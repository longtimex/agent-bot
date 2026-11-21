import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentModelCatalog } from "../src/agentModelCatalog.js"

/** Codex has no probe any more: its models come from the config file and the provider. */
const codexRegistry = {
  get: (id: string) =>
    id === "codex"
      ? { id: "codex", label: "Codex CLI", bin: "codex", supportsModel: true }
      : undefined,
  binPath: () => "/usr/bin/codex",
} as never

function withCodexHome(contents: string): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bot-codex-home-"))
  writeFileSync(join(dir, "config.toml"), contents)
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("the model named in config.toml is listed first, and the vendor table is not", async () => {
  const home = withCodexHome(
    ['model = "deepseek-v4.1-flash"', "", "[profiles.fast]", 'model = "gpt-6-mini"', ""].join("\n"),
  )
  try {
    const catalog = new AgentModelCatalog(codexRegistry, {
      // If this were called at all, the vendor list would leak into the result
      run: async () => {
        throw new Error("codex debug models must not be used")
      },
    })
    const result = await catalog.list("codex")
    const ids = result.models.map((model) => model.id)
    assert.deepEqual(ids, ["deepseek-v4.1-flash", "gpt-6-mini"])
    assert.equal(result.source, "configured")
  } finally {
    home.restore()
  }
})

test("models the provider itself reports are listed beside the configured one", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      // The key from env_key has to reach the provider
      if (req.headers.authorization !== "Bearer sk-relay") {
        res.writeHead(401)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash" }, { id: "deepseek-chat" }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as AddressInfo).port
  const home = withCodexHome(
    [
      'model = "deepseek-v4.1-flash"',
      'model_provider = "relay"',
      "",
      "[model_providers.relay]",
      'name = "My Relay"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'env_key = "BOT_TEST_RELAY_KEY"',
      "",
    ].join("\n"),
  )
  process.env.BOT_TEST_RELAY_KEY = "sk-relay"
  try {
    const catalog = new AgentModelCatalog(codexRegistry, { run: async () => ({ stdout: "", stderr: "", code: 1 }) })
    const result = await catalog.list("codex")
    const ids = result.models.map((model) => model.id)
    assert.ok(ids.includes("deepseek-v4.1-flash"), "the configured model stays")
    assert.ok(ids.includes("deepseek-chat"), "a model only the provider knows must appear")
    // No duplicates when the config model is also reported by the provider
    assert.equal(ids.filter((id) => id === "deepseek-v4.1-flash").length, 1)
  } finally {
    delete process.env.BOT_TEST_RELAY_KEY
    home.restore()
    server.close()
  }
})

test("an unreachable provider leaves the configured model usable and says so", async () => {
  const home = withCodexHome(
    [
      'model = "deepseek-v4.1-flash"',
      "",
      "[model_providers.relay]",
      'base_url = "http://127.0.0.1:1/v1"',
      "",
    ].join("\n"),
  )
  try {
    const catalog = new AgentModelCatalog(codexRegistry, { run: async () => ({ stdout: "", stderr: "", code: 1 }) })
    const result = await catalog.list("codex")
    assert.deepEqual(result.models.map((model) => model.id), ["deepseek-v4.1-flash"])
    assert.match(result.hint ?? "", /provider/)
  } finally {
    home.restore()
  }
})

test("without a config file the catalogue stays empty instead of inventing names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-codex-empty-"))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    const catalog = new AgentModelCatalog(codexRegistry, { run: async () => ({ stdout: "", stderr: "", code: 1 }) })
    const result = await catalog.list("codex")
    assert.deepEqual(result.models, [])
    assert.match(result.hint ?? "", /没有提供模型查询接口|config\.toml/)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two providers each contribute their own models, without duplicates", async () => {
  const makeProvider = (models: string[]) => {
    const server = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    return server
  }
  const first = makeProvider(["shared-model", "only-in-a"])
  const second = makeProvider(["shared-model", "only-in-b"])
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", () => resolve()))
  await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", () => resolve()))
  const portOf = (server: ReturnType<typeof makeProvider>) => (server.address() as AddressInfo).port

  const home = withCodexHome(
    [
      'model = "shared-model"',
      "",
      "[model_providers.a]",
      'name = "Relay A"',
      `base_url = "http://127.0.0.1:${portOf(first)}/v1"`,
      "",
      "[model_providers.b]",
      'name = "Relay B"',
      `base_url = "http://127.0.0.1:${portOf(second)}/v1"`,
      "",
    ].join("\n"),
  )
  try {
    const catalog = new AgentModelCatalog(codexRegistry, { run: async () => ({ stdout: "", stderr: "", code: 1 }) })
    const models = (await catalog.list("codex")).models
    const ids = models.map((model) => model.id)
    assert.ok(ids.includes("only-in-a"), "provider a's own model must appear")
    assert.ok(ids.includes("only-in-b"), "provider b's own model must appear")
    // `codex --model` carries only the name, so a shared name cannot mean two entries
    assert.equal(ids.filter((id) => id === "shared-model").length, 1)
    // The provider name travels as the description, so the list still says where each came from
    const shared = models.find((model) => model.id === "shared-model")
    assert.match(shared?.desc ?? "", /Relay [AB]/)
  } finally {
    home.restore()
    first.close()
    second.close()
  }
})
