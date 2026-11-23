import { rmSync, statSync } from "node:fs"
import { withFileLock as withStateLock } from "./lock.js"
import type { Logger } from "./logger.js"

export interface FileLockOptions {
  /** How long to wait for the holder before giving up. */
  timeoutMs?: number
  /**
   * Grace period for a lock file whose owner has not written its pid yet. A lock whose owner
   * process is gone is reclaimed at once, whatever its age.
   */
  staleMs?: number
}

const DEFAULTS = { timeoutMs: 5_000, staleMs: 2_000 }

const warnOnly = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
} as unknown as Logger

/**
 * Serialises a read-modify-write across processes. `modelAdmin` already writes through a
 * temp file and rename, which keeps a torn file from appearing, but two writers that each
 * read the old contents still lose one of the updates.
 *
 * This used to be a separate mkdir-based lock that judged staleness by age and reclaimed it
 * with a plain rmSync: two waiters that both saw a stale lock could each delete the other's
 * fresh one and run together, and release removed the lock without checking its owner. It now
 * delegates to the owner-checked lock in lock.ts (pid + start time, rename-to-claim reclaim,
 * release only by the owner), so the project has a single cross-process lock.
 */
export function withFileLock<T>(target: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = `${target}.lock`
  clearLegacyDirectoryLock(lockPath)
  try {
    return withStateLock(
      lockPath,
      warnOnly,
      fn,
      options.timeoutMs ?? DEFAULTS.timeoutMs,
      options.staleMs ?? DEFAULTS.staleMs,
    )
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("等待状态文件锁超时")) {
      throw new Error(`文件正被另一个进程写入（${lockPath}），请稍后重试`)
    }
    throw err
  }
}

/**
 * Versions before the unified lock held `<target>.lock` as a directory. One left behind by a
 * crash would make every open(wx) fail with EEXIST and every read fail with EISDIR, so the
 * registry could never be written again. A directory lock can only come from an older build;
 * only one bot runs per data directory, so a leftover one is safe to drop.
 */
function clearLegacyDirectoryLock(lockPath: string): void {
  try {
    if (statSync(lockPath).isDirectory()) rmSync(lockPath, { recursive: true, force: true })
  } catch {
    // no lock, or it is a regular lock file
  }
}
