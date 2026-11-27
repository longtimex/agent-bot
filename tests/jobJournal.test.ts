import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { recoveredTasks, type StoredApiTask } from "../src/apiTaskJournal.js"
import { ApiTaskManager } from "../src/apiTasks.js"
import { freezeJobJournals, JobJournal, planRecovery, RESUME_MAX_AGE_MS, type JournalEntry } from "../src/jobJournal.js"
import { SessionStore } from "../src/store.js"
import type { Job } from "../src/telegram.js"
import { handleQueueButton, recoveryNotice, TelegramJobJournal, type StoredJob } from "../src/telegramJobQueue.js"

const log = { debug() {}, info() {}, warn() {}, error() {} }
const tmp = (): string => mkdtempSync(join(tmpdir(), "job-journal-"))
const stored = (path: string): JournalEntry<unknown>[] =>
  (JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry<unknown>[] }).entries

test("the journal follows a message from queued to running to gone, and hands the rest to the next start", () => {
  const path = join(tmp(), "jobs.json")
  const journal = new JobJournal<{ text: string }>(path, log)
  journal.track("a", { text: "第一条" }, 1_000)
  journal.track("b", { text: "第二条" }, 2_000)
  journal.track("c", { text: "第三条" }, 3_000)
  journal.started("a")
  journal.finished("c")
  assert.deepEqual(stored(path).map((entry) => [entry.id, entry.state]), [["a", "running"], ["b", "queued"]])

  // A crash here: the next process reads what was left
  const next = new JobJournal<{ text: string }>(path, log)
  // Something queued before recovery runs must not overwrite the previous entries
  next.track("d", { text: "新消息" }, 4_000)
  assert.deepEqual(stored(path).map((entry) => entry.id), ["a", "b", "d"])
  const plan = next.takeRecovery(2_000 + 60_000)
  assert.deepEqual(plan.interrupted.map((entry) => entry.id), ["a"])
  assert.deepEqual(plan.resume.map((entry) => entry.payload.text), ["第二条"])
  assert.deepEqual(stored(path).map((entry) => entry.id), ["d"], "taken entries leave the file")
  assert.equal(next.takeRecovery().resume.length, 0, "recovery happens once")
})

test("old waiting messages are reported, not run; a clock that jumped back still resumes", () => {
  const entries: JournalEntry<string>[] = [
    { id: "old", state: "queued", queuedAt: 0, payload: "old" },
    { id: "new", state: "queued", queuedAt: RESUME_MAX_AGE_MS, payload: "new" },
    { id: "future", state: "queued", queuedAt: RESUME_MAX_AGE_MS * 5, payload: "future" },
    { id: "run", state: "running", queuedAt: 10, payload: "run" },
  ]
  const plan = planRecovery(entries, RESUME_MAX_AGE_MS + 1)
  assert.deepEqual(plan.expired.map((entry) => entry.id), ["old"])
  assert.deepEqual(plan.resume.map((entry) => entry.id), ["new", "future"])
  assert.deepEqual(plan.interrupted.map((entry) => entry.id), ["run"])
})

test("an unreadable journal is ignored rather than stopping the bot", () => {
  const path = join(tmp(), "jobs.json")
  writeFileSync(path, "{not json")
  const journal = new JobJournal(path, log)
  assert.equal(journal.takeRecovery().resume.length, 0)
  writeFileSync(path, JSON.stringify({ entries: [{ id: 1 }, { id: "x", state: "queued", queuedAt: Date.now(), payload: {} }] }))
  assert.deepEqual(new JobJournal(path, log).takeRecovery().resume.map((entry) => entry.id), ["x"], "malformed rows are skipped")
})

test("shutdown freezes the journal, so the cancellations of stopping are not written out", () => {
  const path = join(tmp(), "jobs.json")
  const journal = new JobJournal<{ text: string }>(path, log)
  journal.track("a", { text: "跑着" })
  journal.started("a")
  journal.track("b", { text: "排着" })
  freezeJobJournals()
  // What stopping the process does to both of them
  journal.finished("a")
  journal.dropQueued(() => true)
  const plan = new JobJournal<{ text: string }>(path, log).takeRecovery()
  assert.deepEqual(plan.interrupted.map((entry) => entry.id), ["a"])
  assert.deepEqual(plan.resume.map((entry) => entry.id), ["b"])
})

function job(id: string, text: string, extra: Partial<Job> = {}): Job {
  return { id, key: "tg:7", text, chatId: 7, userId: 1, generation: 0, ...extra }
}

test("Telegram recovery: one notice per chat first, then the waiting messages in order", async () => {
  const path = join(tmp(), "queued-jobs.json")
  const before = new TelegramJobJournal(path, log)
  before.track(job("q1", "正在跑的任务"))
  before.started(job("q1", "正在跑的任务"))
  before.track(job("q2", "排队一"))
  before.track(job("q3", "排队二", { attachments: [{ fileId: "f", kind: "image", name: "a.jpg", mime: "image/jpeg" }] }))
  before.track(job("q4", "定时任务", { scheduled: true }))
  before.track(job("q5", "等结果的", { onOutcome: () => {} }))
  before.track(job("q6", "别的聊天", { key: "tg:8", chatId: 8 }))
  before.track(job("q7", "已取消"))
  before.finished(job("q7", "已取消"))

  const events: string[] = []
  const remembered: string[] = []
  await new TelegramJobJournal(path, log).recover({
    enqueue: (stored) => events.push(`run ${stored.chatId} ${stored.text} ${stored.attachments?.length ?? 0}`),
    send: async (chatId, text) => {
      events.push(`say ${chatId} ${text.split("\n").length}`)
    },
    remember: (key, prompt) => remembered.push(`${key} ${prompt.text}`),
  })
  assert.deepEqual(events, ["say 7 4", "run 7 排队一 0", "run 7 排队二 1", "say 8 2", "run 8 别的聊天 0"])
  assert.deepEqual(remembered, ["tg:7 正在跑的任务"], "/retry replays the interrupted task")
})

test("the recovery notice explains each case and lists stale messages", () => {
  const plain = (text: string): StoredJob => ({ key: "k", text, chatId: 1, userId: 1 })
  const notice = recoveryNotice({
    resume: [plain("a")],
    interrupted: [plain("改一下 README_file")],
    expired: [plain("很久以前的问题"), plain("")],
  })
  assert.match(notice, /被中断，没有自动重跑/)
  assert.match(notice, /README\\_file/, "excerpts are escaped for Markdown")
  assert.match(notice, /\/retry/)
  assert.match(notice, /1 条消息现在继续执行/)
  assert.match(notice, /排队超过 30 分钟的 2 条消息/)
  assert.match(notice, /「很久以前的问题」/)
})

test("queue panel buttons drop entries from memory and from the journal", async () => {
  const path = join(tmp(), "queued-jobs.json")
  const journal = new TelegramJobJournal(path, log)
  const first = job("q1", "一")
  const second = job("q2", "二")
  journal.track(first)
  journal.track(second)
  const pending = new Map<string, Job[]>([["tg:7", [first, second]]])
  const generation = new Map<string, number>()
  const answers: string[] = []
  const deps = { key: "tg:7", answer: async (text?: string) => void answers.push(text ?? ""), pending, generation, journal }

  assert.equal(await handleQueueButton("qdrop:q1", deps), "edit")
  assert.equal(first.dropped, true)
  assert.deepEqual(stored(path).map((entry) => entry.id), ["q2"])
  assert.equal(await handleQueueButton("qdrop:q1", deps), "edit", "already gone: the panel is redrawn")

  assert.equal(await handleQueueButton("qclear", deps), "edit")
  assert.equal(second.dropped, true, "qclear marks pending jobs dropped directly")
  assert.equal(generation.get("tg:7"), undefined, "qclear must not bump generation and abort a running task")
  assert.equal(pending.has("tg:7"), false)
  assert.deepEqual(stored(path), [])
  assert.equal(await handleQueueButton("qclear", deps), "done")
  assert.equal(await handleQueueButton("other", deps), undefined)
  assert.deepEqual(answers, ["已取消第 1 条", "这条消息已开始执行，或已被取消", "已清空 1 条排队消息", "队列已经是空的"])
})

test("App records come back under their old ids with the reason they ended", () => {
  const payload = (id: string): StoredApiTask => ({ id, key: "api:app", text: id, engine: "opencode", createdAt: 1 })
  const { resume, ended, summary } = recoveredTasks(
    {
      resume: [{ id: "t1", state: "queued", queuedAt: 1, payload: payload("t1") }],
      interrupted: [{ id: "t2", state: "running", queuedAt: 1, payload: payload("t2") }],
      expired: [{ id: "t3", state: "queued", queuedAt: 1, payload: payload("t3") }],
    },
    99,
  )
  assert.deepEqual(resume.map((task) => [task.id, task.status]), [["t1", "queued"]])
  assert.deepEqual(ended.map((task) => [task.id, task.status, task.errorCode, task.finishedAt]), [
    ["t2", "failed", "UNKNOWN", 99],
    ["t3", "cancelled", "TASK_CANCELLED", 99],
  ])
  assert.match(ended[0]!.error ?? "", /重试/)
  assert.equal(summary, "1 resumed, 1 interrupted, 1 expired")
})

test("the App task manager resumes a queued task after a restart and the App can still find it", async () => {
  const dir = tmp()
  const now = Date.now()
  const entry = (id: string, state: "queued" | "running", queuedAt: number) => ({
    id,
    state,
    queuedAt,
    payload: { id, key: "api:app", text: `问题 ${id}`, engine: "opencode", autoEngine: false, createdAt: queuedAt },
  })
  writeFileSync(
    join(dir, "app-queued-tasks.json"),
    JSON.stringify({ version: 1, entries: [entry("tRun", "running", now - 5_000), entry("tOld", "queued", now - RESUME_MAX_AGE_MS - 60_000), entry("tNew", "queued", now - 1_000)] }),
  )
  const manager = new ApiTaskManager({
    cfg: {
      dataDir: dir,
      inboxDir: join(dir, "inbox"),
      outboxDir: join(dir, "outbox"),
      maxInputBytes: 0,
      maxMediaBytes: 1024,
      stt: undefined,
      taskTimeoutMs: 60_000,
      opencode: { agent: "assistant" },
    } as never,
    agents: { registry: { get: () => undefined, resolveModel: () => undefined, modelLabel: () => "m", label: () => "OpenCode" } } as never,
    oc: {
      health: async () => true,
      prompt: async () => "回复",
      createSession: async () => "ses-test",
      subscribeSession: () => () => {},
      inputCapabilities: async () => undefined,
      abortSession: async () => {},
    } as never,
    store: new SessionStore(join(dir, "sessions.json"), log) as never,
    log,
    usage: { record: () => {} } as never,
    history: { record: () => {} } as never,
    models: { resolveModel: () => ({ providerID: "p", modelID: "m", label: "m" }) } as never,
    ownerChatId: 42,
    appKey: "api:app",
  })
  assert.equal(manager.get("tRun")?.status, "failed")
  assert.equal(manager.get("tOld")?.status, "cancelled")
  const resumed = manager.get("tNew")
  assert.ok(resumed, "the App's polling finds the task under its old id")
  assert.notEqual(resumed.status, "cancelled")

  for (let i = 0; i < 100 && (resumed.status === "queued" || resumed.status === "running"); i++) {
    await new Promise((done) => setTimeout(done, 20))
  }
  assert.ok(resumed.status === "done" || resumed.status === "failed", `the resumed task ran (${resumed.status})`)
  assert.deepEqual(stored(join(dir, "app-queued-tasks.json")), [], "a settled task leaves the journal")
})
