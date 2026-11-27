import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Re-entrant FIFO async lock shared across HTTP API and Telegram callers.
 * Nested calls within the same async execution context run directly without deadlocking,
 * while `failFast: true` lets HTTP routes return 409 immediately on contention.
 */
export class ReEntrantWriteLock {
  readonly #scope = new AsyncLocalStorage<this>()
  #tail: Promise<void> = Promise.resolve()
  #active = 0

  async run<T>(
    fn: () => Promise<T>,
    options: { failFast?: boolean; onBusy?: () => Error } = {},
  ): Promise<T> {
    if (this.#scope.getStore() === this) return fn()
    if (options.failFast && this.#active > 0) {
      throw options.onBusy ? options.onBusy() : new Error("操作正在执行，请稍后再试")
    }
    this.#active += 1
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      return await this.#scope.run(this, fn)
    } finally {
      this.#active -= 1
      release()
    }
  }
}

export interface WriteLockable {
  runWriteLocked?: <R>(fn: () => Promise<R>, options?: { failFast?: boolean }) => Promise<R>
}

/** Runs `fn` under a service's shared fail-fast write lock, with a local fallback flag for test stubs. */
export async function runFailFastLock<T>(
  service: WriteLockable | undefined,
  onBusy: (message?: string) => Error,
  isServiceBusyError: (err: unknown) => boolean,
  getFallback: () => boolean,
  setFallback: (busy: boolean) => void,
  fn: () => Promise<T>,
): Promise<T> {
  if (service && typeof service.runWriteLocked === "function") {
    try {
      return await service.runWriteLocked(fn, { failFast: true })
    } catch (err) {
      if (isServiceBusyError(err)) throw onBusy(err instanceof Error ? err.message : undefined)
      throw err
    }
  }
  if (getFallback()) throw onBusy()
  setFallback(true)
  try { return await fn() } finally { setFallback(false) }
}

