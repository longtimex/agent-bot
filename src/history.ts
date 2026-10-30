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
