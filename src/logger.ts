import { copyFileSync, existsSync, readdirSync, statSync, truncateSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024

// copytruncate so the process's stdout file descriptor keeps working after rotation
export function rotateLogIfNeeded(path: string, maxBytes = LOG_ROTATE_BYTES, now = Date.now()): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    if (statSync(path).size < maxBytes) return undefined

    const date = new Date(now)
    const pad = (value: number, length = 2): string => String(value).padStart(length, "0")
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
      date.getMinutes(),
    )}${pad(date.getSeconds())}`
    const rotated = `${path}.${stamp}`
    copyFileSync(path, rotated)
    truncateSync(path, 0)
    return rotated
  } catch {
    return undefined
  }
}

// Keep only the newest N rotated logs: bot.log.20261028-120000 sorts by timestamp
export function pruneRotatedLogs(path: string, keep = 7): number {
  try {
    const base = basename(path)
    const dir = dirname(path)
    if (!existsSync(dir)) return 0
    const rotated = readdirSync(dir)
      .filter((entry) => entry.startsWith(`${base}.`) && entry !== base)
      .sort((a, b) => b.localeCompare(a))
    let pruned = 0
    for (const entry of rotated.slice(keep)) {
      try {
        unlinkSync(join(dir, entry))
        pruned++
      } catch {
        // ignore files we cannot remove
      }
    }
    return pruned
  } catch {
    return 0
  }
}

const order: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = order[level] ?? order.info

  const write = (lvl: LogLevel, args: unknown[]): void => {
    if (order[lvl] < threshold) return
    const prefix = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)}`
    const sink = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log
    sink(prefix, ...args)
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  }
}
