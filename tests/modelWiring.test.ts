import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentCliRegistry, AgentCliService } from "../src/agentCli.js"
import { AgentCustomModelStore } from "../src/agentCustomModels.js"
import { AgentProviderStore } from "../src/agentProviders.js"
import { SessionStore } from "../src/store.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`)
  chmodSync(path, 0o755)
}

/**
 * The whole point of a hand-added model is that a task actually runs against it. Every other
 * test stops at "the list shows it" or "the API accepts it"; this one checks the process that
 * is spawned.
 */
const posixOnly = { skip: process.platform === "win32" ? "needs a POSIX exec bit" : false }

test("a hand-added model's endpoint reaches the spawned CLI", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-wiring-"))
  try {
    const bin = join(dir, "codex")
    writeExecutable(
      bin,
      'process.stdout.write("BASE=" + (process.env.OPENAI_BASE_URL ?? "") + " KEY=" + (process.env.OPENAI_API_KEY ?? ""))',
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "codex",
            label: "Codex CLI",
            bin,
            parse: "text",
            supportsModel: true,
            args: { base: ["exec", "{prompt}"] },
          },
        ],
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const customModels = new AgentCustomModelStore(join(dir, "models.json"), join(dir, "accounts.key"), log)
    const providers = new AgentProviderStore(join(dir, "providers.json"), join(dir, "accounts.key"), log)

    // The operator adds a model pointed at a relay, then selects it
    customModels.add("codex", {
      value: "relay-model",
      label: "Relay Model",
      baseURL: "https://model-relay.example.com/v1",
      apiKey: "sk-model-key",
    })
    store.setCliModel("chat", "codex", "relay-model")

    const service = new AgentCliService(dir, store, log, 15_000, 15_000, undefined, registry, (engine, model) =>
      providers.envFor(engine, model ? customModels.endpointFor(engine, model) : undefined),
    )
    const output = await service.prompt("chat", "codex", "hi")

    assert.ok(output.includes("BASE=https://model-relay.example.com/v1"), "the model's relay must win")
    assert.ok(output.includes("KEY=sk-model-key"), "the model's key must be exported")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("without a model endpoint the engine-level relay is what the CLI sees", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-wiring-"))
  try {
    const bin = join(dir, "codex")
    writeExecutable(
      bin,
      'process.stdout.write("BASE=" + (process.env.OPENAI_BASE_URL ?? ""))',
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "codex",
            label: "Codex CLI",
            bin,
            parse: "text",
            supportsModel: true,
            args: { base: ["exec", "{prompt}"] },
          },
        ],
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const customModels = new AgentCustomModelStore(join(dir, "models.json"), join(dir, "accounts.key"), log)
    const providers = new AgentProviderStore(join(dir, "providers.json"), join(dir, "accounts.key"), log)
    providers.set("codex", { baseURL: "https://engine-default.example.com/v1", apiKey: "sk-engine" })

    // A plain model id with no endpoint of its own
    customModels.add("codex", { value: "plain-model", label: "Plain" })
    store.setCliModel("chat", "codex", "plain-model")

    const service = new AgentCliService(dir, store, log, 15_000, 15_000, undefined, registry, (engine, model) =>
      providers.envFor(engine, model ? customModels.endpointFor(engine, model) : undefined),
    )
    const output = await service.prompt("chat", "codex", "hi")
    assert.ok(output.includes("BASE=https://engine-default.example.com/v1"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
