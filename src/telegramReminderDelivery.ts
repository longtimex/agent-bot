import { randomBytes } from "node:crypto"
import { InlineKeyboard } from "grammy"
import { clip, escapeMarkdown } from "./messages.js"
import { type Reminder } from "./reminders.js"
import { describeRemainingLabel } from "./telegramSupport.js"

const MAX_PENDING_SNOOZES = 500
const SNOOZE_TTL_MS = 24 * 3_600_000

interface PendingSnooze {
  chatId: number
  userId: number
  text: string
  createdAt: number
}

export interface ReminderDeliveryDeps {
  sendText(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>
  snooze(chatId: number, userId: number, text: string, minutes: number): Reminder
}

/** Delivers due reminders and owns the one-tap snooze tokens on their cards. */
export class ReminderDelivery {
  readonly #deps: ReminderDeliveryDeps
  readonly #pending = new Map<string, PendingSnooze>()

  constructor(deps: ReminderDeliveryDeps) {
    this.#deps = deps
  }

  async deliver(chatId: number, text: string, reminder?: Reminder): Promise<void> {
    // Reminder bodies are user text: an unescaped * _ ` [ would fail the Markdown parse
    // and lose the formatting of the whole message
    let keyboard: InlineKeyboard | undefined
    if (reminder && !reminder.repeat && reminder.text.length <= 500) {
      // One-shot reminders can be re-armed from the delivery message; repeating ones
      // already have a next occurrence, and long texts would bloat the token cache
      const token = randomBytes(6).toString("hex")
      this.#pending.set(token, { chatId, userId: reminder.userId, text: reminder.text, createdAt: Date.now() })
      this.#prune()
      keyboard = new InlineKeyboard()
        .text("⏰ 10分钟", `snooze:${token}:10`)
        .text("⏰ 1小时", `snooze:${token}:60`)
        .row()
        .text("⏰ 明天这个时候", `snooze:${token}:1440`)
    }
    const ok = await this.#deps.sendText(chatId, escapeMarkdown(text), keyboard)
    if (!ok) throw new Error("消息发送失败")
  }

  async snooze(chatId: number, token: string, minutes: number, answer: (text?: string) => Promise<void>): Promise<void> {
    const pending = this.#pending.get(token)
    if (!pending || pending.chatId !== chatId) {
      await answer("该按钮已过期")
      return
    }
    this.#pending.delete(token)
    try {
      const reminder = this.#deps.snooze(chatId, pending.userId, pending.text, minutes)
      await answer("已安排稍后提醒")
      await this.#deps.sendText(
        chatId,
        `⏰ 好的，${escapeMarkdown(describeRemainingLabel(minutes))}后再提醒你：${escapeMarkdown(clip(reminder.text, 120) ?? "")}`,
      )
    } catch (err) {
      await answer(err instanceof Error ? err.message : "稍后提醒失败")
    }
  }

  /** Keeps the snooze token cache bounded: 500 entries or 24h, whichever first. */
  #prune(): void {
    const cutoff = Date.now() - SNOOZE_TTL_MS
    for (const [token, pending] of this.#pending) {
      if (pending.createdAt < cutoff || this.#pending.size > MAX_PENDING_SNOOZES) this.#pending.delete(token)
    }
  }
}
