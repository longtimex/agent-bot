import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ApiTaskManager } from "../src/apiTasks.js"
import { SessionStore } from "../src/store.js"

const log = { debug() {}, info() {}, warn() {}, error() {} }

const attachment = { name: "note.txt", mime: "text/plain", data: Buffer.from("附件正文").toString("base64") }

/**
 * submit() validates the engine, the model pin and the queue cap before it commits anything.
 * The pin was checked after #saveAttachments, so a request carrying a bad model name answered
 * 400 while its decoded bytes stayed in the inbox with no task referencing them.
 */
function makeManager(dir: string, knownModel: string | undefined): ApiTaskManager {
  return new ApiTaskManager({
    cfg: {
      dataDir: dir,
      inboxDir: join(dir, "inbox"),
      maxInputBytes: 10 * 1024 * 1024,
      stt: undefined,
      taskTimeoutMs: 60_000,
    } as never,
    oc: {
      prompt: async () => "回复",
      createSession: async () => "ses-test",
      subscribeSession: () => () => {},
      inputCapabilities: async () => undefined,
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
