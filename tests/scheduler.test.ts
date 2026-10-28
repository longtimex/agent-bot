import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import {
  MAX_SCHEDULES_PER_CHAT,
  parseScheduleAdd,
  ScheduleService,
  ScheduleStore,
  scheduleTargetLabel,
  type ScheduleDefaults,
} from "../src/scheduler.js"
import type { UsageOutcome } from "../src/usage.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const GEMINI = { providerID: "custom", modelID: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash" }
const defaults: ScheduleDefaults = { engine: "opencode", model: GEMINI }

test("parseScheduleAdd parses time, prompt and defaults", () => {
  const now = 1_700_000_000_000
  assert.deepEqual(parseScheduleAdd("30m 检查服务器", defaults, now), {
    prompt: "检查服务器",
    dueAt: now + 30 * 60_000,
    repeat: undefined,
    engine: "opencode",
    model: GEMINI,
    qoderModel: undefined,
  })
})

test("parseScheduleAdd honours engine and model flags in any order", () => {
  const now = 1_700_000_000_000

  const qoder = parseScheduleAdd("--model deepseek --engine qoder every 2h 汇总日志", defaults, now)
  assert.equal(qoder.engine, "qoder")
  assert.equal(qoder.qoderModel, "DeepSeek-Flash")
  assert.equal(qoder.model, undefined)
  assert.deepEqual(qoder.repeat, { type: "interval", ms: 2 * 3_600_000 })
  assert.equal(qoder.prompt, "汇总日志")

  const sonnet = parseScheduleAdd("--model sonnet 每天 09:00 生成日报", defaults, now)
  assert.equal(sonnet.model?.label, "Claude Sonnet 5.5")
  assert.deepEqual(sonnet.repeat, { type: "daily", hour: 9, minute: 0 })

  const qwen = parseScheduleAdd("-e qoder -m qwen 10m 检查", defaults, now)
  assert.equal(qwen.qoderModel, "Qwen3.8-Flash")
})

test("parseScheduleAdd rejects invalid targets", () => {
  const now = 1_700_000_000_000
  assert.throws(() => parseScheduleAdd("--engine nope 30m 检查", defaults, now), /仅支持 opencode 或 qoder/)
  assert.throws(() => parseScheduleAdd("--model nope 30m 检查", defaults, now), /未识别的模型/)
  assert.throws(() => parseScheduleAdd("--engine qoder --model sonnet 30m 检查", defaults, now), /deepseek 或 qwen/)
  assert.throws(() => parseScheduleAdd("30m", defaults, now), /补充定时任务内容/)
  assert.throws(() => parseScheduleAdd("5s 检查", defaults, now), /10 秒/)
})

test("scheduleTargetLabel describes the run target", () => {
  assert.equal(scheduleTargetLabel({ engine: "opencode", model: GEMINI }), "OpenCode / Gemini 3.8 Flash")
  assert.equal(scheduleTargetLabel({ engine: "qoder", qoderModel: "DeepSeek-Flash" }), "Qoder / DeepSeek-Flash")
})

test("ScheduleStore persists tasks atomically and recovers crashed runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const path = join(dir, "schedules.json")
    const store = new ScheduleStore(path, log)
    const task = store.add({
      chatId: 42,
      userId: 7,
      prompt: "检查服务器",
      dueAt: Date.now() + 60_000,
      createdAt: Date.now(),
      engine: "opencode",
      model: GEMINI,
      runningAt: Date.now(),
    })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(store.count(42), 1)

    const reloaded = new ScheduleStore(path, log)
    const [restored] = reloaded.list(42)
    assert.equal(restored?.id, task.id)
    assert.equal(restored?.runningAt, undefined)
    assert.deepEqual(restored?.model, GEMINI)
    assert.equal(reloaded.list(99).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
});

test("ScheduleStore ignores malformed records", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const path = join(dir, "schedules.json")
    writeFileSync(
      path,
      JSON.stringify({
        nextId: 9,
        tasks: [
          { id: 1, chatId: 42, dueAt: 1, prompt: "" },
          { id: 2, chatId: 42, dueAt: 1, prompt: "ok", engine: "weird", repeat: { type: "interval", ms: 1 } },
        ],
      }),
    )
    const store = new ScheduleStore(path, log)
    const items = store.list(42)
    assert.equal(items.length, 1)
    assert.equal(items[0]?.engine, "opencode")
    assert.equal(items[0]?.repeat, undefined)
    assert.equal(store.add({ chatId: 42, userId: 0, prompt: "x", dueAt: 2, createdAt: 1, engine: "qoder" }).id, 9)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService runs due one-off tasks once and removes them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const now = 1_700_000_000_000
    const ran: string[] = []
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async (task) => {
        ran.push(task.prompt)
        return "ok"
      },
      log,
      "Asia/Shanghai",
    )
    const task = service.add(42, 7, "30m 检查服务器", defaults, now)
    await service.tick(now + 60_000)
    await service.idle()
    assert.deepEqual(ran, [])

    await service.tick(now + 30 * 60_000)
    await service.idle()
    assert.deepEqual(ran, ["检查服务器"])
    assert.equal(service.count(42), 0)
    assert.equal(task.id, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService reschedules recurring tasks and skips paused ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const now = Date.now()
    let runs = 0
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async () => {
        runs += 1
        return "ok"
      },
      log,
      "Asia/Shanghai",
    )
    // Created 30 minutes ago, so it is due right now
    const task = service.add(42, 7, "every 30m 检查", defaults, now - 30 * 60_000)
    service.pause(42, task.id)
    await service.tick(now)
    await service.idle()
    assert.equal(runs, 0)

    service.resume(42, task.id)
    await service.tick(now)
    await service.idle()
    assert.equal(runs, 1)
    const [next] = service.list(42)
    assert.ok((next?.dueAt ?? 0) > now)
    assert.equal(next?.repeat?.type, "interval")
    assert.equal(next?.lastStatus, "ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService drops stale one-off tasks and rolls recurring ones forward", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const now = 1_700_000_000_000
    const runs: number[] = []
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async (task) => {
        runs.push(task.id)
        return "ok"
      },
      log,
      "Asia/Shanghai",
    )
    const oneOff = service.add(42, 7, "30m one", defaults, now)
    const recurring = service.add(42, 7, "每天 09:00 daily", defaults, now)
    const stale = now + 30 * 60_000 + 8 * 86_400_000
    await service.tick(stale)
    await service.idle()
    assert.deepEqual(runs, [])
    assert.equal(service.list(42).some((task) => task.id === oneOff.id), false)
    const daily = service.list(42).find((task) => task.id === recurring.id)
    assert.ok((daily?.dueAt ?? 0) > stale)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService keeps a one-off task when shutdown cancels it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const now = 1_700_000_000_000
    let finish: (outcome: UsageOutcome) => void = () => {}
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      () => new Promise<UsageOutcome>((resolve) => {
        finish = resolve
      }),
      log,
      "Asia/Shanghai",
    )
    const task = service.add(42, 7, "30m 检查", defaults, now)
    await service.tick(now + 30 * 60_000)
    service.dispose()
    finish("cancelled")
    await service.idle()
    const [kept] = service.list(42)
    assert.equal(kept?.id, task.id)
    assert.equal(kept?.runningAt, undefined)
    assert.equal(kept?.lastStatus, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService enforces the per-chat cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const service = new ScheduleService(join(dir, "schedules.json"), async () => "ok", log)
    for (let i = 0; i < MAX_SCHEDULES_PER_CHAT; i++) {
      service.add(42, 7, "30m 检查", defaults)
    }
    assert.throws(() => service.add(42, 7, "30m 检查", defaults), /最多创建/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Keep the raw file readable in failure reports and ensure persisted JSON is valid
test("schedule store writes readable JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const path = join(dir, "schedules.json")
    const store = new ScheduleStore(path, log)
    store.add({
      chatId: 42,
      userId: 7,
      prompt: "检查",
      dueAt: 1,
      createdAt: 1,
      engine: "opencode",
      model: GEMINI,
    })
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks: unknown[] }
    assert.equal(parsed.tasks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
