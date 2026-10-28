import assert from "node:assert/strict"
import test from "node:test"
import { resolveModelKey } from "../src/models.js"

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
