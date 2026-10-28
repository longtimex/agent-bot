import { readFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { fetch as undiciFetch } from "undici"
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
import type { Logger } from "./logger.js"
import { assertUrlAllowed, mediaLabel, parseReply, resolveMedia, type ReplyPart } from "./media.js"
import { splitMessage } from "./messages.js"
import { AVAILABLE_MODELS, resolveModelKey, resolveQoderModel, type ModelInfo } from "./models.js"
import { Opencode, OpencodeError, type PromptFile } from "./opencode.js"
import { ProgressTracker } from "./progress.js"
import { maskProxyUrl, ProxyService } from "./proxy.js"
import { QoderService } from "./qoder.js"
import { describeRepeat, formatRemaining, formatReminderTime, MAX_PER_CHAT, ReminderService, zonedParts } from "./reminders.js"
import { scheduleTargetLabel, ScheduleService, type ScheduleDefaults, type ScheduledTask } from "./scheduler.js"
import type { BackendEngine, SessionStore } from "./store.js"
import { UsageStore, type UsageOutcome } from "./usage.js"

const MAX_INPUT_LENGTH = 12_000
const MAX_PENDING = 4
const MAX_ATTACHMENTS = 4
const MAX_ATTACH_FILE_BYTES = 10 * 1024 * 1024
const MAX_ATTACH_TOTAL_BYTES = 15 * 1024 * 1024
const MAX_INLINE_TEXT_TOTAL = 100_000
const CHUNK_DELAY_MS = 250
const TELEGRAM_MAX_TEXT = 4000
const SHUTDOWN_DRAIN_MS = 3_000

const HELP = `🤖 *AI 私人助手 (Telegram 版)*

*常用核心命令：*
• \`/agent\` - 查看当前 Agent 引擎或一键切换 (\`opencode\` / \`qoder\`)
• \`/agent qoder\` - 切换至 Qoder CLI 智能编程助手
• \`/agent opencode\` - 切换回 OpenCode 引擎
• \`/model\` - 查看或切换底层大模型列表
• \`/new\` 或 \`/reset\` - 重置会话上下文
• \`/stop\` - 立即停止当前正在执行的任务
• \`/retry\` - 重新发送上一条任务
• \`/queue\` - 查看或清空排队中的消息
• \`/status\` - 查看引擎、模型、运行时长与排队数
• \`/usage\` - 查看任务量、成功率与耗时统计
• \`/schedule\` - 查看/管理定时 AI 任务
• \`/schedule add 每天 09:00 检查服务器\` - 到点自动执行 AI 任务
• \`/schedule add --engine qoder --model deepseek 2h 汇总日志\` - 指定引擎与模型
• \`/remind 30m 喝水\` - 设定定时提醒（支持 30s/10m/2h/1d、18:30、明天 08:30）
• \`/remind every 30m 喝水\` - 重复提醒（也支持 \`每天 08:30\`）
• \`/reminders\` - 查看待触发的提醒
• \`/cancel 编号\` - 取消指定提醒
• \`/proxy\` - 管理网络代理（HTTP/HTTPS/SOCKS），支持测试、启用与删除
• \`/id\` - 查看你的会话与当前配置信息
• \`/help\` - 显示本帮助

*功能支持：*
• 编程代码生成、分析与调试
• 发送图片、文件、语音（文本文件会直接读取内容）
• 图片、视频、语音与文件发送传输
• Markdown 代码块语法高亮排版

💡 \`/agent\`、\`/model\`、\`/reminders\`、\`/schedule\` 面板支持直接点击按钮操作。`

const SCHEDULE_USAGE = `🗓 *定时 AI 任务*

• \`/schedule\` - 打开任务面板
• \`/schedule add 30m 检查服务器\` - 到点自动执行
• \`/schedule add --engine qoder --model deepseek 2h 汇总日志\` - 指定引擎与模型
• \`/schedule add every 2h 汇总日志\` / \`/schedule add 每天 09:00 生成日报\` - 重复执行
• \`/schedule pause 编号\` / \`/schedule resume 编号\` / \`/schedule del 编号\` - 管理任务

时间格式与 \`/remind\` 相同；提示词上限 2000 字，每个会话最多 20 个任务。`

interface Job {
  key: string
  text: string
  chatId: number
  userId: number
  generation: number
  attachments?: AttachmentDescriptor[]
  scheduled?: boolean
  engine?: BackendEngine
  model?: { providerID: string; modelID: string; label: string }
  qoderModel?: string
  onOutcome?: (outcome: UsageOutcome) => void
}

const COMMANDS = [
  { command: "start", description: "欢迎页与快捷入口" },
  { command: "help", description: "显示完整帮助" },
  { command: "stop", description: "停止当前任务" },
  { command: "retry", description: "重新发送上一条任务" },
  { command: "queue", description: "查看或清空排队消息" },
  { command: "status", description: "查看运行状态" },
  { command: "usage", description: "查看任务量、成功率与耗时统计" },
  { command: "schedule", description: "定时执行 AI 任务（查看/添加/暂停）" },
  { command: "remind", description: "设定定时提醒，如 /remind 30m 喝水" },
  { command: "reminders", description: "查看待触发的提醒" },
  { command: "cancel", description: "取消指定编号的提醒" },
  { command: "proxy", description: "管理网络代理（添加/测试/启用/删除）" },
  { command: "new", description: "开启新会话（清空上下文）" },
  { command: "agent", description: "查看或切换 Agent 引擎" },
  { command: "model", description: "查看或切换大模型" },
  { command: "id", description: "查看会话与配置信息" },
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

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[\]\\]/g, "\\$&")
}

interface Panel {
  text: string
  keyboard: InlineKeyboard
}

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

export class TelegramBridge {
  readonly #cfg: BotConfig
  readonly #bot: Bot
  readonly #oc: Opencode
  readonly #qoder: QoderService
  readonly #store: SessionStore
  readonly #log: Logger
  readonly #proxies: ProxyService
  readonly #usage: UsageStore
  readonly #queues = new Map<string, Promise<void>>()
  readonly #queueDepth = new Map<string, number>()
  readonly #pending = new Map<string, Job[]>()
  readonly #generation = new Map<string, number>()
  readonly #cancels = new Map<string, AbortController>()
  readonly #runningSince = new Map<string, number>()
  readonly #lastPrompts = new Map<string, { text: string; attachments?: AttachmentDescriptor[] }>()
  readonly #reminders: ReminderService
  readonly #schedules: ScheduleService
  #startedAt = Date.now()
  #running = false

  constructor(
    cfg: BotConfig,
    oc: Opencode,
    qoder: QoderService,
    store: SessionStore,
    log: Logger,
    proxies: ProxyService,
    bot?: Bot,
  ) {
    if (!cfg.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN 未配置")
    this.#cfg = cfg
    this.#bot = bot ?? new Bot(cfg.telegram.token)
    this.#oc = oc
    this.#qoder = qoder
    this.#store = store
    this.#log = log
    this.#proxies = proxies
    this.#usage = new UsageStore(resolve(cfg.dataDir, "usage.json"), log, cfg.reminderTimezone)
    this.#reminders = new ReminderService(
      resolve(cfg.dataDir, "reminders.json"),
      (chatId, text) => this.#deliverReminder(chatId, text),
      log,
      cfg.reminderTimezone,
    )
    this.#schedules = new ScheduleService(
      resolve(cfg.dataDir, "schedules.json"),
      (task) => this.#executeScheduled(task),
      log,
      cfg.reminderTimezone,
    )
  }

  async start(options: { polling?: boolean } = {}): Promise<void> {
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

    this.#log.info("starting Telegram Bot (long polling)...")
    this.#bot
      .start({
        onStart: (botInfo) => {
          this.#log.info(`Telegram Bot connected as @${botInfo.username} (ID: ${botInfo.id})`)
          this.#bot.api
            .setMyCommands(COMMANDS)
            .catch((err: unknown) => this.#log.warn("failed to register Telegram command menu:", (err as Error).message))
          this.#reminders.start()
          this.#schedules.start()
        },
      })
      .catch((err) => {
        if (!this.#running) return
        this.#log.error("Telegram Bot startup error:", (err as Error).message)
      })
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#reminders.dispose()
    this.#schedules.dispose()

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
        return
      }

      const userId = String(from.id)
      if (!this.#cfg.telegram.allowAll && !this.#cfg.telegram.allowUsers.has(userId)) {
        this.#log.debug(`ignored Telegram message from unauthorized user ${userId} (@${from.username ?? "none"})`)
        await ctx
          .reply(
            `⚠️ 你未在白名单中。\n你的 Telegram ID 是：\`${userId}\`\n请将其添加到 .env 中的 TELEGRAM_ALLOW_USERS。`,
            {
              parse_mode: "Markdown",
            },
          )
          .catch(() => {})
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
      if (command === "/status") {
        await this.#handleStatus(chatId, key)
        return
      }
      if (command === "/usage") {
        await this.#handleUsage(chatId, key)
        return
      }
      if (command === "/queue") {
        await this.#handleQueue(chatId, key)
        return
      }
      if (command === "/proxy") {
        await this.#handleProxyCommand(chatId, arg)
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
      if (command === "/cancel") {
        await this.#handleCancelReminder(chatId, arg)
        return
      }
      if (!command.startsWith("/") && !(await this.#ensureCapacity(chatId, key))) return

      await this.#dispatch({
        key,
        text,
        chatId,
        userId,
        generation: this.#generation.get(key) ?? 0,
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

      await this.#dispatch({
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
        if (which === "agent") await this.#sendPanel(chatId, this.#agentPanel(key))
        else if (which === "model") await this.#sendPanel(chatId, this.#modelPanel(key))
        else if (which === "reminders") await this.#sendPanel(chatId, this.#remindersPanel(chatId))
        else if (which === "schedule") await this.#sendPanel(chatId, this.#schedulePanel(chatId))
        else if (which === "queue") await this.#sendPanel(chatId, this.#queuePanel(key))
        else if (which === "proxy") await this.#sendPanel(chatId, this.#proxyPanel())
        else if (which === "usage") await this.#sendPanel(chatId, this.#usagePanel(key))
        else if (which === "status") {
          await this.#editPanel(ctx, { text: this.#statusText(chatId, key), keyboard: this.#statusKeyboard() })
        }
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
          const result = await this.#proxies.test(id)
          const text = result.ok
            ? `✅ 代理 #${id} 连接正常（${result.latencyMs ?? 0}ms）`
            : `❌ 代理 #${id} 测试失败：${result.message}`
          await this.#editPanel(ctx, this.#proxyPanel(text))
          return
        }
      }

      if (data === "task:stop") {
        await answer("正在停止…")
        await this.#handleStop(chatId, key)
        return
      }

      if (data === "retry") {
        const last = this.#lastPrompts.get(key)
        if (!last) {
          await answer("没有可重试的任务")
          return
        }
        if (!(await this.#ensureCapacity(chatId, key))) {
          await answer("排队已满")
          return
        }
        await answer("正在重试…")
        await this.#dispatch({
          key,
          text: last.text,
          chatId,
          userId: ctx.from?.id ?? 0,
          generation: this.#generation.get(key) ?? 0,
          attachments: last.attachments,
        })
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

      if (data.startsWith("agent:")) {
        const engine = data.slice("agent:".length)
        if (engine !== "opencode" && engine !== "qoder") {
          await answer("未知引擎")
          return
        }
        if (this.#store.getEngine(key) === engine) {
          await answer("已经是当前引擎")
          return
        }
        this.#store.setEngine(key, engine)
        this.#log.info(`agent switched [${key}] -> ${engine}`)
        await answer(engine === "qoder" ? "已切换至 Qoder CLI" : "已切换至 OpenCode")
        await this.#editPanel(ctx, this.#agentPanel(key))
        return
      }

      if (data.startsWith("model:")) {
        if (this.#store.getEngine(key) === "qoder") {
          await answer("当前为 Qoder 引擎")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        // Deleting the session while it is generating would fail the running task
        if (this.#runningSince.has(key)) {
          await answer("任务执行中，请先发送 /stop")
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

      if (data.startsWith("qmodel:")) {
        if (this.#store.getEngine(key) === "opencode") {
          await answer("当前为 OpenCode 引擎")
          await this.#editPanel(ctx, this.#modelPanel(key))
          return
        }
        if (this.#runningSince.has(key)) {
          await answer("任务执行中，请先发送 /stop")
          return
        }
        const label = resolveQoderModel(data.slice("qmodel:".length))
        if (!label) {
          await answer("模型不存在")
          return
        }
        if ((this.#store.getQoderModel(key) || "Qwen3.8-Flash") === label) {
          await answer("已经是当前模型")
          return
        }
        this.#applyQoderModel(key, label)
        await answer(`已切换至 ${label}`)
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

      await answer()
    })
  }

  async #handleStop(chatId: number, key: string): Promise<void> {
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1)
    const queued = this.#pending.get(key)?.length ?? 0
    const controller = this.#cancels.get(key)
    if (controller) {
      this.#log.info(`cancel requested [${key}]`)
      controller.abort()
      const suffix = queued > 0 ? `，排队中的 ${queued} 条消息也已丢弃` : ""
      await this.#sendTextMessage(chatId, `🛑 已请求停止当前任务${suffix}。`)
    } else if (queued > 0) {
      this.#pending.delete(key)
      await this.#sendTextMessage(chatId, `🛑 已丢弃排队中的 ${queued} 条消息。`)
    } else {
      await this.#sendTextMessage(chatId, "🛑 当前没有正在执行的任务。")
    }
  }

  async #handleQueue(chatId: number, key: string): Promise<void> {
    await this.#sendPanel(chatId, this.#queuePanel(key))
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
      return { text, keyboard }
    }

    const lines = items.map((proxy) => {
      const current = active?.id === proxy.id ? " ✅" : ""
      return `• #${proxy.id} *${escapeMarkdown(proxy.name)}*${current}\n  ${escapeMarkdown(maskProxyUrl(proxy.url))}`
    })
    const status = active
      ? `#${active.id} ${escapeMarkdown(active.name)}`
      : "未启用"
    const text =
      (note ? `${note}\n\n` : "") +
      `🌐 *网络代理*\n\n当前：${status}\n\n${lines.join("\n")}\n\n` +
      "启用后，远程媒体下载、Qoder 子进程以及 Agent 的网络命令会走该代理；Telegram 与本地 opencode 连接保持直连。"

    items.forEach((proxy, index) => {
      keyboard
        .text(`${active?.id === proxy.id ? "✅" : "▶️"} 使用 #${proxy.id}`, `proxy:use:${proxy.id}`)
        .text(`🧪 测试 #${proxy.id}`, `proxy:test:${proxy.id}`)
        .row()
        .text(`🗑 删除 #${proxy.id}`, `proxy:del:${proxy.id}`)
      if (index < items.length - 1) keyboard.row()
    })
    if (active) keyboard.row().text("⏹ 停用代理", "proxy:off")
    keyboard.row().text("🔄 刷新", "show:proxy")
    return { text, keyboard }
  }

  #queuePanel(key: string): Panel {
    const items = this.#pending.get(key) ?? []
    const running = this.#runningSince.has(key)
    if (items.length === 0 && !running) {
      return {
        text: "📭 *队列为空*\n\n直接发送消息即可开始新的任务。",
        keyboard: new InlineKeyboard(),
      }
    }

    const lines = items.map((job, index) => {
      const preview = escapeMarkdown(job.text.replace(/\s+/g, " ").trim().slice(0, 60) || "（无文字，仅附件）")
      return `${index + 1}. ${preview}`
    })
    const head = running ? "⏳ 当前任务执行中。" : "✅ 当前没有运行中的任务。"
    const body = lines.length > 0 ? `\n\n*排队中（${items.length}）*\n${lines.join("\n")}` : ""
    const keyboard = new InlineKeyboard()
    if (items.length > 0) {
      keyboard.text(`🧹 清空排队（${items.length}）`, "qclear")
      keyboard.row()
    }
    keyboard.text("🔄 刷新队列", "show:queue")
    return { text: `📋 *任务队列*\n${head}${body}`, keyboard }
  }

  async #handleStatus(chatId: number, key: string): Promise<void> {
    await this.#sendTextMessage(chatId, this.#statusText(chatId, key), this.#statusKeyboard())
  }

  async #handleUsage(chatId: number, key: string): Promise<void> {
    await this.#sendPanel(chatId, this.#usagePanel(key))
  }

  #usagePanel(key: string): Panel {
    const usage = this.#usage.summary(key)
    const keyboard = new InlineKeyboard().text("🔄 刷新统计", "show:usage").text("📊 运行状态", "show:status")

    if (usage.tasks === 0) {
      return {
        text: "📈 *使用统计*\n\n暂无任务记录。直接发送消息即可开始对话。",
        keyboard,
      }
    }

    const rate = Math.round((usage.ok / usage.tasks) * 100)
    const avg = Math.round(usage.totalMs / usage.tasks)
    const engine =
      usage.lastEngine === "qoder" ? "Qoder CLI" : usage.lastEngine === "opencode" ? "OpenCode" : usage.lastEngine
    const last = usage.lastAt
      ? `\n• 最近任务：${formatDateTime(usage.lastAt, this.#cfg.reminderTimezone)}` +
        `（${engine ?? "未知"}${usage.lastModel ? ` / ${escapeMarkdown(usage.lastModel)}` : ""}）`
      : ""
    return {
      text:
        `📈 *使用统计*\n\n` +
        `• 总任务：${usage.tasks}（成功 ${usage.ok} / 失败 ${usage.failed} / 取消 ${usage.cancelled}）\n` +
        `• 成功率：${rate}%\n` +
        `• 平均耗时：${formatDuration(avg)}\n` +
        `• 今日任务：${usage.today.tasks}（成功 ${usage.today.ok} / 失败 ${usage.today.failed} / 取消 ${usage.today.cancelled}）\n` +
        `• 引擎使用：OpenCode ${usage.engines.opencode} / Qoder ${usage.engines.qoder}` +
        last,
      keyboard,
    }
  }

  #statusText(chatId: number, key: string): string {
    const engine = this.#store.getEngine(key)
    const model =
      engine === "qoder"
        ? this.#store.getQoderModel(key) || "Qwen3.8-Flash (默认)"
        : this.#getCurrentModel(key).label
    const since = this.#runningSince.get(key)
    const depth = this.#queueDepth.get(key) ?? 0
    // #queueDepth includes the running job, so subtract it from the pending count
    const pending = Math.max(0, depth - (since ? 1 : 0))
    const running = since ? `运行中（已 ${formatDuration(Date.now() - since)}）` : "空闲"
    const reminders = this.#reminders.list(chatId).length
    const schedules = this.#schedules.count(chatId)
    const today = this.#usage.summary(key).today.tasks
    const proxy = this.#proxies.active()

    return (
      `📊 *运行状态*\n• 引擎: *${engine === "qoder" ? "Qoder CLI" : "OpenCode"}*\n• 模型: *${model}*\n` +
      `• 当前任务: ${running}\n• 待处理队列: ${pending} 条\n• 今日任务: ${today} 条\n` +
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
      .text("📋 查看队列", "show:queue")
      .text("🌐 网络代理", "show:proxy")
      .row()
      .text("🗓 定时任务", "show:schedule")
      .text("⏰ 我的提醒", "show:reminders")
  }

  async #handleRemind(chatId: number, userId: number, arg: string): Promise<void> {
    if (!arg) {
      await this.#sendTextMessage(
        chatId,
        "⏰ *设置提醒*\n\n用法：`/remind 30m 喝水`\n\n支持的时间格式：\n• `30s` / `10m` / `2h` / `1d` / `1h30m`\n• `18:30`（当天或次日）\n• `明天 08:30`\n• `every 30m` / `每30m`（重复提醒）\n• `每天 08:30`（每天固定时间）\n\n" +
          `当前时区：\`${this.#cfg.reminderTimezone}\`，最多同时保留 ${MAX_PER_CHAT} 条。`,
      )
      return
    }

    try {
      const reminder = this.#reminders.add(chatId, userId, arg)
      const when = formatReminderTime(reminder.dueAt, this.#cfg.reminderTimezone)
      const remaining = formatRemaining(reminder.dueAt - Date.now())
      const repeat = reminder.repeat ? `\n• 重复：${describeRepeat(reminder.repeat)}` : ""
      await this.#sendTextMessage(
        chatId,
        `⏰ *提醒已设置* #${reminder.id}\n• 时间：${when}（${this.#cfg.reminderTimezone}，约 ${remaining}后）${repeat}\n• 内容：${escapeMarkdown(reminder.text)}\n\n发送 \`/cancel ${reminder.id}\` 可取消。`,
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
          engine === "qoder"
            ? { engine, qoderModel: this.#store.getQoderModel(key) || "Qwen3.8-Flash" }
            : { engine, model: this.#getCurrentModel(key) }
        const task = this.#schedules.add(chatId, userId, input, defaults)
        const when = formatReminderTime(task.dueAt, this.#cfg.reminderTimezone)
        const remaining = formatRemaining(task.dueAt - Date.now())
        const repeat = task.repeat
          ? `\n• 重复：${describeRepeat(task.repeat)}`
          : "\n• 重复：不重复（执行后自动删除）"
        await this.#sendTextMessage(
          chatId,
          `🗓 *定时任务已创建* #${task.id}\n• 时间：${when}（${this.#cfg.reminderTimezone}，约 ${remaining}后）${repeat}\n` +
            `• 引擎：${escapeMarkdown(scheduleTargetLabel(task))}\n• 提示词：${escapeMarkdown(task.prompt)}\n\n` +
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
          "发送 `/schedule add 30m 检查服务器` 创建；支持 `every 2h`、`每天 09:00`，" +
          "可加 `--engine qoder --model deepseek` 指定执行引擎。",
        keyboard: keyboard.text("🔄 刷新", "show:schedule"),
      }
    }

    const now = Date.now()
    const lines: string[] = []
    let length = 0
    let shown = 0
    for (const item of items) {
      const state = item.paused ? "⏸" : "✅"
      const when = formatReminderTime(item.dueAt, this.#cfg.reminderTimezone)
      const whenText = item.paused ? when : `${when}（约 ${formatRemaining(item.dueAt - now)}后）`
      const repeat = item.repeat ? ` 🔁 ${describeRepeat(item.repeat)}` : ""
      const last = item.lastStatus
        ? `\n  上次：${item.lastStatus === "ok" ? "成功" : item.lastStatus === "cancelled" ? "已取消" : "失败"}`
        : ""
      const line = `${state} #${item.id} ${whenText}${repeat}\n  ${scheduleTargetLabel(item)}\n  ${escapeMarkdown(item.prompt)}${last}`
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
        .text(
          item.paused ? `▶️ 恢复 #${item.id}` : `⏸ 暂停 #${item.id}`,
          item.paused ? `sched:resume:${item.id}` : `sched:pause:${item.id}`,
        )
        .text(`🗑 删除 #${item.id}`, `sched:del:${item.id}`)
      if (index < items.length - 1) keyboard.row()
    })
    keyboard.row().text("🔄 刷新", "show:schedule")

    return {
      text:
        `🗓 *定时任务（${items.length}）*\n\n${lines.join("\n\n")}${more}\n\n` +
        "到点后自动执行并把结果发到这里。发送 `/schedule add ...` 新建。",
      keyboard,
    }
  }

  async #ensureCapacity(chatId: number, key: string): Promise<boolean> {
    // Exclude the running job so MAX_PENDING counts messages actually waiting
    const running = this.#runningSince.has(key) ? 1 : 0
    const waiting = (this.#queueDepth.get(key) ?? 0) - running
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

  #dispatch(job: Job): Promise<void> {
    const previous = this.#queues.get(job.key) ?? Promise.resolve()
    const run = previous.then(
      () => this.#process(job),
      () => this.#process(job),
    )

    this.#queues.set(job.key, run)
    this.#queueDepth.set(job.key, (this.#queueDepth.get(job.key) ?? 0) + 1)
    const pending = this.#pending.get(job.key) ?? []
    pending.push(job)
    this.#pending.set(job.key, pending)
    const cleanup = (): void => {
      const depth = (this.#queueDepth.get(job.key) ?? 1) - 1
      if (depth <= 0) this.#queueDepth.delete(job.key)
      else this.#queueDepth.set(job.key, depth)
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

  async #process(job: Job): Promise<void> {
    this.#dequeue(job)
    // Scheduled prompts are executed verbatim, even if they start with "/"
    const parts = job.scheduled ? [] : job.text.split(/\s+/)
    const rawCommand = parts[0]?.toLowerCase() ?? ""
    const command = rawCommand.split("@")[0]
    const arg = parts.slice(1).join(" ").trim()

    if (command === "/start") {
      await this.#sendTextMessage(job.chatId, this.#welcomeText(job.key, job.userId), this.#quickKeyboard())
      return
    }

    if (command === "/help") {
      await this.#sendTextMessage(job.chatId, HELP, this.#quickKeyboard())
      return
    }

    if (command === "/agent") {
      await this.#handleAgentCommand(job, arg || undefined)
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
        this.#store.setQoderSessionID(job.key, "")
      }
      await this.#sendTextMessage(job.chatId, `✨ *已开启新会话* (当前 Agent: \`${engine}\`)，对话上下文已清空。`)
      return
    }

    if (command === "/id") {
      const engine = this.#store.getEngine(job.key)
      const sessionID = this.#store.get(job.key)
      const qoderSessionID = this.#store.getQoderSessionID(job.key)
      const currentModel = this.#getCurrentModel(job.key)
      const currentQoderModel = this.#store.getQoderModel(job.key) || "Qwen3.8-Flash (默认)"

      let infoText =
        `🆔 *会话信息*\n• 聊天 ID: \`${job.chatId}\`\n• 用户 ID: \`${job.userId}\`\n` +
        `• 当前 Agent: *${engine === "qoder" ? "Qoder CLI" : "OpenCode"}*\n` +
        `• 提醒时区: \`${this.#cfg.reminderTimezone}\`\n`
      if (engine === "qoder") {
        infoText += `• Qoder 模型: *${currentQoderModel}*\n• Qoder 会话: \`${qoderSessionID || "未创建"}\``
      } else {
        infoText += `• OpenCode 模型: *${currentModel.label}*\n• 会话 ID: \`${sessionID || "暂未创建"}\``
      }
      await this.#sendTextMessage(job.chatId, infoText)
      return
    }

    if (command === "/model") {
      await this.#handleModelCommand(job, arg || undefined)
      return
    }

    if (command === "/retry") {
      const last = this.#lastPrompts.get(job.key)
      if (!last) {
        await this.#sendTextMessage(job.chatId, "⚠️ 还没有可重试的任务。")
        return
      }
      await this.#sendTextMessage(job.chatId, "🔁 已重新提交上一条任务。")
      await this.#process({
        ...job,
        text: last.text,
        attachments: last.attachments,
        generation: this.#generation.get(job.key) ?? 0,
      })
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

    this.#lastPrompts.set(job.key, { text: job.text, attachments: job.attachments })

    const engine = job.engine ?? this.#store.getEngine(job.key)
    const activeModel = engine === "qoder" ? undefined : (job.model ?? this.#getCurrentModel(job.key))
    const qoderModel =
      engine === "qoder" ? (job.qoderModel ?? this.#store.getQoderModel(job.key) ?? "Qwen3.8-Flash") : undefined
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
    let unsubscribeOc: (() => void) | undefined

    try {
      const input = job.attachments?.length
        ? await this.#buildAttachmentInput(job, activeModel)
        : { text: job.text, files: [] as PromptFile[] }
      const attachmentInfo = job.attachments?.length ? ` attachments=${job.attachments.length}` : ""
      let reply: string

      if (engine === "qoder") {
        this.#log.info(`prompt [${job.key}] (Qoder CLI) length=${input.text.length}${attachmentInfo}`)
        this.#log.debug(`prompt content: ${input.text.slice(0, 80).replace(/\n/g, " ")}`)
        reply = await this.#qoder.prompt(
          job.key,
          input.text,
          qoderModel,
          (status) => tracker.update(status),
          controller.signal,
        )
      } else {
        const model = activeModel!
        let sessionID = await this.#ensureSession(job.key)
        this.#log.info(`prompt [${job.key}] (OpenCode: ${model.label}) length=${input.text.length}${attachmentInfo}`)
        this.#log.debug(`prompt content: ${input.text.slice(0, 80).replace(/\n/g, " ")}`)

        let watchdogTrigger: (() => void) | undefined

        unsubscribeOc = this.#oc.subscribeSession(sessionID, (status) => {
          watchdogTrigger?.()
          tracker.update(status)
        })

        try {
          reply = await this.#prompt(sessionID, input.text, model, (touch) => {
            watchdogTrigger = touch
          }, controller.signal, input.files)
        } catch (err) {
          const missing = err instanceof OpencodeError && /-> 404:/.test(err.message)
          if (!missing) throw err
          this.#log.warn(`session ${sessionID} is gone, creating a new one`)
          this.#store.clearSession(job.key)
          sessionID = await this.#ensureSession(job.key)
          if (unsubscribeOc) unsubscribeOc()
          unsubscribeOc = this.#oc.subscribeSession(sessionID, (status) => {
            watchdogTrigger?.()
            tracker.update(status)
          })
          reply = await this.#prompt(sessionID, input.text, model, (touch) => {
            watchdogTrigger = touch
          }, controller.signal, input.files)
        }
      }

      typingActive = false
      void typingPromise
      if (unsubscribeOc) unsubscribeOc()
      await tracker.finish()

      await this.#sendReply(job, reply)
      outcome = "ok"
    } catch (err) {
      typingActive = false
      void typingPromise
      if (unsubscribeOc) unsubscribeOc()
      await tracker.finish()
      const detail = err instanceof Error ? err.message : String(err)
      if (/已取消当前任务/.test(detail)) {
        outcome = "cancelled"
        this.#log.info(`task cancelled [${job.key}]`)
        return
      }
      this.#log.error(`prompt failed [${job.key}]:`, detail)
      const hint =
        engine === "opencode" && /ECONNREFUSED|UND_ERR_SOCKET|fetch failed/i.test(detail)
          ? "\n\n请确认 opencode serve 已启动（npm run serve）。"
          : ""
      await this.#sendTextMessage(
        job.chatId,
        `抱歉，处理这条消息时出错了：\n${detail}${hint}`,
        new InlineKeyboard().text("🔁 重试", "retry"),
      )
    } finally {
      this.#usage.record(job.key, {
        engine,
        model: engine === "qoder" ? qoderModel ?? "Qwen3.8-Flash" : activeModel?.label,
        ms: Date.now() - taskStarted,
        outcome,
      })
      if (this.#cancels.get(job.key) === controller) this.#cancels.delete(job.key)
      this.#runningSince.delete(job.key)
      job.onOutcome?.(outcome)
    }
  }

  async #downloadAttachment(chatId: number, att: AttachmentDescriptor): Promise<SavedAttachment> {
    const file = await this.#bot.api.getFile(att.fileId)
    if (!file.file_path) throw new Error("Telegram 未返回文件路径（文件可能超过 20MB）")

    const res = await fetch(`https://api.telegram.org/file/bot${this.#cfg.telegram.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`)
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

  async #buildAttachmentInput(job: Job, model?: ModelRef): Promise<{ text: string; files: PromptFile[] }> {
    const saved: SavedAttachment[] = []
    const failed: string[] = []
    let totalBytes = 0

    for (const att of job.attachments ?? []) {
      if (totalBytes + (att.size ?? 0) > MAX_ATTACH_TOTAL_BYTES) {
        failed.push(`${att.name}: 附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
        continue
      }
      try {
        const item = await this.#downloadAttachment(job.chatId, att)
        if (totalBytes + item.bytes > MAX_ATTACH_TOTAL_BYTES) {
          failed.push(`${att.name}: 附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
          continue
        }
        totalBytes += item.bytes
        saved.push(item)
      } catch (err) {
        failed.push(`${att.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    pruneInbox(this.#cfg.inboxDir)

    const caps = model ? await this.#oc.inputCapabilities(model) : undefined
    const notes: string[] = []
    const blocks: string[] = []
    const files: PromptFile[] = []
    let inlineChars = 0

    for (const item of saved) {
      const rel = relative(process.cwd(), item.path).split(sep).join("/")
      const label = item.kind === "image" ? "图片" : item.kind === "audio" ? "音频" : "文件"
      notes.push(`- ${label}: ${rel} (${item.mime}, ${formatBytes(item.bytes)})`)

      if (item.text !== undefined) {
        if (inlineChars + item.text.length > MAX_INLINE_TEXT_TOTAL) {
          notes.push("  （文本内容过多，已跳过内联）")
          continue
        }
        inlineChars += item.text.length
        const suffix = item.truncated ? ' truncated="true"' : ""
        blocks.push(`<file name="${rel}"${suffix}>\n${item.text}\n</file>`)
        continue
      }

      const asFile = (): PromptFile => ({ mime: item.mime, filename: item.name, data: readFileSync(item.path) })
      if (item.kind === "image") {
        if (caps?.image && item.bytes <= MAX_ATTACH_FILE_BYTES) files.push(asFile())
        else notes.push(caps?.image ? "  （图片过大，未直接附加）" : "  （当前模型不支持图片输入，无法直接查看）")
      } else if (item.kind === "audio") {
        if (caps?.audio && item.bytes <= MAX_ATTACH_FILE_BYTES) files.push(asFile())
        else notes.push(caps?.audio ? "  （音频过大，未直接附加）" : "  （当前模型不支持音频输入，无法转写）")
      } else if (item.mime === "application/pdf") {
        if (caps?.pdf && item.bytes <= MAX_ATTACH_FILE_BYTES) files.push(asFile())
        else notes.push(caps?.pdf ? "  （PDF 过大，未直接附加）" : "  （当前模型不支持 PDF 输入，无法直接阅读）")
      }
    }

    const header =
      job.text ||
      (saved.some((item) => item.kind === "audio")
        ? "请转写这段音频并回应相关内容。"
        : saved.some((item) => item.kind === "image")
          ? "请查看用户发送的图片并回应。"
          : "请阅读用户发送的文件并回应。")

    const sections = [header]
    if (notes.length > 0) sections.push(`[用户附件]\n${notes.join("\n")}`)
    if (blocks.length > 0) sections.push(blocks.join("\n\n"))
    if (failed.length > 0) sections.push(`[附件处理失败]\n${failed.join("\n")}`)
    return { text: sections.join("\n\n"), files }
  }

  async #handleAgentCommand(job: Job, target?: string): Promise<void> {
    if (!target) {
      await this.#sendPanel(job.chatId, this.#agentPanel(job.key))
      return
    }

    const norm = target.toLowerCase()
    let chosen: BackendEngine | undefined

    if (norm === "qoder" || norm === "q") {
      chosen = "qoder"
    } else if (norm === "opencode" || norm === "oc" || norm === "open") {
      chosen = "opencode"
    }

    if (!chosen) {
      await this.#sendTextMessage(job.chatId, `❌ 未识别的 Agent 引擎：\`${target}\`\n\n可选：\`/agent opencode\` 或 \`/agent qoder\``)
      return
    }

    this.#store.setEngine(job.key, chosen)
    this.#log.info(`agent switched [${job.key}] -> ${chosen}`)

    if (chosen === "qoder") {
      await this.#sendTextMessage(
        job.chatId,
        `✅ *已切换至 Qoder Agent 引擎！*\n\n当前直接由本地已登录的 Qoder CLI 驱动，具备强大的代码阅读/编写/重构能力。\n\n提示：你可以直接对 Qoder 提问，若需换模型可使用 \`/model deepseek\` 或 \`/model qwen\`。`,
      )
    } else {
      await this.#sendTextMessage(
        job.chatId,
        `✅ *已切换至 OpenCode Agent 引擎！*\n\n当前由 OpenCode 提供服务，支持 Claude 3.5/3.7 Sonnet、Gemini 3.8、Grok、工具调用与多媒体交互。\n发送 \`/model\` 可随心切换底层模型。`,
      )
    }
  }

  async #handleModelCommand(job: Job, arg?: string): Promise<void> {
    const engine = this.#store.getEngine(job.key)

    // Handle Qoder models
    if (engine === "qoder") {
      if (!arg) {
        await this.#sendPanel(job.chatId, this.#modelPanel(job.key))
        return
      }

      const selectedModel = resolveQoderModel(arg)
      if (!selectedModel) {
        await this.#sendTextMessage(job.chatId, `❌ Qoder 仅支持 \`deepseek\` 和 \`qwen\` 两个选项。`)
        return
      }

      if ((this.#store.getQoderModel(job.key) || "Qwen3.8-Flash") === selectedModel) {
        await this.#sendTextMessage(job.chatId, `✅ 当前已经是 *${selectedModel}*，无需切换，会话上下文保持不变。`)
        return
      }

      this.#applyQoderModel(job.key, selectedModel)
      await this.#sendTextMessage(job.chatId, `✅ *Qoder 模型已切换为：${selectedModel}* (已开启新会话上下文)`)
      return
    }

    // Handle OpenCode models
    if (!arg) {
      await this.#sendPanel(job.chatId, this.#modelPanel(job.key))
      return
    }

    const targetKey = resolveModelKey(arg)
    const targetModel = targetKey ? AVAILABLE_MODELS[targetKey] : undefined

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
        `✅ 当前已经是 *${targetModel.label}*，无需切换，会话上下文保持不变。`,
      )
      return
    }

    await this.#applyOpenCodeModel(job.key, targetModel)
    await this.#sendTextMessage(
      job.chatId,
      `✅ *已成功切换模型！*\n\n当前模型：*${targetModel.label}*\n_${targetModel.desc}_\n\n已自动重置会话上下文，你可以直接开始向新模型提问了。`,
    )
  }

  async #applyOpenCodeModel(key: string, target: ModelInfo): Promise<void> {
    this.#store.setModel(key, {
      providerID: target.providerID,
      modelID: target.modelID,
      label: target.label,
    })
    this.#log.info(`model switched [${key}] -> ${target.label} (${target.providerID}/${target.modelID})`)

    const oldSession = this.#store.get(key)
    if (oldSession) {
      await this.#oc.deleteSession(oldSession).catch(() => {})
      this.#store.clearSession(key)
    }
  }

  #applyQoderModel(key: string, label: string): void {
    this.#store.setQoderModel(key, label)
    this.#store.setQoderSessionID(key, "")
    this.#log.info(`qoder model switched [${key}] -> ${label}`)
  }

  #welcomeText(key: string, userId: number): string {
    const engine = this.#store.getEngine(key)
    const model = engine === "qoder" ? this.#store.getQoderModel(key) || "Qwen3.8-Flash" : this.#getCurrentModel(key).label
    return (
      `👋 *欢迎使用 AI 私人助手*\n\n• 用户 ID：\`${userId}\`\n` +
      `• 引擎：*${engine === "qoder" ? "Qoder CLI" : "OpenCode"}*\n• 模型：*${model}*\n\n` +
      `*直接发消息即可对话：*\n• 代码编写、分析与调试\n• 发送图片、文件、语音（文本文件会读取内容）\n` +
      `• 发送 \`/remind 30m 喝水\` 设定提醒\n• 发送 \`/schedule add 30m 检查服务器\` 定时执行 AI 任务\n\n` +
      `_仅响应私聊消息，发送 /help 查看完整命令。_`
    )
  }

  #quickKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🤖 切换引擎", "show:agent")
      .text("🧠 切换模型", "show:model")
      .row()
      .text("🗓 定时任务", "show:schedule")
      .text("⏰ 我的提醒", "show:reminders")
      .row()
      .text("📈 使用统计", "show:usage")
      .text("🌐 网络代理", "show:proxy")
  }

  #agentPanel(key: string): Panel {
    const current = this.#store.getEngine(key)
    const keyboard = new InlineKeyboard()
      .text(`${current === "opencode" ? "✅ " : ""}OpenCode`, "agent:opencode")
      .text(`${current === "qoder" ? "✅ " : ""}Qoder CLI`, "agent:qoder")
      .row()
      .text("🧠 选择模型", "show:model")
    const text =
      `🤖 *Agent 引擎*\n\n当前：*${current === "qoder" ? "Qoder CLI" : "OpenCode"}*\n\n` +
      `• *OpenCode*：多模型、工具调用、附件收发\n` +
      `• *Qoder CLI*：本地编程助手（DeepSeek / Qwen）\n\n` +
      `点击下方按钮切换：`
    return { text, keyboard }
  }

  #modelPanel(key: string): Panel {
    if (this.#store.getEngine(key) === "qoder") {
      const current = this.#store.getQoderModel(key) || "Qwen3.8-Flash"
      const keyboard = new InlineKeyboard()
        .text(`${current === "DeepSeek-Flash" ? "✅ " : ""}DeepSeek-Flash`, "qmodel:deepseek")
        .text(`${current === "Qwen3.8-Flash" ? "✅ " : ""}Qwen3.8-Flash`, "qmodel:qwen")
        .row()
        .text("🤖 切换引擎", "show:agent")
      const text =
        `🧠 *Qoder 模型*\n\n当前：*${current}*\n\n` +
        `点击下方按钮切换，切换后会重置当前会话上下文。\n` +
        `若想使用 Claude / Gemini / Grok，请先发送 \`/agent opencode\`。`
      return { text, keyboard }
    }

    const current = this.#getCurrentModel(key)
    const currentInfo = Object.values(AVAILABLE_MODELS).find(
      (item) => item.providerID === current.providerID && item.modelID === current.modelID,
    )
    const keyboard = new InlineKeyboard()
    const models = Object.entries(AVAILABLE_MODELS)
    models.forEach(([modelKey, info], index) => {
      const isCurrent = info.providerID === current.providerID && info.modelID === current.modelID
      keyboard.text(`${isCurrent ? "✅ " : ""}${info.label}`, `model:${modelKey}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (models.length % 2 === 1) keyboard.row()
    keyboard.text("🤖 切换引擎", "show:agent")
    const text =
      `🧠 *OpenCode 模型*\n\n当前：*${current.label}*` +
      `${currentInfo ? `\n_${currentInfo.desc}_` : ""}\n\n` +
      `点击下方按钮切换，或发送 \`/model 简称\`。\n切换后会重置当前会话上下文。`
    return { text, keyboard }
  }

  #remindersPanel(chatId: number): Panel {
    const items = this.#reminders.list(chatId)
    if (items.length === 0) {
      return {
        text: "📭 *暂无待触发的提醒*\n\n发送 `/remind 30m 喝水` 即可创建。",
        keyboard: new InlineKeyboard(),
      }
    }

    const now = Date.now()
    const lines: string[] = []
    let length = 0
    let shown = 0
    for (const item of items) {
      const when = formatReminderTime(item.dueAt, this.#cfg.reminderTimezone)
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

    return {
      text: `⏰ *待触发的提醒（${items.length}）*\n\n${lines.join("\n\n")}${more}\n\n点击按钮取消，或发送 \`/cancel 编号\`。`,
      keyboard,
    }
  }

  async #sendPanel(chatId: number, panel: Panel): Promise<void> {
    await this.#sendTextMessage(chatId, panel.text, panel.keyboard)
  }

  async #editPanel(ctx: Context, panel: Panel): Promise<void> {
    try {
      await ctx.editMessageText(panel.text, { parse_mode: "Markdown", reply_markup: panel.keyboard })
    } catch {
      await ctx.editMessageText(panel.text, { reply_markup: panel.keyboard }).catch(() => {})
    }
  }

  #getCurrentModel(key: string): { providerID: string; modelID: string; label: string } {
    const saved = this.#store.getModel(key)
    if (saved) return saved

    if (this.#cfg.opencode.model) {
      return {
        providerID: this.#cfg.opencode.model.providerID,
        modelID: this.#cfg.opencode.model.modelID,
        label: this.#cfg.opencode.model.modelID,
      }
    }

    // Default to Gemini 3.8 Flash
    return {
      providerID: AVAILABLE_MODELS.gemini!.providerID,
      modelID: AVAILABLE_MODELS.gemini!.modelID,
      label: AVAILABLE_MODELS.gemini!.label,
    }
  }

  async #deliverReminder(chatId: number, text: string): Promise<void> {
    const ok = await this.#sendTextMessage(chatId, text)
    if (!ok) throw new Error("Telegram 发送失败")
  }

  async #executeScheduled(task: ScheduledTask): Promise<UsageOutcome> {
    const key = `tg:${task.chatId}`
    const repeat = task.repeat ? `（${describeRepeat(task.repeat)}）` : ""
    this.#log.info(`scheduled task #${task.id} dispatching [${key}] (${scheduleTargetLabel(task)})`)
    await this.#sendTextMessage(
      task.chatId,
      `🗓 *定时任务 #${task.id} 已触发*${repeat}\n` +
        `• 引擎：${escapeMarkdown(scheduleTargetLabel(task))}\n` +
        `• 提示词：${escapeMarkdown(task.prompt.slice(0, 120))}\n\n正在执行…`,
    )

    return new Promise<UsageOutcome>((resolve) => {
      void this.#dispatch({
        key,
        text: task.prompt,
        chatId: task.chatId,
        userId: task.userId,
        generation: this.#generation.get(key) ?? 0,
        scheduled: true,
        engine: task.engine,
        model: task.model ? { ...task.model } : undefined,
        qoderModel: task.qoderModel,
        onOutcome: resolve,
      }).catch(() => resolve("failed"))
    })
  }

  async #sendTextMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    const markup = keyboard && keyboard.inline_keyboard.length > 0 ? keyboard : undefined
    try {
      await this.#bot.api.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup })
      return true
    } catch {
      // Graceful fallback to plain text if Markdown parsing fails
      try {
        await this.#bot.api.sendMessage(chatId, text, { reply_markup: markup })
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
      const detail = err instanceof Error ? err.message : String(err)
      this.#log.error(`media failed [${job.key}] ${part.kind}:`, detail)
      await this.#sendTextMessage(job.chatId, `⚠️ ${mediaLabel(part.kind)}发送失败：${detail}`)
    }
  }

  async #fetchRemoteMedia(target: string): Promise<Buffer> {
    let current = target
    for (let hop = 0; ; hop++) {
      const url = await assertUrlAllowed(current, this.#cfg.mediaAllowPrivateUrls)
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
      }
      const dispatcher = this.#proxies.dispatcher()
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
        throw new Error(`无法获取远程地址 (HTTP ${res.status}): ${target}`)
      }
      return this.#readCappedBody(res)
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

  #prompt(
    sessionID: string,
    text: string,
    modelOverride?: { providerID: string; modelID: string },
    onActivityHook?: (touch: () => void) => void,
    signal?: AbortSignal,
    files?: PromptFile[],
  ): Promise<string> {
    return this.#oc.prompt(sessionID, text, {
      agent: this.#cfg.opencode.agent,
      model: modelOverride ?? this.#cfg.opencode.model,
      idleTimeoutMs: this.#cfg.taskTimeoutMs,
      maxTimeoutMs: this.#cfg.taskMaxTimeoutMs,
      onActivityHook,
      signal,
      files,
    })
  }

  async #ensureSession(key: string): Promise<string> {
    const existing = this.#store.get(key)
    if (existing) return existing

    const sessionID = await this.#oc.createSession(`Telegram ${key}`)
    this.#store.set(key, sessionID)
    return sessionID
  }
}
