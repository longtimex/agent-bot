import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { workspaceChanges } from "./workspaceChanges.js"

export interface WorkspaceRouteDeps {
  appKey: string
  workDir: () => string | undefined
  requireIdle: (what: string) => void
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
}

/** Routes GET /diff, POST /undo and POST /commit for workspace change inspection and git actions. */
export async function routeWorkspace(
  ctx: ApiRequestContext,
  deps: WorkspaceRouteDeps,
  resource: string,
): Promise<void> {
  if (resource === "diff" && ctx.method === "GET") {
    deps.json(ctx.res, 200, workspaceChanges.diff(deps.appKey, deps.workDir()))
    return
  }
  if (resource === "undo" && ctx.method === "POST") {
    deps.requireIdle("撤销改动")
    deps.json(ctx.res, 200, workspaceChanges.undo(deps.appKey))
    return
  }
  if (resource === "commit" && ctx.method === "POST") {
    deps.requireIdle("提交改动")
    const body = await deps.readJsonBody(ctx.req)
    const message = typeof body.message === "string" ? body.message.trim() : ""
    if (!message) throw new ApiError(400, "缺少 message 字段（提交说明）")
    deps.json(ctx.res, 200, workspaceChanges.commit(deps.appKey, message, deps.workDir()))
    return
  }
  throw new ApiError(404, "未知的工作区操作")
}
