import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { SeenEventStore } from "../src/feishuSeen.js"

test("a redelivered event is still recognised after a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-feishu-seen-"))
  try {
    const path = join(dir, "feishu-seen-events.json")
    const before = new SeenEventStore({ path, max: 100 })
    assert.equal(before.once("ev_1"), true)
    assert.equal(before.once("ev_1"), false)

    // A new process reads the same data dir: the platform's retry must not run the prompt again
    const after = new SeenEventStore({ path, max: 100 })
    assert.equal(after.once("ev_1"), false)
    assert.equal(after.once("ev_2"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("old ids expire and the store stays bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-feishu-seen-cap-"))
  try {
    const path = join(dir, "feishu-seen-events.json")
    const clock = { now: 1_000 }
    const store = new SeenEventStore({ path, max: 3, ttlMs: 10_000, now: () => clock.now })
    for (const id of ["a", "b", "c", "d"]) {
      clock.now += 1
      store.once(id)
    }
    assert.equal(store.size, 3, "the oldest id is evicted past the cap")
    assert.equal(store.once("a"), true, "an evicted id counts as new")

    clock.now += 20_000
    const reloaded = new SeenEventStore({ path, max: 3, ttlMs: 10_000, now: () => clock.now })
    assert.equal(reloaded.size, 0, "expired ids are not loaded back")
    assert.equal(reloaded.once("d"), true)
    assert.match(readFileSync(path, "utf8"), /"version":1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a damaged file starts empty instead of failing delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-feishu-seen-bad-"))
  try {
    const path = join(dir, "feishu-seen-events.json")
    writeFileSync(path, "{not json")
    const warnings: string[] = []
    const store = new SeenEventStore({ path, max: 10, warn: (message) => void warnings.push(message) })
    assert.equal(store.once("ev"), true)
    assert.ok(warnings.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an empty key is never treated as a duplicate and memory-only mode works", () => {
  const store = new SeenEventStore({ max: 10 })
  assert.equal(store.once(""), true)
  assert.equal(store.once(""), true)
  assert.equal(store.once("x"), true)
  assert.equal(store.once("x"), false)
})
