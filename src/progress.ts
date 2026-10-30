import { InlineKeyboard } from "grammy"
import type { Bot } from "grammy"
import { clip } from "./messages.js"

/**
 * Telegram tells us the target message is gone (400 "message to edit not
 * found") when the card was deleted or pruned. Flood/retry-after errors are
 * deliberately excluded: the card still exists there, so re-sending it would
 * post a duplicate.
 */
function lostCard(err: unknown): boolean {
  const code = (err as { error_code?: unknown }).error_code
  if (code !== 400 && code !== 403 && code !== 404) return false
  const description = String((err as { description?: unknown }).description ?? "").toLowerCase()
  return (
    description.includes("message to edit not found") ||
    description.includes("message can't be edited") ||
    description.includes("message deleted") ||
    description.includes("chat not found")
  )
}

/** 429/420, plus the 400 variant Telegram sometimes returns for an edit flood. */
function floodLimited(err: unknown): boolean {
  const code = (err as { error_code?: unknown }).error_code
  if (code !== 429 && code !== 420 && code !== 400) return false
  return /too many requests|retry after|flood/i.test(String((err as { description?: unknown }).description ?? ""))
}

function floodBackoffMs(err: unknown): number {
  const raw = (err as { parameters?: { retry_after?: unknown } }).parameters?.retry_after
  const seconds = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 + 500 : DEFAULT_FLOOD_BACKOFF_MS
}

const RENDER_INTERVAL_MS = 2_000
/** The elapsed counter is cosmetic; re-sending the card for it alone wastes the edit budget. */
const TICK_REFRESH_MS = 30_000
const DEFAULT_FLOOD_BACKOFF_MS = 15_000

export class ProgressTracker {
  readonly #bot: Bot
  readonly #chatId: number
  readonly #startTime = Date.now()
  #statusMessageId: number | null = null
  #currentStatus = "正在初始化环境..."
  #recentSteps: string[] = []
  #timer: NodeJS.Timeout | null = null
  #lastSentBody = ""
  #lastSentAt = 0
  #mutedUntil = 0
  #disposed = false
  #rendering = false

  constructor(bot: Bot, chatId: number) {
    this.#bot = bot
    this.#chatId = chatId

    this.#timer = setInterval(() => {
      this.#render().catch(() => {})
    }, RENDER_INTERVAL_MS)
  }

  update(step: string): void {
    if (this.#disposed) return
    this.#currentStatus = step
    if (!this.#recentSteps.includes(step)) {
      this.#recentSteps.push(step)
      if (this.#recentSteps.length > 3) this.#recentSteps.shift()
    }
  }

  async #render(): Promise<void> {
    // Skip when disposed, and never overlap renders (two sends would leave an orphan card)
    if (this.#disposed || this.#rendering) return
    const now = Date.now()
    if (now < this.#mutedUntil) return
    const elapsedSec = Math.floor((now - this.#startTime) / 1000)
    // Only display progress card if processing takes more than 2 seconds
    if (elapsedSec < 2) return

    const formatTime = (sec: number): string => {
      const m = Math.floor(sec / 60)
      const s = sec % 60
      return `${m > 0 ? `${m}m ` : ""}${s}s`
    }

    const stepsText = this.#recentSteps.map((s) => `• \`${this.#escape(s)}\``).join("\n")
    const body = `${stepsText ? `${stepsText}\n\n` : ""}🔄 当前状态：_${this.#escape(this.#currentStatus)}_`
    const text = `⏳ *正在处理任务...* (已耗时 ${formatTime(elapsedSec)})\n\n${body}\n\n_系统后台正在全自动执行中，请稍候..._`

    // Re-sending identical text only to move the elapsed counter would spend the
    // chat's edit budget on nothing and is what triggers the flood limit
    if (body === this.#lastSentBody && now - this.#lastSentAt < TICK_REFRESH_MS) return

    this.#rendering = true
    try {
      const keyboard = new InlineKeyboard().text("🛑 停止任务", "task:stop")
      if (this.#statusMessageId === null) {
        const msg = await this.#bot.api.sendMessage(this.#chatId, text, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        })
        if (this.#disposed) {
          await this.#bot.api.deleteMessage(this.#chatId, msg.message_id).catch(() => {})
          return
        }
        this.#statusMessageId = msg.message_id
      } else {
        await this.#bot.api.editMessageText(this.#chatId, this.#statusMessageId, text, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        })
      }
      this.#lastSentBody = body
      this.#lastSentAt = now
    } catch (err) {
      // The card can disappear (deleted by the user, pruned with the chat) or a
      // Markdown glitch can reject the edit. Without a reset every later edit
      // would fail against the same dead id and the task would run unreported.
      if (this.#statusMessageId !== null && lostCard(err)) {
        this.#statusMessageId = null
        this.#lastSentBody = ""
      } else if (floodLimited(err)) {
        // Without a backoff every 2 s tick hits the same limit and the card stays
        // frozen for the rest of the run
        this.#mutedUntil = Date.now() + floodBackoffMs(err)
      }
    } finally {
      this.#rendering = false
    }
  }

  #escape(str: string): string {
    // Backslash is stripped too: legacy Markdown treats it as an escape character,
    // and one stray `\` before punctuation makes the whole send fail to parse
    return clip(str.replace(/[_*`\[\]\\]/g, " "), 80) ?? ""
  }

  async finish(): Promise<void> {
    this.#disposed = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (this.#statusMessageId !== null) {
      await this.#bot.api.deleteMessage(this.#chatId, this.#statusMessageId).catch(() => {})
      this.#statusMessageId = null
    }
  }
}
