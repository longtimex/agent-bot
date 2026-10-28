import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import { dateKey, UsageStore } from "../src/usage.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("dateKey groups by the configured timezone", () => {
  assert.equal(dateKey(Date.UTC(2026, 0, 1, 15, 59), "Asia/Shanghai"), "2026-01-01")
  assert.equal(dateKey(Date.UTC(2026, 0, 1, 16, 0), "Asia/Shanghai"), "2026-01-02")
})

test("UsageStore records outcomes, totals and engines", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const path = join(dir, "usage.json")
    const store = new UsageStore(path, log, "Asia/Shanghai")
    const now = Date.UTC(2026, 0, 1, 2, 0)

    store.record("tg:1", { engine: "opencode", model: "Gemini 3.8 Flash", ms: 2_000, outcome: "ok" }, now)
    store.record("tg:1", { engine: "opencode", model: "Gemini 3.8 Flash", ms: 4_000, outcome: "failed" }, now + 1_000)
    store.record("tg:1", { engine: "qoder", model: "Qwen3.8-Flash", ms: 6_000, outcome: "cancelled" }, now + 2_000)

    const summary = store.summary("tg:1", now + 3_000)
    assert.equal(summary.tasks, 3)
    assert.equal(summary.ok, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.cancelled, 1)
    assert.equal(summary.totalMs, 12_000)
    assert.deepEqual(summary.engines, { opencode: 2, qoder: 1 })
    assert.equal(summary.today.tasks, 3)
    assert.equal(summary.lastAt, now + 2_000)
    assert.equal(summary.lastEngine, "qoder")
    assert.equal(summary.lastModel, "Qwen3.8-Flash")

    const reloaded = new UsageStore(path, log, "Asia/Shanghai")
    assert.deepEqual(reloaded.summary("tg:1", now + 3_000), summary)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(reloaded.summary("tg:other", now).tasks, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore separates days by local midnight", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const store = new UsageStore(join(dir, "usage.json"), log, "Asia/Shanghai")
    const late = Date.UTC(2026, 0, 1, 15, 0) // 23:00 Asia/Shanghai, Jan 1
    const late2 = late + 1_000
    const midnight = Date.UTC(2026, 0, 1, 16, 0) // 00:00 Asia/Shanghai, Jan 2

    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, late)
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, late2)
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "failed" }, midnight)

    assert.equal(store.summary("tg:1", late2).today.tasks, 2)
    assert.equal(store.summary("tg:1", midnight).today.tasks, 1)
    assert.equal(store.summary("tg:1", midnight).tasks, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore tolerates a corrupt file and keeps recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const path = join(dir, "usage.json")
    writeFileSync(path, "{not json")
    const store = new UsageStore(path, log, "Asia/Shanghai")
    assert.equal(store.summary("tg:1").tasks, 0)

    store.record("tg:1", { engine: "opencode", ms: 500, outcome: "ok" })
    assert.equal(store.summary("tg:1").tasks, 1)
    assert.equal(new UsageStore(path, log, "Asia/Shanghai").summary("tg:1").tasks, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
