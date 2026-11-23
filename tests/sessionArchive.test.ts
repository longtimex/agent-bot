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
      evicted.push(...result.evicted.map((entry) => entry.sessionID ?? ""))
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
        sessions: Array<{ id: string; current?: boolean }>
      }
      // Both stay listed: the resumed one is marked current, the one left behind sits beside it
      assert.equal(after.sessions.length, 2)
      assert.deepEqual(after.sessions.filter((s) => s.current).map((s) => s.id), [archivedId])
      assert.ok(after.sessions.some((s) => s.id === body.archived?.id && !s.current))
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

test("switching back and forth keeps every conversation listed and titled", async () => {
  await withApi(
    async (_key, _engine, text) => `ok:${text}`,
    async (h) => {
      // /new and resume refuse with 409 while a task runs, so each prompt is awaited to the end
      const send = async (text: string): Promise<void> => {
        const res = await fetch(`${h.base}/api/v1/task`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ text }) })
        assert.ok(res.status < 300, `task submit answered ${res.status}`)
        const { task } = (await res.json()) as { task: { id: string } }
        for (let attempt = 0; attempt < 200; attempt++) {
          const polled = (await (await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })).json()) as {
            task: { status: string }
          }
          if (polled.task.status !== "queued" && polled.task.status !== "running") return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.fail(`task ${task.id} never settled`)
      }
      const newChat = async (): Promise<void> => {
        const res = await fetch(`${h.base}/api/v1/new`, { method: "POST", headers: authHeaders() })
        assert.equal(res.status, 200)
        await res.body?.cancel()
      }
      const list = async () =>
        ((await (await fetch(`${h.base}/api/v1/sessions`, { headers: authHeaders() })).json()) as {
          sessions: Array<{ id: string; title?: string; current?: boolean; stateless?: boolean }>
        }).sessions
      const resume = async (id: string): Promise<void> => {
        const res = await fetch(`${h.base}/api/v1/sessions/${id}/resume`, { method: "POST", headers: authHeaders() })
        assert.equal(res.status, 200, `resume answered ${res.status}`)
        await res.body?.cancel()
      }

      h.store.setEngine("api:app", "claude")
      // Three conversations; the CLI stub records no session id, so each is a context-less one
      for (const topic of ["话题甲", "话题乙", "话题丙"]) {
        await send(topic)
        await newChat()
      }
      let rows = await list()
      assert.deepEqual(rows.map((r) => r.title).sort(), ["话题丙", "话题乙", "话题甲"].sort(), "every conversation keeps its own title")
      assert.ok(rows.every((r) => r.stateless), "a conversation without an engine session is still listed")

      const first = rows.find((r) => r.title === "话题甲")!
      const second = rows.find((r) => r.title === "话题乙")!
      await resume(first.id)
      await send("甲的追问")
      await resume(second.id)
      await resume(first.id)
      rows = await list()
      assert.equal(rows.length, 3, "switching back and forth neither drops nor duplicates entries")
      assert.deepEqual(rows.filter((r) => r.current).map((r) => r.title), ["话题甲"])
      assert.equal(new Set(rows.map((r) => r.id)).size, 3)
    },
  )
})

test("a pinned session is listed first and survives the 20-entry cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-archive-pin-"))
  try {
    let now = 1_000
    const store = new SessionArchiveStore(join(dir, "session-archive.json"), log, () => now)
    const pinned = store.add("api:app", { engine: "opencode", sessionID: "ses-pin", title: "置顶的" }).added
    assert.equal(store.update("api:app", pinned.id, { pinned: true })?.pinned, true)
    const evicted: string[] = []
    for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 3; i++) {
      now += 1
      evicted.push(...store.add("api:app", { engine: "opencode", sessionID: `ses-${i}` }).evicted.map((e) => e.sessionID ?? ""))
    }
    const listed = store.list("api:app")
    assert.equal(listed.length, MAX_ARCHIVED_SESSIONS)
    assert.equal(listed[0]?.id, pinned.id, "pinned comes first though it is the oldest")
    assert.deepEqual(evicted, ["ses-0", "ses-1", "ses-2", "ses-3"], "the cap takes the oldest unpinned entries")
    assert.equal(store.update("api:app", pinned.id, { title: "" })?.title, undefined, "an empty title clears it")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rename and pin go through PUT and survive switching away and back", async () => {
  await withApi(
    async (_key, _engine, text) => `ok:${text}`,
    async (h) => {
      h.store.setEngine("api:app", "claude")
      h.store.setCliSession("api:app", "claude", "s-a")
      h.store.noteTitle("api:app", "原始标题")
      const parked = (await (await fetch(`${h.base}/api/v1/new`, { method: "POST", headers: authHeaders() })).json()) as {
        archivedId?: string
      }
      const id = parked.archivedId!
      const put = await fetch(`${h.base}/api/v1/sessions/${id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ title: "重要：发布计划", pinned: true }),
      })
      assert.equal(put.status, 200)
      const body = (await put.json()) as { archived: { title?: string; pinned?: boolean } }
      assert.equal(body.archived.title, "重要：发布计划")
      assert.equal(body.archived.pinned, true)

      // Resume it, then park it again: the new name and the pin must stick
      assert.equal((await fetch(`${h.base}/api/v1/sessions/${id}/resume`, { method: "POST", headers: authHeaders() })).status, 200)
      assert.equal((await fetch(`${h.base}/api/v1/new`, { method: "POST", headers: authHeaders() })).status, 200)
      const rows = ((await (await fetch(`${h.base}/api/v1/sessions`, { headers: authHeaders() })).json()) as {
        sessions: Array<{ id: string; title?: string; pinned?: boolean }>
      }).sessions
      const row = rows.find((r) => r.id === id)
      assert.equal(row?.title, "重要：发布计划")
      assert.equal(row?.pinned, true)

      const bad = await fetch(`${h.base}/api/v1/sessions/${id}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ pinned: "yes" }) })
      assert.equal(bad.status, 400)
      const empty = await fetch(`${h.base}/api/v1/sessions/${id}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({}) })
      assert.equal(empty.status, 400)
      const missing = await fetch(`${h.base}/api/v1/sessions/abcdefabcdef`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ pinned: true }) })
      assert.equal(missing.status, 404)
    },
  )
})
