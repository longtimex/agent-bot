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

test("splitMessage keeps markdown code fences balanced across chunks", () => {
  const body = Array.from({ length: 30 }, (_, index) => `print(${index})`).join("\n")
  const text = "```python\n" + body + "\n```"
  const chunks = splitMessage(text, 120)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`)
    const markers = chunk.match(/^\s*(```|~~~)/gm) ?? []
    assert.equal(markers.length % 2, 0, `unbalanced fence in chunk:\n${chunk}`)
  }
  assert.match(chunks[0] ?? "", /^```python/)
  assert.match(chunks[1] ?? "", /^```/)
  const recovered = chunks.join("\n").replace(/^\s*```[^\n]*\n/gm, "").replace(/\n\s*```\s*$/gm, "")
  assert.match(recovered, /print\(0\)/)
  assert.match(recovered, /print\(29\)/)
  assert.equal(recovered.split("\n").filter((line) => line.trim()).length, 30)
})

test("splitMessage never splits a surrogate pair", () => {
  const text = "🚀".repeat(80)
  const chunks = splitMessage(text, 51)

  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(""), text)
  for (const chunk of chunks) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk), "lone high surrogate")
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk), "lone low surrogate")
  }
})

test("splitMessage moves an inline code span to the next chunk instead of cutting it", () => {
  const lead = "word ".repeat(16)
  const span = '`short longer tail`'
  const tail = "and more text ".repeat(30)
  const chunks = splitMessage(lead + span + tail, 100)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk too long: ${chunk.length}`)
    assert.equal((chunk.match(/`/g) ?? []).length % 2, 0, `unbalanced inline code:\n${chunk}`)
  }
  assert.ok(!chunks[0]?.includes("`"), "the span must not start in the first chunk")
  assert.ok(chunks[1]?.startsWith(span), `expected the whole span in chunk 2:\n${chunks[1]}`)
})

test("splitMessage closes and reopens an inline span that starts too early to re-cut", () => {
  const lead = "alpha beta gamma delta epsilon zeta "
  const span = '`lorem ipsum dolor sit amet consectetur adipiscing elit tempor inc`'
  const tail = "rest of the reply ".repeat(20)
  const chunks = splitMessage(lead + span + tail, 100)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk too long: ${chunk.length}`)
    assert.equal((chunk.match(/`/g) ?? []).length % 2, 0, `unbalanced inline code:\n${chunk}`)
  }
  const recovered = chunks.join(" ").replace(/`/g, "")
  for (const word of ["alpha", "zeta", "lorem", "adipiscing", "tempor", "rest"]) {
    assert.match(recovered, new RegExp(word))
  }
})
