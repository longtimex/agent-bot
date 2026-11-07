import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ApiError, type ApiRequestContext } from "../src/apiCore.js"
import { ApiTaskManager } from "../src/apiTasks.js"
import { MAX_ATTACH_TOTAL_BYTES } from "../src/attachmentInput.js"
import { SessionStore } from "../src/store.js"

const log = { debug() {}, info() {}, warn() {}, error() {} }

const attachment = { name: "note.txt", mime: "text/plain", data: Buffer.from("附件正文").toString("base64") }

/**
 * submit() validates the engine, the model pin and the queue cap before it commits anything.
 * The pin was checked after #saveAttachments, so a request carrying a bad model name answered
 * 400 while its decoded bytes stayed in the inbox with no task referencing them.
 */
function makeManager(
  dir: string,
  knownModel: string | undefined,
  reply = "回复",
  maxMediaBytes = 1024,
): ApiTaskManager {
  return new ApiTaskManager({
    cfg: {
      dataDir: dir,
      inboxDir: join(dir, "inbox"),
      outboxDir: join(dir, "outbox"),
      maxInputBytes: 10 * 1024 * 1024,
      maxMediaBytes,
      stt: undefined,
      taskTimeoutMs: 60_000,
      opencode: { agent: "assistant", model: { providerID: "custom", modelID: "good-model" } },
    } as never,
    agents: {
      registry: {
        get: () => undefined,
        defaultModel: () => undefined,
        resolveModel: () => undefined,
        modelLabel: () => "m",
        label: () => "OpenCode",
      },
    } as never,
    oc: {
      prompt: async () => reply,
      createSession: async () => "ses-test",
      subscribeSession: () => () => {},
      inputCapabilities: async () => undefined,
      abortSession: async () => {},
    } as never,
    store: new SessionStore(join(dir, "sessions.json"), log) as never,
    log,
    usage: { record: () => {} } as never,
    history: { record: () => {} } as never,
    models: {
      resolveModel: (raw: string) => {
        if (raw !== knownModel) throw new Error(`未识别的模型：${raw}`)
        return { providerID: "custom", modelID: raw, label: raw }
      },
    } as never,
    ownerChatId: 42,
    appKey: "api:app",
  })
}

async function waitForSettled(manager: ApiTaskManager, id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const status = manager.get(id)?.status
    if (status === "done" || status === "failed" || status === "cancelled") return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`task ${id} did not settle`)
}

function responseSink(): { ctx: ApiRequestContext; body: () => Buffer | undefined } {
  let body: Buffer | undefined
  const res = {
    writeHead() {},
    end(data: Buffer) {
      body = Buffer.from(data)
    },
  }
  return {
    ctx: { res } as unknown as ApiRequestContext,
    body: () => body,
  }
}

function inboxFiles(dir: string): string[] {
  const inbox = join(dir, "inbox")
  return existsSync(inbox) ? readdirSync(inbox, { recursive: true }).map(String) : []
}

test("a rejected model pin leaves no attachment behind in the inbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-order-"))
  try {
    const manager = makeManager(dir, "good-model")
    assert.throws(() => manager.submit("正文", "opencode", "bad-model", [attachment]), /未识别的模型/)
    assert.deepEqual(inboxFiles(dir), [], "the 400 must be raised before anything is written")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an accepted model pin still stores the attachment it was given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-order-ok-"))
  try {
    const manager = makeManager(dir, "good-model")
    const task = manager.submit("正文", "opencode", "good-model", [attachment])
    assert.equal(task.status, "queued")
    assert.equal(task.modelRef?.modelID, "good-model")
    assert.equal(task.savedAttachments?.length, 1, "the valid request must keep writing its attachment")
    assert.equal(inboxFiles(dir).length, 1)
    for (let i = 0; i < 50 && manager.get(task.id)?.status === "queued"; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.notEqual(manager.get(task.id)?.status, "queued", "the run started, so the task was really committed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("task media re-checks its local file before serving it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-media-"))
  try {
    const outbox = join(dir, "outbox")
    mkdirSync(outbox, { recursive: true })
    writeFileSync(join(outbox, "pic.png"), "safe")

    const swappedManager = makeManager(dir, "good-model", "[[file: pic.png]]")
    const swappedId = swappedManager.submit("发文件").id
    await waitForSettled(swappedManager, swappedId)
    const secret = join(dir, "secret.txt")
    writeFileSync(secret, "must-not-leak")
    rmSync(join(outbox, "pic.png"))
    symlinkSync(secret, join(outbox, "pic.png"))
    const swapped = responseSink()
    await assert.rejects(
      swappedManager.sendMedia(swapped.ctx, swappedId, 0),
      (err: unknown) => err instanceof ApiError && err.status === 410,
      "a post-run symlink swap must not serve a file outside the outbox",
    )
    assert.equal(swapped.body(), undefined)

    rmSync(join(outbox, "pic.png"))
    writeFileSync(join(outbox, "pic.png"), "safe")
    const grewManager = makeManager(dir, "good-model", "[[file: pic.png]]", 16)
    const grewId = grewManager.submit("发文件").id
    await waitForSettled(grewManager, grewId)
    writeFileSync(join(outbox, "pic.png"), "x".repeat(64))
    await assert.rejects(
      grewManager.sendMedia(responseSink().ctx, grewId, 0),
      (err: unknown) => err instanceof ApiError && err.status === 413,
      "the size limit checked when the reply settles must still hold at download time",
    )

    writeFileSync(join(outbox, "pic.png"), "safe")
    const prunedManager = makeManager(dir, "good-model", "[[file: pic.png]]")
    const prunedId = prunedManager.submit("发文件").id
    await waitForSettled(prunedManager, prunedId)
    rmSync(join(outbox, "pic.png"))
    await assert.rejects(
      prunedManager.sendMedia(responseSink().ctx, prunedId, 0),
      (err: unknown) => err instanceof ApiError && err.status === 410,
      "outbox pruning is a gone resource, not an internal server error",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("attachment parsing counts decoded bytes instead of base64 padding", () => {
  const manager = new ApiTaskManager({ cfg: {} } as never)
  // Each payload is 1 mod 3, so its base64 ends in "==". The old estimate charged
  // two extra bytes per item; four of those extra bytes push a legal 15MB batch over
  // the cap even though the decoded total is three bytes below it.
  const base = Math.floor(MAX_ATTACH_TOTAL_BYTES / 4) - 2
  const sizes = [base, base, base, MAX_ATTACH_TOTAL_BYTES - base * 3 - 3]
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), MAX_ATTACH_TOTAL_BYTES - 3)
  for (const size of sizes.slice(0, 3)) assert.equal(size % 3, 1)
  assert.equal(sizes[3]! % 3, 0)

  const attachments = sizes.map((size, index) => ({
    name: `part-${index}.bin`,
    mime: "application/octet-stream",
    data: Buffer.alloc(size, 0x41).toString("base64"),
  }))
  const parsed = manager.parseAttachments(attachments)
  assert.equal(parsed?.length, 4)
  assert.equal(
    parsed!.reduce((sum, item) => sum + Buffer.from(item.data, "base64").byteLength, 0),
    MAX_ATTACH_TOTAL_BYTES - 3,
  )
})
