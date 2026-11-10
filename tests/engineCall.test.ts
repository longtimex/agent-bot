import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { callEngine, cliAttachmentNotice, resolveOpencodeModel } from "../src/engineCall.js"
import type { EngineCallDeps } from "../src/engineCall.js"
import { OpencodeError } from "../src/opencode.js"
import { SessionStore } from "../src/store.js"

const log = { debug() {}, info() {}, warn() {}, error() {} }

interface FakeOc {
  sessions: string[]
  prompts: Array<{ sessionID: string; text: string; files: unknown[]; model?: unknown }>
  /** When set, the next prompt() rejects with this error (once per entry). */
  failFirstWith?: (sessionID: string) => Error | undefined
}

function makeDeps(overrides: Partial<FakeOc> = {}): { deps: EngineCallDeps; store: SessionStore; fake: FakeOc } {
  const dir = mkdtempSync(join(tmpdir(), "bot-engine-call-"))
  const store = new SessionStore(join(dir, "sessions.json"), log)
  const fake: FakeOc = { sessions: [], prompts: [], ...overrides }
  const oc = {
    createSession: async (title: string) => {
      const id = `ses-${fake.sessions.length + 1}`
      fake.sessions.push(title)
      return id
    },
    subscribeSession: (_id: string, _cb: (status: string) => void) => () => {},
    prompt: async (sessionID: string, text: string, opts: { files?: unknown[]; model?: unknown }) => {
      fake.prompts.push({ sessionID, text, files: opts.files ?? [], model: opts.model })
      const failure = fake.failFirstWith?.(sessionID)
      if (failure) {
        fake.failFirstWith = undefined
        throw failure
      }
      return `回复:${text}`
    },
  }
  const agents = { prompt: async (_key, _engine, text) => `CLI:${text}` }
  const deps: EngineCallDeps = {
    oc: oc as unknown as EngineCallDeps["oc"],
    agents: agents as unknown as EngineCallDeps["agents"],
    store,
    log,
    opencodeAgent: "assistant",
    taskTimeoutMs: 60_000,
    taskMaxTimeoutMs: 60_000,
  }
  return { deps, store, fake }
}

function tempCleanup(deps: EngineCallDeps): void {
  // store 的目录随 tmpdir 回收;这里无需额外动作,保持签名简单
  void deps
}

test("CLI engines route through AgentCliService with the per-session model", async () => {
  const { deps } = makeDeps()
  try {
    const reply = await callEngine(deps, { key: "tg:1", engine: "claude", text: "你好", cliModel: "sonnet" })
    assert.equal(reply, "CLI:你好")
  } finally {
    tempCleanup(deps)
  }
})

test("OpenCode reuses the stored session and passes files", async () => {  const { deps, store, fake } = makeDeps()
  try {
    store.set("tg:1", "ses-existing")
    const files = [{ mime: "image/png", filename: "a.png", path: "/tmp/a.png", size: 0 }]
    const reply = await callEngine(deps, { key: "tg:1", engine: "opencode", text: "看图", files })
    assert.equal(reply, "回复:看图")
    assert.deepEqual(fake.prompts.map((p) => p.sessionID), ["ses-existing"], "no new session when one is stored")
    assert.deepEqual(fake.prompts[0]!.files, files)
  } finally {
    tempCleanup(deps)
  }
})

test("a lost session (404) is recreated transparently and the prompt retried once", async () => {
  const { deps, store, fake } = makeDeps({
    failFirstWith: (sessionID) => new OpencodeError(`session ${sessionID} not found`, 404),
  })
  try {
    store.set("tg:1", "ses-gone")
    const reply = await callEngine(deps, { key: "tg:1", engine: "opencode", text: "再来" })
    assert.equal(reply, "回复:再来")
    assert.equal(fake.prompts.length, 2, "the prompt runs twice: once against the dead session, once against the new one")
    assert.equal(fake.sessions.length, 1, "exactly one replacement session is created")
    assert.equal(store.get("tg:1"), "ses-1", "the store points at the new session")
  } finally {
    tempCleanup(deps)
  }
})

test("non-404 errors surface instead of triggering session recovery", async () => {
  const { deps, store, fake } = makeDeps({
    failFirstWith: () => new OpencodeError("upstream model exploded", 502),
  })
  try {
    store.set("tg:1", "ses-alive")
    await assert.rejects(callEngine(deps, { key: "tg:1", engine: "opencode", text: "hi" }), /upstream/)
    assert.equal(fake.prompts.length, 1, "no blind retry for non-404 failures")
    assert.equal(store.get("tg:1"), "ses-alive", "the stored session survives")
  } finally {
    tempCleanup(deps)
  }
})

test("model resolution only returns a session pick and never invents a default", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-engine-resolve-"))
    try {
      const store = new SessionStore(join(dir, "sessions.json"), log)
      store.set("tg:1", "s")
      store.setModel("tg:1", { providerID: "custom", modelID: "mine", label: "我的模型" })

      const saved = resolveOpencodeModel(store, "tg:1")
      assert.deepEqual({ providerID: saved?.providerID, modelID: saved?.modelID }, { providerID: "custom", modelID: "mine" })

      store.clearModel("tg:1")
      const unset = resolveOpencodeModel(store, "tg:1")
      assert.equal(unset, undefined, "no session pick must stay unset for the engine to decide")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("OpenCode omits model from the request unless one was explicitly selected", async () => {
  const { deps, fake } = makeDeps()
  try {
    await callEngine(deps, { key: "tg:1", engine: "opencode", text: "hi" })
    assert.equal(fake.prompts[0]?.model, undefined)

    await callEngine(deps, {
      key: "tg:1",
      engine: "opencode",
      text: "hi again",
      model: { providerID: "custom", modelID: "chosen", label: "Chosen" },
    })
    assert.deepEqual(fake.prompts[1]?.model, { providerID: "custom", modelID: "chosen" })
  } finally {
    tempCleanup(deps)
  }
})

test("a CLI engine is told that binary attachments did not travel with the prompt", async () => {
  const captured: Array<{ text: string }> = []
  const { deps } = makeDeps()
  ;(deps.agents as unknown as { prompt: (...args: unknown[]) => Promise<string> }).prompt = async (
    _key: string,
    _engine: string,
    text: string,
  ) => {
    captured.push({ text })
    return `CLI:${text.slice(0, 4)}`
  }
  const files = [{ mime: "image/png", filename: "截图.png", path: "/tmp/截图.png", size: 0 }]
  await callEngine(deps, { key: "tg:1", engine: "claude", text: "看图说话", files })

  assert.equal(captured.length, 1)
  assert.match(captured[0]!.text, /^看图说话/)
  assert.match(captured[0]!.text, /截图\.png/)
  assert.match(captured[0]!.text, /OpenCode/)
})

test("the CLI notice is only added when a binary part was actually built", async () => {
  const { deps } = makeDeps()
  const plain = await callEngine(deps, { key: "tg:1", engine: "claude", text: "无附件" })
  assert.equal(plain, "CLI:无附件")
  assert.equal(cliAttachmentNotice([]), undefined)
  assert.equal(cliAttachmentNotice(undefined), undefined)
})
