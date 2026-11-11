import { readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { res_attachment_binary } from "./apiHttp.js"
import type { OpsResult, OpsService } from "./ops.js"

export interface OpsActionJob {
  id: string
  label: string
  state: "running" | "done"
  result?: Record<string, unknown>
}

/** In-memory, like the one-at-a-time guard it replaces: a restart ends a job anyway. */
export class OpsActionJobs {
  readonly #jobs = new Map<string, OpsActionJob>()
  #lastTicket?: { label: string; id: string }

  start(label: string, run: () => Promise<Record<string, unknown>>): OpsActionJob {
    if ([...this.#jobs.values()].some((job) => job.state === "running")) {
      throw new ApiError(409, "已有运维操作在执行，请稍后再试")
    }
    const job: OpsActionJob = { id: randomBytes(8).toString("hex"), label, state: "running" }
    this.#jobs.set(job.id, job)
    this.#lastTicket = { label, id: job.id }
    void run().then(
      (result) => Object.assign(job, { state: "done" as const, result }),
      (err: unknown) => Object.assign(job, {
        state: "done" as const,
        result: {
          ok: false,
          message: err instanceof Error ? err.message : "运维操作失败",
          steps: [],
        },
      }),
    )
    // Keep enough recent results for a phone to reconnect; bound memory without a timer.
    for (const old of [...this.#jobs.values()].filter((item) => item.state === "done").slice(0, -8)) {
      this.#jobs.delete(old.id)
    }
    return job
  }

  get(id: string): OpsActionJob | undefined {
    return this.#jobs.get(id)
  }

  /** The latest matching job, so a client that lost the first response can reconnect. */
  latest(label: string): OpsActionJob | undefined {
    return this.#lastTicket?.label === label ? this.#jobs.get(this.#lastTicket.id) : undefined
  }
}

export interface OpsRouteDeps {
  ops: OpsService | undefined
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
  runOpsAction: (run: () => Promise<OpsResult>) => Promise<Record<string, unknown>>
  asyncOps: OpsActionJobs
  hasActiveTask: () => boolean
}

/** Returns true when the /ops route handled the request. */
export async function routeOps(
  deps: OpsRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<boolean> {
  const { method } = ctx
  const ops = deps.ops

  if (method === "GET" && id === "diag") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维诊断")
    deps.json(ctx.res, 200, { diagnostics: await ops.diagnostics() })
    return true
  }
  if (method === "GET" && id === "service") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持服务管理")
    deps.json(ctx.res, 200, { service: await ops.opencodeStatus() })
    return true
  }
  if (method === "GET" && id === "actions" && action) {
    if (action === "latest" && !ctx.url.searchParams.get("label")) throw new ApiError(400, "缺少 label 参数")
    const job = action === "latest" ? deps.asyncOps.latest(ctx.url.searchParams.get("label") ?? "") : deps.asyncOps.get(action)
    if (!job) throw new ApiError(404, "运维任务不存在或已过期")
    deps.json(ctx.res, 200, { job: { id: job.id, label: job.label, state: job.state, result: job.result } })
    return true
  }
  if (method === "GET" && id === "check-update") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
    if (ctx.url.searchParams.get("async") === "1") {
      const job = deps.asyncOps.start("check-update", () => deps.runOpsAction(() => ops.checkUpdate()))
      deps.json(ctx.res, 202, { job: { id: job.id, label: job.label, state: job.state } })
      return true
    }
    deps.json(ctx.res, 200, { result: await ops.checkUpdate() })
    return true
  }
  if (method === "GET" && id === "release") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
    // This endpoint only needs the release pointers and the last self-check. It is
    // polled by the App while an update is pending, so skip the full diagnostics
    // probe (git/opencode/cc-switch/statfs) that `GET /ops/diag` already pays for.
    if (ops.releaseOverview) {
      deps.json(ctx.res, 200, await ops.releaseOverview())
      return true
    }
    const diagnostics = await ops.diagnostics()
    deps.json(ctx.res, 200, {
      release: diagnostics.release ?? null,
      update: diagnostics.update ?? null,
      startup: diagnostics.startup ?? null,
      lastBackupAt: diagnostics.lastBackupAt ?? 0,
    })
    return true
  }
  if (method === "GET" && id === "backup") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
    const result = await ops.backupData()
    if (!result.ok || !result.file) throw new ApiError(500, result.message)
    const file = result.file.split("/").pop() ?? "backup.tar.gz"
    res_attachment_binary(ctx.res, file, "application/gzip", readFileSync(result.file))
    return true
  }
  if (method === "GET" && id === "logs") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持日志查看")
    const source = ctx.url.searchParams.get("source") === "opencode" ? "opencode" : "bot"
    const rawLines = Number(ctx.url.searchParams.get("lines") ?? 80)
    const lines = Math.min(400, Math.max(10, Number.isFinite(rawLines) ? Math.floor(rawLines) : 80))
    deps.json(ctx.res, 200, ops.tailLogs(source, lines))
    return true
  }
  if (method === "POST" && id) {
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
    const serviceActions: Record<string, () => Promise<OpsResult>> = {
      start: () => ops.startOpencode(),
      stop: () => ops.stopOpencode(),
      restart: () => ops.restartOpencode(),
    }
    let run: (() => Promise<OpsResult>) | undefined
    if (id === "update") {
      if (deps.hasActiveTask()) throw new ApiError(409, "当前有任务正在执行，请先停止任务再更新。")
      run = () => ops.updateProject()
    } else if (id === "check") run = () => ops.runCheck()
    else if (id === "restart") {
      if (deps.hasActiveTask()) throw new ApiError(409, "当前有任务正在执行，请先停止任务再重启。")
      run = () => ops.restartBot()
    } else if (id === "rollback") {
      if (deps.hasActiveTask()) throw new ApiError(409, "当前有任务正在执行，请先停止任务再回滚。")
      run = async () => ops.rollbackRelease()
    } else if (id === "cancel-pending") {
      if (deps.hasActiveTask()) throw new ApiError(409, "当前有任务正在执行，请先停止任务再丢弃 pending。")
      run = async () => ops.cancelPendingRelease()
    }
    else if (id === "cc") run = () => ops.installCcSwitch(false)
    else if (id === "cc-update") run = () => ops.installCcSwitch(true)
    else if (id === "service" && action && Object.hasOwn(serviceActions, action)) run = serviceActions[action]
    if (!run) throw new ApiError(404, "未知的运维操作")
    const label = id === "service" && action ? `service/${action}` : id
    // Long commands outlive reverse proxies (the hosted Instabox tunnel cuts at ~20s).
    // Report an id immediately; old clients still get the synchronous result below.
    if (ctx.url.searchParams.get("async") === "1") {
      const job = deps.asyncOps.start(label, () => deps.runOpsAction(run!))
      deps.json(ctx.res, 202, { job: { id: job.id, label: job.label, state: job.state } })
      return true
    }
    deps.json(ctx.res, 200, { result: await deps.runOpsAction(run) })
    return true
  }
  return false
}
