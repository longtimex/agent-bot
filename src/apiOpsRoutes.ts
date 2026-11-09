import { readFileSync } from "node:fs"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { res_attachment_binary } from "./apiHttp.js"
import type { OpsResult, OpsService } from "./ops.js"

export interface OpsRouteDeps {
  ops: OpsService | undefined
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
  runOpsAction: (run: () => Promise<OpsResult>) => Promise<Record<string, unknown>>
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
  if (method === "GET" && id === "check-update") {
    if (!ops) throw new ApiError(409, "当前运行环境不支持运维操作")
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
    deps.json(ctx.res, 200, { result: await deps.runOpsAction(run) })
    return true
  }
  return false
}
