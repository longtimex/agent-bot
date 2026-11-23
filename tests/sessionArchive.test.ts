import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import { MAX_ARCHIVED_SESSIONS, SessionArchiveStore, staleAttachmentNotice } from "../src/sessionArchive.js"
import { authHeaders, withApi } from "./api.test.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("the archive keeps the newest sessions and reports the evicted ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-archive-"))
  try {
    let now = 1_000
    const store = new SessionArchiveStore(join(dir, "session-archive.json"), log, () => now)
    const evicted: string[] = []
    for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 2; i++) {
      now += 1
      const result = store.add("api:app", { engine: "opencode", sessionID: `ses-${i}`, title: `第 ${i} 个` })
      evicted.push(...result.evicted.map((entry) => entry.sessionID))
    }
    const listed = store.list("api:app")
    assert.equal(listed.length, MAX_ARCHIVED_SESSIONS)
    assert.equal(listed[0]?.sessionID, `ses-${MAX_ARCHIVED_SESSIONS + 1}`, "newest first")
    assert.deepEqual(evicted, ["ses-0", "ses-1"], "the oldest are evicted so their server sessions can be deleted")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("archiving the same engine session twice keeps one entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-archive-dup-"))
  try {
    const store = new SessionArchiveStore(join(dir, "session-archive.json"), log)
    store.add("api:app", { engine: "claude", sessionID: "same" })
    store.add("api:app", { engine: "claude", sessionID: "same", title: "再次" })
    const listed = store.list("api:app")
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.title, "再次")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("new parks the session and resume brings its context back", async () => {
  await withApi(
    async (_key, _engine, text) => `ok:${text}`,
    async (h) => {
      h.store.setEngine("api:app", "claude")
      h.store.setCliSession("api:app", "claude", "first-session")
      h.store.setCliModel("api:app", "claude", "claude-sonnet-4-5")

      const parked = await fetch(`${h.base}/api/v1/new`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ title: "第一个话题" }),
      })
      assert.equal(parked.status, 200)
      const { archivedId } = (await parked.json()) as { archivedId?: string }
      assert.ok(archivedId, "the reply names the archive entry")
      assert.equal(h.store.getCliSession("api:app", "claude"), undefined, "the live session was reset")

      // A second conversation, then switch back to the first
      h.store.setCliSession("api:app", "claude", "second-session")
      const listed = (await (await fetch(`${h.base}/api/v1/sessions`, { headers: authHeaders() })).json()) as {
        sessions: Array<{ id: string; title?: string; engine: string }>
      }
      assert.deepEqual(listed.sessions.map((s) => s.title), ["第一个话题"])
      assert.ok(!JSON.stringify(listed).includes("first-session"), "the engine's own session id never leaves the server")

      const resumed = await fetch(`${h.base}/api/v1/sessions/${archivedId}/resume`, { method: "POST", headers: authHeaders() })
      assert.equal(resumed.status, 200)
      const body = (await resumed.json()) as { archived?: { id: string }; session: { hasSession?: boolean } }
      assert.equal(h.store.getCliSession("api:app", "claude"), "first-session", "the Agent's context is restored")
      assert.equal(h.store.getCliModel("api:app", "claude"), "claude-sonnet-4-5")
      assert.equal(body.session.hasSession, true)
      assert.ok(body.archived?.id, "the session that was open is parked in its place")

      const after = (await (await fetch(`${h.base}/api/v1/sessions`, { headers: authHeaders() })).json()) as {
        sessions: Array<{ id: string }>
      }
      assert.equal(after.sessions.length, 1, "the resumed entry left the archive, the replaced one joined it")
      assert.equal(after.sessions[0]?.id, body.archived?.id)
    },
  )
})

test("new without any context archives nothing", async () => {
  await withApi(
    async () => "ok",
    async (h) => {
      h.store.setEngine("api:app", "claude")
      const res = await fetch(`${h.base}/api/v1/new`, { method: "POST", headers: authHeaders() })
      assert.equal(res.status, 200)
      assert.equal(((await res.json()) as { archivedId?: string }).archivedId, undefined)
      const listed = (await (await fetch(`${h.base}/api/v1/sessions`, { headers: authHeaders() })).json()) as {
        sessions: unknown[]
      }
      assert.deepEqual(listed.sessions, [])
    },
  )
})

test("resuming or deleting an unknown session answers 404", async () => {
  await withApi(
    async () => "ok",
    async (h) => {
      const resume = await fetch(`${h.base}/api/v1/sessions/abcdefabcdef/resume`, { method: "POST", headers: authHeaders() })
      assert.equal(resume.status, 404)
      const del = await fetch(`${h.base}/api/v1/sessions/abcdefabcdef`, { method: "DELETE", headers: authHeaders() })
      assert.equal(del.status, 404)
    },
  )
})

test("a session parked past the inbox retention warns that its attachments are gone", () => {
  const day = 24 * 60 * 60 * 1000
  const entry = { id: "abcdefabcdef", engine: "claude", sessionID: "s", archivedAt: 1_000 }
  assert.equal(staleAttachmentNotice(entry, day, 1_000 + day - 1), undefined, "files can still be there")
  assert.match(staleAttachmentNotice(entry, day, 1_000 + day + 1) ?? "", /24 小时.*重新发送/)
})
