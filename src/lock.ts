import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import type { Logger } from "./logger.js"

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Linux start time (field 22 of /proc/<pid>/stat) detects a recycled PID
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const close = stat.lastIndexOf(")")
    if (close < 0) return undefined
    return stat.slice(close + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

export function acquireLock(path: string, log: Logger): () => void {
  const ownerStart = processStartTime(process.pid)
  const owner = ownerStart ? `${process.pid} ${ownerStart}` : String(process.pid)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600)
      writeSync(fd, owner)
      closeSync(fd)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err

      let content = ""
      try {
        content = readFileSync(path, "utf8").trim()
      } catch {
        // lock disappeared meanwhile; retry
      }
      const tokens = content.split(/\s+/)
      const pid = Number.parseInt(tokens[0] ?? "", 10)
      const storedStart = tokens[1]
      const currentStart = pid > 0 ? processStartTime(pid) : undefined
      const sameProcess = !storedStart || !currentStart || storedStart === currentStart
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid) && sameProcess) {
        throw new Error(`已有实例正在运行（PID ${pid}，锁文件 ${path}）。如需重启请执行 npm run restart。`)
      }

      log.warn(`removing stale lock file ${path} (owner ${content || "unknown"})`)
      try {
        unlinkSync(path)
      } catch {
        // another process may have removed it first
      }
      continue
    }

    let released = false
    return () => {
      if (released) return
      released = true
      try {
        if (readFileSync(path, "utf8").trim() === owner) unlinkSync(path)
      } catch {
        // already gone
      }
    }
  }

  throw new Error(`无法获取锁文件 ${path}`)
}
