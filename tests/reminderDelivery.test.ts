import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { InlineKeyboard } from "grammy"
import type { Reminder } from "../src/reminders.js"
import { ReminderDelivery } from "../src/telegramReminderDelivery.js"

const HOUR = 3_600_000

function reminder(text = "喝水"): Reminder {
  return { id: 1, chatId: 42, userId: 7, text, dueAt: 0, createdAt: 0 }
}

function createDelivery(path: string, clock: { now: number }) {
  const keyboards: InlineKeyboard[] = []
  const snoozed: Array<{ chatId: number; userId: number; text: string; minutes: number }> = []
  const delivery = new ReminderDelivery({
    sendText: async (_chatId, _text, keyboard) => {
      if (keyboard) keyboards.push(keyboard)
      return true
    },
    snooze: (chatId, userId, text, minutes) => {
      snoozed.push({ chatId, userId, text, minutes })
      return { ...reminder(text), id: 2 }
    },
    path,
    now: () => clock.now,
  })
  return { delivery, keyboards, snoozed }
}

function tokenOf(keyboard: InlineKeyboard): string {
  const data = (keyboard.inline_keyboard[0]![0] as { callback_data: string }).callback_data
  return /^snooze:([0-9a-f]+):/.exec(data)![1]!
}

test("a snooze button still works after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-"))
  try {
    const path = join(dir, "reminder-snoozes.json")
    const clock = { now: 1_000_000 }
    const first = createDelivery(path, clock)
    await first.delivery.deliver(42, "⏰ 提醒 #1：喝水", reminder())
    const token = tokenOf(first.keyboards[0]!)

    // A new process reads the same data dir
    clock.now += HOUR
    const second = createDelivery(path, clock)
    const answers: Array<string | undefined> = []
    await second.delivery.snooze(42, token, 10, async (text) => void answers.push(text))
    assert.deepEqual(second.snoozed, [{ chatId: 42, userId: 7, text: "喝水", minutes: 10 }])
    assert.equal(answers[0], "已安排稍后提醒")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a used snooze token is gone for good, even across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-used-"))
  try {
    const path = join(dir, "reminder-snoozes.json")
    const clock = { now: 1_000_000 }
    const first = createDelivery(path, clock)
    await first.delivery.deliver(42, "⏰ 提醒", reminder())
    const token = tokenOf(first.keyboards[0]!)
    await first.delivery.snooze(42, token, 10, async () => {})

    const second = createDelivery(path, clock)
    const answers: Array<string | undefined> = []
    await second.delivery.snooze(42, token, 10, async (text) => void answers.push(text))
    assert.equal(second.snoozed.length, 0, "a double tap must not arm the reminder twice")
    assert.equal(answers[0], "该按钮已过期")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a snooze token expires after 24 hours", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-ttl-"))
  try {
    const path = join(dir, "reminder-snoozes.json")
    const clock = { now: 1_000_000 }
    const first = createDelivery(path, clock)
    await first.delivery.deliver(42, "⏰ 提醒", reminder())
    const token = tokenOf(first.keyboards[0]!)

    clock.now += 25 * HOUR
    const answers: Array<string | undefined> = []
    await first.delivery.snooze(42, token, 10, async (text) => void answers.push(text))
    assert.equal(first.snoozed.length, 0)
    assert.equal(answers[0], "该按钮已过期")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token from another chat is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-chat-"))
  try {
    const clock = { now: 1_000_000 }
    const h = createDelivery(join(dir, "reminder-snoozes.json"), clock)
    await h.delivery.deliver(42, "⏰ 提醒", reminder())
    const token = tokenOf(h.keyboards[0]!)
    await h.delivery.snooze(99, token, 10, async () => {})
    assert.equal(h.snoozed.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a damaged token file is ignored instead of breaking delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-snooze-bad-"))
  try {
    const path = join(dir, "reminder-snoozes.json")
    writeFileSync(path, "{not json")
    const h = createDelivery(path, { now: 1_000_000 })
    await h.delivery.deliver(42, "⏰ 提醒", reminder())
    assert.equal(h.keyboards.length, 1, "delivery still offers the buttons")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
