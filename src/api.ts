import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { normalizeWorkDirInput } from "./agentCli.js"
import type { AgentCliInstaller } from "./agentInstaller.js"
import type { AgentCliProfile } from "./agentCli.js"
import { isTextAttachment, pruneInbox, readTextAttachment, saveAttachment, type AttachmentKind, type SavedAttachment } from "./attachments.js"
import { buildAttachmentSections, MAX_ATTACH_TOTAL_BYTES } from "./attachmentInput.js"
import { AVAILABLE_MODELS, type ModelInfo } from "./models.js"
import type { ModelAdmin } from "./modelAdmin.js"
import { callEngine, defaultOpencodeModel, resolveOpencodeModel, type EngineCallDeps } from "./engineCall.js"
import {
  assertSafeId,
  CC_LONG_TIMEOUT_MS,
  CC_PROVIDER_API_FORMATS,
  CC_PROVIDER_TEMPLATES,
  CcSwitchError,
  redactSecrets,
  stripAnsi,
  type CcSwitchProvider,
  type CcSwitchProviderDraft,
  type CcSwitchService,
} from "./ccswitch.js"
import type { Logger } from "./logger.js"
import type { Reminder, ReminderService } from "./reminders.js"
import { scheduleTargetLabel } from "./scheduler.js"
import type { ScheduleService, ScheduledTask } from "./scheduler.js"
import type { SessionStore } from "./store.js"
import type { UsageOutcome, UsageStore } from "./usage.js"
import { formatHistoryMarkdown, type TaskHistoryStore } from "./history.js"
import { helpSections } from "./help.js"
import { mediaLabel, parseReply, resolveMedia, type MediaKind } from "./media.js"
import type { AgentCliService } from "./agentCli.js"
import type { PromptFile } from "./opencode.js"
import type { ResolvedModel } from "./engineCall.js"
import type { BotConfig } from "./config.js"
import type { Opencode } from "./opencode.js"
import { OPS_COMMAND_MANAGED_KEYS, OPS_ENV_KEYS, type OpsResult, type OpsService } from "./ops.js"
import type { AliasEntry, AliasStore } from "./aliases.js"
import { maskProxyUrl, type ProxyRecord, type ProxyService } from "./proxy.js"

const API_PREFIX = "/api/v1"
// Attachment uploads are base64 on the same endpoint: a 15MB batch inflates
// to ~20MB, so the cap covers text-only requests with plenty of headroom
const MAX_BODY_BYTES = 48 * 1024 * 1024
const MAX_API_ATTACHMENTS = 4
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
/** Finished task records kept for polling; the queue itself never grows past the per-key chain. */
const MAX_TASK_RECORDS = 200
const MEDIA_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  zip: "application/zip",
}

function mimeForName(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  return MEDIA_MIME[ext] ?? "application/octet-stream"
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  // A garbage value must fall back to the default: NaN would slice the list empty.
  const value = Number(raw?.trim() || fallback)
  return Math.min(Math.max(Number.isFinite(value) ? Math.floor(value) : fallback, 1), max)
}

/** Session search text is free-form, so it gets a looser check than an ID. */
function assertSafeQuery(raw: string, label: string): string {
  const value = raw.trim()
  if (!value) throw new ApiError(400, `${label} 不能为空`)
  if (value.length > 128) throw new ApiError(400, `${label} 过长（上限 128 字）`)
  if (value.startsWith("-")) throw new ApiError(400, `${label} 不能以 - 开头`)
  // One argv token, and no control characters reaching the terminal output
  if (!/^[\w\s.@:/+-]+$/u.test(value)) throw new ApiError(400, `${label} 含有不支持的字符`)
  return value
}

/** Read-only `/cc` views the app may request by name; writes stay restricted to typed routes. */
const CC_VIEW_COMMANDS: Readonly<Record<string, string[]>> = {
  config: ["config", "show"],
  sessions: ["sessions", "list"],
  auth: ["auth", "status"],
  skills: ["skills", "list"],
  failover: ["failover", "show"],
  daemon: ["daemon", "status"],
  settings: ["settings", "show"],
}

interface CcExecSpec {
  label: string
  /** Build the fixed argv; `target` is already validated by assertSafeId. */
  args: (target: string) => string[]
  needsTarget?: boolean
  targetLabel?: string
  /** cc-switch prompts for confirmation on a TTY for these. */
  pty?: boolean
  /** Network-bound (skill market), so it needs the long cc-switch timeout. */
  long?: boolean
  /** Destructive: the caller must send confirm:true, mirroring Telegram's button. */
  confirm?: boolean
}

/** Section titles for the app's danger zone, keyed by cc-switch's top-level group. */
const CC_EXEC_GROUPS: Readonly<Record<string, string>> = {
  provider: "Provider",
  mcp: "MCP 服务器",
  prompts: "提示词",
  skills: "技能",
  sessions: "会话",
  failover: "故障转移",
  proxy: "代理",
  config: "配置",
  auth: "ChatGPT 账号",
}

/**
 * The mutating `/cc` commands the app may reach. Keys mirror Telegram's
 * confirmation gate; only these fixed argv shapes ever hit the CLI, so the
 * request body can never smuggle arbitrary arguments.
 */
const CC_EXEC_COMMANDS: Readonly<Record<string, CcExecSpec>> = {
  "provider-delete": {
    label: "删除 Provider",
    args: (id) => ["provider", "delete", id],
    needsTarget: true,
    targetLabel: "Provider ID",
    pty: true,
    confirm: true,
  },
  "provider-duplicate": {
    label: "复制 Provider",
    args: (id) => ["provider", "duplicate", id],
    needsTarget: true,
    targetLabel: "Provider ID",
  },
  "provider-set-default": {
    label: "设为应用默认 Provider",
    args: (id) => ["provider", "set-default", id],
    needsTarget: true,
    targetLabel: "Provider ID",
    confirm: true,
  },
  "provider-import-live": {
    label: "从当前 live 配置导入 Provider",
    args: () => ["provider", "import-live"],
    confirm: true,
  },
  "provider-remove-from-config": {
    label: "从 live 配置移除 Provider（不删除本体）",
    args: (id) => ["provider", "remove-from-config", id],
    needsTarget: true,
    targetLabel: "Provider ID",
    pty: true,
    confirm: true,
  },
  "mcp-enable": {
    label: "启用 MCP 服务器",
    args: (id) => ["mcp", "enable", id],
    needsTarget: true,
    targetLabel: "MCP 名称",
  },
  "mcp-disable": {
    label: "停用 MCP 服务器",
    args: (id) => ["mcp", "disable", id],
    needsTarget: true,
    targetLabel: "MCP 名称",
  },
  "failover-add": {
    label: "加入故障转移队列",
    args: (id) => ["failover", "add", id],
    needsTarget: true,
    targetLabel: "Provider ID",
  },
  "failover-remove": {
    label: "移出故障转移队列",
    args: (id) => ["failover", "remove", id],
    needsTarget: true,
    targetLabel: "Provider ID",
  },
  "proxy-enable": {
    label: "启用 cc-switch 代理",
    args: () => ["proxy", "enable"],
  },
  "proxy-disable": {
    label: "停用 cc-switch 代理",
    args: () => ["proxy", "disable"],
  },
  "config-validate": {
    label: "校验配置文件",
    args: () => ["config", "validate"],
  },
  "sessions-sync-usage": {
    label: "同步会话日志到用量统计",
    args: () => ["sessions", "sync-usage"],
    long: true,
  },
  "skills-sync": {
    label: "同步已启用技能到各应用目录",
    args: () => ["skills", "sync"],
    long: true,
  },
  "skills-update": {
    label: "更新单个技能仓库",
    args: (spec) => ["skills", "update", spec],
    needsTarget: true,
    targetLabel: "技能目录或 ID",
    long: true,
  },
  "skills-update-all": {
    label: "更新全部有新版技能",
    args: () => ["skills", "update", "--all"],
    long: true,
  },
  "mcp-delete": {
    label: "删除 MCP 服务器",
    args: (id) => ["mcp", "delete", id],
    needsTarget: true,
    targetLabel: "MCP 名称",
    pty: true,
    confirm: true,
  },
  "prompt-delete": {
    label: "删除提示词预设",
    args: (id) => ["prompts", "delete", id],
    needsTarget: true,
    targetLabel: "提示词 ID",
    pty: true,
    confirm: true,
  },
  "skill-uninstall": {
    label: "卸载技能",
    args: (id) => ["skills", "uninstall", id],
    needsTarget: true,
    targetLabel: "技能名称",
    pty: true,
    confirm: true,
  },
  "session-delete": {
    label: "删除会话",
    args: (id) => ["sessions", "delete", id, "--yes"],
    needsTarget: true,
    targetLabel: "会话 ID",
    confirm: true,
  },
  "skill-install": {
    label: "安装技能",
    args: (repo) => ["skills", "install", repo],
    needsTarget: true,
    targetLabel: "技能仓库 owner/name",
    long: true,
  },
  "failover-enable": {
    label: "启用自动故障转移（可能同时开启代理路由）",
    args: () => ["failover", "enable"],
    pty: true,
    confirm: true,
  },
  "failover-disable": {
    label: "停用自动故障转移",
    args: () => ["failover", "disable"],
  },
  "failover-clear": {
    label: "清空故障转移队列",
    args: () => ["failover", "clear", "--yes"],
    confirm: true,
  },
  "auth-remove": {
    label: "移除 ChatGPT 账号",
    args: (id) => ["auth", "remove", id],
    needsTarget: true,
    targetLabel: "账号 ID",
    pty: true,
    confirm: true,
  },
  "auth-logout": {
    label: "登出并清除所有 ChatGPT OAuth 数据",
    args: () => ["auth", "logout"],
    pty: true,
    confirm: true,
  },
  "config-reset": {
    label: "重置 cc-switch 配置为默认值",
    args: () => ["config", "reset"],
    pty: true,
    confirm: true,
  },
}

export interface ApiTaskView {
  id: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  text: string
  engine: string
  model?: string
  progress?: string
  reply?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** Attachments ride along on submit; only the count is echoed back. */
  attachmentCount?: number
  /** Media produced by the task, mirroring what Telegram receives. */
  media?: ApiTaskMediaView[]
}

interface ApiTaskMediaView {
  index: number
  kind: MediaKind
  label: string
  name: string
  size: number
  remote: boolean
}

interface ApiTaskMedia {
  kind: MediaKind
  name: string
  size: number
  remote: boolean
  /** Local absolute path inside data/outbox, or the original URL when remote. */
  target: string
}

interface ApiTask extends Omit<ApiTaskView, "media"> {
  key: string
  controller?: AbortController
  attachments?: ApiAttachment[]
  media?: ApiTaskMedia[]
  /** OpenCode pin resolved from `model` at submit; CLI engines use `model` directly. */
  modelRef?: ResolvedModel
}

export interface ApiAttachment {
  name: string
  mime: string
  data: string
}

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface ApiRequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  segments: string[]
}

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


/** A download-style response with an attachment filename. */
function res_attachment(res: ServerResponse, filename: string, contentType: string, body: string): void {
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "content-disposition": `attachment; filename="${filename}"`,
  })
  res.end(body)
}

function stamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** HTTP control surface for the companion Android app. Telegram keeps working in parallel. */
export class ApiServer {  readonly #opts: ApiServerOptions
  readonly #log: Logger
  readonly #token: string
  #server?: Server
  #sequence = 0
  #agentActionRunning = false
  /** Update/check can run npm for minutes; one at a time keeps the repo files sane. */
  #opsActionRunning = false
  #ccActionRunning = false
  readonly #tasks = new Map<string, ApiTask>()
  readonly #queues = new Map<string, Promise<void>>()
  /** SSE subscribers per task id; each gets the serialized task view on every update. */
  readonly #taskListeners = new Map<string, Set<(payload: string) => void>>()
  readonly #lastEmit = new Map<string, number>()

  constructor(options: ApiServerOptions, token: string) {
    this.#opts = options
    this.#log = options.log
    this.#token = token
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
    for (const task of this.#tasks.values()) task.controller?.abort()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Polling clients hold keep-alive sockets; close them so shutdown is prompt.
    server.closeAllConnections()
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    if (!url.pathname.startsWith(API_PREFIX)) {
      this.#json(res, 404, { error: "未知的 API 路径" })
      return
    }
    if (!this.#authorized(req)) {
      this.#json(res, 401, { error: "未授权：请在请求头携带 Authorization: Bearer <token>" })
      return
    }

    const segments = url.pathname.slice(API_PREFIX.length).split("/").filter(Boolean)
    const ctx: ApiRequestContext = { req, res, url, method: (req.method ?? "GET").toUpperCase(), segments }
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
      })
      return
    }

    if (resource === "help" && method === "GET") {
      this.#json(ctx.res, 200, { sections: helpSections() })
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
      await this.#resetSession()
      this.#json(ctx.res, 200, { ok: true, message: "已开启新会话，上下文已清空。" })
      return
    }

    if (resource === "task" && method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const text = typeof body.text === "string" ? body.text.trim() : ""
      const attachments = this.#parseAttachments(body.attachments)
      // Attachments-only tasks are allowed: #runTask fills in a default instruction per media kind.
      if (!text && (attachments?.length ?? 0) === 0) throw new ApiError(400, "缺少 text 字段")
      if (text.length > 12_000) throw new ApiError(400, "消息太长（上限 12000 字），请分段发送")
      // Same expansion the bot applies to /name messages, so shortcuts created in
      // either client work from both (built-in commands do not exist here).
      const expanded = this.#expandAlias(text)
      const engine = typeof body.engine === "string" && body.engine.trim() ? body.engine.trim() : undefined
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined
      const task = this.#submitTask(expanded, engine, model, attachments)
      this.#json(ctx.res, 202, { task: this.#view(task) })
      return
    }

    if (resource === "task" && id && method === "GET" && !action) {
      const task = this.#tasks.get(id)
      if (!task) throw new ApiError(404, "任务不存在或已被清理")
      this.#json(ctx.res, 200, { task: this.#view(task) })
      return
    }

    if (resource === "task" && id && action === "events" && method === "GET") {
      const task = this.#tasks.get(id)
      if (!task) throw new ApiError(404, "任务不存在或已被清理")
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
        // Already settled: a single snapshot response is friendlier than an
        // event stream that closes after one frame
        this.#json(ctx.res, 200, { task: this.#view(task) })
        return
      }
      this.#streamTaskEvents(ctx, task)
      return
    }

    if (resource === "task" && id && method === "GET" && action === "media") {
      await this.#sendTaskMedia(ctx, id, Number(segments[3]))
      return
    }

    if (resource === "task" && id && method === "POST" && action === "stop") {
      const task = this.#tasks.get(id)
      if (!task || task.key !== this.appKey) throw new ApiError(404, "任务不存在或已被清理")
      if (task.status === "queued") {
        task.status = "cancelled"
        task.finishedAt = Date.now()
        this.#emitTask(task, true)
      } else if (task.status === "running") {
        task.controller?.abort()
      } else {
        throw new ApiError(409, "任务已经结束")
      }
      this.#json(ctx.res, 200, { ok: true, task: this.#view(task) })
      return
    }

    if (resource === "task" && id && method === "POST" && action === "retry") {
      const failed = this.#tasks.get(id)
      if (!failed || failed.key !== this.appKey) throw new ApiError(404, "任务不存在或已被清理")
      if (failed.status === "queued" || failed.status === "running") {
        throw new ApiError(409, "任务还在排队或执行中，请先停止")
      }
      // Telegram's /retry replays the captured prompt, so reuse the stored text,
      // engine, model pin and attachments instead of a text-only client copy
      const task = this.#submitTask(failed.text, failed.engine, failed.model, failed.attachments)
      this.#json(ctx.res, 202, { ok: true, retriedFrom: id, task: this.#view(task) })
      return
    }

    if (resource === "tasks" && method === "GET") {
      const limit = clampLimit(ctx.url.searchParams.get("limit"), 50, MAX_TASK_RECORDS)
      const tasks = [...this.#tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
      this.#json(ctx.res, 200, { tasks: tasks.map((task) => this.#view(task)) })
      return
    }

    if (resource === "stop" && method === "POST") {
      this.#json(ctx.res, 200, this.#stopTasks())
      return
    }

    if (resource === "queue" && method === "POST" && id === "clear") {
      this.#json(ctx.res, 200, this.#clearQueued())
      return
    }

    if (resource === "queue" && method === "GET") {
      const tasks = [...this.#tasks.values()]
        .filter((task) => task.key === this.appKey && (task.status === "queued" || task.status === "running"))
        .sort((a, b) => a.createdAt - b.createdAt)
      this.#json(ctx.res, 200, { tasks: tasks.map((task) => this.#view(task)) })
      return
    }

    if (resource === "dir") {
      await this.#routeDir(ctx)
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

    if (resource === "agents" && method === "GET") {
      this.#json(ctx.res, 200, { agents: this.#agentsView() })
      return
    }

    if (resource === "agent" && method === "POST") {
      const body = await this.#readJsonBody(ctx.req)
      // resolveEngine (not resolve): the literal "opencode" must select the
      // server engine, not the opencode CLI whose bin is also called opencode
      const resolved = this.#opts.agents.registry.resolveEngine(typeof body.engine === "string" ? body.engine : "")
      if (!resolved) throw new ApiError(400, `未知的 Agent 引擎，可用：opencode, ${this.#opts.agents.registry.list().map((p) => p.id).join(", ")}`)
      this.#opts.store.setEngine(this.appKey, resolved)
      this.#json(ctx.res, 200, { ok: true, session: this.#sessionView() })
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
          sessionMessage = this.#applyModel(result.model)
        } catch {
          sessionMessage = undefined
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
      this.#json(ctx.res, 200, { models: this.#modelsView(ctx.url.searchParams.get("engine") ?? undefined) })
      return
    }

    if (resource === "model" && method === "POST") {
      const body = await this.#readJsonBody(ctx.req)
      const raw = typeof body.model === "string" ? body.model.trim() : ""
      if (!raw) throw new ApiError(400, "缺少 model 字段")
      const message = this.#applyModel(raw)
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

    if (resource === "usage" && method === "GET") {
      const summary = this.#opts.usage.summary(this.appKey)
      this.#json(ctx.res, 200, { usage: summary, trend: this.#opts.usage.recentDays(this.appKey, 7) })
      return
    }

    if (resource === "history" && method === "GET") {
      const limit = clampLimit(ctx.url.searchParams.get("limit"), 20, 50)
      // total lets the app show the same "已显示 N / 共 M 条" line Telegram does
      this.#json(ctx.res, 200, {
        history: this.#opts.history.list(this.appKey, limit),
        total: this.#opts.history.count(this.appKey),
      })
      return
    }

    if (resource === "export" && method === "GET") {
      const format = (ctx.url.searchParams.get("format") ?? "markdown").toLowerCase()
      if (format !== "markdown" && format !== "json") throw new ApiError(400, "format 仅支持 markdown 或 json")
      const entries = this.#opts.history.list(this.appKey, 50)
      if (format === "json") {
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), key: this.appKey, entries }, null, 2)
        res_attachment(ctx.res, `agentbot-history-${stamp()}.json`, "application/json; charset=utf-8", payload)
        return
      }
      const markdown = formatHistoryMarkdown(entries, {
        source: `App (${this.appKey})`,
        timeZone: this.#opts.timezone(),
      })
      res_attachment(ctx.res, `agentbot-history-${stamp()}.md`, "text/markdown; charset=utf-8", markdown)
      return
    }

    if (resource === "history" && method === "DELETE") {
      this.#json(ctx.res, 200, { cleared: this.#opts.history.clear(this.appKey) })
      return
    }

    if (resource === "reminders") {
      await this.#routeReminders(ctx, id)
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

  #customModelView(key: string, entry: ModelInfo): Record<string, unknown> {
    return { key, providerID: entry.providerID, modelID: entry.modelID, label: entry.label, desc: entry.desc }
  }

  async #routeCustomModels(ctx: ApiRequestContext, key: string | undefined): Promise<void> {
    const models = this.#opts.models
    if (ctx.method === "GET" && !key) {
      const custom = models.listCustomModels()
      this.#json(ctx.res, 200, {
        models: Object.entries(custom).map(([name, entry]) => this.#customModelView(name, entry)),
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
      const input = {
        key: typeof body.key === "string" ? body.key : "",
        providerID: typeof body.providerID === "string" ? body.providerID : "",
        modelID: typeof body.modelID === "string" ? body.modelID : "",
        label: typeof body.label === "string" ? body.label : undefined,
        desc: typeof body.desc === "string" ? body.desc : undefined,
        attachment: typeof body.attachment === "boolean" ? body.attachment : undefined,
        contextWindow: typeof body.contextWindow === "number" ? body.contextWindow : undefined,
        outputLimit: typeof body.outputLimit === "number" ? body.outputLimit : undefined,
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
      this.#json(ctx.res, 200, {
        ok: true,
        message: `已添加自定义模型 ${added.key}（${input.providerID}/${input.modelID}）。`,
        model: this.#customModelView(added.key, added.entry),
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

  async #routeCc(ctx: ApiRequestContext, id: string | undefined, action: string | undefined): Promise<void> {
    const cc = this.#opts.ccswitch
    if (!cc) throw new ApiError(409, "当前运行环境不支持 cc-switch")

    if (ctx.method === "GET" && !id) {
      if (!cc.available) {
        this.#json(ctx.res, 200, { available: false, app: cc.app, bin: null, version: null, providers: [], current: null, error: null })
        return
      }
      let providers: CcSwitchProvider[] = []
      let error: string | undefined
      try {
        providers = await cc.listProviders()
      } catch (err) {
        error = redactSecrets(err instanceof Error ? err.message : String(err))
      }
      const version = await cc.version()
      this.#json(ctx.res, 200, {
        available: true,
        app: cc.app,
        bin: cc.bin ?? null,
        version: version ?? null,
        providers: providers.map((provider) => ({ id: provider.id, name: provider.name, current: provider.current })),
        current: providers.find((provider) => provider.current)?.id ?? null,
        error: error ?? null,
      })
      return
    }

    if (ctx.method === "GET" && id === "view") {
      const name = ctx.url.searchParams.get("name") ?? ""
      const args = Object.hasOwn(CC_VIEW_COMMANDS, name) ? CC_VIEW_COMMANDS[name] : undefined
      if (!args) throw new ApiError(400, "未知的视图，可用：config、sessions、auth、skills、failover、daemon、settings")
      const result = await this.#ccQuery(() => cc.run(args))
      this.#json(ctx.res, 200, {
        name,
        text: this.#clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "GET" && id === "proxy") {
      this.#json(ctx.res, 200, { text: this.#clipCcOutput(await this.#ccQuery(() => cc.proxyShow())) })
      return
    }

    if (ctx.method === "GET" && id === "mcp") {
      this.#json(ctx.res, 200, { text: this.#clipCcOutput(await this.#ccQuery(() => cc.listMcp())) })
      return
    }

    if (ctx.method === "GET" && id === "prompts") {
      this.#json(ctx.res, 200, { text: this.#clipCcOutput(await this.#ccQuery(() => cc.listPrompts())) })
      return
    }

    if (ctx.method === "GET" && id === "env") {
      const mode = ctx.url.searchParams.get("mode") === "tools" ? "tools" : "check"
      const text = await this.#ccQuery(() => (mode === "tools" ? cc.envTools() : cc.envCheck()))
      this.#json(ctx.res, 200, { mode, text: this.#clipCcOutput(text) })
      return
    }

    if (ctx.method === "GET" && (id === "stream" || id === "models")) {
      // Typed Telegram commands `/cc stream <id>` and `/cc models <id>` as buttons.
      const providerId = ctx.url.searchParams.get("id")?.trim() ?? ""
      if (!providerId) throw new ApiError(400, "缺少 id 查询参数（Provider ID）")
      const text = await this.#ccQuery(() => (id === "stream" ? cc.streamCheck(providerId) : cc.fetchModels(providerId)))
      this.#json(ctx.res, 200, { id: providerId, text: this.#clipCcOutput(redactSecrets(text)) })
      return
    }

    if (ctx.method === "GET" && id === "sessions") {
      // `/cc sessions search <关键词>`; the read-only listing stays on /cc/view?name=sessions
      const query = assertSafeQuery(ctx.url.searchParams.get("q") ?? "", "搜索关键词")
      const result = await this.#ccQuery(() => cc.run(["sessions", "search", query], CC_LONG_TIMEOUT_MS))
      this.#json(ctx.res, 200, {
        query,
        text: this.#clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "GET" && id === "quota") {
      // `/cc quota <id>` read-only: the --reset variant burns credit and stays on Telegram.
      const providerId = ctx.url.searchParams.get("id")?.trim() ?? ""
      if (!providerId) throw new ApiError(400, "缺少 id 查询参数（Provider ID）")
      const result = await this.#ccQuery(() => cc.run(["provider", "quota", assertSafeId(providerId, "Provider ID")]))
      this.#json(ctx.res, 200, {
        id: providerId,
        text: this.#clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "use") {
      const body = await this.#readJsonBody(ctx.req)
      const providerId = typeof body.id === "string" ? body.id.trim() : ""
      if (!providerId) throw new ApiError(400, "缺少 id 字段")
      const text = await this.#runCcAction(() => cc.useProvider(providerId))
      this.#json(ctx.res, 200, { ok: true, message: `已切换 Provider 到 ${providerId}。`, text: this.#clipCcOutput(text) })
      return
    }

    if (ctx.method === "POST" && id === "test") {
      const body = await this.#readJsonBody(ctx.req)
      let providerId = typeof body.id === "string" ? body.id.trim() : ""
      if (!providerId) {
        const providers = await this.#ccQuery(() => cc.listProviders())
        providerId = providers.find((provider) => provider.current)?.id ?? ""
      }
      if (!providerId) throw new ApiError(400, "未找到当前 Provider，请在请求中指定 id")
      const result = await this.#runCcAction(() => cc.speedtest(providerId))
      this.#json(ctx.res, 200, {
        ok: result.ok,
        id: providerId,
        latencyMs: result.latencyMs ?? null,
        status: result.status ?? null,
        text: this.#clipCcOutput(redactSecrets(result.raw)),
      })
      return
    }

    if (ctx.method === "POST" && id === "mcp" && action === "sync") {
      const text = await this.#runCcAction(() => cc.syncMcp())
      this.#json(ctx.res, 200, { ok: true, message: "已同步 MCP 配置。", text: this.#clipCcOutput(text) })
      return
    }

    if (ctx.method === "POST" && id === "prompts" && (action === "activate" || action === "deactivate")) {
      const body = await this.#readJsonBody(ctx.req)
      const promptId = typeof body.id === "string" ? body.id.trim() : ""
      if (action === "activate" && !promptId) throw new ApiError(400, "缺少 id 字段")
      const text = await this.#runCcAction(() => (action === "activate" ? cc.activatePrompt(promptId) : cc.deactivatePrompt()))
      this.#json(ctx.res, 200, {
        ok: true,
        message: action === "activate" ? `已启用提示词 ${promptId}。` : "已停用提示词。",
        text: this.#clipCcOutput(text),
      })
      return
    }

    if (ctx.method === "POST" && id === "mcp" && action === "import") {
      const body = await this.#readJsonBody(ctx.req)
      const raw = typeof body.json === "string" ? body.json.trim() : ""
      if (!raw) throw new ApiError(400, "缺少 json 字段（MCP 服务器配置）")
      if (raw.length > 20_000) throw new ApiError(400, "MCP 配置过长（上限 20000 字）")
      const text = await this.#runCcAction(() => cc.importMcp(raw))
      this.#json(ctx.res, 200, { ok: true, message: "已提交 MCP 导入。", text: this.#clipCcOutput(text) })
      return
    }

    if (ctx.method === "POST" && id === "prompts" && action === "create") {
      const body = await this.#readJsonBody(ctx.req)
      const name = typeof body.name === "string" ? body.name.trim() : ""
      const content = typeof body.content === "string" ? body.content.trim() : ""
      if (!name || !content) throw new ApiError(400, "缺少 name 或 content 字段")
      if (/\s/.test(name)) throw new ApiError(400, "提示词名称不能包含空格")
      if (content.length > 20_000) throw new ApiError(400, "提示词内容过长（上限 20000 字）")
      const text = await this.#runCcAction(() => cc.importPrompt(name, content))
      this.#json(ctx.res, 200, { ok: true, message: `已创建提示词 ${name}。`, text: this.#clipCcOutput(text) })
      return
    }

    if (ctx.method === "GET" && id === "exec") {
      // The app renders its danger zone from this, so the two sides cannot drift
      const groupOrder = Object.values(CC_EXEC_GROUPS)
      const commands = Object.entries(CC_EXEC_COMMANDS)
        .map(([name, spec]) => ({
          name,
          label: spec.label,
          // the argv builders are pure, so a dry call reveals the cc-switch group
          group: CC_EXEC_GROUPS[spec.args("")[0] ?? ""] ?? "其他",
          needsTarget: spec.needsTarget ?? false,
          targetLabel: spec.targetLabel ?? "目标 ID",
          confirm: spec.confirm ?? false,
        }))
        // stable sort keeps the table order inside a section
        .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group))
      this.#json(ctx.res, 200, { commands })
      return
    }

    if (ctx.method === "GET" && id === "providers") {
      // The create form renders these, so cc-switch's allowed values stay server-side
      this.#json(ctx.res, 200, {
        app: cc.app,
        // OpenCode-style apps only accept raw settings JSON, so the form must ask for it
        fieldMode: cc.supportsProviderFields,
        templates: [...CC_PROVIDER_TEMPLATES],
        apiFormats: [...CC_PROVIDER_API_FORMATS],
        nameMaxLength: 80,
        configMaxLength: 20_000,
      })
      return
    }

    if (ctx.method === "POST" && id === "providers") {
      // The typed twin of Telegram's `/cc provider add ...`; the API key is masked
      // by the service before anything is returned, and never echoed back.
      const body = await this.#readJsonBody(ctx.req)
      const text = (key: string): string | undefined => {
        const value = body[key]
        return typeof value === "string" && value.trim() ? value.trim() : undefined
      }
      const name = text("name")
      if (!name) throw new ApiError(400, "缺少 name 字段（Provider 显示名）")
      const draft: CcSwitchProviderDraft = {
        name,
        id: text("id"),
        template: text("template"),
        baseUrl: text("baseUrl"),
        apiKey: text("apiKey"),
        model: text("model"),
        apiFormat: text("apiFormat"),
        config: typeof body.config === "string" ? body.config.trim() : undefined,
      }
      const result = await this.#withCcLock(async () => {
        try {
          return await cc.addProvider(draft)
        } catch (err) {
          // A rejected field is the form's mistake; only real CLI failures are 502
          if (err instanceof CcSwitchError) throw new ApiError(400, redactSecrets(err.message))
          throw new ApiError(502, redactSecrets(err instanceof Error ? err.message : String(err)))
        }
      })
      this.#json(ctx.res, result.code === 0 ? 200 : 502, {
        ok: result.code === 0,
        name: draft.name,
        message: result.code === 0 ? `已创建 Provider「${draft.name}」。` : `创建 Provider 失败（退出码 ${result.code}）`,
        text: this.#clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "deeplink") {
      const body = await this.#readJsonBody(ctx.req)
      const url = typeof body.url === "string" ? body.url.trim() : ""
      if (!url) throw new ApiError(400, "缺少 url 字段")
      if (!/^ccswitch:\/\/v1\/import\?/i.test(url)) throw new ApiError(400, "只接受 ccswitch://v1/import?... 形式的链接")
      if (url.length > 8192) throw new ApiError(400, "Deep Link 过长（上限 8192 字）")
      if (body.confirm !== true) throw new ApiError(400, "Deep Link 会覆盖 Provider/MCP/提示词配置，需要 confirm: true")
      const result = await this.#runCcAction(() => cc.runBare(["deeplink", url], CC_LONG_TIMEOUT_MS))
      this.#json(ctx.res, 200, {
        ok: result.code === 0,
        // cc-switch links can carry provider keys, so the URL is not echoed back
        message: result.code === 0 ? "已导入 Deep Link。" : "Deep Link 导入失败",
        text: this.#clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "exec") {
      const body = await this.#readJsonBody(ctx.req)
      const name = typeof body.name === "string" ? body.name.trim() : ""
      const spec = Object.hasOwn(CC_EXEC_COMMANDS, name) ? CC_EXEC_COMMANDS[name] : undefined
      if (!spec) throw new ApiError(400, `未知的操作，可用：${Object.keys(CC_EXEC_COMMANDS).join("、")}`)
      if (spec.confirm && body.confirm !== true) throw new ApiError(400, `「${spec.label}」需要确认，请在请求中带上 confirm: true`)
      const rawTarget = typeof body.arg === "string" ? body.arg.trim() : ""
      if (spec.needsTarget && !rawTarget) throw new ApiError(400, `缺少 arg 字段（${spec.targetLabel ?? "目标 ID"}）`)
      if (!spec.needsTarget && rawTarget) throw new ApiError(400, "该操作不接受 arg 字段")
      let target = ""
      if (rawTarget) {
        try {
          target = assertSafeId(rawTarget, spec.targetLabel ?? "ID")
        } catch (err) {
          // A malformed id is the caller's mistake, not a cc-switch failure
          throw new ApiError(400, err instanceof Error ? err.message : "目标 ID 不合法")
        }
      }
      const args = spec.args(target)
      const result = await this.#runCcAction(() =>
        spec.pty ? cc.runWithConfirm(args) : cc.run(args, spec.long ? CC_LONG_TIMEOUT_MS : undefined),
      )
      this.#json(ctx.res, 200, {
        ok: result.code === 0,
        name,
        code: result.code,
        message: `${result.code === 0 ? "已完成" : "执行失败"}：${spec.label}${target ? `（${target}）` : ""}`,
        text: this.#clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    throw new ApiError(404, "未知的 cc-switch API 路径")
  }

  #clipCcOutput(text: string): string {
    return text.length > 20_000 ? text.slice(-20_000) : text
  }

  async #ccQuery<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      throw new ApiError(502, redactSecrets(err instanceof Error ? err.message : String(err)))
    }
  }

  async #runCcAction<T>(run: () => Promise<T>): Promise<T> {
    return this.#withCcLock(async () => {
      try {
        return await run()
      } catch (err) {
        throw new ApiError(502, redactSecrets(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  /** Same single-flight as #runCcAction, but the caller maps the errors. */
  async #withCcLock<T>(run: () => Promise<T>): Promise<T> {
    if (this.#ccActionRunning) throw new ApiError(409, "已有 cc-switch 操作在执行，请稍后再试")
    this.#ccActionRunning = true
    try {
      return await run()
    } finally {
      this.#ccActionRunning = false
    }
  }

  async #routeConfig(ctx: ApiRequestContext, key: string | undefined): Promise<void> {
    const ops = this.#opts.ops
    if (!ops) throw new ApiError(409, "当前运行环境不支持配置管理")

    if (ctx.method === "GET" && !key) {
      this.#json(ctx.res, 200, this.#configView(ops))
      return
    }

    if (ctx.method === "PUT" && key) {
      const body = await this.#readJsonBody(ctx.req)
      if (typeof body.value !== "string") throw new ApiError(400, "缺少 value 字段")
      const upper = key.trim().toUpperCase()
      // Timezone has a live-apply path shared with /timezone; going through it keeps
      // reminders/schedules in sync instead of only rewriting .env
      const result =
        upper === "REMINDER_TIMEZONE" && this.#opts.setTimezone
          ? this.#opts.setTimezone(body.value.trim())
          : ops.envSet(upper, body.value)
      if (!result.ok) throw new ApiError(400, result.message)
      this.#json(ctx.res, 200, { ok: true, message: result.message, config: this.#configView(ops) })
      return
    }

    if (ctx.method === "DELETE" && key) {
      const result = ops.envUnset(key)
      if (!result.ok) throw new ApiError(400, result.message)
      this.#json(ctx.res, 200, { ok: true, message: result.message, config: this.#configView(ops) })
      return
    }

    throw new ApiError(404, "未知的配置 API 路径")
  }

  #configView(ops: OpsService): Record<string, unknown> {
    const list = ops.envList()
    return {
      exists: list.exists,
      entries: list.entries,
      editableKeys: OPS_ENV_KEYS.filter((name) => !OPS_COMMAND_MANAGED_KEYS.has(name)),
    }
  }

  async #routeAccess(ctx: ApiRequestContext, id: string | undefined): Promise<void> {
    const access = this.#opts.access
    if (!access) throw new ApiError(409, "当前运行环境不支持白名单管理")
    if (ctx.method === "GET" && !id) {
      this.#json(ctx.res, 200, access.list())
      return
    }
    if (ctx.method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const raw = Array.isArray(body.ids) ? body.ids : typeof body.id === "string" ? [body.id] : []
      const ids = raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      if (ids.length === 0) throw new ApiError(400, "缺少 id 字段，例如：{\"id\":\"12345678\"}")
      const result = access.add(ids)
      if (!result.ok) throw new ApiError(400, result.message)
      this.#json(ctx.res, 200, { ok: true, message: result.message, ...access.list() })
      return
    }
    if (ctx.method === "DELETE" && id) {
      const result = access.remove([id])
      if (!result.ok) throw new ApiError(400, result.message)
      this.#json(ctx.res, 200, { ok: true, message: result.message, ...access.list() })
      return
    }
    throw new ApiError(404, "未知的白名单 API 路径")
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

  #aliasView(entry: AliasEntry): Record<string, unknown> {
    return { name: entry.name, expansion: entry.expansion, createdAt: entry.createdAt }
  }

  async #routeAliases(ctx: ApiRequestContext, id: string | undefined): Promise<void> {
    const aliases = this.#opts.aliases
    if (!aliases) throw new ApiError(409, "当前运行环境不支持快捷指令")
    const chatId = this.#requireOwnerChat("快捷指令")
    if (ctx.method === "GET" && !id) {
      this.#json(ctx.res, 200, { aliases: aliases.list(chatId).map((entry) => this.#aliasView(entry)) })
      return
    }
    if (ctx.method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const name = typeof body.name === "string" ? body.name.trim().replace(/^\//, "") : ""
      const expansion = typeof body.expansion === "string" ? body.expansion.trim() : ""
      if (!name) throw new ApiError(400, "缺少 name 字段，例如：{\"name\":\"code\",\"expansion\":\"审查代码\"}")
      if (!expansion) throw new ApiError(400, "缺少 expansion 字段（指令触发后要发送的内容）")
      let entry: AliasEntry
      try {
        entry = aliases.add(chatId, name, expansion)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法创建快捷指令")
      }
      this.#json(ctx.res, 201, { ok: true, message: `已创建 /${entry.name}。`, alias: this.#aliasView(entry) })
      return
    }
    if (ctx.method === "DELETE" && id) {
      const removed = aliases.remove(chatId, id)
      if (!removed) throw new ApiError(404, "快捷指令不存在")
      this.#json(ctx.res, 200, { ok: true, message: `已删除 /${removed.name}。` })
      return
    }
    throw new ApiError(404, "未知的快捷指令 API 路径")
  }

  #proxyView(proxy: ProxyRecord, activeId?: number): Record<string, unknown> {
    return {
      id: proxy.id,
      name: proxy.name,
      // The URL can embed SOCKS/HTTP credentials; the app only ever sees the masked form.
      url: maskProxyUrl(proxy.url),
      protocol: proxy.protocol,
      createdAt: proxy.createdAt,
      active: proxy.id === activeId,
    }
  }

  async #routeProxy(ctx: ApiRequestContext, id: string | undefined, action: string | undefined): Promise<void> {
    const proxies = this.#opts.proxies
    if (!proxies) throw new ApiError(409, "当前运行环境不支持代理管理")
    if (ctx.method === "GET" && !id) {
      const active = proxies.active()
      this.#json(ctx.res, 200, {
        active: active?.id ?? null,
        proxies: proxies.list().map((proxy) => this.#proxyView(proxy, active?.id)),
      })
      return
    }
    if (ctx.method === "POST" && id === "off") {
      proxies.disable()
      this.#json(ctx.res, 200, { ok: true, message: "已停用代理。", active: null })
      return
    }
    if (ctx.method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const url = typeof body.url === "string" ? body.url.trim() : ""
      const name = typeof body.name === "string" ? body.name.trim() : undefined
      if (!url) throw new ApiError(400, "缺少 url 字段，例如：{\"url\":\"http://127.0.0.1:7890\"}")
      let proxy: ProxyRecord
      try {
        proxy = await proxies.add(url, name)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法添加代理")
      }
      this.#json(ctx.res, 201, {
        ok: true,
        message: `代理 #${proxy.id} 测试通过并已添加。`,
        proxy: this.#proxyView(proxy, proxies.active()?.id),
      })
      return
    }
    const proxyId = Number(id)
    if (!Number.isInteger(proxyId)) throw new ApiError(404, "未知的代理 API 路径")
    if (ctx.method === "POST" && action === "use") {
      let proxy: ProxyRecord
      try {
        proxy = proxies.use(proxyId)
      } catch {
        throw new ApiError(404, "代理不存在")
      }
      this.#json(ctx.res, 200, {
        ok: true,
        message: `已启用代理 #${proxy.id}。`,
        proxy: this.#proxyView(proxy, proxy.id),
      })
      return
    }
    if (ctx.method === "POST" && action === "test") {
      if (!proxies.list().some((proxy) => proxy.id === proxyId)) throw new ApiError(404, "代理不存在")
      const result = await proxies.test(proxyId)
      this.#json(ctx.res, 200, result)
      return
    }
    if (ctx.method === "DELETE" && !action) {
      const removed = proxies.remove(proxyId)
      if (!removed) throw new ApiError(404, "代理不存在")
      this.#json(ctx.res, 200, { ok: true, message: `已删除代理 #${removed.id}。` })
      return
    }
    throw new ApiError(404, "未知的代理 API 路径")
  }

  async #routeReminders(ctx: ApiRequestContext, id: string | undefined): Promise<void> {
    const chatId = this.#requireOwnerChat("提醒")
    if (ctx.method === "GET" && !id) {
      this.#json(ctx.res, 200, { reminders: this.#opts.reminders.list(chatId).map((r) => this.#publicReminder(r)) })
      return
    }
    if (ctx.method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const text = typeof body.text === "string" ? body.text.trim() : ""
      if (!text) throw new ApiError(400, "缺少 text 字段，例如：{\"text\":\"30m 喝水\"}")
      let reminder
      try {
        reminder = this.#opts.reminders.add(chatId, chatId, text)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法解析提醒时间")
      }
      this.#json(ctx.res, 201, { reminder: this.#publicReminder(reminder) })
      return
    }
    const reminderId = Number(id)
    if (ctx.method === "DELETE" && Number.isInteger(reminderId)) {
      const removed = this.#opts.reminders.cancel(chatId, reminderId)
      if (!removed) throw new ApiError(404, "提醒不存在")
      this.#json(ctx.res, 200, { ok: true })
      return
    }
    throw new ApiError(404, "未知的提醒 API 路径")
  }

  async #routeSchedules(ctx: ApiRequestContext, id: string | undefined, action: string | undefined): Promise<void> {
    const chatId = this.#requireOwnerChat("定时任务")
    if (ctx.method === "GET" && !id) {
      this.#json(ctx.res, 200, { schedules: this.#opts.schedules.list(chatId).map((task) => this.#publicSchedule(task)) })
      return
    }
    if (ctx.method === "POST" && !id) {
      const body = await this.#readJsonBody(ctx.req)
      const text = typeof body.text === "string" ? body.text.trim() : ""
      if (!text) throw new ApiError(400, "缺少 text 字段，例如：{\"text\":\"每天 09:00 检查服务器\"}")
      const engine = this.#opts.store.getEngine(this.appKey)
      const defaults =
        engine === "opencode"
          ? { engine, model: resolveOpencodeModel(this.#opts.store, this.#opts.cfg.opencode.model, this.appKey) }
          : { engine, cliModel: this.#opts.store.getCliModel(this.appKey, engine) }
      let task
      try {
        task = this.#opts.schedules.add(chatId, chatId, text, defaults)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法解析定时任务")
      }
      this.#json(ctx.res, 201, { schedule: this.#publicSchedule(task) })
      return
    }
    const taskId = Number(id)
    if (!Number.isInteger(taskId)) throw new ApiError(404, "未知的定时任务 API 路径")
    if (ctx.method === "DELETE" && !action) {
      const removed = this.#opts.schedules.remove(chatId, taskId)
      if (!removed) throw new ApiError(404, "定时任务不存在")
      this.#json(ctx.res, 200, { ok: true })
      return
    }
    if (ctx.method === "POST" && (action === "pause" || action === "resume")) {
      const updated =
        action === "pause" ? this.#opts.schedules.pause(chatId, taskId) : this.#opts.schedules.resume(chatId, taskId)
      if (!updated) throw new ApiError(404, "定时任务不存在")
      this.#json(ctx.res, 200, { schedule: this.#publicSchedule(updated) })
      return
    }
    if (ctx.method === "POST" && action === "run") {
      let task
      try {
        task = this.#opts.schedules.runNow(chatId, taskId)
      } catch (err) {
        throw new ApiError(409, err instanceof Error ? err.message : "定时任务正在执行中")
      }
      if (!task) throw new ApiError(404, "定时任务不存在")
      this.#json(ctx.res, 200, {
        ok: true,
        message: `已立即执行定时任务 #${taskId}，结果会发送到 Telegram（不影响原定时间）。`,
        schedule: this.#publicSchedule(task),
      })
      return
    }
    throw new ApiError(404, "未知的定时任务 API 路径")
  }

  /** `/dir` equivalent: the working directory CLI engines start in for the app session. */
  async #routeDir(ctx: ApiRequestContext): Promise<void> {
    if (ctx.method === "GET") {
      this.#json(ctx.res, 200, this.#dirView())
      return
    }
    if (ctx.method !== "POST") throw new ApiError(405, "只支持 GET 或 POST")
    const body = await this.#readJsonBody(ctx.req)

    if (body.reset === true) {
      const cleared = this.#opts.store.clearDir(this.appKey)
      if (cleared) this.#resetCliSessions()
      this.#json(ctx.res, 200, {
        ok: true,
        message: cleared ? "已恢复默认工作目录（CLI 会话上下文已重置）" : "已经是默认工作目录",
        dir: this.#dirView(),
      })
      return
    }

    const raw = typeof body.dir === "string" ? body.dir.trim() : ""
    if (!raw) throw new ApiError(400, "缺少 dir 字段（或传 reset: true 恢复默认目录）")
    // Switching directories under a running task would split one session across projects
    if (this.#hasActiveTask()) throw new ApiError(409, "任务执行中，请先停止当前任务再切换工作目录")
    const dir = normalizeWorkDirInput(raw, this.#opts.agents.defaultWorkDir, homedir())
    if (!dir) {
      throw new ApiError(400, "路径无效：不能为空、含控制字符、超过 512 字符，或指向文件系统根目录")
    }
    let isDirectory = false
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch {
      // reported below
    }
    if (!isDirectory) throw new ApiError(400, `目录不存在或不是目录：${dir}`)

    this.#opts.store.setDir(this.appKey, dir)
    this.#resetCliSessions()
    this.#json(ctx.res, 200, {
      ok: true,
      message: "工作目录已更新（CLI 会话上下文已重置）",
      dir: this.#dirView(),
    })
  }

  #dirView(): Record<string, unknown> {
    const engine = this.#opts.store.getEngine(this.appKey)
    const view: Record<string, unknown> = {
      engine,
      workDir: this.#opts.agents.workDir(this.appKey),
      defaultWorkDir: this.#opts.agents.defaultWorkDir,
      custom: this.#opts.store.getDir(this.appKey) ?? null,
    }
    if (engine === "opencode") view.note = "OpenCode 的目录由其服务端决定，该设置只影响 CLI 引擎"
    return view
  }

  async #routeTimezone(ctx: ApiRequestContext): Promise<void> {
    if (ctx.method === "GET") {
      this.#json(ctx.res, 200, { timezone: this.#opts.timezone() })
      return
    }
    if (ctx.method !== "POST") throw new ApiError(405, "只支持 GET 或 POST")
    const body = await this.#readJsonBody(ctx.req)
    const zone = typeof body.timezone === "string" ? body.timezone.trim() : ""
    if (!zone) throw new ApiError(400, "缺少 timezone 字段，例如：Asia/Shanghai")
    const setter = this.#opts.setTimezone
    if (!setter) throw new ApiError(409, "当前运行环境不支持在线切换时区")
    const result = setter(zone)
    if (!result.ok) throw new ApiError(400, result.message)
    this.#json(ctx.res, 200, { ok: true, message: result.message, timezone: this.#opts.timezone() })
  }

  #hasActiveTask(): boolean {
    return [...this.#tasks.values()].some(
      (task) => task.key === this.appKey && (task.status === "queued" || task.status === "running"),
    )
  }

  /** A CLI session belongs to the directory it was created in, so both reset together. */
  #resetCliSessions(): void {
    for (const profile of this.#opts.agents.registry.list()) {
      this.#opts.store.clearCliSession(this.appKey, profile.id)
    }
  }

  #requireOwnerChat(feature: string): number {
    const owner = this.#opts.ownerChatId
    if (!owner) {
      throw new ApiError(409, `${feature}需要一个推送目标：请在 .env 的 TELEGRAM_ALLOW_USERS 配置你的 Telegram 用户 ID`)
    }
    return owner
  }

  #sessionView(): Record<string, unknown> {
    const engine = this.#opts.store.getEngine(this.appKey)
    const profile = this.#opts.agents.registry.get(engine)
    const view: Record<string, unknown> = {
      key: this.appKey,
      engine,
      engineLabel: this.#opts.agents.registry.label(engine),
      engineInstalled: engine === "opencode" ? true : Boolean(profile && this.#opts.agents.registry.binPath(profile)),
      timezone: this.#opts.timezone(),
    }
    if (engine === "opencode") {
      const model = resolveOpencodeModel(this.#opts.store, this.#opts.cfg.opencode.model, this.appKey)
      view.model = model.label
      view.modelRef = model
      view.hasSession = Boolean(this.#opts.store.get(this.appKey))
    } else {
      const model = this.#opts.store.getCliModel(this.appKey, engine) ?? this.#opts.agents.registry.defaultModel(engine)
      view.model = model
        ? this.#opts.agents.registry.modelLabel(engine, model)
        : profile?.supportsModel
          ? "默认"
          : "由 CLI 决定"
      view.hasSession = Boolean(this.#opts.store.getCliSession(this.appKey, engine))
      view.workDir = this.#opts.agents.workDir(this.appKey)
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

  /**
   * Accepts the client's attachment list: base64-decodable, sane names/mimes,
   * at most 4 files and 15MB decoded in total (same caps as Telegram).
   */
  #parseAttachments(raw: unknown): ApiAttachment[] | undefined {
    if (raw === undefined || raw === null) return undefined
    if (!Array.isArray(raw)) throw new ApiError(400, "attachments 必须是数组")
    if (raw.length > MAX_API_ATTACHMENTS) {
      throw new ApiError(400, `附件最多 ${MAX_API_ATTACHMENTS} 个`)
    }
    let total = 0
    const parsed = raw.map((item) => {
      if (!item || typeof item !== "object") throw new ApiError(400, "附件项必须是 {name, mime, data} 对象")
      const record = item as Record<string, unknown>
      const name = typeof record.name === "string" ? record.name.trim().slice(0, 200) : ""
      const mime = typeof record.mime === "string" ? record.mime.trim().slice(0, 100) : ""
      const data = typeof record.data === "string" ? record.data : ""
      if (!name || !data) throw new ApiError(400, "附件缺少 name 或 data")
      if (!MIME_RE.test(mime)) throw new ApiError(400, `附件 ${name} 的 mime 无效`)
      const stripped = data.replace(/\s+/g, "")
      if (!BASE64_RE.test(stripped)) throw new ApiError(400, `附件 ${name} 不是合法的 base64`)
      const bytes = Math.floor((stripped.length * 3) / 4)
      total += bytes
      if (total > MAX_ATTACH_TOTAL_BYTES) {
        throw new ApiError(400, `附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
      }
      return { name, mime: mime.toLowerCase(), data: stripped }
    })
    return parsed.length > 0 ? parsed : undefined
  }

  /** Persists API attachments into the same inbox the Telegram flow uses. */
  #saveAttachments(attachments: ApiAttachment[]): { saved: SavedAttachment[]; failed: string[] } {
    const chatId = this.#opts.ownerChatId ?? 0
    const saved: SavedAttachment[] = []
    const failed: string[] = []
    for (const att of attachments) {
      try {
        const buffer = Buffer.from(att.data, "base64")
        if (buffer.byteLength === 0) {
          failed.push(`${att.name}: 附件为空`)
          continue
        }
        const stored = saveAttachment(this.#opts.cfg.inboxDir, chatId, att.name, buffer)
        const kind: AttachmentKind = att.mime.startsWith("image/")
          ? "image"
          : att.mime.startsWith("audio/")
            ? "audio"
            : "document"
        const record: SavedAttachment = {
          fileId: "",
          kind,
          name: stored.name,
          mime: att.mime,
          path: stored.path,
          bytes: buffer.byteLength,
        }
        if (isTextAttachment(att.mime, stored.name)) {
          try {
            const { text, truncated } = readTextAttachment(stored.path)
            record.text = text
            record.truncated = truncated
          } catch {
            // treat as binary if decoding fails
          }
        }
        saved.push(record)
      } catch (err) {
        failed.push(`${att.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    pruneInbox(this.#opts.cfg.inboxDir)
    return { saved, failed }
  }

  #submitTask(text: string, engineOverride?: string, modelOverride?: string, attachments?: ApiAttachment[]): ApiTask {
    const id = `t${Date.now().toString(36)}${++this.#sequence}`
    const engine = engineOverride ?? this.#opts.store.getEngine(this.appKey)
    const profile = engine === "opencode" ? undefined : this.#opts.agents.registry.get(engine)
    if (!profile && engine !== "opencode") {
      throw new ApiError(400, `未知的 Agent 引擎：${engine}`)
    }
    const task: ApiTask = {
      id,
      key: this.appKey,
      status: "queued",
      text,
      engine,
      model: modelOverride,
      createdAt: Date.now(),
      attachments,
    }
    // Validate the pin now so a bad name answers 400 like POST /model does, instead of
    // queueing a task that can only fail later. OpenCode needs the full reference.
    if (modelOverride) {
      if (engine === "opencode") {
        let info: ModelInfo
        try {
          info = this.#opts.models.resolveModel(modelOverride)
        } catch (err) {
          throw new ApiError(400, err instanceof Error ? err.message : `未识别的模型：${modelOverride}`)
        }
        task.modelRef = { providerID: info.providerID, modelID: info.modelID, label: info.label }
      } else if (!this.#opts.agents.registry.resolveModel(engine, modelOverride)) {
        const options = (profile?.models ?? []).map((model) => model.id).join(", ")
        throw new ApiError(400, options ? `未知的模型，可用：${options}` : "该引擎不支持指定模型")
      }
    }
    this.#tasks.set(id, task)
    this.#pruneTasks()

    const previous = this.#queues.get(task.key) ?? Promise.resolve()
    const run = previous.then(
      () => this.#runTask(task),
      () => this.#runTask(task),
    )
    this.#queues.set(task.key, run)
    const cleanup = (): void => {
      if (this.#queues.get(task.key) === run) this.#queues.delete(task.key)
    }
    run.then(cleanup, cleanup)
    return task
  }

  async #runTask(task: ApiTask): Promise<void> {
    if (task.status === "cancelled") return
    task.status = "running"
    task.startedAt = Date.now()
    this.#emitTask(task, true)
    const controller = new AbortController()
    task.controller = controller
    const engine = task.engine
    const isOpencode = engine === "opencode"
    const started = Date.now()
    let outcome: UsageOutcome = "failed"
    let modelLabel: string | undefined

    try {
      let opencodeModel: ResolvedModel | undefined
      if (!isOpencode) {
        const profile = this.#opts.agents.registry.get(engine)
        if (!profile) throw new Error(`未知的 Agent 引擎：${engine}`)
        const resolvedModel =
          task.model ?? this.#opts.store.getCliModel(task.key, engine) ?? this.#opts.agents.registry.defaultModel(engine)
        modelLabel = this.#opts.agents.registry.modelLabel(engine, resolvedModel ?? "")
        task.model = task.model ?? resolvedModel
      } else {
        opencodeModel =
          task.modelRef ?? resolveOpencodeModel(this.#opts.store, this.#opts.cfg.opencode.model, task.key)
        modelLabel = opencodeModel.label
      }

      let input: { text: string; files: PromptFile[] } = { text: task.text, files: [] }
      if (task.attachments?.length) {
        const caps = isOpencode ? await this.#opts.oc.inputCapabilities(opencodeModel) : undefined
        const { saved, failed } = this.#saveAttachments(task.attachments)
        input = buildAttachmentSections(task.text, { saved, failed, modelCapabilities: caps })
      }

      const reply = await callEngine(this.#engineDeps, {
        key: task.key,
        engine,
        text: input.text,
        files: input.files,
        model: opencodeModel,
        cliModel: isOpencode ? undefined : (task.model ?? undefined),
        signal: controller.signal,
        onProgress: (summary) => {
          task.progress = summary
          this.#emitTask(task)
        },
      })
      const settled = this.#settleReply(reply)
      task.reply = settled.text
      task.media = settled.media
      task.status = "done"
      outcome = "ok"
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (/已取消当前任务/.test(detail)) {
        task.status = "cancelled"
        outcome = "cancelled"
      } else {
        task.status = "failed"
        task.error = redactSecrets(detail).slice(0, 2000)
      }
    } finally {
      task.finishedAt = Date.now()
      task.controller = undefined
      this.#opts.usage.record(task.key, { engine, model: modelLabel, ms: Date.now() - started, outcome })
      this.#opts.history.record(task.key, {
        prompt: task.text || this.#attachmentSummary(task.attachments),
        engine,
        model: modelLabel,
        ms: Date.now() - started,
        outcome,
        scheduled: false,
      })
      // One terminal snapshot (reply/error + status + finishedAt) for SSE subscribers
      this.#emitTask(task, true)
    }
  }

  /** History label for an attachment-only task, which has no prompt text of its own. */
  #attachmentSummary(attachments?: ApiAttachment[]): string {
    const kinds: string[] = []
    for (const item of attachments ?? []) {
      const kind = item.mime.startsWith("image/")
        ? "图片"
        : item.mime.startsWith("audio/")
          ? "语音"
          : item.mime === "application/pdf"
            ? "PDF"
            : "文件"
      if (!kinds.includes(kind)) kinds.push(kind)
    }
    return kinds.length > 0 ? `（${kinds.join("、")}）` : ""
  }

  /** Telegram's 「清空排队」: drops queued tasks only, leaving the running one alone. */
  #clearQueued(): { cleared: string[] } {
    const cleared: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.key !== this.appKey || task.status !== "queued") continue
      task.status = "cancelled"
      task.finishedAt = Date.now()
      this.#emitTask(task, true)
      cleared.push(task.id)
    }
    return { cleared }
  }

  #stopTasks(): { stopped: string[] } {
    const stopped: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.key !== this.appKey) continue
      if (task.status === "queued") {
        task.status = "cancelled"
        task.finishedAt = Date.now()
        this.#emitTask(task, true)
        stopped.push(task.id)
      } else if (task.status === "running") {
        task.controller?.abort()
        stopped.push(task.id)
      }
    }
    return { stopped }
  }

  get #engineDeps(): EngineCallDeps {
    return {
      oc: this.#opts.oc,
      agents: this.#opts.agents,
      store: this.#opts.store,
      log: this.#log,
      opencodeAgent: this.#opts.cfg.opencode.agent ?? "assistant",
      opencodeModel: this.#opts.cfg.opencode.model,
      taskTimeoutMs: this.#opts.cfg.taskTimeoutMs,
      taskMaxTimeoutMs: this.#opts.cfg.taskMaxTimeoutMs,
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
        agent: this.#agentView(profile),
      })
    } finally {
      this.#agentActionRunning = false
    }
  }

  #agentsView(): Array<Record<string, unknown>> {
    return this.#opts.agents.registry.list().map((profile) => this.#agentView(profile))
  }

  #agentView(profile: AgentCliProfile): Record<string, unknown> {
    const installer = this.#opts.installer
    const installed = Boolean(this.#opts.agents.registry.binPath(profile))
    return {
      id: profile.id,
      label: profile.label,
      desc: profile.desc,
      installed,
      install: profile.install,
      sessionMode: profile.sessionMode,
      supportsModel: Boolean(profile.supportsModel),
      defaultModel: profile.defaultModel,
      models: profile.models,
      experimental: profile.experimental,
      managed: installer?.isManaged(profile.id) ?? false,
      installable: Boolean(!installed && installer?.installCommand(profile)),
      updateable: Boolean(installer?.updateCommand(profile.id)),
      uninstallable: Boolean(installer?.uninstallCommand(profile.id)),
      installCommand: installer?.installCommand(profile),
      updateCommand: installer?.updateCommand(profile.id),
      uninstallCommand: installer?.uninstallCommand(profile.id),
    }
  }

  #modelsView(requestedEngine?: string): Record<string, unknown> {
    // A one-off pin can target another engine than the session, so callers may ask
    // explicitly instead of only getting the current engine's list.
    const engine = requestedEngine?.trim() || this.#opts.store.getEngine(this.appKey)
    if (engine !== "opencode" && !this.#opts.agents.registry.get(engine)) {
      throw new ApiError(400, `未知的 Agent 引擎：${engine}`)
    }
    if (engine === "opencode") {
      const custom = this.#opts.models.listCustomModels()
      const builtin = Object.entries(AVAILABLE_MODELS).map(([key, info]) => ({ key, ...info }))
      const customEntries = Object.entries(custom).map(([key, info]) => ({ key, ...info }))
      return { engine, models: [...customEntries, ...builtin] }
    }
    const profile = this.#opts.agents.registry.get(engine)
    return {
      engine,
      models: profile?.supportsModel ? (profile.models ?? []) : [],
      modelHint: profile?.modelHint,
    }
  }

  #applyModel(raw: string): string {
    const engine = this.#opts.store.getEngine(this.appKey)
    if (raw === "default" || raw === "默认") {
      if (engine === "opencode") {
        this.#opts.store.clearModel(this.appKey)
        const fallback = defaultOpencodeModel(this.#opts.cfg.opencode.model)
        return `已恢复默认模型 ${fallback.label}`
      }
      // An empty string is the "unset" marker for CLI model preferences
      this.#opts.store.setCliModel(this.appKey, engine, "")
      return "已恢复该引擎的默认模型"
    }
    if (engine === "opencode") {
      let info: ModelInfo
      try {
        info = this.#opts.models.resolveModel(raw)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法识别的模型")
      }
      this.#opts.store.setModel(this.appKey, { providerID: info.providerID, modelID: info.modelID, label: info.label })
      return `模型已切换为 ${info.label}`
    }
    const resolved = this.#opts.agents.registry.resolveModel(engine, raw)
    if (!resolved) {
      const profile = this.#opts.agents.registry.get(engine)
      const options = (profile?.models ?? []).map((m) => m.id).join(", ")
      throw new ApiError(400, options ? `未知的模型，可用：${options}` : "该引擎不支持指定模型")
    }
    this.#opts.store.setCliModel(this.appKey, engine, resolved)
    return `模型已切换为 ${this.#opts.agents.registry.modelLabel(engine, resolved)}`
  }

  #publicReminder(reminder: Reminder): Record<string, unknown> {
    return { id: reminder.id, text: reminder.text, dueAt: reminder.dueAt, repeat: reminder.repeat }
  }

  #publicSchedule(task: ScheduledTask): Record<string, unknown> {
    return {
      id: task.id,
      prompt: task.prompt,
      dueAt: task.dueAt,
      engine: task.engine,
      // Same "引擎 / 模型" line Telegram shows, including `--engine/--model` pins.
      target: scheduleTargetLabel(task, this.#opts.agents.registry),
      repeat: task.repeat,
      paused: Boolean(task.paused),
      lastRunAt: task.lastRunAt,
      lastStatus: task.lastStatus,
    }
  }

  async #statusView(): Promise<Record<string, unknown>> {
    const usage = this.#opts.usage.summary(this.appKey)
    const running = [...this.#tasks.values()].find((task) => task.status === "running" || task.status === "queued")
    return {
      uptimeMs: Math.round(process.uptime() * 1000),
      version: this.#opts.version,
      timezone: this.#opts.timezone(),
      engine: this.#opts.store.getEngine(this.appKey),
      usageToday: usage.today,
      opencodeReachable: await this.#opts.oc.health(),
      activeTask: running ? this.#view(running) : undefined,
      tasksTotal: this.#tasks.size,
    }
  }

  /**
   * Pushes a task snapshot to its SSE subscribers. Progress lines can arrive
   * hundreds of times a second for verbose CLI output, so non-terminal updates
   * are throttled; status transitions always go out immediately.
   */
  #emitTask(task: ApiTask, immediate = false): void {
    const listeners = this.#taskListeners.get(task.id)
    if (!listeners || listeners.size === 0) return
    const now = Date.now()
    if (!immediate) {
      const last = this.#lastEmit.get(task.id) ?? 0
      if (now - last < 250) return
    }
    this.#lastEmit.set(task.id, now)
    const payload = JSON.stringify({ task: this.#view(task) })
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch {
        // A broken subscriber is dropped by its own close handler
      }
    }
    const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled"
    if (terminal) {
      this.#taskListeners.delete(task.id)
      this.#lastEmit.delete(task.id)
    }
  }

  /** Renders the task as a server-sent-events response; ends on the terminal state. */
  #streamTaskEvents(ctx: ApiRequestContext, task: ApiTask): void {
    const { req, res } = ctx
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx and friends must not buffer the stream
      "x-accel-buffering": "no",
    })
    let closed = false
    const listener = (payload: string): void => {
      if (closed) return
      res.write(`data: ${payload}\n\n`)
      // The emitter drops the listener set on terminal states; end the response so
      // the client sees a clean stream close instead of waiting for a heartbeat
      if (payload.includes('"status":"done"') || payload.includes('"status":"failed"') || payload.includes('"status":"cancelled"')) {
        cleanup()
      }
    }
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n")
    }, 15_000)
    const cleanup = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      const listeners = this.#taskListeners.get(task.id)
      if (listeners) {
        listeners.delete(listener)
        if (listeners.size === 0) this.#taskListeners.delete(task.id)
      }
      res.end()
    }
    req.on("close", cleanup)
    req.on("error", cleanup)

    const listeners = this.#taskListeners.get(task.id) ?? new Set()
    listeners.add(listener)
    this.#taskListeners.set(task.id, listeners)
    // Replay the current state first so late subscribers skip the polling round-trip
    res.write(`data: ${JSON.stringify({ task: this.#view(task) })}\n\n`)
  }

  #view(task: ApiTask): ApiTaskView {
    const { controller: _controller, key: _key, attachments, media, ...view } = task
    return {
      ...view,
      ...(attachments?.length ? { attachmentCount: attachments.length } : {}),
      ...(media?.length
        ? {
            media: media.map((item, index) => ({
              index,
              kind: item.kind,
              label: mediaLabel(item.kind),
              name: item.name,
              size: item.size,
              remote: item.remote,
            })),
          }
        : {}),
    }
  }

  /** Strips media directives from the reply and resolves what Telegram would send. */
  #settleReply(reply: string): { text: string; media: ApiTaskMedia[] } {
    const { parts } = parseReply(reply)
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    const media: ApiTaskMedia[] = []
    for (const part of parts) {
      if (part.type !== "media") continue
      try {
        const resolved = resolveMedia(part.kind, part.target, this.#opts.cfg.outboxDir, this.#opts.cfg.maxMediaBytes)
        media.push({
          kind: part.kind,
          name: resolved.name,
          size: resolved.size,
          remote: resolved.isUrl,
          target: resolved.target,
        })
      } catch (err) {
        this.#log.warn(
          `api media skipped (${part.kind}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return { text, media }
  }

  /** Streams one media item produced by a finished task; same auth as every other endpoint. */
  async #sendTaskMedia(ctx: ApiRequestContext, id: string, index: number): Promise<void> {
    const task = this.#tasks.get(id)
    if (!task || task.key !== this.appKey) throw new ApiError(404, "任务不存在或已被清理")
    const item = Number.isInteger(index) ? task.media?.[index] : undefined
    if (!item) throw new ApiError(404, "媒体不存在")

    let data: Buffer
    if (item.remote) {
      const fetchMedia = this.#opts.fetchMedia
      if (!fetchMedia) throw new ApiError(503, "服务端未启用远程媒体下载")
      try {
        data = await fetchMedia(item.target)
      } catch (err) {
        throw new ApiError(
          502,
          `获取远程媒体失败：${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        )
      }
    } else {
      data = readFileSync(item.target)
    }

    ctx.res.writeHead(200, {
      "Content-Type": mimeForName(item.name),
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      "Cache-Control": "private, max-age=300",
    })
    ctx.res.end(data)
  }

  #pruneTasks(): void {
    if (this.#tasks.size <= MAX_TASK_RECORDS) return
    const finished = [...this.#tasks.values()]
      .filter((task) => task.status !== "queued" && task.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
    for (const task of finished) {
      if (this.#tasks.size <= MAX_TASK_RECORDS) break
      this.#tasks.delete(task.id)
    }
  }

  async #readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength
      if (total > MAX_BODY_BYTES) throw new ApiError(413, "请求体过大")
      chunks.push(chunk as Buffer)
    }
    if (total === 0) return {}
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      throw new ApiError(400, "请求体必须是 JSON 对象")
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(400, "请求体不是合法的 JSON")
    }
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    })
    res.end(payload)
  }
}
