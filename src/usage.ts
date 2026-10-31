import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { readJsonObject } from "./jsonStore.js"
import type { Logger } from "./logger.js"

export type UsageOutcome = "ok" | "failed" | "cancelled"

export interface UsageDay {
  tasks: number
  ok: number
  failed: number
  cancelled: number
  totalMs: number
}

export interface UsageRecord {
  engine: string
  model?: string
  ms: number
  outcome: UsageOutcome
}

export interface UsageSummary extends UsageDay {
  engines: Record<string, number>
  lastAt?: number
  lastEngine?: string
  lastModel?: string
  today: UsageDay
}

export type UsageTrendDay = UsageDay & { day: string }

interface ChatUsage extends UsageDay {
  engines: Record<string, number>
  days: Record<string, UsageDay>
  lastAt?: number
  lastEngine?: string
  lastModel?: string
}

interface UsageFile {
  version: number
  chats: Record<string, ChatUsage>
}

const KEEP_DAYS = 31
const DAY_MS = 86_400_000
/** Dormant chats are swept at most this often, so the hot path stays a single map pass. */
const PRUNE_INTERVAL_MS = 60 * 60_000
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function emptyDay(): UsageDay {
  return { tasks: 0, ok: 0, failed: 0, cancelled: 0, totalMs: 0 }
}

function emptyChat(): ChatUsage {
  // Null prototypes: the keys of every map below come from the data file, and an
  // inherited name such as "constructor" must not read back as stored usage
  return {
    ...emptyDay(),
    engines: Object.create(null) as Record<string, number>,
    days: Object.create(null) as Record<string, UsageDay>,
  }
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

export function dateKey(timestamp: number, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    dayFormatters.set(timeZone, formatter)
  }
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(timestamp)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * One calendar day earlier, independent of the local wall clock: subtracting
 * 24 h twice can land on the same local day across a DST fall-back.
 */
function previousDay(day: string): string {
  const parts = day.split("-").map(Number)
  const [year = 1970, month = 1, date = 1] = parts
  return new Date(Date.UTC(year, month - 1, date) - DAY_MS).toISOString().slice(0, 10)
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

function sanitizeDay(value: unknown): UsageDay {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  return {
    tasks: count(record.tasks),
    ok: count(record.ok),
    failed: count(record.failed),
    cancelled: count(record.cancelled),
    totalMs: count(record.totalMs),
  }
}

export class UsageStore {
  readonly #path: string
  readonly #log: Logger
  #timeZone: string
  #chats: Record<string, ChatUsage> = Object.create(null) as Record<string, ChatUsage>
  #prunedAt = 0

  constructor(path: string, log: Logger, timeZone: string) {
    this.#path = path
    this.#log = log
    this.#timeZone = timeZone
    this.#load()
  }

  /** /timezone applies without a restart; per-day totals stay on the day they were recorded. */
  setTimeZone(timeZone: string): void {
    this.#timeZone = timeZone
  }

  record(key: string, input: UsageRecord, now = Date.now()): void {
    const chat = this.#chats[key] ?? emptyChat()
    const outcome = input.outcome
    const ms = Math.max(0, Math.round(input.ms))

    chat.tasks += 1
    chat[outcome] += 1
    chat.totalMs += ms
    // Own-property read: engine ids come from user-managed profiles, and an
    // inherited name such as "toString" would otherwise count as NaN
    const engineTotal = Object.hasOwn(chat.engines, input.engine) ? chat.engines[input.engine]! : 0
    chat.engines[input.engine] = engineTotal + 1
    chat.lastAt = now
    chat.lastEngine = input.engine
    // Keep lastModel aligned with the newest task: a task without a model must not
    // surface the previous task's (possibly different engine's) model.
    chat.lastModel = input.model || undefined

    const day = dateKey(now, this.#timeZone)
    const entry = chat.days[day] ?? emptyDay()
    entry.tasks += 1
    entry[outcome] += 1
    entry.totalMs += ms
    chat.days[day] = entry

    const days = Object.keys(chat.days).sort()
    for (const stale of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete chat.days[stale]

    this.#chats[key] = chat
    this.#prune(now)
    this.#save()
  }

  /**
   * Forgets chats that have been idle for longer than the daily-trend window. Without
   * it a long-lived allow-all bot grows both the map and the file that every task
   * rewrites in full, while a dormant chat's totals are never shown again.
   */
  #prune(now: number): number {
    if (now - this.#prunedAt < PRUNE_INTERVAL_MS) return 0
    this.#prunedAt = now
    const cutoff = now - KEEP_DAYS * DAY_MS
    let dropped = 0
    for (const [key, chat] of Object.entries(this.#chats)) {
      // A record with no timestamp cannot be placed in the window, so it is kept
      if (chat.lastAt === undefined || chat.lastAt >= cutoff) continue
      delete this.#chats[key]
      dropped++
    }
    if (dropped > 0) this.#log.debug(`dropped usage stats for ${dropped} dormant chat(s)`)
    return dropped
  }

  summary(key: string, now = Date.now()): UsageSummary {
    const chat = this.#chats[key] ?? emptyChat()
    return {
      tasks: chat.tasks,
      ok: chat.ok,
      failed: chat.failed,
      cancelled: chat.cancelled,
      totalMs: chat.totalMs,
      engines: { ...chat.engines },
      lastAt: chat.lastAt,
      lastEngine: chat.lastEngine,
      lastModel: chat.lastModel,
      today: { ...(chat.days[dateKey(now, this.#timeZone)] ?? emptyDay()) },
    }
  }

  /** Chronological per-day totals for the last `count` calendar days, zero-filled. */
  recentDays(key: string, count = 7, now = Date.now()): UsageTrendDay[] {
    const size = Math.max(1, Math.min(KEEP_DAYS, Math.floor(count)))
    const days: UsageTrendDay[] = []
    const chat = this.#chats[key]
    let day = dateKey(now, this.#timeZone)
    for (let offset = 0; offset < size; offset++) {
      days.unshift({ day, ...(chat?.days[day] ?? emptyDay()) })
      day = previousDay(day)
    }
    return days
  }

  /** Per-chat totals for one calendar day (0 = today); chats idle that day are omitted. */
  dayTotalsByChat(offsetDays = 0, now = Date.now()): Array<{ key: string; usage: UsageDay }> {
    let day = dateKey(now, this.#timeZone)
    for (let index = 0; index < offsetDays; index++) day = previousDay(day)
    const rows: Array<{ key: string; usage: UsageDay }> = []
    for (const [key, chat] of Object.entries(this.#chats)) {
      const usage = chat.days[day]
      if (usage && usage.tasks > 0) rows.push({ key, usage: { ...usage } })
    }
    return rows
  }

  /** Day-by-day totals summed across every chat, chronological and zero-filled. */
  aggregateRecentDays(count = 7, now = Date.now()): UsageTrendDay[] {
    const size = Math.max(1, Math.min(KEEP_DAYS, Math.floor(count)))
    let day = dateKey(now, this.#timeZone)
    const ordered: string[] = []
    for (let offset = 0; offset < size; offset++) {
      ordered.unshift(day)
      day = previousDay(day)
    }
    const totals = new Map<string, UsageDay>(ordered.map((key) => [key, emptyDay()]))
    for (const chat of Object.values(this.#chats)) {
      for (const key of ordered) {
        const entry = chat.days[key]
        if (!entry) continue
        const total = totals.get(key)!
        total.tasks += entry.tasks
        total.ok += entry.ok
        total.failed += entry.failed
        total.cancelled += entry.cancelled
        total.totalMs += entry.totalMs
      }
    }
    return ordered.map((key) => ({ day: key, ...totals.get(key)! }))
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message)) as Partial<UsageFile> | undefined
    if (!parsed) return
    try {
      const chats =
        parsed.chats && typeof parsed.chats === "object"
          ? (parsed.chats as unknown as Record<string, unknown>)
          : {}
      for (const [key, value] of Object.entries(chats)) {
        if (!value || typeof value !== "object") continue
        const record = value as Record<string, unknown>
        const chat = emptyChat()
        const totals = sanitizeDay(record)
        chat.tasks = totals.tasks
        chat.ok = totals.ok
        chat.failed = totals.failed
        chat.cancelled = totals.cancelled
        chat.totalMs = totals.totalMs

        if (record.engines && typeof record.engines === "object") {
          for (const [engine, raw] of Object.entries(record.engines as Record<string, unknown>)) {
            const value = count(raw)
            if (value > 0) chat.engines[engine] = value
          }
        }
        if (record.days && typeof record.days === "object") {
          for (const [day, raw] of Object.entries(record.days as Record<string, unknown>)) {
            if (DAY_KEY.test(day)) chat.days[day] = sanitizeDay(raw)
          }
        }
        if (typeof record.lastAt === "number" && Number.isFinite(record.lastAt)) chat.lastAt = record.lastAt
        if (typeof record.lastEngine === "string") chat.lastEngine = record.lastEngine
        if (typeof record.lastModel === "string") chat.lastModel = record.lastModel
        this.#chats[key] = chat
      }
      this.#log.debug(`loaded usage stats for ${Object.keys(this.#chats).length} chat(s) from ${this.#path}`)
    } catch (err) {
      this.#log.warn(`failed to read usage store ${this.#path}:`, (err as Error).message)
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      const body: UsageFile = { version: 1, chats: this.#chats }
      writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
      renameSync(tmp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn("failed to persist usage store:", (err as Error).message)
    }
  }
}
