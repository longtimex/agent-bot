import assert from "node:assert/strict"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readJsonObject, writePrivateAtomic } from "../src/jsonStore.js"

test("readJsonObject returns undefined for a missing file without warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-"))
  try {
    const warnings: string[] = []
    assert.equal(readJsonObject(join(dir, "absent.json"), (m) => warnings.push(m)), undefined)
    assert.deepEqual(warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readJsonObject moves unparseable bytes aside instead of losing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-corrupt-"))
  try {
    const path = join(dir, "store.json")
    writeFileSync(path, '{"tg:1": {"sessionID": "ses_1"')
    const warnings: string[] = []
    assert.equal(
      readJsonObject(path, (m) => warnings.push(m)),
      undefined,
    )
    const aside = readdirSync(dir).filter((name) => name.startsWith("store.json.corrupt-"))
    assert.equal(aside.length, 1, readdirSync(dir).join(", "))
    assert.equal(readFileSync(join(dir, aside[0]!), "utf8"), '{"tg:1": {"sessionID": "ses_1"')
    assert.match(warnings[0] ?? "", /moved it to/)
    assert.equal(readdirSync(dir).includes("store.json"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readJsonObject quarantines a JSON root that is not an object", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-root-"))
  try {
    for (const body of ["[1,2,3]", "null", '"text"', "42"]) {
      const path = join(dir, "store.json")
      writeFileSync(path, body)
      assert.equal(
        readJsonObject(path, () => {}),
        undefined,
        body,
      )
      assert.equal(readdirSync(dir).some((name) => name.startsWith("store.json.corrupt-")), true, body)
      rmSync(join(dir, readdirSync(dir).find((name) => name.startsWith("store.json.corrupt-"))!))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readJsonObject returns the object root untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-ok-"))
  try {
    const path = join(dir, "store.json")
    writeFileSync(path, '{"a":{"b":1}}')
    assert.deepEqual(readJsonObject(path, () => {}), { a: { b: 1 } })
    assert.equal(readdirSync(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writePrivateAtomic re-modes a file that someone else created world-readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-write-"))
  try {
    const path = join(dir, "api-token.json")
    writeFileSync(path, "pre-existing", { mode: 0o644 })
    chmodSync(path, 0o644)

    writePrivateAtomic(path, '{"token":"abc"}')
    assert.equal(readFileSync(path, "utf8"), '{"token":"abc"}')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(readdirSync(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writePrivateAtomic creates the parent directory and leaves no temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-nested-"))
  try {
    const path = join(dir, "nested", "state.json")
    writePrivateAtomic(path, '{"ok":true}')
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: true })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(join(dir, "nested")), ["state.json"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writePrivateAtomic cleans the temp file and throws when the swap fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-json-fail-"))
  try {
    // A directory in the destination's place makes the rename fail
    mkdirSync(join(dir, "blocked"))
    assert.throws(() => writePrivateAtomic(join(dir, "blocked"), "payload"), { code: /^(EISDIR|ENOTDIR|EPERM)$/ })
    assert.deepEqual(readdirSync(dir), ["blocked"], "temp file must not survive the failure")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
