import { readFileSync } from "node:fs"
import { writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"

/**
 * A small on-disk record of the messages a queue holds, so a restart does not silently eat them.
 *
 * Both queues (Telegram/Feishu and the App) kept their waiting messages only in memory: an update,
 * a crash or `/restart` dropped every queued prompt without a word, and the task that was running
 * simply never answered. Each queue now writes an entry when a message joins it, flips it to
 * running when it starts and removes it when it ends. The next process reads what was left:
 *
 * - queued, recent  → run it, in the original order (it never reached an engine, so it is safe)
 * - queued, too old → report it instead; a question from hours ago may no longer be wanted
 * - running         → report it as interrupted and never re-run it on its own: the engine may
 *                     already have edited files or spent money, so only the user may retry it
 *
 * The file holds prompts, so it is written 0600 like the other private stores.
 */
export const RESUME_MAX_AGE_MS = 30 * 60_000
const MAX_ENTRIES = 200

export interface JournalEntry<T> {
  id: string
  state: "queued" | "running"
  queuedAt: number
  payload: T
}

export interface RecoveryPlan<T> {
  resume: JournalEntry<T>[]
  interrupted: JournalEntry<T>[]
  expired: JournalEntry<T>[]
}

const live = new Set<JobJournal<unknown>>()

/**
 * Called first thing on shutdown. Stopping the process cancels the queued messages and aborts the
 * running one; without freezing, those cancellations would be written out and the next start
 * would find nothing to recover, which is exactly the restart this journal exists for.
 */
export function freezeJobJournals(): void {
  for (const journal of live) journal.freeze()
}

export class JobJournal<T> {
  readonly #path: string
  readonly #log: Logger
  readonly #entries = new Map<string, JournalEntry<T>>()
  /** What the previous process left; it stays in the file until recovery takes it. */
  #previous: JournalEntry<T>[]
  #frozen = false

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#previous = readEntries<T>(path, log)
    live.add(this as JobJournal<unknown>)
  }

  track(id: string, payload: T, queuedAt = Date.now()): void {
    if (this.#frozen) return
    this.#entries.set(id, { id, state: "queued", queuedAt, payload })
    this.#save()
  }

  started(id: string): void {
    const entry = this.#entries.get(id)
    if (this.#frozen || !entry || entry.state === "running") return
    entry.state = "running"
    this.#save()
  }

  finished(id: string): void {
    if (this.#frozen || !this.#entries.delete(id)) return
    this.#save()
  }

  /** /stop and 清空排队 drop every waiting message of a chat at once. */
  dropQueued(match: (payload: T) => boolean): void {
    if (this.#frozen) return
    let changed = false
    for (const [id, entry] of this.#entries) {
      if (entry.state === "queued" && match(entry.payload)) {
        this.#entries.delete(id)
        changed = true
      }
    }
    if (changed) this.#save()
  }

  freeze(): void {
    this.#frozen = true
  }

  get size(): number {
    return this.#entries.size
  }

  /** Hands over what the previous process left, once; later calls return an empty plan. */
  takeRecovery(now = Date.now(), maxAgeMs = RESUME_MAX_AGE_MS): RecoveryPlan<T> {
    const previous = this.#previous
    this.#previous = []
    if (previous.length > 0 && !this.#frozen) this.#save()
    return planRecovery(previous, now, maxAgeMs)
  }

  #save(): void {
    const entries = [...this.#previous, ...this.#entries.values()].slice(-MAX_ENTRIES)
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    } catch (err) {
      // Losing the journal only loses the restart safety net; the queue itself keeps working
      this.#log.warn(`failed to write the queue journal ${this.#path}:`, (err as Error).message)
    }
  }
}

export function planRecovery<T>(entries: JournalEntry<T>[], now: number, maxAgeMs = RESUME_MAX_AGE_MS): RecoveryPlan<T> {
  const plan: RecoveryPlan<T> = { resume: [], interrupted: [], expired: [] }
  for (const entry of [...entries].sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (entry.state === "running") plan.interrupted.push(entry)
    // A clock that jumped backwards makes an entry look newer, never older: resume it
    else if (now - entry.queuedAt <= maxAgeMs) plan.resume.push(entry)
    else plan.expired.push(entry)
  }
  return plan
}

function readEntries<T>(path: string, log: Logger): JournalEntry<T>[] {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(
      (entry): entry is JournalEntry<T> =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as JournalEntry<T>).id === "string" &&
        ((entry as JournalEntry<T>).state === "queued" || (entry as JournalEntry<T>).state === "running") &&
        Number.isFinite((entry as JournalEntry<T>).queuedAt) &&
        typeof (entry as JournalEntry<T>).payload === "object" &&
        (entry as JournalEntry<T>).payload !== null,
    )
  } catch (err) {
    log.warn(`ignoring an unreadable queue journal ${path}:`, (err as Error).message)
    return []
  }
}
