import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { OpencodeSupervisor } from "../src/opencodeSupervisor.js"
import type { Logger } from "../src/logger.js"

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

interface Harness {
  supervisor: OpencodeSupervisor
  clock: { now: number }
  counts: { healthy: number; start: number; stop: number }
  setHealthy(value: boolean): void
  setLocal(value: boolean): void
  setUnitManaged(value: boolean): void
  cleanup(): void
}

function createHarness(options: { onDemand?: boolean; idleStopMs?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bot-opencode-supervisor-"))
  const clock = { now: 1_000 }
  const counts = { healthy: 0, start: 0, stop: 0 }
  const state = { healthy: false, local: true, unitManaged: false }
  const supervisor = new OpencodeSupervisor({
    paths: {
      projectDir: dir,
      dataDir: dir,
      envPath: join(dir, ".env"),
      logPath: join(dir, "bot.log"),
      opencodeLogPath: join(dir, "opencode.log"),
      pidPath: join(dir, "bot.pid"),
      lockPath: join(dir, "bot.lock"),
      opencodePidPath: join(dir, "opencode.pid"),
      startupPath: join(dir, "startup.json"),
    },
    env: {},
    log,
    onDemand: options.onDemand ?? true,
    idleStopMs: options.idleStopMs ?? 60_000,
    tickMs: 60 * 60_000,
    now: () => clock.now,
    healthy: async () => {
      counts.healthy += 1
      return state.healthy
    },
    start: async () => {
      counts.start += 1
      state.healthy = true
      return { ok: true, message: "started" }
    },
    stop: async () => {
      counts.stop += 1
      state.healthy = false
      return "stopped"
    },
    localTarget: () => (state.local ? { host: "127.0.0.1", port: 4096 } : undefined),
    unitManaged: () => state.unitManaged,
  })
  return {
    supervisor,
    clock,
    counts,
    setHealthy: (value) => {
      state.healthy = value
    },
    setLocal: (value) => {
      state.local = value
    },
    setUnitManaged: (value) => {
      state.unitManaged = value
    },
    cleanup: () => {
      supervisor.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("an unhealthy server is started once for concurrent tasks", async () => {
  const h = createHarness()
  try {
    const results = await Promise.all([h.supervisor.ensureRunning(), h.supervisor.ensureRunning()])
    assert.deepEqual(results, [true, true])
    assert.equal(h.counts.start, 1, "two chats must not spawn two servers")
  } finally {
    h.cleanup()
  }
})

test("a healthy server is left alone", async () => {
  const h = createHarness()
  try {
    h.setHealthy(true)
    assert.equal(await h.supervisor.ensureRunning(), true)
    assert.equal(h.counts.start, 0)
  } finally {
    h.cleanup()
  }
})

test("a remote OPENCODE_URL is never started locally", async () => {
  const h = createHarness()
  try {
    h.setLocal(false)
    assert.equal(await h.supervisor.ensureRunning(), false)
    assert.equal(h.counts.start, 0)
  } finally {
    h.cleanup()
  }
})

test("a systemd-managed server is not spawned a second time", async () => {
  const h = createHarness()
  try {
    h.setUnitManaged(true)
    assert.equal(await h.supervisor.ensureRunning(), false)
    assert.equal(h.counts.start, 0)
  } finally {
    h.cleanup()
  }
})

test("an idle server this bot started is stopped after the window", async () => {
  const h = createHarness({ idleStopMs: 60_000 })
  try {
    await h.supervisor.ensureRunning()
    assert.equal(h.counts.stop, 0, "a fresh start is not idle")

    h.clock.now += 61_000
    await h.supervisor.tick()
    assert.equal(h.counts.stop, 1)
  } finally {
    h.cleanup()
  }
})

test("a running task keeps the server alive past the idle window", async () => {
  const h = createHarness({ idleStopMs: 60_000 })
  try {
    await h.supervisor.ensureRunning()
    const release = h.supervisor.track()
    h.clock.now += 120_000
    await h.supervisor.tick()
    assert.equal(h.counts.stop, 0, "a task in flight must not be cut off")

    release()
    h.clock.now += 61_000
    await h.supervisor.tick()
    assert.equal(h.counts.stop, 1)
  } finally {
    h.cleanup()
  }
})

test("a server the bot did not start is never stopped", async () => {
  const h = createHarness({ idleStopMs: 60_000 })
  try {
    h.setHealthy(true) // e.g. started by systemd or by hand
    await h.supervisor.ensureRunning()
    h.clock.now += 600_000
    await h.supervisor.tick()
    assert.equal(h.counts.stop, 0)
  } finally {
    h.cleanup()
  }
})

test("idleStopMs=0 keeps the server up, and onDemand=false disables the feature", async () => {
  const never = createHarness({ idleStopMs: 0 })
  try {
    await never.supervisor.ensureRunning()
    never.clock.now += 600_000
    await never.supervisor.tick()
    assert.equal(never.counts.stop, 0)
  } finally {
    never.cleanup()
  }

  const off = createHarness({ onDemand: false })
  try {
    off.setHealthy(false)
    assert.equal(await off.supervisor.ensureRunning(), true, "always-on mode never blocks a task")
    assert.equal(off.counts.start, 0)
    await off.supervisor.tick()
    assert.equal(off.counts.stop, 0)
  } finally {
    off.cleanup()
  }
})

test("a broken opencode binary is reported instead of crashing the process", async () => {
  // A failed spawn emits 'error' asynchronously; without a listener it used to take the
  // whole bot down — the one moment it must not, because the engine is already broken.
  // The failure differs by platform: Windows cannot spawn the script at all (the 'error'
  // path), while POSIX execvp falls back to /bin/sh, which exits 1 (the health path).
  const { startOpencode } = await import("../src/runtime.js")
  const dir = mkdtempSync(join(tmpdir(), "bot-opencode-start-"))
  try {
    const broken = join(dir, "broken-opencode")
    writeFileSync(broken, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const result = await startOpencode(
      {
        projectDir: dir,
        dataDir: dir,
        envPath: join(dir, ".env"),
        logPath: join(dir, "bot.log"),
        opencodeLogPath: join(dir, "opencode.log"),
        pidPath: join(dir, "bot.pid"),
        lockPath: join(dir, "bot.lock"),
        opencodePidPath: join(dir, "opencode.pid"),
        startupPath: join(dir, "startup.json"),
      },
      // Port 1 is privileged and never listened on, so the health check cannot pass by
      // accident if an earlier case left a server behind
      { ...process.env, OPENCODE_BIN: broken, OPENCODE_URL: "http://127.0.0.1:1" },
    )
    assert.equal(result.ok, false)
    assert.match(result.message, /OpenCode (启动失败|已启动)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface RaceState {
  healthy: boolean
  gateHealth: boolean
  gateStop: boolean
  holdHealth?: () => void
  holdStop?: () => void
}

function createRaceHarness() {
  const dir = mkdtempSync(join(tmpdir(), "bot-opencode-supervisor-race-"))
  writeFileSync(join(dir, "opencode.pid"), "1") // a pid file marks the server as bot-managed
  const clock = { now: 1_000 }
  const counts = { start: 0, stop: 0 }
  const state: RaceState = { healthy: true, gateHealth: false, gateStop: false }
  const supervisor = new OpencodeSupervisor({
    paths: {
      projectDir: dir,
      dataDir: dir,
      envPath: join(dir, ".env"),
      logPath: join(dir, "bot.log"),
      opencodeLogPath: join(dir, "opencode.log"),
      pidPath: join(dir, "bot.pid"),
      lockPath: join(dir, "bot.lock"),
      opencodePidPath: join(dir, "opencode.pid"),
      startupPath: join(dir, "startup.json"),
    },
    env: {},
    log,
    onDemand: true,
    idleStopMs: 60_000,
    tickMs: 60 * 60_000,
    now: () => clock.now,
    healthy: async () => {
      if (state.gateHealth) {
        state.gateHealth = false
        await new Promise<void>((resolve) => (state.holdHealth = resolve))
      }
      return state.healthy
    },
    start: async () => {
      counts.start += 1
      state.healthy = true
      return { ok: true, message: "started" }
    },
    stop: async () => {
      if (state.gateStop) {
        state.gateStop = false
        await new Promise<void>((resolve) => (state.holdStop = resolve))
      }
      counts.stop += 1
      state.healthy = false
      return "stopped"
    },
    localTarget: () => ({ host: "127.0.0.1", port: 4096 }),
    unitManaged: () => false,
  })
  const cleanup = (): void => {
    supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  return { supervisor, clock, counts, state, cleanup }
}

async function flush(until: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !until(); i++) await new Promise((resolve) => setImmediate(resolve))
}

test("a task arriving during the idle health check is not cut off", async () => {
  const h = createRaceHarness()
  try {
    h.clock.now += 61_000
    h.state.gateHealth = true
    const sweep = h.supervisor.tick()
    await flush(() => h.state.holdHealth !== undefined)
    assert.ok(h.state.holdHealth, "the sweep should be waiting on its health check")

    const release = h.supervisor.track()
    h.state.holdHealth!()
    await sweep
    assert.equal(h.counts.stop, 0, "a task that started mid-check must keep its server")
    assert.equal(await h.supervisor.ensureRunning(), true)
    assert.equal(h.counts.start, 0)
    release()
  } finally {
    h.cleanup()
  }
})

test("a task arriving while the server is being stopped starts it again", async () => {
  const h = createRaceHarness()
  try {
    h.clock.now += 61_000
    h.state.gateStop = true
    const sweep = h.supervisor.tick()
    await flush(() => h.state.holdStop !== undefined)
    assert.ok(h.state.holdStop, "the sweep should be inside stop")

    const release = h.supervisor.track()
    const ready = h.supervisor.ensureRunning()
    h.state.holdStop!()
    await sweep
    assert.equal(await ready, true)
    assert.equal(h.counts.stop, 1)
    assert.equal(h.counts.start, 1, "the server stopped under the task must be started again")
    release()
  } finally {
    h.cleanup()
  }
})
