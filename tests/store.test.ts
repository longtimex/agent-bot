import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import { SessionStore } from "../src/store.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("SessionStore persists state with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-store-"))
  try {
    const path = join(dir, "sessions.json")
    const store = new SessionStore(path, log)
    store.set("tg:1", "ses_1")
    store.setCliSession("tg:1", "claude", "cli_1")
    store.setCliModel("tg:1", "claude", "sonnet")
    assert.equal(statSync(path).mode & 0o777, 0o600)

    const reloaded = new SessionStore(path, log)
    assert.equal(reloaded.get("tg:1"), "ses_1")
    assert.equal(reloaded.getCliSession("tg:1", "claude"), "cli_1")
    assert.equal(reloaded.getCliModel("tg:1", "claude"), "sonnet")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SessionStore migrates legacy qoder fields and ignores corrupt entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-store-"))
  try {
    const path = join(dir, "sessions.json")
    writeFileSync(
      path,
      JSON.stringify({
        "tg:1": { sessionID: "ses_1", qoderSessionID: "q_1", qoderModel: "DeepSeek-Flash" },
        "tg:2": { sessionID: 42 },
        "tg:3": "garbage",
        "tg:4": { sessionID: "", model: "not-an-object" },
        "tg:5": { sessionID: "", model: { providerID: "p", modelID: "m" } },
      }),
    )
    const store = new SessionStore(path, log)
    assert.equal(store.getCliSession("tg:1", "qoder"), "q_1")
    assert.equal(store.getCliModel("tg:1", "qoder"), "DeepSeek-Flash")
    assert.equal(store.getEngine("tg:1"), "opencode")
    assert.equal(store.get("tg:2"), undefined)
    assert.equal(store.get("tg:3"), undefined)
    assert.equal(store.getModel("tg:4"), undefined)
    assert.deepEqual(store.getModel("tg:5"), { providerID: "p", modelID: "m", label: "m" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SessionStore lists chat model refs and drops a cleared selection on reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-store-refs-"))
  try {
    const path = join(dir, "sessions.json")
    const store = new SessionStore(path, log)
    store.setModel("tg:1", { providerID: "custom", modelID: "zeta-1", label: "Zeta" })
    store.setModel("tg:2", { providerID: "custom", modelID: "other", label: "Other" })

    assert.deepEqual(store.listModelRefs(), [
      { key: "tg:1", providerID: "custom", modelID: "zeta-1" },
      { key: "tg:2", providerID: "custom", modelID: "other" },
    ])

    assert.equal(store.clearModel("tg:1"), true)
    assert.equal(store.clearModel("tg:1"), false)
    assert.equal(store.clearModel("tg:missing"), false)
    assert.deepEqual(new SessionStore(path, log).listModelRefs(), [
      { key: "tg:2", providerID: "custom", modelID: "other" },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SessionStore persists a per-chat working directory and drops invalid ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-dir-"))
  try {
    const path = join(dir, "sessions.json")
    const store = new SessionStore(path, log)
    assert.equal(store.getDir("tg:1"), undefined)
    assert.equal(store.clearDir("tg:1"), false)

    store.setDir("tg:1", "/srv/projects/app")
    store.setEngine("tg:1", "claude")
    assert.equal(store.clearDir("tg:1"), true)
    assert.equal(store.getDir("tg:1"), undefined)
    // clearing the directory must not drop the rest of the chat record
    assert.equal(store.getEngine("tg:1"), "claude")

    store.setDir("tg:1", "/srv/projects/app")
    writeFileSync(
      path,
      JSON.stringify({
        "tg:1": { sessionID: "", updatedAt: "", dir: "relative/path" },
        "tg:2": { sessionID: "", updatedAt: "", dir: "/ok/path\u0000" },
        "tg:3": { sessionID: "", updatedAt: "", dir: "/kept/path" },
      }),
    )
    const reloaded = new SessionStore(path, log)
    assert.equal(reloaded.getDir("tg:1"), undefined, "a relative path is not a stored directory")
    assert.equal(reloaded.getDir("tg:2"), undefined, "control characters are not a stored directory")
    assert.equal(reloaded.getDir("tg:3"), "/kept/path")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SessionStore keeps prototype-shaped keys as records instead of a prototype", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-proto-"))
  try {
    const path = join(dir, "sessions.json")
    // Raw JSON text: an object literal could not express these keys, and a nested
    // engine key of "__proto__" is reachable through user-managed agent profiles
    writeFileSync(
      path,
      '{"__proto__":{"sessionID":"ses_proto","engine":"qoder","updatedAt":"2026-01-01T00:00:00.000Z",' +
        '"cliSessions":{"__proto__":"cli_proto"}},"tg:1":{"sessionID":"ses_1","updatedAt":"2026-01-01T00:00:00.000Z"}}',
    )
    const store = new SessionStore(path, log)
    assert.equal(store.get("__proto__"), "ses_proto", "the tampered key must load as its own record")
    assert.equal(store.getCliSession("__proto__", "__proto__"), "cli_proto")
    assert.equal(store.getEngine("constructor"), "opencode")
    assert.equal(store.get("toString"), undefined)

    store.clearSession("constructor")
    store.clearSession("toString")
    assert.equal((Object as unknown as { sessionID?: unknown }).sessionID, undefined, "builtins must stay untouched")
    assert.equal((Object.prototype as unknown as { sessionID?: unknown }).sessionID, undefined)

    store.set("tg:2", "ses_2")
    const reloaded = new SessionStore(path, log)
    assert.equal(reloaded.get("__proto__"), "ses_proto", "record must survive the next save")
    assert.equal(reloaded.getCliSession("__proto__", "__proto__"), "cli_proto")
    assert.equal(reloaded.get("tg:2"), "ses_2")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupt session store is quarantined instead of overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-store-corrupt-"))
  try {
    const path = join(dir, "sessions.json")
    writeFileSync(path, '{"tg:1": {"sessionID": "ses_1"')
    const store = new SessionStore(path, log)
    assert.equal(store.get("tg:1"), undefined)
    const aside = readdirSync(dir).filter((name) => name.startsWith("sessions.json.corrupt-"))
    assert.equal(aside.length, 1, "the damaged file must be kept for repair")
    assert.match(readFileSync(join(dir, aside[0]!), "utf8"), /ses_1/)

    store.set("tg:9", "ses_9")
    assert.equal(new SessionStore(path, log).get("tg:9"), "ses_9")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
