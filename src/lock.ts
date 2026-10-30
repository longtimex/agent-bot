import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
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

  // Write the owner first, then hard-link it into place: link() is atomic and
  // fails with EEXIST, so a competing process can never observe an empty lock
  // file and mistake it for a crashed owner.
  const staging = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(staging, owner, { mode: 0o600 })
      try {
        linkSync(staging, path)
      } finally {
        try {
          unlinkSync(staging)
        } catch {
          // staging already cleaned up
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err

      // Reclaim the existing lock by moving it aside: rename() is atomic, so only one
      // of several concurrently starting processes can take the stale file. Deleting
      // it in place would let a second starter unlink the fresh lock the first one has
      // just linked, and both would then run.
      const claim = `${path}.claim.${process.pid}.${Date.now().toString(36)}`
      try {
        renameSync(path, claim)
      } catch (moveErr) {
        // Someone else reclaimed it first; the path is free again.
        if ((moveErr as NodeJS.ErrnoException).code === "ENOENT") continue
        throw moveErr
      }

      let content = ""
      try {
        content = readFileSync(claim, "utf8").trim()
      } catch {
        // treat an unreadable claim as stale
      }
      const tokens = content.split(/\s+/)
      const pid = Number.parseInt(tokens[0] ?? "", 10)
      const storedStart = tokens[1]
      const currentStart = pid > 0 ? processStartTime(pid) : undefined
      const sameProcess = !storedStart || !currentStart || storedStart === currentStart
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid) && sameProcess) {
        // We raced with a lock that was fresh after all: put it back, unless a third
        // process has linked its own lock in the meantime.
        try {
          linkSync(claim, path)
        } catch {
          // another owner won the free slot
        }
        try {
          unlinkSync(claim)
        } catch {
          // claim already gone
        }
        throw new Error(`已有实例正在运行（PID ${pid}，锁文件 ${path}）。如需重启请执行 npm run restart。`)
      }

      log.warn(`removing stale lock file ${path} (owner ${content || "unknown"})`)
      try {
        unlinkSync(claim)
      } catch {
        // claim already gone
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
