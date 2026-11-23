import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"

/**
 * Event ids already handled, kept across restarts.
 *
 * Feishu redelivers an event it did not see acknowledged. The ids used to live only in memory,
 * so a bot restarted between handling a message and the platform's retry ran the same prompt a
 * second time (a second AI run, a second reply). The newest ids are now written to disk; entries
 * older than the TTL are dropped, since Feishu stops retrying long before that.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export class SeenEventStore {
  readonly #path?: string
  readonly #max: number
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #warn: (message: string) => void
  readonly #seen = new Map<string, number>()

  constructor(options: {
    /** Omit to keep the ids in memory only (tests, or no data directory). */
    path?: string
    max: number
    ttlMs?: number
    now?: () => number
    warn?: (message: string) => void
  }) {
    this.#path = options.path
    this.#max = options.max
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? Date.now
    this.#warn = options.warn ?? (() => {})
    this.#load()
  }

  /** True the first time a key is seen; false for a redelivery. */
  once(key: string): boolean {
    if (!key) return true
    const now = this.#now()
    const at = this.#seen.get(key)
    if (at !== undefined && now - at <= this.#ttlMs) return false
    this.#seen.delete(key)
    this.#seen.set(key, now)
    this.#trim(now)
    this.#save()
    return true
  }

  get size(): number {
    return this.#seen.size
  }

  #trim(now: number): void {
    for (const [key, at] of this.#seen) {
      if (now - at > this.#ttlMs) this.#seen.delete(key)
    }
    while (this.#seen.size > this.#max) {
      const oldest = this.#seen.keys().next()
      if (oldest.done) break
      this.#seen.delete(oldest.value)
    }
  }

  #load(): void {
    if (!this.#path) return
    const raw = readJsonObject(this.#path, this.#warn)
    const ids = raw?.ids
    if (!ids || typeof ids !== "object") return
    const entries = Object.entries(ids as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
      .sort((a, b) => a[1] - b[1])
    for (const [key, at] of entries) this.#seen.set(key, at)
    this.#trim(this.#now())
  }

  #save(): void {
    if (!this.#path) return
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify({ version: 1, ids: Object.fromEntries(this.#seen) })}\n`)
    } catch (err) {
      // Losing the file only reopens the restart window; it must not fail the message itself
      this.#warn(`failed to persist Feishu dedupe ids: ${(err as Error).message}`)
    }
  }
}
