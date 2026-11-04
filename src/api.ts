import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentCliInstaller } from "./agentInstaller.js"
import { isTextAttachment, pruneInbox, readTextAttachment, saveAttachment, type AttachmentKind, type SavedAttachment } from "./attachments.js"
import { buildAttachmentSections, MAX_ATTACH_TOTAL_BYTES } from "./attachmentInput.js"
import { applyStt } from "./stt.js"
import { decodeEncKey, decryptPayload, encryptPayload, ENC_HEADER, ENC_VERSION, randomEncKey } from "./apiCrypto.js"
import { clampLimit, mimeForName, res_attachment_binary } from "./apiHttp.js"
import type { ModelInfo } from "./models.js"
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
import type { UsageOutcome, UsageStore } from "./usage.js"
import type { TaskHistoryStore } from "./history.js"
import { BOT_COMMAND_ALIASES, BOT_MENU_COMMANDS, CC_SUB_ALIASES, helpSections } from "./help.js"
import { mediaLabel, parseReply, resolveMedia, type MediaKind } from "./media.js"
import type { AgentCliService } from "./agentCli.js"
import type { PromptFile } from "./opencode.js"
import type { ResolvedModel } from "./engineCall.js"
import type { BotConfig } from "./config.js"
import type { Opencode } from "./opencode.js"
import { type OpsResult, type OpsService } from "./ops.js"
import type { AliasStore } from "./aliases.js"
import type { ProxyService } from "./proxy.js"

const API_PREFIX = "/api/v1"
// Attachment uploads are base64 on the same endpoint: a 15MB batch inflates
// to ~20MB, so the cap covers text-only requests with plenty of headroom
const MAX_BODY_BYTES = 48 * 1024 * 1024
const MAX_API_ATTACHMENTS = 4
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
/** Finished task records kept for polling; the queue itself never grows past the per-key chain. */
const MAX_TASK_RECORDS = 200

/** HTTP helpers live in apiHttp.ts so the route split can grow without re-plumbing. */

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

/**
 * The word runs a typed `/cc …` can use for one argv shape: the group and subcommand
 * it really runs — a third literal word included, for shapes like `skills repos add` —
 * plus every Telegram alias that resolves to them (`provider rm` for `provider delete`).
 * Derived from the tables below, so the App answers a typed command without hardcoding
 * a single cc-switch word.
 */
function ccPhrases(argv: string[]): string[] {
  const words = argv.filter((part) => part.length > 0 && !part.startsWith("-")).slice(0, 3)
  const [group, sub, third] = words
  if (!group || !sub) return []
  const pair = `${group} ${sub}`
  const phrases = third ? [`${pair} ${third}`, pair] : [pair]
  for (const [alias, target] of Object.entries(CC_SUB_ALIASES)) {
    if (target[0] === group && target[1] === sub) phrases.push(alias)
  }
  return phrases
}

interface CcViewSpec {
  label: string
  /** Build the fixed argv; `target` is already validated with assertSafeId. */
  args: (target: string) => string[]
  needsTarget?: boolean
  targetLabel?: string
  /** Network-bound (repos, marketplace), so it needs the long cc-switch timeout. */
  long?: boolean
}

/**
 * Read-only `/cc` views, mirroring what Telegram can print. The app renders this
 * table, so a new view needs no app release; argv stays built here.
 */
const CC_VIEWS: Readonly<Record<string, CcViewSpec>> = {
  config: { label: "cc-switch 配置", args: () => ["config", "show"] },
  sessions: { label: "会话列表", args: () => ["sessions", "list"] },
  "session-show": {
    label: "会话详情",
    args: (id) => ["sessions", "show", id],
    needsTarget: true,
    targetLabel: "会话 ID 或 provider/ID",
  },
  "session-messages": {
    label: "会话消息",
    args: (id) => ["sessions", "messages", id],
    needsTarget: true,
    targetLabel: "会话 ID 或 provider/ID",
  },
  "provider-current": { label: "当前 Provider", args: () => ["provider", "current"] },
  auth: { label: "认证状态", args: () => ["auth", "status"] },
  "auth-list": { label: "ChatGPT 账号列表", args: () => ["auth", "list"] },
  skills: { label: "技能列表", args: () => ["skills", "list"] },
  "skill-info": {
    label: "技能详情",
    args: (name) => ["skills", "info", name],
    needsTarget: true,
    targetLabel: "技能目录或 ID",
  },
  "skills-discover": { label: "仓库可用技能", args: () => ["skills", "discover"], long: true },
  "skills-updates": { label: "检查技能更新", args: () => ["skills", "check-updates"], long: true },
  failover: { label: "故障转移状态", args: () => ["failover", "show"] },
  "failover-list": { label: "故障转移队列", args: () => ["failover", "list"] },
  "failover-available": { label: "可加入队列的 Provider", args: () => ["failover", "available"] },
  "prompt-current": { label: "当前提示词", args: () => ["prompts", "current"] },
  "prompt-live": { label: "生效中的提示词文件", args: () => ["prompts", "live"] },
  "prompt-show": {
    label: "提示词内容",
    args: (id) => ["prompts", "show", id],
    needsTarget: true,
    targetLabel: "提示词 ID",
  },
  "config-path": { label: "配置文件路径", args: () => ["config", "path"] },
  "daemon-logs": { label: "守护进程日志", args: () => ["daemon", "logs"] },
  daemon: { label: "守护进程", args: () => ["daemon", "status"] },
  settings: { label: "cc-switch 设置", args: () => ["settings", "show"] },
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
  daemon: "守护进程",
  settings: "设置",
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
  "prompt-activate": {
    label: "启用提示词预设",
    args: (id) => ["prompts", "activate", id],
    needsTarget: true,
    targetLabel: "提示词 ID",
  },
  "prompt-deactivate": {
    label: "停用当前提示词预设",
    args: () => ["prompts", "deactivate"],
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
  // The `/cc` words Telegram also answers, given the same argv shapes here so a typed
  // command in the App resolves instead of stopping at the panel.
  "skills-repos-add": {
    label: "添加技能仓库",
    args: (spec) => ["skills", "repos", "add", spec],
    needsTarget: true,
    targetLabel: "技能仓库 owner/name",
    long: true,
  },
  "settings-language": {
    label: "切换 cc-switch 界面语言",
    args: (lang) => ["settings", "language", lang],
    needsTarget: true,
    targetLabel: "语言代码（en / zh）",
  },
  "daemon-start": {
    label: "后台启动 cc-switch 守护进程",
    args: () => ["daemon", "start", "--detach"],
  },
  "daemon-stop": {
    label: "停止 cc-switch 守护进程",
    args: () => ["daemon", "stop"],
    confirm: true,
  },
  "config-backup": {
    label: "备份当前配置文件",
    args: () => ["config", "backup"],
  },
  "auth-default": {
    label: "设为默认 ChatGPT 账号",
    args: (id) => ["auth", "default", id],
    needsTarget: true,
    targetLabel: "账号 ID",
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

export interface ApiRequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  segments: string[]
  /** True when this request asked for (and got) v1 message-level encryption. */
  encrypted: boolean
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
  /** Per-request encryption keys, stashed at dispatch so #readJsonBody/#json need no new params. */
  readonly #bodyKeys = new WeakMap<IncomingMessage, Buffer>()
  readonly #resKeys = new WeakMap<ServerResponse, Buffer>()

  constructor(options: ApiServerOptions, token: string, encKey?: Buffer) {
    this.#opts = options
    this.#log = options.log
    this.#token = token
    this.#encKey = encKey
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
      this.#json(ctx.res, 200, { models: modelsView(this.#personalDeps(), ctx.url.searchParams.get("engine") ?? undefined) })
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

    if (ctx.method === "GET" && id === "views") {
      // Labels and target prompts come from the server, so the app never hardcodes this list
      this.#json(ctx.res, 200, {
        views: Object.entries(CC_VIEWS).map(([name, spec]) => ({
          name,
          label: spec.label,
          needsTarget: spec.needsTarget ?? false,
          targetLabel: spec.targetLabel ?? "目标 ID",
          // So a typed 「/cc provider current」 resolves here instead of in the app
          tokens: ccPhrases(spec.args("")),
        })),
      })
      return
    }

    if (ctx.method === "GET" && id === "view") {
      const name = ctx.url.searchParams.get("name") ?? ""
      const spec = Object.hasOwn(CC_VIEWS, name) ? CC_VIEWS[name] : undefined
      if (!spec) throw new ApiError(400, `未知的视图，可用：${Object.keys(CC_VIEWS).join("、")}`)
      const raw = ctx.url.searchParams.get("target") ?? ""
      const label = spec.targetLabel ?? "目标 ID"
      // An absent target stays empty (the argv builder ignores it); a needed one must validate
      const target = raw ? this.#ccTargetId(raw, label) : ""
      if (spec.needsTarget && !target) throw new ApiError(400, `「${spec.label}」需要${label}`)
      const result = await this.#ccQuery(() => cc.run(spec.args(target), spec.long ? CC_LONG_TIMEOUT_MS : undefined))
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
      const result = await this.#ccQuery(() => cc.run(["provider", "quota", this.#ccTargetId(providerId, "Provider ID")]))
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
          // Same word list as the views, so 「/cc provider del foo」 reaches this gate
          tokens: ccPhrases(spec.args("")),
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

  /** cc-switch's ID guard throws its own error type; a bad id is the caller's mistake. */
  #ccTargetId(raw: string, label: string): string {
    try {
      return assertSafeId(raw, label)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : `${label} 不合法`)
    }
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
  async #routeDir(ctx: ApiRequestContext): Promise<void> {
    await routeDirApi(this.#personalDeps(), ctx)
  }

  async #routeTimezone(ctx: ApiRequestContext): Promise<void> {
    await routeTimezoneApi(this.#personalDeps(), ctx)
  }

  #hasActiveTask(): boolean {
    return [...this.#tasks.values()].some(
      (task) => task.key === this.appKey && (task.status === "queued" || task.status === "running"),
    )
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
        const stt = await applyStt(saved, { stt: this.#opts.cfg.stt, modelCapabilities: caps })
        input = buildAttachmentSections(task.text, { saved: stt.saved, failed: [...failed, ...stt.errors], modelCapabilities: caps })
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
        agent: agentView(this.#personalDeps(), profile),
      })
    } finally {
      this.#agentActionRunning = false
    }
  }

  // Engine/model views moved to apiPersonal.ts (agentsView/modelsView/agentView).

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

  // Wire views for reminders/schedules moved to apiPersonal.ts (publicReminder/publicSchedule).

  async #statusView(): Promise<Record<string, unknown>> {
    const usage = this.#opts.usage.summary(this.appKey)
    const pending = [...this.#tasks.values()].filter((task) => task.status === "running" || task.status === "queued")
    return {
      uptimeMs: Math.round(process.uptime() * 1000),
      version: this.#opts.version,
      timezone: this.#opts.timezone(),
      engine: this.#opts.store.getEngine(this.appKey),
      usageToday: usage.today,
      opencodeReachable: await this.#opts.oc.health(),
      activeTask: pending[0] ? this.#view(pending[0]) : undefined,
      // `tasksTotal` also covers finished rows the map still keeps for retry and SSE,
      // so a client that wants queue depth needs `tasksActive` rather than reading into it.
      tasksTotal: this.#tasks.size,
      tasksActive: pending.length,
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
        throw new ApiError(400, `解密请求体失败：${(err as Error).message}`)
      }
      return parseObject(inner)
    }
    return parseObject(raw.toString("utf8"))
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    let payload = JSON.stringify(body)
    const encKey = this.#resKeys.get(res)
    const headers: Record<string, string | number> = {
      "content-type": "application/json; charset=utf-8",
    }
    if (encKey) {
      payload = encryptPayload(encKey, payload)
      headers[ENC_HEADER] = ENC_VERSION
    }
    headers["content-length"] = Buffer.byteLength(payload)
    res.writeHead(status, headers)
    res.end(payload)
  }
}
