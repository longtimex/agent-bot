import assert from "node:assert/strict"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { ApiRequestContext } from "../src/apiCore.js"
import { routeTasks, type TaskRouteDeps } from "../src/apiTaskRoutes.js"
import type { ApiTaskManager } from "../src/apiTasks.js"

function makeCtx(method: string, path: string, segments: string[], contentType?: string): ApiRequestContext {
  return {
    req: { headers: contentType ? { "content-type": contentType } : {} } as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://localhost/api/v1${path}`),
    method,
    segments,
    encrypted: false,
  }
}

function makeDeps() {
  const calls: string[] = []
  const responses: Array<{ status: number; body: unknown }> = []
  const tasks = {
    list: (limit: number) => { calls.push(`list:${limit}`); return [] },
    parseAttachments: () => undefined,
    view: (task: unknown) => task,
    submit: (text: string, engine?: string, model?: string) => {
      calls.push(`submit:${text}:${engine ?? ""}:${model ?? ""}`)
      return { id: "t1", text, engine: engine ?? "opencode", model }
    },
    parseMultipartTask: async () => ({ text: "multipart", failed: [] }),
    submitSaved: (text: string, engine?: string, model?: string) => {
      calls.push(`submitSaved:${text}:${engine ?? ""}:${model ?? ""}`)
      return { id: "t2", text, engine: engine ?? "opencode", model }
    },
    get: () => undefined,
    clearQueue: () => { calls.push("clear"); return { cleared: [] } },
    stopAll: () => { calls.push("stopAll"); return { stopped: [] } },
  } as unknown as ApiTaskManager
  const deps: TaskRouteDeps = {
    tasks,
    readJsonBody: async () => ({ text: "hello" }),
    json: (_res, status, body) => { responses.push({ status, body }) },
    expandAlias: (text) => text,
    appKey: "api:app",
  }
  return { deps, calls, responses }
}

test("task routes ignore unrelated resources", async () => {
  const h = makeDeps()
  const handled = await routeTasks(h.deps, makeCtx("GET", "/health", ["health"]), "health", undefined, undefined, [])
  assert.equal(handled, false)
  assert.equal(h.responses.length, 0)
})

test("task routes list tasks with a clamped limit", async () => {
  const h = makeDeps()
  const handled = await routeTasks(h.deps, makeCtx("GET", "/tasks?limit=5", ["tasks"]), "tasks", undefined, undefined, [])
  assert.equal(handled, true)
  assert.deepEqual(h.calls, ["list:5"])
  assert.equal(h.responses[0]?.status, 200)
})

test("task routes submit and retry through the manager", async () => {
  const h = makeDeps()
  const ctx = makeCtx("POST", "/task", ["task"])
  assert.equal(await routeTasks(h.deps, ctx, "task", undefined, undefined, []), true)
  assert.deepEqual(h.calls, ["submit:hello::"])
  assert.equal(h.responses[0]?.status, 202)

  const queue = makeDeps()
  assert.equal(await routeTasks(queue.deps, makeCtx("POST", "/queue/clear", ["queue", "clear"]), "queue", "clear", undefined, []), true)
  assert.deepEqual(queue.calls, ["clear"])
})

test("task routes report a missing task as 404", async () => {
  const h = makeDeps()
  const ctx = makeCtx("GET", "/task/missing", ["task", "missing"])
  await assert.rejects(() => routeTasks(h.deps, ctx, "task", "missing", undefined, []), /任务不存在/)
})

/**
 * POST /task/:id/retry re-reads the inbox copies saved at submit time, and pruning deletes
 * anything older than a day. Reading them used to fail quietly, so the task re-ran without the
 * file the user sent - or with no input at all for an attachments-only prompt.
 */
function makeRetryDeps(source: { text: string; savedAttachments?: Array<{ name: string; mime: string; path: string }> }) {
  const submitted: Array<{ text: string; attachments: unknown }> = []
  const responses: Array<{ status: number; body: unknown }> = []
  const tasks = {
    get: () => ({ id: "t0", key: "api:app", status: "failed", ...source }),
    view: (task: unknown) => task,
    submit: (text: string, _engine?: string, _model?: string, attachments?: unknown) => {
      submitted.push({ text, attachments })
      return { id: "t1" }
    },
    submitSaved: (text: string, _engine?: string, _model?: string, attachments?: unknown) => {
      submitted.push({ text, attachments })
      return { id: "t1" }
    },
    list: () => [],
    parseAttachments: () => undefined,
    clearQueue: () => ({ cleared: [] }),
    stopAll: () => ({ stopped: [] }),
  } as unknown as ApiTaskManager
  const deps: TaskRouteDeps = {
    tasks,
    readJsonBody: async () => ({}),
    json: (_res, status, body) => {
      responses.push({ status, body })
    },
    expandAlias: (text) => text,
    appKey: "api:app",
  }
  return { deps, submitted, responses }
}

test("retrying a text task whose attachment was pruned says so in the prompt", async () => {
  const h = makeRetryDeps({
    text: "看看这张图",
    savedAttachments: [{ name: "gone.png", mime: "image/png", path: join(tmpdir(), "bot-definitely-missing.png") }],
  })
  assert.equal(await routeTasks(h.deps, makeCtx("POST", "/task/t0/retry", ["task", "t0", "retry"]), "task", "t0", "retry", []), true)
  assert.equal(h.submitted.length, 1)
  assert.match(h.submitted[0]!.text, /看看这张图/)
  assert.match(h.submitted[0]!.text, /附件处理失败/)
  assert.equal(h.submitted[0]!.attachments, undefined, "nothing can be re-read from the pruned inbox")
})

test("retrying an attachments-only task after pruning answers 410", async () => {
  const h = makeRetryDeps({
    text: "",
    savedAttachments: [{ name: "gone.png", mime: "image/png", path: join(tmpdir(), "bot-definitely-missing.png") }],
  })
  await assert.rejects(
    () => routeTasks(h.deps, makeCtx("POST", "/task/t0/retry", ["task", "t0", "retry"]), "task", "t0", "retry", []),
    /无法只凭空提示词重试/,
  )
  assert.equal(h.submitted.length, 0, "an empty prompt must never reach an engine")
})

test("multipart task requests route through submitSaved", async () => {
  const h = makeDeps()
  const ctx = makeCtx("POST", "/task", ["task"], "multipart/form-data; boundary=test-boundary")
  assert.equal(await routeTasks(h.deps, ctx, "task", undefined, undefined, []), true)
  assert.deepEqual(h.calls, ["submitSaved:multipart::"])
  assert.equal(h.responses[0]?.status, 202)
})
