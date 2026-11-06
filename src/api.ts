import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { gzipSync } from "node:zlib"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentCliInstaller } from "./agentInstaller.js"
import { decodeEncKey, decryptPayload, encryptPayload, ENC_HEADER, ENC_VERSION, randomEncKey } from "./apiCrypto.js"
import { clampLimit, res_attachment_binary } from "./apiHttp.js"
import { isModelResetWord, resolveModelKey, type ModelInfo } from "./models.js"
import type { ModelAdmin } from "./modelAdmin.js"
import { resolveOpencodeModel } from "./engineCall.js"
import { redactSecrets, type CcSwitchService } from "./ccswitch.js"
import { API_PREFIX, ApiError, type ApiRequestContext } from "./apiCore.js"
import { ApiTaskManager, MAX_TASK_RECORDS } from "./apiTasks.js"
import { AuthFailureLimiter } from "./apiRateLimit.js"
import { routeCc } from "./apiCc.js"
import type { Logger } from "./logger.js"
import type { ReminderService } from "./reminders.js"
import type { ScheduleService } from "./scheduler.js"
import {
  routeAccess as routeAccessApi,
  routeAliases as routeAliasesApi,
  routeConfig as routeConfigApi,
  routeDir as routeDirApi,
  routePeers,
  routeProxy as routeProxyApi,
  routeReminders as routeRemindersApi,
  routeSchedules as routeSchedulesApi,
  routeTimezone as routeTimezoneApi,
  routeUsageHistory as routeUsageHistoryApi,
  agentView,
  agentsView,
  modelsView,
  customModelView,
  type PersonalRouteDeps,
} from "./apiPersonal.js"
import type { SessionStore } from "./store.js"
import type { UsageStore } from "./usage.js"
import type { TaskHistoryStore } from "./history.js"
import { BOT_COMMAND_ALIASES, BOT_MENU_COMMANDS, helpSections } from "./help.js"
import type { AgentCliService } from "./agentCli.js"
import type { BotConfig } from "./config.js"
import type { Opencode } from "./opencode.js"
import { type OpsResult, type OpsService } from "./ops.js"
import type { AliasStore } from "./aliases.js"
import type { ProxyService } from "./proxy.js"

// Attachment uploads are base64 on the same endpoint: a 15MB batch inflates
// to ~20MB, so the cap covers text-only requests with plenty of headroom
const MAX_BODY_BYTES = 48 * 1024 * 1024

/** HTTP helpers live in apiHttp.ts so the route split can grow without re-plumbing. */

/** Session search text is free-form, so it gets a looser check than an ID. */
export interface ApiServerOptions {
  cfg: BotConfig
  oc: Opencode
  agents: AgentCliService
  store: SessionStore
  log: Logger
  usage: UsageStore
  history: TaskHistoryStore
  reminders: ReminderService
  schedules: ScheduleService
  models: ModelAdmin
  /** Live timezone (changes via /timezone must be reflected without a restart). */
  timezone: () => string
  /** Telegram chat that receives reminders/schedules created from the app. */
  ownerChatId?: number
  /** Session key used by app-initiated prompts; independent from Telegram chats. */
  appKey?: string
  /** Applies a timezone change (persists `.env` and updates reminders/schedules/usage live). */
  setTimezone?: (zone: string) => { ok: boolean; message: string }
  /** Ops surface for diagnostics and log tails. */
  ops?: OpsService
  /** Agent CLI installer; enables /agents install/update/uninstall from the app. */
  installer?: AgentCliInstaller
  /** Proxy store shared with the bot so enabling a proxy takes effect for outbound downloads. */
  proxies?: ProxyService
  /** Per-chat shortcuts; the app shares the owner chat's list with Telegram. */
  aliases?: AliasStore
  /** Telegram access whitelist, mutated with the same lockout guards as `/access`. */
  access?: {
    list: () => { users: string[]; allowAll: boolean }
    add: (ids: string[]) => { ok: boolean; message: string }
    remove: (ids: string[]) => { ok: boolean; message: string }
  }
  /** cc-switch console shared with `/cc`; only allowlisted, non-interactive actions are exposed. */
  ccswitch?: CcSwitchService
  /** Fetches remote media (Telegram's guarded downloader) so the app can receive it too. */
  fetchMedia?: (target: string) => Promise<Buffer>
  version?: string
}

export { ApiError, type ApiRequestContext } from "./apiCore.js"
export { CC_EXEC_COMMANDS, CC_VIEWS } from "./apiCcSpecs.js"

/**
 * The API token comes from API_TOKEN when set; otherwise it is generated once,
 * stored next to the other state files (mode 600) and reused across restarts.
 */
export function resolveApiToken(cfg: BotConfig): string {
  if (cfg.api.token) return cfg.api.token
  const path = resolve(cfg.dataDir, "api-token.json")
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    const token = parsed && typeof parsed === "object" ? (parsed as { token?: unknown }).token : undefined
    if (typeof token === "string" && token.length >= 16) return token
  } catch {
    // Missing or unreadable file: generate a fresh token below.
  }
  const token = randomBytes(24).toString("hex")
  writeFileSync(
    path,
    `${JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return token
}

/**
 * The address the App should dial, or nothing when there is no honest one to hand out.
 * `bind` alone is not enough: a container listens on 0.0.0.0 while the phone needs the host's
 * address, so API_PUBLIC_URL is the operator's answer and the QR stays away when it is unset.
 */
export function resolvePairingUrl(cfg: BotConfig): string | undefined {
  if (cfg.api.publicUrl) return cfg.api.publicUrl
  const { bind, port } = cfg.api
  if (bind === "0.0.0.0" || bind === "::" || bind === "127.0.0.1" || bind === "localhost" || bind === "::1") {
    return undefined
  }
  return `http://${bind.includes(":") ? `[${bind}]` : bind}:${port}`
}

/**
 * The JSON inside the /api pairing QR. The App's 扫码配对 reads `url`, `token` and `enc`, so the
 * names are checked against that screen by tests/appParity.test.ts rather than by eye.
 */
export function pairingQrPayload(url: string, token: string, encKey?: string): Record<string, string> {
  return { url, token, ...(encKey ? { enc: encKey } : {}) }
}

/**
 * Pairing key for message-level encryption, created on first start when
 * API_ENCRYPTION=1. It deliberately never appears in chat output — the App
 * receives it through the /api QR code alongside the address and token.
 */
export function resolveEncKey(cfg: BotConfig): Buffer | undefined {
  if (!cfg.encryption?.enabled) return undefined
  const path = resolve(cfg.dataDir, "api-enc-key.json")
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    const key = decodeEncKey((parsed as { key?: unknown } | undefined)?.key)
    if (key) return key
  } catch {
    // Missing or unreadable file: generate a fresh key below.
  }
  const key = decodeEncKey(randomEncKey()) ?? randomBytes(32)
  writeFileSync(path, `${JSON.stringify({ key: key.toString("base64"), createdAt: new Date().toISOString() }, null, 2)}\n`, {
    mode: 0o600,
  })
  return key
}

/** HTTP control surface for the companion Android app. Telegram keeps working in parallel. */
export class ApiServer {  readonly #opts: ApiServerOptions
  readonly #log: Logger
  readonly #token: string
  readonly #encKey?: Buffer
  #server?: Server
  #agentActionRunning = false
  /** Update/check can run npm for minutes; one at a time keeps the repo files sane. */
  #opsActionRunning = false
  #ccActionRunning = false
  readonly #taskManager: ApiTaskManager
  /** Per-request encryption keys, stashed at dispatch so #readJsonBody/#json need no new params. */
  readonly #bodyKeys = new WeakMap<IncomingMessage, Buffer>()
  readonly #resKeys = new WeakMap<ServerResponse, Buffer>()
  /** Requests whose body could not be decrypted: the peer lacks the current key, so its answer must stay readable. */
  readonly #keyMismatch = new WeakSet<IncomingMessage>()
  /** Responses that may be gzipped, decided once from the request's Accept-Encoding. */
  readonly #gzipResponses = new WeakSet<ServerResponse>()
  /** Failed bearer attempts are counted per client address so a static token cannot be brute-forced. */
  readonly #authLimit = new AuthFailureLimiter()

  constructor(options: ApiServerOptions, token: string, encKey?: Buffer) {
    this.#opts = options
    this.#log = options.log
    this.#token = token
    this.#encKey = encKey
    this.#taskManager = new ApiTaskManager({
      cfg: options.cfg,
      oc: options.oc,
      agents: options.agents,
      store: options.store,
      log: options.log,
      usage: options.usage,
      history: options.history,
      models: options.models,
      ownerChatId: options.ownerChatId,
      fetchMedia: options.fetchMedia,
      appKey: options.appKey ?? "api:app",
    })
  }

  get appKey(): string {
    return this.#opts.appKey ?? "api:app"
  }

  /** The bound base URL without the /api/v1 prefix; undefined while stopped. */
  get endpoint(): string | undefined {
    const addr = this.#server?.address()
    if (!addr || typeof addr === "string") return undefined
    return `http://${addr.address}:${addr.port}`
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.#log.error("api request crashed:", err instanceof Error ? err.stack : String(err))
        if (!res.headersSent) this.#json(res, 500, { error: "服务器内部错误" })
        else res.end()
      })
    })
    // Bound slow clients and idle sockets; attachment uploads are the only long body.
    server.requestTimeout = 120_000
    server.headersTimeout = 30_000
    server.keepAliveTimeout = 5_000
    server.on("clientError", (err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      void err
    })
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.#opts.cfg.api.port, this.#opts.cfg.api.bind, () => resolve())
    })
    this.#log.info(`api listening on http://${this.#opts.cfg.api.bind}:${this.#opts.cfg.api.port}${API_PREFIX}`)
  }

  async stop(): Promise<void> {
    const server = this.#server
    if (!server) return
    this.#server = undefined
    this.#taskManager.stopAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Polling clients hold keep-alive sockets; close them so shutdown is prompt.
    server.closeAllConnections()
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const client = req.socket.remoteAddress ?? "unknown"
    if (!url.pathname.startsWith(API_PREFIX)) {
      this.#json(res, 404, { error: "未知的 API 路径" })
      return
    }
    // Authorize before the failure budget is consulted. Behind nginx every phone shares one
    // socket address, and this limiter is keyed on it, so a block earned by one stale-token
    // device used to refuse the devices holding the right token: the App went silent for five
    // minutes and re-scanning the QR changed nothing, because the correct answer was being
    // rejected for somebody else's failures. Wrong tokens still pay the full budget.
    if (this.#authorized(req)) {
      this.#authLimit.recordSuccess(client)
    } else {
      const limit = this.#authLimit.check(client)
      if (!limit.allowed) {
        this.#json(
          res,
          429,
          { error: `认证失败次数过多，请在 ${limit.retryAfterSec} 秒后重试` },
          { "retry-after": String(limit.retryAfterSec) },
        )
        return
      }
      const failed = this.#authLimit.recordFailure(client)
      if (!failed.allowed) {
        this.#log.warn(`api auth blocked for ${client} after repeated failures`)
      }
      this.#json(res, 401, { error: "未授权：请在请求头携带 Authorization: Bearer <token>" })
      return
    }
    if (/\bgzip\b/i.test(req.headers["accept-encoding"] ?? "")) this.#gzipResponses.add(res)

    const segments = url.pathname.slice(API_PREFIX.length).split("/").filter(Boolean)
    // Message-level encryption is opt-in per request via the x-enc header; the server
    // answers in kind only when API_ENCRYPTION enabled a pairing key.
    const requestedEncrypted = req.headers[ENC_HEADER] === ENC_VERSION
    if (requestedEncrypted && !this.#encKey) {
      this.#json(res, 400, { error: "服务器未启用消息加密（API_ENCRYPTION=0），请去掉 x-enc 请求头后重试" })
      return
    }
    if (requestedEncrypted && this.#encKey) {
      this.#bodyKeys.set(req, this.#encKey)
      this.#resKeys.set(res, this.#encKey)
    }
    const ctx: ApiRequestContext = {
      req,
      res,
      url,
      method: (req.method ?? "GET").toUpperCase(),
      segments,
      encrypted: requestedEncrypted && this.#encKey !== undefined,
    }
    try {
      await this.#route(ctx)
    } catch (err) {
      if (err instanceof ApiError) {
        this.#json(res, err.status, { error: err.message })
        return
      }
      throw err
    }
  }

  #authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return false
    const provided = Buffer.from(header.slice("Bearer ".length).trim())
    const expected = Buffer.from(this.#token)
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  }

  async #route(ctx: ApiRequestContext): Promise<void> {
    const { method, segments } = ctx
    const [resource, id, action] = segments

    if (resource === "health" && method === "GET") {
      const engine = this.#opts.store.getEngine(this.appKey)
      this.#json(ctx.res, 200, {
        ok: true,
        name: "agent-bot",
        version: this.#opts.version,
        uptimeMs: Math.round(process.uptime() * 1000),
        engine,
        timezone: this.#opts.timezone(),
        encryption: this.#encKey !== undefined,
      })
      return
    }

    if (resource === "help" && method === "GET") {
      // The command list rides along so the app's "/" palette and its argument
      // handling follow the bot's real surface instead of a hardcoded copy
      this.#json(ctx.res, 200, {
        sections: helpSections(),
        commands: BOT_MENU_COMMANDS,
        aliases: BOT_COMMAND_ALIASES,
      })
      return
    }

    if (resource === "info" && method === "GET") {
      const engine = this.#opts.store.getEngine(this.appKey)
      const session = this.#sessionView()
      this.#json(ctx.res, 200, {
        version: this.#opts.version ?? null,
        timezone: this.#opts.timezone(),
        engine,
        engineLabel: this.#opts.agents.registry.label(engine),
        model: session.model ?? null,
        sessionId: engine === "opencode" ? (this.#opts.store.get(this.appKey) ?? null) : null,
        cliSessionId: engine === "opencode" ? null : (this.#opts.store.getCliSession(this.appKey, engine) ?? null),
        workDir: this.#opts.agents.workDir(this.appKey),
        chatId: this.#opts.ownerChatId ?? null,
        api: {
          enabled: this.#opts.cfg.api.enabled,
          bind: this.#opts.cfg.api.bind,
          port: this.#opts.cfg.api.port,
          // The token itself was used to authenticate this request; never echo it back
          tokenConfigured: true,
        },
      })
      return
    }

    if (resource === "session" && method === "GET") {
      this.#json(ctx.res, 200, this.#sessionView())
      return
    }

    if (resource === "new" && method === "POST") {
      this.#requireIdle("开启新会话")
      await this.#resetSession()
      this.#json(ctx.res, 200, { ok: true, message: "已开启新会话，上下文已清空。" })
      return
    }

    if (resource === "task" && method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const text = typeof body.text === "string" ? body.text.trim() : ""
      const attachments = this.#taskManager.parseAttachments(body.attachments)
      // Attachments-only tasks are allowed: #runTask fills in a default instruction per media kind.
      if (!text && (attachments?.length ?? 0) === 0) throw new ApiError(400, "缺少 text 字段")
      if (text.length > 12_000) throw new ApiError(400, "消息太长（上限 12000 字），请分段发送")
      // Same expansion the bot applies to /name messages, so shortcuts created in
      // either client work from both (built-in commands do not exist here).
      const expanded = this.#expandAlias(text)
      const engine = typeof body.engine === "string" && body.engine.trim() ? body.engine.trim() : undefined
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined
      const task = this.#taskManager.submit(expanded, engine, model, attachments)
      this.#json(ctx.res, 202, { task: this.#taskManager.view(task) })
      return
    }

    if (resource === "task" && id && method === "GET" && !action) {
      const task = this.#taskManager.get(id)
      if (!task) throw new ApiError(404, "任务不存在或已被清理")
      this.#json(ctx.res, 200, { task: this.#taskManager.view(task) })
      return
    }

    if (resource === "task" && id && action === "events" && method === "GET") {
      const task = this.#taskManager.get(id)
      if (!task) throw new ApiError(404, "任务不存在或已被清理")
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
        // Already settled: a single snapshot response is friendlier than an
        // event stream that closes after one frame
        this.#json(ctx.res, 200, { task: this.#taskManager.view(task) })
        return
      }
      this.#taskManager.streamEvents(ctx, task)
      return
    }

    if (resource === "task" && id && method === "GET" && action === "media") {
      await this.#taskManager.sendMedia(ctx, id, Number(segments[3]))
      return
    }

    if (resource === "task" && id && method === "POST" && action === "stop") {
      const task = this.#taskManager.stopTask(id)
      this.#json(ctx.res, 200, { ok: true, task: this.#taskManager.view(task) })
      return
    }

    if (resource === "task" && id && method === "POST" && action === "retry") {
      const failed = this.#taskManager.get(id)
      if (!failed || failed.key !== this.appKey) throw new ApiError(404, "任务不存在或已被清理")
      if (failed.status === "queued" || failed.status === "running") {
        throw new ApiError(409, "任务还在排队或执行中，请先停止")
      }
      // Telegram's /retry replays the captured prompt, so reuse the stored text,
      // engine, model pin and attachments instead of a text-only client copy.
      // Attachments were saved to the inbox at submit time; re-read them into base64.
      const attachments = (failed.savedAttachments ?? []).flatMap((saved) => {
        try {
          return [{ name: saved.name, mime: saved.mime, data: readFileSync(saved.path).toString("base64") }]
        } catch {
          return []
        }
      })
      const task = this.#taskManager.submit(failed.text, failed.engine, failed.model, attachments.length > 0 ? attachments : undefined)
      this.#json(ctx.res, 202, { ok: true, retriedFrom: id, task: this.#taskManager.view(task) })
      return
    }

    if (resource === "tasks" && method === "GET") {
      const limit = clampLimit(ctx.url.searchParams.get("limit"), 50, MAX_TASK_RECORDS)
      // Unlike /queue this also answers the settled runs, which is what lets a client re-run
      // any of them through POST /task/:id/retry while the record is still retained.
      const tasks = this.#taskManager.list(limit)
      this.#json(ctx.res, 200, { tasks: tasks.map((task) => this.#taskManager.view(task)) })
      return
    }

    if (resource === "stop" && method === "POST") {
      this.#json(ctx.res, 200, this.#taskManager.stopAll())
      return
    }

    if (resource === "queue" && method === "POST" && id === "clear") {
      this.#json(ctx.res, 200, this.#taskManager.clearQueue())
      return
    }

    if (resource === "queue" && method === "GET") {
      this.#json(ctx.res, 200, { tasks: this.#taskManager.queue().map((task) => this.#taskManager.view(task)) })
      return
    }

    if (resource === "dir") {
      await this.#routeDir(ctx, id)
      return
    }

    if (resource === "timezone") {
      await this.#routeTimezone(ctx)
      return
    }

    if (resource === "proxy") {
      await this.#routeProxy(ctx, id, action)
      return
    }

    if (resource === "aliases") {
      await this.#routeAliases(ctx, id)
      return
    }

    if (resource === "access") {
      await this.#routeAccess(ctx, id)
      return
    }

    if (resource === "cc") {
      await this.#routeCc(ctx, id, action)
      return
    }

    if (resource === "config") {
      await this.#routeConfig(ctx, id)
      return
    }

    if (resource === "peers") {
      await this.#routePeers(ctx, id)
      return
    }

    if (resource === "agents" && method === "GET") {
      this.#json(ctx.res, 200, { agents: agentsView(this.#personalDeps()) })
      return
    }

    if (resource === "agent" && method === "POST") {
      const body = await this.#readJsonBody(ctx.req)
      // resolveEngine (not resolve): the literal "opencode" must select the
      // server engine, not the opencode CLI whose bin is also called opencode
      const resolved = this.#opts.agents.registry.resolveEngine(typeof body.engine === "string" ? body.engine : "")
      if (!resolved) throw new ApiError(400, `未知的 Agent 引擎，可用：opencode, ${this.#opts.agents.registry.list().map((p) => p.id).join(", ")}`)
      // Telegram answers "已经是当前引擎" instead of rewriting the same value, and warns when
      // the CLI it just selected is not on PATH — the App's toast carries both notes.
      const label = this.#opts.agents.registry.label(resolved)
      if (this.#opts.store.getEngine(this.appKey) === resolved) {
        this.#json(ctx.res, 200, { ok: true, message: `当前已经是 ${label}，无需切换`, session: this.#sessionView() })
        return
      }
      // No session reset and running tasks already captured their engine, so this is safe
      // mid-flight — unlike Telegram's queued /agent it applies at once for the next task.
      this.#opts.store.setEngine(this.appKey, resolved)
      const profile = resolved === "opencode" ? undefined : this.#opts.agents.registry.get(resolved)
      const missing = profile && !this.#opts.agents.registry.binPath(profile)
      this.#json(ctx.res, 200, {
        ok: true,
        message: missing ? `已切换至 ${label}，但未检测到命令 ${profile.bin}，任务可能失败` : `已切换至 ${label}`,
        session: this.#sessionView(),
      })
      return
    }

    if (resource === "models" && id === "assign" && method === "POST") {
      const body = await this.#readJsonBody(ctx.req)
      const agent = typeof body.agent === "string" ? body.agent.trim() : ""
      const selection = typeof body.model === "string" ? body.model.trim() : ""
      if (!agent || !selection) throw new ApiError(400, "缺少 agent 或 model 字段")
      let result
      try {
        result = this.#opts.models.assignAgent(agent, selection)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法绑定 Agent 模型")
      }
      // Mirrors `/cc model assign`: assigning the bot's own opencode agent also switches
      // the app session, but a failure there must not undo the file write that succeeded.
      let sessionMessage: string | undefined
      if (result.agent === (this.#opts.cfg.opencode.agent ?? "assistant") && this.#opts.store.getEngine(this.appKey) === "opencode") {
        try {
          sessionMessage = await this.#applyModel(result.model)
        } catch (err) {
          // The catalog write already succeeded, so still answer 200 but say the session did not follow
          sessionMessage = `会话模型未切换：${err instanceof Error ? err.message : "未知错误"}`
        }
      }
      this.#json(ctx.res, 200, {
        ok: true,
        message: `已将 Agent ${result.agent} 的模型设置为 ${result.label}。`,
        result,
        sessionMessage: sessionMessage ?? null,
        session: this.#sessionView(),
      })
      return
    }

    if (resource === "models" && id === "custom") {
      await this.#routeCustomModels(ctx, action)
      return
    }

    if (resource === "models" && method === "GET") {
      this.#json(ctx.res, 200, { models: modelsView(this.#personalDeps(), ctx.url.searchParams.get("engine") ?? undefined) })
      return
    }

    if (resource === "model" && method === "POST") {
      const body = await this.#readJsonBody(ctx.req)
      const raw = typeof body.model === "string" ? body.model.trim() : ""
      if (!raw) throw new ApiError(400, "缺少 model 字段")
      // `reset` is the App's button: it always drops the selection, even on an engine that
      // declares a model whose name happens to be a reset word
      const message = await this.#applyModel(raw, body.reset === true)
      this.#json(ctx.res, 200, { ok: true, message, session: this.#sessionView() })
      return
    }

    if (resource === "agents" && id && method === "POST") {
      await this.#routeAgentAction(ctx, id, action)
      return
    }

    if (resource === "ops" && method === "GET" && id === "diag") {
      const ops = this.#opts.ops
      if (!ops) throw new ApiError(409, "当前运行环境不支持运维诊断")
      this.#json(ctx.res, 200, { diagnostics: await ops.diagnostics() })
      return
    }

    if (resource === "ops" && method === "GET" && id === "service") {
      const ops = this.#opts.ops
      if (!ops) throw new ApiError(409, "当前运行环境不支持服务管理")
      this.#json(ctx.res, 200, { service: await ops.opencodeStatus() })
      return
    }

    if (resource === "ops" && method === "GET" && id === "check-update") {
      const ops = this.#opts.ops
      if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
      this.#json(ctx.res, 200, { result: await ops.checkUpdate() })
      return
    }

    // Streams the fresh data backup; the pairing token is never inside the archive
    if (resource === "ops" && method === "GET" && id === "backup") {
      const ops = this.#opts.ops
      if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
      const result = await ops.backupData()
      if (!result.ok || !result.file) throw new ApiError(500, result.message)
      const file = result.file.split("/").pop() ?? "backup.tar.gz"
      res_attachment_binary(ctx.res, file, "application/gzip", readFileSync(result.file))
      return
    }

    if (resource === "ops" && method === "POST" && id) {
      await this.#routeOpsAction(ctx, id, action)
      return
    }

    if (resource === "ops" && method === "GET" && id === "logs") {
      const ops = this.#opts.ops
      if (!ops) throw new ApiError(409, "当前运行环境不支持日志查看")
      const source = ctx.url.searchParams.get("source") === "opencode" ? "opencode" : "bot"
      const rawLines = Number(ctx.url.searchParams.get("lines") ?? 80)
      const lines = Math.min(400, Math.max(10, Number.isFinite(rawLines) ? Math.floor(rawLines) : 80))
      this.#json(ctx.res, 200, ops.tailLogs(source, lines))
      return
    }

    if (resource === "usage" || resource === "history" || resource === "export") {
      await routeUsageHistoryApi(this.#personalDeps(), ctx, resource, id)
      return
    }

    if (resource === "reminders") {
      await this.#routeReminders(ctx, id, action)
      return
    }

    if (resource === "schedules") {
      await this.#routeSchedules(ctx, id, action)
      return
    }

    if (resource === "status" && method === "GET") {
      this.#json(ctx.res, 200, await this.#statusView())
      return
    }

    this.#json(ctx.res, 404, { error: "未知的 API 路径" })
  }

  async #routeCustomModels(ctx: ApiRequestContext, key: string | undefined): Promise<void> {
    const models = this.#opts.models
    if (ctx.method === "GET" && !key) {
      const custom = models.listCustomModels()
      this.#json(ctx.res, 200, {
        models: Object.entries(custom).map(([name, entry]) => customModelView(name, entry)),
        agents: models.listAgents().map((agent) => ({
          name: agent.name,
          model: agent.model,
          description: agent.description,
          mode: agent.mode,
        })),
      })
      return
    }
    if (ctx.method === "POST" && !key) {
      const body = await this.#readJsonBody(ctx.req)
      // The same positive-integer rule Telegram's `--context/--output` flags enforce
      const limitOf = (field: string, raw: unknown): number | undefined => {
        if (raw === undefined || raw === null) return undefined
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > 1_000_000_000) {
          throw new ApiError(400, `${field} 需要 1–1000000000 之间的整数`)
        }
        return raw
      }
      const input = {
        key: typeof body.key === "string" ? body.key : "",
        providerID: typeof body.providerID === "string" ? body.providerID : "",
        modelID: typeof body.modelID === "string" ? body.modelID : "",
        label: typeof body.label === "string" ? body.label : undefined,
        desc: typeof body.desc === "string" ? body.desc : undefined,
        attachment: typeof body.attachment === "boolean" ? body.attachment : undefined,
        contextWindow: limitOf("contextWindow", body.contextWindow),
        outputLimit: limitOf("outputLimit", body.outputLimit),
      }
      if (!input.key || !input.providerID || !input.modelID) {
        throw new ApiError(400, "缺少 key、providerID 或 modelID 字段")
      }
      let added
      try {
        added = models.add(input)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法添加模型")
      }
      // Telegram spells out which capabilities landed, because a provider missing from
      // opencode.json silently keeps them; the App has to say the same thing.
      const capabilities = [
        input.attachment ? "支持图片输入" : "",
        input.contextWindow ? `上下文 ${input.contextWindow}` : "",
        input.outputLimit ? `输出上限 ${input.outputLimit}` : "",
      ].filter(Boolean)
      const capabilityNote =
        capabilities.length === 0
          ? ""
          : added.providerUpdated
            ? `已写入模型能力：${capabilities.join("、")}。`
            : `⚠️ 模型能力参数（${capabilities.join("、")}）未写入：Provider 不在项目 opencode.json 中。`
      this.#json(ctx.res, 200, {
        ok: true,
        message: `已添加自定义模型 ${added.key}（${input.providerID}/${input.modelID}）。${capabilityNote}`,
        model: customModelView(added.key, added.entry),
      })
      return
    }
    if (ctx.method === "DELETE" && key) {
      const force = ctx.url.searchParams.get("force") === "1"
      let removed
      try {
        removed = models.remove(key, force)
      } catch (err) {
        throw new ApiError(409, err instanceof Error ? err.message : "模型无法删除")
      }
      if (!removed) throw new ApiError(404, "自定义模型不存在")
      this.#json(ctx.res, 200, {
        ok: true,
        message: `已删除自定义模型 ${removed.key}。${removed.resetChats.length > 0 ? `已重置 ${removed.resetChats.length} 个会话的模型选择。` : ""}`,
        resetChats: removed.resetChats,
        resetAgents: removed.resetAgents,
      })
      return
    }
    throw new ApiError(404, "未知的模型 API 路径")
  }

  async #routeOpsAction(ctx: ApiRequestContext, id: string, action: string | undefined): Promise<void> {
    const ops = this.#opts.ops
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
    const serviceActions: Record<string, () => Promise<OpsResult>> = {
      start: () => ops.startOpencode(),
      stop: () => ops.stopOpencode(),
      restart: () => ops.restartOpencode(),
    }
    let run: (() => Promise<OpsResult>) | undefined
    if (id === "update") run = () => ops.updateProject()
    else if (id === "check") run = () => ops.runCheck()
    else if (id === "restart") run = () => ops.restartBot()
    else if (id === "cc") run = () => ops.installCcSwitch(false)
    else if (id === "cc-update") run = () => ops.installCcSwitch(true)
    else if (id === "service" && action && Object.hasOwn(serviceActions, action)) run = serviceActions[action]
    if (!run) throw new ApiError(404, "未知的运维操作")
    this.#json(ctx.res, 200, { result: await this.#runOpsAction(run) })
  }

  async #runOpsAction(run: () => Promise<OpsResult>): Promise<Record<string, unknown>> {
    if (this.#opsActionRunning) throw new ApiError(409, "已有运维操作在执行，请稍后再试")
    this.#opsActionRunning = true
    try {
      const result = await run()
      return {
        ok: result.ok,
        message: redactSecrets(result.message),
        // Install/build output can be long; the app only shows the tail
        steps: result.steps.map((step) => ({
          label: step.label,
          ok: step.ok,
          code: step.code,
          output: redactSecrets(step.output).slice(-20_000),
        })),
      }
    } finally {
      this.#opsActionRunning = false
    }
  }

  /** cc-switch reads only: a CLI failure is a 502, not a client error. */
  async #ccQuery<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      throw new ApiError(502, redactSecrets(err instanceof Error ? err.message : String(err)))
    }
  }

  /** cc-switch writes run one at a time and report CLI failures as 502. */
  async #runCcAction<T>(run: () => Promise<T>): Promise<T> {
    return this.#withCcLock(async () => {
      try {
        return await run()
      } catch (err) {
        throw new ApiError(502, redactSecrets(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  /** Single-flight guard shared by every mutating cc-switch route. */
  async #withCcLock<T>(run: () => Promise<T>): Promise<T> {
    if (this.#ccActionRunning) throw new ApiError(409, "已有 cc-switch 操作在执行，请稍后再试")
    this.#ccActionRunning = true
    try {
      return await run()
    } finally {
      this.#ccActionRunning = false
    }
  }

  async #routeCc(ctx: ApiRequestContext, id: string | undefined, action: string | undefined): Promise<void> {
    await routeCc(
      {
        cc: this.#opts.ccswitch,
        json: (res, status, body) => this.#json(res, status, body),
        readJsonBody: (req) => this.#readJsonBody(req),
        ccQuery: (run) => this.#ccQuery(run),
        runCcAction: (run) => this.#runCcAction(run),
        withCcLock: (run) => this.#withCcLock(run),
      },
      ctx,
      id,
      action,
    )
  }

  async #routeConfig(ctx: ApiRequestContext, key: string | undefined): Promise<void> {
    await routeConfigApi(this.#personalDeps(), ctx, key)
  }

  async #routeAccess(ctx: ApiRequestContext, id: string | undefined): Promise<void> {
    await routeAccessApi(this.#personalDeps(), ctx, id)
  }

  #expandAlias(text: string): string {
    const aliases = this.#opts.aliases
    const chatId = this.#opts.ownerChatId
    if (!aliases || chatId === undefined) return text
    let current = text
    for (let depth = 0; depth < 3; depth++) {
      const first = current.split(/\s+/, 1)[0] ?? ""
      if (!/^\/[a-z][a-z0-9_]*$/i.test(first)) break
      const expansion = aliases.expand(chatId, first.slice(1))
      if (!expansion) break
      const rest = current.slice(first.length).trim()
      current = rest ? `${expansion} ${rest}` : expansion
    }
    return current
  }

  async #routeAliases(ctx: ApiRequestContext, id: string | undefined): Promise<void> {
    await routeAliasesApi(this.#personalDeps(), ctx, id)
  }

  async #routeProxy(ctx: ApiRequestContext, id: string | undefined, action: string | undefined): Promise<void> {
    await routeProxyApi(this.#personalDeps(), ctx, id, action)
  }

  async #routeReminders(ctx: ApiRequestContext, id: string | undefined, action?: string): Promise<void> {
    await routeRemindersApi(this.#personalDeps(), ctx, id, action)
  }

  async #routeSchedules(ctx: ApiRequestContext, id: string | undefined, action: string | undefined): Promise<void> {
    await routeSchedulesApi(this.#personalDeps(), ctx, id, action)
  }

  /** `/dir` equivalent: the working directory CLI engines start in for the app session. */
  async #routeDir(ctx: ApiRequestContext, sub?: string): Promise<void> {
    await routeDirApi(this.#personalDeps(), ctx, sub)
  }

  async #routeTimezone(ctx: ApiRequestContext): Promise<void> {
    await routeTimezoneApi(this.#personalDeps(), ctx)
  }

  #hasActiveTask(): boolean {
    return this.#taskManager.hasActiveTask()
  }

  /** Telegram answers "任务执行中，请先停止" instead of rewriting session state under a job. */
  #requireIdle(what: string): void {
    this.#taskManager.requireIdle(what)
  }

  /** Everything the personal-data route modules need from this class, in one object. */
  #personalDeps(): PersonalRouteDeps {
    return {
      appKey: this.appKey,
      ownerChatId: this.#opts.ownerChatId,
      store: this.#opts.store,
      cfg: this.#opts.cfg,
      registry: this.#opts.agents.registry,
      reminders: this.#opts.reminders,
      schedules: this.#opts.schedules,
      usage: this.#opts.usage,
      models: this.#opts.models,
      installer: this.#opts.installer,
      json: (res, status, body) => this.#json(res, status, body),
      readJsonBody: (req) => this.#readJsonBody(req),
      sessionView: (key) => this.#sessionView(key),
      adoptSession: (from) => this.#adoptSession(from),
      workDir: (key) => this.#opts.agents.workDir(key),
      defaultWorkDir: this.#opts.agents.defaultWorkDir,
      resetCliSessions: () => this.#resetCliSessions(),
      hasActiveTask: () => this.#hasActiveTask(),
      timezone: () => this.#opts.timezone(),
      setTimezone: this.#opts.setTimezone,
      aliases: this.#opts.aliases,
      ops: this.#opts.ops,
      proxies: this.#opts.proxies,
      history: this.#opts.history,
      access: this.#opts.access,
    }
  }

  async #routePeers(ctx: ApiRequestContext, id: string | undefined): Promise<void> {
    await routePeers(this.#personalDeps(), ctx, id)
  }

  /** Copies engine, model and working directory from another session onto this one. */
  #adoptSession(from: string): string[] {
    const store = this.#opts.store
    const changed: string[] = []
    const engine = store.getEngine(from)
    if (store.getEngine(this.appKey) !== engine) {
      store.setEngine(this.appKey, engine)
      changed.push(`引擎切换为 ${this.#opts.agents.registry.label(engine)}`)
    }
    if (engine === "opencode") {
      const model = store.getModel(from)
      const own = store.getModel(this.appKey)
      if (model?.modelID !== own?.modelID || model?.providerID !== own?.providerID) {
        if (model) store.setModel(this.appKey, model)
        else store.clearModel(this.appKey)
        changed.push(model ? `模型 ${model.label}` : "恢复默认模型")
      }
    } else {
      const model = store.getCliModel(from, engine) ?? ""
      if (model !== (store.getCliModel(this.appKey, engine) ?? "")) {
        store.setCliModel(this.appKey, engine, model)
        changed.push(model ? `模型 ${this.#opts.agents.registry.modelLabel(engine, model)}` : "恢复该引擎的默认模型")
      }
    }
    // Copy what the other session really runs in, which `workDir` already resolved to an
    // existing directory — a deleted repo dir must not become this session's setting too.
    const sourceDir = this.#opts.agents.workDir(from)
    if (sourceDir !== this.#opts.agents.workDir(this.appKey)) {
      this.#opts.store.setDir(this.appKey, sourceDir)
      // Another directory means another repository, so a CLI session cannot carry over
      this.#resetCliSessions()
      changed.push(`工作目录 ${sourceDir}`)
    }
    return changed
  }

  #resetCliSessions(): void {
    for (const profile of this.#opts.agents.registry.list()) {
      this.#opts.store.clearCliSession(this.appKey, profile.id)
    }
  }

  /** Session state for any key, so the App can also read the Telegram side. */
  #sessionView(key = this.appKey): Record<string, unknown> {
    const engine = this.#opts.store.getEngine(key)
    const profile = this.#opts.agents.registry.get(engine)
    const view: Record<string, unknown> = {
      key,
      engine,
      engineLabel: this.#opts.agents.registry.label(engine),
      engineInstalled: engine === "opencode" ? true : Boolean(profile && this.#opts.agents.registry.binPath(profile)),
      timezone: this.#opts.timezone(),
    }
    if (engine === "opencode") {
      const model = resolveOpencodeModel(this.#opts.store, this.#opts.cfg.opencode.model, key)
      view.model = model.label
      view.modelRef = model
      view.hasSession = Boolean(this.#opts.store.get(key))
    } else {
      const model = this.#opts.store.getCliModel(key, engine) ?? this.#opts.agents.registry.defaultModel(engine)
      view.model = model
        ? this.#opts.agents.registry.modelLabel(engine, model)
        : profile?.supportsModel
          ? "默认"
          : "由 CLI 决定"
      view.hasSession = Boolean(this.#opts.store.getCliSession(key, engine))
      view.workDir = this.#opts.agents.workDir(key)
    }
    return view
  }

  async #resetSession(): Promise<void> {
    const engine = this.#opts.store.getEngine(this.appKey)
    if (engine === "opencode") {
      const old = this.#opts.store.get(this.appKey)
      if (old) {
        await this.#opts.oc.deleteSession(old).catch(() => {})
        this.#opts.store.clearSession(this.appKey)
      }
    } else {
      this.#opts.store.clearCliSession(this.appKey, engine)
    }
  }

  /** Install/update/uninstall an Agent CLI; the app confirms before calling. */
  async #routeAgentAction(ctx: ApiRequestContext, rawId: string, action: string | undefined): Promise<void> {
    const verbs: Record<string, string> = { install: "安装", update: "更新", uninstall: "卸载" }
    const verb = action ? verbs[action] : undefined
    if (!action || !verb) throw new ApiError(404, "未知的 Agent 管理操作")
    const engine = this.#opts.agents.registry.resolveEngine(rawId)
    const profile = engine && engine !== "opencode" ? this.#opts.agents.registry.get(engine) : undefined
    if (!engine || !profile) throw new ApiError(404, `未识别的 Agent CLI：${rawId}`)
    const installer = this.#opts.installer
    if (!installer) throw new ApiError(409, "当前运行环境不支持安装管理")

    if (action === "install") {
      const existing = this.#opts.agents.registry.binPath(profile)
      if (existing) throw new ApiError(409, `${profile.label} 已安装：${existing}`)
      if (!installer.installCommand(profile)) {
        throw new ApiError(400, `${profile.label} 暂不支持自动安装${profile.install ? `，请手动安装：${profile.install}` : ""}`)
      }
    } else {
      if (!installer.isManaged(engine)) {
        throw new ApiError(409, `${profile.label} 不是由 Bot 安装的，无法自动${verb}`)
      }
      if (action === "uninstall" && this.#opts.store.getEngine(this.appKey) === engine) {
        throw new ApiError(409, `当前正在使用 ${profile.label}，请先切换到 OpenCode 再卸载`)
      }
    }
    if (this.#agentActionRunning) throw new ApiError(409, "已有安装/卸载任务在执行，请稍后再试")

    this.#agentActionRunning = true
    try {
      const result =
        action === "install"
          ? await installer.install(engine)
          : action === "update"
            ? await installer.update(engine)
            : await installer.uninstall(engine)
      this.#log.info(`api agent ${action} ${engine}: ${result.ok ? "ok" : "failed"}`)
      this.#json(ctx.res, 200, {
        ok: result.ok,
        message: redactSecrets(result.message),
        output: result.output ? redactSecrets(result.output).slice(0, 20_000) : undefined,
        agent: agentView(this.#personalDeps(), profile),
      })
    } finally {
      this.#agentActionRunning = false
    }
  }

  // Engine/model views moved to apiPersonal.ts (agentsView/modelsView/agentView).

  /**
   * Applies `POST /model`, with the semantics Telegram already had: a word naming a real
   * model wins, otherwise a reset word drops the session's own pick, and any change drops
   * the context so the previous model never keeps answering under the new one.
   * Telegram refuses the whole panel while a job runs (deleting its session would fail it),
   * so the guard comes before even the "已经是当前模型" answer.
   */
  async #applyModel(raw: string, forceReset = false): Promise<string> {
    this.#requireIdle("切换模型")
    const engine = this.#opts.store.getEngine(this.appKey)
    const word = raw.trim().toLowerCase()
    // Non-strict CLI profiles take any string as a model id, so only a model the engine
    // really declares may shadow the reset keyword
    const declared =
      engine === "opencode" ? resolveModelKey(word) !== undefined : this.#opts.agents.registry.declaresModel(engine, word)
    if (forceReset || (!declared && isModelResetWord(word))) {
      return engine === "opencode" ? this.#clearOpenCodeModel() : this.#clearCliModel(engine)
    }
    if (engine === "opencode") {
      let info: ModelInfo
      try {
        info = this.#opts.models.resolveModel(raw)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法识别的模型")
      }
      const current = this.#opts.store.getModel(this.appKey) ?? resolveOpencodeModel(this.#opts.store, this.#opts.cfg.opencode.model, this.appKey)
      if (current.providerID === info.providerID && current.modelID === info.modelID) {
        return `当前已经是 ${info.label}，无需切换，会话上下文保持不变`
      }
      this.#opts.store.setModel(this.appKey, { providerID: info.providerID, modelID: info.modelID, label: info.label })
      await this.#resetSession()
      return `模型已切换为 ${info.label}（会话上下文已重置）`
    }
    const resolved = this.#opts.agents.registry.resolveModel(engine, raw)
    if (!resolved) {
      const profile = this.#opts.agents.registry.get(engine)
      const options = (profile?.models ?? []).map((m) => m.id).join(", ")
      throw new ApiError(400, options ? `未知的模型，可用：${options}` : "该引擎不支持指定模型")
    }
    const current = this.#opts.store.getCliModel(this.appKey, engine) ?? this.#opts.agents.registry.defaultModel(engine)
    if (current === resolved) {
      return `当前已经是 ${this.#opts.agents.registry.modelLabel(engine, resolved)}，无需切换，会话上下文保持不变`
    }
    this.#opts.store.setCliModel(this.appKey, engine, resolved)
    this.#opts.store.clearCliSession(this.appKey, engine)
    return `模型已切换为 ${this.#opts.agents.registry.modelLabel(engine, resolved)}（会话上下文已重置）`
  }

  /** `/model <reset word>` on OpenCode: false when the session never picked one itself. */
  async #clearOpenCodeModel(): Promise<string> {
    const fallback = () => resolveOpencodeModel(this.#opts.store, this.#opts.cfg.opencode.model, this.appKey).label
    if (!this.#opts.store.clearModel(this.appKey)) return `本会话没有独立的模型选择，当前就是默认模型 ${fallback()}`
    await this.#resetSession()
    return `已取消本会话的模型选择，恢复默认模型 ${fallback()}（会话上下文已重置）`
  }

  /** `/model <reset word>` on a CLI engine, mirroring Telegram's own selection drop. */
  #clearCliModel(engine: string): string {
    const label = this.#opts.agents.registry.label(engine)
    if (!this.#opts.store.getCliModel(this.appKey, engine)) {
      return `本会话没有独立的模型选择，当前就是 ${label} 默认模型`
    }
    this.#opts.store.setCliModel(this.appKey, engine, "")
    this.#opts.store.clearCliSession(this.appKey, engine)
    return `已取消本会话的模型选择，恢复 ${label} 默认模型（会话上下文已重置）`
  }

  // Wire views for reminders/schedules moved to apiPersonal.ts (publicReminder/publicSchedule).

  async #statusView(): Promise<Record<string, unknown>> {
    const usage = this.#opts.usage.summary(this.appKey)
    const pending = this.#taskManager.activeTasks()
    return {
      uptimeMs: Math.round(process.uptime() * 1000),
      version: this.#opts.version,
      timezone: this.#opts.timezone(),
      engine: this.#opts.store.getEngine(this.appKey),
      usageToday: usage.today,
      opencodeReachable: await this.#opts.oc.health(),
      activeTask: pending[0] ? this.#taskManager.view(pending[0]) : undefined,
      // `tasksTotal` also covers finished rows the map still keeps for retry and SSE,
      // so a client that wants queue depth needs `tasksActive` rather than reading into it.
      tasksTotal: this.#taskManager.total,
      tasksActive: pending.length,
    }
  }

  async #readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const encKey = this.#bodyKeys.get(req)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength
      if (total > MAX_BODY_BYTES) throw new ApiError(413, "请求体过大")
      chunks.push(chunk as Buffer)
    }
    if (total === 0) return {}
    const raw = Buffer.concat(chunks, total)

    const parseObject = (text: string): Record<string, unknown> => {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        throw new ApiError(400, "请求体必须是 JSON 对象")
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw new ApiError(400, "请求体不是合法的 JSON")
      }
    }
    if (encKey) {
      let inner: string
      try {
        inner = decryptPayload(encKey, raw.toString("utf8"))
      } catch (err) {
        // An unreadable body means the peer holds a different key (the bot rotated
        // API_ENCRYPTION or the App re-scanned): encrypting the explanation with our
        // current key would hide the one message that tells the user to re-pair.
        this.#keyMismatch.add(req)
        throw new ApiError(400, `解密请求体失败：${(err as Error).message}。若服务器刚更换过加密密钥，请在 App 设置里清空密钥或重新扫码。`)
      }
      return parseObject(inner)
    }
    return parseObject(raw.toString("utf8"))
  }

  #json(
    res: ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    let payload = JSON.stringify(body)
    const encKey =
      res.req && this.#keyMismatch.has(res.req) ? undefined : this.#resKeys.get(res)
    const headers: Record<string, string | number> = {
      "content-type": "application/json; charset=utf-8",
      // API responses can carry the pairing/token state and task text.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      ...extraHeaders,
    }
    if (encKey) {
      payload = encryptPayload(encKey, payload)
      headers[ENC_HEADER] = ENC_VERSION
    }
    let bytes = Buffer.from(payload)
    if (this.#gzipResponses.has(res) && bytes.byteLength >= 1024) {
      bytes = gzipSync(bytes)
      headers["content-encoding"] = "gzip"
      headers["vary"] = "Accept-Encoding"
    }
    headers["content-length"] = bytes.byteLength
    res.writeHead(status, headers)
    res.end(bytes)
  }
}
