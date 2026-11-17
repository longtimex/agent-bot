import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { NoticeStore } from "../src/appNotices.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-notices-"))
  return {
    store: () => new NoticeStore(join(dir, "app-notices.json"), log),
    file: join(dir, "app-notices.json"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("notices are appended and read back in order", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.push({ kind: "reminder", text: "喝水", at: 1000 })
    store.push({ kind: "schedule", text: "日报已生成", at: 2000 })
    assert.deepEqual(store.list().map((n) => n.text), ["喝水", "日报已生成"])
  } finally {
    f.close()
  }
})

test("notices filter by since so the App only inserts what it has not seen", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.push({ kind: "reminder", text: "旧", at: 1000 })
    store.push({ kind: "reminder", text: "新", at: 3000 })
    assert.deepEqual(store.list(1500).map((n) => n.text), ["新"])
    assert.deepEqual(store.list(3000).map((n) => n.text), [], "a notice at the cursor is already seen")
  } finally {
    f.close()
  }
})

test("a second instance sees what the first wrote", () => {
  const f = fixture()
  try {
    f.store().push({ kind: "reminder", text: "来自桥接", at: 1000 })
    // The API holds its own store over the same file
    assert.deepEqual(f.store().list().map((n) => n.text), ["来自桥接"])
  } finally {
    f.close()
  }
})

test("notices keep only the newest 200", () => {
  const f = fixture()
  try {
    const store = f.store()
    for (let i = 0; i < 205; i++) store.push({ kind: "system", text: `第 ${i} 条`, at: 1000 + i })
    const list = store.list(undefined, 500)
    assert.equal(list.length, 200)
    assert.equal(list[0]?.text, "第 5 条")
    assert.equal(list.at(-1)?.text, "第 204 条")
  } finally {
    f.close()
  }
})

test("a damaged mailbox is ignored instead of blocking delivery", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.push({ kind: "reminder", text: "还能用", at: 1000 })
    rmSync(f.file)
    assert.deepEqual(store.list(), [])
  } finally {
    f.close()
  }
})

test("notices keep their kind so the client can tell a reminder from a report", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.push({ kind: "reminder", text: "喝水", at: 1000 })
    store.push({ kind: "schedule", text: "日报已生成", at: 2000 })
    store.push({ kind: "report", text: "今日用量", at: 3000 })
    assert.deepEqual(
      store.list().map((notice) => notice.kind),
      ["reminder", "schedule", "report"],
    )
  } finally {
    f.close()
  }
})
