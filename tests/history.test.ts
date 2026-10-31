import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { formatHistoryMarkdown } from "../src/history.js"
import { MAX_HISTORY_PER_CHAT, TaskHistoryStore } from "../src/history.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("TaskHistoryStore keeps the newest entries per chat and persists them", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const path = join(dir, "history.json")
    const store = new TaskHistoryStore(path, log)
    for (let i = 1; i <= MAX_HISTORY_PER_CHAT + 5; i++) {
      store.record(
        "tg:1",
        { prompt: `  task ${i}\n second line `, engine: "opencode", model: "Gemini", ms: 1500, outcome: "ok" },
        1_700_000_000_000 + i,
      )
    }
    store.record("tg:2", { prompt: "other", engine: "claude", ms: 20, outcome: "failed" }, 1_700_000_100_000)

    const latest = store.list("tg:1", 3)
    assert.equal(latest.length, 3)
    assert.equal(latest[0]?.prompt, `task ${MAX_HISTORY_PER_CHAT + 5} second line`)
    assert.equal(latest[0]?.outcome, "ok")
    assert.equal(latest[0]?.ms, 1500)
    assert.equal(store.count("tg:1"), MAX_HISTORY_PER_CHAT)
    assert.equal(store.count("tg:2"), 1)

    const reloaded = new TaskHistoryStore(path, log)
    assert.equal(reloaded.count("tg:1"), MAX_HISTORY_PER_CHAT)
    assert.equal(reloaded.list("tg:1", 1)[0]?.prompt, latest[0]?.prompt)
    assert.equal(reloaded.list("tg:2", 1)[0]?.outcome, "failed")
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore truncates long prompts and clears per chat", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const path = join(dir, "history.json")
    const store = new TaskHistoryStore(path, log)
    store.record("tg:1", { prompt: "x".repeat(500), engine: "opencode", ms: 10, outcome: "failed" })
    store.record("tg:2", { prompt: "keep", engine: "opencode", ms: 10, outcome: "cancelled" })

    const entry = store.list("tg:1", 1)[0]!
    assert.equal(entry.prompt.length, 200)
    assert.ok(entry.prompt.endsWith("…"))
    assert.equal(entry.outcome, "failed")

    assert.equal(store.clear("tg:1"), 1)
    assert.equal(store.clear("tg:1"), 0)
    assert.equal(store.count("tg:1"), 0)
    assert.equal(store.count("tg:2"), 1)
    assert.equal(new TaskHistoryStore(path, log).count("tg:2"), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore ignores corrupt files and invalid entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const path = join(dir, "history.json")
    writeFileSync(path, "{not json")
    const store = new TaskHistoryStore(path, log)
    assert.equal(store.count("tg:1"), 0)
    const aside = readdirSync(dir).filter((name) => name.startsWith("history.json.corrupt-"))
    assert.equal(aside.length, 1, "an unreadable file must be kept, not silently replaced")
    store.record("tg:1", { prompt: "after corruption", engine: "opencode", ms: 1, outcome: "ok" })
    assert.match(readFileSync(path, "utf8"), /after corruption/)

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        chats: {
          "tg:9": [
            { at: 1, prompt: "bad outcome", engine: "e", ms: 1, outcome: "weird" },
            { at: 2, prompt: "good", engine: "e", ms: 1, outcome: "ok" },
          ],
        },
      }),
    )
    const sanitized = new TaskHistoryStore(path, log)
    assert.equal(sanitized.count("tg:9"), 1)
    assert.equal(sanitized.list("tg:9", 5)[0]?.prompt, "good")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore never truncates a prompt inside a surrogate pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const store = new TaskHistoryStore(join(dir, "history.json"), log)
    // The emoji straddles the 199-character cut: a naive slice keeps its high half
    store.record("tg:1", {
      prompt: `${"a".repeat(198)}😀${"b".repeat(50)}`,
      engine: "opencode",
      ms: 1,
      outcome: "ok",
    })
    const prompt = store.list("tg:1", 1)[0]!.prompt
    assert.ok(prompt.endsWith("…"))
    assert.ok(prompt.length <= 200)
    for (let i = 0; i < prompt.length; i++) {
      const code = prompt.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = prompt.charCodeAt(i + 1)
        assert.ok(next >= 0xdc00 && next <= 0xdfff, "truncation left a lone high surrogate")
        i += 1
      } else {
        assert.ok(!(code >= 0xdc00 && code <= 0xdfff), "truncation left a lone low surrogate")
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore keeps prototype-shaped chat keys from the data file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const path = join(dir, "history.json")
    const seededAt = Date.now() - 60_000
    // Written as raw JSON text: an object literal with a __proto__ key would set the
    // prototype instead of creating a chat, so it could not reproduce a tampered file.
    // The timestamp stays inside the retention window, unlike a small fixed epoch value
    writeFileSync(
      path,
      `{"version":1,"chats":{"__proto__":[{"at":${seededAt},"prompt":"tampered","engine":"opencode","ms":5,"outcome":"ok"}]}}`,
    )
    const store = new TaskHistoryStore(path, log)
    assert.equal(store.count("__proto__"), 1, "prototype-shaped key must load as its own chat")
    assert.equal(store.list("__proto__", 1)[0]?.prompt, "tampered")

    store.record("tg:1", { prompt: "fresh", engine: "opencode", ms: 1, outcome: "ok" })
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { chats: Record<string, unknown> }
    assert.ok(Object.hasOwn(persisted.chats, "__proto__"), "record must survive the next save")

    const reloaded = new TaskHistoryStore(path, log)
    assert.equal(reloaded.count("__proto__"), 1)
    assert.equal(reloaded.count("tg:1"), 1)
    assert.equal(reloaded.clear("__proto__"), 1)
    assert.equal(new TaskHistoryStore(path, log).count("__proto__"), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore redacts credentials before persisting prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const path = join(dir, "history.json")
    const store = new TaskHistoryStore(path, log)
    store.record("tg:1", { prompt: "use sk-abcdefgh12345678 now", engine: "opencode", ms: 1, outcome: "ok" })

    const entry = store.list("tg:1", 1)[0]!
    assert.equal(entry.prompt, "use sk-*** now")
    assert.doesNotMatch(readFileSync(path, "utf8"), /sk-abcdefgh12345678/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore forgets chats dormant past the retention window", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const path = join(dir, "history.json")
    const store = new TaskHistoryStore(path, log)
    const now = Date.UTC(2026, 5, 1)
    store.record("tg:quiet", { prompt: "old", engine: "opencode", ms: 1, outcome: "ok" }, now - 40 * 86_400_000)
    assert.equal(store.count("tg:quiet"), 1)

    store.record("tg:active", { prompt: "new", engine: "opencode", ms: 1, outcome: "ok" }, now)

    assert.equal(store.count("tg:quiet"), 0, "a dormant chat must be swept")
    assert.equal(store.count("tg:active"), 1)
    assert.doesNotMatch(readFileSync(path, "utf8"), /tg:quiet/, "the sweep must reach the file")
    assert.equal(new TaskHistoryStore(path, log).count("tg:quiet"), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TaskHistoryStore keeps a recent entry in a chat that also has stale ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-"))
  try {
    const store = new TaskHistoryStore(join(dir, "history.json"), log)
    const now = Date.UTC(2026, 5, 1)
    store.record("tg:1", { prompt: "old", engine: "opencode", ms: 1, outcome: "ok" }, now - 90 * 86_400_000)
    store.record("tg:1", { prompt: "recent", engine: "opencode", ms: 1, outcome: "ok" }, now - 60 * 60_000)

    assert.deepEqual(
      store.list("tg:1", 5).map((entry) => entry.prompt),
      ["recent", "old"],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("formatHistoryMarkdown renders a standalone document with quoted prompts", () => {
  const entries = [
    { at: Date.UTC(2026, 0, 2, 3, 30), prompt: "第一行\n第二行", engine: "opencode", model: "Gemini 3.8", ms: 12_345, outcome: "ok" },
    { at: Date.UTC(2026, 0, 1, 9, 0), prompt: "```json\n{}\n```", engine: "claude", ms: 500, outcome: "failed", scheduled: true },
  ]
  const doc = formatHistoryMarkdown(entries, { source: "App (api:app)", timeZone: "Asia/Shanghai" })
  assert.match(doc, /# Agent Bot 任务历史/)
  assert.match(doc, /来源：App \(api:app\)/)
  assert.match(doc, /共 2 条（成功 1 · 失败 1 · 取消 0）/)
  assert.match(doc, /✅ 01-02 11:30/)
  assert.match(doc, /❌ 01-01 17:00/)
  assert.match(doc, /定时/)
  // multi-line prompts are blockquoted line by line, and fences cannot break layout
  assert.match(doc, /^> 第一行$/m)
  assert.match(doc, /^> 第二行$/m)
  assert.match(doc, /^> ```json$/m)

  assert.match(formatHistoryMarkdown([], {}), /暂无任务记录/)
})
