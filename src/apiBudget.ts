import { ApiError, type ApiRequestContext } from "./apiCore.js"
import type { UsageStore } from "./usage.js"
import type { UsageBudgetStore } from "./usageBudget.js"
import { formatUsd } from "./tokenUsage.js"

export interface BudgetRouteDeps {
  usage: UsageStore
  budget?: UsageBudgetStore
  timezone: () => string
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
}

function parseLimitField(raw: unknown, label: string): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === "") return null
  const num = typeof raw === "number" ? raw : Number(String(raw).trim())
  if (!Number.isFinite(num) || num < 0 || num > 100_000) {
    throw new ApiError(400, `${label} 必须为 0 ~ 100000 之间的数字（0 表示不限制）`)
  }
  return num === 0 ? null : num
}

/** Routes GET /budget and POST /budget for token/cost budget monitoring and thresholds. */
export async function routeBudget(deps: BudgetRouteDeps, ctx: ApiRequestContext): Promise<void> {
  const budget = deps.budget
  if (!budget) throw new ApiError(503, "费用预算监控尚未初始化")

  if (ctx.method === "GET") {
    deps.json(ctx.res, 200, budget.status(deps.usage, deps.timezone()))
    return
  }

  if (ctx.method === "POST") {
    const body = await deps.readJsonBody(ctx.req)
    const dailyUsd = parseLimitField(body.dailyUsd, "每日预算")
    const monthlyUsd = parseLimitField(body.monthlyUsd, "每月预算")
    if (dailyUsd === undefined && monthlyUsd === undefined) {
      throw new ApiError(400, "请提供 dailyUsd 或 monthlyUsd")
    }
    budget.setLimits({ dailyUsd, monthlyUsd })
    const status = budget.status(deps.usage, deps.timezone())
    const parts: string[] = []
    if (dailyUsd !== undefined) parts.push(dailyUsd ? `每日上限 ${formatUsd(dailyUsd)}` : "已关闭每日上限")
    if (monthlyUsd !== undefined) parts.push(monthlyUsd ? `每月上限 ${formatUsd(monthlyUsd)}` : "已关闭每月上限")
    deps.json(ctx.res, 200, { ok: true, message: `预算已更新（${parts.join("，")}）`, ...status })
    return
  }

  throw new ApiError(405, "Method Not Allowed")
}
