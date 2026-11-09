import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  detectSupervisor,
  processStartTime,
  projectEnv,
  readInstallManifest,
  readLockIdentity,
  readRuntimeState,
  writeInstallManifest,
} from "../src/runtime.js"

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "bot-runtime-"))
}

test("projectEnv reads .env without overriding explicit values", () => {
  const dir = tempProject()
  try {
    writeFileSync(join(dir, ".env"), "DATA_DIR=from-file\nLOG_LEVEL=debug\n")
    const env = projectEnv(dir, { PATH: process.env.PATH, DATA_DIR: "" })
    assert.equal(env.DATA_DIR, "")
    assert.equal(env.LOG_LEVEL, "debug")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("lock identity rejects a recycled PID and accepts the live owner", () => {
  const dir = tempProject()
  try {
    const path = join(dir, "bot.lock")
    const start = processStartTime(process.pid)
    assert.ok(start)
    writeFileSync(path, `${process.pid} ${start}\n`)
    assert.equal(readLockIdentity(path)?.pid, process.pid)

    writeFileSync(path, `${process.pid} 0\n`)
    assert.equal(readLockIdentity(path), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runtime state selects a managed release before the checkout build", () => {
  const dir = tempProject()
  try {
    const release = join(dir, "data", "releases", "store", "release-1")
    mkdirSync(join(release, "dist"), { recursive: true })
    writeFileSync(join(release, "dist", "index.js"), "// index\n")
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "index.js"), "// checkout\n")
    writeFileSync(
      join(dir, "data", "releases", "state.json"),
      JSON.stringify({
        current: { id: "release-1", commit: "abcdef0123456789", version: "0.5.0", createdAt: "", path: release },
      }),
    )
    const state = readRuntimeState(dir)
    assert.equal(state.entrySource, "release")
    assert.equal(state.entry, join(release, "dist", "index.js"))
    assert.equal(state.releaseId, "release-1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("install manifest is atomic and scoped to DATA_DIR from .env", () => {
  const dir = tempProject()
  try {
    writeFileSync(join(dir, ".env"), "DATA_DIR=./custom-data\n")
    const path = writeInstallManifest(dir, {
      version: 1,
      projectDir: dir,
      supervisor: "script",
      installedAt: "2026-01-01T00:00:00.000Z",
    })
    assert.equal(path, join(dir, "custom-data", "install.json"))
    assert.equal(JSON.parse(readFileSync(path, "utf8")).supervisor, "script")
    assert.equal(readInstallManifest(dir)?.projectDir, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("supervisor detection distinguishes explicit, systemd and script modes", () => {
  assert.equal(detectSupervisor({ AGENT_BOT_SUPERVISOR: "docker" }), "docker")
  assert.equal(detectSupervisor({ INVOCATION_ID: "abc" }), "systemd")
  assert.equal(detectSupervisor({}), existsSync("/.dockerenv") ? "docker" : "script")
})

test("a stale lock and pid file are not reported as a running bot", () => {
  const dir = tempProject()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, "data", "bot.lock"), "999999 1\n")
    writeFileSync(join(dir, "data", "bot.pid"), "999999\n")
    const state = readRuntimeState(dir)
    assert.equal(state.bot, undefined)
    assert.equal(existsSync(join(dir, "data", "bot.pid")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runtime never treats an unrelated pid file as the bot", () => {
  const dir = tempProject()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, "data", "bot.pid"), `${process.pid}\n`)
    const state = readRuntimeState(dir)
    assert.equal(state.bot, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runtime does not require executable bits on a managed entry", () => {
  const dir = tempProject()
  try {
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "index.js"), "// index\n")
    chmodSync(join(dir, "dist", "index.js"), 0o600)
    assert.equal(readRuntimeState(dir).entry, join(dir, "dist", "index.js"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
