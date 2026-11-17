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

test("accounts update rewrites only the fields it is given", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "Edit", username: "u1", password: "old", category: "开发", notes: "保留" })
    const updated = store.update("edit", { password: "new" })
    assert.equal(updated.category, "开发")
    assert.equal(updated.notes, "保留")
    assert.equal(store.reveal("edit")?.password, "new")
  } finally {
    f.close()
  }
})

test("accounts update clears a field when it is null", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "Clear", username: "u", password: "p", notes: "旧备注", url: "https://x" })
    const updated = store.update("clear", { notes: null, url: null, password: null })
    assert.equal(updated.notes, undefined)
    assert.equal(updated.url, undefined)
    assert.equal(store.reveal("clear")?.password, "")
  } finally {
    f.close()
  }
})

test("accounts update refuses to rename onto an existing entry", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "One", username: "u" })
    store.add({ name: "Two", username: "u" })
    assert.throws(() => store.update("one", { name: "two" }), /已存在/)
    // Renaming to its own name is a no-op, not a clash
    assert.equal(store.update("one", { name: "One" }).name, "One")
  } finally {
    f.close()
  }
})

test("accounts keeps tags and custom fields, and filters by tag", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({
      name: "小红书-A",
      username: "u1",
      category: "社交运营",
      tags: ["小红书", "美妆", "A组"],
      extras: { 绑定邮箱: "op@example.com", 负责人: "小王" },
    })
    store.add({ name: "抖音-B", username: "u2", category: "社交运营", tags: ["抖音"] })

    const reloaded = f.store()
    const entry = reloaded.find("小红书-A")
    assert.deepEqual(entry?.tags, ["小红书", "美妆", "A组"])
    assert.deepEqual(entry?.extras, { 绑定邮箱: "op@example.com", 负责人: "小王" })

    assert.equal(reloaded.list(undefined, "美妆").length, 1)
    // Order follows the locale collation, so only membership is asserted
    const tagNames = reloaded.tags().map((tag) => tag.name)
    assert.equal(tagNames.length, 4)
    for (const tag of ["小红书", "美妆", "A组", "抖音"]) assert.ok(tagNames.includes(tag), `missing tag ${tag}`)

    reloaded.update("小红书-A", { tags: ["小红书"], extras: { 负责人: "小李" } })
    assert.deepEqual(reloaded.find("小红书-A")?.tags, ["小红书"])
    assert.deepEqual(reloaded.find("小红书-A")?.extras, { 负责人: "小李" })
  } finally {
    f.close()
  }
})

test("accounts reports shared passwords without revealing them", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "Alpha", username: "u", password: "same-secret" })
    store.add({ name: "Beta", username: "u", password: "same-secret" })
    store.add({ name: "Gamma", username: "u", password: "other-secret" })
    const groups = store.sharedPasswords()
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0]?.names, ["Alpha", "Beta"])
    // The report must never carry the password or a digest
    assert.ok(!JSON.stringify(groups).includes("same-secret"))
  } finally {
    f.close()
  }
})

test("accounts snapshot answers list, categories and tags from a single read", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "One", username: "u", category: "开发", tags: ["A"] })
    store.add({ name: "Two", username: "u", category: "社交", tags: ["A", "B"] })
    const snapshot = store.snapshot()
    assert.equal(snapshot.entries.length, 2)
    assert.deepEqual(snapshot.categories.map((item) => item.name).sort(), ["开发", "社交"].sort())
    assert.deepEqual(snapshot.tags.map((item) => item.name).sort(), ["A", "B"])
  } finally {
    f.close()
  }
})
