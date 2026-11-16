import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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

test("withFileLock waits for a concurrent writer and then gives up", () => {
  const dir = tempDir("bot-lock-busy-")
  try {
    const target = join(dir, "models.json")
    // Stand in for another process that took the lock and is still writing
    mkdirSync(`${target}.lock`)
    const started = Date.now()
    assert.throws(() => withFileLock(target, () => "never", { timeoutMs: 40 }), /正被另一个进程写入/)
    assert.ok(Date.now() - started >= 30, "it must actually wait before failing")
    // The lock belongs to the other writer, so a failed acquire must leave it in place
    assert.equal(existsSync(`${target}.lock`), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock clears a lock left behind by a crashed process", () => {
  const dir = tempDir("bot-lock-stale-")
  try {
    const target = join(dir, "models.json")
    mkdirSync(`${target}.lock`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${target}.lock`, old, old)

    // A fresh process would wait forever on a stale lock; it must be reclaimed instead
    const ran = withFileLock(target, () => "ran", { timeoutMs: 500, staleMs: 5_000 })
    assert.equal(ran, "ran")
    assert.equal(existsSync(`${target}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withFileLock creates the parent directory of a registry that does not exist yet", () => {
  const dir = tempDir("bot-lock-nested-")
  try {
    const target = join(dir, "data", "models.json")
    writeFileSync(join(dir, "placeholder"), "")
    const ran = withFileLock(target, () => "ran")
    assert.equal(ran, "ran")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
