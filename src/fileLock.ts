import { mkdirSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"

export interface FileLockOptions {
  /** How long to wait for the holder before giving up. */
  timeoutMs?: number
  /** A lock older than this is treated as left behind by a crashed process. */
  staleMs?: number
}

const DEFAULTS = { timeoutMs: 5_000, staleMs: 30_000 }

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Serialises a read-modify-write across processes. `modelAdmin` already writes through a
 * temp file and rename, which keeps a torn file from appearing, but two writers that each
 * read the old contents still lose one of the updates. Creating a directory is atomic on
 * every filesystem Node targets, so the lock needs no native dependency.
 */
export function withFileLock<T>(target: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = `${target}.lock`
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const staleMs = options.staleMs ?? DEFAULTS.staleMs
  const started = Date.now()
  // The registry may not exist yet on a fresh install; recursive:true here only creates
  // the parent, the lock itself still needs a plain mkdir to stay atomic.
  mkdirSync(dirname(lockPath), { recursive: true })

  for (;;) {
    try {
      mkdirSync(lockPath)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      let age = 0
      try {
        age = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        // Released between mkdir and stat: retry immediately
        continue
      }
      if (age > staleMs) {
        rmSync(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`文件正被另一个进程写入（${lockPath}），请稍后重试`)
      }
      sleepSync(10)
    }
  }

  try {
    return fn()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}
