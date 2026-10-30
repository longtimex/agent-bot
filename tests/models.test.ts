import assert from "node:assert/strict"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AVAILABLE_MODELS, getCustomModelsPath, reloadCustomModels, resolveModelKey, setCustomModelsPath } from "../src/models.js"

test("resolveModelKey resolves aliases case-insensitively", () => {
  assert.equal(resolveModelKey("Sonnet"), "sonnet")
  assert.equal(resolveModelKey("gemini 3.8 flash"), "gemini")
  assert.equal(resolveModelKey("grok-4.7"), "grok")
  assert.equal(resolveModelKey("deepseek v4.1"), "deepseek")
  assert.equal(resolveModelKey("gpt_oss"), "gpt")
})

test("resolveModelKey accepts full model IDs", () => {
  assert.equal(resolveModelKey("gemini-3.8-flash-high"), "gemini")
  assert.equal(resolveModelKey("claude-opus-5-5-high"), "opus")
  assert.equal(resolveModelKey("deepseek-v4.1-flash-free"), "deepseek")
})

test("resolveModelKey rejects unknown or empty input", () => {
  assert.equal(resolveModelKey("not-a-model"), undefined)
  assert.equal(resolveModelKey("   "), undefined)
})

test("resolveModelKey ignores inherited object properties", () => {
  assert.equal(resolveModelKey("constructor"), undefined)
  assert.equal(resolveModelKey("toString"), undefined)
  assert.equal(resolveModelKey("__proto__"), undefined)
})

test("a corrupt models.json keeps the custom models that were already loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-models-corrupt-"))
  const previous = getCustomModelsPath()
  const path = join(dir, "models.json")
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        models: { zephyr: { providerID: "custom", modelID: "z-1", label: "Zephyr One", desc: "自定义" } },
      }),
    )
    setCustomModelsPath(path)
    assert.equal(resolveModelKey("zephyr"), "zephyr")
    assert.equal(resolveModelKey("zephyr one"), "zephyr")

    writeFileSync(path, "{ zephyr: oops ")
    reloadCustomModels(true)
    assert.equal(AVAILABLE_MODELS.zephyr?.modelID, "z-1")
    assert.equal(resolveModelKey("zephyr"), "zephyr")
    assert.equal(resolveModelKey("gemini"), "gemini")

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        models: { ember: { providerID: "custom", modelID: "e-1", label: "Ember", desc: "自定义" } },
      }),
    )
    reloadCustomModels(true)
    assert.equal(resolveModelKey("ember"), "ember")
    assert.equal(AVAILABLE_MODELS.zephyr, undefined)
    assert.equal(resolveModelKey("zephyr"), undefined)
  } finally {
    if (previous) setCustomModelsPath(previous)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("custom model aliases follow the registry across key renames and removal", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-models-rename-"))
  const previous = getCustomModelsPath()
  const path = join(dir, "models.json")
  const registry = (entries: Record<string, { modelID: string; label: string }>): string =>
    JSON.stringify({
      version: 1,
      models: Object.fromEntries(
        Object.entries(entries).map(([key, info]) => [key, { providerID: "custom", desc: "自定义", ...info }]),
      ),
    })
  try {
    writeFileSync(path, registry({ foo: { modelID: "f-1", label: "Shared Name" } }))
    setCustomModelsPath(path)
    assert.equal(resolveModelKey("shared name"), "foo")

    // the same size and label with a new key must not leave the alias dangling
    writeFileSync(path, registry({ bar: { modelID: "b-1", label: "Shared Name" } }))
    reloadCustomModels(true)
    assert.equal(resolveModelKey("shared name"), "bar")
    assert.equal(resolveModelKey("foo"), undefined)

    unlinkSync(path)
    reloadCustomModels(true)
    assert.equal(resolveModelKey("bar"), undefined)
    assert.equal(resolveModelKey("shared name"), undefined)
    assert.equal(resolveModelKey("sonnet"), "sonnet")

    writeFileSync(path, registry({ bar: { modelID: "b-1", label: "Shared Name" } }))
    reloadCustomModels(true)
    assert.equal(resolveModelKey("bar"), "bar")
  } finally {
    if (previous) setCustomModelsPath(previous)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a custom model key wins over another model's modelID alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-models-shadow-"))
  const previous = getCustomModelsPath()
  const path = join(dir, "models.json")
  try {
    // alpha is declared first, and its modelID spells beta's key
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        models: {
          alpha: { providerID: "custom", modelID: "beta", label: "Alpha", desc: "自定义" },
          beta: { providerID: "custom", modelID: "b-2", label: "Beta", desc: "自定义" },
        },
      }),
    )
    setCustomModelsPath(path)
    assert.equal(resolveModelKey("beta"), "beta")
    assert.equal(resolveModelKey("alpha"), "alpha")
  } finally {
    if (previous) setCustomModelsPath(previous)
    rmSync(dir, { recursive: true, force: true })
  }
})
