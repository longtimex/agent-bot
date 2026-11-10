import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { acquireLock, withFileLock } from "../src/lock.js"
import { createLogger } from "../src/logger.js"

const log = createLogger("error")

function tempLockDir(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "bot-lock-"))
  return { dir, path: join(dir, "bot.lock") }
}

test("acquireLock refuses a second live instance and releases cleanly", () => {
  const { dir, path } = tempLockDir()
  const release = acquireLock(path, log)
  assert.throws(() => acquireLock(path, log), /已有实例正在运行/)
  release()
  assert.equal(existsSync(path), false)
  rmSync(dir, { recursive: true, force: true })
})

test("a refused acquire leaves the live owner's lock file in place", () => {
  // Reclaiming moves the file aside first, so a live lock must be put back:
  // losing it would let yet another start believe no instance is running.
  const { dir, path } = tempLockDir()
  const release = acquireLock(path, log)
  try {
    const before = readFileSync(path, "utf8")
    assert.throws(() => acquireLock(path, log), /已有实例正在运行/)
    assert.equal(readFileSync(path, "utf8"), before)
    assert.deepEqual(readdirSync(dir), ["bot.lock"], "no claim file may be left behind")
  } finally {
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("acquireLock replaces a lock left by a dead process", () => {
  const { dir, path } = tempLockDir()
  const dead = spawnSync(process.execPath, ["-e", ""])
  assert.ok(dead.pid && dead.pid > 0)
  writeFileSync(path, String(dead.pid))

  const release = acquireLock(path, log)
  try {
    assert.equal(existsSync(path), true)
    assert.deepEqual(readdirSync(dir), ["bot.lock"], "the claimed stale file must be cleaned up")
  } finally {
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("release is idempotent", () => {
  const { dir, path } = tempLockDir()
  const release = acquireLock(path, log)
  release()
  release()
  rmSync(dir, { recursive: true, force: true })
})

test("acquireLock leaves no staging files behind", () => {
  const { dir, path } = tempLockDir()
  const release = acquireLock(path, log)
  try {
    assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid}( \\d+)?$`))
    assert.deepEqual(readdirSync(dir), ["bot.lock"])
  } finally {
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("acquireLock reclaims an empty lock file", () => {
  const { dir, path } = tempLockDir()
  writeFileSync(path, "")
  const release = acquireLock(path, log)
  try {
    assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid}( \\d+)?$`))
  } finally {
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("acquireLock reclaims a lock whose PID was recycled", { skip: !existsSync("/proc/self/stat") }, () => {
  const { dir, path } = tempLockDir()
  // Same PID but a different process start time means the PID now belongs to another process
  writeFileSync(path, `${process.pid} 0`)

  const release = acquireLock(path, log)
  try {
    const content = readFileSync(path, "utf8")
    assert.notEqual(content, `${process.pid} 0`)
  } finally {
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock runs a transaction, returns its value and removes the lock", () => {
  const { dir } = tempLockDir()
  const lock = join(dir, "sessions.json.lock")
  try {
    const value = withFileLock(lock, log, () => {
      assert.equal(existsSync(lock), true, "the lock must exist for the whole transaction")
      return 42
    })
    assert.equal(value, 42)
    assert.equal(existsSync(lock), false)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock releases the lock when the transaction throws", () => {
  const { dir } = tempLockDir()
  const lock = join(dir, "sessions.json.lock")
  try {
    assert.throws(() => withFileLock(lock, log, () => {
      throw new Error("transaction failed")
    }), /transaction failed/)
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock reclaims a lock left by a dead process", () => {
  const { dir } = tempLockDir()
  const lock = join(dir, "sessions.json.lock")
  const dead = spawnSync(process.execPath, ["-e", ""])
  assert.ok(dead.pid && dead.pid > 0)
  writeFileSync(lock, String(dead.pid))
  try {
    assert.equal(withFileLock(lock, log, () => "reclaimed"), "reclaimed")
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock waits for a live owner and reports a timeout", () => {
  const { dir } = tempLockDir()
  const lock = join(dir, "sessions.json.lock")
  writeFileSync(lock, String(process.pid))
  try {
    assert.throws(() => withFileLock(lock, log, () => "never", 40, 60_000), /等待状态文件锁超时/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
