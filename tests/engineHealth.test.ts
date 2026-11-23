import assert from "node:assert/strict"
import test from "node:test"
import { EngineHealthMonitor, type EngineHealthDeps, type EngineOutcome } from "../src/engineHealth.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function harness(overrides: Partial<EngineHealthDeps> = {}) {
  const state = {
    engines: ["opencode", "codex"],
    opencodeUp: true,
    installed: new Map<string, boolean>([["codex", true]]),
    outcomes: new Map<string, EngineOutcome[]>(),
    sent: [] as string[],
    failSend: false,
  }
  const monitor = new EngineHealthMonitor({
    engines: () => state.engines,
    label: (engine) => (engine === "codex" ? "Codex CLI" : "OpenCode"),
    opencodeOnDemand: false,
    opencodeHealthy: async () => state.opencodeUp,
    cliInstalled: (engine) => state.installed.get(engine),
    recentOutcomes: (engine) => [...(state.outcomes.get(engine) ?? [])],
    send: async (text) => {
      if (state.failSend) throw new Error("offline")
      state.sent.push(text)
    },
    log,
    ...overrides,
  })
  return { monitor, state }
}

const failed = (at: number, errorCode: string): EngineOutcome => ({ at, outcome: "failed", errorCode })

test("a problem is reported once, then its recovery once", async () => {
  const { monitor, state } = harness()
  assert.equal(await monitor.check(), undefined, "all healthy: nothing to say")

  state.opencodeUp = false
  assert.match((await monitor.check()) ?? "", /OpenCode：OpenCode 服务无法连接/)
  assert.equal(await monitor.check(), undefined, "an unchanged problem is not repeated")

  state.opencodeUp = true
  assert.match((await monitor.check()) ?? "", /已恢复：OpenCode/)
  assert.equal(state.sent.length, 2)
})

test("a missing CLI binary and a streak of the same failure are both caught", async () => {
  const { monitor, state } = harness()
  state.installed.set("codex", false)
  assert.match((await monitor.check()) ?? "", /Codex CLI：找不到 CLI 可执行文件/)

  state.installed.set("codex", true)
  state.outcomes.set("codex", [failed(3, "AUTH_FAILED"), failed(2, "AUTH_FAILED"), failed(1, "AUTH_FAILED")])
  const text = (await monitor.check()) ?? ""
  assert.match(text, /最近 3 次任务都认证失败/, "the problem changed, so it is reported again")

  // One success among the recent runs clears the streak
  state.outcomes.set("codex", [{ at: 4, outcome: "ok" }, failed(3, "AUTH_FAILED"), failed(2, "AUTH_FAILED")])
  assert.match((await monitor.check()) ?? "", /已恢复：Codex CLI/)
})

test("mixed or too few failures, an on-demand OpenCode and timeouts raise nothing", async () => {
  const { monitor, state } = harness({ opencodeOnDemand: true })
  state.opencodeUp = false
  state.outcomes.set("codex", [failed(3, "AUTH_FAILED"), failed(2, "MODEL_UNAVAILABLE"), failed(1, "AUTH_FAILED")])
  assert.equal(await monitor.check(), undefined)
  state.outcomes.set("codex", [failed(2, "AUTH_FAILED"), failed(1, "AUTH_FAILED")])
  assert.equal(await monitor.check(), undefined, "two failures are not a streak yet")
  state.outcomes.set("codex", [failed(3, "TASK_TIMEOUT"), failed(2, "TASK_TIMEOUT"), failed(1, "TASK_TIMEOUT")])
  assert.equal(await monitor.check(), undefined, "a slow task says nothing about the engine itself")
})

test("an undelivered alert is retried next round", async () => {
  const { monitor, state } = harness()
  state.opencodeUp = false
  state.failSend = true
  assert.equal(await monitor.check(), undefined)
  state.failSend = false
  assert.match((await monitor.check()) ?? "", /OpenCode 服务无法连接/)
})

test("an engine nobody uses any more is dropped without a recovery notice", async () => {
  const { monitor, state } = harness()
  state.installed.set("codex", false)
  await monitor.check()
  state.engines = ["opencode"]
  assert.equal(await monitor.check(), undefined)
})
