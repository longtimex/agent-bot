import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentCustomModelStore } from "../src/agentCustomModels.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-models-"))
  const path = join(dir, "agent-custom-models.json")
  return {
    path,
    store: () => new AgentCustomModelStore(path, join(dir, "accounts.key"), log),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("a model can carry its own endpoint, with the key encrypted", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add("codex", {
      value: "gpt-4o",
      label: "GPT-4o",
      baseURL: "https://relay.example.com/v1",
      apiKey: "sk-model-secret",
    })
    const endpoint = store.endpointFor("codex", "gpt-4o")
    assert.equal(endpoint?.baseURL, "https://relay.example.com/v1")
    assert.equal(endpoint?.apiKey, "sk-model-secret")
    // The file must not carry the key in clear text
    const raw = readFileSync(f.path, "utf8")
    assert.ok(!raw.includes("sk-model-secret"), "a backup of data/ must not leak the model key")
    // A model without an endpoint falls back to the engine relay (undefined here)
    store.add("codex", { value: "plain", label: "Plain" })
    assert.equal(store.endpointFor("codex", "plain"), undefined)
  } finally {
    f.close()
  }
})

test("a model id without an endpoint keeps the entry minimal", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add("claude", { value: "claude-opus-4-6", label: "Opus 4.6" })
    const listed = store.list("claude")
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.value, "claude-opus-4-6")
    assert.equal(listed[0]?.baseURL, undefined)
  } finally {
    f.close()
  }
})

test("re-adding the same id replaces its endpoint instead of duplicating", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add("codex", { value: "gpt-4o", label: "A", baseURL: "https://one/v1", apiKey: "k1" })
    store.add("codex", { value: "gpt-4o", label: "B", baseURL: "https://two/v1", apiKey: "k2" })
    const listed = store.list("codex")
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.label, "B")
    assert.equal(store.endpointFor("codex", "gpt-4o")?.baseURL, "https://two/v1")
  } finally {
    f.close()
  }
})
