import assert from "node:assert/strict"
import test from "node:test"
import { splitMessage } from "../src/messages.js"

test("splitMessage keeps short text intact", () => {
  assert.deepEqual(splitMessage("hello", 100), ["hello"])
  assert.deepEqual(splitMessage("   ", 100), [])
})

test("splitMessage respects the limit and keeps content", () => {
  const line = "这是一段用于测试分片的中文内容。"
  const text = Array.from({ length: 20 }, () => line).join("\n")
  const chunks = splitMessage(text, 120)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`)
  }
  assert.equal(chunks.join("\n"), text)
})

test("splitMessage hard-cuts text without spaces", () => {
  const text = "a".repeat(250)
  const chunks = splitMessage(text, 100)

  assert.equal(chunks.length, 3)
  assert.ok(chunks.every((chunk) => chunk.length <= 100))
  assert.equal(chunks.join(""), text)
})
