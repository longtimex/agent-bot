import assert from "node:assert/strict"
import { linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AccountStore } from "../src/accounts.js"
import { AgentProviderStore } from "../src/agentProviders.js"
import type { Logger } from "../src/logger.js"
import { loadOrCreateSecretKey } from "../src/secretKey.js"
import { assertFileMode } from "./support/platform.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-secret-key-"))
}

test("a new key is 32 bytes, private, and reported once", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "accounts.key")
    const created: string[] = []
    const key = loadOrCreateSecretKey(path, { onCreate: (p) => created.push(p) })
    assert.equal(key.length, 32)
    assert.equal(readFileSync(path, "utf8").trim(), key.toString("hex"))
    assertFileMode(path, 0o600)
    assert.deepEqual(created, [path])
    assert.deepEqual(loadOrCreateSecretKey(path, { onCreate: (p) => created.push(p) }), key)
    assert.equal(created.length, 1, "reading an existing key is not a creation")
    assert.deepEqual(readdirSync(dir), ["accounts.key"], "no staging file is left behind")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an existing key is never replaced, even when malformed", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "accounts.key")
    writeFileSync(path, "not-a-key\n")
    assert.throws(() => loadOrCreateSecretKey(path), /格式无效/)
    assert.equal(readFileSync(path, "utf8"), "not-a-key\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a key another process linked first is adopted", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "accounts.key")
    // Stand in for the winner: its key appears just as we try to link ours
    const winner = "ab".repeat(32)
    const staged = join(dir, "winner.tmp")
    writeFileSync(staged, `${winner}\n`)
    linkSync(staged, path)
    rmSync(staged)
    assert.equal(loadOrCreateSecretKey(path).toString("hex"), winner)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the vault and the relay store share one key and read each other's secrets", () => {
  const dir = tempDir()
  try {
    const keyPath = join(dir, "accounts.key")
    // The relay store creates the key first, the vault must adopt it rather than make its own
    const relays = new AgentProviderStore(join(dir, "agent-providers.json"), keyPath, log)
    relays.set("claude", { baseURL: "https://relay.example", apiKey: "sk-relay" })
    const before = readFileSync(keyPath, "utf8")

    const vault = new AccountStore(join(dir, "accounts.json"), keyPath, log)
    vault.add({ name: "GitHub", username: "me", password: "s3cret" })
    assert.equal(readFileSync(keyPath, "utf8"), before, "the second store must not rewrite the key")
    assert.equal(relays.get("claude")?.apiKey, "sk-relay")
    assert.equal(new AccountStore(join(dir, "accounts.json"), keyPath, log).reveal("GitHub")?.password, "s3cret")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
