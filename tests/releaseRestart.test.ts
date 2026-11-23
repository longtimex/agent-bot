import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { releaseHealthTiming, restartSystemdRelease } from "../src/release-restart.js"
import { runtimePaths, type RuntimeState } from "../src/runtime.js"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-systemd-release-"))
}

function state(dir: string): RuntimeState {
  return {
    paths: runtimePaths(dir, { ...process.env, AGENT_BOT_HOME: "" }),
    supervisor: "systemd",
    releaseId: "checkout",
    entrySource: "missing",
  }
}

function writeRelease(dir: string, id: string): string {
  const release = join(dir, "data", "releases", "store", id)
  mkdirSync(join(release, "dist"), { recursive: true })
  writeFileSync(join(release, "dist", "index.js"), "// built\n")
  writeFileSync(join(release, "package.json"), JSON.stringify({ version: "0.5.0" }))
  return release
}

function writeState(dir: string, value: Record<string, unknown>): void {
  const path = join(dir, "data", "releases", "state.json")
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

const manifest = {
  version: 1 as const,
  projectDir: "",
  supervisor: "systemd" as const,
  installedAt: "2026-01-01T00:00:00.000Z",
  unitName: "agent-bot.service",
  systemdScope: "system" as const,
}

test("systemd restart activates pending and records success after a healthy probe", async () => {
  const dir = tempDir()
  try {
    const current = writeRelease(dir, "current")
    const pending = writeRelease(dir, "pending")
    writeState(dir, {
      current: { id: "current", commit: "1111111", version: "0.4.0", createdAt: "", path: current },
      pending: { id: "pending", commit: "2222222", version: "0.5.0", createdAt: "", path: pending },
    })
    const calls: string[][] = []
    const code = await restartSystemdRelease(state(dir), {
      systemctl: (args) => {
        calls.push(args)
        return { ok: true, output: "" }
      },
      unitNames: () => ({ bot: "agent-bot.service" }),
      readManifest: () => ({ ...manifest, projectDir: dir }),
      readState: () => ({ ...state(dir), bot: { pid: process.pid } }),
      probeHealth: () => true,
    })
    assert.equal(code, 0)
    assert.deepEqual(calls, [["restart", "agent-bot.service"]])
    const saved = JSON.parse(readFileSync(join(dir, "data", "releases", "state.json"), "utf8"))
    assert.equal(saved.current.id, "pending")
    assert.equal(saved.previous.id, "current")
    assert.equal(saved.pending, undefined)
    assert.equal(saved.lastUpdate.status, "ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("systemd restart rolls back when the activated release never becomes healthy", async () => {
  const dir = tempDir()
  try {
    const current = writeRelease(dir, "current")
    const pending = writeRelease(dir, "pending")
    writeState(dir, {
      current: { id: "current", commit: "1111111", version: "0.4.0", createdAt: "", path: current },
      pending: { id: "pending", commit: "2222222", version: "0.5.0", createdAt: "", path: pending },
    })
    const calls: string[][] = []
    const code = await restartSystemdRelease(state(dir), {
      systemctl: (args) => {
        calls.push(args)
        return { ok: true, output: "" }
      },
      unitNames: () => ({ bot: "agent-bot.service" }),
      readManifest: () => ({ ...manifest, projectDir: dir }),
      readState: () => ({ ...state(dir), bot: { pid: process.pid } }),
      // The pending release never becomes healthy; after rollback the restored
      // current release answers immediately.
      probeHealth: () => {
        const saved = JSON.parse(readFileSync(join(dir, "data", "releases", "state.json"), "utf8"))
        return saved.current?.id === "current"
      },
      sleep: async () => {},
      healthTimeoutMs: 50,
      healthIntervalMs: 10,
    })
    assert.equal(code, 1)
    assert.deepEqual(calls, [["restart", "agent-bot.service"], ["restart", "agent-bot.service"]])
    const saved = JSON.parse(readFileSync(join(dir, "data", "releases", "state.json"), "utf8"))
    assert.equal(saved.current.id, "current")
    assert.equal(saved.previous.id, "pending")
    assert.equal(saved.lastUpdate.status, "rolled-back")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("systemd restart refuses to touch an unowned unit without a manifest", async () => {
  const dir = tempDir()
  try {
    let called = false
    const code = await restartSystemdRelease(state(dir), {
      systemctl: () => {
        called = true
        return { ok: true, output: "" }
      },
      unitNames: () => ({ bot: "agent-bot.service" }),
      readManifest: () => undefined,
    })
    assert.equal(code, 1)
    assert.equal(called, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unusable health timing falls back to the defaults instead of rolling back at once", () => {
  assert.deepEqual(releaseHealthTiming({}), { timeoutMs: 45_000, intervalMs: 1_000 })
  // `60s`, `1m` and an empty value used to make the wait NaN or zero: every update rolled back
  for (const bad of ["60s", "1m", "", "  ", "-5", "0", "abc"]) {
    assert.equal(releaseHealthTiming({ RELEASE_HEALTH_TIMEOUT: bad }).timeoutMs, 45_000, `timeout ${JSON.stringify(bad)}`)
    assert.equal(releaseHealthTiming({ RELEASE_HEALTH_INTERVAL: bad }).intervalMs, 1_000, `interval ${JSON.stringify(bad)}`)
  }
  assert.deepEqual(releaseHealthTiming({ RELEASE_HEALTH_TIMEOUT: "120", RELEASE_HEALTH_INTERVAL: "2" }), {
    timeoutMs: 120_000,
    intervalMs: 2_000,
  })
  // Floors keep a too-small value from being a window nothing can pass
  assert.equal(releaseHealthTiming({ RELEASE_HEALTH_TIMEOUT: "1" }).timeoutMs, 5_000)
  assert.equal(releaseHealthTiming({ RELEASE_HEALTH_INTERVAL: "0.01" }).intervalMs, 100)
})
