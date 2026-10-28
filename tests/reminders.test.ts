import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import {
  describeRepeat,
  formatRemaining,
  formatReminderTime,
  MAX_PER_CHAT,
  nextReminderDue,
  parseReminder,
  ReminderService,
  ReminderStore,
} from "../src/reminders.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("parseReminder understands relative durations", () => {
  const now = 1_700_000_000_000
  assert.deepEqual(parseReminder("30m 喝水", now), { dueAt: now + 30 * 60_000, text: "喝水" })
  assert.deepEqual(parseReminder("1h30m 站会", now), { dueAt: now + 90 * 60_000, text: "站会" })
  assert.deepEqual(parseReminder("2d 交报告", now), { dueAt: now + 2 * 86_400_000, text: "交报告" })
})

test("parseReminder understands recurring intervals and daily reminders", () => {
  const now = 1_700_000_000_000
  assert.deepEqual(parseReminder("every 30m 喝水", now), {
    dueAt: now + 30 * 60_000,
    text: "喝水",
    repeat: { type: "interval", ms: 30 * 60_000 },
  })
  assert.deepEqual(parseReminder("每30m 喝水", now), {
    dueAt: now + 30 * 60_000,
    text: "喝水",
    repeat: { type: "interval", ms: 30 * 60_000 },
  })
  assert.deepEqual(parseReminder("每隔1h30m 站会", now), {
    dueAt: now + 90 * 60_000,
    text: "站会",
    repeat: { type: "interval", ms: 90 * 60_000 },
  })

  // 2026-01-01 10:00 Asia/Shanghai → next 08:30 is tomorrow
  const morning = Date.UTC(2026, 0, 1, 2, 0)
  assert.deepEqual(parseReminder("每天 08:30 打卡", morning, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 2, 0, 30),
    text: "打卡",
    repeat: { type: "daily", hour: 8, minute: 30 },
  })
  assert.deepEqual(parseReminder("每天08:30 打卡", morning, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 2, 0, 30),
    text: "打卡",
    repeat: { type: "daily", hour: 8, minute: 30 },
  })

  assert.throws(() => parseReminder("every 5s 喝水", now), /10 秒/)
  assert.throws(() => parseReminder("every 喝水", now), /重复提醒的格式/)
  assert.throws(() => parseReminder("每天 打卡", now), /每日提醒的格式/)
})

test("describeRepeat and nextReminderDue describe recurring schedules", () => {
  assert.equal(describeRepeat({ type: "interval", ms: 30 * 60_000 }), "每 30 分钟")
  assert.equal(describeRepeat({ type: "interval", ms: 90 * 60_000 }), "每 1 小时 30 分钟")
  assert.equal(describeRepeat({ type: "interval", ms: 2 * 86_400_000 }), "每 2 天")
  assert.equal(describeRepeat({ type: "daily", hour: 8, minute: 5 }), "每天 08:05")

  const now = Date.UTC(2026, 0, 1, 2, 0)
  const interval = { dueAt: now, repeat: { type: "interval" as const, ms: 60_000 } }
  assert.equal(nextReminderDue(interval, now), now + 60_000)
  assert.equal(nextReminderDue(interval, now + 2 * 60_000 + 500), now + 3 * 60_000)

  const daily = { dueAt: now, repeat: { type: "daily" as const, hour: 8, minute: 30 } }
  assert.equal(nextReminderDue(daily, now, "Asia/Shanghai"), Date.UTC(2026, 0, 2, 0, 30))
})

test("parseReminder rejects invalid input", () => {
  const now = 1_700_000_000_000
  assert.throws(() => parseReminder("5s 喝水", now), /10 秒/)
  assert.throws(() => parseReminder("400d 喝水", now), /365 天/)
  assert.throws(() => parseReminder("30m", now), /补充提醒内容/)
  assert.throws(() => parseReminder("soon 喝水", now), /无法识别/)
  assert.throws(() => parseReminder("25:00 开会", now), /HH:MM/)
})

test("parseReminder resolves wall-clock times in the configured timezone", () => {
  // 2026-01-01 10:00 Asia/Shanghai
  const morning = Date.UTC(2026, 0, 1, 2, 0)
  assert.deepEqual(parseReminder("18:30 开会", morning, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 1, 10, 30),
    text: "开会",
  })

  // 2026-01-01 20:00 Asia/Shanghai → 18:30 already passed, roll to tomorrow
  const evening = Date.UTC(2026, 0, 1, 12, 0)
  assert.deepEqual(parseReminder("18:30 开会", evening, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 2, 10, 30),
    text: "开会",
  })

  assert.deepEqual(parseReminder("明天 08:30 打卡", morning, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 2, 0, 30),
    text: "打卡",
  })
  assert.deepEqual(parseReminder("明天08:30 打卡", morning, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 2, 0, 30),
    text: "打卡",
  })
})

test("formatting helpers render local time and durations", () => {
  assert.equal(formatReminderTime(Date.UTC(2026, 0, 1, 10, 30), "Asia/Shanghai"), "01-01 18:30")
  assert.equal(formatRemaining(30_000), "30 秒")
  assert.equal(formatRemaining(90_000), "2 分钟")
  assert.equal(formatRemaining(90 * 60_000), "1 小时 30 分钟")
  assert.equal(formatRemaining(25 * 3_600_000), "1 天 1 小时")
})

test("ReminderStore persists reminders and keeps ids monotonic", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const path = join(dir, "reminders.json")
    const store = new ReminderStore(path, log)
    const now = Date.now()
    const later = store.add(1, 10, "later", now + 60_000)
    const sooner = store.add(1, 10, "sooner", now + 10_000)
    const other = store.add(2, 20, "other chat", now + 20_000)
    assert.deepEqual(
      store.list(1).map((item) => item.id),
      [sooner.id, later.id],
    )
    assert.equal(store.count(1), 2)

    const reloaded = new ReminderStore(path, log)
    assert.deepEqual(
      reloaded.list(1).map((item) => item.text),
      ["sooner", "later"],
    )
    const next = reloaded.add(1, 10, "new", now + 30_000)
    assert.equal(next.id, other.id + 1)

    assert.equal(reloaded.cancel(1, sooner.id)?.text, "sooner")
    assert.equal(reloaded.cancel(1, sooner.id), undefined)
    assert.equal(reloaded.cancel(2, sooner.id), undefined)
    assert.equal(reloaded.count(1), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService delivers due reminders once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const sent: Array<{ chatId: number; text: string }> = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (chatId, text) => {
        sent.push({ chatId, text })
      },
      log,
    )
    const now = Date.now()
    const reminder = service.add(42, 7, "10s 喝水", now)
    assert.equal(reminder.text, "喝水")

    await service.tick(now + 5_000)
    assert.equal(sent.length, 0)

    await service.tick(now + 11_000)
    assert.deepEqual(sent, [{ chatId: 42, text: `⏰ 提醒 #${reminder.id}：喝水` }])

    await service.tick(now + 60_000)
    assert.equal(sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService marks late deliveries and drops stale ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        sent.push(text)
      },
      log,
    )
    const now = Date.now()
    service.add(42, 7, "10s 茶", now)
    await service.tick(now + 130_000)
    assert.match(sent[0] ?? "", /提醒（补发）/)

    service.add(42, 7, "10s 报告", now)
    await service.tick(now + 8 * 86_400_000)
    assert.equal(sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService retries when delivery fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    let fail = true
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        if (fail) throw new Error("network down")
        sent.push(text)
      },
      log,
    )
    const now = Date.now()
    service.add(42, 7, "10s 备份", now)

    await service.tick(now + 11_000)
    assert.equal(sent.length, 0)
    assert.equal(service.list(42).length, 1)

    // Backoff defers the retry; a tick during the backoff window must not resend
    await service.tick(now + 20_000)
    assert.equal(sent.length, 0)
    assert.equal(service.list(42).length, 1)

    fail = false
    await service.tick(now + 80_000)
    assert.equal(sent.length, 1)
    assert.equal(service.list(42).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService repeats interval reminders after each delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        sent.push(text)
      },
      log,
    )
    const now = Date.now()
    const reminder = service.add(42, 7, "every 10s 喝水", now)
    assert.deepEqual(reminder.repeat, { type: "interval", ms: 10_000 })

    await service.tick(now + 11_000)
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /每 10 秒/)
    assert.equal(service.list(42).length, 1)

    const next = service.list(42)[0]!
    assert.ok(next.dueAt > now + 11_000)

    await service.tick(next.dueAt + 1_000)
    assert.equal(sent.length, 2)
    assert.equal(service.list(42).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService reschedules daily reminders at local wall-clock time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        sent.push(text)
      },
      log,
      "Asia/Shanghai",
    )
    const morning = Date.UTC(2026, 0, 1, 2, 0)
    const reminder = service.add(42, 7, "每天 08:30 打卡", morning)
    assert.equal(reminder.dueAt, Date.UTC(2026, 0, 2, 0, 30))

    await service.tick(reminder.dueAt + 1_000)
    assert.equal(sent.length, 1)
    assert.equal(service.list(42)[0]?.dueAt, Date.UTC(2026, 0, 3, 0, 30))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService skips stale recurring occurrences instead of dropping them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        sent.push(text)
      },
      log,
    )
    const now = Date.now()
    service.add(42, 7, "every 10m 巡检", now)

    const muchLater = now + 8 * 86_400_000
    await service.tick(muchLater)
    assert.equal(sent.length, 0)
    const next = service.list(42)[0]
    assert.ok(next)
    assert.ok(next.dueAt > muchLater)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService caps reminders per chat and start() delivers immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        sent.push(text)
      },
      log,
    )
    const now = Date.now()
    for (let i = 0; i < MAX_PER_CHAT; i++) {
      service.add(42, 7, `10m 提醒 ${i}`, now)
    }
    assert.throws(() => service.add(42, 7, "10m 超限", now), /最多设置/)

    // already due relative to real "now", so start() must flush it
    service.add(99, 7, "10s 立即", now - 20_000)
    service.start()
    service.dispose()
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /立即/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
