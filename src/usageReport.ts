import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { readJsonObject } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import { zonedParts } from "./reminders.js"
import { dateKey, type UsageDay, type UsageStore, type UsageTrendDay } from "./usage.js"

export interface DailyReportData {
  day: string
  totals: UsageDay
  byChat: Array<{ key: string; usage: UsageDay }>
  trend: UsageTrendDay[]
}

const BAR_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/** One sparkline char per day, scaled to the busiest day in the window. */
export function trendBars(trend: UsageTrendDay[]): string {
  const max = trend.reduce((peak, day) => Math.max(peak, day.tasks), 0)
  if (max === 0) return "（无记录）"
  return trend
    .map((day) => BAR_CHARS[Math.min(BAR_CHARS.length - 1, Math.floor((day.tasks / max) * (BAR_CHARS.length - 1)))])
    .join("")
}

/** Human name for a usage key: `tg:<id>` / `api:app` today, anything else verbatim. */
export function sourceLabel(key: string): string {
  if (key === "api:app") return "App"
  if (key.startsWith("tg:")) return `Telegram ${key.slice(3)}`
  return key
}

function sumDays(rows: Array<{ usage: UsageDay }>): UsageDay {
  const totals: UsageDay = { tasks: 0, ok: 0, failed: 0, cancelled: 0, totalMs: 0 }
  for (const { usage } of rows) {
    totals.tasks += usage.tasks
    totals.ok += usage.ok
    totals.failed += usage.failed
    totals.cancelled += usage.cancelled
    totals.totalMs += usage.totalMs
  }
  return totals
}

/** Aggregates every chat's usage for today plus the 7-day trend, in the given timezone. */
export function buildDailyReportData(store: UsageStore, timeZone: string, now = Date.now()): DailyReportData {
  const byChat = store.dayTotalsByChat(0, now).sort((a, b) => b.usage.tasks - a.usage.tasks)
  return {
    day: dateKey(now, timeZone),
    totals: sumDays(byChat),
    byChat,
    trend: store.aggregateRecentDays(7, now),
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** The chat-facing daily report; empty days still render so a scheduled push never looks broken. */
export function formatDailyReport(data: DailyReportData, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(new Date())
  const totals = data.totals
  const trendTasks = data.trend.reduce((sum, day) => sum + day.tasks, 0)
  const lines = [
    `📊 *每日用量报告* · ${data.day}（${weekday}）`,
    "",
    `今日任务：${totals.tasks} · ✅ ${totals.ok} · ❌ ${totals.failed} · 🚫 ${totals.cancelled}`,
  ]
  if (totals.tasks > 0) lines.push(`平均耗时：${formatDuration(totals.totalMs / totals.tasks)}`)
  if (data.byChat.length > 0) {
    lines.push(
      `来源：${data.byChat.map((row) => `${sourceLabel(row.key)} ${row.usage.tasks}`).join(" · ")}`,
    )
  }
  lines.push(`近 7 天：${trendBars(data.trend)} 共 ${trendTasks} 条`)
  return lines.join("\n")
}

const REPORT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** "21:00" → minutes since midnight; callers validated the format at config load. */
export function reportTimeMinutes(time: string): number {
  const match = REPORT_TIME_RE.exec(time.trim())
  if (!match) return 21 * 60
  return Number(match[1]) * 60 + Number(match[2])
}

interface DailyReportFile {
  lastSent?: string
}

export interface DailyReportOptions {
  store: UsageStore
  /** data/usage-report.json remembers the last sent local day across restarts. */
  path: string
  timeZone: () => string
  /** Local push time, "HH:MM" (24 h). */
  time: string
  log: Logger
  send: (text: string) => Promise<void>
}

/**
 * Pushes one usage summary per local day once the configured time has passed.
 * A restart later the same day catches up (the day is only marked after a
 * successful send); days missed entirely are skipped rather than delivered late.
 */
export class DailyReportService {
  readonly #opts: DailyReportOptions
  #timer: NodeJS.Timeout | undefined
  #ticking = false
  #lastSent: string | undefined

  constructor(opts: DailyReportOptions) {
    this.#opts = opts
    const stored = readJsonObject(opts.path, (message) => opts.log.warn(message)) as DailyReportFile | undefined
    if (typeof stored?.lastSent === "string") this.#lastSent = stored.lastSent
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), 30_000)
    this.#timer.unref()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** Sends the report if due; resolves with the sent text (tests) or undefined. */
  async tick(now = Date.now()): Promise<string | undefined> {
    if (this.#ticking) return undefined
    this.#ticking = true
    try {
      const timeZone = this.#opts.timeZone()
      const today = dateKey(now, timeZone)
      if (this.#lastSent === today) return undefined
      const parts = zonedParts(now, timeZone)
      if (parts.hour * 60 + parts.minute < reportTimeMinutes(this.#opts.time)) return undefined
      const text = formatDailyReport(buildDailyReportData(this.#opts.store, timeZone, now), timeZone)
      await this.#opts.send(text)
      this.#lastSent = today
      this.#save()
      return text
    } catch (err) {
      this.#opts.log.warn("daily usage report failed:", (err as Error).message)
      return undefined
    } finally {
      this.#ticking = false
    }
  }

  /** Manual preview (e.g. the /usage panel button); never marks the day as sent. */
  preview(now = Date.now()): string {
    const timeZone = this.#opts.timeZone()
    return formatDailyReport(buildDailyReportData(this.#opts.store, timeZone, now), timeZone)
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#opts.path), { recursive: true })
      const tmp = `${this.#opts.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ lastSent: this.#lastSent }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.#opts.path)
      chmodSync(this.#opts.path, 0o600)
    } catch (err) {
      this.#opts.log.warn("failed to persist the daily report state:", (err as Error).message)
    }
  }
}
