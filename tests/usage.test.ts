import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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

test("UsageStore clears lastModel when the newest task has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const store = new UsageStore(join(dir, "usage.json"), log, "Asia/Shanghai")
    const now = Date.UTC(2026, 0, 1, 2, 0)
    store.record("tg:1", { engine: "opencode", model: "Gemini 3.8 Flash", ms: 1_000, outcome: "ok" }, now)
    assert.equal(store.summary("tg:1", now).lastModel, "Gemini 3.8 Flash")
    store.record("tg:1", { engine: "claude", ms: 1_000, outcome: "ok" }, now + 1_000)
    const summary = store.summary("tg:1", now + 1_000)
    assert.equal(summary.lastEngine, "claude")
    assert.equal(summary.lastModel, undefined)
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

test("UsageStore reports a zero-filled recent-day trend", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const store = new UsageStore(join(dir, "usage.json"), log, "Asia/Shanghai")
    const base = Date.UTC(2026, 0, 5, 4, 0) // 12:00 Asia/Shanghai, Jan 5
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, base)
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "failed" }, base - 2 * 86_400_000)

    const trend = store.recentDays("tg:1", 4, base)
    assert.deepEqual(
      trend.map((day) => day.day),
      ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"],
    )
    assert.deepEqual(
      trend.map((day) => day.tasks),
      [0, 1, 0, 1],
    )
    assert.equal(trend[1]!.failed, 1)
    assert.equal(trend[3]!.ok, 1)
    assert.equal(store.recentDays("tg:other", 3, base).length, 3)
    assert.equal(store.recentDays("tg:1", 99, base).length, 31)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore trend walks back calendar days across a DST transition", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const store = new UsageStore(join(dir, "usage.json"), log, "America/New_York")
    // 2026-11-02T04:30Z is 23:30 on Nov 1, the 25-hour fall-back day
    const at = Date.UTC(2026, 10, 2, 4, 30)
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, at)
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, Date.UTC(2026, 9, 31, 15, 0))

    const trend = store.recentDays("tg:1", 4, at)
    assert.equal(trend.length, 4)
    assert.deepEqual(
      trend.map((day) => day.day),
      ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"],
    )
    assert.deepEqual(
      trend.map((day) => day.tasks),
      [0, 0, 1, 1],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore re-buckets today after a live timezone change but keeps totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const store = new UsageStore(join(dir, "usage.json"), log, "Asia/Shanghai")
    const at = Date.UTC(2026, 0, 1, 20, 0) // 01-02 04:00 in Shanghai, 01-01 20:00 in UTC
    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, at)
    assert.equal(store.summary("tg:1", at).today.tasks, 1)

    store.setTimeZone("UTC")
    assert.equal(store.summary("tg:1", at).today.tasks, 0)
    assert.equal(store.summary("tg:1", at).tasks, 1)

    store.record("tg:1", { engine: "opencode", ms: 1_000, outcome: "ok" }, at)
    assert.equal(store.recentDays("tg:1", 1, at)[0]?.day, "2026-01-01")
    assert.equal(store.recentDays("tg:1", 1, at)[0]?.tasks, 1)
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
    const aside = readdirSync(dir).filter((name) => name.startsWith("usage.json.corrupt-"))
    assert.equal(aside.length, 1, "the damaged file must be kept for inspection")
    assert.equal(readFileSync(join(dir, aside[0]!), "utf8"), "{not json")

    store.record("tg:1", { engine: "opencode", ms: 500, outcome: "ok" })
    assert.equal(store.summary("tg:1").tasks, 1)
    assert.equal(new UsageStore(path, log, "Asia/Shanghai").summary("tg:1").tasks, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore keeps prototype-shaped keys from the data file as real records", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-proto-"))
  try {
    const path = join(dir, "usage.json")
    const day = Date.UTC(2026, 0, 1, 4, 0)
    // written as text on purpose: in an object literal __proto__ would set the prototype
    // instead of becoming the chat key the file really contains
    writeFileSync(
      path,
      '{"version":1,"chats":{"__proto__":{"tasks":2,"ok":2,"failed":0,"cancelled":0,"totalMs":9,' +
        '"engines":{"__proto__":3,"opencode":1},"days":{}}}}',
    )

    const store = new UsageStore(path, log, "UTC")
    const loaded = store.summary("__proto__", day)
    assert.equal(loaded.tasks, 2)
    assert.ok(Object.hasOwn(loaded.engines, "__proto__"), "an engine named __proto__ must still be counted")
    assert.equal(loaded.engines["__proto__"], 3)

    // the next save must not drop that record on the floor
    store.record("tg:1", { engine: "opencode", ms: 1, outcome: "ok" }, day)
    const saved = JSON.parse(readFileSync(path, "utf8")) as { chats: Record<string, unknown> }
    assert.ok(Object.hasOwn(saved.chats, "__proto__"), "record must survive the next save")

    const reloaded = new UsageStore(path, log, "UTC")
    assert.equal(reloaded.summary("__proto__", day).tasks, 2)
    assert.equal(reloaded.summary("tg:1", day).tasks, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore forgets chats dormant past the daily-trend window", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const path = join(dir, "usage.json")
    const store = new UsageStore(path, log, "UTC")
    const now = Date.UTC(2026, 5, 1)
    store.record("tg:quiet", { engine: "opencode", ms: 1_000, outcome: "ok" }, now - 40 * 86_400_000)
    assert.equal(store.summary("tg:quiet", now).tasks, 1)

    store.record("tg:active", { engine: "opencode", ms: 1_000, outcome: "ok" }, now)

    assert.equal(store.summary("tg:quiet", now).tasks, 0, "a dormant chat must be swept")
    assert.equal(store.summary("tg:active", now).tasks, 1)
    assert.doesNotMatch(readFileSync(path, "utf8"), /tg:quiet/, "the sweep must reach the file")
    assert.equal(new UsageStore(path, log, "UTC").summary("tg:active", now).tasks, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore keeps records that carry no timestamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-usage-"))
  try {
    const path = join(dir, "usage.json")
    const day = Date.UTC(2026, 5, 1)
    writeFileSync(path, '{"version":1,"chats":{"tg:legacy":{"tasks":4,"ok":4,"failed":0,"cancelled":0,"totalMs":9,"engines":{},"days":{}}}}')

    const store = new UsageStore(path, log, "UTC")
    store.record("tg:1", { engine: "opencode", ms: 1, outcome: "ok" }, day)

    assert.equal(store.summary("tg:legacy", day).tasks, 4)
    const saved = JSON.parse(readFileSync(path, "utf8")) as { chats: Record<string, unknown> }
    assert.ok(Object.hasOwn(saved.chats, "tg:legacy"), "an unplaceable record must not be guessed away")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
