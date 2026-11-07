export interface AuthLimitDecision {
  allowed: boolean
  retryAfterSec: number
}

export interface AuthLimiterOptions {
  /** Failed attempts allowed inside one window before the key is blocked. */
  maxFailures?: number
  /** Sliding window for counting failures. */
  windowMs?: number
  /** How long a key stays blocked once the limit is reached. */
  blockMs?: number
  /** Upper bound on tracked keys, so hostile traffic cannot grow memory without limit. */
  maxKeys?: number
}

interface Entry {
  failures: number
  windowStart: number
  blockedUntil: number
}

const ALLOWED: AuthLimitDecision = { allowed: true, retryAfterSec: 0 }

/**
 * Counts failed bearer-token attempts per client address. The token is static, so a
 * brute-force guard is the only server-side cost an unauthenticated caller can be made
 * to pay. A cooldown is not a refusal of the address's legitimate traffic: the server
 * authorizes first and only consults this budget for a wrong token.
 */
export class AuthFailureLimiter {
  readonly #maxFailures: number
  readonly #windowMs: number
  readonly #blockMs: number
  readonly #maxKeys: number
  readonly #entries = new Map<string, Entry>()

  constructor(options: AuthLimiterOptions = {}) {
    this.#maxFailures = options.maxFailures ?? 10
    this.#windowMs = options.windowMs ?? 60_000
    this.#blockMs = options.blockMs ?? 300_000
    this.#maxKeys = options.maxKeys ?? 4096
  }

  check(key: string, now = Date.now()): AuthLimitDecision {
    const entry = this.#entries.get(key)
    if (!entry) return ALLOWED
    if (entry.blockedUntil > now) return this.#blocked(entry, now)
    if (entry.blockedUntil !== 0 || now - entry.windowStart >= this.#windowMs) {
      this.#entries.delete(key)
    }
    return ALLOWED
  }

  recordFailure(key: string, now = Date.now()): AuthLimitDecision {
    let entry = this.#entries.get(key)
    if (!entry || now - entry.windowStart >= this.#windowMs) {
      entry = { failures: 0, windowStart: now, blockedUntil: 0 }
      this.#entries.set(key, entry)
      this.#prune(now)
    }
    if (entry.blockedUntil > now) return this.#blocked(entry, now)

    entry.failures += 1
    if (entry.failures < this.#maxFailures) return ALLOWED

    entry.failures = 0
    entry.blockedUntil = now + this.#blockMs
    return this.#blocked(entry, now)
  }

  /**
   * A good token resets its address's failure count, but not a cooldown that count already
   * triggered. Behind nginx every phone is the same address, so letting an authenticated request
   * from a working App clear the block would hand an attacker sitting on the same proxy unlimited
   * tries: the App's own polling would launder the cooldown away between every attempt.
   */
  recordSuccess(key: string, now = Date.now()): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    if (entry.blockedUntil > now) return
    this.#entries.delete(key)
  }

  /** Drops expired records; called opportunistically so a long-running server stays small. */
  prune(now = Date.now()): number {
    return this.#prune(now)
  }

  get size(): number {
    return this.#entries.size
  }

  #prune(now: number): number {
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.blockedUntil > now) continue
      if (entry.blockedUntil === 0 && now - entry.windowStart < this.#windowMs) continue
      this.#entries.delete(key)
      removed++
    }
    // Keep the cap without sacrificing live cooldowns first. A newly seen address
    // whose window has not expired is exactly what address rotation produces, so
    // insertion order alone would let it evict the attacker's own block. Expired
    // records are already gone by here; prefer a non-blocked failure window, then
    // the cooldown that expires soonest. Only when every slot is blocked must a
    // block be dropped, which keeps memory bounded without pretending the server
    // can track unlimited addresses.
    while (this.#entries.size > this.#maxKeys) {
      let victim: string | undefined
      let victimBlockedUntil = Infinity
      for (const [key, entry] of this.#entries) {
        const blockedUntil = entry.blockedUntil > now ? entry.blockedUntil : 0
        if (blockedUntil === 0) {
          victim = key
          break
        }
        if (blockedUntil < victimBlockedUntil) {
          victim = key
          victimBlockedUntil = blockedUntil
        }
      }
      if (victim === undefined) break
      this.#entries.delete(victim)
    }
    return removed
  }

  #blocked(entry: Entry, now: number): AuthLimitDecision {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) }
  }
}
