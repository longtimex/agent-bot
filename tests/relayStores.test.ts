import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentCustomModelStore } from "../src/agentCustomModels.js"
import { AgentProviderStore } from "../src/agentProviders.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-relay-store-"))
}

test("two relay stores configuring different engines keep both", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "agent-providers.json")
    const key = join(dir, "accounts.key")
    // The bot and the App each hold their own instance over one file
    const bot = new AgentProviderStore(path, key, log)
    const app = new AgentProviderStore(path, key, log)
    bot.set("claude", { baseURL: "https://a.example", apiKey: "sk-a" })
    app.set("codex", { baseURL: "https://b.example", apiKey: "sk-b" })
    const fresh = new AgentProviderStore(path, key, log)
    assert.equal(fresh.get("claude")?.apiKey, "sk-a")
    assert.equal(fresh.get("codex")?.apiKey, "sk-b")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saving one relay never writes another engine's key in plain text", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "agent-providers.json")
    const store = new AgentProviderStore(path, join(dir, "accounts.key"), log)
    store.set("claude", { baseURL: "https://a.example", apiKey: "sk-claude-secret" })
    store.set("codex", { baseURL: "https://b.example", apiKey: "sk-codex-secret" })
    const disk = readFileSync(path, "utf8")
    assert.ok(!disk.includes("sk-claude-secret"), "an untouched engine's key leaked to disk")
    assert.ok(!disk.includes("sk-codex-secret"))
    assert.ok(!/"apiKey"/.test(disk), "no plain apiKey field may be written")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a legacy plain apiKey is encrypted by the next save", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "agent-providers.json")
    writeFileSync(
      path,
      JSON.stringify({ version: 1, engines: { gemini: { baseURL: "https://g.example", apiKey: "sk-legacy" } } }),
    )
    const store = new AgentProviderStore(path, join(dir, "accounts.key"), log)
    assert.equal(store.get("gemini")?.apiKey, "sk-legacy")
    store.set("claude", { baseURL: "https://a.example" })
    assert.ok(!readFileSync(path, "utf8").includes("sk-legacy"))
    assert.equal(store.get("gemini")?.apiKey, "sk-legacy")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an undecryptable relay keeps its ciphertext when another engine is saved", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "agent-providers.json")
    writeFileSync(
      path,
      JSON.stringify({ version: 1, engines: { gemini: { baseURL: "https://g.example", secret: "AAAA" } } }),
    )
    const store = new AgentProviderStore(path, join(dir, "accounts.key"), log)
    store.set("claude", { baseURL: "https://a.example" })
    const stored = JSON.parse(readFileSync(path, "utf8")) as { engines: Record<string, { secret?: string }> }
    assert.equal(stored.engines.gemini?.secret, "AAAA", "a key that might be recovered must not be dropped")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two custom model stores adding at once keep both models", () => {
  const dir = tempDir()
  try {
    const path = join(dir, "agent-custom-models.json")
    const key = join(dir, "accounts.key")
    const a = new AgentCustomModelStore(path, key, log)
    const b = new AgentCustomModelStore(path, key, log)
    a.add("claude", { value: "model-a", label: "A" })
    b.add("claude", { value: "model-b", label: "B" })
    const values = new AgentCustomModelStore(path, key, log).list("claude").map((m) => m.value).sort()
    assert.deepEqual(values, ["model-a", "model-b"])
    assert.equal(b.remove("claude", "missing"), false)
    assert.equal(a.remove("claude", "model-b"), true)
    assert.deepEqual(new AgentCustomModelStore(path, key, log).list("claude").map((m) => m.value), ["model-a"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
