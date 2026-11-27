import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { parseApprovalMode, type ApprovalDecision, type ApprovalManager } from "./approvals.js"

export interface ApprovalRouteDeps {
  approvals: ApprovalManager
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
}

function parseDecision(raw: unknown): ApprovalDecision | undefined {
  if (raw === "once" || raw === "always" || raw === "reject") return raw
  return undefined
}

/** Routes GET /approvals, PUT /approvals/mode, and POST /approvals/:id/decide. */
export async function routeApprovals(
  deps: ApprovalRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const { approvals } = deps

  if (!id && ctx.method === "GET") {
    deps.json(ctx.res, 200, { mode: approvals.mode, pending: approvals.listPending() })
    return
  }

  if (id === "mode" && (ctx.method === "PUT" || ctx.method === "POST")) {
    const body = await deps.readJsonBody(ctx.req)
    const mode = parseApprovalMode(body.mode)
    if (!mode) throw new ApiError(400, "审批模式必须是 auto、strict 或 off")
    approvals.setMode(mode)
    const label = mode === "strict" ? "严格模式" : mode === "off" ? "已关闭" : "自动高危防护"
    deps.json(ctx.res, 200, {
      ok: true,
      message: `高危审批模式已切换为「${label}」`,
      mode: approvals.mode,
      pending: approvals.listPending(),
    })
    return
  }

  if (id && action === "decide" && ctx.method === "POST") {
    const body = await deps.readJsonBody(ctx.req)
    const decision = parseDecision(body.decision)
    if (!decision) throw new ApiError(400, "decision 必须是 once、always 或 reject")
    const result = approvals.decide(id, decision)
    if (!result.ok) throw new ApiError(404, result.message)
    deps.json(ctx.res, 200, {
      ok: true,
      message: result.message,
      mode: approvals.mode,
      pending: approvals.listPending(),
    })
    return
  }

  throw new ApiError(404, "未知的审批接口")
}
