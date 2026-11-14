import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import { ApiError, type ApiRequestContext } from "../src/apiCore.js"
import { ApiTaskManager } from "../src/apiTasks.js"
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
      maxInputBytes: 0,
      maxMediaBytes,
      stt: undefined,
      taskTimeoutMs: 60_000,
      opencode: { agent: "assistant" },
    } as never,
    agents: {
      registry: {
        get: () => undefined,
        resolveModel: () => undefined,
        modelLabel: () => "m",
        label: () => "OpenCode",
      },
    } as never,
    oc: {
      health: async () => true,
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

function makeFallbackManager(
  dir: string,
  options: { healthy: boolean; explicitEngine?: string; installed?: string[]; fail?: boolean; storedModel?: boolean; gate?: Promise<void> },
): ApiTaskManager {
  const logs: string[] = []
  const installed = options.installed ?? ["codex"]
  const prompted: string[] = []
  const store = new SessionStore(join(dir, "sessions.json"), log)
  if (options.explicitEngine) store.setEngine("api:app", options.explicitEngine)
  if (options.storedModel) store.setModel("api:app", { providerID: "custom", modelID: "old", label: "Old" })
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
    agents: {
      registry: {
        get: (id: string) => (installed.includes(id) ? { id, label: id } : undefined),
        resolveModel: () => undefined,
        modelLabel: (id: string) => id,
        label: (id: string) => id,
        list: () => [
          { id: "codex", label: "Codex CLI", bin: "codex" },
          { id: "claude", label: "Claude Code", bin: "claude" },
        ],
        binPath: (profile: { id: string }) => (installed.includes(profile.id) ? `/usr/bin/${profile.id}` : undefined),
      },
      prompt: async (key: string, engine: string) => {
        prompted.push(engine)
        if (options.fail) throw new Error("CLI 退出错误 (代码 2): unexpected argument '-C'")
        return `ok from ${engine}`
      },
    } as never,
    oc: {
      health: async () => options.healthy,
      prompt: async () => {
        if (options.gate) await options.gate
        prompted.push("opencode")
        return "ok from opencode"
      },
      createSession: async () => "ses-health",
      subscribeSession: () => () => {},
      inputCapabilities: async () => undefined,
      abortSession: async () => {},
    } as never,
    store: store as never,
    log: { debug() {}, info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error() {} },
    usage: { record: () => {} } as never,
    history: { record: () => {} } as never,
    models: { resolveModel: () => { throw new Error("not used") } } as never,
    ownerChatId: 42,
    appKey: "api:app",
  })
  return Object.assign(manager, { logs, prompted })
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
    await assert.rejects(manager.submit("正文", "opencode", "bad-model", [attachment]), /未识别的模型/)
    assert.deepEqual(inboxFiles(dir), [], "the 400 must be raised before anything is written")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an accepted model pin still stores the attachment it was given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-order-ok-"))
  try {
    const manager = makeManager(dir, "good-model")
    const task = await manager.submit("正文", "opencode", "good-model", [attachment])
    assert.ok(task.status === "queued" || task.status === "running", `task was committed (${task.status})`)
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

test("a CLI model alias is stored as the catalogue's canonical id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-canonical-"))
  try {
    const store = new SessionStore(join(dir, "sessions.json"), log)
    store.setEngine("api:app", "demo")
    const seen: string[] = []
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
      agents: {
        registry: {
          get: () => ({ id: "demo", label: "Demo CLI", supportsModel: true }),
          resolveModel: () => undefined,
          modelLabel: () => "DeepSeek",
          label: () => "Demo CLI",
        },
        prompt: async (_key: string, _engine: string, _text: string, model?: string) => {
          seen.push(model ?? "")
          return "ok"
        },
      } as never,
      oc: { health: async () => true } as never,
      store: store as never,
      log,
      usage: { record: () => {} } as never,
      history: { record: () => {} } as never,
      models: { resolveModel: () => { throw new Error("not used") } } as never,
      agentModels: {
        list: async () => ({ models: [{ id: "DeepSeek-V4", label: "DeepSeek V4" }], source: "probe" }),
        resolve: (_engine: string, raw: string) => (raw.toLowerCase() === "deepseek" ? "DeepSeek-V4" : undefined),
      } as never,
      ownerChatId: 42,
      appKey: "api:app",
    })

    const task = await manager.submit("你好", "demo", "deepseek")
    assert.equal(task.model, "DeepSeek-V4", "the raw alias must not reach the CLI")
    await waitForSettled(manager, task.id)
    assert.deepEqual(seen, ["DeepSeek-V4"])
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
    const swappedId = (await swappedManager.submit("发文件")).id
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
    const grewId = (await grewManager.submit("发文件")).id
    await waitForSettled(grewManager, grewId)
    writeFileSync(join(outbox, "pic.png"), "x".repeat(64))
    await assert.rejects(
      grewManager.sendMedia(responseSink().ctx, grewId, 0),
      (err: unknown) => err instanceof ApiError && err.status === 413,
      "the size limit checked when the reply settles must still hold at download time",
    )

    writeFileSync(join(outbox, "pic.png"), "safe")
    const prunedManager = makeManager(dir, "good-model", "[[file: pic.png]]")
    const prunedId = (await prunedManager.submit("发文件")).id
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

test("attachment parsing accepts every file and no longer enforces an aggregate byte cap", () => {
  const manager = new ApiTaskManager({ cfg: {} } as never)
  const size = 4 * 1024 * 1024
  const attachments = Array.from({ length: 4 }, (_, index) => ({
    name: `part-${index}.bin`,
    mime: "application/octet-stream",
    data: Buffer.alloc(size, 0x41).toString("base64"),
  }))
  const parsed = manager.parseAttachments(attachments)
  assert.equal(parsed?.length, 4)
  assert.equal(
    parsed!.reduce((sum, item) => sum + Buffer.from(item.data, "base64").byteLength, 0),
    size * 4,
  )
})

test("attachment parsing still caps a message at four files", () => {
  const manager = new ApiTaskManager({ cfg: {} } as never)
  const attachments = Array.from({ length: 5 }, (_, index) => ({
    name: `part-${index}.bin`,
    mime: "application/octet-stream",
    data: Buffer.from("x").toString("base64"),
  }))
  assert.throws(() => manager.parseAttachments(attachments), /附件最多 4 个/)
})

test("an unset engine falls back from a dead OpenCode to an installed CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-fallback-"))
  try {
    const manager = makeFallbackManager(dir, { healthy: false }) as ApiTaskManager & { logs: string[]; prompted: string[] }
    const task = await manager.submit("你好")
    await waitForSettled(manager, task.id)
    const settled = manager.get(task.id)!
    assert.equal(settled.status, "done")
    assert.equal(settled.engine, "codex")
    assert.match(settled.engineNote ?? "", /OpenCode 未运行/)
    assert.deepEqual(manager.prompted, ["codex"], "the implicit OpenCode default was skipped")
    assert.equal(manager.view(settled).engineNote, settled.engineNote)
    assert.equal(new SessionStore(join(dir, "sessions.json"), log).getExplicitEngine("api:app"), undefined, "fallback must not be persisted")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a saved OpenCode model alone still allows the implicit default to fall back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-fallback-model-"))
  try {
    const manager = makeFallbackManager(dir, { healthy: false, storedModel: true }) as ApiTaskManager & {
      logs: string[]
      prompted: string[]
    }
    const task = await manager.submit("你好")
    await waitForSettled(manager, task.id)
    const settled = manager.get(task.id)!
    assert.equal(settled.status, "done")
    assert.equal(settled.engine, "codex")
    assert.match(settled.engineNote ?? "", /OpenCode 未运行/)
    assert.deepEqual(manager.prompted, ["codex"], "a model preference is not an engine choice")
    assert.equal(
      new SessionStore(join(dir, "sessions.json"), log).getExplicitEngine("api:app"),
      undefined,
      "falling back must still not persist an engine choice",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an explicitly selected OpenCode is never silently replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-explicit-"))
  try {
    const manager = makeFallbackManager(dir, { healthy: false, explicitEngine: "opencode" }) as ApiTaskManager & { prompted: string[] }
    const task = await manager.submit("你好")
    await waitForSettled(manager, task.id)
    assert.equal(manager.get(task.id)?.engine, "opencode")
    assert.deepEqual(manager.prompted, ["opencode"], "the explicit choice must be attempted")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("cancelling a queued task records an error code and a terminal log line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-queue-cancel-"))
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const manager = makeFallbackManager(dir, { healthy: true, gate }) as ApiTaskManager & { logs: string[] }
    const first = await manager.submit("第一条")
    // Hold the first run so the second stays queued regardless of scheduler timing.
    for (let i = 0; i < 100 && manager.get(first.id)?.status !== "running"; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(manager.get(first.id)?.status, "running")
    const second = await manager.submit("第二条")
    const cleared = manager.clearQueue()
    assert.deepEqual(cleared.cleared, [second.id])
    const cancelled = manager.get(second.id)!
    assert.equal(cancelled.status, "cancelled")
    assert.equal(cancelled.errorCode, "TASK_CANCELLED")
    assert.ok(cancelled.finishedAt, "a cancelled queued task must carry a finish time")
    const line = manager.logs.find((entry) => entry.includes(`task=${second.id}`))
    assert.ok(line, "a queued cancellation must write a terminal line")
    assert.match(line!, /outcome=cancelled/)
    assert.match(line!, /reason=TASK_CANCELLED/)
    assert.doesNotMatch(line!, /第二条/, "the prompt must not be logged")
    release()
    await waitForSettled(manager, first.id)
  } finally {
    release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("terminal task logs carry stable fields and a classified failure code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-log-"))
  try {
    const manager = makeFallbackManager(dir, { healthy: false, fail: true }) as ApiTaskManager & { logs: string[] }
    const task = await manager.submit("触发失败")
    await waitForSettled(manager, task.id)
    const settled = manager.get(task.id)!
    assert.equal(settled.status, "failed")
    assert.equal(settled.errorCode, "CLI_ARGUMENT_INVALID")
    const line = manager.logs.find((entry) => entry.includes(`task=${task.id}`))
    assert.ok(line, "a terminal line must be written")
    assert.match(line!, /engine=codex/)
    assert.match(line!, /outcome=failed/)
    assert.match(line!, /durationMs=\d+/)
    assert.match(line!, /reason=CLI_ARGUMENT_INVALID/)
    assert.doesNotMatch(line!, /触发失败/, "the prompt must not be logged")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function multipartBody(boundary: string, files: Array<{ name: string; mime: string; data: Buffer }>, text = "请分析"): Buffer {
  const chunks: Buffer[] = []
  for (const [key, value] of [["text", text]] as const) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  files.forEach((file, index) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file${index}"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
    )
    chunks.push(file.data)
    chunks.push(Buffer.from("\r\n"))
  })
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function multipartRequest(body: Buffer): IncomingMessage {
  return Readable.from([body]) as unknown as IncomingMessage
}

test("multipart uploads are written to the inbox without retaining the bytes in the task record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-multipart-"))
  try {
    const manager = new ApiTaskManager({
      cfg: { inboxDir: join(dir, "inbox"), dataDir: dir } as never,
      ownerChatId: 42,
      store: { getExplicitEngine: () => undefined } as never,
    } as never)
    const boundary = "agentbot-boundary"
    const payload = Buffer.from("a video payload")
    const result = await manager.parseMultipartTask(
      multipartRequest(multipartBody(boundary, [{ name: "clip.mp4", mime: "video/mp4", data: payload }])),
      boundary,
    )
    assert.equal(result.text, "请分析")
    assert.equal(result.attachments?.length, 1)
    assert.equal(result.attachments?.[0]?.kind, "video")
    assert.deepEqual(readFileSync(result.attachments![0]!.path), payload)
    assert.equal(result.attachments?.[0]?.bytes, payload.byteLength)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an over-limit multipart batch is rejected and its saved files are removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-multipart-limit-"))
  try {
    const manager = new ApiTaskManager({
      cfg: { inboxDir: join(dir, "inbox"), dataDir: dir } as never,
      ownerChatId: 42,
      store: { getExplicitEngine: () => undefined } as never,
    } as never)
    const boundary = "agentbot-boundary"
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `file-${index}.bin`,
      mime: "application/octet-stream",
      data: Buffer.from(`payload-${index}`),
    }))
    await assert.rejects(
      () => manager.parseMultipartTask(multipartRequest(multipartBody(boundary, files)), boundary),
      /附件最多 4 个/,
    )
    assert.deepEqual(inboxFiles(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test("a failed API task persists its error code and redacted detail in history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-task-history-error-"))
  const records: Array<{ key: string; input: Record<string, unknown> }> = []
  try {
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const manager = new ApiTaskManager({
      cfg: {
        dataDir: dir,
        inboxDir: join(dir, "inbox"),
        outboxDir: join(dir, "outbox"),
        maxMediaBytes: 1024,
        stt: undefined,
        taskTimeoutMs: 60_000,
        opencode: { agent: "assistant" },
      } as never,
      agents: {
        registry: {
          get: (id: string) => (id === "codex" ? { id, label: "Codex" } : undefined),
          resolveModel: () => undefined,
          modelLabel: (id: string) => id,
          label: (id: string) => id,
          list: () => [{ id: "codex", label: "Codex", bin: "codex" }],
          binPath: () => "/usr/bin/codex",
        },
        prompt: async () => {
          throw new Error("CLI 退出错误 (代码 2): unexpected argument '-C' api_key=SECRET123")
        },
      } as never,
      oc: { health: async () => false } as never,
      store: store as never,
      log,
      usage: { record: () => {} } as never,
      history: { record: (key: string, input: Record<string, unknown>) => records.push({ key, input }) } as never,
      models: { resolveModel: () => { throw new Error("not used") } } as never,
      ownerChatId: 42,
      appKey: "api:app",
    })
    const task = await manager.submit("失败任务")
    await waitForSettled(manager, task.id)
    const settled = manager.get(task.id)!
    assert.equal(settled.status, "failed")
    assert.equal(settled.errorCode, "CLI_ARGUMENT_INVALID")
    const history = records.find((entry) => entry.key === "api:app")?.input
    assert.equal(history?.errorCode, "CLI_ARGUMENT_INVALID")
    assert.match(String(history?.detail), /unexpected argument/)
    assert.doesNotMatch(String(history?.detail), /SECRET123/, "history must not persist credentials")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
