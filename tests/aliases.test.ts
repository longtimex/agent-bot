import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AliasStore, isValidAliasName } from "../src/aliases.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("isValidAliasName accepts Telegram command shapes", () => {
  assert.equal(isValidAliasName("code"), true)
  assert.equal(isValidAliasName("daily_report2"), true)
  assert.equal(isValidAliasName("2fast"), false)
  assert.equal(isValidAliasName("has-dash"), false)
  assert.equal(isValidAliasName("has space"), false)
  assert.equal(isValidAliasName("x"), false)
  assert.equal(isValidAliasName("a".repeat(33)), false)
})

test("AliasStore add, expand and remove per chat", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-alias-"))
  try {
    const store = new AliasStore(join(dir, "aliases.json"), log)
    const entry = store.add(42, "Code", "审查当前目录的代码")
    assert.equal(entry.name, "code")
    assert.equal(store.expand(42, "code"), "审查当前目录的代码")
    assert.equal(store.expand(42, "CODE"), "审查当前目录的代码")
    assert.equal(store.expand(7, "code"), undefined)

    // Re-adding replaces the expansion instead of growing the list
    store.add(42, "code", "新的内容")
    assert.equal(store.count(42), 1)
    assert.equal(store.expand(42, "code"), "新的内容")

    const removed = store.remove(42, "code")
    assert.equal(removed?.name, "code")
    assert.equal(store.remove(42, "code"), undefined)
    assert.equal(store.expand(42, "code"), undefined)

    assert.throws(() => store.add(42, "Bad Name", "内容"), /小写字母/)
    assert.throws(() => store.add(42, "ok", "   "), /指令内容/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AliasStore persists across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-alias-"))
  try {
    const path = join(dir, "aliases.json")
    const first = new AliasStore(path, log)
    first.add(42, "deploy", "/ops")
    first.add(42, "daily", "汇总今日日志")

    const second = new AliasStore(path, log)
    assert.equal(second.expand(42, "deploy"), "/ops")
    assert.deepEqual(second.list(42).map((entry) => entry.name), ["daily", "deploy"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AliasStore skips invalid entries and duplicate ids stay safe on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-alias-"))
  try {
    const path = join(dir, "aliases.json")
    writeFileSync(
      path,
      JSON.stringify({
        aliases: {
          "42": {
            good: { name: "good", expansion: "ok", createdAt: 1 },
            "bad name": { name: "bad name", expansion: "ignored", createdAt: 2 },
            empty: { name: "empty", expansion: "", createdAt: 3 },
          },
          broken: "not-an-object",
        },
      }),
    )
    const store = new AliasStore(path, log)
    assert.deepEqual(store.list(42).map((entry) => entry.name), ["good"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AliasStore refuses writes when the file is unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-alias-"))
  try {
    const path = join(dir, "aliases.json")
    writeFileSync(path, "{not json")
    const store = new AliasStore(path, log)
    assert.throws(() => store.add(42, "code", "内容"), /无法解析/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
