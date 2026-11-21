import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentModelCatalog } from "../src/agentModelCatalog.js"

const codexRegistry = {
  get: (id: string) =>
    id === "codex"
      ? {
          id: "codex",
          label: "Codex CLI",
          bin: "codex",
          supportsModel: true,
          modelProbe: { args: ["debug", "models"], format: "json" as const },
        }
      : undefined,
  binPath: () => "/usr/bin/codex",
} as never

test("a model named in codex config.toml is offered beside the vendor list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-codex-home-"))
  writeFileSync(
    join(dir, "config.toml"),
    ['model = "deepseek-v4.1-flash"', "", "[profiles.fast]", 'model = "gpt-6-mini"', ""].join("\n"),
  )
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    const catalog = new AgentModelCatalog(codexRegistry, {
      // The probe only knows the vendor catalogue
      run: async () => ({
        stdout: JSON.stringify([{ id: "gpt-6.2-sol", name: "GPT-6.2-Sol" }]),
        stderr: "",
        code: 0,
      }),
    })
    const result = await catalog.list("codex")
    const ids = result.models.map((model) => model.id)
    assert.ok(ids.includes("deepseek-v4.1-flash"), "the model in use must be selectable")
    assert.ok(ids.includes("gpt-6-mini"), "a named profile's model is selectable too")
    assert.ok(ids.includes("gpt-6.2-sol"), "the vendor list still appears")
    // The config one comes first: it is what the operator actually pointed at a relay
    assert.equal(ids[0], "deepseek-v4.1-flash")
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a config model survives a failing probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-codex-home-"))
  writeFileSync(join(dir, "config.toml"), 'model = "deepseek-v4.1-flash"\n')
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    const catalog = new AgentModelCatalog(codexRegistry, {
      run: async () => ({ stdout: "", stderr: "boom", code: 1 }),
    })
    const result = await catalog.list("codex")
    assert.deepEqual(result.models.map((model) => model.id), ["deepseek-v4.1-flash"])
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
