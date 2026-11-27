import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import { formatTokens, formatUsd, roundUsd } from "./tokenUsage.js"
import { dateKey, type UsageStore } from "./usage.js"

export type BudgetAlertLevel = "ok" | "warn" | "exceeded"

export interface BudgetStatus {
  dailyUsd: number
  monthlyUsd: number
  todayUsd: number
  monthUsd: number
  todayTokens: number
  monthTokens: number
  dailyPercent: number
  monthlyPercent: number
  alertLevel: BudgetAlertLevel
}

interface AlertMark {
  period: string
  level: "warn" | "exceeded"
}

interface BudgetFile {
  dailyUsd?: number
  monthlyUsd?: number
  lastDailyAlert?: AlertMark
  lastMonthlyAlert?: AlertMark
}

function nonNegNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return roundUsd(value)
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n) && n >= 0) return roundUsd(n)
  }
  return undefined
}

const WARN_RATIO = 0.8

/**
 * Tracks daily/monthly USD spend caps and emits at most one warning (80%) and
 * one exceeded (100%) notification per period across Telegram/Feishu and the App.
 */
export class UsageBudgetStore {
  readonly #path: string
  readonly #log: Logger
  #data: BudgetFile = {}

  constructor(path: string, log: Logger, env: NodeJS.ProcessEnv = process.env) {
    this.#path = path
    this.#log = log
    this.#load(env)
  }

  get dailyUsd(): number {
    return this.#data.dailyUsd ?? 0
  }

  get monthlyUsd(): number {
    return this.#data.monthlyUsd ?? 0
  }

  setLimits(limits: { dailyUsd?: number | null; monthlyUsd?: number | null }): void {
    if (limits.dailyUsd !== undefined) {
      // Persist explicit 0 (disabled) so restarting does not rebound to .env defaults.
      const next = limits.dailyUsd === null ? 0 : Math.max(0, roundUsd(limits.dailyUsd))
      this.#data.dailyUsd = next
      // Reset today's dedup marker if the user raised or changed the cap
      delete this.#data.lastDailyAlert
    }
    if (limits.monthlyUsd !== undefined) {
      const next = limits.monthlyUsd === null ? 0 : Math.max(0, roundUsd(limits.monthlyUsd))
      this.#data.monthlyUsd = next
      delete this.#data.lastMonthlyAlert
    }
    this.#save()
  }

  status(usage: UsageStore, timeZone: string, now = Date.now()): BudgetStatus {
    const today = dateKey(now, timeZone)
    const monthPrefix = today.slice(0, 7)

    const todayRows = usage.dayTotalsByChat(0, now)
    let todayUsd = 0
    let todayTokens = 0
    for (const row of todayRows) {
      todayUsd += row.usage.costUsd ?? 0
      todayTokens += (row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0)
    }

    const recent = usage.aggregateRecentDays(31, now)
    let monthUsd = 0
    let monthTokens = 0
    for (const day of recent) {
      if (!day.day.startsWith(monthPrefix)) continue
      monthUsd += day.costUsd ?? 0
      monthTokens += (day.inputTokens ?? 0) + (day.outputTokens ?? 0)
    }

    todayUsd = roundUsd(todayUsd)
    monthUsd = roundUsd(monthUsd)
    const dailyLimit = this.dailyUsd
    const monthlyLimit = this.monthlyUsd
    const dailyPercent = dailyLimit > 0 ? Math.round((todayUsd / dailyLimit) * 100) : 0
    const monthlyPercent = monthlyLimit > 0 ? Math.round((monthUsd / monthlyLimit) * 100) : 0

    let alertLevel: BudgetAlertLevel = "ok"
    if (
      (dailyLimit > 0 && todayUsd >= dailyLimit) ||
      (monthlyLimit > 0 && monthUsd >= monthlyLimit)
    ) {
      alertLevel = "exceeded"
    } else if (
      (dailyLimit > 0 && todayUsd >= dailyLimit * WARN_RATIO) ||
      (monthlyLimit > 0 && monthUsd >= monthlyLimit * WARN_RATIO)
    ) {
      alertLevel = "warn"
    }

    return {
      dailyUsd: dailyLimit,
      monthlyUsd: monthlyLimit,
      todayUsd,
      monthUsd,
      todayTokens,
      monthTokens,
      dailyPercent,
      monthlyPercent,
      alertLevel,
    }
  }

  /** Evaluates thresholds and returns an alert notice string only when a new threshold is crossed. */
  checkAndConsumeAlert(usage: UsageStore, timeZone: string, now = Date.now()): string | undefined {
    const st = this.status(usage, timeZone, now)
    const today = dateKey(now, timeZone)
    const month = today.slice(0, 7)
    const alerts: string[] = []
    let dirty = false

    const evaluate = (
      kind: "每日" | "每月",
      period: string,
      spent: number,
      limit: number,
      pct: number,
      prev: AlertMark | undefined,
    ): AlertMark | undefined => {
      if (limit <= 0) return prev
      const level: "warn" | "exceeded" | undefined =
        spent >= limit ? "exceeded" : spent >= limit * WARN_RATIO ? "warn" : undefined
      if (!level) return prev
      const alreadySent =
        prev?.period === period && (prev.level === level || (prev.level === "exceeded" && level === "warn"))
      if (alreadySent) return prev
      const icon = level === "exceeded" ? "🚨" : "⚠️"
      const state = level === "exceeded" ? "已超过上限" : "已达到 80% 预警线"
      alerts.push(`${icon} ${kind}费用预算${state}：${formatUsd(spent)} / ${formatUsd(limit)}（${pct}%）`)
      dirty = true
      return { period, level }
    }

    this.#data.lastDailyAlert = evaluate("每日", today, st.todayUsd, st.dailyUsd, st.dailyPercent, this.#data.lastDailyAlert)
    this.#data.lastMonthlyAlert = evaluate("每月", month, st.monthUsd, st.monthlyUsd, st.monthlyPercent, this.#data.lastMonthlyAlert)

    if (dirty) this.#save()
    if (alerts.length === 0) return undefined
    return (
      `💸 费用预算告警\n\n` +
      alerts.join("\n") +
      `\n今日累计 Token：${formatTokens(st.todayTokens)} · 本月累计：${formatTokens(st.monthTokens)}\n` +
      `发送 /budget 可查看或调整预算阈值。`
    )
  }

  #load(env: NodeJS.ProcessEnv): void {
    const parsed = readJsonObject(this.#path, (msg) => this.#log.warn(msg)) as BudgetFile | undefined
    if (parsed) {
      const daily = nonNegNumber(parsed.dailyUsd)
      const monthly = nonNegNumber(parsed.monthlyUsd)
      if (daily !== undefined) this.#data.dailyUsd = daily
      if (monthly !== undefined) this.#data.monthlyUsd = monthly
      if (parsed.lastDailyAlert?.period && (parsed.lastDailyAlert.level === "warn" || parsed.lastDailyAlert.level === "exceeded")) {
        this.#data.lastDailyAlert = parsed.lastDailyAlert
      }
      if (parsed.lastMonthlyAlert?.period && (parsed.lastMonthlyAlert.level === "warn" || parsed.lastMonthlyAlert.level === "exceeded")) {
        this.#data.lastMonthlyAlert = parsed.lastMonthlyAlert
      }
    }
    if (this.#data.dailyUsd === undefined) {
      const envDaily = nonNegNumber(env.USAGE_DAILY_BUDGET_USD)
      if (envDaily && envDaily > 0) this.#data.dailyUsd = envDaily
    }
    if (this.#data.monthlyUsd === undefined) {
      const envMonthly = nonNegNumber(env.USAGE_MONTHLY_BUDGET_USD)
      if (envMonthly && envMonthly > 0) this.#data.monthlyUsd = envMonthly
    }
  }

  #save(): void {
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify(this.#data, null, 2)}\n`)
    } catch (err) {
      this.#log.warn("failed to persist budget store:", (err as Error).message)
    }
  }
}

export function formatBudgetSummary(status: BudgetStatus): string {
  const dailyLine =
    status.dailyUsd > 0
      ? `${formatUsd(status.todayUsd)} / ${formatUsd(status.dailyUsd)}（${status.dailyPercent}%）`
      : `${formatUsd(status.todayUsd)}（未设上限）`
  const monthLine =
    status.monthlyUsd > 0
      ? `${formatUsd(status.monthUsd)} / ${formatUsd(status.monthlyUsd)}（${status.monthlyPercent}%）`
      : `${formatUsd(status.monthUsd)}（未设上限）`
  const badge =
    status.alertLevel === "exceeded" ? "🚨 已超预算" : status.alertLevel === "warn" ? "⚠️ 接近上限" : "✅ 正常"
  return (
    `💸 *费用与预算监控*（${badge}）\n\n` +
    `• 今日花费：${dailyLine}\n` +
    `• 今日 Token：${formatTokens(status.todayTokens)}\n` +
    `• 本月花费：${monthLine}\n` +
    `• 本月 Token：${formatTokens(status.monthTokens)}\n\n` +
    `用法：\n` +
    `• \`/budget 5\` 设置每日预算 $5\n` +
    `• \`/budget month 80\` 设置每月预算 $80\n` +
    `• \`/budget off\` 关闭全部预算告警`
  )
}
