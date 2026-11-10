import { resolve } from "node:path"
import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy"
import type { Context } from "grammy"
import type { Message } from "grammy/types"
import { type AttachmentDescriptor } from "./attachments.js"
import type { BotConfig, ModelRef } from "./config.js"
import { CcSwitchService, redactSecrets } from "./ccswitch.js"
import { AliasStore } from "./aliases.js"
import { CcCommands, type CcHost } from "./ccCommands.js"
import { MagpieCommands, type MagpieHost } from "./telegramMagpieCommands.js"
import { MagpieService } from "./magpie.js"
import { TaskHistoryStore } from "./history.js"
import { BOT_MENU_COMMANDS, CC_HELP, HELP, HELP_FULL, isBotCommand } from "./help.js"
import type { Logger } from "./logger.js"

export { HELP_FULL }
import { clip, escapeMarkdown, pruneChatState, type Panel } from "./messages.js"
export { pruneChatState }
export { parseProviderAdd } from "./ccCommands.js"
import { ModelAdmin } from "./modelAdmin.js"
import { AgentCliService } from "./agentCli.js"
import { AgentCliInstaller } from "./agentInstaller.js"
import { appVersion } from "./version.js"
import {
  AVAILABLE_MODELS,
  resolveModelKey,
  type ModelInfo,
} from "./models.js"
import { callEngine, type EngineCallDeps } from "./engineCall.js"
import { ChatTaskOutcomeRecorder, chatTaskOutcomeRecorder } from "./telegramTaskOutcome.js"
import { resolveEncKey } from "./api.js"
import { Opencode, type PromptFile } from "./opencode.js"
import { OpsService } from "./ops.js"
import { ProgressTracker } from "./progress.js"
import { ProxyService } from "./proxy.js"
import { describeRepeat, ReminderService, type Reminder } from "./reminders.js"
import { scheduleTargetLabel, ScheduleService, type ScheduledTask } from "./scheduler.js"
import type { BackendEngine, SessionStore } from "./store.js"
import { UsageStore, type UsageOutcome } from "./usage.js"
import { DailyReportService } from "./usageReport.js"
import {
  USER_ID_RE,
  isMessageNotModified,
  nearestMenuCommand,
  sleep,
  startupNoticeText,
} from "./telegramSupport.js"
import { channelOfChatId, sessionKeyForChat, type Channel, type ChannelIdResolver } from "./channelRegistry.js"
import { TelegramStatsPanels } from "./telegramStats.js"
import { TelegramPersonalPanels } from "./telegramPersonalPanels.js"
import { TelegramCorePanels } from "./telegramCorePanels.js"
import { TelegramPersonalCommands } from "./telegramPersonalCommands.js"
import { TelegramModelCommands } from "./telegramModelCommands.js"
import { TelegramOpsCommands } from "./telegramOpsCommands.js"
import { AGENT_ACTION_VERB, AGENT_CONFIRM_TTL_MS, TelegramAgentCommands, type AgentAction } from "./telegramAgentCommands.js"
import { TelegramProxyCommands } from "./telegramProxyCommands.js"
import { FEISHU_OPEN_ID_RE } from "./config.js"
import { TelegramAdminCommands } from "./telegramAdminCommands.js"
import { TelegramAttachments } from "./telegramAttachments.js"
import { TelegramMediaSender } from "./telegramMedia.js"
import { TelegramInfoCommands } from "./telegramInfoCommands.js"
import { ReminderDelivery } from "./telegramReminderDelivery.js"
import type { FeishuApiLike } from "./feishuTypes.js"
import {
  createChannelBot,
  openFeishuAttachmentStream,
  seedFeishuBotInfo,
  isUserAllowed,
  resolveOwnerChatId,
  resolveOwnerUserId,
} from "./telegramChannel.js"
export { startupNoticeText } from "./telegramSupport.js"
const MAX_INPUT_LENGTH = 12_000
const MAX_PENDING = 4
const SHUTDOWN_DRAIN_MS = 3_000
/** Reconnect attempts after a transport failure to api.telegram.org: 5s, 10s, 20s… capped. */
const RECONNECT_DELAY_MS = 5_000
const RECONNECT_MAX_DELAY_MS = 60_000
/** Per-chat bookkeeping is pruned past this many chats so an allow-all bot cannot grow without bound. */
const CHAT_STATE_LIMIT = 500

/** Failure cards keep their prompt for the 重试 button; only the newest ones survive. */
const RETRY_CARD_LIMIT = 100
/**
 * Only a rejected credential is worth dying for: 401/404 from the Bot API cannot heal, and a
 * process that stays up holding the lock answers nothing. A GrammyError means Telegram actually
 * replied; everything else (HttpError, DNS failure, reset connection) is transport, and the App
 * drives the HTTP API rather than Telegram, so that channel must survive the outage.
 */
function isFatalTelegramCredentialError(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)
}

// Control commands routed through the per-chat queue (they touch session state);
// everything else that reaches the queue is a prompt and must respect the cap.
const QUEUED_COMMANDS = new Set(["/agent", "/new", "/reset", "/id", "/model", "/cc", "/retry"])

/** Monotonic queue-entry ids, because a plain index would shift under a button press. */
let jobSequence = 0
export interface Job {
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
  readonly #outcomes: ChatTaskOutcomeRecorder
  readonly #queues = new Map<string, Promise<void>>()
  readonly #pending = new Map<string, Job[]>()
  readonly #generation = new Map<string, number>()
  readonly #cancels = new Map<string, AbortController>()
  readonly #runningSince = new Map<string, number>()
  readonly #lastPrompts = new Map<string, { text: string; attachments?: AttachmentDescriptor[] }>()
  /** Prompt behind each failure card's 重试 button, keyed by the failed job id. */
  readonly #retryPrompts = new Map<string, { key: string; text: string; attachments?: AttachmentDescriptor[] }>()
  readonly #ccCommands: CcCommands
  readonly #magpie: MagpieService
  readonly #magpieCommands: MagpieCommands
  readonly #reminders: ReminderService
  readonly #aliases: AliasStore
  readonly #schedules: ScheduleService
  readonly #cc: CcSwitchService
  readonly #models: ModelAdmin
  readonly #agentInstaller: AgentCliInstaller
  readonly #ops: OpsService
  readonly #stats: TelegramStatsPanels
  readonly #personalPanels: TelegramPersonalPanels
  readonly #corePanels: TelegramCorePanels
  readonly #personalCommands: TelegramPersonalCommands
  readonly #modelCommands: TelegramModelCommands
  readonly #opsCommands: TelegramOpsCommands
  readonly #agentCommands: TelegramAgentCommands
  readonly #proxyCommands: TelegramProxyCommands
  readonly #adminCommands: TelegramAdminCommands
  readonly #attachments: TelegramAttachments
  readonly #mediaSender: TelegramMediaSender
  readonly #infoCommands: TelegramInfoCommands
  readonly #channel?: ChannelIdResolver
  readonly #feishuResourceClient?: FeishuApiLike
  readonly #reminderDelivery = new ReminderDelivery({
    sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
    snooze: (chatId, userId, text, minutes) => this.#reminders.snooze(chatId, userId, text, minutes),
  })
  #startedAt = Date.now()
  #running = false
  #reconnectTimer?: ReturnType<typeof setTimeout>
  #reconnectDelayMs = RECONNECT_DELAY_MS
  #coreServicesStarted = false
  #usageReportStarted = false
  readonly #announcedStartups = new Set<string>()
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
    magpie?: MagpieService,
    channel?: ChannelIdResolver,
    feishuResourceClient?: FeishuApiLike,
  ) {
    this.#cfg = cfg
    this.#timezone = cfg.reminderTimezone
    // Feishu-only deployments still need a Bot instance because every command
    // and panel is authored against the Bot API. The placeholder is never
    // polled: start() skips init/getUpdates when the token is absent and the
    // transformer intercepts every call aimed at the Feishu namespace.
    this.#bot = bot ?? createChannelBot(cfg.telegram.token)
    this.#oc = oc
    this.#agents = agents
    this.#store = store
    this.#log = log
    this.#proxies = proxies
    this.#channel = channel
    this.#feishuResourceClient = feishuResourceClient
    this.#cc =
      ccswitch ??
      new CcSwitchService({ bin: cfg.ccswitch?.bin, app: cfg.ccswitch?.app ?? "opencode", projectDir: process.cwd() })
    this.#magpie =
      magpie ??
      new MagpieService({ bin: cfg.magpie?.bin, gatewayUrl: cfg.magpie?.gatewayUrl, projectDir: process.cwd() })
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
    this.#outcomes = chatTaskOutcomeRecorder(log, this.#usage, this.#history, this.#store, (text) => this.#maskToken(text))
    this.#aliases = new AliasStore(resolve(cfg.dataDir, "aliases.json"), log)
    this.#reminders = new ReminderService(
      resolve(cfg.dataDir, "reminders.json"),
      (chatId, text, reminder) => this.#deliverReminder(chatId, text, reminder),
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
    this.#stats = new TelegramStatsPanels({
      cfg: this.#cfg,
      store: this.#store,
      agents: this.#agents,
      usage: this.#usage,
      history: this.#history,
      reminders: this.#reminders,
      schedules: this.#schedules,
      proxies: this.#proxies,
      timezone: () => this.#timezone,
      startedAt: () => this.#startedAt,
      pendingCount: (key) => this.#pending.get(key)?.length ?? 0,
      currentModel: (key) => this.#modelCommands.getCurrentModel(key),
      cliModelLabel: (engine, model) => this.#cliModelLabel(engine, model),
      encryptionEnabled: () => resolveEncKey(this.#cfg) !== undefined,
      runningSince: this.#runningSince,
    })
    this.#personalPanels = new TelegramPersonalPanels({
      cfg: this.#cfg,
      agents: this.#agents,
      proxies: this.#proxies,
      aliases: this.#aliases,
      schedules: this.#schedules,
      reminders: this.#reminders,
      timezone: () => this.#timezone,
      pendingJobs: (key) => this.#pending.get(key) ?? [],
      isRunning: (key) => this.#runningSince.has(key),
    })
    this.#corePanels = new TelegramCorePanels({
      store: this.#store,
      agents: this.#agents,
      agentInstaller: this.#agentInstaller,
      usage: this.#usage,
      reminders: this.#reminders,
      schedules: this.#schedules,
      runningSince: this.#runningSince,
      pendingCount: (key) => this.#pending.get(key)?.length ?? 0,
      currentModel: (key) => this.#modelCommands.getCurrentModel(key),
      cliModelLabel: (engine, model) => this.#cliModelLabel(engine, model),
    })
    this.#personalCommands = new TelegramPersonalCommands({
      reminders: this.#reminders,
      aliases: this.#aliases,
      schedules: this.#schedules,
      store: this.#store,
      agents: this.#agents,
      timezone: () => this.#timezone,
      currentModel: (key) => this.#modelCommands.getCurrentModel(key),
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      aliasPanel: (chatId) => this.#personalPanels.aliasPanel(chatId),
      schedulePanel: (chatId, page) => this.#personalPanels.schedulePanel(chatId, page),
      remindersPanel: (chatId, page) => this.#personalPanels.remindersPanel(chatId, page),
    })
    this.#modelCommands = new TelegramModelCommands({
      store: this.#store,
      agents: this.#agents,
      oc: this.#oc,
      log: this.#log,
      runningSince: this.#runningSince,
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      dirPanel: (key) => this.#corePanels.dirPanel(key),
      modelPanel: (key) => this.#corePanels.modelPanel(key),
    })
    this.#opsCommands = new TelegramOpsCommands({
      ops: this.#ops,
      cfg: this.#cfg,
      log: this.#log,
      timezone: () => this.#timezone,
      setTimezone: (zone) => { this.#timezone = zone },
      reminders: this.#reminders,
      schedules: this.#schedules,
      usage: this.#usage,
      runningSince: this.#runningSince,
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      sendDocument: (chatId, data, filename, caption) =>
        this.#bot.api.sendDocument(chatId, new InputFile(data, filename), { caption }),
      offLoop: (chatId, label, run) => this.#offLoop(chatId, label, run),
      maskToken: (text) => this.#maskToken(text),
    })
    this.#agentCommands = new TelegramAgentCommands({
      agents: this.#agents,
      installer: this.#agentInstaller,
      store: this.#store,
      log: this.#log,
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      agentPanel: (key) => this.#corePanels.agentPanel(key),
      agentInstallerPanel: () => this.#corePanels.agentInstallerPanel(),
    })
    this.#proxyCommands = new TelegramProxyCommands({
      proxies: this.#proxies,
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      proxyPanel: (note) => this.#personalPanels.proxyPanel(note),
    })
    this.#adminCommands = new TelegramAdminCommands({
      cfg: this.#cfg,
      ops: this.#ops,
      ownerChatId: this.ownerChatId,
      timezone: () => this.#timezone,
      applyLiveEnv: (key, value) => this.#applyLiveEnv(key, value),
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      accessPanel: (channel) => this.#personalPanels.accessPanel(undefined, channel),
      timezonePanel: (headline) => this.#personalPanels.timezonePanel(headline),
      openIdForUser: (userId) => this.#channel?.openIdForUser?.(userId),
      channel: this.#channel,
    })
    this.#attachments = new TelegramAttachments({
      bot: this.#bot,
      cfg: this.#cfg,
      oc: this.#oc,
      maskToken: (text) => this.#maskToken(text),
      log: this.#log,
      feishuStream: this.#feishuResourceClient
        ? (ref, signal) => openFeishuAttachmentStream(this.#feishuResourceClient!, ref, this.#cfg.maxInputBytes, signal)
        : undefined,
    })
    this.#mediaSender = new TelegramMediaSender({
      bot: this.#bot,
      cfg: this.#cfg,
      proxies: this.#proxies,
      log: this.#log,
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
    })
    this.#infoCommands = new TelegramInfoCommands({
      cfg: this.#cfg,
      log: this.#log,
      bot: this.#bot,
      history: this.#history,
      timezone: () => this.#timezone,
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      queuePanel: (key) => this.#personalPanels.queuePanel(key),
      statusText: (chatId, key) => this.#statusText(chatId, key),
      statusKeyboard: () => this.#statusKeyboard(),
      usagePanel: (key) => this.#stats.usagePanel(key),
      channel: this.#channel,
    })
    this.#ccCommands = new CcCommands(ccHost, this.#cc, this.#models, log)
    const magpieHost: MagpieHost = {
      sendText: (chatId, text, keyboard) => this.#sendTextMessage(chatId, text, keyboard),
      sendPanel: (chatId, panel) => this.#sendPanel(chatId, panel),
      editPanel: (ctx, panel) => this.#editPanel(ctx, panel),
    }
    this.#magpieCommands = new MagpieCommands(magpieHost, this.#magpie, log)
  }

  /** Shared services the HTTP API reuses; both surfaces then see the same reminders and stats. */
  get sharedReminders(): ReminderService {
    return this.#reminders
  }

  get sharedSchedules(): ScheduleService {
    return this.#schedules
  }

  /** The shared grammY Bot; the Feishu adapter installs its outbound transformer here. */
  get bot(): Bot {
    return this.#bot
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

  /** Exposed to the HTTP API for the app's magpie console (/magpie parity). */
  get magpieService(): MagpieService {
    return this.#magpie
  }

  /** Lets the HTTP API deliver remote media with the same SSRF/proxy guards as Telegram. */
  fetchRemoteMedia(target: string): Promise<Buffer> {
    return this.#mediaSender.fetchRemoteMedia(target)
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

  /** First whitelisted chat: the push target for reminders created outside a chat. */
  get ownerChatId(): number | undefined {
    return resolveOwnerChatId(this.#cfg, this.#channel)
  }

  /** The user identity owning the notification chat; equals chatId for Telegram DMs. */
  get ownerUserId(): number | undefined {
    return resolveOwnerUserId(this.#cfg, this.#channel, this.ownerChatId)
  }

  /** Feishu and Telegram share one command stack; adapters submit synthetic updates here. */
  async handleUpdate(update: Parameters<Bot["handleUpdate"]>[0]): Promise<void> {
    if (!this.#cfg.telegram.token) seedFeishuBotInfo(this.#bot)
    await this.#bot.handleUpdate(update)
  }

  /** Starts reminders, schedules and the daily report once for whichever transport is up. */
  startBackgroundServices(): void {
    this.#startServices()
  }

  /** Sends the boot ping once per transport/chat, including Feishu-only starts. */
  async announceStartup(chatId: number | undefined, channel: Channel, username?: string): Promise<void> {
    if (this.#cfg.startupNotice === false || chatId === undefined) return
    const key = `${channel}:${chatId}`
    if (this.#announcedStartups.has(key)) return
    this.#announcedStartups.add(key)
    const opencodeOk = await this.#oc.health().catch(() => false)
    try {
      const sent = await this.#sendTextMessage(
        chatId,
        startupNoticeText({ username, version: appVersion(), opencodeOk, timezone: this.#timezone, channel }),
      )
      if (!sent) this.#announcedStartups.delete(key)
    } catch (err) {
      this.#announcedStartups.delete(key)
      this.#log.warn("failed to send the startup notice:", (err as Error).message)
    }
  }

  /**
   * `reconnecting` tells the caller what happened: the Bot API never answered, the credential was
   * not necessarily rejected, and polling will be picked up in the background. A deployment that
   * also serves the App keeps serving it; a Telegram-only one has nothing left to do and exits.
   */
  async start(options: { polling?: boolean; onFatal?: (err: Error) => void } = {}): Promise<{ reconnecting: boolean }> {
    this.#running = true
    this.#startedAt = Date.now()
    this.#setupHandlers()

    this.#bot.catch((err) => {
      this.#log.error("Telegram bot error caught:", err.message)
    })

    if (!this.#cfg.telegram.token) {
      this.#log.info("Telegram handlers registered (token absent, polling disabled)")
      return { reconnecting: false }
    }

    if (options.polling === false) {
      this.#log.info("Telegram handlers registered (polling disabled)")
      return { reconnecting: false }
    }

    // bot.start() resolves only when polling ends, so awaiting it would say nothing
    // about a revoked token. init() is the one round trip that proves the credential
    // works; without it a 401 left a live process that held the lock and answered nothing.
    try {
      await this.#bot.init()
    } catch (err) {
      if (isFatalTelegramCredentialError(err)) {
        this.#running = false
        throw new Error(`无法连接 Telegram：${(err as Error).message}`)
      }
      this.#log.error(
        `Telegram 暂时连不上，转为后台重连（HTTP API 与安卓端不受影响）：${(err as Error).message}`,
      )
      this.#scheduleReconnect(options)
      return { reconnecting: true }
    }

    this.#poll(options)
    return { reconnecting: false }
  }

  #poll(options: { onFatal?: (err: Error) => void }): void {
    this.#log.info("starting Telegram Bot (long polling)...")
    this.#bot
      .start({
        onStart: (botInfo) => {
          this.#log.info(`Telegram Bot connected as @${botInfo.username} (ID: ${botInfo.id})`)
          this.#bot.api
            .setMyCommands(BOT_MENU_COMMANDS)
            .catch((err: unknown) => this.#log.warn("failed to register Telegram command menu:", (err as Error).message))
          this.#startServices()
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

  /** Reminders, schedules and the usage report all deliver into Telegram, so they wait for the
   * first successful connect — and only run once, however many reconnects follow. */
  #startServices(): void {
    if (!this.#coreServicesStarted) {
      this.#coreServicesStarted = true
      this.#reminders.start()
      this.#schedules.start()
    }
    // Feishu has no owner chat until its first whitelisted private message
    // creates the identity mapping. Re-check on every transport event rather
    // than letting a startup without an owner disable the report forever.
    if (!this.#usageReportStarted && this.ownerChatId !== undefined) {
      this.#usageReportStarted = true
      this.#usageReport.start()
    }
  }

  /** Exponential backoff, unref'd so a pending attempt can never hold the process open. */
  #scheduleReconnect(options: { onFatal?: (err: Error) => void }): void {
    if (!this.#running || this.#reconnectTimer) return
    const delay = this.#reconnectDelayMs
    this.#reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      if (!this.#running) return
      void this.#bot
        .init()
        .then(() => {
          if (!this.#running) return
          this.#reconnectDelayMs = RECONNECT_DELAY_MS
          this.#log.info("Telegram 已恢复，开始轮询")
          this.#poll(options)
        })
        .catch((err: unknown) => {
          if (!this.#running) return
          if (isFatalTelegramCredentialError(err)) {
            this.#running = false
            this.#log.error(`Telegram 令牌已失效：${(err as Error).message}`)
            options.onFatal?.(err as Error)
            return
          }
          this.#log.warn(
            `Telegram 重连失败，${Math.round(this.#reconnectDelayMs / 1000)}s 后再试：${(err as Error).message}`,
          )
          this.#scheduleReconnect(options)
        })
    }, delay)
    this.#reconnectTimer.unref()
  }

  /**
   * One-line "I'm back" ping after a successful boot, so /restart, /update or a
   * server reboot is visible in chat without tailing logs. Goes to the first
   * whitelisted user (the owner chat); STARTUP_NOTICE=0 turns it off.
   */
  async #sendStartupNotice(username?: string): Promise<void> {
    await this.announceStartup(this.ownerChatId, "telegram", username)
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
    const remindersStopped = this.#reminders.dispose(true)
    // Stop scheduling new work first, but do not wait here: the tasks already in
    // flight are waiting on this bridge's queues, so they must be aborted before
    // their scheduler completion can be drained.
    const schedulesStopped = this.#schedules.dispose(true)
    const reportsStopped = this.#usageReport.dispose(true)

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
    this.#opsCommands.clearPending()
    this.#agentCommands.clearPending()
    this.#lastPrompts.clear()
    this.#retryPrompts.clear()
    this.#ccCommands.clearProviders()

    const running = [...this.#queues.values(), ...aborts]
    await Promise.race([
      Promise.allSettled([...running, schedulesStopped, remindersStopped, reportsStopped]),
      sleep(SHUTDOWN_DRAIN_MS),
    ])

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
        const channel = channelOfChatId(ctx.chat?.id ?? from.id, this.#channel)
        this.#log.debug(`ignored ${channel} message from unauthorized user ${userId} (@${from.username ?? "none"})`)
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: "你未在白名单中", show_alert: true }).catch(() => {})
        } else {
          const openId = this.#channel?.openIdForUser?.(from.id)
          const identity = channel === "feishu" ? `飞书 open_id：\`${openId ?? userId}\`` : `Telegram ID 是：\`${userId}\``
          const grant =
            channel === "feishu"
              ? "请把这个 open_id 发给 Bot 管理员，或把它加入 `.env` 的 `FEISHU_ALLOW_OPEN_IDS`。"
              : `请把这个 ID 发给 Bot 管理员，让他发送 \`/access add ${userId}\` 即可立即放行。`
          await ctx
            .reply(
              `⚠️ 你未在白名单中。\n你的${identity}\n${grant}`,
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
      const key = this.#sessionKey(chatId)

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
      if (command === "/report") {
        this.#offLoop(chatId, "每日报告", async () => {
          await this.#sendTextMessage(chatId, escapeMarkdown(this.#usageReport.preview()), this.#reportKeyboard())
        })
        return
      }
      if (command === "/export") {
        this.#offLoop(chatId, "导出", () => this.#handleExport(chatId, key, arg))
        return
      }
      if (command === "/history") {
        const requested = Number(arg)
        const count = Number.isInteger(requested) && requested > 0 ? Math.min(50, requested) : 10
        await this.#sendPanel(chatId, this.#historyPanel(key, count))
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
      if (isBotCommand(command, "ops")) {
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
      if (isBotCommand(command, "service")) {
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
      if (isBotCommand(command, "timezone")) {
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

      // 拼错的菜单命令不再完全静默:给一句邻近命令提示,但仍按普通消息入队(alias 依赖这条兜底路径)
      if (command.startsWith("/") && !arg && !QUEUED_COMMANDS.has(command)) {
        const near = nearestMenuCommand(command)
        if (near) {
          await this.#sendTextMessage(
            chatId,
            `💡 未找到命令 \`${escapeMarkdown(command)}\`。你是想输入 \`/${near}\` 吗?这条消息仍会发给 AI 处理;发送 /help 查看全部命令。`,
          )
        }
      }

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

    // Photos, documents, voice notes, audio and video files
    this.#bot.on(
      ["message:photo", "message:document", "message:voice", "message:audio", "message:video"],
      async (ctx) => {
        const chatId = ctx.chat.id
        const key = this.#sessionKey(chatId)
        const attachments = this.#collectAttachments(ctx.message)
        if (attachments.length === 0) return

        const tooBig = this.#cfg.maxInputBytes > 0
          ? attachments.find((att) => (att.size ?? 0) > this.#cfg.maxInputBytes)
          : undefined
        if (tooBig) {
          const limitMb = Math.round(this.#cfg.maxInputBytes / 1024 / 1024)
          await this.#sendTextMessage(chatId, `⚠️ ${tooBig.name} 超过配置的 ${limitMb}MB 下载上限，无法接收。`)
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
      },
    )

    // Inline panel buttons
    this.#bot.on("callback_query:data", async (ctx) => {
      const chatId = ctx.chat?.id
      const data = ctx.callbackQuery.data
      if (!chatId) {
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      const key = this.#sessionKey(chatId)
      const answer = async (text?: string): Promise<void> => {
        await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
      }

      if (data.startsWith("show:")) {
        const which = data.slice("show:".length)
        await answer()
        // cc/ops/service/magpie panels spawn subprocesses: build them off the update loop
        if (which === "cc" || which === "ops" || which === "service" || which === "magpie") {
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
        await this.#reminderDelivery.snooze(chatId, snoozeMatch[1]!, Number(snoozeMatch[2]), answer)
        return
      }

      // 纯展示按钮（如分页指示「2/3」）：点了只确认，不做任何事
      if (data.startsWith("noop:")) {
        await answer()
        return
      }

      if (data.startsWith("tz:")) {
        await answer()
        await this.#handleTimeZone(chatId, data.slice("tz:".length))
        return
      }

      if (data.startsWith("magpie:")) {
        const rest = data.slice("magpie:".length)
        this.#offLoop(chatId, "magpie 操作", () => this.#magpieCommands.handleCallback(ctx, chatId, rest, answer))
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
        const blocked = this.#agentCommands.actionBlocked(key, action, engine)
        if (blocked) {
          await answer(blocked)
          return
        }
        await answer()
        await this.#agentCommands.requestAction(chatId, key, action, engine)
        return
      }
      if (data.startsWith("a:cnl:")) {
        const token = data.slice("a:cnl:".length)
        const pending = this.#agentCommands.getPending(token)
        if (pending && pending.chatId !== chatId) {
          await answer("该按钮不属于当前会话")
          return
        }
        // A declined request must not stay executable until its TTL expires
        this.#agentCommands.deletePending(token)
        await answer("已取消")
        const panel = await this.#panelFor("agents", chatId, key)
        if (panel) await this.#editPanel(ctx, panel)
        return
      }
      if (data.startsWith("a:cfm:")) {
        const token = data.slice("a:cfm:".length)
        const pending = this.#agentCommands.getPending(token)
        if (!pending || Date.now() - pending.createdAt > AGENT_CONFIRM_TTL_MS) {
          this.#agentCommands.deletePending(token)
          await answer("操作已过期，请重新发起")
          await this.#sendTextMessage(chatId, "⌛ 该确认按钮已过期或已被使用，请重新发起操作。")
          return
        }
        if (pending.chatId !== chatId) {
          await answer("该按钮不属于当前会话")
          return
        }
        this.#agentCommands.deletePending(token)
        // Preconditions are re-checked here because the state may have changed
        // between showing the prompt and pressing the button
        const blocked = this.#agentCommands.actionBlocked(key, pending.action, pending.engine)
        if (blocked) {
          await answer(blocked)
          await this.#sendTextMessage(chatId, `⚠️ ${escapeMarkdown(blocked)}，操作已取消。`)
          return
        }
        const verb = AGENT_ACTION_VERB[pending.action]
        await answer(`开始${verb}…`)
        void this.#agentCommands.runAction(chatId, key, pending.action, pending.engine).catch((err: unknown) => {
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
        const channel = channelOfChatId(chatId, this.#channel)
        const result = this.#adminCommands.mutateAccess(false, [id], ctx.from?.id, channel)
        if (!result.ok) {
          await answer(result.message)
          await this.#editPanel(ctx, this.#accessPanel(undefined, channel))
          return
        }
        this.#log.info(`access removed ${id} by ${ctx.from?.id ?? "?"}`)
        await answer(`已移除 ${id}`)
        await this.#editPanel(ctx, this.#accessPanel(`🗑 已从白名单移除 ${id}，立即生效。`, channel))
        return
      }

      if (data.startsWith("faccess:")) {
        const id = data.slice("faccess:del:".length)
        if (!data.startsWith("faccess:del:") || !FEISHU_OPEN_ID_RE.test(id)) {
          await answer("未知的飞书白名单操作")
          return
        }
        const result = this.#adminCommands.mutateAccess(false, [id], ctx.from?.id, "feishu")
        if (!result.ok) {
          await answer(result.message)
          await this.#editPanel(ctx, this.#accessPanel(undefined, "feishu"))
          return
        }
        this.#log.info(`Feishu access removed ${id} by ${ctx.from?.id ?? "?"}`)
        await answer(`已移除 ${id}`)
        await this.#editPanel(ctx, this.#accessPanel(`🗑 已从飞书白名单移除 ${id}，立即生效。`, "feishu"))
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
            await answer("本会话没有独立的模型选择")
            return
          }
          await answer("已清除模型选择，之后由 OpenCode 自身配置决定")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        const targetKey = resolveModelKey(data.slice("model:".length))
        const target = targetKey ? AVAILABLE_MODELS[targetKey] : undefined
        if (!target) {
          await answer("模型不存在")
          return
        }
        const current = this.#modelCommands.getCurrentModel(key)
        if (current?.providerID === target.providerID && current.modelID === target.modelID) {
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
          await answer("本会话没有独立的模型选择")
          return
        }
        await answer("已清除模型选择，之后由 CLI 自身配置决定")
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
          // Split on the first colon only: a model id may itself contain one
          const at = payload.indexOf(":")
          engine = at < 0 ? payload : payload.slice(0, at)
          const value = at < 0 ? "" : payload.slice(at + 1)
          const profile = this.#agents.registry.get(engine)
          // Panels built before a profile reload carry the position; the id is what survives
          // the list changing under the tap, so it wins whenever the panel offered one
          model = profile?.models?.find((entry) => entry.id === value)?.id ?? this.#indexedModel(profile, value)
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
        const current = this.#store.getCliModel(key, engine)
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

      // Panel snooze: one tap postpones a pending one-shot by an hour (the App
      // offers 10 分钟/1 小时/明天; the delivery message keeps its own buttons)
      if (data.startsWith("rpostpone:")) {
        const id = Number(data.slice("rpostpone:".length))
        try {
          const postponed = this.#reminders.postpone(chatId, id, 60)
          await answer(`已把 #${postponed.id} 延后 1 小时`)
        } catch (err) {
          await answer(err instanceof Error ? err.message : "无法延后该提醒")
        }
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
    return this.#infoCommands.handleQueue(chatId, key)
  }

  async #handleApiInfo(chatId: number): Promise<void> {
    return this.#infoCommands.handleApiInfo(chatId)
  }

  async #handleProxyCommand(chatId: number, arg: string): Promise<void> {
    return this.#proxyCommands.handleProxyCommand(chatId, arg)
  }

  #proxyPanel(note?: string): Panel {
    return this.#personalPanels.proxyPanel(note)
  }

  #queuePanel(key: string): Panel {
    return this.#personalPanels.queuePanel(key)
  }

  async #handleExport(chatId: number, key: string, arg: string): Promise<void> {
    return this.#infoCommands.handleExport(chatId, key, arg)
  }

  async #handleStatus(chatId: number, key: string): Promise<void> {
    return this.#infoCommands.handleStatus(chatId, key)
  }

  async #handleUsage(chatId: number, key: string): Promise<void> {
    return this.#infoCommands.handleUsage(chatId, key)
  }

  #reportKeyboard(): InlineKeyboard {
    return this.#stats.reportKeyboard()
  }

  #usagePanel(key: string): Panel {
    return this.#stats.usagePanel(key)
  }

  #historyPanel(key: string, count = 10, offset = 0): Panel {
    return this.#stats.historyPanel(key, count, offset)
  }

  #statusText(chatId: number, key: string): string {
    return this.#stats.statusText(chatId, key)
  }

  #statusKeyboard(): InlineKeyboard {
    return this.#stats.statusKeyboard()
  }

  async #handleRemind(chatId: number, userId: number, arg: string): Promise<void> {
    return this.#personalCommands.handleRemind(chatId, userId, arg)
  }

  async #handleReminders(chatId: number): Promise<void> {
    return this.#personalCommands.handleReminders(chatId)
  }

  async #handleCancelReminder(chatId: number, arg: string): Promise<void> {
    return this.#personalCommands.handleCancelReminder(chatId, arg)
  }

  async #handleAliasCommand(chatId: number, arg: string): Promise<void> {
    return this.#personalCommands.handleAliasCommand(chatId, arg)
  }

  async #handleScheduleCommand(chatId: number, userId: number, key: string, arg: string): Promise<void> {
    return this.#personalCommands.handleScheduleCommand(chatId, userId, key, arg)
  }

  #aliasPanel(chatId: number): Panel {
    return this.#personalPanels.aliasPanel(chatId)
  }

  #schedulePanel(chatId: number, page = 1): Panel {
    return this.#personalPanels.schedulePanel(chatId, page)
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
    return this.#attachments.collectAttachments(message)
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

    if (isBotCommand(command, "new")) {
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
        const currentModel = this.#modelCommands.getCurrentModel(job.key)
        infoText += `• OpenCode 模型: *${escapeMarkdown(currentModel?.label ?? "由 OpenCode 决定")}*\n• 会话 ID: \`${sessionID || "暂未创建"}\``
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

    if (command === "/magpie") {
      // Every magpie call shells out to the CLI; keep the update loop free for other chats.
      this.#offLoop(job.chatId, "magpie 操作", () => this.#magpieCommands.handleCommand(job.chatId, job.key, arg))
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
    const activeModel = isOpencode ? (job.model ?? this.#modelCommands.getCurrentModel(job.key)) : undefined
    const cliModel = isOpencode
      ? undefined
      : (job.cliModel ?? this.#store.getCliModel(job.key, engine))
    const taskStarted = Date.now()
    let outcome: UsageOutcome = "failed"
    let failureDetail: string | undefined

    const controller = new AbortController()

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
      // Marked busy inside the try: the finally below is what unmarks it, and nothing
      // between the two may be able to leave the chat stuck as "running"
      this.#cancels.set(job.key, controller)
      this.#runningSince.set(job.key, Date.now())
      const input = job.attachments?.length
        ? await this.#buildAttachmentInput(job, activeModel, controller.signal)
        : { text: job.text, files: [] as PromptFile[] }
      const attachmentInfo = job.attachments?.length ? ` attachments=${job.attachments.length}` : ""
      const promptLabel = isOpencode ? `OpenCode: ${activeModel?.label ?? "engine config"}` : this.#agents.registry.label(engine)
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
        failureDetail = redactSecrets(this.#maskToken(detail)).replace(/\s+/g, " ").slice(0, 300)
        return
      }
      failureDetail = redactSecrets(this.#maskToken(detail)).replace(/\s+/g, " ").slice(0, 300)
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
      this.#outcomes.record({ task: job, engine, model: modelLabel, outcome, detail: failureDetail, ms, startedAt: taskStarted })
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
      this.#ccCommands.pruneProviders((chatId) => active(this.#sessionKey(chatId)), CHAT_STATE_LIMIT)
    if (removed > 0) this.#log.debug(`pruned ${removed} idle chat state entries`)
  }

  async #buildAttachmentInput(job: Job, model?: ModelRef, signal?: AbortSignal): Promise<{ text: string; files: PromptFile[] }> {
    return this.#attachments.buildAttachmentInput(job, model, signal)
  }

  async #handleAgentCommand(job: Job, target?: string): Promise<void> {
    return this.#agentCommands.handleCommand(job, target)
  }

  async #handleAgentsCommand(job: Job, arg: string): Promise<void> {
    return this.#agentCommands.handleAgentsCommand(job, arg)
  }

  async #handleDiagnostics(chatId: number): Promise<void> {
    return this.#opsCommands.handleDiagnostics(chatId)
  }

  async #opsPanel(): Promise<Panel> {
    return this.#opsCommands.opsPanel()
  }

  async #handleLogs(chatId: number, arg: string): Promise<void> {
    return this.#opsCommands.handleLogs(chatId, arg)
  }

  async #handleOpsCallback(
    chatId: number,
    action: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<void> {
    return this.#opsCommands.handleOpsCallback(chatId, action, answer)
  }

  async #handleServiceCommand(chatId: number, arg: string): Promise<void> {
    return this.#opsCommands.handleServiceCommand(chatId, arg)
  }

  async #servicePanel(): Promise<Panel> {
    return this.#opsCommands.servicePanel()
  }

  async #confirmRestart(chatId: number): Promise<void> {
    return this.#opsCommands.confirmRestart(chatId)
  }

  async #confirmUpdate(chatId: number): Promise<void> {
    return this.#opsCommands.confirmUpdate(chatId)
  }

  async #handleEnvCommand(chatId: number, arg: string): Promise<void> {
    return this.#opsCommands.handleEnvCommand(chatId, arg)
  }

  #applyLiveEnv(key: string, value: string): void {
    this.#opsCommands.applyLiveEnv(key, value)
  }

  /** The active channel's whitelist, editable from the chat instead of by editing `.env`. */
  #accessPanel(headline?: string, channel: Channel = "telegram"): Panel {
    return this.#personalPanels.accessPanel(headline, channel)
  }

  async #handleAccessCommand(chatId: number, userId: number, arg: string): Promise<void> {
    return this.#adminCommands.handleAccessCommand(chatId, userId, arg)
  }

  get accessState(): { users: string[]; allowAll: boolean } {
    return this.#adminCommands.accessState
  }

  addAccess(ids: string[]): { ok: boolean; message: string } {
    return this.#adminCommands.addAccess(ids)
  }

  removeAccess(ids: string[]): { ok: boolean; message: string } {
    return this.#adminCommands.removeAccess(ids)
  }

  async #handleTimeZone(chatId: number, arg: string): Promise<void> {
    return this.#adminCommands.handleTimeZone(chatId, arg)
  }

  async #handleDirCommand(job: Job, arg?: string): Promise<void> {
    return this.#modelCommands.handleDirCommand(job, arg)
  }

  async #handleModelCommand(job: Job, arg?: string): Promise<void> {
    return this.#modelCommands.handleModelCommand(job, arg)
  }

  #cliModelLabel(engine: string, model: string | undefined): string {
    return this.#modelCommands.cliModelLabel(engine, model)
  }

  #dirPanel(key: string): Panel {
    return this.#corePanels.dirPanel(key)
  }

  #agentPanel(key: string): Panel {
    return this.#corePanels.agentPanel(key)
  }

  #modelPanel(key: string): Panel {
    return this.#corePanels.modelPanel(key)
  }

  #remindersPanel(chatId: number, page = 1): Panel {
    return this.#personalPanels.remindersPanel(chatId, page)
  }

  #welcomeText(key: string, userId: number): string {
    return this.#corePanels.welcomeText(key, userId)
  }

  #menuPanel(chatId: number, key: string): Panel {
    return this.#corePanels.menuPanel(chatId, key)
  }

  #menuKeyboard(): InlineKeyboard {
    return this.#corePanels.menuKeyboard()
  }

  #agentInstallerPanel(): Panel {
    return this.#corePanels.agentInstallerPanel()
  }

  #resetCliSessions(key: string): void {
    for (const profile of this.#agents.registry.list()) this.#store.clearCliSession(key, profile.id)
  }

  async #applyOpenCodeModel(key: string, target: ModelInfo): Promise<void> {
    return this.#modelCommands.applyOpenCodeModel(key, target)
  }

  async #clearOpenCodeModelSelection(key: string): Promise<boolean> {
    return this.#modelCommands.clearOpenCodeModelSelection(key)
  }

  #clearCliModelSelection(key: string, engine: string): boolean {
    return this.#modelCommands.clearCliModelSelection(key, engine)
  }

  #applyCliModel(key: string, engine: string, model: string): void {
    this.#modelCommands.applyCliModel(key, engine, model)
  }

  /**
   * A panel rendered before this session's callback data carried model ids sends a position
   * instead, which only means something while the profile list has not changed.
   */
  #indexedModel(profile: { models?: Array<{ id: string }> } | undefined, value: string): string | undefined {
    const index = Number(value)
    return value !== "" && Number.isInteger(index) && index >= 0 ? profile?.models?.[index]?.id : undefined
  }

  async #panelFor(which: string, chatId: number, key: string): Promise<Panel | undefined> {
    // Page buttons carry their argument in the callback data ("reminders:2"), so dispatch
    // on the panel name; matching the whole string left every pagination link in default.
    const [name, argument, second] = which.split(":")
    switch (name) {
      case "menu": return this.#menuPanel(chatId, key)
      case "help": return { text: HELP, keyboard: this.#menuKeyboard() }
      case "agent": return this.#agentPanel(key)
      case "agents": return this.#agentInstallerPanel()
      case "model": return this.#modelPanel(key)
      case "dir": return this.#dirPanel(key)
      case "access": return this.#accessPanel(undefined, channelOfChatId(chatId, this.#channel))
      case "reminders": {
        const rawPage = Number(argument)
        return this.#remindersPanel(chatId, Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1)
      }
      case "schedule": {
        const rawPage = Number(argument)
        return this.#schedulePanel(chatId, Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1)
      }
      case "queue": return this.#queuePanel(key)
      case "proxy": return this.#proxyPanel()
      case "usage": return this.#usagePanel(key)
      case "history": {
        // "show:history:<page size>:<offset>" — the offset is what makes 「更早」 move on
        const rawCount = Number(argument)
        const rawOffset = Number(second)
        const count = Number.isInteger(rawCount) && rawCount > 0 ? rawCount : 10
        const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0
        return this.#historyPanel(key, count, offset)
      }
      case "cc": return await this.#ccCommands.panel(chatId)
      case "magpie": return await this.#magpieCommands.panel(chatId)
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

  #isAllowedUser(userId: number): boolean {
    return isUserAllowed(this.#cfg, userId, this.#channel)
  }

  #sessionKey(chatId: number): string {
    return sessionKeyForChat(chatId, this.#channel)
  }

  async #deliverReminder(chatId: number, text: string, reminder?: Reminder): Promise<void> {
    return this.#reminderDelivery.deliver(chatId, text, reminder)
  }

  async #executeScheduled(task: ScheduledTask): Promise<UsageOutcome> {
    const key = this.#sessionKey(task.chatId)
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
    return this.#mediaSender.sendReply(job, reply)
  }

  /** The engine-call context handed to the shared callEngine() helper. */
  get #engineDeps(): EngineCallDeps {
    return {
      oc: this.#oc,
      agents: this.#agents,
      store: this.#store,
      log: this.#log,
      opencodeAgent: this.#cfg.opencode.agent ?? "assistant",
      taskTimeoutMs: this.#cfg.taskTimeoutMs,
      taskMaxTimeoutMs: this.#cfg.taskMaxTimeoutMs,
    }
  }
}
