import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentCliRegistry, type AgentCliProfile } from "../src/agentCli.js"
import {
  AgentModelCatalog,
  isSafeModelId,
  parseAgentModelJson,
  parseAgentModelLines,
  parseAgentModelOutput,
  type AgentModelProbeResult,
} from "../src/agentModelCatalog.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function catalogFor(
  registry: AgentCliRegistry,
  run: (profile: AgentCliProfile, args: string[]) => Promise<AgentModelProbeResult> = async () => ({
    code: 0,
    stdout: "",
    stderr: "",
  }),
  options: { cacheTtlMs?: number; now?: () => number } = {},
): AgentModelCatalog {
  return new AgentModelCatalog(registry, {
    log,
    // Only the profiles this suite intends to probe are pretended to be installed.
    which: (profile) => ["qoder", "codex", "gemini", "opencode-cli", "failing"].includes(profile.id)
      ? "/fake/agent"
      : undefined,
    run: (profile, _binPath, args) => run(profile, args),
    env: () => ({}),
    ...options,
  })
}

test("the model parsers understand Codex JSON and hide internal models", () => {
  const parsed = parseAgentModelJson(
    JSON.stringify({
      data: [
        { slug: "gpt-visible", display_name: "GPT Visible", visibility: "list", description: "chat" },
        { slug: "codex-hidden", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-other", display_name: "GPT Other", visibility: "visible" },
      ],
    }),
  )
  assert.deepEqual(parsed, [
    { id: "gpt-visible", label: "GPT Visible", desc: "chat", aliases: undefined },
    { id: "gpt-other", label: "GPT Other", desc: undefined, aliases: undefined },
  ])
})

test("JSON that merely contains a key or value string is not mistaken for a model", () => {
  assert.equal(parseAgentModelJson('{"error":"unauthorized","message":"login required"}'), undefined)
  assert.equal(
    parseAgentModelJson(JSON.stringify({ data: { instruction: "call the skill with model tools" } })),
    undefined,
  )
})

test("Gemini JSON metadata and OpenCode line output are parsed without guessing", () => {
  assert.deepEqual(
    parseAgentModelOutput(
      JSON.stringify({
        models: [
          { model: "gemini-3-pro", name: "Gemini 3 Pro", description: "reasoning" },
          { modelId: "gemini-3-flash", displayName: "Gemini 3 Flash" },
        ],
      }),
      "json",
    ),
    [
      { id: "gemini-3-pro", label: "Gemini 3 Pro", desc: "reasoning", aliases: undefined },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", desc: undefined, aliases: undefined },
    ],
  )
  assert.deepEqual(parseAgentModelLines("openai/gpt-5\nanthropic/claude-sonnet-4\n"), [
    { id: "openai/gpt-5", label: "openai/gpt-5" },
    { id: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4" },
  ])
})

test("model ids reject flags and control characters", () => {
  for (const value of ["-p", "--model", "a\tb", "a\nb", ""]) assert.equal(isSafeModelId(value), false, value)
  assert.equal(isSafeModelId("provider/model"), true)
  assert.equal(isSafeModelId("claude-sonnet-4"), true)
})

test("catalog probes each built-in shape and never falls back to a static list", async () => {
  const registry = new AgentCliRegistry({ log })
  const calls: string[][] = []
  const catalog = catalogFor(registry, async (profile, args) => {
    calls.push([profile.id, ...args])
    if (profile.id === "qoder") {
      return { code: 0, stdout: "", stderr: "Warning: no models available for your account." }
    }
    if (profile.id === "codex") {
      return {
        code: 0,
        stdout: JSON.stringify({
          models: [
            { slug: "gpt-5-codex", display_name: "GPT-5 Codex", visibility: "list" },
            { slug: "internal", display_name: "Internal", visibility: "hide" },
          ],
        }),
        stderr: "",
      }
    }
    if (profile.id === "gemini") {
      return {
        code: 0,
        stdout: JSON.stringify({ models: [{ model: "gemini-3-pro", name: "Gemini 3 Pro" }] }),
        stderr: "",
      }
    }
    return { code: 0, stdout: "provider/model-a\nprovider/model-b\n", stderr: "" }
  })

  const qoder = await catalog.list("qoder")
  assert.deepEqual(qoder.models, [])
  assert.equal(qoder.source, "probe")
  assert.match(qoder.hint ?? "", /没有可用模型/)

  const codex = await catalog.list("codex")
  assert.deepEqual(codex.models.map((model) => model.id), ["gpt-5-codex"])

  const gemini = await catalog.list("gemini")
  assert.deepEqual(gemini.models.map((model) => model.id), ["gemini-3-pro"])

  const opencodeCli = await catalog.list("opencode-cli")
  assert.deepEqual(opencodeCli.models.map((model) => model.id), ["provider/model-a", "provider/model-b"])

  assert.deepEqual(calls, [
    ["qoder", "--list-models"],
    ["codex", "debug", "models"],
    ["gemini", "--list-models", "--output-format", "json"],
    ["opencode-cli", "models"],
  ])
})

test("catalog caches a probe, deduplicates concurrent calls and refreshes on demand", async () => {
  const dir = tempDir("agent-model-catalog-")
  try {
    const registry = new AgentCliRegistry({ path: join(dir, "agents.json"), log })
    let calls = 0
    let now = 1_000
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const catalog = catalogFor(
      registry,
      async () => {
        calls += 1
        if (calls === 1) await gate
        return { code: 0, stdout: `model-${calls}\n`, stderr: "" }
      },
      { cacheTtlMs: 60_000, now: () => now },
    )

    const first = catalog.list("opencode-cli")
    const second = catalog.list("opencode-cli")
    await Promise.resolve()
    assert.equal(calls, 1, "two simultaneous panel opens must share one probe")
    release?.()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.models[0]?.id, "model-1")
    assert.equal(b.models[0]?.id, "model-1")

    assert.equal((await catalog.list("opencode-cli")).models[0]?.id, "model-1")
    assert.equal(calls, 1, "a cache hit must not spawn another probe")

    now += 61_000
    assert.equal((await catalog.list("opencode-cli")).models[0]?.id, "model-2")
    assert.equal(calls, 2)
    assert.equal((await catalog.list("opencode-cli", true)).models[0]?.id, "model-3")
    assert.equal(calls, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("probe failures stay empty with a useful reason, while custom static lists still work", async () => {
  const dir = tempDir("agent-model-catalog-")
  try {
    const path = join(dir, "agents.json")
    const largeOutput = Array.from({ length: 20 }, (_, index) => ({
      slug: `gpt-${index}`,
      display_name: `GPT ${index}`,
      visibility: "list",
      model_messages: "x".repeat(60_000),
    }))
    const producer = join(dir, "large-models.mjs")
    writeFileSync(producer, `process.stdout.write(${JSON.stringify(JSON.stringify({ models: largeOutput }))})\n`)
    writeFileSync(
      path,
      JSON.stringify({
        agents: {
          custom: {
            label: "Custom CLI",
            bin: "custom-not-on-path",
            supportsModel: true,
            models: [{ id: "fast", label: "Fast", aliases: ["f"] }],
            args: {},
          },
          failing: {
            label: "Failing CLI",
            bin: "failing-not-on-path",
            supportsModel: true,
            modelProbe: { args: ["models"], format: "json" },
            args: {},
          },
          wide: {
            label: "Wide CLI",
            bin: process.execPath,
            supportsModel: true,
            modelProbe: { args: [producer], format: "json" },
            args: {},
          },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path, log })

    const missing = await catalogFor(registry, async () => ({ code: 2, stdout: "", stderr: "auth expired" })).list(
      "failing",
    )
    assert.deepEqual(missing.models, [])
    assert.equal(missing.source, "probe")
    assert.match(missing.hint ?? "", /auth expired/)

    const configured = await catalogFor(registry).list("custom")
    assert.deepEqual(configured.models.map((model) => model.id), ["fast"])
    assert.equal(configured.source, "configured")
    assert.equal(configured.hint, undefined)
    assert.equal(registry.declaresModel("custom", "f"), true)

    const installed = new AgentModelCatalog(registry, {
      log,
      which: (profile) => profile.id === "custom" ? "/fake/custom" : undefined,
      env: () => ({}),
    })
    const installedConfigured = await installed.list("custom")
    assert.deepEqual(installedConfigured.models.map((model) => model.id), ["fast"])
    assert.equal(installedConfigured.source, "configured")
    assert.equal(installedConfigured.hint, undefined)

    const largeProbe = new AgentModelCatalog(registry, {
      log,
      which: () => process.execPath,
      env: () => ({}),
    })
    assert.equal((await largeProbe.list("wide")).models.length, 20)

    const noModels = await catalogFor(registry).list("qoder")
    assert.deepEqual(noModels.models, [], "a Qoder account without models must not resurrect stale variants")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

