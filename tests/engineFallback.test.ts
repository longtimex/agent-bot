import assert from "node:assert/strict"
import test from "node:test"
import { pickInstalledEngine, resolveUsableEngine, type EngineAvailability } from "../src/engineFallback.js"

function registry(installed: string[]): EngineAvailability {
  const profiles = ["codex", "claude", "qoder"].map((id) => ({ id, label: id, bin: id }))
  return {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id),
    binPath: (profile) => (installed.includes(profile.bin) ? `/usr/bin/${profile.bin}` : undefined),
    label: (id) => id,
  }
}

const down = (): Promise<boolean> => Promise.resolve(false)
const up = (): Promise<boolean> => Promise.resolve(true)

test("an implicit opencode session falls back to an installed CLI", async () => {
  const choice = await resolveUsableEngine({
    engine: "opencode",
    explicit: false,
    registry: registry(["codex"]),
    opencodeHealthy: down,
  })
  assert.equal(choice.engine, "codex")
  assert.match(choice.note ?? "", /OpenCode 不可用/)
  assert.match(choice.note ?? "", /codex/)
})

test("an explicit engine is never replaced, even when it cannot run", async () => {
  // The user picked it, so failing is the truthful answer; switching would be a surprise
  const choice = await resolveUsableEngine({
    engine: "opencode",
    explicit: true,
    registry: registry(["codex"]),
    opencodeHealthy: down,
  })
  assert.deepEqual(choice, { engine: "opencode" })
})

test("a healthy opencode keeps the implicit default", async () => {
  const choice = await resolveUsableEngine({
    engine: "opencode",
    explicit: false,
    registry: registry(["codex"]),
    opencodeHealthy: up,
  })
  assert.deepEqual(choice, { engine: "opencode" })
})

test("an implicit CLI engine whose binary disappeared falls back to another one", async () => {
  const choice = await resolveUsableEngine({
    engine: "qoder",
    explicit: false,
    registry: registry(["codex"]),
    opencodeHealthy: up,
  })
  assert.equal(choice.engine, "codex")
  assert.match(choice.note ?? "", /qoder/)
})

test("an installed implicit CLI engine is left alone", async () => {
  const choice = await resolveUsableEngine({
    engine: "claude",
    explicit: false,
    registry: registry(["claude"]),
    opencodeHealthy: down,
  })
  assert.deepEqual(choice, { engine: "claude" })
})

test("no installed engine means no replacement", async () => {
  const choice = await resolveUsableEngine({
    engine: "opencode",
    explicit: false,
    registry: registry([]),
    opencodeHealthy: down,
  })
  assert.deepEqual(choice, { engine: "opencode" })
})

test("codex wins over other installed engines, then declaration order", () => {
  assert.equal(pickInstalledEngine(registry(["claude", "codex"]), "opencode"), "codex")
  assert.equal(pickInstalledEngine(registry(["claude", "qoder"]), "opencode"), "claude")
  assert.equal(pickInstalledEngine(registry(["codex"]), "codex"), undefined)
})
