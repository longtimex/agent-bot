import { InlineKeyboard } from "grammy"
import type { Bot } from "grammy"

export class ProgressTracker {
  readonly #bot: Bot
  readonly #chatId: number
  readonly #startTime = Date.now()
  #statusMessageId: number | null = null
  #currentStatus = "正在初始化环境..."
  #recentSteps: string[] = []
  #timer: NodeJS.Timeout | null = null
  #lastSentText = ""
  #disposed = false
  #rendering = false

  constructor(bot: Bot, chatId: number) {
    this.#bot = bot
    this.#chatId = chatId

    this.#timer = setInterval(() => {
      this.#render().catch(() => {})
    }, 2000)
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
    const elapsedSec = Math.floor((Date.now() - this.#startTime) / 1000)
    // Only display progress card if processing takes more than 2 seconds
    if (elapsedSec < 2) return

    const formatTime = (sec: number): string => {
      const m = Math.floor(sec / 60)
      const s = sec % 60
      return `${m > 0 ? `${m}m ` : ""}${s}s`
    }

    const stepsText = this.#recentSteps.map((s) => `• \`${this.#escape(s)}\``).join("\n")
    const text = `⏳ *正在处理任务...* (已耗时 ${formatTime(elapsedSec)})\n\n${stepsText ? `${stepsText}\n\n` : ""}🔄 当前状态：_${this.#escape(this.#currentStatus)}_\n\n_系统后台正在全自动执行中，请稍候..._`

    if (text === this.#lastSentText) return

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
        this.#lastSentText = text
      } else {
        await this.#bot.api.editMessageText(this.#chatId, this.#statusMessageId, text, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        })
        this.#lastSentText = text
      }
    } catch {
      // Ignore Telegram rate limits or formatting glitches
    } finally {
      this.#rendering = false
    }
  }

  #escape(str: string): string {
    return str.replace(/[_*`\[\]]/g, " ").slice(0, 80)
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
