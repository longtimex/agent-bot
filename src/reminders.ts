import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "./logger.js"

export const DEFAULT_TIMEZONE = "Asia/Shanghai"
export const MAX_PER_CHAT = 20

const MIN_DELAY_MS = 10_000
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000
const MAX_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TEXT_LENGTH = 500
const TICK_MS = 15_000
const SEND_TIMEOUT_MS = 20_000
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
const MAX_ATTEMPTS = 8

export type ReminderRepeat =
  | { type: "interval"; ms: number }
  | { type: "daily"; hour: number; minute: number }

export interface Reminder {
  id: number
  chatId: number
  userId: number
  text: string
  dueAt: number
  createdAt: number
  attempts?: number
  retryAt?: number
  repeat?: ReminderRepeat
}

interface ReminderFile {
  nextId: number
  reminders: Reminder[]
}

export interface ParsedReminder {
  dueAt: number
  text: string
  repeat?: ReminderRepeat
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function zonedParts(timestamp: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts: Record<string, string> = {}
  for (const part of fmt.formatToParts(timestamp)) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

function offsetMs(timestamp: number, timeZone: string): number {
  const parts = zonedParts(timestamp, timeZone)
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUTC - Math.floor(timestamp / 1000) * 1000
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const offset = offsetMs(guess, timeZone)
  return guess - offsetMs(guess - offset, timeZone)
}

function absoluteDue(hour: number, minute: number, now: number, timeZone: string, tomorrow: boolean): number {
  const parts = zonedParts(now, timeZone)
  let dueAt = zonedToUtc(parts.year, parts.month, parts.day + (tomorrow ? 1 : 0), hour, minute, timeZone)
  if (!tomorrow && dueAt <= now + 1_000) {
    dueAt = zonedToUtc(parts.year, parts.month, parts.day + 1, hour, minute, timeZone)
  }
  return dueAt
}

function validateDelay(ms: number, label = "提醒"): void {
  if (!Number.isFinite(ms) || ms < MIN_DELAY_MS) {
    throw new Error(`${label}时间至少需要 10 秒之后。`)
  }
  if (ms > MAX_DELAY_MS) {
    throw new Error(`${label}时间不能超过 365 天。`)
  }
}

function validateClock(hour: number, minute: number): void {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("时间格式应为 HH:MM（00:00 - 23:59）。")
  }
}

export function formatReminderTime(dueAt: number, timeZone = DEFAULT_TIMEZONE): string {
  const parts = zonedParts(dueAt, timeZone)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

function describeInterval(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

export function describeRepeat(repeat: ReminderRepeat): string {
  if (repeat.type === "daily") {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `每天 ${pad(repeat.hour)}:${pad(repeat.minute)}`
  }
  return `每 ${describeInterval(repeat.ms)}`
}

export function nextReminderDue(
  reminder: Pick<Reminder, "dueAt" | "repeat">,
  now: number,
  timeZone = DEFAULT_TIMEZONE,
): number | undefined {
  const repeat = reminder.repeat
  if (!repeat) return undefined
  if (repeat.type === "daily") return absoluteDue(repeat.hour, repeat.minute, now, timeZone, false)
  if (reminder.dueAt > now) return reminder.dueAt
  // Skip occurrences missed while the bot was offline instead of replaying them all
  const steps = Math.floor((now - reminder.dueAt) / repeat.ms) + 1
  return reminder.dueAt + steps * repeat.ms
}

export function sanitizeRepeat(value: unknown): ReminderRepeat | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (
    record.type === "interval" &&
    typeof record.ms === "number" &&
    Number.isFinite(record.ms) &&
    record.ms >= MIN_DELAY_MS
  ) {
    return { type: "interval", ms: record.ms }
  }
  if (record.type === "daily" && Number.isInteger(record.hour) && Number.isInteger(record.minute)) {
    const hour = record.hour as number
    const minute = record.minute as number
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { type: "daily", hour, minute }
    }
  }
  return undefined
}

const DURATION_TOKEN = /^(?:\d+[smhd])+$/i

function durationMs(token: string): number {
  let ms = 0
  for (const match of token.matchAll(/(\d+)([smhd])/gi)) {
    const value = Number(match[1])
    const unit = (match[2] ?? "").toLowerCase()
    ms += value * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000)
  }
  return ms
}

export interface ParseReminderOptions {
  maxTextLength?: number
  /** Command shown in usage errors, e.g. "/remind". */
  command?: string
  /** Noun shown in usage errors, e.g. "提醒". */
  label?: string
}

export function parseReminder(
  input: string,
  now = Date.now(),
  timeZone = DEFAULT_TIMEZONE,
  options: ParseReminderOptions = {},
): ParsedReminder {
  const command = options.command ?? "/remind"
  const label = options.label ?? "提醒"
  const maxTextLength = options.maxTextLength ?? MAX_TEXT_LENGTH
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  const first = tokens[0]
  if (!first) throw new Error(`用法：${command} 30m 喝水`)

  const usage =
    "支持：30s / 10m / 2h / 1d / 1h30m / 18:30 / 明天 08:30 / every 30m / 每天 08:30"
  const requireText = (text: string): string => {
    const value = text.trim()
    if (!value) throw new Error(`请补充${label}内容，例如：${command} 30m 喝水`)
    if (value.length > maxTextLength) throw new Error(`${label}内容不能超过 ${maxTextLength} 字。`)
    return value
  }

  // 每天 08:30 / 每日 08:30 / 每天08:30
  if (first === "每天" || first === "每日" || /^每[天日]\d{1,2}:\d{2}$/.test(first)) {
    const clockToken = first === "每天" || first === "每日" ? (tokens[1] ?? "") : first.replace(/^每[天日]/, "")
    const match = /^(\d{1,2}):(\d{2})$/.exec(clockToken)
    if (!match) throw new Error(`每日${label}的格式应为：${command} 每天 08:30 打卡`)
    const hour = Number(match[1])
    const minute = Number(match[2])
    validateClock(hour, minute)
    const textStart = first === "每天" || first === "每日" ? 2 : 1
    const dueAt = absoluteDue(hour, minute, now, timeZone, false)
    validateDelay(dueAt - now, label)
    return {
      dueAt,
      text: requireText(tokens.slice(textStart).join(" ")),
      repeat: { type: "daily", hour, minute },
    }
  }

  // every 30m / 每30m / 每隔30m
  const isEveryWord = first.toLowerCase() === "every"
  const isChineseEvery = /^每(?:隔)?(?:\d+[smhd])+$/i.test(first)
  if (isEveryWord || isChineseEvery) {
    const durationToken = isEveryWord ? (tokens[1] ?? "") : first.replace(/^每(?:隔)?/i, "")
    const textStart = isEveryWord ? 2 : 1
    if (!DURATION_TOKEN.test(durationToken)) {
      throw new Error(`重复${label}的格式应为：${command} every 30m 喝水 或 ${command} 每天 08:30 打卡`)
    }
    const ms = durationMs(durationToken)
    validateDelay(ms, label)
    return {
      dueAt: now + ms,
      text: requireText(tokens.slice(textStart).join(" ")),
      repeat: { type: "interval", ms },
    }
  }

  // 明天 08:30 / 明天08:30
  if (first === "明天" || first === "明日" || /^明[天日]\d{1,2}:\d{2}$/.test(first)) {
    const clockToken = first === "明天" || first === "明日" ? (tokens[1] ?? "") : first.replace(/^明[天日]/, "")
    const match = /^(\d{1,2}):(\d{2})$/.exec(clockToken)
    if (!match) throw new Error(`明天${label}的格式应为：${command} 明天 08:30 内容`)
    const hour = Number(match[1])
    const minute = Number(match[2])
    validateClock(hour, minute)
    const textStart = first === "明天" || first === "明日" ? 2 : 1
    const text = requireText(tokens.slice(textStart).join(" "))
    return { dueAt: absoluteDue(hour, minute, now, timeZone, true), text }
  }

  // 30s / 10m / 2h / 1d / 1h30m
  if (DURATION_TOKEN.test(first)) {
    const ms = durationMs(first)
    validateDelay(ms, label)
    return { dueAt: now + ms, text: requireText(tokens.slice(1).join(" ")) }
  }

  // 18:30
  const clock = /^(\d{1,2}):(\d{2})$/.exec(first)
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2])
    validateClock(hour, minute)
    validateDelay(absoluteDue(hour, minute, now, timeZone, false) - now, label)
    return { dueAt: absoluteDue(hour, minute, now, timeZone, false), text: requireText(tokens.slice(1).join(" ")) }
  }

  throw new Error(`无法识别时间“${first}”。${usage}`)
}

export class ReminderStore {
  readonly #path: string
  readonly #log: Logger
  #nextId = 1
  #reminders: Reminder[] = []

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  add(chatId: number, userId: number, text: string, dueAt: number, repeat?: ReminderRepeat): Reminder {
    const reminder: Reminder = { id: this.#nextId++, chatId, userId, text, dueAt, createdAt: Date.now() }
    if (repeat) reminder.repeat = repeat
    this.#reminders.push(reminder)
    this.#save()
    return reminder
  }

  list(chatId: number): Reminder[] {
    return this.#reminders.filter((item) => item.chatId === chatId).sort((a, b) => a.dueAt - b.dueAt)
  }

  count(chatId: number): number {
    return this.#reminders.filter((item) => item.chatId === chatId).length
  }

  cancel(chatId: number, id: number): Reminder | undefined {
    const index = this.#reminders.findIndex((item) => item.id === id && item.chatId === chatId)
    if (index < 0) return undefined
    const [removed] = this.#reminders.splice(index, 1)
    this.#save()
    return removed
  }

  takeDue(now: number): Reminder[] {
    const isDue = (item: Reminder): boolean => item.dueAt <= now && (item.retryAt ?? 0) <= now
    const due = this.#reminders.filter(isDue)
    if (due.length === 0) return due
    this.#reminders = this.#reminders.filter((item) => !isDue(item))
    this.#save()
    return due
  }

  restore(reminders: Reminder[]): void {
    if (reminders.length === 0) return
    this.#reminders.push(...reminders)
    this.#save()
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<ReminderFile>
      this.#nextId = Number.isInteger(parsed.nextId) && (parsed.nextId ?? 0) > 0 ? parsed.nextId! : 1
      const items = Array.isArray(parsed.reminders) ? parsed.reminders : []
      for (const item of items) {
        if (
          item &&
          Number.isInteger(item.id) &&
          Number.isFinite(item.chatId) &&
          Number.isFinite(item.dueAt) &&
          typeof item.text === "string"
        ) {
          this.#reminders.push({
            id: item.id,
            chatId: item.chatId,
            userId: Number.isFinite(item.userId) ? item.userId : 0,
            text: item.text,
            dueAt: item.dueAt,
            createdAt: Number.isFinite(item.createdAt) ? item.createdAt : item.dueAt,
            attempts: Number.isInteger(item.attempts) && (item.attempts ?? 0) > 0 ? item.attempts : undefined,
            retryAt: Number.isFinite(item.retryAt) ? item.retryAt : undefined,
            repeat: sanitizeRepeat(item.repeat),
          })
          if (item.id >= this.#nextId) this.#nextId = item.id + 1
        }
      }
      this.#log.debug(`loaded ${this.#reminders.length} reminder(s) from ${this.#path}`)
    } catch (err) {
      this.#log.warn(`failed to read reminder store ${this.#path}:`, (err as Error).message)
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      writeFileSync(tmp, JSON.stringify({ nextId: this.#nextId, reminders: this.#reminders }, null, 2))
      renameSync(tmp, this.#path)
    } catch (err) {
      this.#log.warn("failed to persist reminder store:", (err as Error).message)
    }
  }
}

export type ReminderSender = (chatId: number, text: string) => Promise<void>

export class ReminderService {
  readonly #store: ReminderStore
  readonly #send: ReminderSender
  readonly #log: Logger
  readonly #timeZone: string
  #timer?: NodeJS.Timeout
  #ticking = false

  constructor(path: string, send: ReminderSender, log: Logger, timeZone = DEFAULT_TIMEZONE) {
    this.#store = new ReminderStore(path, log)
    this.#send = send
    this.#log = log
    this.#timeZone = timeZone
  }

  add(chatId: number, userId: number, input: string, now = Date.now()): Reminder {
    if (this.#store.count(chatId) >= MAX_PER_CHAT) {
      throw new Error(`每个会话最多设置 ${MAX_PER_CHAT} 条提醒，请先取消部分提醒。`)
    }
    const parsed = parseReminder(input, now, this.#timeZone)
    return this.#store.add(chatId, userId, parsed.text, parsed.dueAt, parsed.repeat)
  }

  list(chatId: number): Reminder[] {
    return this.#store.list(chatId)
  }

  cancel(chatId: number, id: number): Reminder | undefined {
    return this.#store.cancel(chatId, id)
  }

  start(): void {
    if (this.#timer) return
    void this.tick()
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
  }

  dispose(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const due = this.#store.takeDue(now)
      for (const reminder of due) {
        if (now - reminder.dueAt > MAX_OVERDUE_MS) {
          if (reminder.repeat) {
            // Keep the recurrence alive after a long outage but skip the stale occurrence
            reminder.dueAt = nextReminderDue(reminder, now, this.#timeZone) ?? now + TICK_MS
            reminder.attempts = undefined
            reminder.retryAt = undefined
            this.#store.restore([reminder])
            this.#log.warn(
              `skipped stale occurrence of recurring reminder #${reminder.id}; next at ${new Date(reminder.dueAt).toISOString()}`,
            )
          } else {
            this.#log.warn(`dropped reminder #${reminder.id}; it was overdue by over 7 days`)
          }
          continue
        }
        const late = now - reminder.dueAt > 60_000
        const tags = reminder.repeat ? [describeRepeat(reminder.repeat)] : []
        if (late) tags.push("补发")
        const prefix = tags.length > 0 ? `⏰ 提醒（${tags.join("，")}）` : "⏰ 提醒"
        try {
          await this.#sendWithTimeout(reminder.chatId, `${prefix} #${reminder.id}：${reminder.text}`)
          if (reminder.repeat) {
            const next = nextReminderDue(reminder, now, this.#timeZone)
            if (next) {
              reminder.dueAt = next
              reminder.attempts = undefined
              reminder.retryAt = undefined
              this.#store.restore([reminder])
            }
          }
        } catch (err) {
          const attempts = (reminder.attempts ?? 0) + 1
          if (attempts >= MAX_ATTEMPTS) {
            this.#log.error(
              `dropped reminder #${reminder.id} after ${attempts} failed deliveries:`,
              (err as Error).message,
            )
            continue
          }
          const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!
          reminder.attempts = attempts
          reminder.retryAt = now + delay
          // Put it back with a backoff so a transient Telegram outage doesn't lose the reminder
          this.#store.restore([reminder])
          this.#log.warn(
            `failed to deliver reminder #${reminder.id} (attempt ${attempts}), retry in ${Math.round(delay / 1000)}s:`,
            (err as Error).message,
          )
        }
      }
    } finally {
      this.#ticking = false
    }
  }

  async #sendWithTimeout(chatId: number, text: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.#send(chatId, text),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Telegram 发送超时")), SEND_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
