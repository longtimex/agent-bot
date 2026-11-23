import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { withFileLock } from "../src/fileLock.js"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("withFileLock runs the body and always releases the lock", () => {
  const dir = tempDir("bot-lock-")
  try {
    const target = join(dir, "models.json")
    const seen = withFileLock(target, () => existsSync(`${target}.lock`))
    assert.equal(seen, true, "the lock must be held while the body runs")
    assert.equal(existsSync(`${target}.lock`), false, "the lock must be gone afterwards")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock releases the lock when the body throws", () => {
  const dir = tempDir("bot-lock-throw-")
  try {
    const target = join(dir, "models.json")
    assert.throws(
      () =>
        withFileLock(target, () => {
          throw new Error("boom")
        }),
      /boom/,
    )
    assert.equal(existsSync(`${target}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock waits for a live holder and then gives up", () => {
  const dir = tempDir("bot-lock-busy-")
  try {
    const target = join(dir, "models.json")
    // Stand in for another live process that holds the lock: our own pid is alive
    writeFileSync(`${target}.lock`, String(process.pid))
    const started = Date.now()
    assert.throws(() => withFileLock(target, () => "never", { timeoutMs: 40 }), /正被另一个进程写入/)
    assert.ok(Date.now() - started >= 30, "it must actually wait before failing")
    // The lock belongs to the other writer, so a failed acquire must leave it in place
    assert.equal(readFileSync(`${target}.lock`, "utf8"), String(process.pid))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock reclaims a lock whose owner process is gone", () => {
  const dir = tempDir("bot-lock-stale-")
  try {
    const target = join(dir, "models.json")
    // A pid far above any real pid_max: the owner cannot be alive
    writeFileSync(`${target}.lock`, "2147483646")
    const ran = withFileLock(target, () => "ran", { timeoutMs: 500 })
    assert.equal(ran, "ran")
    assert.equal(existsSync(`${target}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock does not delete a lock it no longer owns", () => {
  const dir = tempDir("bot-lock-owner-")
  try {
    const target = join(dir, "models.json")
    withFileLock(target, () => {
      // Another process reclaimed and re-took the lock while the body ran
      writeFileSync(`${target}.lock`, "1 other")
    })
    assert.equal(readFileSync(`${target}.lock`, "utf8"), "1 other", "release must only remove its own lock")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock clears a directory lock left by an older version", () => {
  const dir = tempDir("bot-lock-legacy-")
  try {
    const target = join(dir, "models.json")
    mkdirSync(`${target}.lock`)
    assert.equal(withFileLock(target, () => "ran", { timeoutMs: 200 }), "ran")
    assert.equal(existsSync(`${target}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock creates the parent directory of a registry that does not exist yet", () => {
  const dir = tempDir("bot-lock-nested-")
  try {
    const target = join(dir, "data", "models.json")
    const ran = withFileLock(target, () => "ran")
    assert.equal(ran, "ran")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
