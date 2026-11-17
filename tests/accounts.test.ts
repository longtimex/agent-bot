import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AccountStore, DEFAULT_CATEGORY } from "../src/accounts.js"
import { assertFileMode } from "./support/platform.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-accounts-"))
  const store = () => new AccountStore(join(dir, "accounts.json"), join(dir, "accounts.key"), log)
  return { dir, store, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test("accounts stores entries, groups them by a free-form category", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "GitHub", username: "me@example.com", password: "s3cret", category: "开发" })
    store.add({ name: "微博", username: "13800000000", category: "社交" })
    store.add({ name: "路由器", username: "admin", category: "开发" })

    assert.equal(store.size, 3)
    assert.deepEqual(store.categories(), [
      { name: "开发", count: 2 },
      { name: "社交", count: 1 },
    ])
    assert.equal(store.list("开发").length, 2)
    assert.equal(store.list().length, 3)
    // An unknown category is simply empty, not an error
    assert.deepEqual(store.list("不存在"), [])
  } finally {
    f.close()
  }
})

test("accounts falls back to the default category and keeps names case-insensitive unique", () => {
  const f = fixture()
  try {
    const store = f.store()
    const entry = store.add({ name: "Gmail", username: "me@gmail.com" })
    assert.equal(entry.category, DEFAULT_CATEGORY)
    assert.throws(() => store.add({ name: "gmail", username: "other@example.com" }), /已存在/)
    assert.equal(store.find("GMAIL")?.id, entry.id)
  } finally {
    f.close()
  }
})

test("accounts encrypts the password on disk and reveals it only on request", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "Bank", username: "u1", password: "plain-text-password" })
    const raw = readFileSync(join(f.dir, "accounts.json"), "utf8")
    assert.ok(!raw.includes("plain-text-password"), "the password must not reach the file in clear text")

    const revealed = store.reveal("bank")
    assert.equal(revealed?.password, "plain-text-password")
    // Listing never carries the ciphertext either; only reveal does
    assert.equal(store.list()[0]?.secret?.includes("plain"), false)
  } finally {
    f.close()
  }
})

test("accounts survives a reload and keeps the ciphertext readable", () => {
  const f = fixture()
  try {
    f.store().add({ name: "Reload", username: "u", password: "p@ss", category: "测试" })
    const reopened = f.store()
    assert.equal(reopened.size, 1)
    assert.equal(reopened.reveal("reload")?.password, "p@ss")
    assert.equal(reopened.list()[0]?.category, "测试")
  } finally {
    f.close()
  }
})

test("accounts creates a private key file next to the data", () => {
  const f = fixture()
  try {
    f.store().add({ name: "Keyed", username: "u", password: "p" })
    assertFileMode(join(f.dir, "accounts.key"), 0o600)
    assertFileMode(join(f.dir, "accounts.json"), 0o600)
  } finally {
    f.close()
  }
})

test("accounts refuses to overwrite a store it cannot parse", () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, "accounts.json"), "{not json")
    const store = f.store()
    assert.equal(store.size, 0)
    assert.throws(() => store.add({ name: "x", username: "y" }), /无法解析/)
  } finally {
    f.close()
  }
})

test("accounts refuses to replace a damaged key instead of losing every password", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "Keep", username: "u", password: "p" })
    writeFileSync(join(f.dir, "accounts.key"), "not-a-key")
    const reopened = f.store()
    assert.throws(() => reopened.reveal("keep"), /密钥.*格式无效/)
  } finally {
    f.close()
  }
})

test("accounts removes an entry and reports whether it existed", () => {
  const f = fixture()
  try {
    const store = f.store()
    const entry = store.add({ name: "Temp", username: "u" })
    assert.equal(store.remove("temp")?.id, entry.id)
    assert.equal(store.remove("temp"), undefined)
    assert.equal(store.size, 0)
  } finally {
    f.close()
  }
})
