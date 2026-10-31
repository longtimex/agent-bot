import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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
  sanitizeRepeat,
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

test("sanitizeRepeat rejects intervals outside the supported range", () => {
  assert.deepEqual(sanitizeRepeat({ type: "interval", ms: 60_000 }), { type: "interval", ms: 60_000 })
  assert.equal(sanitizeRepeat({ type: "interval", ms: 5_000 }), undefined)
  assert.equal(sanitizeRepeat({ type: "interval", ms: 400 * 86_400_000 }), undefined)
  assert.equal(sanitizeRepeat({ type: "interval", ms: Number.POSITIVE_INFINITY }), undefined)
  assert.deepEqual(sanitizeRepeat({ type: "daily", hour: 8, minute: 30 }), { type: "daily", hour: 8, minute: 30 })
  assert.equal(sanitizeRepeat({ type: "daily", hour: 24, minute: 0 }), undefined)
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

test("parseReminder accepts wall-clock times only a few seconds away", () => {
  // 2026-01-01 18:29:55 Asia/Shanghai
  const now = Date.UTC(2026, 0, 1, 10, 29, 55)
  assert.deepEqual(parseReminder("18:30 开会", now, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 1, 10, 30),
    text: "开会",
  })
  assert.deepEqual(parseReminder("每天 18:30 站会", now, "Asia/Shanghai"), {
    dueAt: Date.UTC(2026, 0, 1, 10, 30),
    text: "站会",
    repeat: { type: "daily", hour: 18, minute: 30 },
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
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderStore keeps a due reminder on disk until delivery settles", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const path = join(dir, "reminders.json")
    const store = new ReminderStore(path, log)
    const now = Date.now()
    const reminder = store.add(1, 10, "喝水", now - 5_000)

    const due = store.takeDue(now)
    assert.deepEqual(due.map((item) => item.id), [reminder.id])
    // A crash right after takeDue must not lose the reminder
    assert.equal(new ReminderStore(path, log).count(1), 1)
    // ...but it must not be picked up twice while it is being delivered
    assert.equal(store.takeDue(now).length, 0)

    store.settle(reminder.id)
    assert.equal(new ReminderStore(path, log).count(1), 0)
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
    assert.equal(sent.length, 2, "the expired reminder is reported instead of vanishing")
    assert.match(sent[1] ?? "", /已过期未发送/)
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

test("ReminderService keeps recurring reminders through a delivery outage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-reminders-"))
  try {
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async () => {
        throw new Error("network down")
      },
      log,
    )
    const now = Date.now()
    const once = service.add(42, 7, "10s 备份", now)
    const daily = service.add(42, 7, "every 1m 打卡", now)
    assert.equal(once.repeat, undefined)
    assert.ok(daily.repeat)

    // Two hours per tick clears every backoff window; after 8 failures the one-shot is
    // dropped while the recurrence keeps moving to its next occurrence
    for (let step = 1; step <= 12; step++) await service.tick(now + step * 2 * 60 * 60_000)

    const left = service.list(42)
    assert.equal(left.length, 1, "the recurrence must outlive the outage")
    assert.equal(left[0]?.id, daily.id)
    assert.ok((left[0]?.dueAt ?? 0) > now, "the skipped occurrence advanced the schedule")
    assert.equal(new ReminderStore(join(dir, "reminders.json"), log).count(42), 1)
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

test("parseReminder accepts Chinese durations, day parts and relative days", () => {
  // 2026-01-01 10:00 Asia/Shanghai
  const now = Date.UTC(2026, 0, 1, 2, 0)
  const tz = "Asia/Shanghai"

  assert.deepEqual(parseReminder("5分钟后 喝水", now, tz), { dueAt: now + 5 * 60_000, text: "喝水" })
  assert.deepEqual(parseReminder("半小时后 休息", now, tz), { dueAt: now + 30 * 60_000, text: "休息" })
  assert.deepEqual(parseReminder("1小时30分钟后 站会", now, tz), { dueAt: now + 90 * 60_000, text: "站会" })
  assert.deepEqual(parseReminder("每5分钟 喝水", now, tz), {
    dueAt: now + 5 * 60_000,
    text: "喝水",
    repeat: { type: "interval", ms: 5 * 60_000 },
  })

  assert.deepEqual(parseReminder("下午3点 开会", now, tz), { dueAt: Date.UTC(2026, 0, 1, 7, 0), text: "开会" })
  assert.deepEqual(parseReminder("今晚8点半 电影", now, tz), { dueAt: Date.UTC(2026, 0, 1, 12, 30), text: "电影" })
  assert.deepEqual(parseReminder("明天早上8点 打卡", now, tz), { dueAt: Date.UTC(2026, 0, 2, 0, 0), text: "打卡" })
  assert.deepEqual(parseReminder("后天 09:00 复诊", now, tz), { dueAt: Date.UTC(2026, 0, 3, 1, 0), text: "复诊" })
  assert.deepEqual(parseReminder("每天8点半 打卡", now, tz), {
    dueAt: Date.UTC(2026, 0, 2, 0, 30),
    text: "打卡",
    repeat: { type: "daily", hour: 8, minute: 30 },
  })

  // 晚上12点 is midnight, not noon; 中午 stays literal
  // 晚上12点 is midnight, not noon (Beijing 00:00 Jan 2 = 16:00 Jan 1 UTC)
  assert.deepEqual(parseReminder("晚上12点 吃药", now, tz), { dueAt: Date.UTC(2026, 0, 1, 16, 0), text: "吃药" })
  assert.deepEqual(parseReminder("今晚12点半 吃药", now, tz), { dueAt: Date.UTC(2026, 0, 1, 16, 30), text: "吃药" })
  assert.deepEqual(parseReminder("中午11点 吃饭", now, tz), { dueAt: Date.UTC(2026, 0, 1, 3, 0), text: "吃饭" })
  assert.deepEqual(parseReminder("中午12点 休息", now, tz), { dueAt: Date.UTC(2026, 0, 1, 4, 0), text: "休息" })

  // 每/每隔 + 钟点 = 每天循环，而不是静默退化为一次性提醒
  assert.deepEqual(parseReminder("每 8点 喝水", now, tz), {
    dueAt: Date.UTC(2026, 0, 2, 0, 0),
    text: "喝水",
    repeat: { type: "daily", hour: 8, minute: 0 },
  })
  assert.deepEqual(parseReminder("every 18:30 站会", now, tz), {
    dueAt: Date.UTC(2026, 0, 1, 10, 30),
    text: "站会",
    repeat: { type: "daily", hour: 18, minute: 30 },
  })

  // A daily slot later today is kept for the first occurrence (no 1s skip window)
  assert.deepEqual(parseReminder("每天 11:00 打卡", now, tz), {
    dueAt: Date.UTC(2026, 0, 1, 3, 0),
    text: "打卡",
    repeat: { type: "daily", hour: 11, minute: 0 },
  })

  // 20:00 local: 18:00 today is already gone rather than silently moved to tomorrow
  assert.throws(() => parseReminder("今天晚上6点 开会", Date.UTC(2026, 0, 1, 12, 0), tz), /已过/)
  assert.throws(() => parseReminder("前天 08:30 复盘", now, tz), /过去/)
})

test("ReminderService does not deliver to a user who lost bot access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-rem-"))
  try {
    const sent: string[] = []
    const now = Date.now()
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (chatId, text) => {
        sent.push(`${chatId}:${text}`)
      },
      log,
      "Asia/Shanghai",
      () => false,
    )
    service.add(42, 7, "30m 喝水", now - 30 * 60_000)
    await service.tick(now)

    assert.deepEqual(sent, [])
    assert.equal(service.list(42).length, 1, "the reminder keeps its slot and backs off")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupt reminder store refuses to overwrite the damaged file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-rem-"))
  const path = join(dir, "reminders.json")
  const broken = '{"nextId":4,"reminders":[{"id":2,"chatId":42,"text'
  try {
    writeFileSync(path, broken)
    const service = new ReminderService(path, async () => {}, log, "Asia/Shanghai")

    assert.throws(() => service.add(42, 7, "30m 喝水", Date.now()), /无法解析/)
    assert.equal(readFileSync(path, "utf8"), broken, "the recoverable file must survive untouched")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a reminder that expired during downtime is reported instead of vanishing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-rem-"))
  try {
    const now = Date.now()
    const eightDaysLate = now - 8 * 24 * 60 * 60 * 1000
    const sent: string[] = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, text) => {
        sent.push(text)
      },
      log,
      "Asia/Shanghai",
    )
    service.add(42, 7, "30m 喝水", eightDaysLate)
    await service.tick(now)

    assert.equal(service.list(42).length, 0)
    assert.equal(sent.length, 1, `expected one expiry notice, got ${JSON.stringify(sent)}`)
    assert.match(sent[0] ?? "", /已过期未发送/)

    const broken = new ReminderService(
      join(dir, "reminders2.json"),
      async () => {
        throw new Error("403: bot was blocked by the user")
      },
      log,
      "Asia/Shanghai",
    )
    broken.add(42, 7, "30m 喝水", eightDaysLate)
    await broken.tick(now)
    assert.equal(broken.list(42).length, 0, "an undeliverable notice must not wedge the tick")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ReminderService.snooze re-arms a one-shot reminder with the same text", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-"))
  try {
    const service = new ReminderService(join(dir, "reminders.json"), async () => {}, log)
    const now = Date.now()
    const reminder = service.snooze(42, 7, "给花浇水", 10, now)
    assert.equal(reminder.text, "给花浇水")
    assert.equal(reminder.dueAt, now + 10 * 60_000)
    assert.equal(reminder.repeat, undefined)
    assert.equal(service.list(42).length, 1)

    assert.throws(() => service.snooze(42, 7, "太久了", 60 * 24 * 8), /1 分钟到 7 天/)
    assert.throws(() => service.snooze(42, 7, "零分钟", 0), /1 分钟到 7 天/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reminder delivery passes the reminder so the bridge can offer snooze buttons", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-delivery-"))
  try {
    const delivered: Array<{ text: string; reminder?: { id: number; repeat?: unknown } }> = []
    const service = new ReminderService(
      join(dir, "reminders.json"),
      async (_chatId, _text, reminder) => {
        delivered.push({ text: _text, reminder })
      },
      log,
    )
    const now = Date.now()
    service.add(42, 7, "30s 测试投递", now)
    await service.tick(now + 31_000)
    assert.equal(delivered.length, 1)
    // One-shot: the bridge gets the reminder (for snooze buttons); repeating ones too,
    // and the bridge decides via repeat whether to attach the keyboard
    assert.ok(delivered[0]?.reminder, "one-shot delivery should carry the reminder")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
