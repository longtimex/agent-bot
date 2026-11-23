import { randomBytes } from "node:crypto"
import { InlineKeyboard } from "grammy"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
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
  sendText(chatId: number, text: string, keyboard?: InlineKeyboard, signal?: AbortSignal): Promise<boolean>
  snooze(chatId: number, userId: number, text: string, minutes: number): Reminder
  /**
   * Where the snooze tokens persist. Without it they lived only in memory, so every restart or
   * /update turned the buttons on the reminders already sent into "该按钮已过期" while the
   * card still promised a 24-hour window. Omit it (tests) to keep the old in-memory behaviour.
   */
  path?: string
  warn?: (message: string) => void
  now?: () => number
}

function isPending(value: unknown): value is PendingSnooze {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    Number.isFinite(record.chatId) &&
    Number.isFinite(record.userId) &&
    typeof record.text === "string" &&
    record.text.length <= 500 &&
    Number.isFinite(record.createdAt)
  )
}

/** Delivers due reminders and owns the one-tap snooze tokens on their cards. */
export class ReminderDelivery {
  readonly #deps: ReminderDeliveryDeps
  readonly #pending = new Map<string, PendingSnooze>()

  constructor(deps: ReminderDeliveryDeps) {
    this.#deps = deps
    this.#load()
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  async deliver(chatId: number, text: string, reminder?: Reminder, signal?: AbortSignal): Promise<void> {
    // Reminder bodies are user text: an unescaped * _ ` [ would fail the Markdown parse
    // and lose the formatting of the whole message
    let keyboard: InlineKeyboard | undefined
    if (reminder && !reminder.repeat && reminder.text.length <= 500) {
      // One-shot reminders can be re-armed from the delivery message; repeating ones
      // already have a next occurrence, and long texts would bloat the token cache
      const token = randomBytes(6).toString("hex")
      this.#pending.set(token, { chatId, userId: reminder.userId, text: reminder.text, createdAt: this.#now() })
      this.#prune()
      this.#save()
      keyboard = new InlineKeyboard()
        .text("⏰ 10分钟", `snooze:${token}:10`)
        .text("⏰ 1小时", `snooze:${token}:60`)
        .row()
        .text("⏰ 明天这个时候", `snooze:${token}:1440`)
    }
    const ok = await this.#deps.sendText(chatId, escapeMarkdown(text), keyboard, signal)
    if (!ok) throw new Error("消息发送失败")
  }

  async snooze(chatId: number, token: string, minutes: number, answer: (text?: string) => Promise<void>): Promise<void> {
    const pending = this.#pending.get(token)
    if (!pending || pending.chatId !== chatId || pending.createdAt < this.#now() - SNOOZE_TTL_MS) {
      await answer("该按钮已过期")
      return
    }
    // Consumed before the snooze runs and persisted at once: a double tap, or a second bot
    // reading the same file after a restart, must not arm the same reminder twice
    this.#pending.delete(token)
    this.#save()
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
    const cutoff = this.#now() - SNOOZE_TTL_MS
    for (const [token, pending] of this.#pending) {
      if (pending.createdAt < cutoff || this.#pending.size > MAX_PENDING_SNOOZES) this.#pending.delete(token)
    }
  }

  #load(): void {
    const path = this.#deps.path
    if (!path) return
    const raw = readJsonObject(path, (message) => this.#deps.warn?.(message))
    const tokens = raw?.tokens
    if (!tokens || typeof tokens !== "object") return
    for (const [token, value] of Object.entries(tokens as Record<string, unknown>)) {
      // Tokens are 12 hex chars; anything else is a hand-edited or foreign entry
      if (/^[0-9a-f]{12}$/.test(token) && isPending(value)) this.#pending.set(token, value)
    }
    this.#prune()
  }

  #save(): void {
    const path = this.#deps.path
    if (!path) return
    try {
      const tokens = Object.fromEntries(this.#pending)
      writePrivateAtomic(path, `${JSON.stringify({ version: 1, tokens })}\n`)
    } catch (err) {
      // A button that cannot survive a restart is worse than ideal, not a failed delivery
      this.#deps.warn?.(`failed to persist reminder snooze buttons: ${(err as Error).message}`)
    }
  }
}
