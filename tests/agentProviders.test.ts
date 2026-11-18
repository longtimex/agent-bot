import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentProviderStore, supportsRelay } from "../src/agentProviders.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-relay-"))
  return {
    dir,
    store: () => new AgentProviderStore(join(dir, "agent-providers.json"), join(dir, "accounts.key"), log),
    file: join(dir, "agent-providers.json"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("relay keys never reach the file in clear text", () => {
  const f = fixture()
  try {
    f.store().set("codex", { baseURL: "https://relay.example.com/v1", apiKey: "sk-plain-secret" })
    const raw = readFileSync(f.file, "utf8")
    assert.ok(!raw.includes("sk-plain-secret"), "a backup of data/ must not carry the relay key")
    assert.match(raw, /"secret"/)
    // ...but the store hands it back decrypted
    assert.equal(f.store().get("codex")?.apiKey, "sk-plain-secret")
    assert.equal(f.store().get("codex")?.baseURL, "https://relay.example.com/v1")
  } finally {
    f.close()
  }
})

test("a relay written before encryption existed is still readable", () => {
  const f = fixture()
  try {
    writeFileSync(
      f.file,
      JSON.stringify({ version: 1, engines: { claude: { baseURL: "https://old.example.com", apiKey: "sk-old" } } }),
    )
    assert.equal(f.store().get("claude")?.apiKey, "sk-old")
  } finally {
    f.close()
  }
})

test("clearing a relay removes it entirely", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.set("gemini", { baseURL: "https://relay.example.com", apiKey: "k" })
    store.set("gemini", undefined)
    assert.equal(store.get("gemini"), undefined)
    assert.deepEqual(store.envFor("gemini"), {})
  } finally {
    f.close()
  }
})

test("envFor maps each engine to the variables its CLI reads", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.set("codex", { baseURL: "https://relay.example.com/v1", apiKey: "sk-1" })
    store.set("claude", { baseURL: "https://relay.example.com", apiKey: "sk-2" })
    assert.deepEqual(store.envFor("codex"), {
      OPENAI_BASE_URL: "https://relay.example.com/v1",
      OPENAI_API_KEY: "sk-1",
    })
    assert.deepEqual(store.envFor("claude"), {
      ANTHROPIC_BASE_URL: "https://relay.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-2",
    })
    // An engine without a mapping never gets injected variables
    assert.deepEqual(store.envFor("copilot"), {})
    assert.equal(supportsRelay("copilot"), false)
  } finally {
    f.close()
  }
})

test("a model's own endpoint wins over the engine-level relay", () => {
  const f = fixture()
  try {
    const providers = f.store()
    providers.set("codex", { baseURL: "https://engine-default/v1", apiKey: "sk-engine" })
    // Engine default applies when the model has none
    assert.equal(providers.envFor("codex").OPENAI_BASE_URL, "https://engine-default/v1")
    // ...but a model that names its own relay switches the spawn to it
    const override = { baseURL: "https://model-relay/v1", apiKey: "sk-model" }
    assert.deepEqual(providers.envFor("codex", override), {
      OPENAI_BASE_URL: "https://model-relay/v1",
      OPENAI_API_KEY: "sk-model",
    })
  } finally {
    f.close()
  }
})
