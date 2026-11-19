import assert from "node:assert/strict"
import test from "node:test"
import { parseJsoncObject, removeJsonPath, setJsonPath } from "../src/jsoncEdit.js"

const PATH = ["provider", "p", "models", "m1"]

function read(text: string, ...keys: string[]): unknown {
  let node: unknown = parseJsoncObject(text)
  for (const key of keys) node = (node as Record<string, unknown> | undefined)?.[key]
  return node
}

test("a trailing comma survives an insertion instead of producing invalid JSON", () => {
  // The comma after the last property is a trailing comma, not a separator: reusing it as
  // one left `"a": 1 "provider": …` with no comma at all.
  const text = '{\n  "a": 1,\n}\n'
  const next = setJsonPath(text, PATH, { name: "M1" })
  assert.ok(parseJsoncObject(next), "the result must still parse")
  assert.equal(read(next, "a"), 1)
  assert.deepEqual(read(next, "provider", "p", "models", "m1"), { name: "M1" })
})

test("a comma inside a comment is not mistaken for a separator", () => {
  const text = '{\n  "a": 1 // 逗号, 在注释里\n}\n'
  const next = setJsonPath(text, PATH, { name: "M1" })
  assert.ok(parseJsoncObject(next))
  assert.match(next, /逗号, 在注释里/)
  assert.equal(read(next, "a"), 1)
})

test("an empty object is filled with the file's own indentation", () => {
  const next = setJsonPath("{}", ["provider"], { p: {} })
  assert.deepEqual(parseJsoncObject(next), { provider: { p: {} } })
})

test("a tab-indented file keeps tabs", () => {
  const text = '{\n\t"provider": {\n\t\t"p": {\n\t\t\t"models": {}\n\t\t}\n\t}\n}\n'
  const next = setJsonPath(text, PATH, { name: "M1" })
  assert.match(next, /\n\t{4}"m1": \{/)
  assert.ok(!next.includes("    "), "no spaces may be introduced")
})

test("a broken models array is replaced rather than nested into", () => {
  const text = '{\n  "provider": {\n    "p": {\n      "models": ["bad"]\n    }\n  }\n}\n'
  const next = setJsonPath(text, PATH, { name: "M1" })
  assert.deepEqual(read(next, "provider", "p", "models"), { m1: { name: "M1" } })
})

test("a null provider is replaced instead of aborting", () => {
  const next = setJsonPath('{\n  "provider": null\n}\n', PATH, { name: "M1" })
  assert.deepEqual(read(next, "provider", "p", "models", "m1"), { name: "M1" })
})

test("adding then removing a path restores the document byte for byte", () => {
  const samples = [
    '{\n    // 注释\n    "a": 1,\n    "provider": {\n        "p": {\n            "models": {\n                "base": { "name": "Base" }\n            }\n        }\n    }\n}\n',
    '{\r\n  "provider": {\r\n    "p": {\r\n      "models": {\r\n        "base": { "name": "Base" }\r\n      }\r\n    }\r\n  }\r\n}\r\n',
    '{\n  "provider": {\n    "p": {\n      "models": {}\n    }\n  }\n}\n',
  ]
  for (const text of samples) {
    const added = setJsonPath(text, PATH, { name: "M1" })
    assert.notEqual(added, text)
    assert.equal(removeJsonPath(added, PATH), text)
  }
})

test("removing the only property leaves a valid empty object", () => {
  const next = removeJsonPath('{\n  "provider": {\n    "p": {\n      "models": {\n        "m1": { "name": "M1" }\n      }\n    }\n  }\n}\n', PATH)
  assert.ok(parseJsoncObject(next))
  assert.deepEqual(read(next, "provider", "p", "models"), {})
})

test("an unparseable document is refused instead of being rewritten", () => {
  assert.throws(() => setJsonPath("{ not json", PATH, { name: "M1" }), /无法解析/)
  assert.throws(() => removeJsonPath("{ not json", PATH), /无法解析/)
})

test("removing a path that is not there is refused", () => {
  assert.throws(() => removeJsonPath('{\n  "a": 1\n}\n', PATH), /路径不存在/)
})
