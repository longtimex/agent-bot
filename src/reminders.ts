import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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
  /** Set while a due reminder is being delivered; cleared on load after a crash. */
  runningAt?: number
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

function absoluteDue(
  hour: number,
  minute: number,
  now: number,
  timeZone: string,
  dayOffset = 0,
  skipToday = true,
): number {
  const parts = zonedParts(now, timeZone)
  let dueAt = zonedToUtc(parts.year, parts.month, parts.day + dayOffset, hour, minute, timeZone)
  // Repeat rescheduling calls this right after a trigger, so "today" must mean
  // tomorrow then; fresh reminders instead keep a same-day slot that is still ahead
  if (dayOffset === 0 && dueAt <= now + (skipToday ? 1_000 : 0)) {
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
  return `${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`
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
  if (repeat.type === "daily") return absoluteDue(repeat.hour, repeat.minute, now, timeZone)
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
    record.ms >= MIN_DELAY_MS &&
    // A hand-edited file must not schedule occurrences past the normal 365-day cap
    record.ms <= MAX_DELAY_MS
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

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

// 每天 / 明天 / 后天 / 今晚 / 下午 既可以独立成词，也可以和时间粘在同一个词里
const TIME_PREFIX_RE =
  /^(每隔|每天|每日|每|everyday|daily|every|each|前天|明天|后天|今天|今晚|明晚|凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)(.*)$/i
const DAY_PARTS_PM = new Set(["下午", "傍晚", "晚上"])
const HORIZON: Record<string, number> = {
  前天: -1,
  今天: 0,
  今晚: 0,
  明天: 1,
  明晚: 1,
  后天: 2,
}

function peelTimePrefixes(token: string): { prefixes: string[]; rest: string } {
  const prefixes: string[] = []
  let rest = token
  for (;;) {
    const match = TIME_PREFIX_RE.exec(rest)
    if (!match) break
    prefixes.push(match[1]!.toLowerCase())
    rest = match[2] ?? ""
  }
  return { prefixes, rest }
}

/** 5分钟后 / 1小时30分钟 / 半小时 / 一刻钟 → 5m / 1h30m / 30m / 15m */
function toDurationToken(token: string): string {
  return token
    .replace(/半小时/g, "30m")
    .replace(/一刻钟/g, "15m")
    .replace(/(?:以后|之后|内|后)$/, "")
    .replace(/分钟|分/g, "m")
    .replace(/小时/g, "h")
    .replace(/秒钟|秒/g, "s")
    .replace(/天/g, "d")
}

/** 18:30 / 8点 / 8点半 / 20点15 / 8点30分 */
function parseClockToken(token: string): { hour: number; minute: number } | undefined {
  const colon = /^(\d{1,2}):(\d{2})$/.exec(token)
  if (colon) return { hour: Number(colon[1]), minute: Number(colon[2]) }
  const cn = /^(\d{1,2})\s*[点時时]\s*(半|[0-5]?\d\s*分?)?$/.exec(token)
  if (!cn) return undefined
  const hour = Number(cn[1])
  const tail = (cn[2] ?? "").replace(/\s+/g, "")
  if (!tail) return { hour, minute: 0 }
  if (tail === "半") return { hour, minute: 30 }
  return { hour, minute: Number(tail.replace(/分$/, "")) }
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
  if (!tokens[0]) throw new Error(`用法：${command} 30m 喝水`)

  const usage =
    `支持：30m / 1h30m / 5分钟后 / 半小时 / 18:30 / 8点半 / 今天下午3点 / 明天 08:30 / ` +
    `每天 08:30 / every 30m / 每30分钟`

  // Consume leading modifier words until a token carries the actual time expression
  const prefixes: string[] = []
  let cursor = 0
  let timeToken = ""
  for (;;) {
    const token = tokens[cursor]
    if (!token) break
    const peeled = peelTimePrefixes(token)
    prefixes.push(...peeled.prefixes)
    if (peeled.rest) {
      timeToken = peeled.rest
      break
    }
    cursor += 1
  }
  const daily = prefixes.includes("每天") || prefixes.includes("每日") || prefixes.includes("daily") || prefixes.includes("everyday")
  const every = prefixes.includes("每隔") || prefixes.includes("每") || prefixes.includes("every") || prefixes.includes("each")
  const dayPart =
    prefixes.find((prefix) => ["凌晨", "清晨", "早上", "上午", "中午", "下午", "傍晚", "晚上"].includes(prefix)) ??
    (prefixes.includes("今晚") || prefixes.includes("明晚") ? "晚上" : undefined)
  const horizon = prefixes
    .map((prefix) => HORIZON[prefix])
    .find((value): value is number => value !== undefined)

  const requireText = (text: string): string => {
    const value = text.trim()
    if (!value) throw new Error(`请补充${label}内容，例如：${command} 30m 喝水`)
    if (value.length > maxTextLength) throw new Error(`${label}内容不能超过 ${maxTextLength} 字。`)
    return value
  }
  // Text is only required once the time expression itself parsed, so a missing time never
  // masks the usage error
  const takeText = (): string => requireText(tokens.slice(cursor + 1).join(" "))

  const durationToken = toDurationToken(timeToken)
  if (DURATION_TOKEN.test(durationToken)) {
    const ms = durationMs(durationToken)
    validateDelay(ms, label)
    if (!every && !daily) return { dueAt: now + ms, text: takeText() }
    return { dueAt: now + ms, text: takeText(), repeat: { type: "interval", ms } }
  }

  const clock = parseClockToken(timeToken)
  if (clock) {
    let hour = clock.hour
    if (dayPart && DAY_PARTS_PM.has(dayPart)) {
      if (dayPart === "晚上" && hour === 12) hour = 0
      // 中午 stays literal (中午11点 = 11:00, 中午12点 = 12:00); other PM parts shift
      else if (hour < 12) hour += 12
    }
    const minute = clock.minute
    validateClock(hour, minute)
    if (daily || every) {
      // 每 8点 / every 18:30 mean a daily recurrence, not a one-shot
      return {
        dueAt: absoluteDue(hour, minute, now, timeZone, 0, false),
        text: takeText(),
        repeat: { type: "daily", hour, minute },
      }
    }
    if (horizon !== undefined && horizon < 0) {
      throw new Error(`${label}时间不能是过去。`)
    }
    if (horizon === 0) {
      // 今晚12点半 means the midnight that ENDS tonight, i.e. the next 00:30,
      // so an already-past wall clock rolls to tomorrow instead of erroring
      if (hour === 0 && dayPart === "晚上") {
        return { dueAt: absoluteDue(hour, minute, now, timeZone), text: takeText() }
      }
      const parts = zonedParts(now, timeZone)
      const dueAt = zonedToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone)
      if (dueAt <= now) {
        throw new Error(`今天 ${pad2(hour)}:${pad2(minute)} 已过，请改用“明天 …”或相对时间。`)
      }
      return { dueAt, text: takeText() }
    }
    return { dueAt: absoluteDue(hour, minute, now, timeZone, horizon ?? 0), text: takeText() }
  }

  if (daily) throw new Error(`每日${label}的格式应为：${command} 每天 08:30 打卡`)
  if (every) {
    throw new Error(`重复${label}的格式应为：${command} every 30m 喝水 或 ${command} 每天 08:30 打卡`)
  }
  throw new Error(`无法识别时间“${timeToken || (tokens[0] ?? "")}”。${usage}`)
}

export class ReminderStore {
  readonly #path: string
  readonly #log: Logger
  #nextId = 1
  #reminders: Reminder[] = []
  #unreadable = false

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  add(chatId: number, userId: number, text: string, dueAt: number, repeat?: ReminderRepeat): Reminder {
    this.#assertWritable()
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
    this.#assertWritable()
    const [removed] = this.#reminders.splice(index, 1)
    this.#save()
    return removed
  }

  takeDue(now: number): Reminder[] {
    const isDue = (item: Reminder): boolean =>
      !item.runningAt && item.dueAt <= now && (item.retryAt ?? 0) <= now
    const due = this.#reminders.filter(isDue)
    if (due.length === 0) return []
    for (const item of due) item.runningAt = now
    this.#save()
    return due.map((item) => ({ ...item }))
  }

  /**
   * Persist the outcome of a delivery. Without a patch the reminder is removed
   * (one-shot); with dueAt/retryAt it is rescheduled and marked idle again.
   */
  settle(id: number, patch?: Partial<Pick<Reminder, "dueAt" | "attempts" | "retryAt">>): void {
    const index = this.#reminders.findIndex((item) => item.id === id)
    if (index < 0) return
    if (!patch) {
      this.#reminders.splice(index, 1)
    } else {
      const item = this.#reminders[index]!
      if (patch.dueAt !== undefined) item.dueAt = patch.dueAt
      item.attempts = patch.attempts
      item.retryAt = patch.retryAt
      item.runningAt = undefined
    }
    this.#save()
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<ReminderFile> | null
      if (typeof parsed !== "object" || parsed === null || (parsed.reminders !== undefined && !Array.isArray(parsed.reminders))) {
        throw new Error("提醒文件结构无效")
      }
      this.#nextId = Number.isInteger(parsed.nextId) && (parsed.nextId ?? 0) > 0 ? parsed.nextId! : 1
      const items = Array.isArray(parsed.reminders) ? parsed.reminders : []
      const seenIds = new Set<number>()
      for (const item of items) {
        if (
          item &&
          Number.isInteger(item.id) &&
          !seenIds.has(item.id) &&
          Number.isFinite(item.chatId) &&
          Number.isFinite(item.dueAt) &&
          typeof item.text === "string"
        ) {
          // A duplicated id (hand-edited file) would otherwise become an uncancellable ghost
          seenIds.add(item.id)
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
      this.#unreadable = true
      this.#log.warn(`failed to read reminder store ${this.#path}:`, (err as Error).message)
    }
  }

  #assertWritable(): void {
    if (!this.#unreadable) return
    throw new Error(
      `提醒文件 ${this.#path} 无法解析，为避免丢失已有提醒已拒绝写入。请先修复该文件（或备份后删除）再重试。`,
    )
  }

  #save(): void {
    // A store we could not read holds (at most) what we recovered; writing it back would
    // replace every reminder the parse dropped with the reduced set
    if (this.#unreadable) {
      this.#log.warn(`reminder store ${this.#path} is unreadable; skipped writing it`)
      return
    }
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      writeFileSync(tmp, JSON.stringify({ nextId: this.#nextId, reminders: this.#reminders }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn("failed to persist reminder store:", (err as Error).message)
    }
  }
}

export type ReminderSender = (chatId: number, text: string, reminder?: Reminder) => Promise<void>

export class ReminderService {
  readonly #store: ReminderStore
  readonly #send: ReminderSender
  readonly #log: Logger
  readonly #access: (userId: number) => boolean
  #timeZone: string
  #timer?: NodeJS.Timeout
  #ticking = false

  constructor(
    path: string,
    send: ReminderSender,
    log: Logger,
    timeZone = DEFAULT_TIMEZONE,
    access?: (userId: number) => boolean,
  ) {
    this.#store = new ReminderStore(path, log)
    this.#send = send
    this.#log = log
    this.#timeZone = timeZone
    this.#access = access ?? (() => true)
  }

  /** /timezone applies without a restart; already-scheduled due times are kept. */
  setTimeZone(timeZone: string): void {
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

  /**
   * Re-arms a delivered one-shot reminder after `minutes` — the 稍后提醒 button
   * on the delivery message. Keeps the original text verbatim (no time parsing),
   * so a snoozed reminder always rings exactly that much later.
   */
  snooze(chatId: number, userId: number, text: string, minutes: number, now = Date.now()): Reminder {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 7) {
      throw new Error("稍后提醒的时长需在 1 分钟到 7 天之间。")
    }
    if (this.#store.count(chatId) >= MAX_PER_CHAT) {
      throw new Error(`每个会话最多设置 ${MAX_PER_CHAT} 条提醒，请先取消部分提醒。`)
    }
    return this.#store.add(chatId, userId, text, now + minutes * 60_000)
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
        // The next due is computed from the tick's entry timestamp: under a simulated
        // clock (tests) that is the only meaningful base, and in production a slow
        // delivery merely advances the next occurrence, never replays a stale one
        if (now - reminder.dueAt > MAX_OVERDUE_MS) {
          if (reminder.repeat) {
            // Keep the recurrence alive after a long outage but skip the stale occurrence
            const next = nextReminderDue(reminder, now, this.#timeZone) ?? now + TICK_MS
            this.#store.settle(reminder.id, { dueAt: next })
            this.#log.warn(
              `skipped stale occurrence of recurring reminder #${reminder.id}; next at ${new Date(next).toISOString()}`,
            )
          } else {
            this.#store.settle(reminder.id)
            this.#log.warn(`dropped reminder #${reminder.id}; it was overdue by over 7 days`)
            // Deleting it in silence looks exactly like the bot lost the reminder, so say so
            await this.#sendWithTimeout(
              reminder.chatId,
              `⏰ 提醒 #${reminder.id} 已过期未发送：Bot 停机期间它超过 7 天没有触发，已自动删除。`,
            ).catch(() => {})
          }
          continue
        }
        const late = now - reminder.dueAt > 60_000
        const tags = reminder.repeat ? [describeRepeat(reminder.repeat)] : []
        if (late) tags.push("补发")
        const prefix = tags.length > 0 ? `⏰ 提醒（${tags.join("，")}）` : "⏰ 提醒"
        try {
          // A chat whose owner was taken off the access list must not keep receiving
          // bot output; the failure path keeps the recurrence and drops it on backoff
          if (!this.#access(reminder.userId)) throw new Error("用户已不在访问白名单中")
          await this.#sendWithTimeout(
            reminder.chatId,
            `${prefix} #${reminder.id}：${reminder.text}`,
            reminder,
          )
          if (reminder.repeat) {
            const next = nextReminderDue(reminder, now, this.#timeZone)
            if (next) this.#store.settle(reminder.id, { dueAt: next })
            else this.#store.settle(reminder.id)
          } else {
            this.#store.settle(reminder.id)
          }
        } catch (err) {
          const attempts = (reminder.attempts ?? 0) + 1
          if (reminder.repeat) {
            // A recurring reminder must outlive a Telegram outage or an unreachable
            // chat: skip this occurrence and keep the recurrence instead of deleting it
            const next = nextReminderDue(reminder, now, this.#timeZone) ?? now + TICK_MS
            this.#store.settle(reminder.id, { dueAt: next })
            this.#log.warn(
              `skipped occurrence of reminder #${reminder.id} after ${attempts} failed delivery attempt(s); ` +
                `next at ${new Date(next).toISOString()}: ${(err as Error).message}`,
            )
            continue
          }
          if (attempts >= MAX_ATTEMPTS) {
            this.#store.settle(reminder.id)
            this.#log.error(
              `dropped reminder #${reminder.id} after ${attempts} failed deliveries:`,
              (err as Error).message,
            )
            continue
          }
          const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!
          // Keep the reminder with a backoff so a transient Telegram outage doesn't lose it
          this.#store.settle(reminder.id, { attempts, retryAt: now + delay })
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

  async #sendWithTimeout(chatId: number, text: string, reminder?: Reminder): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.#send(chatId, text, reminder),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Telegram 发送超时")), SEND_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
