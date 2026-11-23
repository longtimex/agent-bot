import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import type { Opencode } from "../src/opencode.js"
import { SessionArchiveStore } from "../src/sessionArchive.js"
import { SessionStore } from "../src/store.js"
import { TelegramSessionCommands } from "../src/telegramSessionCommands.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function harness(busy = false) {
  const dir = mkdtempSync(join(tmpdir(), "bot-tg-sessions-"))
  const store = new SessionStore(join(dir, "sessions.json"), log)
  const archive = new SessionArchiveStore(join(dir, "session-archive.json"), log)
  const deleted: string[] = []
  const oc = { deleteSession: async (id: string) => void deleted.push(id) } as unknown as Opencode
  const commands = new TelegramSessionCommands({
    store,
    archive,
    oc,
    engineLabel: (engine) => engine,
    modelLabel: (_engine, model) => model,
    busy: () => busy,
    formatTime: () => "11-23 18:00",
  })
  return { dir, store, archive, commands, deleted, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test("/new parks the session and /sessions switches back to it", async () => {
  const h = harness()
  try {
    const key = "tg:42"
    h.store.setEngine(key, "claude")
    h.store.setCliSession(key, "claude", "first")
    const reply = await h.commands.newSession(key, "第一个话题")
    assert.match(reply, /\/sessions/, "the reply tells the user how to come back")
    assert.equal(h.store.getCliSession(key, "claude"), undefined)

    const panel = h.commands.panel(key)
    assert.match(panel.text, /第一个话题/)
    const id = h.archive.list(key)[0]!.id
    assert.ok(JSON.stringify(panel.keyboard.inline_keyboard).includes(`sesresume:${id}`))

    h.store.setCliSession(key, "claude", "second")
    const sent: string[] = []
    const handled = await h.commands.callback(`sesresume:${id}`, key, async () => {}, async (text) => void sent.push(text), async () => {})
    assert.equal(handled, true)
    assert.equal(h.store.getCliSession(key, "claude"), "first", "the old context is back")
    assert.match(sent[0] ?? "", /已切回会话/)
    assert.equal(h.archive.list(key)[0]?.sessionID, "second", "the open session took its place")
  } finally {
    h.close()
  }
})

test("a chat only sees and resumes its own sessions", async () => {
  const h = harness()
  try {
    h.store.setEngine("tg:1", "claude")
    h.store.setCliSession("tg:1", "claude", "mine")
    await h.commands.newSession("tg:1", "我的")
    const id = h.archive.list("tg:1")[0]!.id
    assert.match(h.commands.panel("tg:2").text, /还没有历史会话/)
    const result = await h.commands.resume("tg:2", id)
    assert.equal(result.ok, false)
    assert.equal(h.archive.list("tg:1").length, 1, "another chat cannot take it")
  } finally {
    h.close()
  }
})

test("switching is refused while a task runs", async () => {
  const h = harness(true)
  try {
    h.store.setEngine("tg:1", "claude")
    h.store.setCliSession("tg:1", "claude", "s1")
    await h.commands.newSession("tg:1")
    const id = h.archive.list("tg:1")[0]!.id
    const result = await h.commands.resume("tg:1", id)
    assert.equal(result.ok, false)
    assert.match(result.message, /\/stop/)
    assert.equal(h.archive.list("tg:1").length, 1, "nothing was consumed")
  } finally {
    h.close()
  }
})

test("deleting an OpenCode history entry deletes its server session", async () => {
  const h = harness()
  try {
    h.store.setEngine("tg:1", "opencode")
    h.store.set("tg:1", "ses_abc")
    await h.commands.newSession("tg:1")
    const id = h.archive.list("tg:1")[0]!.id
    assert.equal(await h.commands.callback(`sesdel:${id}`, "tg:1", async () => {}, async () => {}, async () => {}), true)
    assert.deepEqual(h.deleted, ["ses_abc"])
    assert.equal(await h.commands.callback("snooze:abc:10", "tg:1", async () => {}, async () => {}, async () => {}), false)
  } finally {
    h.close()
  }
})
