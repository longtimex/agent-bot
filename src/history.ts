import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { redactSecrets } from "./ccswitch.js"
import { readJsonObject } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import { clip } from "./messages.js"
import type { UsageOutcome } from "./usage.js"

export interface HistoryEntry {
  at: number
  prompt: string
  engine: string
  model?: string
  ms: number
  outcome: UsageOutcome
  scheduled?: boolean
}

export interface HistoryRecordInput {
  prompt: string
  engine: string
  model?: string
  ms: number
  outcome: UsageOutcome
  scheduled?: boolean
}

interface HistoryFile {
  version: number
  chats: Record<string, HistoryEntry[]>
}

export const MAX_HISTORY_PER_CHAT = 50
const MAX_PROMPT_CHARS = 200
/** Chats with no run inside this window are forgotten, mirroring the usage store. */
const RETENTION_DAYS = 31
const DAY_MS = 86_400_000
const PRUNE_INTERVAL_MS = 60 * 60_000
const OUTCOMES: UsageOutcome[] = ["ok", "failed", "cancelled"]

function cleanPrompt(value: string): string {
  // Prompts are echoed back by /history, so credentials pasted into a task must
  // never be persisted verbatim
  const text = redactSecrets(value).replace(/\s+/g, " ").trim()
  if (text.length <= MAX_PROMPT_CHARS) return text
  // clip keeps the cut off a surrogate pair: a lone half makes Telegram reject
  // the whole /history message with a 400
  return `${clip(text, MAX_PROMPT_CHARS - 1) ?? ""}…`
}

function sanitizeEntry(value: unknown): HistoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : undefined
  const engine = typeof record.engine === "string" && record.engine ? record.engine : undefined
  if (at === undefined || !engine) return undefined
  if (!OUTCOMES.includes(record.outcome as UsageOutcome)) return undefined
  return {
    at,
    prompt: typeof record.prompt === "string" ? cleanPrompt(record.prompt) : "",
    engine,
    model: typeof record.model === "string" && record.model ? record.model : undefined,
    ms: typeof record.ms === "number" && Number.isFinite(record.ms) && record.ms >= 0 ? Math.round(record.ms) : 0,
    outcome: record.outcome as UsageOutcome,
    scheduled: record.scheduled === true ? true : undefined,
  }
}

/**
 * Per-chat ring buffer of recent task runs (prompt preview + outcome only).
 * Kept separate from usage.json because usage holds aggregates, not history.
 */
export class TaskHistoryStore {
  readonly #path: string
  readonly #log: Logger
  // Null prototype: chat keys come from the data file, and assigning "constructor"
  // or "__proto__" onto a normal object would create/replace the prototype instead
  // of a record, silently dropping that chat on the next save.
  #chats: Record<string, HistoryEntry[]> = Object.create(null) as Record<string, HistoryEntry[]>
  #prunedAt = 0

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  record(key: string, input: HistoryRecordInput, now = Date.now()): void {
    const entry: HistoryEntry = {
      at: now,
      prompt: cleanPrompt(input.prompt),
      engine: input.engine,
      model: input.model,
      ms: Math.max(0, Math.round(input.ms)),
      outcome: input.outcome,
      scheduled: input.scheduled ? true : undefined,
    }
    this.#chats[key] = [entry, ...this.#entries(key)].slice(0, MAX_HISTORY_PER_CHAT)
    this.#prune(now)
    this.#save()
  }

  /**
   * Forgets chats whose newest run is older than the retention window, so a long-lived
   * allow-all bot cannot grow the map and the file that every task rewrites in full.
   */
  #prune(now: number): number {
    if (now - this.#prunedAt < PRUNE_INTERVAL_MS) return 0
    this.#prunedAt = now
    const cutoff = now - RETENTION_DAYS * DAY_MS
    let dropped = 0
    for (const [key, entries] of Object.entries(this.#chats)) {
      const newest = entries.reduce((max, item) => (item.at > max ? item.at : max), 0)
      if (newest >= cutoff) continue
      delete this.#chats[key]
      dropped++
    }
    if (dropped > 0) this.#log.debug(`dropped task history for ${dropped} dormant chat(s)`)
    return dropped
  }

  list(key: string, limit = 10): HistoryEntry[] {
    const size = Math.max(0, Math.floor(limit))
    return this.#entries(key).slice(0, size).map((entry) => ({ ...entry }))
  }

  count(key: string): number {
    return this.#entries(key).length
  }

  clear(key: string): number {
    const count = this.#entries(key).length
    if (count === 0) return 0
    delete this.#chats[key]
    this.#save()
    return count
  }

  /** Own-property read: keys can collide with inherited names such as "constructor". */
  #entries(key: string): HistoryEntry[] {
    return Object.hasOwn(this.#chats, key) ? this.#chats[key]! : []
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message)) as
      | Partial<HistoryFile>
      | undefined
    if (!parsed) return
    try {
      const chats =
        parsed.chats && typeof parsed.chats === "object" ? (parsed.chats as unknown as Record<string, unknown>) : {}
      for (const [key, value] of Object.entries(chats)) {
        if (!Array.isArray(value)) continue
        const entries: HistoryEntry[] = []
        for (const item of value) {
          const entry = sanitizeEntry(item)
          if (entry) entries.push(entry)
          if (entries.length >= MAX_HISTORY_PER_CHAT) break
        }
        if (entries.length > 0) this.#chats[key] = entries
      }
      this.#log.debug(`loaded task history for ${Object.keys(this.#chats).length} chat(s) from ${this.#path}`)
    } catch (err) {
      this.#log.warn(`failed to read task history ${this.#path}:`, (err as Error).message)
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      const body: HistoryFile = { version: 1, chats: this.#chats }
      writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
      renameSync(tmp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn("failed to persist task history:", (err as Error).message)
    }
  }
}


export interface HistoryFormatOptions {
  /** Chat label shown in the document header (e.g. "Telegram 12345" or "App"). */
  source?: string
  /** IANA timezone for the timestamps. */
  timeZone?: string
}

const OUTCOME_BADGE: Record<string, string> = {
  ok: "✅",
  cancelled: "🚫",
  failed: "❌",
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function formatStamp(at: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(at))
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
    return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
  } catch {
    const d = new Date(at)
    return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  }
}

/**
 * Renders task history as a standalone Markdown document. Blockquotes carry the
 * prompt so prompts that contain code fences or headings cannot break the layout.
 */
export function formatHistoryMarkdown(
  entries: HistoryEntry[],
  options: HistoryFormatOptions = {},
): string {
  const zone = options.timeZone
  const lines: string[] = ["# Agent Bot 任务历史", ""]
  if (options.source) {
    lines.push(`来源：${options.source}`)
  }
  if (entries.length === 0) {
    lines.push("", "_暂无任务记录。_")
    return lines.join("\n")
  }
  const newest = entries.reduce((max, item) => (item.at > max ? item.at : max), 0)
  const oldest = entries.reduce((min, item) => (item.at < min ? item.at : min), newest)
  const ok = entries.filter((item) => item.outcome === "ok").length
  lines.push(
    `共 ${entries.length} 条（成功 ${ok} · 失败 ${entries.filter((item) => item.outcome === "failed").length} · 取消 ${entries.filter((item) => item.outcome === "cancelled").length}）`,
    `时间范围：${formatStamp(oldest, zone)} ~ ${formatStamp(newest, zone)}`,
    "",
    "---",
    "",
  )
  for (const entry of entries) {
    const badge = OUTCOME_BADGE[entry.outcome] ?? "❔"
    const meta = [
      entry.engine ?? "unknown",
      entry.model,
      `${(entry.ms / 1000).toFixed(1)}s`,
      entry.scheduled ? "定时" : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
    lines.push(`## ${badge} ${formatStamp(entry.at, zone)}`, "", `\`${meta}\``, "")
    for (const line of entry.prompt.split("\n")) {
      lines.push(`> ${line}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
