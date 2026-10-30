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
    cliModel: undefined,
  })
})

test("parseScheduleAdd honours engine and model flags in any order", () => {
  const now = 1_700_000_000_000

  const qoder = parseScheduleAdd("--model deepseek --engine qoder every 2h 汇总日志", defaults, now)
  assert.equal(qoder.engine, "qoder")
  assert.equal(qoder.cliModel, "DeepSeek-Flash")
  assert.equal(qoder.model, undefined)
  assert.deepEqual(qoder.repeat, { type: "interval", ms: 2 * 3_600_000 })
  assert.equal(qoder.prompt, "汇总日志")

  const sonnet = parseScheduleAdd("--model sonnet 每天 09:00 生成日报", defaults, now)
  assert.equal(sonnet.model?.label, "Claude Sonnet 5.5")
  assert.deepEqual(sonnet.repeat, { type: "daily", hour: 9, minute: 0 })

  const qwen = parseScheduleAdd("-e qoder -m qwen 10m 检查", defaults, now)
  assert.equal(qwen.cliModel, "Qwen3.8-Flash")
})

test("parseScheduleAdd resolves custom CLI engines and models", () => {
  const now = 1_700_000_000_000
  const resolver = {
    resolveEngine: (raw: string) => (raw === "claude" ? "claude" : raw === "opencode" ? "opencode" : undefined),
    label: (engine: string) => (engine === "claude" ? "Claude Code" : engine),
    resolveModel: (engine: string, raw: string) => (engine === "claude" ? (raw === "sonnet" ? "sonnet" : undefined) : undefined),
    defaultModel: () => undefined,
  }

  const claude = parseScheduleAdd("--engine claude --model sonnet 30m 分析", defaults, now, undefined, resolver)
  assert.equal(claude.engine, "claude")
  assert.equal(claude.cliModel, "sonnet")
  assert.equal(claude.model, undefined)
  assert.throws(
    () => parseScheduleAdd("--engine claude --model nope 30m 分析", defaults, now, undefined, resolver),
    /未识别的模型/,
  )
  assert.throws(
    () => parseScheduleAdd("--engine unknown 30m 分析", defaults, now, undefined, resolver),
    /未识别的引擎/,
  )
})

test("parseScheduleAdd does not carry another engine's CLI model across --engine", () => {
  const now = 1_700_000_000_000
  const resolver = {
    resolveEngine: (raw: string) => (["claude", "codex"].includes(raw) ? raw : undefined),
    label: (engine: string) => engine,
    resolveModel: (_engine: string, raw: string) => (raw === "sonnet" ? "sonnet" : undefined),
    defaultModel: (engine: string) => (engine === "codex" ? "gpt-5" : engine === "claude" ? "sonnet" : undefined),
  }
  const claudeDefaults: ScheduleDefaults = { engine: "claude", cliModel: "sonnet" }

  const same = parseScheduleAdd("30m 检查", claudeDefaults, now, undefined, resolver)
  assert.equal(same.engine, "claude")
  assert.equal(same.cliModel, "sonnet")

  const switched = parseScheduleAdd("--engine codex 30m 检查", claudeDefaults, now, undefined, resolver)
  assert.equal(switched.engine, "codex")
  assert.equal(switched.cliModel, "gpt-5")

  const toOpencode = parseScheduleAdd("--engine opencode 30m 检查", claudeDefaults, now, undefined, resolver)
  assert.equal(toOpencode.engine, "opencode")
  assert.equal(toOpencode.cliModel, undefined)
  assert.equal(toOpencode.model?.label, "Gemini 3.8 Flash")
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
  assert.equal(scheduleTargetLabel({ engine: "qoder", cliModel: "DeepSeek-Flash" }), "Qoder / DeepSeek-Flash")
  const resolver = {
    resolveEngine: () => undefined,
    label: (engine: string) => (engine === "claude" ? "Claude Code" : engine),
    resolveModel: () => undefined,
    defaultModel: () => undefined,
  }
  assert.equal(scheduleTargetLabel({ engine: "claude", cliModel: "sonnet" }, resolver), "Claude Code / sonnet")
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
    assert.equal(items[0]?.engine, "weird")
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

test("ScheduleService runNow executes without touching the schedule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const now = Date.now()
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
    const task = service.add(42, 7, "every 2h 检查", defaults, now)
    const dueBefore = service.list(42)[0]?.dueAt
    service.pause(42, task.id)

    assert.equal(service.runNow(42, task.id)?.id, task.id)
    await service.idle()
    assert.deepEqual(ran, ["检查"])

    const [after] = service.list(42)
    assert.equal(after?.dueAt, dueBefore)
    assert.equal(after?.paused, true)
    assert.equal(after?.lastStatus, "ok")
    assert.ok((after?.lastRunAt ?? 0) > 0)
    assert.equal(after?.runningAt, undefined)

    assert.equal(service.runNow(42, 999), undefined)
    assert.equal(service.runNow(99, task.id), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService runNow rejects a task that is already running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const resolvers: Array<(outcome: UsageOutcome) => void> = []
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      () => new Promise<UsageOutcome>((resolve) => resolvers.push(resolve)),
      log,
      "Asia/Shanghai",
    )
    const task = service.add(42, 7, "every 2h 检查", defaults)
    service.runNow(42, task.id)
    assert.throws(() => service.runNow(42, task.id), /正在执行中/)

    resolvers[0]!("ok")
    await service.idle()
    assert.equal(service.list(42)[0]?.runningAt, undefined)

    service.runNow(42, task.id)
    resolvers[1]!("failed")
    await service.idle()
    assert.equal(service.list(42)[0]?.lastStatus, "failed")
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

test("ScheduleService retries a failed one-off task and then drops it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const base = Date.now()
    let runs = 0
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async () => {
        runs += 1
        return "failed"
      },
      log,
      "Asia/Shanghai",
    )
    service.add(42, 7, "30m 检查服务器", defaults, base - 3_600_000)

    await service.tick(base)
    await service.idle()
    assert.equal(runs, 1)
    assert.equal(service.list(42)[0]?.attempts, 1)

    // The retry delays grow, but every pending retry is still due under this clock
    for (const expected of [2, 3]) {
      await service.tick(base + 3_600_000)
      await service.idle()
      assert.equal(runs, expected)
      assert.equal(service.list(42)[0]?.attempts, expected)
    }

    await service.tick(base + 3_600_000)
    await service.idle()
    assert.equal(runs, 4)
    assert.equal(service.count(42), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService clears retry counter and keeps a recurring task that failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const base = Date.now()
    const service = new ScheduleService(join(dir, "schedules.json"), async () => "failed", log, "Asia/Shanghai")
    const task = service.add(42, 7, "every 2h 检查", defaults, base - 2 * 3_600_000)

    await service.tick(base)
    await service.idle()
    const [after] = service.list(42)
    assert.equal(after?.id, task.id)
    assert.equal(after?.attempts, undefined)
    assert.equal(after?.lastStatus, "failed")
    assert.ok((after?.dueAt ?? 0) > base)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService pauses a one-off task that the user cancelled before it ran", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-scheduler-"))
  try {
    const base = Date.now()
    const service = new ScheduleService(join(dir, "schedules.json"), async () => "cancelled", log, "Asia/Shanghai")
    const task = service.add(42, 7, "30m 检查服务器", defaults, base - 3_600_000)

    await service.tick(base)
    await service.idle()
    const [kept] = service.list(42)
    assert.equal(kept?.id, task.id)
    assert.equal(kept?.paused, true)
    assert.equal(kept?.runningAt, undefined)
    assert.equal(kept?.lastStatus, "cancelled")
    assert.equal(kept?.attempts, undefined)

    // It stays quiet while paused, and a resumed run behaves normally
    await service.tick(base + 60_000)
    await service.idle()
    assert.equal(service.list(42)[0]?.paused, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseScheduleAdd keeps a chat default that comes from model passthrough", () => {
  const now = 1_700_000_000_000
  const resolver = {
    resolveEngine: (raw: string) => (raw === "demo" ? "demo" : undefined),
    label: (engine: string) => engine,
    resolveModel: (_engine: string, raw: string) => (raw === "router" ? "router" : undefined),
    // no declared default for the engine, yet the chat runs on a passthrough model
    defaultModel: () => undefined,
  }
  const chatDefaults: ScheduleDefaults = { engine: "demo", cliModel: "router" }

  const kept = parseScheduleAdd("30m 跑一次", chatDefaults, now, undefined, resolver)
  assert.equal(kept.cliModel, "router")
  assert.equal(scheduleTargetLabel(kept, resolver), "demo / router")

  const switched = parseScheduleAdd("--engine demo 30m 跑一次", { engine: "opencode" }, now, undefined, resolver)
  assert.equal(switched.engine, "demo")
  assert.equal(switched.cliModel, undefined)
  assert.equal(scheduleTargetLabel(switched, resolver), "demo / CLI 默认")
})

test("ScheduleService pauses a due task whose owner lost bot access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-sched-"))
  try {
    const now = Date.now()
    const ran: string[] = []
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async (task) => {
        ran.push(task.prompt)
        return "ok"
      },
      log,
      "Asia/Shanghai",
      undefined,
      (userId) => userId !== 7,
    )
    service.add(42, 7, "30m 检查服务器", defaults, now - 30 * 60_000)
    await service.tick(now)
    await service.idle()

    assert.deepEqual(ran, [], "an AI run nobody can receive must not happen")
    const [held] = service.list(42)
    assert.equal(held?.paused, true)
    assert.equal(held?.lastStatus, "cancelled")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupt schedule store refuses to overwrite the damaged file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-sched-"))
  const path = join(dir, "schedules.json")
  const broken = '{"nextId":9,"tasks":[{"id":4,"chatId":42,'
  try {
    writeFileSync(path, broken)
    const service = new ScheduleService(path, async () => "ok", log, "Asia/Shanghai")

    assert.throws(() => service.add(42, 7, "30m 检查", defaults, Date.now()), /无法解析/)
    assert.equal(readFileSync(path, "utf8"), broken, "the recoverable file must survive untouched")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService announces a stale one-off task before dropping it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-sched-"))
  try {
    const now = 1_700_000_000_000
    const notices: Array<{ chatId: number; text: string }> = []
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async () => "ok",
      log,
      "Asia/Shanghai",
      undefined,
      undefined,
      (chatId, text) => {
        notices.push({ chatId, text })
      },
    )
    const task = service.add(42, 7, "30m 检查服务器", defaults, now)
    await service.tick(now + 30 * 60_000 + 8 * 86_400_000)
    await service.idle()

    assert.equal(service.count(42), 0)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.chatId, 42)
    assert.ok(notices[0]?.text.includes(`#${task.id}`), notices[0]?.text)
    assert.ok(notices[0]?.text.includes("已自动删除"), notices[0]?.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ScheduleService announces a one-off task that exhausted its retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-sched-"))
  try {
    const base = Date.now()
    const notices: string[] = []
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async () => "failed",
      log,
      "Asia/Shanghai",
      undefined,
      undefined,
      (_chatId, text) => {
        notices.push(text)
      },
    )
    service.add(42, 7, "30m 检查服务器", defaults, base - 3_600_000)
    for (let i = 0; i < 4; i++) {
      await service.tick(base + 3_600_000)
      await service.idle()
    }

    assert.equal(service.count(42), 0)
    assert.equal(notices.length, 1)
    assert.ok(notices[0]?.includes("连续失败 4 次"), notices[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a notice that fails to send does not break the scheduler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-sched-"))
  try {
    const now = 1_700_000_000_000
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async () => "ok",
      log,
      "Asia/Shanghai",
      undefined,
      undefined,
      () => Promise.reject(new Error("blocked by user")),
    )
    service.add(42, 7, "30m 检查服务器", defaults, now)
    await service.tick(now + 30 * 60_000 + 8 * 86_400_000)
    await service.idle()

    assert.equal(service.count(42), 0, "the stale task is still dropped")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
