import {
  closeSync,
  mkdirSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"
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

function lockOwner(): string {
  const start = processStartTime(process.pid)
  return start ? `${process.pid} ${start}` : String(process.pid)
}

function parseLock(content: string): { pid: number; start?: string } | undefined {
  const [rawPid, start] = content.trim().split(/\s+/)
  const pid = Number.parseInt(rawPid ?? "", 10)
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, start } : undefined
}

/** A lock is stale when its owner is gone or the pid now belongs to a different process. */
function isStaleLock(path: string, content: string, staleAfterMs = 2_000): boolean {
  const owner = parseLock(content)
  if (!owner) {
    try {
      // openSync creates the file before writeSync runs. Give the owner a moment to finish.
      return Date.now() - statSync(path).mtimeMs > staleAfterMs
    } catch {
      return false
    }
  }
  if (!isAlive(owner.pid)) return true
  const currentStart = processStartTime(owner.pid)
  return !!owner.start && !!currentStart && owner.start !== currentStart
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

/**
 * Runs `fn` while holding a short-lived cross-process lock. Unlike acquireLock,
 * which protects the whole Bot process and fails immediately on a live owner,
 * this waits briefly for a peer's read-modify-write transaction to finish. The
 * lock file is removed in `finally`; a crashed owner is reclaimed on the next attempt.
 */
export function withFileLock<T>(
  path: string,
  log: Logger,
  fn: () => T,
  timeoutMs = 5_000,
  staleAfterMs = 2_000,
): T {
  mkdirSync(dirname(path), { recursive: true })
  const owner = lockOwner()
  const deadline = Date.now() + Math.max(1, timeoutMs)
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600)
      try {
        writeSync(fd, owner)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      let content = ""
      try {
        content = readFileSync(path, "utf8").trim()
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue
        throw readErr
      }

      if (isStaleLock(path, content, staleAfterMs)) {
        // Move the stale file aside and re-check what we actually claimed. A peer may
        // have released and reacquired it between our read and rename; in that case put
        // the live lock back instead of deleting someone else's transaction.
        const claim = `${path}.stale.${process.pid}.${Date.now().toString(36)}`
        try {
          renameSync(path, claim)
        } catch (moveErr) {
          if ((moveErr as NodeJS.ErrnoException).code === "ENOENT") continue
          throw moveErr
        }
        let claimed = ""
        try {
          claimed = readFileSync(claim, "utf8").trim()
        } catch {
          // Treat an unreadable claim as stale.
        }
        if (!isStaleLock(claim, claimed, staleAfterMs)) {
          try {
            linkSync(claim, path)
          } catch {
            // Another waiter won the free slot; it owns the lock now.
          }
          try {
            unlinkSync(claim)
          } catch {
            // claim already gone
          }
        } else {
          log.warn(`removing stale state lock ${path} (owner ${content || "unknown"})`)
          try {
            unlinkSync(claim)
          } catch {
            // claim already gone
          }
          continue
        }
      }

      if (Date.now() >= deadline) throw new Error(`等待状态文件锁超时：${path}`)
      sleepSync(10 + Math.floor(Math.random() * 15))
    }
  }

  let released = false
  try {
    return fn()
  } finally {
    if (!released) {
      released = true
      try {
        if (readFileSync(path, "utf8").trim() === owner) unlinkSync(path)
      } catch {
        // already gone
      }
    }
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
      const ownerInfo = parseLock(content)
      const sameProcess = !ownerInfo?.start || !processStartTime(ownerInfo.pid) || ownerInfo.start === processStartTime(ownerInfo.pid)
      if (ownerInfo && isAlive(ownerInfo.pid) && sameProcess) {
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
        throw new Error(`已有实例正在运行（PID ${ownerInfo.pid}，锁文件 ${path}）。如需重启请执行 npm run restart。`)
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
