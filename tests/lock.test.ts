import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { acquireLock } from "../src/lock.js"
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

test("acquireLock replaces a lock left by a dead process", () => {
  const { dir, path } = tempLockDir()
  const dead = spawnSync(process.execPath, ["-e", ""])
  assert.ok(dead.pid && dead.pid > 0)
  writeFileSync(path, String(dead.pid))

  const release = acquireLock(path, log)
  try {
    assert.equal(existsSync(path), true)
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
