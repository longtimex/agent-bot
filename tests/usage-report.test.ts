import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig, StartupConfigError } from "../src/config.js"
import type { Logger } from "../src/logger.js"
import { UsageStore } from "../src/usage.js"
import {
  buildDailyReportData,
  DailyReportService,
  formatDailyReport,
  reportTimeMinutes,
  sourceLabel,
  trendBars,
} from "../src/usageReport.js"

const TZ = "Asia/Shanghai"
// 2026-10-31 13:30 UTC == 21:30 in Shanghai (after the default 21:00 push time)
const AFTER = Date.UTC(2026, 9, 31, 13, 30)
// 18:00 Shanghai, before the push time
const BEFORE = Date.UTC(2026, 9, 31, 10, 0)

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-usage-report-"))
}

function makeStore(dir: string): UsageStore {
  return new UsageStore(join(dir, "usage.json"), log, TZ)
}

function seed(store: UsageStore, now: number): void {
  store.record("tg:123", { engine: "opencode", ms: 60_000, outcome: "ok" }, now)
  store.record("tg:123", { engine: "opencode", ms: 30_000, outcome: "failed" }, now)
  store.record("api:app", { engine: "claude", ms: 90_000, outcome: "ok" }, now)
}

function makeService(store: UsageStore, path: string, sent: string[]): DailyReportService {
  return new DailyReportService({
    store,
    path,
    timeZone: () => TZ,
    time: "21:00",
    log,
    send: async (text) => {
      sent.push(text)
    },
  })
}

test("usage store aggregates totals across chats for a day and the trend window", () => {
  const dir = tempDir()
  try {
    const store = makeStore(dir)
    seed(store, AFTER)
    const rows = store.dayTotalsByChat(0, AFTER)
    assert.equal(rows.length, 2)
    const total = rows.reduce((sum, row) => sum + row.usage.tasks, 0)
    assert.equal(total, 3)
    assert.deepEqual(
      store.aggregateRecentDays(7, AFTER).map((day) => day.tasks),
      [0, 0, 0, 0, 0, 0, 3],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trend bars scale to the busiest day and stay empty without data", () => {
  assert.equal(trendBars(Array.from({ length: 7 }, (_, index) => ({ day: `d${index}`, tasks: 0, ok: 0, failed: 0, cancelled: 0, totalMs: 0 }))), "（无记录）")
  const bars = trendBars([
    { day: "d0", tasks: 0, ok: 0, failed: 0, cancelled: 0, totalMs: 0 },
    { day: "d1", tasks: 4, ok: 4, failed: 0, cancelled: 0, totalMs: 0 },
    { day: "d2", tasks: 8, ok: 8, failed: 0, cancelled: 0, totalMs: 0 },
  ])
  assert.match(bars, /[▂█]/)
})

test("daily report text mentions totals, sources and the trend", () => {
  const dir = tempDir()
  try {
    const store = makeStore(dir)
    seed(store, AFTER)
    const data = buildDailyReportData(store, TZ, AFTER)
    const text = formatDailyReport(data, TZ)
    assert.match(text, /每日用量报告/)
    assert.match(text, /今日任务：3 · ✅ 2 · ❌ 1 · 🚫 0/)
    assert.match(text, /Telegram 123 2/)
    assert.match(text, /App 1/)
    assert.match(text, /近 7 天/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("source labels cover telegram, app and unknown keys", () => {
  assert.equal(sourceLabel("tg:123456"), "Telegram 123456")
  assert.equal(sourceLabel("api:app"), "App")
  assert.equal(sourceLabel("custom"), "custom")
})

test("daily report sends once per local day, only after the configured time", async () => {
  const dir = tempDir()
  try {
    const store = makeStore(dir)
    seed(store, AFTER)
    const path = join(dir, "usage-report.json")
    const sent: string[] = []
    const service = makeService(store, path, sent)

    assert.equal(await service.tick(BEFORE), undefined)
    assert.equal(sent.length, 0)

    const text = await service.tick(AFTER)
    assert.ok(text?.includes("每日用量报告"))
    assert.equal(sent.length, 1)

    // Same day, still after the time: the sent marker holds
    assert.equal(await service.tick(AFTER + 60_000), undefined)
    assert.equal(sent.length, 1)

    // The day is only persisted after a successful send
    assert.ok(existsSync(path))
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { lastSent?: string }).lastSent, "2026-10-31")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daily report survives a restart without resending and catches up when started late", async () => {
  const dir = tempDir()
  try {
    const store = makeStore(dir)
    seed(store, AFTER)
    const path = join(dir, "usage-report.json")
    const sent: string[] = []
    const first = makeService(store, path, sent)
    await first.tick(AFTER)
    assert.equal(sent.length, 1)

    const second = makeService(store, path, sent)
    assert.equal(await second.tick(AFTER + 120_000), undefined)
    assert.equal(sent.length, 1)

    // A different day with no persisted marker catches up immediately
    const freshPath = join(dir, "usage-report-2.json")
    const late = makeService(store, freshPath, sent)
    assert.ok(await late.tick(AFTER))
    assert.equal(sent.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("preview renders the report without marking the day as sent", async () => {
  const dir = tempDir()
  try {
    const store = makeStore(dir)
    seed(store, AFTER)
    const sent: string[] = []
    const service = makeService(store, join(dir, "usage-report.json"), sent)
    assert.match(service.preview(AFTER), /每日用量报告/)
    assert.ok(await service.tick(AFTER))
    assert.equal(sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reportTimeMinutes parses HH:MM and falls back to 21:00", () => {
  assert.equal(reportTimeMinutes("09:05"), 545)
  assert.equal(reportTimeMinutes("21:00"), 1260)
  assert.equal(reportTimeMinutes("bogus"), 1260)
})

test("loadConfig parses the daily report switches and rejects a bad time", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7" }
  const enabled = loadConfig({ ...base, USAGE_DAILY_REPORT: "1", USAGE_DAILY_REPORT_TIME: "08:30" })
  assert.deepEqual(enabled.usageReport, { enabled: true, time: "08:30" })
  assert.deepEqual(loadConfig(base).usageReport, { enabled: false, time: "21:00" })
  assert.throws(() => loadConfig({ ...base, USAGE_DAILY_REPORT_TIME: "25:00" }), StartupConfigError)
})
