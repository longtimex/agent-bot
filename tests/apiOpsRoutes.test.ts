import assert from "node:assert/strict"
import type { IncomingMessage, ServerResponse } from "node:http"
import test from "node:test"
import type { ApiRequestContext } from "../src/apiCore.js"
import { OpsActionJobs, routeOps, type OpsRouteDeps } from "../src/apiOpsRoutes.js"
import type { OpsResult, OpsService } from "../src/ops.js"

function makeCtx(method: string, path: string, segments: string[]): ApiRequestContext {
  return {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://localhost/api/v1${path}`),
    method,
    segments,
    encrypted: false,
  }
}

function makeDeps() {
  const responses: Array<{ status: number; body: unknown }> = []
  const asyncOps = new OpsActionJobs()
  const ops = {} as OpsService
  const deps: OpsRouteDeps = {
    ops,
    json: (_res, status, body) => responses.push({ status, body }),
    runOpsAction: async (run) => {
      const result = await run()
      return { ok: result.ok, message: result.message, steps: result.steps }
    },
    asyncOps,
    hasActiveTask: () => false,
  }
  return { deps, responses, asyncOps }
}

function okResult(): OpsResult {
  return { ok: true, message: "完成", steps: [] }
}

test("async ops returns an id before the command finishes, then serves its result", async () => {
  const h = makeDeps()
  let finish = (): void => {}
  h.deps.ops = {
    runCheck: () => new Promise<OpsResult>((resolve) => {
      finish = () => resolve(okResult())
    }),
  } as OpsService

  assert.equal(await routeOps(h.deps, makeCtx("POST", "/ops/check?async=1", ["ops", "check"]), "check", undefined), true)
  const started = h.responses[0]?.body as { job: { id: string; state: string } }
  assert.equal(h.responses[0]?.status, 202)
  assert.equal(started.job.state, "running")

  assert.equal(
    await routeOps(h.deps, makeCtx("GET", `/ops/actions/${started.job.id}`, ["ops", "actions", started.job.id]), "actions", started.job.id),
    true,
  )
  const running = h.responses[1]?.body as { job: { state: string } }
  assert.equal(running.job.state, "running")

  finish()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    await routeOps(h.deps, makeCtx("GET", `/ops/actions/${started.job.id}`, ["ops", "actions", started.job.id]), "actions", started.job.id),
    true,
  )
  const finished = h.responses[2]?.body as { job: { result: { ok: boolean } } }
  assert.equal(finished.job.result.ok, true)
})

test("async ops keeps the synchronous response for existing clients", async () => {
  const h = makeDeps()
  h.deps.ops = { runCheck: async () => okResult() } as OpsService
  await routeOps(h.deps, makeCtx("POST", "/ops/check", ["ops", "check"]), "check", undefined)
  assert.equal(h.responses[0]?.status, 200)
  assert.deepEqual(h.responses[0]?.body, { result: { ok: true, message: "完成", steps: [] } })
})

test("async ops refuses a second concurrent action", async () => {
  const h = makeDeps()
  let finish = (): void => {}
  h.deps.ops = {
    runCheck: () => new Promise<OpsResult>((resolve) => {
      finish = () => resolve(okResult())
    }),
    startOpencode: async () => okResult(),
  } as OpsService
  await routeOps(h.deps, makeCtx("POST", "/ops/check?async=1", ["ops", "check"]), "check", undefined)
  await assert.rejects(
    () => routeOps(h.deps, makeCtx("POST", "/ops/service/start?async=1", ["ops", "service", "start"]), "service", "start"),
    /已有运维操作/,
  )
  finish()
})

test("async ops reports a missing job as 404", async () => {
  const h = makeDeps()
  await assert.rejects(
    () => routeOps(h.deps, makeCtx("GET", "/ops/actions/missing", ["ops", "actions", "missing"]), "actions", "missing"),
    /不存在|过期/,
  )
})
