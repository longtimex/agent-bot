import assert from "node:assert/strict"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  findModel,
  getCustomModelsPath,
  listModels,
  reloadCustomModels,
  resolveModelKey,
  setCustomModelsPath,
} from "../src/models.js"

interface SeedEntry {
  providerID: string
  modelID: string
  label: string
  desc?: string
}

/** Points the module at a throwaway data/models.json and restores the previous registry. */
function useRegistry(run: (ctx: { path: string; write: (models: Record<string, SeedEntry>) => void }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bot-models-"))
  const previous = getCustomModelsPath()
  const path = join(dir, "models.json")
  const write = (models: Record<string, SeedEntry>): void => {
    writeFileSync(path, JSON.stringify({ version: 1, models }))
  }
  write({})
  setCustomModelsPath(path)
  try {
    run({ path, write })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (previous) setCustomModelsPath(previous)
    else reloadCustomModels(true)
  }
}

const entry = (modelID: string, label: string): SeedEntry => ({
  providerID: "custom",
  modelID,
  label,
  desc: "自定义",
})

test("the built-in catalogue is gone: nothing resolves until a model is registered", () => {
  useRegistry(() => {
    // These names were hard-coded before; an empty registry must not resurrect them.
    assert.equal(resolveModelKey("sonnet"), undefined)
    assert.equal(resolveModelKey("gemini 3.8 flash"), undefined)
    assert.equal(resolveModelKey("deepseek v4.1"), undefined)
    assert.equal(resolveModelKey("gpt-oss"), undefined)
    assert.equal(findModel("sonnet"), undefined)
    assert.equal(Object.keys(listModels()).length, 0)
  })
})

test("resolveModelKey matches a registered model by key, model ID and label", () => {
  useRegistry(({ write }) => {
    write({
      sonnet: entry("claude-sonnet-5-5-high", "Claude Sonnet 5.5"),
      "gemini-flash": entry("gemini-3.8-flash-high", "Gemini 3.8 Flash"),
    })
    reloadCustomModels(true)

    assert.equal(resolveModelKey("Sonnet"), "sonnet")
    assert.equal(resolveModelKey("claude-sonnet-5-5-high"), "sonnet")
    assert.equal(resolveModelKey("claude sonnet 5.5"), "sonnet")
    assert.equal(resolveModelKey("gemini 3.8 flash"), "gemini-flash")
    assert.equal(resolveModelKey("gemini-3.8-flash-high"), "gemini-flash")
    // A different key targeting the same provider/model is still a separate entry.
    assert.equal(findModel("sonnet")?.modelID, "claude-sonnet-5-5-high")
  })
})

test("resolveModelKey rejects unknown or empty input", () => {
  useRegistry(({ write }) => {
    write({ zephyr: entry("z-1", "Zephyr One") })
    reloadCustomModels(true)

    assert.equal(resolveModelKey("not-a-model"), undefined)
    assert.equal(resolveModelKey(""), undefined)
    assert.equal(resolveModelKey("   "), undefined)
  })
})

test("resolveModelKey ignores inherited object properties", () => {
  useRegistry(({ write }) => {
    write({ zephyr: entry("z-1", "Zephyr One") })
    reloadCustomModels(true)

    assert.equal(resolveModelKey("constructor"), undefined)
    assert.equal(resolveModelKey("toString"), undefined)
    assert.equal(resolveModelKey("__proto__"), undefined)
  })
})

test("a corrupt models.json keeps the models that were already loaded", () => {
  useRegistry(({ path, write }) => {
    write({ zephyr: entry("z-1", "Zephyr One") })
    reloadCustomModels(true)
    assert.equal(resolveModelKey("zephyr"), "zephyr")
    assert.equal(resolveModelKey("zephyr one"), "zephyr")

    writeFileSync(path, "{ zephyr: oops ")
    reloadCustomModels(true)
    assert.equal(findModel("zephyr")?.modelID, "z-1")
    assert.equal(resolveModelKey("zephyr"), "zephyr")

    write({ ember: entry("e-1", "Ember") })
    reloadCustomModels(true)
    assert.equal(resolveModelKey("ember"), "ember")
    assert.equal(findModel("zephyr"), undefined)
    assert.equal(resolveModelKey("zephyr"), undefined)
  })
})

test("custom model aliases follow the registry across key renames and removal", () => {
  useRegistry(({ path, write }) => {
    write({ foo: entry("f-1", "Shared Name") })
    reloadCustomModels(true)
    assert.equal(resolveModelKey("shared name"), "foo")

    // the same label with a new key must not leave the alias dangling
    write({ bar: entry("b-1", "Shared Name") })
    reloadCustomModels(true)
    assert.equal(resolveModelKey("shared name"), "bar")
    assert.equal(resolveModelKey("foo"), undefined)

    unlinkSync(path)
    reloadCustomModels(true)
    assert.equal(resolveModelKey("bar"), undefined)
    assert.equal(resolveModelKey("shared name"), undefined)
    assert.equal(Object.keys(listModels()).length, 0)

    write({ bar: entry("b-1", "Shared Name") })
    reloadCustomModels(true)
    assert.equal(resolveModelKey("bar"), "bar")
  })
})

test("a custom model key wins over another model's modelID alias", () => {
  useRegistry(({ write }) => {
    // alpha is declared first, and its modelID spells beta's key
    write({
      alpha: entry("beta", "Alpha"),
      beta: entry("b-2", "Beta"),
    })
    reloadCustomModels(true)

    assert.equal(resolveModelKey("beta"), "beta")
    assert.equal(resolveModelKey("alpha"), "alpha")
  })
})
