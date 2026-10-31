import { randomBytes } from "node:crypto"
import QRCode from "qrcode"
import { readFileSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { relative, resolve, sep } from "node:path"
import { Agent, fetch as undiciFetch } from "undici"
import { Bot, InlineKeyboard, InputFile } from "grammy"
import type { Context } from "grammy"
import type { Message } from "grammy/types"
import {
  formatBytes,
  isTextAttachment,
  pruneInbox,
  readTextAttachment,
  saveAttachment,
  type AttachmentDescriptor,
  type SavedAttachment,
} from "./attachments.js"
import type { BotConfig, ModelRef } from "./config.js"
import { CcSwitchService, redactSecrets, CcSwitchProviderDraft } from "./ccswitch.js"
import { AliasStore } from "./aliases.js"
import { CcCommands, type CcHost } from "./ccCommands.js"
import { formatHistoryMarkdown, TaskHistoryStore } from "./history.js"
import { CC_HELP, HELP, HELP_FULL } from "./help.js"
import type { Logger } from "./logger.js"

export { HELP_FULL }
import { assertUrlAllowed, mediaLabel, parseReply, pinnedLookup, resolveMedia, safeMediaTarget, type ReplyPart } from "./media.js"
import { clip, escapeMarkdown, pruneChatState, splitMessage, type Panel } from "./messages.js"
export { pruneChatState }
export { parseProviderAdd } from "./ccCommands.js"
import { ModelAdmin } from "./modelAdmin.js"
import { AgentCliService, normalizeWorkDirInput, type AgentCliProfile } from "./agentCli.js"
import { buildAttachmentSections } from "./attachmentInput.js"
import { AgentCliInstaller } from "./agentInstaller.js"
import { appVersion } from "./version.js"
import {
  AVAILABLE_MODELS,
  reloadCustomModels,
  resolveModelKey,
  type ModelInfo,
} from "./models.js"
import { callEngine, resolveOpencodeModel, type EngineCallDeps } from "./engineCall.js"
import { resolveApiToken } from "./api.js"
import { Opencode, type PromptFile } from "./opencode.js"
import { OPS_ENV_KEYS, OPS_ENV_RULES, OpsService, type OpsDiagnostics, type OpsResult } from "./ops.js"
import { ProgressTracker } from "./progress.js"
import { maskProxyUrl, ProxyService } from "./proxy.js"
import { describeRepeat, formatRemaining, formatReminderTime, MAX_PER_CHAT, ReminderService, type Reminder, zonedParts } from "./reminders.js"
import { scheduleTargetLabel, ScheduleService, type ScheduleDefaults, type ScheduledTask } from "./scheduler.js"
import type { BackendEngine, SessionStore } from "./store.js"
import { UsageStore, type UsageOutcome } from "./usage.js"
import { DailyReportService } from "./usageReport.js"
const MAX_INPUT_LENGTH = 12_000
const MAX_PENDING = 4
const MAX_ATTACHMENTS = 4
const MAX_ATTACH_FILE_BYTES = 10 * 1024 * 1024
const MAX_ATTACH_TOTAL_BYTES = 15 * 1024 * 1024
const MAX_INLINE_TEXT_TOTAL = 100_000
const CHUNK_DELAY_MS = 250
const TELEGRAM_MAX_TEXT = 4000
const SHUTDOWN_DRAIN_MS = 3_000
/** Per-chat bookkeeping is pruned past this many chats so an allow-all bot cannot grow without bound. */
const CHAT_STATE_LIMIT = 500

/** Failure cards keep their prompt for the 重试 button; only the newest ones survive. */
const RETRY_CARD_LIMIT = 100


// Control commands routed through the per-chat queue (they touch session state);
// everything else that reaches the queue is a prompt and must respect the cap.
const QUEUED_COMMANDS = new Set(["/agent", "/new", "/reset", "/id", "/model", "/cc", "/retry"])

/** Monotonic queue-entry ids, because a plain index would shift under a button press. */
let jobSequence = 0

/** `/model <word>` spellings that drop the chat's own selection and fall back to the configured default. */
const MODEL_DEFAULT_WORDS = new Set(["default", "reset", "clear", "auto", "默认", "恢复默认"])

const SCHEDULE_USAGE = `🗓 *定时 AI 任务*

• \`/schedule\` - 打开任务面板
• \`/schedule add 30m 检查服务器\` - 到点自动执行
• \`/schedule add --engine claude --model sonnet 2h 汇总日志\` - 指定引擎与模型
• \`/schedule add every 2h 汇总日志\` / \`/schedule add 每天 09:00 生成日报\` - 重复执行（也支持 \`每2小时\`、\`下午6点\`）
• \`/schedule pause 编号\` / \`/schedule resume 编号\` / \`/schedule del 编号\` - 管理任务
• \`/schedule run 编号\` - 立即执行一次（不影响原定时间）

时间格式与 \`/remind\` 相同；提示词上限 2000 字，每个会话最多 20 个任务。`


const CC_SUB_ALIASES: Record<string, [string, string]> = {
  "provider del": ["provider", "delete"],
  "provider rm": ["provider", "delete"],
  "mcp del": ["mcp", "delete"],
  "mcp rm": ["mcp", "delete"],
  "prompts use": ["prompts", "activate"],
  "prompts off": ["prompts", "deactivate"],
  "prompts stop": ["prompts", "deactivate"],
  "prompts del": ["prompts", "delete"],
  "prompts rm": ["prompts", "delete"],
  "skills del": ["skills", "uninstall"],
  "skills repo": ["skills", "repos"],
  "sessions del": ["sessions", "delete"],
  "auth del": ["auth", "remove"],
}

interface Job {
  key: string
  text: string
  chatId: number
  userId: number
  generation: number
  /** Queue-panel handle: lets one queued message be dropped without touching the rest. */
  id?: string
  dropped?: boolean
  attachments?: AttachmentDescriptor[]
  scheduled?: boolean
  engine?: BackendEngine
  model?: { providerID: string; modelID: string; label: string }
  cliModel?: string
  /** Prompt captured when a queued /retry was submitted; the live last-prompt may change. */
  retryOf?: { text: string; attachments?: AttachmentDescriptor[] }
  onOutcome?: (outcome: UsageOutcome) => void
}

/** Telegram's own "/" autocomplete menu; kept in sync with the help text by tests. */
export const BOT_MENU_COMMANDS = [
  { command: "start", description: "欢迎页与功能菜单入口" },
  { command: "menu", description: "打开功能菜单" },
  { command: "help", description: "分类帮助（/help full 查看全部）" },
  { command: "status", description: "查看运行状态" },
  { command: "new", description: "开启新会话（清空上下文）" },
  { command: "agent", description: "查看或切换 Agent 引擎（推荐 OpenCode）" },
  { command: "model", description: "查看或切换大模型" },
  { command: "dir", description: "查看或切换本会话 CLI 工作目录" },
  { command: "agents", description: "检测、安装或卸载 Agent CLI" },
  { command: "schedule", description: "定时执行 AI 任务（查看/添加/暂停）" },
  { command: "reminders", description: "查看待触发的提醒" },
  { command: "remind", description: "设定定时提醒，如 /remind 30m 喝水" },
  { command: "cancel", description: "取消指定编号的提醒" },
  { command: "queue", description: "查看或清空排队消息" },
  { command: "stop", description: "停止当前任务" },
  { command: "retry", description: "重新发送上一条任务" },
  { command: "usage", description: "查看任务量、成功率与耗时统计" },
  { command: "history", description: "查看最近的任务执行历史" },
  { command: "export", description: "导出任务历史为 Markdown/JSON 文件" },
  { command: "proxy", description: "管理网络代理（添加/测试/启用/删除）" },
  { command: "cc", description: "cc-switch：Provider、MCP、提示词与环境诊断" },
  { command: "ops", description: "运维中心：诊断、日志、更新与服务管理" },
  { command: "logs", description: "查看 Bot 或 OpenCode 日志" },
  { command: "diag", description: "查看系统诊断信息" },
  { command: "update", description: "更新项目代码并构建（需确认）" },
  { command: "restart", description: "重启 Bot（需确认）" },
  { command: "service", description: "管理 OpenCode 服务" },
  { command: "env", description: "查看或修改非密钥配置" },
  { command: "access", description: "管理 Telegram 访问白名单（立即生效）" },
  { command: "api", description: "安卓 App 配对信息（HTTP API 地址与令牌）" },
  { command: "alias", description: "自定义快捷指令（/alias add 名称 指令内容）" },
  { command: "timezone", description: "查看或切换时区（立即生效）" },
  { command: "id", description: "查看会话与配置信息" },
]

/** Text of the one-shot "Bot 已上线" ping sent to the owner chat after polling connects. */
export function startupNoticeText(opts: {
  username?: string
  version: string
  opencodeOk: boolean
  timezone: string
}): string {
  const who = opts.username ? ` @${opts.username}` : ""
  const opencode = opts.opencodeOk
    ? "OpenCode 服务：✅ 可达"
    : "OpenCode 服务：❌ 不可达（运行 npm run serve，或在 Telegram 里发送 /service opencode start）"
  return [
    `✅ Bot 已上线${who} · v${opts.version}`,
    opencode,
    `时区 ${opts.timezone} · 发送 /menu 打开功能菜单`,
  ].join("\n")
}

/** Buttons for /timezone; anything else can still be typed as /timezone <IANA 名称>. */
const TIMEZONE_PRESETS = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
]

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

function formatDateTime(timestamp: number, timeZone: string): string {
  const parts = zonedParts(timestamp, timeZone)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}


function describeRemainingLabel(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} 天`
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时`
  return `${minutes} 分钟`
}

function isMessageNotModified(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const description = (err as { description?: string } | undefined)?.description ?? ""
  return /message is not modified/i.test(`${message} ${description}`)
}



/**
 * `/cc provider add 名称 键=值…` → the same validated draft the HTTP form sends.
 * Returns an error string for the chat instead of throwing, so a typo stays advice.
 */

const AGENT_CONFIRM_TTL_MS = 5 * 60_000

const OPS_CONFIRM_TTL_MS = 5 * 60_000

type OpsConfirmKind = "restart" | "update" | "cc-install" | "cc-update" | "svc-stop" | "svc-restart"

type AgentAction = "install" | "update" | "uninstall"
const AGENT_ACTION_VERB: Record<AgentAction, string> = { install: "安装", update: "更新", uninstall: "卸载" }

function extensionFromMime(mime: string | undefined): string {
  switch (mime) {
    case "application/pdf": return ".pdf"
    case "image/png": return ".png"
    case "image/jpeg": return ".jpg"
    case "image/gif": return ".gif"
    case "image/webp": return ".webp"
    case "audio/mpeg": return ".mp3"
    case "audio/ogg": return ".ogg"
    case "audio/wav": return ".wav"
    case "audio/mp4": return ".m4a"
    case "application/zip": return ".zip"
    default: return ""
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const USER_ID_RE = /^\d{1,20}$/

/** Numeric Telegram IDs only, deduped and ascending, as stored in TELEGRAM_ALLOW_USERS. */
function sortUserIds(ids: Iterable<string>): string[] {
  const unique = new Set<string>()
  for (const raw of ids) {
    const id = raw.trim()
    if (USER_ID_RE.test(id)) unique.add(id)
  }
  return [...unique].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

function parseAllowUsers(value: string): string[] {
  return sortUserIds(value.split(","))
}

export class TelegramBridge {
  readonly #cfg: BotConfig
  readonly #bot: Bot
  readonly #oc: Opencode
  readonly #agents: AgentCliService
  readonly #store: SessionStore
  readonly #log: Logger
  readonly #proxies: ProxyService
  readonly #usage: UsageStore
  readonly #usageReport: DailyReportService
  readonly #history: TaskHistoryStore
  readonly #queues = new Map<string, Promise<void>>()
  readonly #pending = new Map<string, Job[]>()
  readonly #generation = new Map<string, number>()
  readonly #cancels = new Map<string, AbortController>()
  readonly #runningSince = new Map<string, number>()
  readonly #lastPrompts = new Map<string, { text: string; attachments?: AttachmentDescriptor[] }>()
  /** Prompt behind each failure card's 重试 button, keyed by the failed job id. */
  readonly #retryPrompts = new Map<string, { key: string; text: string; attachments?: AttachmentDescriptor[] }>()
  readonly #ccCommands: CcCommands
  readonly #reminders: ReminderService
  readonly #aliases: AliasStore
  readonly #schedules: ScheduleService
  readonly #cc: CcSwitchService
  readonly #models: ModelAdmin
  readonly #agentInstaller: AgentCliInstaller
  readonly #ops: OpsService
  readonly #opsPending = new Map<string, { chatId: number; kind: OpsConfirmKind; createdAt: number }>()
  readonly #snoozePending = new Map<string, { chatId: number; userId: number; text: string; createdAt: number }>()
  readonly #agentPending = new Map<
    string,
    { chatId: number; action: AgentAction; engine: string; createdAt: number }
  >()
  #startedAt = Date.now()
  #running = false
  #opsRunning = ""
  /** Live-overridable via /timezone; the reminder, schedule and usage stores all follow it. */
  #timezone: string

  constructor(
    cfg: BotConfig,
    oc: Opencode,
    agents: AgentCliService,
    store: SessionStore,
    log: Logger,
    proxies: ProxyService,
    bot?: Bot,
    ccswitch?: CcSwitchService,
    models?: ModelAdmin,
    agentInstaller?: AgentCliInstaller,
    ops?: OpsService,
  ) {
    if (!cfg.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN 未配置")
    this.#cfg = cfg
    this.#timezone = cfg.reminderTimezone
    this.#bot = bot ?? new Bot(cfg.telegram.token)
    this.#oc = oc
    this.#agents = agents
    this.#store = store
    this.#log = log
    this.#proxies = proxies
    this.#cc =
      ccswitch ??
      new CcSwitchService({ bin: cfg.ccswitch?.bin, app: cfg.ccswitch?.app ?? "opencode", projectDir: process.cwd() })
    this.#models =
      models ??
      new ModelAdmin(
        resolve(cfg.dataDir, "models.json"),
        process.cwd(),
        cfg.opencode.agent ?? "assistant",
        store,
      )
    this.#agentInstaller =
      agentInstaller ??
      new AgentCliInstaller(resolve(cfg.dataDir, "agent-cli-installs.json"), agents.registry, log, {
        proxyEnv: () => proxies.env(),
      })
    this.#ops =
      ops ??
      new OpsService(
        {
          projectDir: process.cwd(),
          dataDir: cfg.dataDir,
          opencodeUrl: cfg.opencode.url,
          ccSwitchBin: cfg.ccswitch.bin,
          proxyEnv: () => proxies.env(),
          health: () => oc.health(),
        },
        log,
      )
    this.#usage = new UsageStore(resolve(cfg.dataDir, "usage.json"), log, this.#timezone)
    this.#history = new TaskHistoryStore(resolve(cfg.dataDir, "history.json"), log)
    this.#aliases = new AliasStore(resolve(cfg.dataDir, "aliases.json"), log)
    this.#reminders = new ReminderService(
      resolve(cfg.dataDir, "reminders.json"),
      (chatId, text) => this.#deliverReminder(chatId, text),
      log,
      this.#timezone,
      (userId) => this.#isAllowedUser(userId),
    )
    this.#schedules = new ScheduleService(
      resolve(cfg.dataDir, "schedules.json"),
      (task) => this.#executeScheduled(task),
      log,
      this.#timezone,
      this.#agents.registry,
      (userId) => this.#isAllowedUser(userId),
      (chatId, text) => this.#deliverReminder(chatId, text),
    )
    // Always built so /usage can preview the report; the push timer only runs
    // when USAGE_DAILY_REPORT is enabled and there is an owner chat to receive it.
    this.#usageReport = new DailyReportService({
      store: this.#usage,
      path: resolve(cfg.dataDir, "usage-report.json"),
      timeZone: () => this.#timezone,
      time: cfg.usageReport?.time ?? "21:00",
      log,
      send: async (text) => {
        const owner = this.ownerChatId
        if (owner === undefined) throw new Error("白名单为空，没有可推送的聊天")
        await this.#sendTextMessage(owner, text)
      },
    })
    const ccHost: CcHost = {
      sendTextMessage: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      editPanel: (ctx, panel) => this.#editPanel(ctx, panel),
      applyOpenCodeModel: (key, target) => this.#applyOpenCodeModel(key, target as ModelInfo),
      store: this.#store,
      cfg: this.#cfg,
    }
    this.#ccCommands = new CcCommands(ccHost, this.#cc, this.#models, log)
  }

  /** Shared services the HTTP API reuses; both surfaces then see the same reminders and stats. */
  get sharedReminders(): ReminderService {
    return this.#reminders
  }

  get sharedSchedules(): ScheduleService {
    return this.#schedules
  }

  get usageStore(): UsageStore {
    return this.#usage
  }

  get historyStore(): TaskHistoryStore {
    return this.#history
  }

  /** Exposed to the HTTP API so the app can show diagnostics and tail logs. */
  get opsService(): OpsService {
    return this.#ops
  }

  /** Exposed to the HTTP API for /agents install/update/uninstall. */
  get agentInstaller(): AgentCliInstaller {
    return this.#agentInstaller
  }

  /** Exposed to the HTTP API so /alias shortcuts are shared with the app. */
  get aliasStore(): AliasStore {
    return this.#aliases
  }

  /** Exposed to the HTTP API for the app's cc-switch console (/cc parity). */
  get ccSwitch(): CcSwitchService {
    return this.#cc
  }

  /** Lets the HTTP API deliver remote media with the same SSRF/proxy guards as Telegram. */
  fetchRemoteMedia(target: string): Promise<Buffer> {
    return this.#fetchRemoteMedia(target)
  }

  get currentTimezone(): string {
    return this.#timezone
  }

  /** Timezone switch from the HTTP API: persist to .env and update running services. */
  setTimezone(zone: string): { ok: boolean; message: string } {
    const result = this.#ops.envSet("REMINDER_TIMEZONE", zone)
    if (result.ok) this.#applyLiveEnv("REMINDER_TIMEZONE", zone.trim())
    return result
  }

  /** First whitelisted chat: the push target for reminders created outside Telegram. */
  get ownerChatId(): number | undefined {
    const first = [...this.#cfg.telegram.allowUsers][0]
    if (!first) return undefined
    const parsed = Number(first)
    return Number.isInteger(parsed) ? parsed : undefined
  }

  async start(options: { polling?: boolean; onFatal?: (err: Error) => void } = {}): Promise<void> {
    this.#running = true
    this.#startedAt = Date.now()
    this.#setupHandlers()

    this.#bot.catch((err) => {
      this.#log.error("Telegram bot error caught:", err.message)
    })

    if (options.polling === false) {
      this.#log.info("Telegram handlers registered (polling disabled)")
      return
    }

    // bot.start() resolves only when polling ends, so awaiting it would say nothing
    // about a revoked token. init() is the one round trip that proves the credential
    // works; without it a 401 left a live process that held the lock and answered nothing.
    try {
      await this.#bot.init()
    } catch (err) {
      this.#running = false
      throw new Error(`无法连接 Telegram：${(err as Error).message}`)
    }

    this.#log.info("starting Telegram Bot (long polling)...")
    this.#bot
      .start({
        onStart: (botInfo) => {
          this.#log.info(`Telegram Bot connected as @${botInfo.username} (ID: ${botInfo.id})`)
          this.#bot.api
            .setMyCommands(BOT_MENU_COMMANDS)
            .catch((err: unknown) => this.#log.warn("failed to register Telegram command menu:", (err as Error).message))
          this.#reminders.start()
          this.#schedules.start()
          if (this.ownerChatId !== undefined) this.#usageReport.start()
          void this.#sendStartupNotice(botInfo.username)
        },
      })
      .catch((err: Error) => {
        if (!this.#running) return
        this.#log.error("Telegram Bot startup error:", err.message)
        // Polling stopped for good (conflict, revoked token, network gone): staying alive
        // would keep the lock and supervise nothing, so let the caller exit and restart.
        options.onFatal?.(err)
      })
  }

  /**
   * One-line "I'm back" ping after a successful boot, so /restart, /update or a
   * server reboot is visible in chat without tailing logs. Goes to the first
   * whitelisted user (the owner chat); STARTUP_NOTICE=0 turns it off.
   */
  async #sendStartupNotice(username?: string): Promise<void> {
    if (this.#cfg.startupNotice === false) return
    const owner = this.ownerChatId
    if (owner === undefined) return
    const opencodeOk = await this.#oc.health().catch(() => false)
    try {
      await this.#sendTextMessage(owner, startupNoticeText({ username, version: appVersion(), opencodeOk, timezone: this.#timezone }))
    } catch (err) {
      this.#log.warn("failed to send the startup notice:", (err as Error).message)
    }
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#reminders.dispose()
    this.#schedules.dispose()
    this.#usageReport.dispose()

    const aborts: Promise<void>[] = []
    for (const [key, controller] of this.#cancels) {
      controller.abort()
      if (this.#store.getEngine(key) === "opencode") {
        const sessionID = this.#store.get(key)
        if (sessionID) aborts.push(this.#oc.abortSession(sessionID).catch(() => {}))
      }
    }
    for (const key of new Set([...this.#queues.keys(), ...this.#pending.keys()])) {
      this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1)
    }
    this.#pending.clear()
    // A restart must not leave live one-shot confirm tokens or cached prompts behind
    this.#ccCommands.clearPending()
    this.#opsPending.clear()
    this.#agentPending.clear()
    this.#lastPrompts.clear()
    this.#retryPrompts.clear()
    this.#ccCommands.clearProviders()

    const running = [...this.#queues.values(), ...aborts]
    if (running.length > 0) {
      await Promise.race([Promise.allSettled(running), sleep(SHUTDOWN_DRAIN_MS)])
    }

    await this.#bot.stop()
    this.#log.info("Telegram Bot stopped")
  }

  #setupHandlers(): void {
    // Whitelist check
    this.#bot.use(async (ctx, next) => {
      const from = ctx.from
      if (!from) return

      if (ctx.chat?.type !== "private") {
        this.#log.debug(`ignored ${ctx.chat?.type ?? "unknown"} chat ${ctx.chat?.id ?? "?"} (private chats only)`)
        // Otherwise a button press in a group shows an endless loading spinner
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "仅支持私聊使用", show_alert: true }).catch(() => {})
        return
      }

      const userId = String(from.id)
      if (!this.#isAllowedUser(from.id)) {
        this.#log.debug(`ignored Telegram message from unauthorized user ${userId} (@${from.username ?? "none"})`)
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: "你未在白名单中", show_alert: true }).catch(() => {})
        } else {
          await ctx
            .reply(
              `⚠️ 你未在白名单中。\n你的 Telegram ID 是：\`${userId}\`\n请把这个 ID 发给 Bot 管理员，让他发送 \`/access add ${userId}\` 即可立即放行。`,
              {
                parse_mode: "Markdown",
              },
            )
            .catch(() => {})
        }
        return
      }

      await next()
    })

    // Text messages
    this.#bot.on("message:text", async (ctx) => {
      const text = ctx.message.text.trim()
      if (!text) return
      const chatId = ctx.chat.id
      const userId = ctx.from.id
      const key = `tg:${chatId}`

      // Control commands bypass the per-chat queue, otherwise they wait for the running task
      const rawCommand = text.split(/\s+/, 1)[0] ?? ""
      const command = rawCommand.toLowerCase().split("@")[0] ?? ""
      const arg = text.slice(rawCommand.length).trim()

      if (command === "/stop") {
        await this.#handleStop(chatId, key)
        return
      }
      if (command === "/start") {
        await this.#sendTextMessage(chatId, this.#welcomeText(key, userId), this.#menuKeyboard())
        return
      }
      if (command === "/menu") {
        await this.#sendPanel(chatId, this.#menuPanel(chatId, key))
        return
      }
      if (command === "/help") {
        if (arg.toLowerCase() === "full" || arg.toLowerCase() === "all") {
          await this.#sendTextMessage(chatId, HELP_FULL, this.#menuKeyboard())
        } else if (arg.toLowerCase() === "cc") {
          await this.#sendTextMessage(chatId, CC_HELP, this.#menuKeyboard())
        } else {
          await this.#sendTextMessage(chatId, HELP, this.#menuKeyboard())
        }
        return
      }
      if (command === "/status") {
        await this.#handleStatus(chatId, key)
        return
      }
      if (command === "/usage") {
        await this.#handleUsage(chatId, key)
        return
      }
      if (command === "/export") {
        this.#offLoop(chatId, "导出", () => this.#handleExport(chatId, key, arg))
        return
      }
      if (command === "/history") {
        const requested = Number(arg)
        const limit = Number.isInteger(requested) && requested > 0 ? Math.min(20, requested) : 10
        await this.#sendPanel(chatId, this.#historyPanel(key, limit))
        return
      }
      if (command === "/queue") {
        await this.#handleQueue(chatId, key)
        return
      }
      if (command === "/proxy") {
        // `add` runs a connectivity test that can take seconds: keep it off the
        // update loop so /stop stays responsive in every chat
        this.#offLoop(chatId, "代理命令", () => this.#handleProxyCommand(chatId, arg))
        return
      }
      if (command === "/remind") {
        await this.#handleRemind(chatId, userId, arg)
        return
      }
      if (command === "/schedule") {
        await this.#handleScheduleCommand(chatId, userId, key, arg)
        return
      }
      if (command === "/reminders") {
        await this.#handleReminders(chatId)
        return
      }
      if (command === "/agents") {
        await this.#handleAgentsCommand(
          { key, text, chatId, userId, generation: this.#generation.get(key) ?? 0 },
          arg,
        )
        return
      }
      if (command === "/ops" || command === "/maintenance") {
        this.#offLoop(chatId, "运维面板", async () => this.#sendPanel(chatId, await this.#opsPanel()))
        return
      }
      if (command === "/diag") {
        this.#offLoop(chatId, "诊断", () => this.#handleDiagnostics(chatId))
        return
      }
      if (command === "/logs") {
        this.#offLoop(chatId, "日志", () => this.#handleLogs(chatId, arg))
        return
      }
      if (command === "/restart") {
        await this.#confirmRestart(chatId)
        return
      }
      if (command === "/update") {
        await this.#confirmUpdate(chatId)
        return
      }
      if (command === "/service" || command === "/svc") {
        await this.#handleServiceCommand(chatId, arg)
        return
      }
      if (command === "/env") {
        await this.#handleEnvCommand(chatId, arg)
        return
      }
      if (command === "/access") {
        await this.#handleAccessCommand(chatId, userId, arg)
        return
      }
      if (command === "/timezone" || command === "/tz") {
        await this.#handleTimeZone(chatId, arg)
        return
      }
      if (command === "/cancel") {
        await this.#handleCancelReminder(chatId, arg)
        return
      }
      if (command === "/alias") {
        await this.#handleAliasCommand(chatId, arg)
        return
      }
      if (!QUEUED_COMMANDS.has(command) && !(await this.#ensureCapacity(chatId, key))) return

      this.#enqueue({
        key,
        text,
        chatId,
        userId,
        generation: this.#generation.get(key) ?? 0,
        // /retry queues behind a running task: capture the retry target now, or the
        // task finishing in between would be replayed instead of the one the user meant
        retryOf: command === "/retry" ? this.#lastPrompts.get(key) : undefined,
      })
    })

    // Photos, documents, voice notes and audio files
    this.#bot.on(["message:photo", "message:document", "message:voice", "message:audio"], async (ctx) => {
      const chatId = ctx.chat.id
      const key = `tg:${chatId}`
      const attachments = this.#collectAttachments(ctx.message)
      if (attachments.length === 0) return

      const limitMb = Math.round(this.#cfg.maxInputBytes / 1024 / 1024)
      const tooBig = attachments.find((att) => (att.size ?? 0) > this.#cfg.maxInputBytes)
      if (tooBig) {
        await this.#sendTextMessage(chatId, `⚠️ ${tooBig.name} 超过 ${limitMb}MB 上限，无法接收。`)
        return
      }
      if (!(await this.#ensureCapacity(chatId, key))) return

      this.#enqueue({
        key,
        text: (ctx.message.caption ?? "").trim(),
        chatId,
        userId: ctx.from.id,
        generation: this.#generation.get(key) ?? 0,
        attachments,
      })
    })

    // Inline panel buttons
    this.#bot.on("callback_query:data", async (ctx) => {
      const chatId = ctx.chat?.id
      const data = ctx.callbackQuery.data
      if (!chatId) {
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      const key = `tg:${chatId}`
      const answer = async (text?: string): Promise<void> => {
        await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
      }

      if (data.startsWith("show:")) {
        const which = data.slice("show:".length)
        await answer()
        // cc/ops/service panels spawn subprocesses: build them off the update loop
        if (which === "cc" || which === "ops" || which === "service") {
          const message = ctx.callbackQuery?.message
          const messageId = message && "message_id" in message ? message.message_id : undefined
          this.#offLoop(chatId, "面板刷新", async () => {
            const panel = await this.#panelFor(which, chatId, key)
            if (!panel) return
            if (messageId !== undefined) await this.#editPanelRef(chatId, messageId, panel)
            else await this.#sendPanel(chatId, panel)
          })
          return
        }
        const panel = await this.#panelFor(which, chatId, key)
        if (panel) await this.#editPanel(ctx, panel)
        return
      }

      if (data.startsWith("aliasdel:")) {
        const name = data.slice("aliasdel:".length)
        const removed = this.#aliases.remove(chatId, name)
        if (!removed) {
          await answer("该快捷指令已不存在")
        } else {
          await answer(`已删除 /${removed.name}`)
        }
        const message = ctx.callbackQuery?.message
        const messageId = message && "message_id" in message ? message.message_id : undefined
        if (messageId !== undefined) await this.#editPanelRef(chatId, messageId, this.#aliasPanel(chatId))
        else await this.#sendPanel(chatId, this.#aliasPanel(chatId))
        return
      }

      const snoozeMatch = /^snooze:([0-9a-f]+):(\d+)$/.exec(data)
      if (snoozeMatch) {
        await this.#handleSnooze(chatId, snoozeMatch[1]!, Number(snoozeMatch[2]), answer)
        return
      }

      if (data.startsWith("tz:")) {
        await answer()
        await this.#handleTimeZone(chatId, data.slice("tz:".length))
        return
      }

      if (data.startsWith("cc:")) {
        const rest = data.slice("cc:".length)
        // Every cc action shells out to cc-switch (up to 20s per call): keep the
        // update loop free so other chats' /stop and buttons stay responsive
        this.#offLoop(chatId, "cc 操作", () => this.#ccCommands.handleCallback(ctx, chatId, rest, answer))
        return
      }

      if (data.startsWith("ops:")) {
        await this.#handleOpsCallback(chatId, data.slice("ops:".length), answer)
        return
      }

      if (data.startsWith("proxy:")) {
        const rest = data.slice("proxy:".length)
        const [action, rawId] = rest.split(":", 2)
        const id = Number(rawId)

        if (action === "off") {
          this.#proxies.disable()
          await answer("已停用代理")
          await this.#editPanel(ctx, this.#proxyPanel())
          return
        }

        if (!Number.isInteger(id)) {
          await answer("代理编号无效")
          return
        }

        if (action === "use") {
          try {
            const proxy = this.#proxies.use(id)
            await answer(`已启用代理 #${proxy.id}`)
          } catch (err) {
            await answer(err instanceof Error ? err.message : "启用失败")
            return
          }
          await this.#editPanel(ctx, this.#proxyPanel())
          return
        }

        if (action === "del") {
          const removed = this.#proxies.remove(id)
          await answer(removed ? `已删除代理 #${id}` : `代理 #${id} 不存在`)
          await this.#editPanel(ctx, this.#proxyPanel())
          return
        }

        if (action === "test") {
          await answer("正在测试代理…")
          // A test can take up to 10s: it must not hold the update loop
          this.#offLoop(chatId, "代理测试", async () => {
            const result = await this.#proxies.test(id)
            const text = result.ok
              ? `✅ 代理 #${id} 连接正常（${result.latencyMs ?? 0}ms）`
              : `❌ 代理 #${id} 测试失败：${result.message}`
            await this.#sendTextMessage(chatId, escapeMarkdown(text))
          })
          return
        }
      }

      if (data === "task:stop") {
        await answer("正在停止…")
        await this.#handleStop(chatId, key)
        return
      }

      const retryCard = /^retry:(q\d+)$/.exec(data)
      if (retryCard) {
        const snapshot = this.#retryPrompts.get(retryCard[1]!)
        if (!snapshot || snapshot.key !== key) {
          await answer("这条重试已过期")
          return
        }
        if (!(await this.#ensureCapacity(chatId, key))) {
          await answer("排队已满")
          return
        }
        await answer("正在重试…")
        this.#enqueue({
          key,
          text: snapshot.text,
          chatId,
          userId: ctx.from?.id ?? 0,
          generation: this.#generation.get(key) ?? 0,
          attachments: snapshot.attachments,
        })
        return
      }

      const queueDrop = /^qdrop:(q\d+)$/.exec(data)
      if (queueDrop) {
        const items = this.#pending.get(key) ?? []
        const index = items.findIndex((job) => job.id === queueDrop[1])
        if (index < 0) {
          await answer("这条消息已开始执行，或已被取消")
          await this.#editPanel(ctx, this.#queuePanel(key))
          return
        }
        const [job] = items.splice(index, 1)
        if (job) job.dropped = true
        if (items.length === 0) this.#pending.delete(key)
        await answer(`已取消第 ${index + 1} 条`)
        await this.#editPanel(ctx, this.#queuePanel(key))
        return
      }

      if (data === "qclear") {
        const count = this.#pending.get(key)?.length ?? 0
        if (count === 0) {
          await answer("队列已经是空的")
          return
        }
        this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1)
        this.#pending.delete(key)
        await answer(`已清空 ${count} 条排队消息`)
        await this.#editPanel(ctx, this.#queuePanel(key))
        return
      }

      const agentRequest = /^areq:(install|update|uninstall):(.+)$/.exec(data)
      if (agentRequest) {
        const action = agentRequest[1] as AgentAction
        const engine = agentRequest[2]!
        const blocked = this.#agentActionBlocked(key, action, engine)
        if (blocked) {
          await answer(blocked)
          return
        }
        await answer()
        await this.#requestAgentAction(chatId, key, action, engine)
        return
      }
      if (data.startsWith("a:cnl:")) {
        const token = data.slice("a:cnl:".length)
        const pending = this.#agentPending.get(token)
        if (pending && pending.chatId !== chatId) {
          await answer("该按钮不属于当前会话")
          return
        }
        // A declined request must not stay executable until its TTL expires
        this.#agentPending.delete(token)
        await answer("已取消")
        const panel = await this.#panelFor("agents", chatId, key)
        if (panel) await this.#editPanel(ctx, panel)
        return
      }
      if (data.startsWith("a:cfm:")) {
        const token = data.slice("a:cfm:".length)
        const pending = this.#agentPending.get(token)
        if (!pending || Date.now() - pending.createdAt > AGENT_CONFIRM_TTL_MS) {
          this.#agentPending.delete(token)
          await answer("操作已过期，请重新发起")
          await this.#sendTextMessage(chatId, "⌛ 该确认按钮已过期或已被使用，请重新发起操作。")
          return
        }
        if (pending.chatId !== chatId) {
          await answer("该按钮不属于当前会话")
          return
        }
        this.#agentPending.delete(token)
        // Preconditions are re-checked here because the state may have changed
        // between showing the prompt and pressing the button
        const blocked = this.#agentActionBlocked(key, pending.action, pending.engine)
        if (blocked) {
          await answer(blocked)
          await this.#sendTextMessage(chatId, `⚠️ ${escapeMarkdown(blocked)}，操作已取消。`)
          return
        }
        const verb = AGENT_ACTION_VERB[pending.action]
        await answer(`开始${verb}…`)
        void this.#runAgentAction(chatId, key, pending.action, pending.engine).catch((err: unknown) => {
          this.#log.error(`agent ${pending.action} failed:`, (err as Error).message)
        })
        return
      }

      if (data.startsWith("agent:")) {
        const engine = data.slice("agent:".length)
        if (engine !== "opencode" && !this.#agents.registry.get(engine)) {
          await answer("未知引擎")
          return
        }
        if (this.#store.getEngine(key) === engine) {
          await answer("已经是当前引擎")
          return
        }
        this.#store.setEngine(key, engine)
        this.#log.info(`agent switched [${key}] -> ${engine}`)
        const label = this.#agents.registry.label(engine)
        const profile = engine === "opencode" ? undefined : this.#agents.registry.get(engine)
        const missing = profile && !this.#agents.registry.binPath(profile)
        await answer(missing ? `已切换，但未检测到 ${profile.bin}` : `已切换至 ${label}`)
        await this.#editPanel(ctx, this.#agentPanel(key))
        return
      }

      if (data.startsWith("dir:")) {
        if (data !== "dir:reset") {
          await answer("未知的目录操作")
          return
        }
        if (this.#runningSince.has(key)) {
          await answer("任务执行中，请先停止")
          return
        }
        if (!this.#store.clearDir(key)) {
          await answer("已经是默认工作目录")
          await this.#editPanel(ctx, this.#dirPanel(key))
          return
        }
        this.#resetCliSessions(key)
        this.#log.info(`work dir reset [${key}] -> ${this.#agents.defaultWorkDir}`)
        await answer("已恢复默认工作目录")
        await this.#editPanel(ctx, this.#dirPanel(key))
        return
      }

      if (data.startsWith("access:")) {
        const id = data.slice("access:del:".length)
        if (!data.startsWith("access:del:") || !USER_ID_RE.test(id)) {
          await answer("未知的白名单操作")
          return
        }
        const result = this.#mutateAccess(false, [id], ctx.from?.id)
        if (!result.ok) {
          await answer(result.message)
          await this.#editPanel(ctx, this.#accessPanel())
          return
        }
        this.#log.info(`access removed ${id} by ${ctx.from?.id ?? "?"}`)
        await answer(`已移除 ${id}`)
        await this.#editPanel(ctx, this.#accessPanel(`🗑 已从白名单移除 ${id}，立即生效。`))
        return
      }

      if (data.startsWith("model:")) {
        if (this.#store.getEngine(key) !== "opencode") {
          await answer("当前不是 OpenCode 引擎")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        // Deleting the session while it is generating would fail the running task
        if (this.#runningSince.has(key)) {
          await answer("任务执行中，请先发送 /stop")
          return
        }
        if (data === "model:reset") {
          if (!(await this.#clearOpenCodeModelSelection(key))) {
            await answer("本会话已经是默认模型")
            return
          }
          await answer("已恢复默认模型")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        const targetKey = resolveModelKey(data.slice("model:".length))
        const target = targetKey ? AVAILABLE_MODELS[targetKey] : undefined
        if (!target) {
          await answer("模型不存在")
          return
        }
        const current = this.#getCurrentModel(key)
        if (current.providerID === target.providerID && current.modelID === target.modelID) {
          await answer("已经是当前模型")
          return
        }
        await answer(`已切换至 ${target.label}`)
        await this.#applyOpenCodeModel(key, target)
        await this.#editPanel(ctx, this.#modelPanel(key))
        return
      }

      if (data.startsWith("cmodelreset:")) {
        const engine = data.slice("cmodelreset:".length)
        const profile = this.#agents.registry.get(engine)
        if (!profile || this.#store.getEngine(key) !== engine) {
          await answer("引擎已切换，请重新打开模型面板")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        if (this.#runningSince.has(key)) {
          await answer("任务执行中，请先发送 /stop")
          return
        }
        if (!this.#clearCliModelSelection(key, engine)) {
          await answer("本会话已经是默认模型")
          return
        }
        await answer("已恢复默认模型")
        await this.#editPanel(ctx, this.#modelPanel(key))
        return
      }

      if (data.startsWith("cmodel:") || data.startsWith("qmodel:")) {
        const legacy = data.startsWith("qmodel:")
        const payload = data.slice(legacy ? "qmodel:".length : "cmodel:".length)
        let engine: string
        let model: string | undefined
        if (legacy) {
          engine = "qoder"
          model = this.#agents.registry.resolveModel(engine, payload)
        } else {
          const [rawEngine = "", rawIndex = ""] = payload.split(":", 2)
          engine = rawEngine
          const profile = this.#agents.registry.get(engine)
          const index = Number(rawIndex)
          model = Number.isInteger(index) ? profile?.models?.[index]?.id : undefined
        }

        if (this.#store.getEngine(key) !== engine) {
          await answer("引擎已切换，请重新打开模型面板")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        if (!model) {
          await answer("模型不存在")
          return
        }
        if (this.#runningSince.has(key)) {
          await answer("任务执行中，请先发送 /stop")
          return
        }
        const current = this.#store.getCliModel(key, engine) ?? this.#agents.registry.defaultModel(engine)
        if (current === model) {
          await answer("已经是当前模型")
          return
        }
        this.#applyCliModel(key, engine, model)
        await answer(`已切换至 ${this.#agents.registry.modelLabel(engine, model)}`)
        await this.#editPanel(ctx, this.#modelPanel(key))
        return
      }

      if (data.startsWith("rcancel:")) {
        const id = Number(data.slice("rcancel:".length))
        const removed = Number.isInteger(id) ? this.#reminders.cancel(chatId, id) : undefined
        await answer(removed ? `已取消提醒 #${removed.id}` : "提醒不存在或已触发")
        await this.#editPanel(ctx, this.#remindersPanel(chatId))
        return
      }

      if (data.startsWith("sched:")) {
        const [action, rawId] = data.slice("sched:".length).split(":", 2)
        const id = Number(rawId)
        if (!Number.isInteger(id)) {
          await answer("任务编号无效")
          return
        }
        if (action === "pause") {
          const task = this.#schedules.pause(chatId, id)
          await answer(task ? `已暂停定时任务 #${id}` : "任务不存在")
        } else if (action === "resume") {
          const task = this.#schedules.resume(chatId, id)
          await answer(task ? `已恢复定时任务 #${id}` : "任务不存在")
        } else if (action === "run") {
          try {
            const task = this.#schedules.runNow(chatId, id)
            await answer(task ? `已开始执行 #${id}` : "任务不存在")
          } catch (err) {
            await answer(err instanceof Error ? err.message : "启动失败")
            return
          }
        } else if (action === "del") {
          const removed = this.#schedules.remove(chatId, id)
          await answer(removed ? `已删除定时任务 #${id}` : "任务不存在")
        } else {
          await answer("未知操作")
          return
        }
        await this.#editPanel(ctx, this.#schedulePanel(chatId))
        return
      }

      if (data === "usage:report") {
        await answer()
        this.#offLoop(chatId, "每日报告", async () => {
          await this.#sendTextMessage(chatId, escapeMarkdown(this.#usageReport.preview()), this.#reportKeyboard())
        })
        return
      }

      if (data === "history:clear") {
        const cleared = this.#history.clear(key)
        await answer(cleared > 0 ? `已清空 ${cleared} 条任务历史` : "历史已经是空的")
        await this.#editPanel(ctx, this.#historyPanel(key))
        return
      }

      await answer()
    })
  }

  async #handleStop(chatId: number, key: string): Promise<void> {
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1)
    const queued = this.#pending.get(key)?.length ?? 0
    if (queued > 0) this.#pending.delete(key)
    const controller = this.#cancels.get(key)
    if (controller) {
      this.#log.info(`cancel requested [${key}]`)
      controller.abort()
      const suffix = queued > 0 ? `，排队中的 ${queued} 条消息也已丢弃` : ""
      await this.#sendTextMessage(chatId, `🛑 已请求停止当前任务${suffix}。`)
    } else if (queued > 0) {
      await this.#sendTextMessage(chatId, `🛑 已丢弃排队中的 ${queued} 条消息。`)
    } else if (this.#queues.has(key)) {
      // A command job (/cc, /agents install, …) occupies the queue without an
      // abort controller: be honest instead of claiming nothing is running
      await this.#sendTextMessage(
        chatId,
        "⏳ 当前正在执行命令类操作（如 /cc、安装任务），它无法被 /stop 中断；执行结束后队列即恢复。",
      )
    } else {
      await this.#sendTextMessage(chatId, "🛑 当前没有正在执行的任务。")
    }
  }

  async #handleQueue(chatId: number, key: string): Promise<void> {
    await this.#sendPanel(chatId, this.#queuePanel(key))
  }

  /** Pairing info for the companion Android app: endpoint, token and exposure hints. */
  async #handleApiInfo(chatId: number): Promise<void> {
    if (!this.#cfg.api.enabled) {
      await this.#sendTextMessage(
        chatId,
        "⚠️ HTTP API 当前未启用。在 .env 中设置 `API_ENABLED=1` 并重启 Bot 后可用。",
      )
      return
    }
    let token: string
    try {
      token = resolveApiToken(this.#cfg)
    } catch (err) {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err))
      await this.#sendTextMessage(
        chatId,
        `⚠️ 无法生成或读取 API 令牌（${escapeMarkdown(detail)}）。请检查 data 目录权限，或在 .env 中直接设置 API_TOKEN。`,
      )
      return
    }
    const { port, bind } = this.#cfg.api
    const wildcard = bind === "0.0.0.0" || bind === "::"
    const host = wildcard || bind === "127.0.0.1" || bind === "localhost" || bind === "::1"
      ? "<你的服务器地址>"
      : bind
    let qrBuffer: Buffer | undefined
    try {
      qrBuffer = await QRCode.toBuffer(JSON.stringify({ url: `http://${host === "<你的服务器地址>" ? "" : host}:${port}`, token }), {
        margin: 2,
        width: 640,
        color: { dark: "#0b0c0e", light: "#ffffff" },
      })
    } catch (err) {
      this.#log.warn(`pairing QR generation failed: ${(err as Error).message}`)
    }

    const text =
      `📱 *安卓 App 配对信息*\n` +
      `• API 地址: \`http://${host}:${port}/api/v1\`\n` +
      `• 访问令牌: \`${token}\`\n\n` +
      (wildcard
        ? "⚠️ 当前监听所有网卡。请配合反向代理 / SSH 隧道 / VPN 暴露给手机，并保持令牌鉴权。\n\n"
        : "") +
      (!wildcard
        ? "⚠️ 当前仅监听本机回环地址，手机无法直连。可在 .env 设置 `API_BIND=0.0.0.0` 后配合反向代理 / SSH 隧道 / VPN 暴露给手机；令牌鉴权会一直保留。\n\n"
        : "") +
      "在 App 的「设置」页也可直接「扫码配对」;令牌持久化在 `data/api-token.json`，设置 `API_TOKEN` 可固定。"
    if (qrBuffer) {
      try {
        await this.#bot.api.sendPhoto(chatId, new InputFile(qrBuffer, "agentbot-pairing.png"), {
          caption: clip(text, 1000),
          parse_mode: "Markdown",
        })
        return
      } catch (err) {
        this.#log.warn(`pairing QR send failed: ${(err as Error).message}`)
      }
    }
    await this.#sendTextMessage(chatId, text)
  }

  async #handleProxyCommand(chatId: number, arg: string): Promise<void> {
    const [action = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    if (!action) {
      await this.#sendPanel(chatId, this.#proxyPanel())
      return
    }

    if (action === "add") {
      const url = rest[0]
      if (!url) {
        await this.#sendTextMessage(
          chatId,
          "用法：`/proxy add http://127.0.0.1:7890 本地代理`\n支持 `http://`、`https://`、`socks4://`、`socks5://`，可带用户名密码。",
        )
        return
      }
      await this.#sendTextMessage(chatId, "🧪 正在测试代理，请稍候…")
      try {
        const proxy = await this.#proxies.add(url, rest.slice(1).join(" "))
        await this.#sendTextMessage(
          chatId,
          `✅ 代理 #${proxy.id} 测试通过并已添加：${escapeMarkdown(proxy.name)}`,
        )
        await this.#sendPanel(chatId, this.#proxyPanel())
      } catch (err) {
        await this.#sendTextMessage(chatId, `❌ 添加失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (action === "use" || action === "del" || action === "test") {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        await this.#sendTextMessage(chatId, `用法：\`/proxy ${action} 编号\`（编号见 \`/proxy\` 列表）。`)
        return
      }
      if (action === "use") {
        try {
          const proxy = this.#proxies.use(id)
          await this.#sendTextMessage(chatId, `✅ 已启用代理 #${proxy.id}：${escapeMarkdown(maskProxyUrl(proxy.url))}`)
        } catch (err) {
          await this.#sendTextMessage(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      if (action === "del") {
        const removed = this.#proxies.remove(id)
        await this.#sendTextMessage(chatId, removed ? `🗑 已删除代理 #${id}。` : `⚠️ 代理 #${id} 不存在。`)
        return
      }
      const result = await this.#proxies.test(id)
      await this.#sendTextMessage(
        chatId,
        result.ok
          ? `✅ 代理 #${id} 连接正常（${result.latencyMs ?? 0}ms）。`
          : `❌ 代理 #${id} 测试失败：${result.message}`,
      )
      return
    }

    if (action === "off") {
      this.#proxies.disable()
      await this.#sendTextMessage(chatId, "⏹ 已停用网络代理。")
      return
    }

    await this.#sendTextMessage(
      chatId,
      "用法：\n• `/proxy` 打开管理面板\n• `/proxy add <地址> [名称]`\n• `/proxy use <编号>`\n• `/proxy test <编号>`\n• `/proxy del <编号>`\n• `/proxy off`",
    )
  }

  #proxyPanel(note?: string): Panel {
    const active = this.#proxies.active()
    const items = this.#proxies.list()
    const keyboard = new InlineKeyboard()

    if (items.length === 0) {
      const text =
        (note ? `${note}\n\n` : "") +
        "🌐 *网络代理*\n\n当前：未启用\n\n尚未添加代理。\n" +
        "发送 `/proxy add http://127.0.0.1:7890 本地代理` 添加，添加时会自动测试连通性。\n\n" +
        "支持 `http://`、`https://`、`socks4://`、`socks5://`。"
      return {
        text,
        keyboard: new InlineKeyboard().text("🔄 刷新", "show:proxy").text("⬅️ 主菜单", "show:menu"),
      }
    }

    // Telegram caps inline keyboards at 100 buttons; three rows per proxy would break
    // the whole panel once enough proxies pile up, so only the first few get buttons
    const panelProxies = items.slice(0, 12)
    const lines = panelProxies.map((proxy) => {
      const current = active?.id === proxy.id ? " ✅" : ""
      return `• #${proxy.id} *${escapeMarkdown(proxy.name)}*${current}\n  ${escapeMarkdown(maskProxyUrl(proxy.url))}`
    })
    const more =
      items.length > panelProxies.length
        ? `\n\n_…另有 ${items.length - panelProxies.length} 个未显示。可用 \`/proxy use <编号>\`、\`/proxy test <编号>\` 或 \`/proxy del <编号>\` 直接操作。_`
        : ""
    const status = active
      ? `#${active.id} ${escapeMarkdown(active.name)}`
      : "未启用"
    const text =
      (note ? `${note}\n\n` : "") +
      `🌐 *网络代理*\n\n当前：${status}\n\n${lines.join("\n")}${more}\n\n` +
      "启用后，远程媒体下载、Agent CLI 子进程以及 Agent 的网络命令会走该代理；Telegram 与本地 opencode 连接保持直连。"

    panelProxies.forEach((proxy, index) => {
      keyboard
        .text(`${active?.id === proxy.id ? "✅" : "▶️"} 使用 #${proxy.id}`, `proxy:use:${proxy.id}`)
        .text(`🧪 测试 #${proxy.id}`, `proxy:test:${proxy.id}`)
        .row()
        .text(`🗑 删除 #${proxy.id}`, `proxy:del:${proxy.id}`)
      if (index < panelProxies.length - 1) keyboard.row()
    })
    if (active) keyboard.row().text("⏹ 停用代理", "proxy:off")
    keyboard.row().text("🔄 刷新", "show:proxy").text("⬅️ 主菜单", "show:menu")
    return { text, keyboard }
  }

  #queuePanel(key: string): Panel {
    const items = this.#pending.get(key) ?? []
    const running = this.#runningSince.has(key)
    if (items.length === 0 && !running) {
      return {
        text: "📭 *队列为空*\n\n直接发送消息即可开始新的任务。",
        keyboard: new InlineKeyboard().text("🔄 刷新", "show:queue").text("⬅️ 主菜单", "show:menu"),
      }
    }

    const lines = items.map((job, index) => {
      const preview = escapeMarkdown(clip(job.text.replace(/\s+/g, " ").trim(), 60) || "（无文字，仅附件）")
      return `${index + 1}. ${preview}`
    })
    const head = running ? "⏳ 当前任务执行中。" : "✅ 当前没有运行中的任务。"
    const body = lines.length > 0 ? `\n\n*排队中（${items.length}）*\n${lines.join("\n")}` : ""
    const keyboard = new InlineKeyboard()
    items.forEach((job, index) => {
      if (!job.id) return
      keyboard.text(`❌ 取消第 ${index + 1} 条`, `qdrop:${job.id}`).row()
    })
    if (items.length > 0) {
      keyboard.text(`🧹 清空排队（${items.length}）`, "qclear")
      keyboard.row()
    }
    keyboard.text("🔄 刷新队列", "show:queue").text("⬅️ 主菜单", "show:menu")
    return { text: `📋 *任务队列*\n${head}${body}`, keyboard }
  }

  /** Sends the chat's task history as a downloadable Markdown or JSON document. */
  async #handleExport(chatId: number, key: string, arg: string): Promise<void> {
    const format = (arg.trim().toLowerCase() || "md").replace(/^\./, "")
    if (!["md", "markdown", "json"].includes(format)) {
      await this.#sendTextMessage(chatId, "用法：`/export`（Markdown，默认）或 `/export json`")
      return
    }
    const entries = this.#history.list(key, 50)
    const stamp = new Date()
    const pad = (value: number): string => String(value).padStart(2, "0")
    const name = `agentbot-history-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
    if (format === "json") {
      const payload = JSON.stringify({ exportedAt: stamp.toISOString(), key, entries }, null, 2)
      await this.#bot.api.sendDocument(chatId, new InputFile(Buffer.from(payload, "utf8"), `${name}.json`), {
        caption: `🗂 任务历史（JSON，${entries.length} 条）`,
      })
      return
    }
    if (entries.length === 0) {
      await this.#sendTextMessage(chatId, "📭 还没有任务记录，先聊点别的吧。")
      return
    }
    const markdown = formatHistoryMarkdown(entries, { source: `Telegram ${chatId}`, timeZone: this.#timezone })
    await this.#bot.api.sendDocument(chatId, new InputFile(Buffer.from(markdown, "utf8"), `${name}.md`), {
      caption: `🗂 任务历史（Markdown，${entries.length} 条）`,
    })
  }

  async #handleStatus(chatId: number, key: string): Promise<void> {
    await this.#sendTextMessage(chatId, this.#statusText(chatId, key), this.#statusKeyboard())
  }

  async #handleUsage(chatId: number, key: string): Promise<void> {
    await this.#sendPanel(chatId, this.#usagePanel(key))
  }

  #reportKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("📈 使用统计", "show:usage").row().text("⬅️ 主菜单", "show:menu")
  }

  #usagePanel(key: string): Panel {
    const usage = this.#usage.summary(key)
    const keyboard = new InlineKeyboard().text("🔄 刷新统计", "show:usage").text("📊 运行状态", "show:status")
    keyboard.row().text("📩 每日报告", "usage:report")
    keyboard.row().text("⬅️ 主菜单", "show:menu")

    if (usage.tasks === 0) {
      return {
        text: "📈 *使用统计*\n\n暂无任务记录。直接发送消息即可开始对话。",
        keyboard,
      }
    }

    const rate = Math.round((usage.ok / usage.tasks) * 100)
    const avg = Math.round(usage.totalMs / usage.tasks)
    const engine = usage.lastEngine ? this.#agents.registry.label(usage.lastEngine) : undefined
    const last = usage.lastAt
      ? `\n• 最近任务：${formatDateTime(usage.lastAt, this.#timezone)}` +
        `（${engine ?? "未知"}${usage.lastModel ? ` / ${escapeMarkdown(usage.lastModel)}` : ""}）`
      : ""
    const engineUsage =
      Object.entries(usage.engines)
        .filter(([, count]) => count > 0)
        .map(([id, count]) => `${this.#agents.registry.label(id)} ${count}`)
        .join(" / ") || "无"
    const trend = this.#usage.recentDays(key, 7)
    const week = trend.reduce(
      (acc, day) => ({
        tasks: acc.tasks + day.tasks,
        ok: acc.ok + day.ok,
        failed: acc.failed + day.failed,
        cancelled: acc.cancelled + day.cancelled,
      }),
      { tasks: 0, ok: 0, failed: 0, cancelled: 0 },
    )
    const blocks = "▁▂▃▄▅▆▇█"
    const peak = Math.max(1, ...trend.map((day) => day.tasks))
    const spark = trend
      .map((day) =>
        day.tasks === 0
          ? "·"
          : blocks[Math.min(blocks.length - 1, Math.max(0, Math.ceil((day.tasks / peak) * blocks.length) - 1))]!,
      )
      .join("")
    const range =
      trend.length > 1
        ? `${trend[0]!.day.slice(5)} → ${trend[trend.length - 1]!.day.slice(5)}`
        : trend[0]!.day.slice(5)
    return {
      text:
        `📈 *使用统计*\n\n` +
        `• 总任务：${usage.tasks}（成功 ${usage.ok} / 失败 ${usage.failed} / 取消 ${usage.cancelled}）\n` +
        `• 成功率：${rate}%\n` +
        `• 平均耗时：${formatDuration(avg)}\n` +
        `• 今日任务：${usage.today.tasks}（成功 ${usage.today.ok} / 失败 ${usage.today.failed} / 取消 ${usage.today.cancelled}）\n` +
        `• 近 7 天：${week.tasks} 任务（成功 ${week.ok} / 失败 ${week.failed} / 取消 ${week.cancelled}）\n` +
        `  \`${spark}\` ${range}\n` +
        `• 引擎使用：${engineUsage}` +
        last,
      keyboard,
    }
  }

  #historyPanel(key: string, limit = 10): Panel {
    const total = this.#history.count(key)
    const keyboard = new InlineKeyboard().text("🔄 刷新", "show:history").text("⬅️ 主菜单", "show:menu")
    if (total === 0) {
      return {
        text: "🕘 *任务历史*\n\n暂无任务记录。发送消息或触发定时任务后，这里会保留最近 50 条执行记录。",
        keyboard,
      }
    }
    keyboard.row().text("🧹 清空历史", "history:clear")

    const lines: string[] = []
    let length = 0
    let shown = 0
    for (const entry of this.#history.list(key, limit)) {
      const status =
        entry.outcome === "ok" ? "✅ 成功" : entry.outcome === "cancelled" ? "🛑 已取消" : "❌ 失败"
      const engine = this.#agents.registry.label(entry.engine)
      const target = entry.model ? `${engine} / ${entry.model}` : engine
      const tag = entry.scheduled ? " · 🗓 定时" : ""
      const prompt = entry.prompt ? `\n   _${escapeMarkdown(clip(entry.prompt, 100) ?? "")}_` : ""
      const line =
        `• ${formatDateTime(entry.at, this.#timezone)} · ${status} · ${formatDuration(entry.ms)}\n` +
        `   ${escapeMarkdown(target)}${tag}${prompt}`
      if (length + line.length > 3200) break
      lines.push(line)
      length += line.length + 2
      shown += 1
    }
    const more =
      shown < total ? `\n\n_另有 ${total - shown} 条更早记录，可发送 \`/history ${Math.min(20, total)}\` 查看。_` : ""

    return {
      text: `🕘 *任务历史*（已显示 ${shown} / 共 ${total} 条）\n\n${lines.join("\n\n")}${more}`,
      keyboard,
    }
  }

  #statusText(chatId: number, key: string): string {
    const engine = this.#store.getEngine(key)
    const model =
      engine === "opencode"
        ? this.#getCurrentModel(key).label
        : this.#cliModelLabel(engine, this.#store.getCliModel(key, engine))
    // Tells the user whether the model came from this chat or from the config default
    const ownSelection = engine === "opencode" ? this.#store.getModel(key) : this.#store.getCliModel(key, engine)
    const since = this.#runningSince.get(key)
    // #pending is what the queue panel shows, so status must not count cancelled-ahead slots
    const pending = this.#pending.get(key)?.length ?? 0
    const running = since ? `运行中（已 ${formatDuration(Date.now() - since)}）` : "空闲"
    const reminders = this.#reminders.list(chatId).length
    const schedules = this.#schedules.count(chatId)
    const today = this.#usage.summary(key).today.tasks
    const proxy = this.#proxies.active()
    const detected = this.#agents.registry.list().filter((profile) => this.#agents.registry.binPath(profile)).length

    return (
      `📊 *运行状态*\n• 引擎: *${this.#agents.registry.label(engine)}*\n• 模型: *${model}*${ownSelection ? "" : "（默认）"}\n` +
      `• 当前任务: ${running}\n• 待处理队列: ${pending} 条\n• 今日任务: ${today} 条\n` +
      `• Agent CLI: ${detected} 个已安装\n` +
      `• 待触发提醒: ${reminders} 条\n• 定时任务: ${schedules} 个\n` +
      `• 网络代理: ${proxy ? `#${proxy.id} ${escapeMarkdown(proxy.name)}` : "未启用"}\n` +
      `• Bot 运行时长: ${formatDuration(Date.now() - this.#startedAt)}`
    )
  }

  #statusKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🔄 刷新状态", "show:status")
      .text("📈 使用统计", "show:usage")
      .row()
      .text("🕘 任务历史", "show:history")
      .text("📋 查看队列", "show:queue")
      .text("🌐 网络代理", "show:proxy")
      .row()
      .text("🗓 定时任务", "show:schedule")
      .text("⏰ 我的提醒", "show:reminders")
      .row()
      .text("📦 Agent 管理", "show:agents")
      .text("🛠 运维中心", "show:ops")
      .row()
      .text("⬅️ 主菜单", "show:menu")
  }

  async #handleRemind(chatId: number, userId: number, arg: string): Promise<void> {
    if (!arg) {
      await this.#sendTextMessage(
        chatId,
        "⏰ *设置提醒*\n\n用法：`/remind 30m 喝水`\n\n支持的时间格式：\n" +
        "• `30s` / `10m` / `2h` / `1d` / `1h30m`，也可写 `5分钟后` / `半小时后` / `1小时30分钟后`\n" +
        "• `18:30` / `8点半` / `下午3点`（当天或次日）\n" +
        "• `今天 18:30` / `明天 08:30` / `后天 09:00` / `今晚8点半`\n" +
        "• `every 30m` / `每30m` / `每5分钟`（重复提醒）\n" +
        "• `每天 08:30` / `每天8点半`（每天固定时间）\n\n" +
          `当前时区：\`${this.#timezone}\`（\`/timezone\` 可修改），最多同时保留 ${MAX_PER_CHAT} 条。`,
      )
      return
    }

    try {
      const reminder = this.#reminders.add(chatId, userId, arg)
      const when = formatReminderTime(reminder.dueAt, this.#timezone)
      const remaining = formatRemaining(reminder.dueAt - Date.now())
      const repeat = reminder.repeat ? `\n• 重复：${describeRepeat(reminder.repeat)}` : ""
      await this.#sendTextMessage(
        chatId,
        `⏰ *提醒已设置* #${reminder.id}\n• 时间：${when}（${this.#timezone}，约 ${remaining}后）${repeat}\n• 内容：${escapeMarkdown(reminder.text)}\n\n发送 \`/cancel ${reminder.id}\` 可取消。`,
        new InlineKeyboard().text(`❌ 取消提醒 #${reminder.id}`, `rcancel:${reminder.id}`),
      )
    } catch (err) {
      await this.#sendTextMessage(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async #handleReminders(chatId: number): Promise<void> {
    await this.#sendPanel(chatId, this.#remindersPanel(chatId))
  }

  async #handleCancelReminder(chatId: number, arg: string): Promise<void> {
    const id = Number(arg.trim())
    if (!arg || !Number.isInteger(id) || id <= 0) {
      await this.#sendTextMessage(chatId, "用法：`/cancel 编号`（编号见 `/reminders` 列表）。")
      return
    }

    const removed = this.#reminders.cancel(chatId, id)
    if (!removed) {
      await this.#sendTextMessage(chatId, `⚠️ 未找到编号为 #${id} 的提醒，发送 \`/reminders\` 查看当前列表。`)
      return
    }
    await this.#sendTextMessage(chatId, `✅ 已取消提醒 #${removed.id}：${removed.text}`)
  }

  async #handleAliasCommand(chatId: number, arg: string): Promise<void> {
    const [action = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    const norm = action.toLowerCase()

    if (!norm || norm === "list" || norm === "面板") {
      await this.#sendPanel(chatId, this.#aliasPanel(chatId))
      return
    }

    if (norm === "add" || norm === "新增") {
      const [name = "", ...words] = rest
      if (!name || words.length === 0) {
        await this.#sendTextMessage(
          chatId,
          "用法：`/alias add 名称 指令内容`\n例如：`/alias add code 审查当前目录的代码并给出改进清单`\n名称限小写字母/数字/下划线。",
        )
        return
      }
      try {
        const entry = this.#aliases.add(chatId, name, words.join(" "))
        await this.#sendTextMessage(
          chatId,
          `✅ 已保存快捷指令 \`/${entry.name}\`\n以后发送 \`/${entry.name}\` 即会执行：${escapeMarkdown(clip(entry.expansion, 300) ?? "")}`,
        )
      } catch (err) {
        await this.#sendTextMessage(chatId, `⚠️ ${escapeMarkdown((err as Error).message)}`)
      }
      return
    }

    if (norm === "del" || norm === "rm" || norm === "delete" || norm === "删除") {
      const name = rest[0] ?? ""
      const removed = this.#aliases.remove(chatId, name)
      if (!removed) {
        await this.#sendTextMessage(chatId, `⚠️ 未找到快捷指令 \`/${escapeMarkdown(name)}\`，发送 \`/alias\` 查看当前列表。`)
        return
      }
      await this.#sendTextMessage(chatId, `✅ 已删除快捷指令 \`/${removed.name}\``)
      return
    }

    await this.#sendTextMessage(
      chatId,
      "用法：\n• `/alias` 查看快捷指令面板\n• `/alias add 名称 指令内容` 新增\n• `/alias del 名称` 删除",
    )
  }

  #aliasPanel(chatId: number): Panel {
    const aliases = this.#aliases.list(chatId)
    const keyboard = new InlineKeyboard().text("➕ 用法见 /alias add", "noop:alias").row().text("⬅️ 主菜单", "show:menu")
    if (aliases.length === 0) {
      return {
        text:
          "⚡ *快捷指令*\n\n还没有自定义指令。用 `/alias add 名称 指令内容` 创建，例如：\n`/alias add code 审查当前目录的代码`\n之后发送 `/code` 即可触发。",
        keyboard,
      }
    }
    const lines = aliases.map((entry) => `• \`/${entry.name}\` → ${escapeMarkdown(clip(entry.expansion, 120) ?? "")}`)
    for (const entry of aliases) {
      keyboard.text(`🗑 /${entry.name}`, `aliasdel:${entry.name}`)
    }
    keyboard.row().text("⬅️ 主菜单", "show:menu")
    return { text: `⚡ *快捷指令*（${aliases.length}）\n\n${lines.join("\n")}\n\n点按钮删除，或发送 /alias add 新增。`, keyboard }
  }

  async #handleScheduleCommand(chatId: number, userId: number, key: string, arg: string): Promise<void> {
    const [action = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    const norm = action.toLowerCase()

    if (!norm || norm === "list") {
      await this.#sendPanel(chatId, this.#schedulePanel(chatId))
      return
    }

    if (norm === "add") {
      const input = rest.join(" ")
      if (!input) {
        await this.#sendTextMessage(chatId, SCHEDULE_USAGE)
        return
      }
      try {
        const engine = this.#store.getEngine(key)
        const defaults: ScheduleDefaults =
          engine === "opencode"
            ? { engine, model: this.#getCurrentModel(key) }
            : { engine, cliModel: this.#store.getCliModel(key, engine) ?? this.#agents.registry.defaultModel(engine) }
        const task = this.#schedules.add(chatId, userId, input, defaults)
        const when = formatReminderTime(task.dueAt, this.#timezone)
        const remaining = formatRemaining(task.dueAt - Date.now())
        const repeat = task.repeat
          ? `\n• 重复：${describeRepeat(task.repeat)}`
          : "\n• 重复：不重复（执行后自动删除）"
        // Escaping Markdown can double the length; echoing a 2000-char prompt in full
        // would push this confirmation past Telegram's 4096-char limit
        const promptPreview = `${clip(task.prompt, 300) ?? ""}${task.prompt.length > 300 ? "…" : ""}`
        await this.#sendTextMessage(
          chatId,
          `🗓 *定时任务已创建* #${task.id}\n• 时间：${when}（${this.#timezone}，约 ${remaining}后）${repeat}\n` +
            `• 引擎：${escapeMarkdown(scheduleTargetLabel(task, this.#agents.registry))}\n• 提示词：${escapeMarkdown(promptPreview)}\n\n` +
            "到点后会自动调用 AI 执行，并把结果发送到这里。",
          new InlineKeyboard()
            .text(`⏸ 暂停 #${task.id}`, `sched:pause:${task.id}`)
            .text(`🗑 删除 #${task.id}`, `sched:del:${task.id}`),
        )
      } catch (err) {
        await this.#sendTextMessage(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (norm === "run" || norm === "now") {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        await this.#sendTextMessage(chatId, "用法：`/schedule run 编号`（编号见 `/schedule` 面板）。")
        return
      }
      try {
        const task = this.#schedules.runNow(chatId, id)
        if (!task) {
          await this.#sendTextMessage(chatId, `⚠️ 定时任务 #${id} 不存在。`)
          return
        }
        await this.#sendTextMessage(
          chatId,
          `▶️ 已立即执行定时任务 #${id}，结果会发送到这里（不影响原定的下一次执行时间）。`,
        )
      } catch (err) {
        await this.#sendTextMessage(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (norm === "pause" || norm === "resume" || norm === "del" || norm === "delete" || norm === "rm") {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        await this.#sendTextMessage(chatId, `用法：\`/schedule ${norm} 编号\`（编号见 \`/schedule\` 面板）。`)
        return
      }
      if (norm === "pause") {
        const task = this.#schedules.pause(chatId, id)
        await this.#sendTextMessage(chatId, task ? `⏸ 已暂停定时任务 #${id}。` : `⚠️ 定时任务 #${id} 不存在。`)
        return
      }
      if (norm === "resume") {
        const task = this.#schedules.resume(chatId, id)
        await this.#sendTextMessage(chatId, task ? `▶️ 已恢复定时任务 #${id}。` : `⚠️ 定时任务 #${id} 不存在。`)
        return
      }
      const removed = this.#schedules.remove(chatId, id)
      await this.#sendTextMessage(chatId, removed ? `🗑 已删除定时任务 #${id}。` : `⚠️ 定时任务 #${id} 不存在。`)
      return
    }

    await this.#sendTextMessage(chatId, SCHEDULE_USAGE)
  }

  #schedulePanel(chatId: number): Panel {
    const items = this.#schedules.list(chatId)
    const keyboard = new InlineKeyboard()
    if (items.length === 0) {
      return {
        text:
          "🗓 *定时任务*\n\n暂无定时任务。\n\n" +
          "发送 `/schedule add 30m 检查服务器` 创建；支持 `every 2h`、`每天 09:00`、`每2小时`、`下午6点`，" +
          "可加 `--engine claude --model sonnet` 指定执行引擎。",
        keyboard: keyboard.text("🔄 刷新", "show:schedule").text("⬅️ 主菜单", "show:menu"),
      }
    }

    const now = Date.now()
    const lines: string[] = []
    let length = 0
    let shown = 0
    for (const item of items) {
      const state = item.paused ? "⏸" : "✅"
      const when = formatReminderTime(item.dueAt, this.#timezone)
      const whenText = item.paused ? when : `${when}（约 ${formatRemaining(item.dueAt - now)}后）`
      const repeat = item.repeat ? ` 🔁 ${describeRepeat(item.repeat)}` : ""
      const last = item.lastStatus
        ? `\n  上次：${
            item.lastStatus === "ok"
              ? "成功"
              : item.lastStatus === "cancelled"
                ? "已取消"
                : item.attempts
                  ? `失败（第 ${item.attempts} 次重试中）`
                  : "失败"
          }`
        : ""
      const promptText = `${clip(item.prompt, 200) ?? ""}${item.prompt.length > 200 ? "…" : ""}`
      const line = `${state} #${item.id} ${whenText}${repeat}\n  ${scheduleTargetLabel(item, this.#agents.registry)}\n  ${escapeMarkdown(promptText)}${last}`
      if (length + line.length > 3000) break
      lines.push(line)
      length += line.length + 2
      shown += 1
    }
    const more =
      shown < items.length
        ? `\n\n_…另有 ${items.length - shown} 个未显示，可用 /schedule del 编号删除。_`
        : ""

    items.forEach((item, index) => {
      keyboard
        .text(`▶️ 运行 #${item.id}`, `sched:run:${item.id}`)
        .text(
          item.paused ? `▶️ 恢复 #${item.id}` : `⏸ 暂停 #${item.id}`,
          item.paused ? `sched:resume:${item.id}` : `sched:pause:${item.id}`,
        )
        .text(`🗑 删除 #${item.id}`, `sched:del:${item.id}`)
      if (index < items.length - 1) keyboard.row()
    })
    keyboard.row().text("🔄 刷新", "show:schedule").text("⬅️ 主菜单", "show:menu")

    return {
      text:
        `🗓 *定时任务（${items.length}）*\n\n${lines.join("\n\n")}${more}\n\n` +
        "到点后自动执行并把结果发到这里。发送 `/schedule add ...` 新建；「▶️ 运行」立即执行一次，不影响原定时间。",
      keyboard,
    }
  }

  async #ensureCapacity(chatId: number, key: string): Promise<boolean> {
    // #pending holds only the messages that have not started yet
    const waiting = this.#pending.get(key)?.length ?? 0
    if (waiting < MAX_PENDING) return true
    await this.#sendTextMessage(
      chatId,
      `⚠️ 待处理消息过多（最多排队 ${MAX_PENDING} 条），请等待当前任务完成或发送 /stop 取消。`,
    )
    return false
  }

  #collectAttachments(message: Message): AttachmentDescriptor[] {
    const attachments: AttachmentDescriptor[] = []

    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1]!
      attachments.push({
        fileId: largest.file_id,
        kind: "image",
        name: `photo-${largest.file_id.slice(-8)}.jpg`,
        mime: "image/jpeg",
        size: largest.file_size,
      })
    }

    if (message.document) {
      const doc = message.document
      const mime = doc.mime_type ?? "application/octet-stream"
      attachments.push({
        fileId: doc.file_id,
        kind: mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "document",
        name: doc.file_name ?? `document-${doc.file_id.slice(-8)}${extensionFromMime(mime)}`,
        mime,
        size: doc.file_size,
      })
    }

    if (message.voice) {
      const mime = message.voice.mime_type ?? "audio/ogg"
      attachments.push({
        fileId: message.voice.file_id,
        kind: "audio",
        name: `voice-${message.voice.file_id.slice(-8)}${extensionFromMime(mime) || ".ogg"}`,
        mime,
        size: message.voice.file_size,
      })
    }

    if (message.audio) {
      const mime = message.audio.mime_type ?? "audio/mpeg"
      attachments.push({
        fileId: message.audio.file_id,
        kind: "audio",
        name: message.audio.file_name ?? `audio-${message.audio.file_id.slice(-8)}${extensionFromMime(mime) || ".mp3"}`,
        mime,
        size: message.audio.file_size,
      })
    }

    return attachments.slice(0, MAX_ATTACHMENTS)
  }

  // Never await #dispatch from an update handler: grammY processes updates
  // sequentially, so blocking here would make /stop and /status unreachable.
  #enqueue(job: Job): void {
    void this.#dispatch(job).catch((err: unknown) => {
      this.#log.error(`task failed [${job.key}]:`, err instanceof Error ? err.message : String(err))
    })
  }

  #dispatch(job: Job): Promise<void> {
    job.id ??= `q${String(++jobSequence)}`
    const previous = this.#queues.get(job.key) ?? Promise.resolve()
    const run = previous.then(
      () => this.#process(job),
      () => this.#process(job),
    )

    this.#queues.set(job.key, run)
    const pending = this.#pending.get(job.key) ?? []
    pending.push(job)
    this.#pending.set(job.key, pending)
    const cleanup = (): void => {
      if (this.#queues.get(job.key) === run) this.#queues.delete(job.key)
      this.#dequeue(job)
    }
    run.then(cleanup, cleanup)
    return run
  }

  #dequeue(job: Job): void {
    const pending = this.#pending.get(job.key)
    if (!pending) return
    const index = pending.indexOf(job)
    if (index >= 0) pending.splice(index, 1)
    if (pending.length === 0) this.#pending.delete(job.key)
  }

  /** The prompt behind a failure card, so its 重试 replays that task and not the newest one. */
  #rememberRetry(job: Job): void {
    if (!job.id || job.scheduled) return
    this.#retryPrompts.set(job.id, { key: job.key, text: job.text, attachments: job.attachments })
    while (this.#retryPrompts.size > RETRY_CARD_LIMIT) {
      const oldest = this.#retryPrompts.keys().next()
      if (oldest.done) break
      this.#retryPrompts.delete(oldest.value)
    }
  }

  async #process(job: Job): Promise<void> {
    this.#dequeue(job)
    if (job.dropped) {
      // Removed from the queue panel: never reaches the engine and stays silent
      this.#log.debug(`dropped queued message [${job.key}] on request`)
      job.onOutcome?.("cancelled")
      return
    }
    // Scheduled prompts are executed verbatim, even if they start with "/"
    const parts = job.scheduled ? [] : job.text.split(/\s+/)
    const rawCommand = parts[0]?.toLowerCase() ?? ""
    const command = rawCommand.split("@")[0]
    const arg = parts.slice(1).join(" ").trim()

    if (command === "/start") {
      await this.#sendTextMessage(job.chatId, this.#welcomeText(job.key, job.userId), this.#menuKeyboard())
      return
    }

    if (command === "/help") {
      await this.#sendTextMessage(job.chatId, HELP, this.#menuKeyboard())
      return
    }

    if (command === "/agent") {
      await this.#handleAgentCommand(job, arg || undefined)
      return
    }

    if (command === "/agents") {
      await this.#handleAgentsCommand(job, arg)
      return
    }

    if (command === "/new" || command === "/reset") {
      const engine = this.#store.getEngine(job.key)
      if (engine === "opencode") {
        const old = this.#store.get(job.key)
        if (old) {
          await this.#oc.deleteSession(old).catch(() => {})
          this.#store.clearSession(job.key)
        }
      } else {
        this.#store.clearCliSession(job.key, engine)
      }
      await this.#sendTextMessage(
        job.chatId,
        `✨ *已开启新会话* (当前 Agent: ${escapeMarkdown(this.#agents.registry.label(engine))})，对话上下文已清空。`,
      )
      return
    }

    if (command === "/id") {
      const engine = this.#store.getEngine(job.key)
      let infoText =
        `🆔 *会话信息*\n• 聊天 ID: \`${job.chatId}\`\n• 用户 ID: \`${job.userId}\`\n` +
        `• 当前 Agent: *${escapeMarkdown(this.#agents.registry.label(engine))}*\n` +
        `• 提醒时区: \`${this.#timezone}\`\n`

      if (engine === "opencode") {
        const sessionID = this.#store.get(job.key)
        const currentModel = this.#getCurrentModel(job.key)
        infoText += `• OpenCode 模型: *${escapeMarkdown(currentModel.label)}*\n• 会话 ID: \`${sessionID || "暂未创建"}\``
      } else {
        const profile = this.#agents.registry.get(engine)
        const sessionID = this.#store.getCliSession(job.key, engine)
        const model = this.#cliModelLabel(engine, this.#store.getCliModel(job.key, engine))
        const binPath = profile ? this.#agents.registry.binPath(profile) : undefined
        infoText +=
          `• 模型: *${escapeMarkdown(model)}*\n• CLI 会话: \`${sessionID || "暂未创建"}\`\n` +
          `• 可执行文件: ${binPath ? `\`${escapeMarkdown(binPath)}\`` : "_未安装_"}\n` +
          `• 工作目录: \`${escapeMarkdown(this.#agents.workDir(job.key))}\`（\`/dir\` 可修改）`
      }
      await this.#sendTextMessage(job.chatId, infoText)
      return
    }

    if (command === "/api") {
      await this.#handleApiInfo(job.chatId)
      return
    }

    if (command === "/dir") {
      await this.#handleDirCommand(job, arg || undefined)
      return
    }

    if (command === "/model") {
      await this.#handleModelCommand(job, arg || undefined)
      return
    }

    if (command === "/cc") {
      await this.#ccCommands.handleCommand(job.chatId, job.key, arg)
      return
    }

    if (command === "/retry") {
      // Prefer the snapshot taken when the /retry was queued: a task that finished
      // in the meantime must not steal the retry target
      const last = job.retryOf ?? this.#lastPrompts.get(job.key)
      if (!last) {
        await this.#sendTextMessage(job.chatId, "⚠️ 还没有可重试的任务。")
        return
      }
      // /stop bumps the generation, so a /retry that was queued before it must not
      // resurrect the work the user just discarded
      if (job.generation !== (this.#generation.get(job.key) ?? 0)) {
        this.#log.debug(`dropped stale retry [${job.key}]`)
        job.onOutcome?.("cancelled")
        return
      }
      await this.#sendTextMessage(job.chatId, "🔁 已重新提交上一条任务。")
      await this.#process({ ...job, text: last.text, attachments: last.attachments })
      return
    }

    if (job.text.length > MAX_INPUT_LENGTH) {
      await this.#sendTextMessage(job.chatId, `⚠️ 消息太长了（上限 ${MAX_INPUT_LENGTH} 字），请分段发送。`)
      job.onOutcome?.("failed")
      return
    }

    // A /stop bumps the generation; queued prompts from before it are discarded
    if (job.generation !== (this.#generation.get(job.key) ?? 0)) {
      this.#log.debug(`dropped stale message [${job.key}]`)
      job.onOutcome?.("cancelled")
      return
    }

    // User-defined /name shortcuts expand here (after the built-in commands all
    // missed), so an alias may itself point at a command; scheduled prompts stay verbatim
    if (!job.scheduled) {
      for (let depth = 0; depth < 3; depth++) {
        const first = job.text.split(/\s+/, 1)[0] ?? ""
        if (!/^\/[a-z][a-z0-9_]*$/i.test(first)) break
        const expansion = this.#aliases.expand(job.chatId, first.slice(1))
        if (!expansion) break
        const rest = job.text.slice(first.length).trim()
        this.#log.debug(`alias ${first} expanded [${job.key}]`)
        job = { ...job, text: rest ? `${expansion} ${rest}` : expansion }
      }
    }

    // A scheduled prompt is not something the user typed, so /retry must not replay it
    if (!job.scheduled) this.#lastPrompts.set(job.key, { text: job.text, attachments: job.attachments })

    const engine = job.engine ?? this.#store.getEngine(job.key)
    const isOpencode = engine === "opencode"
    const activeModel = isOpencode ? (job.model ?? this.#getCurrentModel(job.key)) : undefined
    const cliModel = isOpencode
      ? undefined
      : (job.cliModel ?? this.#store.getCliModel(job.key, engine) ?? this.#agents.registry.defaultModel(engine))
    const taskStarted = Date.now()
    let outcome: UsageOutcome = "failed"

    const controller = new AbortController()
    this.#cancels.set(job.key, controller)
    this.#runningSince.set(job.key, Date.now())

    // Keep sending typing action while generating reply
    let typingActive = true
    const typingLoop = async () => {
      while (typingActive) {
        await this.#bot.api.sendChatAction(job.chatId, "typing").catch(() => {})
        await sleep(4000)
      }
    }
    const typingPromise = typingLoop()
    const tracker = new ProgressTracker(this.#bot, job.chatId)
    try {
      const input = job.attachments?.length
        ? await this.#buildAttachmentInput(job, activeModel, controller.signal)
        : { text: job.text, files: [] as PromptFile[] }
      const attachmentInfo = job.attachments?.length ? ` attachments=${job.attachments.length}` : ""
      const promptLabel = isOpencode ? `OpenCode: ${activeModel?.label}` : this.#agents.registry.label(engine)
      this.#log.info(`prompt [${job.key}] (${promptLabel}) length=${input.text.length}${attachmentInfo}`)
      this.#log.debug(`prompt content: ${input.text.slice(0, 80).replace(/\n/g, " ")}`)

      const reply = await callEngine(this.#engineDeps, {
        key: job.key,
        engine,
        text: input.text,
        files: input.files,
        model: activeModel,
        cliModel,
        signal: controller.signal,
        onProgress: (status) => tracker.update(status),
      })

      typingActive = false
      void typingPromise
      await tracker.finish()

      await this.#sendReply(job, reply)
      outcome = "ok"
    } catch (err) {
      typingActive = false
      void typingPromise
      await tracker.finish()
      const detail = err instanceof Error ? err.message : String(err)
      if (/已取消当前任务/.test(detail)) {
        outcome = "cancelled"
        this.#log.info(`task cancelled [${job.key}]`)
        return
      }
      this.#log.error(`prompt failed [${job.key}]:`, this.#maskToken(detail))
      const hint =
        engine === "opencode" && /ECONNREFUSED|UND_ERR_SOCKET|fetch failed/i.test(detail)
          ? "\n\n请确认 opencode serve 已启动（npm run serve）。"
          : ""
      this.#rememberRetry(job)
      await this.#sendTextMessage(
        job.chatId,
        `抱歉，处理这条消息时出错了：\n${escapeMarkdown(redactSecrets(detail))}${hint}`,
        !job.scheduled && job.id ? new InlineKeyboard().text("🔁 重试", `retry:${job.id}`) : undefined,
      )
    } finally {
      const modelLabel = isOpencode
        ? activeModel?.label
        : cliModel
          ? this.#agents.registry.modelLabel(engine, cliModel)
          : undefined
      const ms = Date.now() - taskStarted
      this.#usage.record(job.key, { engine, model: modelLabel, ms, outcome })
      this.#history.record(job.key, {
        prompt: job.text,
        engine,
        model: modelLabel,
        ms,
        outcome,
        scheduled: job.scheduled,
      })
      if (this.#cancels.get(job.key) === controller) this.#cancels.delete(job.key)
      this.#runningSince.delete(job.key)
      this.#pruneChatState()
      job.onOutcome?.(outcome)
    }
  }

  #pruneChatState(): void {
    const active = (key: string): boolean =>
      this.#queues.has(key) || this.#pending.has(key) || this.#runningSince.has(key)
    const removed =
      pruneChatState(this.#generation, active, CHAT_STATE_LIMIT) +
      pruneChatState(this.#lastPrompts, active, CHAT_STATE_LIMIT) +
      this.#ccCommands.pruneProviders((chatId) => active(`tg:${chatId}`), CHAT_STATE_LIMIT)
    if (removed > 0) this.#log.debug(`pruned ${removed} idle chat state entries`)
  }

  async #downloadAttachment(chatId: number, att: AttachmentDescriptor, signal?: AbortSignal): Promise<SavedAttachment> {
    const file = await this.#bot.api.getFile(att.fileId)
    if (!file.file_path) throw new Error("Telegram 未返回文件路径（文件可能超过 20MB）")

    const url = `https://api.telegram.org/file/bot${this.#cfg.telegram.token}/${file.file_path}`
    let res: Response
    try {
      // /stop must cut downloads short too, not only the engine call after them
      const timeout = AbortSignal.timeout(60_000)
      res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (err) {
      // undici can echo the request URL, which carries the bot token
      throw new Error(`下载附件失败：${this.#maskToken(redactSecrets((err as Error).message))}`)
    }
    if (!res.ok) {
      // An unread body keeps the undici socket out of the pool for good
      await res.body?.cancel().catch(() => {})
      throw new Error(`下载失败 (HTTP ${res.status})`)
    }
    const data = Buffer.from(await res.arrayBuffer())
    if (data.byteLength > this.#cfg.maxInputBytes) {
      throw new Error(`超过 ${Math.round(this.#cfg.maxInputBytes / 1024 / 1024)}MB 上限`)
    }

    const saved = saveAttachment(this.#cfg.inboxDir, chatId, att.name, data)
    const result: SavedAttachment = { ...att, path: saved.path, bytes: data.byteLength }
    if (isTextAttachment(att.mime, saved.name)) {
      try {
        const { text, truncated } = readTextAttachment(saved.path)
        result.text = text
        result.truncated = truncated
      } catch {
        // treat as binary if decoding fails
      }
    }
    return result
  }

  async #buildAttachmentInput(job: Job, model?: ModelRef, signal?: AbortSignal): Promise<{ text: string; files: PromptFile[] }> {
    const saved: SavedAttachment[] = []
    const failed: string[] = []
    let totalBytes = 0

    for (const att of job.attachments ?? []) {
      if (totalBytes + (att.size ?? 0) > MAX_ATTACH_TOTAL_BYTES) {
        failed.push(`${att.name}: 附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
        continue
      }
      try {
        const item = await this.#downloadAttachment(job.chatId, att, signal)
        if (totalBytes + item.bytes > MAX_ATTACH_TOTAL_BYTES) {
          failed.push(`${att.name}: 附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
          // The copy is already on disk; drop it so oversized batches do not fill the inbox
          try {
            unlinkSync(item.path)
          } catch {
            // already gone
          }
          continue
        }
        totalBytes += item.bytes
        saved.push(item)
      } catch (err) {
        // Telegram client errors can quote the API URL, which contains the bot token
        const detail = this.#maskToken(redactSecrets(err instanceof Error ? err.message : String(err)))
        failed.push(`${att.name}: ${detail}`)
      }
    }
    pruneInbox(this.#cfg.inboxDir)

    const caps = model ? await this.#oc.inputCapabilities(model) : undefined
    return buildAttachmentSections(job.text, { saved, failed, modelCapabilities: caps })
  }

  async #handleAgentCommand(job: Job, target?: string): Promise<void> {
    if (!target) {
      await this.#sendPanel(job.chatId, this.#agentPanel(job.key))
      return
    }

    const [sub = "", rawId = ""] = target.split(/\s+/).filter(Boolean)
    const normalized = sub.toLowerCase()
    if (["install", "add", "uninstall", "remove", "del", "delete"].includes(normalized)) {
      await this.#handleAgentInstallCommand(job, normalized, rawId)
      return
    }

    const chosen = this.#agents.registry.resolveEngine(target)
    if (!chosen) {
      const ids = ["opencode", ...this.#agents.registry.list().map((profile) => profile.id)]
      await this.#sendTextMessage(
        job.chatId,
        `❌ 未识别的 Agent 引擎：\`${target}\`\n\n可选：${ids.map((id) => `\`${id}\``).join("、")}`,
      )
      return
    }

    this.#store.setEngine(job.key, chosen)
    this.#log.info(`agent switched [${job.key}] -> ${chosen}`)

    if (chosen === "opencode") {
      await this.#sendTextMessage(
        job.chatId,
        `✅ *已切换至 OpenCode Agent 引擎！*\n\n当前由 OpenCode 提供服务，支持多模型、工具调用与多媒体交互。\n发送 \`/model\` 可切换底层模型。`,
      )
      return
    }

    const profile = this.#agents.registry.get(chosen)!
    const binPath = this.#agents.registry.binPath(profile)
    const modelLine = profile.supportsModel
      ? profile.modelHint
        ? `\n• 可用模型提示：\`${profile.modelHint}\`（也可发送 \`/model <模型ID>\`）`
        : `\n• 模型：发送 \`/model <模型ID>\` 指定`
      : "\n• 模型：由 CLI 自身配置"
    const installLine = binPath
      ? `\n• 可执行文件：\`${binPath}\``
      : `\n• ⚠️ 未检测到 \`${profile.bin}\`${profile.install ? `\n• 安装：${profile.install}` : ""}`
    await this.#sendTextMessage(
      job.chatId,
      `✅ *已切换至 ${escapeMarkdown(profile.label)}！*\n\n${escapeMarkdown(profile.desc)}${modelLine}${installLine}`,
    )
  }

  async #handleAgentsCommand(job: Job, arg: string): Promise<void> {
    const [action = "", rawId = ""] = arg.split(/\s+/).filter(Boolean)
    if (!action) {
      await this.#sendPanel(job.chatId, this.#agentInstallerPanel())
      return
    }
    const normalized = action.toLowerCase()
    if (["install", "add", "uninstall", "remove", "del", "delete", "update", "upgrade"].includes(normalized)) {
      await this.#handleAgentInstallCommand(job, normalized, rawId)
      return
    }
    await this.#sendTextMessage(
      job.chatId,
      "用法：`/agents` 查看检测与安装面板；`/agents install <id>` 安装；`/agents update <id>` 更新 Bot 托管的 CLI；`/agents uninstall <id>` 卸载。",
    )
  }

  async #handleAgentInstallCommand(job: Job, action: string, rawId: string): Promise<void> {
    const uninstall = ["uninstall", "remove", "del", "delete"].includes(action)
    const update = ["update", "upgrade"].includes(action)
    if (!rawId) {
      await this.#sendPanel(job.chatId, this.#agentInstallerPanel())
      return
    }
    const engine = this.#agents.registry.resolveEngine(rawId)
    const profile = engine && engine !== "opencode" ? this.#agents.registry.get(engine) : undefined
    if (!engine || !profile) {
      await this.#sendTextMessage(job.chatId, `❌ 未识别的 Agent CLI：\`${rawId}\`\n发送 \`/agents\` 查看可管理列表。`)
      return
    }

    if (uninstall) {
      if (!this.#agentInstaller.uninstallCommand(engine)) {
        await this.#sendTextMessage(
          job.chatId,
          `ℹ️ ${escapeMarkdown(profile.label)} 不是由 Bot 安装的，无法自动卸载。\n只能卸载通过 \`/agents install\` 安装的 CLI；系统预装版本请手动管理。`,
        )
        return
      }
      if (this.#store.getEngine(job.key) === engine) {
        await this.#sendTextMessage(
          job.chatId,
          `⚠️ 当前正在使用 ${escapeMarkdown(profile.label)}，请先发送 \`/agent opencode\` 切换后再卸载。`,
        )
        return
      }
      await this.#requestAgentAction(job.chatId, job.key, "uninstall", engine)
      return
    }

    if (update) {
      if (!this.#agentInstaller.updateCommand(engine)) {
        await this.#sendTextMessage(
          job.chatId,
          `ℹ️ ${escapeMarkdown(profile.label)} 不是由 Bot 安装的，无法自动更新。\n只能更新通过 \`/agents install\` 安装的 CLI；其他方式安装的版本请手动升级。`,
        )
        return
      }
      await this.#requestAgentAction(job.chatId, job.key, "update", engine)
      return
    }

    const installed = this.#agents.registry.binPath(profile)
    if (installed) {
      const managed = this.#agentInstaller.isManaged(engine)
      await this.#sendTextMessage(
        job.chatId,
        `✅ 已检测到 ${escapeMarkdown(profile.label)}：\`${installed}\`\n` +
          (managed
            ? "该版本由 Bot 托管，可用 `/agents update " + engine + "` 更新、`/agents uninstall " + engine + "` 卸载。"
            : "该版本不是由 Bot 安装的，Bot 不会自动更新或卸载它。"),
      )
      return
    }

    if (!this.#agentInstaller.installCommand(profile)) {
      const hint = profile.install ? `\n安装方式：${escapeMarkdown(profile.install)}` : ""
      await this.#sendTextMessage(
        job.chatId,
        `ℹ️ ${escapeMarkdown(profile.label)} 暂不支持在 Telegram 内自动安装。${hint}`,
      )
      return
    }

    await this.#requestAgentAction(job.chatId, job.key, "install", engine)
  }

  #agentActionBlocked(key: string, action: AgentAction, engine: string): string | undefined {
    const profile = this.#agents.registry.get(engine)
    if (!profile || engine === "opencode") return "未识别的 Agent CLI"
    if (action === "install") {
      if (this.#agents.registry.binPath(profile)) return `${profile.label} 已安装，无需重复安装`
      if (!this.#agentInstaller.installCommand(profile)) return `${profile.label} 暂不支持在 Telegram 内自动安装`
      return undefined
    }
    if (!this.#agentInstaller.isManaged(engine)) {
      return `${profile.label} 不是由 Bot 安装的，无法自动${AGENT_ACTION_VERB[action]}`
    }
    if (action === "uninstall" && this.#store.getEngine(key) === engine) return "请先切换到 OpenCode 再卸载"
    return undefined
  }

  async #requestAgentAction(chatId: number, key: string, action: AgentAction, engine: string): Promise<void> {
    const profile = this.#agents.registry.get(engine)
    if (!profile) {
      await this.#sendTextMessage(chatId, `❌ 未识别的 Agent CLI：\`${escapeMarkdown(engine)}\``)
      return
    }
    const command =
      action === "install"
        ? this.#agentInstaller.installCommand(profile)
        : action === "update"
          ? this.#agentInstaller.updateCommand(engine)
          : this.#agentInstaller.uninstallCommand(engine)
    if (!command) {
      const hint = action === "install" && profile.install ? `\n安装方式：${escapeMarkdown(profile.install)}` : ""
      await this.#sendTextMessage(
        chatId,
        `ℹ️ ${escapeMarkdown(profile.label)} 无法在 Telegram 内自动${AGENT_ACTION_VERB[action]}。${hint}`,
      )
      return
    }
    const verb = AGENT_ACTION_VERB[action]
    const icon = action === "install" ? "⬇️" : action === "update" ? "🔄" : "🗑"
    const note =
      action === "install"
        ? `仅支持内置的 npm/pip 安装方式；安装完成后可用 \`/agent ${engine}\` 切换。`
        : action === "update"
          ? "会覆盖 Bot 托管的版本；更新期间该 CLI 的正在运行任务可能受影响。"
          : "只会移除由 Bot 安装的版本。"
    const now = Date.now()
    for (const [token, pending] of this.#agentPending) {
      if (now - pending.createdAt > AGENT_CONFIRM_TTL_MS) this.#agentPending.delete(token)
    }
    const token = randomBytes(6).toString("hex")
    this.#agentPending.set(token, { chatId, action, engine, createdAt: now })
    await this.#sendTextMessage(
      chatId,
      `${icon} *确认${verb} ${escapeMarkdown(profile.label)}？*\n\n将执行：\`${command}\`\n\n${note}\n\n` +
        "_5 分钟内有效，点击确认后执行。_",
      new InlineKeyboard().text(`✅ 确认${verb}`, `a:cfm:${token}`).text("取消", `a:cnl:${token}`),
    )
  }

  async #runAgentAction(
    chatId: number,
    key: string,
    action: AgentAction,
    engine: string,
  ): Promise<void> {
    const profile = this.#agents.registry.get(engine)
    const label = profile?.label ?? engine
    const verb = AGENT_ACTION_VERB[action]
    await this.#sendTextMessage(chatId, `⏳ 正在${verb} ${escapeMarkdown(label)}…（最长 10 分钟，期间可继续使用其他命令）`)
    const result =
      action === "install"
        ? await this.#agentInstaller.install(engine)
        : action === "uninstall"
          ? await this.#agentInstaller.uninstall(engine)
          : await this.#agentInstaller.update(engine)
    this.#log.info(`agent ${action} [${key}] ${engine}: ${result.ok ? "ok" : "failed"}`)

    let text = result.ok ? `✅ ${escapeMarkdown(result.message)}` : `❌ ${escapeMarkdown(result.message)}`
    if (result.output) text += `\n\n${escapeMarkdown(result.output.replace(/```/g, "'''"))}`
    await this.#sendTextMessage(chatId, text)
    await this.#sendPanel(chatId, this.#agentInstallerPanel())
  }

  async #handleDiagnostics(chatId: number): Promise<void> {
    try {
      const diag = await this.#ops.diagnostics()
      await this.#sendTextMessage(
        chatId,
        this.#diagnosticsText(diag),
        new InlineKeyboard()
          .text("🔄 刷新", "ops:diag")
          .text("🛠 运维中心", "show:ops")
          .row()
          .text("⬅️ 主菜单", "show:menu"),
      )
    } catch (err) {
      await this.#sendTextMessage(chatId, `❌ 诊断失败：${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  #diagnosticsText(diag: OpsDiagnostics): string {
    const git = diag.git
      ? `${escapeMarkdown(diag.git.branch)} @ ${escapeMarkdown(diag.git.commit)}${diag.git.dirty ? "（有未提交改动）" : ""}`
      : "不可用"
    const ccSwitch = diag.ccSwitch
      ? `已安装${diag.ccSwitch.version ? `（${escapeMarkdown(diag.ccSwitch.version)}）` : ""}`
      : "未安装"
    const opencode = diag.opencode.reachable ? "🟢 可访问" : "🔴 不可访问"
    const disk = diag.disk
      ? `${formatBytes(diag.disk.freeBytes)} 可用 / ${formatBytes(diag.disk.totalBytes)}`
      : "未知"
    const memory = `${formatBytes(diag.memory.freeBytes)} 可用 / ${formatBytes(diag.memory.totalBytes)}`
    return (
      `🩺 *系统诊断*\n\n` +
      `• Node：${escapeMarkdown(diag.node)}（${escapeMarkdown(diag.platform)}）\n` +
      `• Bot PID：${diag.pid} · 已运行 ${formatDuration(diag.uptimeSec * 1000)}\n` +
      `• 部署方式：${diag.systemd ? "systemd" : "脚本 / 手动"}\n` +
      `• 项目目录：\`${escapeMarkdown(diag.projectDir)}\`\n` +
      `• Git：${git}\n` +
      `• OpenCode：${opencode}${diag.opencode.pid ? `（PID ${diag.opencode.pid}）` : ""}\n` +
      `• OpenCode URL：\`${escapeMarkdown(diag.opencode.url)}\`\n` +
      `• cc-switch：${ccSwitch}\n` +
      `• Bot 日志：${formatBytes(diag.log.bytes)} · \`${escapeMarkdown(diag.log.path)}\`\n` +
      `• OpenCode 日志：${formatBytes(diag.opencodeLog.bytes)}\n` +
      `• 磁盘：${disk}\n` +
      `• 内存：${memory}`
    )
  }

  async #opsPanel(): Promise<Panel> {
    let head = "🛠 *运维中心*\n\n诊断暂时不可用。"
    try {
      head = this.#diagnosticsText(await this.#ops.diagnostics())
    } catch {
      // keep fallback text
    }
    const busy = this.#opsRunning ? `\n\n⏳ 正在执行：${escapeMarkdown(this.#opsRunning)}` : ""
    return {
      text: `🛠 *运维中心*\n\n${head}${busy}\n\n⚠️ 更新、重启与停止服务需要确认；不会读取或输出 .env 中的密钥。`,
      keyboard: this.#opsKeyboard(),
    }
  }

  #opsKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🩺 诊断", "ops:diag")
      .text("📜 Bot 日志", "ops:logs:bot:80")
      .row()
      .text("⚡ OpenCode 服务", "ops:svc")
      .text("🧪 运行检查", "ops:check")
      .row()
      .text("🔌 cc-switch 安装/更新", "ops:cc")
      .text("⚙️ 配置项", "ops:env")
      .row()
      .text("🔐 访问白名单", "show:access")
      .text("🔍 检查更新", "ops:checkup")
      .row()
      .text("⬆️ 更新项目", "ops:update")
      .text("🔄 重启 Bot", "ops:restart")
      .row()
      .text("🔄 刷新", "show:ops")
      .row()
      .text("⬅️ 主菜单", "show:menu")
  }

  async #handleLogs(chatId: number, arg: string): Promise<void> {
    let source: "bot" | "opencode" = "bot"
    let lines = 80
    for (const token of arg.split(/\s+/).filter(Boolean)) {
      if (token === "opencode" || token === "oc") source = "opencode"
      else if (token === "bot") source = "bot"
      else if (/^\d+$/.test(token)) lines = Math.min(400, Math.max(10, Number(token)))
    }
    const label = source === "opencode" ? "OpenCode" : "Bot"
    const result = this.#ops.tailLogs(source, lines)
    if (result.missing) {
      await this.#sendTextMessage(
        chatId,
        `📜 ${label} 日志尚未生成：\`${escapeMarkdown(result.path)}\``,
        new InlineKeyboard().text("🛠 运维中心", "show:ops"),
      )
      return
    }
    if (!result.ok) {
      await this.#sendTextMessage(chatId, `❌ 读取日志失败：${escapeMarkdown(result.text)}`)
      return
    }
    const body = result.text || "（日志为空）"
    const text =
      `📜 *${label} 日志（最近 ${lines} 行）*\n` +
      `\`${escapeMarkdown(result.path)}\` · ${formatBytes(result.bytes)}\n\n` +
      `\`\`\`\n${body.replace(/```/g, "'''")}\n\`\`\``
    for (const chunk of splitMessage(text, 3800)) {
      await this.#sendTextMessage(chatId, chunk)
    }
    await this.#sendTextMessage(
      chatId,
      "发送 `/logs opencode 200` 可查看 OpenCode 日志。",
      new InlineKeyboard()
        .text("🔄 刷新日志", `ops:logs:${source}:${lines}`)
        .text("🛠 运维中心", "show:ops")
        .row()
        .text("⬅️ 主菜单", "show:menu"),
    )
  }

  async #handleOpsCallback(
    chatId: number,
    action: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<void> {
    if (action === "diag") {
      await answer("正在诊断…")
      this.#offLoop(chatId, "诊断", () => this.#handleDiagnostics(chatId))
      return
    }
    if (action.startsWith("logs:")) {
      const [, source = "bot", rawLines = "80"] = action.split(":")
      await answer()
      this.#offLoop(chatId, "日志", () => this.#handleLogs(chatId, `${source} ${rawLines}`))
      return
    }
    if (action === "restart") {
      await answer()
      await this.#confirmRestart(chatId)
      return
    }
    if (action.startsWith("cnl:")) {
      const token = action.slice("cnl:".length)
      const pending = this.#opsPending.get(token)
      if (pending && pending.chatId !== chatId) {
        await answer("该按钮不属于当前会话")
        return
      }
      // A declined restart/update must not stay executable until its TTL expires
      this.#opsPending.delete(token)
      await answer("已取消")
      await this.#sendTextMessage(
        chatId,
        "🚫 已取消，未执行任何操作。",
        new InlineKeyboard().text("🛠 运维中心", "show:ops"),
      )
      return
    }
    if (action.startsWith("cfm:")) {
      const token = action.slice("cfm:".length)
      const pending = this.#opsPending.get(token)
      if (!pending || Date.now() - pending.createdAt > OPS_CONFIRM_TTL_MS) {
        this.#opsPending.delete(token)
        await answer("操作已过期，请重新发起")
        await this.#sendTextMessage(chatId, "⌛ 该确认按钮已过期或已被使用，请重新发起操作。")
        return
      }
      if (pending.chatId !== chatId) {
        await answer("该按钮不属于当前会话")
        return
      }
      this.#opsPending.delete(token)
      await answer()
      await this.#runOpsConfirm(chatId, pending.kind)
      return
    }
    if (action === "update") {
      await answer()
      await this.#confirmUpdate(chatId)
      return
    }
    if (action === "check") {
      await answer("开始检查…")
      void this.#runOpsAction(chatId, "运行检查", () => this.#ops.runCheck())
      return
    }
    if (action === "checkup") {
      await answer("正在检查更新…")
      void this.#runOpsAction(chatId, "检查更新", () => this.#ops.checkUpdate())
      return
    }
    if (action === "cc") {
      await answer()
      await this.#confirmCcSwitch(chatId)
      return
    }
    if (action === "svc") {
      await answer()
      await this.#sendPanel(chatId, await this.#servicePanel())
      return
    }
    if (action === "svc:start") {
      await answer("正在启动…")
      void this.#runOpsAction(chatId, "启动 OpenCode", () => this.#ops.startOpencode())
      return
    }
    if (action === "svc:stop") {
      await answer()
      await this.#confirmServiceAction(chatId, "stop")
      return
    }
    if (action === "svc:restart") {
      await answer()
      await this.#confirmServiceAction(chatId, "restart")
      return
    }
    if (action === "env") {
      await answer()
      await this.#sendPanel(chatId, this.#envPanel())
      return
    }
    await answer()
  }

  async #requestOpsConfirm(chatId: number, kind: OpsConfirmKind, body: string): Promise<void> {
    const now = Date.now()
    for (const [token, pending] of this.#opsPending) {
      if (now - pending.createdAt > OPS_CONFIRM_TTL_MS) this.#opsPending.delete(token)
    }
    const token = randomBytes(6).toString("hex")
    this.#opsPending.set(token, { chatId, kind, createdAt: now })
    await this.#sendTextMessage(
      chatId,
      body,
      new InlineKeyboard().text("✅ 确认执行", `ops:cfm:${token}`).text("取消", `ops:cnl:${token}`),
    )
  }

  async #runOpsConfirm(chatId: number, kind: OpsConfirmKind): Promise<void> {
    const blockedByTasks = "⚠️ 当前有任务正在执行，请先发送 `/stop` 再操作。"
    switch (kind) {
      case "restart":
        if (this.#ops.systemd) {
          await this.#confirmRestart(chatId)
          return
        }
        if (this.#runningSince.size > 0) {
          await this.#sendTextMessage(chatId, blockedByTasks)
          return
        }
        void this.#runOpsAction(chatId, "重启 Bot", () => this.#ops.restartBot())
        return
      case "update":
        void this.#runOpsAction(chatId, "更新项目", () => this.#ops.updateProject())
        return
      case "cc-install":
        void this.#runOpsAction(chatId, "安装 cc-switch", () => this.#ops.installCcSwitch(false))
        return
      case "cc-update":
        void this.#runOpsAction(chatId, "更新 cc-switch", () => this.#ops.installCcSwitch(true))
        return
      case "svc-stop":
        if (this.#runningSince.size > 0) {
          await this.#sendTextMessage(chatId, blockedByTasks)
          return
        }
        void this.#runOpsAction(chatId, "停止 OpenCode", () => this.#ops.stopOpencode())
        return
      case "svc-restart":
        if (this.#runningSince.size > 0) {
          await this.#sendTextMessage(chatId, blockedByTasks)
          return
        }
        void this.#runOpsAction(chatId, "重启 OpenCode", () => this.#ops.restartOpencode())
        return
    }
  }

  async #runOpsAction(chatId: number, label: string, action: () => Promise<OpsResult>): Promise<void> {
    if (this.#opsRunning) {
      await this.#sendTextMessage(chatId, `⏳ 正在执行「${escapeMarkdown(this.#opsRunning)}」，请稍后再试。`)
      return
    }
    this.#opsRunning = label
    const restarting = label.includes("重启 Bot")
    try {
      await this.#sendTextMessage(chatId, `⏳ 正在${escapeMarkdown(label)}…`)
      const result = await action()
      this.#log.info(`ops ${label}: ${result.ok ? "ok" : "failed"}`)
      await this.#sendOpsResult(chatId, result)
      if (!restarting) await this.#sendPanel(chatId, await this.#opsPanel())
    } catch (err) {
      const detail = redactSecrets((err as Error).message)
      this.#log.error(`ops ${label} failed:`, this.#maskToken(detail))
      await this.#sendTextMessage(chatId, `❌ ${escapeMarkdown(label)}失败：${escapeMarkdown(detail)}`)
    } finally {
      this.#opsRunning = ""
    }
  }

  async #sendOpsResult(chatId: number, result: OpsResult): Promise<void> {
    let text = `${result.ok ? "✅" : "❌"} ${escapeMarkdown(redactSecrets(result.message))}`
    for (const step of result.steps) {
      text += `\n\n${step.ok ? "✅" : "❌"} ${escapeMarkdown(step.label)}${
        step.code !== null ? `（退出码 ${step.code}）` : ""
      }`
      if (step.output) {
        // Command output can echo env vars (npm/git failures), so scrub it before sending
        text += `\n\`\`\`\n${redactSecrets(step.output).replace(/```/g, "'''")}\n\`\`\``
      }
    }
    for (const chunk of splitMessage(text, 3800)) {
      await this.#sendTextMessage(chatId, chunk)
    }
  }

  async #confirmRestart(chatId: number): Promise<void> {
    if (this.#ops.systemd) {
      await this.#sendTextMessage(
        chatId,
        "ℹ️ 当前 Bot 由 systemd 管理，Bot 不会执行脚本重启。\n请运行 `sudo systemctl restart telegram-bot`（或你的服务名）。",
      )
      return
    }
    if (this.#runningSince.size > 0) {
      await this.#sendTextMessage(chatId, "⚠️ 当前有任务正在执行，请先发送 `/stop` 再重启，避免丢失回复。")
      return
    }
    await this.#requestOpsConfirm(
      chatId,
      "restart",
      "🔄 *确认重启 Bot？*\n\n会在数秒内完成构建产物重启，期间 Bot 短暂离线。\n" +
        "如果正在执行任务，请先发送 `/stop`。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  async #confirmUpdate(chatId: number): Promise<void> {
    await this.#requestOpsConfirm(
      chatId,
      "update",
      "⬆️ *确认更新项目？*\n\n将依次执行：\n" +
        "1. `git status --porcelain`：工作区有未提交改动会直接中止\n" +
        "2. `git pull --ff-only`\n" +
        "3. `npm install --no-audit --no-fund`\n" +
        "4. `npm run build`\n\n" +
        "更新不会自动重启，完成后可点击「重启 Bot」。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  async #confirmCcSwitch(chatId: number): Promise<void> {
    let installed = false
    try {
      installed = Boolean((await this.#ops.diagnostics()).ccSwitch)
    } catch {
      installed = false
    }
    await this.#requestOpsConfirm(
      chatId,
      installed ? "cc-update" : "cc-install",
      `🔌 *${installed ? "更新" : "安装"} cc-switch CLI？*\n\n` +
        "将运行 `scripts/install-cc-switch.sh` 下载对应平台的二进制到 `./bin/cc-switch`。" +
        (installed ? "\n已有版本会被覆盖（`--force`）。" : "") +
        "\n下载需要网络；已启用的代理会自动生效。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  async #servicePanel(): Promise<Panel> {
    let status: { reachable: boolean; managed: boolean; pid?: number; url: string }
    try {
      status = await this.#ops.opencodeStatus()
    } catch {
      status = { reachable: false, managed: false, url: this.#cfg.opencode.url }
    }
    const state = status.reachable ? "🟢 运行中" : "🔴 未运行"
    const managed = status.pid
      ? `由 Bot 托管（PID ${status.pid}）`
      : status.reachable
        ? "运行中，但未由 Bot 托管"
        : "未运行"
    return {
      text:
        `⚡ *OpenCode 服务*\n\n• 状态：${state}\n• 托管：${managed}\n• URL：\`${escapeMarkdown(status.url)}\`\n\n` +
        "Bot 只会停止由自己启动的 OpenCode（通过 `data/opencode.pid` 识别），不会误杀手动启动的进程。",
      keyboard: new InlineKeyboard()
        .text("▶️ 启动", "ops:svc:start")
        .text("🔄 重启", "ops:svc:restart")
        .row()
        .text("⏹ 停止", "ops:svc:stop")
        .text("📜 日志", "ops:logs:opencode:80")
        .row()
        .text("🔄 刷新", "ops:svc")
        .text("🛠 运维中心", "show:ops")
        .row()
        .text("⬅️ 主菜单", "show:menu"),
    }
  }

  async #handleServiceCommand(chatId: number, arg: string): Promise<void> {
    const tokens = arg.split(/\s+/).filter(Boolean)
    let action = (tokens[0] ?? "").toLowerCase()
    if (action === "opencode") action = (tokens[1] ?? "").toLowerCase()
    if (!action || action === "status") {
      await this.#sendPanel(chatId, await this.#servicePanel())
      return
    }
    if (action === "start") {
      void this.#runOpsAction(chatId, "启动 OpenCode", () => this.#ops.startOpencode())
      return
    }
    if (action === "stop") {
      await this.#confirmServiceAction(chatId, "stop")
      return
    }
    if (action === "restart") {
      await this.#confirmServiceAction(chatId, "restart")
      return
    }
    await this.#sendTextMessage(
      chatId,
      "用法：`/service opencode start|stop|restart`，或发送 `/service` 打开面板。",
    )
  }

  async #confirmServiceAction(chatId: number, action: "stop" | "restart"): Promise<void> {
    if (this.#runningSince.size > 0) {
      await this.#sendTextMessage(chatId, "⚠️ 当前有任务正在执行，请先发送 `/stop` 再操作 OpenCode 服务。")
      return
    }
    const verb = action === "stop" ? "停止" : "重启"
    await this.#requestOpsConfirm(
      chatId,
      action === "stop" ? "svc-stop" : "svc-restart",
      `⚡ *确认${verb} OpenCode？*\n\n${verb}期间所有依赖 OpenCode 的任务都会失败。\n` +
        "只会操作由 Bot 启动的实例；手动启动的实例会被拒绝。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  #envPanel(): Panel {
    const list = this.#ops.envList()
    const mapping = new Map(list.entries.map((entry) => [entry.key, entry]))
    const hidden = list.entries.filter((entry) => entry.secret).length
    const lines = OPS_ENV_KEYS.map((key) => {
      const entry = mapping.get(key)
      const shown = !entry ? "_未设置_" : entry.secret ? "***" : entry.value ? `\`${escapeMarkdown(entry.value)}\`` : "（空）"
      return `• \`${key}\` = ${shown} — ${escapeMarkdown(OPS_ENV_RULES[key]?.hint ?? "")}`
    })
    return {
      text:
        "⚙️ *配置项*\n\n" +
        `\`.env\`：${list.exists ? "已加载" : "不存在"}${hidden > 0 ? ` · 已隐藏 ${hidden} 个密钥类配置` : ""}\n\n` +
        `${lines.join("\n")}\n\n` +
        "修改：`/env set KEY VALUE`\n删除：`/env unset KEY`\n\n" +
        "_只允许修改上表中的非密钥配置；Telegram Token、API Key、密码等永远不会显示或修改。重启 Bot 后生效。_",
      keyboard: new InlineKeyboard()
        .text("🔄 刷新", "ops:env")
        .text("📜 日志", "ops:logs:bot:80")
        .row()
        .text("🛠 运维中心", "show:ops")
        .text("⬅️ 主菜单", "show:menu"),
    }
  }

  async #handleEnvCommand(chatId: number, arg: string): Promise<void> {
    const [rawAction = "", rawKey = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    const action = rawAction.toLowerCase()
    if (!action || action === "list" || action === "show") {
      await this.#sendPanel(chatId, this.#envPanel())
      return
    }
    if (action === "set") {
      if (!rawKey || rest.length === 0) {
        await this.#sendTextMessage(chatId, "用法：`/env set KEY VALUE`，例如 `/env set LOG_LEVEL debug`。")
        return
      }
      const result = this.#ops.envSet(rawKey, rest.join(" "))
      if (result.ok) this.#applyLiveEnv(rawKey.trim().toUpperCase(), rest.join(" ").trim())
      await this.#sendTextMessage(chatId, `${result.ok ? "✅" : "❌"} ${escapeMarkdown(result.message)}`)
      if (result.ok) await this.#sendPanel(chatId, this.#envPanel())
      return
    }
    if (action === "unset" || action === "del" || action === "delete") {
      if (!rawKey) {
        await this.#sendTextMessage(chatId, "用法：`/env unset KEY`。")
        return
      }
      const result = this.#ops.envUnset(rawKey)
      await this.#sendTextMessage(chatId, `${result.ok ? "✅" : "❌"} ${escapeMarkdown(result.message)}`)
      if (result.ok) await this.#sendPanel(chatId, this.#envPanel())
      return
    }
    await this.#sendTextMessage(
      chatId,
      "用法：`/env` 查看配置；`/env set KEY VALUE` 修改；`/env unset KEY` 删除。",
    )
  }

  /** Some .env keys can be honoured by the running process, so the user does not have to restart. */
  #applyLiveEnv(key: string, value: string): void {
    if (key === "REMINDER_TIMEZONE") {
      this.#timezone = value
      this.#reminders.setTimeZone(value)
      this.#schedules.setTimeZone(value)
      this.#usage.setTimeZone(value)
      return
    }
    if (key === "TELEGRAM_ALLOW_USERS") {
      const ids = parseAllowUsers(value)
      // An empty list would lock everyone out; config.ts refuses to start with one, so
      // the running bot keeps its current gate instead of diverging from the file.
      if (ids.length === 0 && !this.#cfg.telegram.allowAll) return
      const users = this.#cfg.telegram.allowUsers
      users.clear()
      for (const id of ids) users.add(id)
      this.#log.info(`access whitelist now ${users.size} user(s): ${[...users].join(",")}`)
    }
  }

  /** The Telegram user whitelist, editable from the chat instead of by editing `.env`. */
  #accessPanel(headline?: string): Panel {
    const ids = parseAllowUsers([...this.#cfg.telegram.allowUsers].join(","))
    const keyboard = new InlineKeyboard()
    for (const id of ids.slice(0, 12)) {
      keyboard.text(`❌ ${id}`, `access:del:${id}`).row()
    }
    keyboard.text("🔄 刷新", "show:access").row()
    keyboard.text("🛠 运维中心", "show:ops").text("⬅️ 主菜单", "show:menu")

    const listCap = 60
    const list = ids.length > 0 ? ids.slice(0, listCap).map((id) => `• \`${escapeMarkdown(id)}\``).join("\n") : "_（空白名单）_"
    const listMore = ids.length > listCap ? `\n_…另有 ${ids.length - listCap} 个未显示。_` : ""
    const overflow = ids.length > 12 ? `\n_…另有 ${ids.length - 12} 个未显示按钮，可用 \`/access del <ID>\` 移除。_` : ""
    const gate = this.#cfg.telegram.allowAll
      ? "⚠️ `TELEGRAM_ALLOW_ALL_USERS` 已开启：任何 Telegram 用户都能驱动 Bot 与运维操作，建议尽快关闭。"
      : "✅ 仅白名单用户可用，且只响应私聊。"

    return {
      text:
        `${headline ? `${headline}\n\n` : ""}🔐 *访问白名单*（${ids.length}）\n\n${list}${listMore}${overflow}\n\n${gate}\n\n` +
        "添加：`/access add <用户 ID>`\n移除：`/access del <用户 ID>` 或点击上方按钮\n\n" +
        "_让对方发送 `/start` 给 Bot：被拒回复里会显示他的数字 ID。改动写入 `.env` 并立即生效，无需重启。_",
      keyboard,
    }
  }

  async #handleAccessCommand(chatId: number, userId: number, arg: string): Promise<void> {
    const [rawAction = "list", ...rest] = arg.split(/\s+/).filter(Boolean)
    const action = rawAction.toLowerCase()

    if (action === "list" || action === "show") {
      await this.#sendPanel(chatId, this.#accessPanel())
      return
    }
    if (action !== "add" && action !== "del" && action !== "delete" && action !== "remove") {
      await this.#sendTextMessage(
        chatId,
        "用法：`/access` 查看白名单；`/access add <用户 ID>` 添加；`/access del <用户 ID>` 移除。",
      )
      return
    }

    const wanted = rest.map((token) => token.replace(/^@/, ""))
    if (wanted.length === 0) {
      await this.#sendTextMessage(chatId, "用法：`/access add <用户 ID>` 或 `/access del <用户 ID>`。")
      return
    }
    const invalid = wanted.filter((token) => !USER_ID_RE.test(token))
    if (invalid.length > 0) {
      await this.#sendTextMessage(
        chatId,
        `❌ 用户 ID 只能是 20 位以内的数字（收到：${escapeMarkdown(invalid.join("、"))}）。`,
      )
      return
    }

    const result = this.#mutateAccess(action === "add", wanted, userId)
    if (!result.ok) {
      await this.#sendTextMessage(chatId, `❌ ${escapeMarkdown(result.message)}`)
      return
    }
    await this.#sendTextMessage(chatId, result.message)
    await this.#sendPanel(chatId, this.#accessPanel())
  }

  /** Shared by /access, its remove buttons and the HTTP API so the guards cannot drift. */
  #mutateAccess(adding: boolean, wanted: string[], self: number | undefined): { ok: boolean; message: string } {
    const tokens = wanted.map((token) => token.replace(/^@/, ""))
    if (tokens.length === 0) return { ok: false, message: "请提供用户 ID。" }
    const invalid = tokens.filter((token) => !USER_ID_RE.test(token))
    if (invalid.length > 0) {
      return { ok: false, message: `用户 ID 只能是 20 位以内的数字（收到：${invalid.join("、")}）。` }
    }
    const current = new Set(this.#cfg.telegram.allowUsers)
    const touched = tokens.filter((id) => (adding ? !current.has(id) : current.has(id)))
    if (touched.length === 0) {
      return { ok: false, message: adding ? "这些用户已经在白名单中。" : "这些用户不在白名单中。" }
    }
    const next = new Set(current)
    for (const id of touched) {
      if (adding) next.add(id)
      else next.delete(id)
    }
    if (!adding) {
      const rejection = this.#allowListRejection(next, String(self ?? ""))
      if (rejection) return { ok: false, message: rejection }
    }
    const value = sortUserIds(next).join(",")
    const result = this.#ops.envSet("TELEGRAM_ALLOW_USERS", value, true)
    if (!result.ok) return { ok: false, message: result.message }
    this.#applyLiveEnv("TELEGRAM_ALLOW_USERS", value)
    const names = touched.join("、")
    return {
      ok: true,
      message: `${adding ? `✅ 已加入白名单：${names}` : `🗑 已移出白名单：${names}`}（当前 ${next.size} 个用户，立即生效）。`,
    }
  }

  /** Snapshot for the app's /access panel. */
  get accessState(): { users: string[]; allowAll: boolean } {
    return {
      users: parseAllowUsers([...this.#cfg.telegram.allowUsers].join(",")),
      allowAll: this.#cfg.telegram.allowAll,
    }
  }

  /** HTTP API counterpart of `/access add`; the owner can never remove themselves. */
  addAccess(ids: string[]): { ok: boolean; message: string } {
    return this.#mutateAccess(true, ids, this.ownerChatId)
  }

  removeAccess(ids: string[]): { ok: boolean; message: string } {
    return this.#mutateAccess(false, ids, this.ownerChatId)
  }

  /** Lockout guards shared by the `/access` command and its remove buttons. */
  #allowListRejection(next: Set<string>, self: string): string | undefined {
    if (this.#cfg.telegram.allowAll) return undefined
    if (!next.has(self) && this.#cfg.telegram.allowUsers.has(self)) {
      return "不能把自己移出白名单，否则你将无法再控制 Bot。"
    }
    if (next.size === 0) return "白名单不能为空：至少保留 1 个用户 ID，或设置 TELEGRAM_ALLOW_ALL_USERS=1。"
    return undefined
  }

  #timezonePanel(headline?: string): string {
    const now = Date.now()
    return [
      headline,
      `🕐 当前时区：\`${escapeMarkdown(this.#timezone)}\``,
      `• 本地时间：${formatDateTime(now, this.#timezone)}`,
      `• 世界标准时间：${formatDateTime(now, "UTC")}`,
      "",
      "提醒、定时任务和每日统计都按这个时区计算。切换后立即生效，无需重启，并会写入 `.env`。",
      "点击下方按钮，或发送 `/timezone America/New_York`（IANA 时区名）。",
    ]
      .filter(Boolean)
      .join("\n")
  }

  async #handleTimeZone(chatId: number, arg: string): Promise<void> {
    const zone = arg.trim()
    if (!zone) {
      const keyboard = new InlineKeyboard()
      for (let offset = 0; offset < TIMEZONE_PRESETS.length; offset += 3) {
        for (const preset of TIMEZONE_PRESETS.slice(offset, offset + 3)) {
          keyboard.text(preset === this.#timezone ? `✅ ${preset}` : preset, `tz:${preset}`)
        }
        keyboard.row()
      }
      await this.#sendTextMessage(chatId, this.#timezonePanel(), keyboard)
      return
    }

    const result = this.#ops.envSet("REMINDER_TIMEZONE", zone)
    if (!result.ok) {
      await this.#sendTextMessage(
        chatId,
        `❌ ${escapeMarkdown(result.message)}\n\n发送 \`/timezone\` 可查看全部常用时区。`,
      )
      return
    }
    this.#applyLiveEnv("REMINDER_TIMEZONE", zone)
    await this.#sendTextMessage(chatId, this.#timezonePanel(`✅ 已切换时区：${zone}`))
  }

  /** `/dir` — the working directory CLI engines start in for this chat. */
  async #handleDirCommand(job: Job, arg?: string): Promise<void> {
    const key = job.key
    const engine = this.#store.getEngine(key)
    const cliNote =
      engine === "opencode" ? "\n_当前引擎是 OpenCode，目录由其服务端决定；该设置只对 CLI 引擎生效。_" : ""

    if (arg === undefined) {
      const panel = this.#dirPanel(key)
      await this.#sendTextMessage(job.chatId, panel.text, panel.keyboard)
      return
    }

    if (/^(reset|default|clear|默认|恢复默认)$/i.test(arg.trim())) {
      if (!this.#store.clearDir(key)) {
        await this.#sendTextMessage(job.chatId, "ℹ️ 本会话没有单独指定工作目录，当前就是 Bot 默认目录。")
        return
      }
      this.#resetCliSessions(key)
      await this.#sendTextMessage(
        job.chatId,
        `↩️ 已恢复默认工作目录 \`${escapeMarkdown(this.#agents.defaultWorkDir)}\`（已重置 CLI 会话上下文）。`,
      )
      return
    }

    // Switching the directory under a running task would split one session across two projects
    if (this.#runningSince.has(key)) {
      await this.#sendTextMessage(job.chatId, "⚠️ 任务执行中，请先发送 `/stop`。")
      return
    }

    const dir = normalizeWorkDirInput(arg, this.#agents.defaultWorkDir, homedir())
    if (!dir) {
      await this.#sendTextMessage(
        job.chatId,
        "❌ 路径无效：不能为空、含控制字符、超过 512 字符，或指向文件系统根目录。",
      )
      return
    }
    let isDirectory: boolean
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch {
      await this.#sendTextMessage(job.chatId, `❌ 目录不存在：\`${escapeMarkdown(dir)}\``)
      return
    }
    if (!isDirectory) {
      await this.#sendTextMessage(job.chatId, `❌ 不是目录：\`${escapeMarkdown(dir)}\``)
      return
    }

    this.#store.setDir(key, dir)
    this.#resetCliSessions(key)
    await this.#sendTextMessage(
      job.chatId,
      `📁 本会话的 CLI 工作目录已设为 \`${escapeMarkdown(dir)}\`（已重置 CLI 会话上下文）。${cliNote}`,
    )
  }

  /** A CLI session belongs to the directory it was created in, so both reset together. */
  #resetCliSessions(key: string): void {
    for (const profile of this.#agents.registry.list()) this.#store.clearCliSession(key, profile.id)
  }

  async #handleModelCommand(job: Job, arg?: string): Promise<void> {
    const engine = this.#store.getEngine(job.key)

    if (engine !== "opencode") {
      if (!arg) {
        await this.#sendPanel(job.chatId, this.#modelPanel(job.key))
        return
      }

      const profile = this.#agents.registry.get(engine)
      if (!profile) {
        await this.#sendTextMessage(job.chatId, `❌ 未知引擎：\`${engine}\``)
        return
      }
      if (!profile.supportsModel) {
        await this.#sendTextMessage(job.chatId, `ℹ️ ${escapeMarkdown(profile.label)} 的模型由 CLI 自身配置，Bot 不支持切换。`)
        return
      }

      const word = arg.trim().toLowerCase()
      // Only a model the profile actually declares may shadow the reset keyword:
      // engines without `strictModels` pass any string through, which would make
      // `/model default` set a model literally named "default" instead of resetting
      const declared = (profile.models ?? []).some(
        (model) =>
          model.id.toLowerCase() === word ||
          model.label.toLowerCase() === word ||
          (model.aliases ?? []).some((alias) => alias.toLowerCase() === word),
      )
      const selectedModel = this.#agents.registry.resolveModel(engine, arg)
      if (!declared && MODEL_DEFAULT_WORDS.has(word)) {
        if (!this.#clearCliModelSelection(job.key, engine)) {
          await this.#sendTextMessage(
            job.chatId,
            `ℹ️ 本会话没有独立的模型选择，当前就是 *${escapeMarkdown(profile.label)}* 的默认模型。`,
          )
          return
        }
        await this.#sendTextMessage(
          job.chatId,
          `↩️ 已取消本会话的模型选择，恢复 *${escapeMarkdown(profile.label)}* 默认模型（已重置会话上下文）。`,
        )
        return
      }

      if (!selectedModel) {
        const hint = profile.models?.map((model) => `\`${model.id}\``).join("、") ?? profile.modelHint
        await this.#sendTextMessage(
          job.chatId,
          `❌ 未识别的模型：\`${arg}\`${hint ? `\n\n可用：${hint}` : ""}`,
        )
        return
      }

      const current = this.#store.getCliModel(job.key, engine) ?? profile.defaultModel
      if (current === selectedModel) {
        await this.#sendTextMessage(
          job.chatId,
          `✅ 当前已经是 *${escapeMarkdown(this.#agents.registry.modelLabel(engine, selectedModel))}*，无需切换，会话上下文保持不变。`,
        )
        return
      }

      this.#applyCliModel(job.key, engine, selectedModel)
      await this.#sendTextMessage(
        job.chatId,
        `✅ *${escapeMarkdown(profile.label)} 模型已切换为：${escapeMarkdown(this.#agents.registry.modelLabel(engine, selectedModel))}* (已开启新会话上下文)`,
      )
      return
    }

    // Handle OpenCode models
    if (!arg) {
      await this.#sendPanel(job.chatId, this.#modelPanel(job.key))
      return
    }

    const targetKey = resolveModelKey(arg)
    const targetModel = targetKey ? AVAILABLE_MODELS[targetKey] : undefined

    // Same rule as the CLI branch: a model really named `auto` stays reachable
    if (!targetModel && MODEL_DEFAULT_WORDS.has(arg.trim().toLowerCase())) {
      await this.#resetOpenCodeModel(job.chatId, job.key)
      return
    }

    if (!targetModel) {
      const valid = Object.keys(AVAILABLE_MODELS).join(", ")
      await this.#sendTextMessage(
        job.chatId,
        `❌ 未识别的模型名称：\`${arg}\`\n\n可选简称有：\`${valid}\`\n发送 \`/model\` 可查看详细列表。`,
      )
      return
    }

    const current = this.#getCurrentModel(job.key)
    if (current.providerID === targetModel.providerID && current.modelID === targetModel.modelID) {
      await this.#sendTextMessage(
        job.chatId,
        `✅ 当前已经是 *${escapeMarkdown(targetModel.label)}*，无需切换，会话上下文保持不变。`,
      )
      return
    }

    await this.#applyOpenCodeModel(job.key, targetModel)
    await this.#sendTextMessage(
      job.chatId,
      `✅ *已成功切换模型！*\n\n当前模型：*${escapeMarkdown(targetModel.label)}*\n_${escapeMarkdown(targetModel.desc)}_\n\n已自动重置会话上下文，你可以直接开始向新模型提问了。`,
    )
  }

  async #applyOpenCodeModel(key: string, target: ModelInfo): Promise<void> {
    this.#store.setModel(key, {
      providerID: target.providerID,
      modelID: target.modelID,
      label: target.label,
    })
    this.#log.info(`model switched [${key}] -> ${target.label} (${target.providerID}/${target.modelID})`)
    await this.#dropSessionForModel(key)
  }

  /** A model change must not carry the previous model's context over. */
  async #dropSessionForModel(key: string): Promise<void> {
    const oldSession = this.#store.get(key)
    if (!oldSession) return
    await this.#oc.deleteSession(oldSession).catch(() => {})
    this.#store.clearSession(key)
  }

  /** Drops the chat's own OpenCode selection and resets its context; false if there was nothing to drop. */
  async #clearOpenCodeModelSelection(key: string): Promise<boolean> {
    const saved = this.#store.getModel(key)
    if (!saved) return false
    this.#store.clearModel(key)
    await this.#dropSessionForModel(key)
    this.#log.info(`model selection cleared [${key}] (was ${saved.providerID}/${saved.modelID})`)
    return true
  }

  async #resetOpenCodeModel(chatId: number, key: string): Promise<void> {
    if (!(await this.#clearOpenCodeModelSelection(key))) {
      await this.#sendTextMessage(
        chatId,
        `ℹ️ 本会话没有独立的模型选择，当前就是默认模型 *${escapeMarkdown(this.#getCurrentModel(key).label)}*。`,
      )
      return
    }
    await this.#sendTextMessage(
      chatId,
      `↩️ 已取消本会话的模型选择，恢复默认模型：*${escapeMarkdown(this.#getCurrentModel(key).label)}*\n（已重置会话上下文，可直接继续提问）`,
    )
  }

  #applyCliModel(key: string, engine: string, model: string): void {
    this.#store.setCliModel(key, engine, model)
    this.#store.clearCliSession(key, engine)
    this.#log.info(`${engine} model switched [${key}] -> ${model}`)
  }

  /** Drops the chat's own CLI model selection and resets its context; false if there was none. */
  #clearCliModelSelection(key: string, engine: string): boolean {
    const saved = this.#store.getCliModel(key, engine)
    if (!saved) return false
    this.#store.setCliModel(key, engine, "")
    this.#store.clearCliSession(key, engine)
    this.#log.info(`${engine} model selection cleared [${key}] (was ${saved})`)
    return true
  }

  #cliModelLabel(engine: string, model: string | undefined): string {
    if (model) return this.#agents.registry.modelLabel(engine, model)
    const profile = this.#agents.registry.get(engine)
    if (!profile) return "CLI 默认"
    return profile.supportsModel ? "CLI 默认" : "CLI 固定"
  }

  #welcomeText(key: string, userId: number): string {
    const engine = this.#store.getEngine(key)
    const model =
      engine === "opencode"
        ? this.#getCurrentModel(key).label
        : this.#cliModelLabel(engine, this.#store.getCliModel(key, engine))
    const detected = this.#agents.registry
      .list()
      .filter((profile) => this.#agents.registry.binPath(profile))
      .map((profile) => profile.label)
    const detectedText =
      detected.length > 0
        ? `${detected.slice(0, 6).map((label) => escapeMarkdown(label)).join("、")}${detected.length > 6 ? ` 等 ${detected.length} 个` : ""}`
        : "无（可使用 OpenCode，或发送 /agents 安装）"
    return (
      `👋 *欢迎使用 AI 私人助手*\n\n• 用户 ID：\`${userId}\`\n` +
      `• 引擎：*${escapeMarkdown(this.#agents.registry.label(engine))}*\n• 模型：*${escapeMarkdown(model)}*\n` +
      `• 本机 Agent CLI：${detectedText}\n\n` +
      `💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务。\n` +
      `☰ 发送 \`/menu\` 打开功能菜单（含 Agent、模型、任务、cc-switch 与运维中心）。\n\n` +
      `*直接发消息即可对话：*\n• 代码编写、分析与调试\n• 发送图片、文件、语音（文本文件会读取内容）\n` +
      `• 发送 \`/remind 30m 喝水\` 设定提醒\n• 发送 \`/schedule add 30m 检查服务器\` 定时执行 AI 任务\n\n` +
      `_仅响应私聊消息。发送 /help 查看帮助，或 /menu 打开功能菜单。_`
    )
  }

  #menuPanel(chatId: number, key: string): Panel {
    const engine = this.#store.getEngine(key)
    const model =
      engine === "opencode"
        ? this.#getCurrentModel(key).label
        : this.#cliModelLabel(engine, this.#store.getCliModel(key, engine))
    const since = this.#runningSince.get(key)
    const pending = this.#pending.get(key)?.length ?? 0
    const running = since ? `运行中 ${formatDuration(Date.now() - since)}` : "空闲"
    const reminders = this.#reminders.list(chatId).length
    const schedules = this.#schedules.count(chatId)
    const today = this.#usage.summary(key).today.tasks
    return {
      text:
        `🤖 *功能菜单*\n\n` +
        `• 引擎：*${escapeMarkdown(this.#agents.registry.label(engine))}*\n` +
        `• 模型：*${escapeMarkdown(model)}*\n` +
        `• 状态：${running} · 今日 ${today} 条\n` +
        `• 提醒 ${reminders} · 定时 ${schedules} · 队列 ${pending}\n\n` +
        `直接发送消息即可对话，或点击下方按钮进入功能区。`,
      keyboard: this.#menuKeyboard(),
    }
  }

  #menuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🤖 Agent 引擎", "show:agent")
      .text("🧠 模型", "show:model")
      .row()
      .text("🗓 定时任务", "show:schedule")
      .text("⏰ 提醒", "show:reminders")
      .row()
      .text("📊 运行状态", "show:status")
      .text("📈 使用统计", "show:usage")
      .row()
      .text("📋 任务队列", "show:queue")
      .text("🕘 任务历史", "show:history")
      .row()
      .text("📦 Agent CLI", "show:agents")
      .text("🔌 cc-switch", "show:cc")
      .row()
      .text("🌐 网络代理", "show:proxy")
      .text("🛠 运维中心", "show:ops")
      .row()
      .text("🕐 时区", "tz:")
      .text("❓ 帮助", "show:help")
  }

  #agentInstallerPanel(): Panel {
    const profiles = this.#agents.registry.list()
    const installed = profiles.filter((profile) => this.#agents.registry.binPath(profile))
    const installable = profiles.filter((profile) => profile.installSpec && !this.#agents.registry.binPath(profile))
    const manual = profiles.filter((profile) => !profile.installSpec && !this.#agents.registry.binPath(profile))
    const managed = this.#agentInstaller.managed()

    const keyboard = new InlineKeyboard()
    installable.slice(0, 10).forEach((profile, index) => {
      keyboard.text(clip(`⬇️ ${profile.label}`, 60) ?? profile.label, `areq:install:${profile.id}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (installable.slice(0, 10).length % 2 === 1) keyboard.row()
    managed.slice(0, 10).forEach((record) => {
      const label = this.#agents.registry.get(record.engine)?.label ?? record.engine
      keyboard.text(clip(`🔄 ${label}`, 60) ?? label, `areq:update:${record.engine}`)
      keyboard.text(clip(`🗑 ${label}`, 60) ?? label, `areq:uninstall:${record.engine}`)
      keyboard.row()
    })
    keyboard.text("🤖 选择引擎", "show:agent").text("🔄 刷新", "show:agents")
    keyboard.row().text("⬅️ 主菜单", "show:menu")

    const commandLines = installable
      .slice(0, 6)
      .map((profile) => `• ${escapeMarkdown(profile.label)}：\`${this.#agentInstaller.installCommand(profile) ?? ""}\``)
      .join("\n")
    const manualLabels = manual.slice(0, 8).map((profile) => escapeMarkdown(profile.label)).join("、")
    const installedLine =
      this.#joinLabels(installed.map((profile) => escapeMarkdown(profile.label))) || "无"
    const managedLine =
      managed.length > 0
        ? `• 🔄 Bot 托管：${this.#joinLabels(
            managed.map((record) => escapeMarkdown(this.#agents.registry.get(record.engine)?.label ?? record.engine)),
          )}（可更新或卸载）\n`
        : ""
    return {
      text:
        `📦 *Agent CLI 管理*\n\n` +
        `💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务能力最完整。\n\n` +
        `🖥 *本机已检测到*：${installedLine}\n` +
        managedLine +
        (installable.length > 0
          ? `\n⬇️ *可自动安装（npm/pip）*：\n${commandLines}${installable.length > 6 ? `\n_另有 ${installable.length - 6} 个，见下方按钮。_` : ""}\n`
          : "\n✅ 所有内置 npm/pip CLI 均已安装。\n") +
        (manualLabels ? `\n🛠 *需手动安装*：${manualLabels}${manual.length > 8 ? " 等" : ""}\n` : "") +
        `\n_仅能卸载由 Bot 安装的 CLI；系统预装版本请手动管理。_`,
      keyboard,
    }
  }

  /** `/dir` view: where CLI engines start for this chat, with a one-tap reset. */
  #dirPanel(key: string): Panel {
    const engine = this.#store.getEngine(key)
    const custom = this.#store.getDir(key)
    const effective = this.#agents.workDir(key)
    return {
      text:
        `📁 *CLI 工作目录*\n\n` +
        `• 本会话：\`${escapeMarkdown(effective)}\`（${custom ? "已单独指定" : "Bot 默认"}）\n` +
        `• Bot 默认：\`${escapeMarkdown(this.#agents.defaultWorkDir)}\`\n` +
        (custom && effective !== custom ? "• ⚠️ 指定目录当前不可用，已回退到默认目录\n" : "") +
        `• 当前引擎：*${escapeMarkdown(this.#agents.registry.label(engine))}*\n` +
        (engine === "opencode" ? "\n_OpenCode 的目录由其服务端决定，该设置只对 CLI 引擎生效。_\n" : "") +
        "\n_发送 `/dir <路径>` 切换（支持 `~` 与相对路径），切换会重置该会话的 CLI 上下文。_",
      keyboard: new InlineKeyboard()
        .text("↩️ 恢复默认目录", "dir:reset")
        .text("🤖 切换引擎", "show:agent")
        .row()
        .text("⬅️ 主菜单", "show:menu"),
    }
  }

  /** Joins escaped labels for one line, folding the rest into a count so the panel stays under the message limit. */
  #joinLabels(labels: string[], budget = 400): string {
    let text = ""
    let shown = 0
    for (const label of labels) {
      const next = text ? `${text}、${label}` : label
      if (next.length > budget) break
      text = next
      shown += 1
    }
    if (!text) return ""
    return shown < labels.length ? `${text} 等 ${labels.length} 个` : text
  }

  #agentPanel(key: string): Panel {
    const current = this.#store.getEngine(key)
    const profiles = this.#agents.registry.list()
    const entries = [
      { id: "opencode", label: "OpenCode", desc: "多模型、工具调用、附件收发", installed: true, profile: undefined },
      ...profiles.map((profile: AgentCliProfile) => ({
        id: profile.id,
        label: profile.label,
        desc: profile.desc,
        installed: Boolean(this.#agents.registry.binPath(profile)),
        profile,
      })),
    ].sort((a, b) => Number(b.installed) - Number(a.installed))

    const keyboard = new InlineKeyboard()
    entries.slice(0, 30).forEach((entry, index) => {
      const mark = entry.id === current ? "✅ " : entry.installed ? "" : "⚠️ "
      keyboard.text(clip(`${mark}${entry.label}`, 60) ?? "", `agent:${entry.id}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (entries.slice(0, 30).length % 2 === 1) keyboard.row()
    keyboard.text("🧠 选择模型", "show:model").text("📦 安装 / 卸载", "show:agents")
    keyboard.row().text("📁 工作目录", "show:dir").text("🔄 刷新", "show:agent").text("⬅️ 主菜单", "show:menu")

    const installed = entries.filter((entry) => entry.installed).map((entry) => escapeMarkdown(entry.label))
    const installedLine = this.#joinLabels(installed)
    const missing = entries.filter((entry) => !entry.installed).length
    const currentLabel = this.#agents.registry.label(current)
    const managed = this.#agentInstaller.managed().length
    return {
      text:
        `🤖 *Agent 引擎*\n\n当前：*${escapeMarkdown(currentLabel)}*\n\n` +
        `• 已检测到：${installedLine || "无"}\n` +
        (current === "opencode"
          ? ""
          : `• 📁 工作目录：\`${escapeMarkdown(this.#agents.workDir(key))}\`（\`/dir\` 可修改）\n`) +
        (missing > 0 ? `• ⚠️ ${missing} 个引擎未安装，可点「安装 / 卸载」或发送 \`/agents\`。\n` : "") +
        (managed > 0 ? `• 📦 Bot 托管：${managed} 个（可在 \`/agents\` 中更新或卸载）\n` : "") +
        (entries.length > 30 ? `• 另有 ${entries.length - 30} 个引擎可用 \`/agent <id>\` 切换。\n` : "") +
        `\n💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务。\n` +
        `\n点击下方按钮切换，或发送 \`/agent <id>\`。`,
      keyboard,
    }
  }

  #modelPanel(key: string): Panel {
    const engine = this.#store.getEngine(key)
    if (engine !== "opencode") {
      const profile = this.#agents.registry.get(engine)
      if (!profile) {
        return {
          text: `🧠 *模型*\n\n未知引擎：\`${escapeMarkdown(engine)}\``,
          keyboard: new InlineKeyboard().text("🤖 切换引擎", "show:agent").text("⬅️ 主菜单", "show:menu"),
        }
      }

      const current = this.#store.getCliModel(key, engine) ?? profile.defaultModel
      const keyboard = new InlineKeyboard()
      if (profile.supportsModel && profile.models?.length) {
        profile.models.slice(0, 30).forEach((model, index) => {
          const mark = current === model.id ? "✅ " : ""
          keyboard.text(clip(`${mark}${model.label}`, 60) ?? "", `cmodel:${engine}:${index}`)
          if (index % 2 === 1) keyboard.row()
        })
        if (profile.models.slice(0, 30).length % 2 === 1) keyboard.row()
      }
      if (this.#store.getCliModel(key, engine)) {
        keyboard.text("↩️ 恢复默认模型", `cmodelreset:${engine}`).row()
      }
      keyboard.text("🤖 切换引擎", "show:agent").text("🔄 刷新", "show:model")
      keyboard.row().text("⬅️ 主菜单", "show:menu")

      const modelLine = profile.supportsModel
        ? this.#cliModelLabel(engine, current)
        : "由 CLI 自身配置"
      const hint = profile.supportsModel
        ? profile.models?.length
          ? `\n\n也可发送 \`/model <模型ID>\` 直接指定${profile.modelHint ? `（如 \`${profile.modelHint}\`）` : ""}。`
          : `\n\n该引擎支持任意模型 ID，发送 \`/model <模型ID>\` 切换。${profile.modelHint ? `\n示例：\`${profile.modelHint}\`` : ""}`
        : "\n\n该引擎不支持通过 Bot 切换模型，请在 CLI 配置中设置。"
      return {
        text:
          `🧠 *${escapeMarkdown(profile.label)} 模型*\n\n当前：*${escapeMarkdown(modelLine)}*\n` +
          `\n切换后会重置当前引擎的会话上下文。${hint}`,
        keyboard,
      }
    }

    reloadCustomModels()
    const current = this.#getCurrentModel(key)
    const currentInfo = Object.values(AVAILABLE_MODELS).find(
      (item) => item.providerID === current.providerID && item.modelID === current.modelID,
    )
    const keyboard = new InlineKeyboard()
    const entries = Object.entries(AVAILABLE_MODELS)
    const limit = 40
    let models = entries.slice(0, limit)
    if (entries.length > limit) {
      const currentIndex = entries.findIndex(
        ([, info]) => info.providerID === current.providerID && info.modelID === current.modelID,
      )
      if (currentIndex >= limit) models = [...entries.slice(0, limit - 1), entries[currentIndex]!]
    }
    models.forEach(([modelKey, info], index) => {
      const isCurrent = info.providerID === current.providerID && info.modelID === current.modelID
      keyboard.text(clip(`${isCurrent ? "✅ " : ""}${info.label}`, 60) ?? "", `model:${modelKey}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (models.length % 2 === 1) keyboard.row()
    if (this.#store.getModel(key)) {
      keyboard.text("↩️ 恢复默认模型", "model:reset").row()
    }
    keyboard.text("🔌 模型管理", "cc:model").text("🤖 切换引擎", "show:agent")
    keyboard.row().text("🔄 刷新", "show:model").text("⬅️ 主菜单", "show:menu")
    const hidden =
      entries.length > models.length ? `\n_另有 ${entries.length - models.length} 个模型未显示，可用 \`/model 简称\` 直接切换。_` : ""
    const text =
      `🧠 *OpenCode 模型*\n\n当前：*${escapeMarkdown(current.label)}*` +
      `${currentInfo ? `\n_${escapeMarkdown(currentInfo.desc)}_` : ""}\n\n` +
      `点击下方按钮切换，或发送 \`/model 简称\`（\`/model default\` 恢复默认）。\n切换后会重置当前会话上下文。${hidden}`
    return { text, keyboard }
  }


  #remindersPanel(chatId: number): Panel {
    const items = this.#reminders.list(chatId)
    if (items.length === 0) {
      return {
        text: "📭 *暂无待触发的提醒*\n\n发送 `/remind 30m 喝水` 即可创建。",
        keyboard: new InlineKeyboard().text("🔄 刷新", "show:reminders").text("⬅️ 主菜单", "show:menu"),
      }
    }

    const now = Date.now()
    const lines: string[] = []
    let length = 0
    let shown = 0
    for (const item of items) {
      const when = formatReminderTime(item.dueAt, this.#timezone)
      const remaining = formatRemaining(item.dueAt - now)
      const repeat = item.repeat ? ` 🔁 ${describeRepeat(item.repeat)}` : ""
      const line = `• #${item.id} ${when}（${remaining}后）${repeat}\n  ${escapeMarkdown(item.text)}`
      if (length + line.length > 3000) break
      lines.push(line)
      length += line.length + 2
      shown += 1
    }
    const more =
      shown < items.length
        ? `\n\n_…另有 ${items.length - shown} 条未显示，可用 \`/cancel 编号\` 取消。_`
        : ""

    const keyboard = new InlineKeyboard()
    items.forEach((item, index) => {
      keyboard.text(`❌ 取消 #${item.id}`, `rcancel:${item.id}`)
      if (index % 2 === 1 && index < items.length - 1) keyboard.row()
    })
    keyboard.row().text("🔄 刷新", "show:reminders").text("⬅️ 主菜单", "show:menu")

    return {
      text: `⏰ *待触发的提醒（${items.length}）*\n\n${lines.join("\n\n")}${more}\n\n点击按钮取消，或发送 \`/cancel 编号\`。`,
      keyboard,
    }
  }

  async #panelFor(which: string, chatId: number, key: string): Promise<Panel | undefined> {
    switch (which) {
      case "menu": return this.#menuPanel(chatId, key)
      case "help": return { text: HELP, keyboard: this.#menuKeyboard() }
      case "agent": return this.#agentPanel(key)
      case "agents": return this.#agentInstallerPanel()
      case "model": return this.#modelPanel(key)
      case "dir": return this.#dirPanel(key)
      case "access": return this.#accessPanel()
      case "reminders": return this.#remindersPanel(chatId)
      case "schedule": return this.#schedulePanel(chatId)
      case "queue": return this.#queuePanel(key)
      case "proxy": return this.#proxyPanel()
      case "usage": return this.#usagePanel(key)
      case "history": return this.#historyPanel(key)
      case "cc": return await this.#ccCommands.panel(chatId)
      case "ops": return await this.#opsPanel()
      case "service": return await this.#servicePanel()
      case "status": return { text: this.#statusText(chatId, key), keyboard: this.#statusKeyboard() }
      default: return undefined
    }
  }

  async #sendPanel(chatId: number, panel: Panel): Promise<void> {
    await this.#sendTextMessage(chatId, panel.text, panel.keyboard)
  }

  /**
   * Runs a panel builder or handler off the grammY update loop. grammY processes
   * updates sequentially, so any subprocess-spanning call awaited inline (ops
   * panels, cc panels, proxy tests, log tails) would park every other chat's
   * /stop and buttons behind it for the whole duration.
   */
  #offLoop(chatId: number, label: string, run: () => Promise<void>): void {
    void run().catch((err: unknown) => {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err))
      this.#log.error(`${label} failed:`, this.#maskToken(detail))
      void this.#sendTextMessage(chatId, `⚠️ ${escapeMarkdown(label)}失败：${escapeMarkdown(this.#maskToken(detail))}`)
    })
  }

  async #editPanel(ctx: Context, panel: Panel): Promise<void> {
    const text = this.#maskToken(panel.text)
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: panel.keyboard })
      return
    } catch (err) {
      if (isMessageNotModified(err)) return
    }
    try {
      await ctx.editMessageText(text, { reply_markup: panel.keyboard })
      return
    } catch (err) {
      if (isMessageNotModified(err)) return
    }
    const chatId = ctx.chat?.id
    if (chatId) await this.#sendPanel(chatId, { text, keyboard: panel.keyboard })
  }

  /** Same edit fallback chain as #editPanel, addressed by explicit message id (used off-loop). */
  async #editPanelRef(chatId: number, messageId: number, panel: Panel): Promise<void> {
    const text = this.#maskToken(panel.text)
    try {
      await this.#bot.api.editMessageText(chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: panel.keyboard,
      })
      return
    } catch (err) {
      if (isMessageNotModified(err)) return
    }
    try {
      await this.#bot.api.editMessageText(chatId, messageId, text, { reply_markup: panel.keyboard })
      return
    } catch (err) {
      if (isMessageNotModified(err)) return
    }
    await this.#sendPanel(chatId, { text, keyboard: panel.keyboard })
  }

  #getCurrentModel(key: string): { providerID: string; modelID: string; label: string } {
    return resolveOpencodeModel(this.#store, this.#cfg.opencode.model, key)
  }

  #isAllowedUser(userId: number): boolean {
    if (this.#cfg.telegram.allowAll) return true
    return this.#cfg.telegram.allowUsers.has(String(userId))
  }

  async #deliverReminder(chatId: number, text: string, reminder?: Reminder): Promise<void> {
    // Reminder bodies are user text: an unescaped * _ ` [ would fail the Markdown parse
    // and lose the formatting of the whole message
    let keyboard: InlineKeyboard | undefined
    if (reminder && !reminder.repeat && reminder.text.length <= 500) {
      // One-shot reminders can be re-armed from the delivery message; repeating ones
      // already have a next occurrence, and long texts would bloat the token cache
      const token = randomBytes(6).toString("hex")
      this.#snoozePending.set(token, { chatId, userId: reminder.userId, text: reminder.text, createdAt: Date.now() })
      this.#pruneSnoozeTokens()
      keyboard = new InlineKeyboard()
        .text("⏰ 10分钟", `snooze:${token}:10`)
        .text("⏰ 1小时", `snooze:${token}:60`)
        .row()
        .text("⏰ 明天这个时候", `snooze:${token}:1440`)
    }
    const ok = await this.#sendTextMessage(chatId, escapeMarkdown(text), keyboard)
    if (!ok) throw new Error("Telegram 发送失败")
  }

  /** Keeps the snooze token cache bounded: 500 entries or 24h, whichever first. */
  #pruneSnoozeTokens(): void {
    const cutoff = Date.now() - 24 * 3_600_000
    for (const [token, pending] of this.#snoozePending) {
      if (pending.createdAt < cutoff || this.#snoozePending.size > 500) this.#snoozePending.delete(token)
    }
  }

  async #handleSnooze(chatId: number, token: string, minutes: number, answer: (text?: string) => Promise<void>): Promise<void> {
    const pending = this.#snoozePending.get(token)
    if (!pending || pending.chatId !== chatId) {
      await answer("该按钮已过期")
      return
    }
    this.#snoozePending.delete(token)
    try {
      const reminder = this.#reminders.snooze(chatId, pending.userId, pending.text, minutes)
      this.#snoozePending.delete(token)
      await answer("已安排稍后提醒")
      await this.#sendTextMessage(
        chatId,
        `⏰ 好的，${escapeMarkdown(describeRemainingLabel(minutes))}后再提醒你：${escapeMarkdown(clip(reminder.text, 120) ?? "")}`,
      )
    } catch (err) {
      await answer(err instanceof Error ? err.message : "稍后提醒失败")
    }
  }

  async #executeScheduled(task: ScheduledTask): Promise<UsageOutcome> {
    const key = `tg:${task.chatId}`
    const repeat = task.repeat ? `（${describeRepeat(task.repeat)}）` : ""
    this.#log.info(`scheduled task #${task.id} dispatching [${key}] (${scheduleTargetLabel(task, this.#agents.registry)})`)
    await this.#sendTextMessage(
      task.chatId,
      `🗓 *定时任务 #${task.id} 已触发*${repeat}\n` +
        `• 引擎：${escapeMarkdown(scheduleTargetLabel(task, this.#agents.registry))}\n` +
        `• 提示词：${escapeMarkdown(clip(task.prompt, 120) ?? "")}\n\n正在执行…`,
    )

    const outcome = await new Promise<UsageOutcome>((resolve) => {
      void this.#dispatch({
        key,
        text: task.prompt,
        chatId: task.chatId,
        userId: task.userId,
        generation: this.#generation.get(key) ?? 0,
        scheduled: true,
        engine: task.engine,
        model: task.model ? { ...task.model } : undefined,
        cliModel: task.cliModel,
        onOutcome: resolve,
      }).catch(() => resolve("failed"))
    })

    if (outcome === "cancelled") {
      await this.#sendTextMessage(
        task.chatId,
        task.repeat
          ? `⏹ 定时任务 #${task.id} 本次被 \`/stop\` 取消，计划已保留并按原定周期继续。`
          : `⏹ 定时任务 #${task.id} 被 \`/stop\` 取消，已自动暂停以免丢失。恢复：\`/schedule resume ${task.id}\`；立即执行：\`/schedule run ${task.id}\`。`,
      )
    }
    return outcome
  }

  /** redactSecrets does not know the Telegram token shape, so mask it separately. */
  #maskToken(text: string): string {
    const token = this.#cfg.telegram.token
    return token && text.includes(token) ? text.split(token).join("***") : text
  }

  async #sendTextMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    const markup = keyboard && keyboard.inline_keyboard.length > 0 ? keyboard : undefined
    const safe = this.#maskToken(text)
    try {
      await this.#bot.api.sendMessage(chatId, safe, { parse_mode: "Markdown", reply_markup: markup })
      return true
    } catch {
      // Graceful fallback to plain text if Markdown parsing fails
      try {
        await this.#bot.api.sendMessage(chatId, safe, { reply_markup: markup })
        return true
      } catch {
        return false
      }
    }
  }

  async #sendReply(job: Job, reply: string): Promise<void> {
    const { parts, dropped } = parseReply(reply || "")
    if (dropped > 0) {
      this.#log.warn(`ignored ${dropped} media directive(s) [${job.key}]`)
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "（模型没有返回内容）" })
    }

    for (const part of parts) {
      if (part.type === "text") {
        const chunks = splitMessage(part.text, Math.min(this.#cfg.maxReplyLength, TELEGRAM_MAX_TEXT))
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i] as string
          if (!(await this.#sendTextMessage(job.chatId, chunk))) {
            await sleep(500)
            if (!(await this.#sendTextMessage(job.chatId, chunk))) {
              this.#log.warn(`failed to deliver reply chunk ${i + 1}/${chunks.length} [${job.key}]`)
            }
          }
          if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS)
        }
      } else {
        await this.#sendMediaPart(job, part)
      }
      await sleep(CHUNK_DELAY_MS)
    }
  }

  async #sendMediaPart(job: Job, part: Extract<ReplyPart, { type: "media" }>): Promise<void> {
    try {
      const media = resolveMedia(part.kind, part.target, this.#cfg.outboxDir, this.#cfg.maxMediaBytes)
      const size = media.size > 0 ? ` ${Math.round(media.size / 1024)}KB` : ""
      this.#log.info(`media [${job.key}] ${part.kind} ${media.name}${size}`)

      let buffer: Buffer | undefined
      if (media.isUrl) {
        buffer = await this.#fetchRemoteMedia(media.target)
      }

      if (part.kind === "image") {
        try {
          if (buffer) {
            await this.#bot.api.sendPhoto(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#bot.api.sendPhoto(job.chatId, new InputFile(media.hostPath))
          }
        } catch (photoErr) {
          this.#log.warn(`sendPhoto failed (${(photoErr as Error).message}), falling back to sendDocument`)
          if (buffer) {
            await this.#bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
          }
        }
      } else if (part.kind === "voice") {
        try {
          if (buffer) {
            await this.#bot.api.sendVoice(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#bot.api.sendVoice(job.chatId, new InputFile(media.hostPath))
          }
        } catch (voiceErr) {
          this.#log.warn(`sendVoice failed (${(voiceErr as Error).message}), falling back to sendDocument`)
          if (buffer) {
            await this.#bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
          }
        }
      } else if (part.kind === "video") {
        try {
          if (buffer) {
            await this.#bot.api.sendVideo(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#bot.api.sendVideo(job.chatId, new InputFile(media.hostPath))
          }
        } catch (videoErr) {
          this.#log.warn(`sendVideo failed (${(videoErr as Error).message}), falling back to sendDocument`)
          if (buffer) {
            await this.#bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
          }
        }
      } else if (part.kind === "file") {
        if (buffer) {
          await this.#bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
        } else if (media.hostPath) {
          await this.#bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
        }
      }
    } catch (err) {
      // The detail is CLI/HTTP text: it can carry Markdown markers and a signed URL
      const detail = escapeMarkdown(redactSecrets(err instanceof Error ? err.message : String(err)))
      this.#log.error(`media failed [${job.key}] ${part.kind}:`, detail)
      await this.#sendTextMessage(job.chatId, `⚠️ ${mediaLabel(part.kind)}发送失败：${detail}`)
    }
  }

  async #fetchRemoteMedia(target: string): Promise<Buffer> {
    let current = target
    for (let hop = 0; ; hop++) {
      const { url, pins } = await assertUrlAllowed(current, this.#cfg.mediaAllowPrivateUrls)
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
      }
      // Re-resolving DNS here would allow a rebinding to an internal host, so a
      // validated hostname is pinned to the addresses that passed the check.
      // Pinning only applies to a direct connection: a proxy resolves the name
      // on its own network, so the private-address check above is the only guard
      // there and a proxy the bot cannot reach (e.g. someone else's) stays unsafe.
      const viaProxy = this.#proxies.dispatcher()
      const pinned = viaProxy || pins.length === 0 ? undefined : new Agent({ connect: { lookup: pinnedLookup(url.hostname, pins) } })
      const dispatcher = viaProxy ?? pinned
      try {
        const res = dispatcher
          ? await undiciFetch(url, {
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(20_000),
              dispatcher,
            })
          : await fetch(url, {
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(20_000),
            })

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location")
          await res.body?.cancel().catch(() => {})
          if (!location || hop >= 3) throw new Error("媒体链接重定向次数过多")
          current = new URL(location, url).toString()
          continue
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          throw new Error(`无法获取远程地址 (HTTP ${res.status}): ${safeMediaTarget(target)}`)
        }
        return await this.#readCappedBody(res)
      } finally {
        if (pinned) await pinned.close().catch(() => {})
      }
    }
  }

  async #readCappedBody(res: {
    headers: { get(name: string): string | null }
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>
        cancel(reason?: unknown): Promise<void>
        releaseLock(): void
      }
    } | null
  }): Promise<Buffer> {
    const limit = this.#cfg.maxMediaBytes
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > limit) {
      throw new Error(`远程文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`)
    }
    if (!res.body) throw new Error("远程响应为空")

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > limit) {
          await reader.cancel().catch(() => {})
          throw new Error(`远程文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  }

  /** The engine-call context handed to the shared callEngine() helper. */
  get #engineDeps(): EngineCallDeps {
    return {
      oc: this.#oc,
      agents: this.#agents,
      store: this.#store,
      log: this.#log,
      opencodeAgent: this.#cfg.opencode.agent ?? "assistant",
      opencodeModel: this.#cfg.opencode.model,
      taskTimeoutMs: this.#cfg.taskTimeoutMs,
      taskMaxTimeoutMs: this.#cfg.taskMaxTimeoutMs,
    }
  }
}
