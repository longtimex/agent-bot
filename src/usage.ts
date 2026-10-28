import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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
  engines: { opencode: number; qoder: number }
  lastAt?: number
  lastEngine?: string
  lastModel?: string
  today: UsageDay
}

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
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function emptyDay(): UsageDay {
  return { tasks: 0, ok: 0, failed: 0, cancelled: 0, totalMs: 0 }
}

function emptyChat(): ChatUsage {
  return { ...emptyDay(), engines: {}, days: {} }
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
  readonly #timeZone: string
  #chats: Record<string, ChatUsage> = {}

  constructor(path: string, log: Logger, timeZone: string) {
    this.#path = path
    this.#log = log
    this.#timeZone = timeZone
    this.#load()
  }

  record(key: string, input: UsageRecord, now = Date.now()): void {
    const chat = this.#chats[key] ?? emptyChat()
    const outcome = input.outcome
    const ms = Math.max(0, Math.round(input.ms))

    chat.tasks += 1
    chat[outcome] += 1
    chat.totalMs += ms
    chat.engines[input.engine] = (chat.engines[input.engine] ?? 0) + 1
    chat.lastAt = now
    chat.lastEngine = input.engine
    if (input.model) chat.lastModel = input.model

    const day = dateKey(now, this.#timeZone)
    const entry = chat.days[day] ?? emptyDay()
    entry.tasks += 1
    entry[outcome] += 1
    entry.totalMs += ms
    chat.days[day] = entry

    const days = Object.keys(chat.days).sort()
    for (const stale of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete chat.days[stale]

    this.#chats[key] = chat
    this.#save()
  }

  summary(key: string, now = Date.now()): UsageSummary {
    const chat = this.#chats[key] ?? emptyChat()
    return {
      tasks: chat.tasks,
      ok: chat.ok,
      failed: chat.failed,
      cancelled: chat.cancelled,
      totalMs: chat.totalMs,
      engines: {
        opencode: chat.engines.opencode ?? 0,
        qoder: chat.engines.qoder ?? 0,
      },
      lastAt: chat.lastAt,
      lastEngine: chat.lastEngine,
      lastModel: chat.lastModel,
      today: { ...(chat.days[dateKey(now, this.#timeZone)] ?? emptyDay()) },
    }
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<UsageFile>
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
