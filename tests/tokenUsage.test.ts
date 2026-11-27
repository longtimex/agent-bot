import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import {
  configureModelPricing,
  estimateCostUsd,
  extractCliUsage,
  extractOpencodeUsage,
  formatTokens,
  formatUsd,
} from "../src/tokenUsage.js"
import { UsageStore } from "../src/usage.js"
import { UsageBudgetStore } from "../src/usageBudget.js"
import { buildDailyReportData, formatDailyReport } from "../src/usageReport.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("extractOpencodeUsage reads tokens and falls back to model pricing when cost is absent", () => {
  const direct = extractOpencodeUsage(
    { tokens: { input: 2000, output: 500, cache: { read: 1000 } }, cost: 0.0123 },
    "claude-sonnet-4-5",
  )
  assert.deepEqual(direct, {
    inputTokens: 2000,
    outputTokens: 500,
    cacheReadTokens: 1000,
    costUsd: 0.0123,
  })

  const estimated = extractOpencodeUsage(
    { tokens: { input: 1_000_000, output: 100_000 } },
    "claude-sonnet-4-5",
  )
  assert.ok(estimated)
  assert.equal(estimated.inputTokens, 1_000_000)
  assert.equal(estimated.outputTokens, 100_000)
  assert.equal(estimated.costUsd, 4.5) // 3.0 input + 1.5 output
})

test("extractCliUsage parses Claude JSON, Codex JSONL, and Gemini stream usage", () => {
  const claude = extractCliUsage(
    "claude-json",
    JSON.stringify({
      type: "result",
      result: "ok",
      total_cost_usd: 0.042,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 500 },
    }),
  )
  assert.deepEqual(claude, {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 500,
    costUsd: 0.042,
  })

  const codex = extractCliUsage(
    "codex-jsonl",
    [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 400 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 100 } }),
    ].join("\n"),
    "gpt-5-codex",
  )
  assert.ok(codex)
  assert.equal(codex.inputTokens, 1500)
  assert.equal(codex.outputTokens, 500)
  assert.equal(codex.cacheReadTokens, 200)
  assert.ok((codex.costUsd ?? 0) > 0)

  const gemini = extractCliUsage(
    "gemini-stream",
    JSON.stringify({ type: "result", stats: { input_tokens: 10_000, output_tokens: 2_000 } }),
    "gemini-2.5-flash",
  )
  assert.ok(gemini)
  assert.equal(gemini.inputTokens, 10_000)
  assert.equal(gemini.outputTokens, 2_000)
  assert.ok((gemini.costUsd ?? 0) > 0)
})

test("configureModelPricing overrides builtin pricing and formatters stay readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-pricing-"))
  try {
    const file = join(dir, "model-pricing.json")
    writeFileSync(file, JSON.stringify({ "custom-fast": { input: 1, output: 2 } }))
    configureModelPricing(file, log)
    assert.equal(estimateCostUsd("my/custom-fast-v1", { inputTokens: 1_000_000, outputTokens: 500_000 }), 2)
    assert.equal(formatTokens(950), "950")
    assert.equal(formatTokens(15_400), "15.4K")
    assert.equal(formatTokens(1_250_000), "1.25M")
    assert.equal(formatUsd(0.0042), "$0.0042")
    assert.equal(formatUsd(1.5), "$1.50")
  } finally {
    configureModelPricing(join(dir, "missing.json"), log)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("UsageStore persists tokens/cost and UsageBudgetStore deduplicates 80% and 100% alerts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-budget-"))
  try {
    const usagePath = join(dir, "usage.json")
    const budgetPath = join(dir, "budget.json")
    const store = new UsageStore(usagePath, log, "Asia/Shanghai")
    const budget = new UsageBudgetStore(budgetPath, log, {})
    budget.setLimits({ dailyUsd: 1.0, monthlyUsd: 10.0 })

    const now = Date.UTC(2026, 4, 10, 4, 0) // 2026-05-10 12:00 Asia/Shanghai
    store.record(
      "tg:1",
      { engine: "opencode", model: "claude-sonnet-4-5", ms: 1200, outcome: "ok", tokens: { inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.5 } },
      now,
    )
    assert.equal(budget.checkAndConsumeAlert(store, "Asia/Shanghai", now), undefined)

    // Cross 80% daily threshold
    store.record(
      "api:app",
      { engine: "claude", model: "sonnet", ms: 900, outcome: "ok", tokens: { inputTokens: 8_000, outputTokens: 1_000, costUsd: 0.35 } },
      now + 1000,
    )
    const warn = budget.checkAndConsumeAlert(store, "Asia/Shanghai", now + 1000)
    assert.ok(warn && warn.includes("80%"))
    // Same threshold does not spam twice on the same day
    assert.equal(budget.checkAndConsumeAlert(store, "Asia/Shanghai", now + 2000), undefined)

    // Cross 100% daily threshold
    store.record(
      "tg:1",
      { engine: "opencode", ms: 800, outcome: "ok", tokens: { inputTokens: 5_000, outputTokens: 500, costUsd: 0.25 } },
      now + 3000,
    )
    const exceeded = budget.checkAndConsumeAlert(store, "Asia/Shanghai", now + 3000)
    assert.ok(exceeded && exceeded.includes("已超过上限"))
    assert.equal(budget.checkAndConsumeAlert(store, "Asia/Shanghai", now + 4000), undefined)

    // Reload from disk preserves both usage tokens/cost and budget alert dedup state
    const reloadedUsage = new UsageStore(usagePath, log, "Asia/Shanghai")
    const reloadedBudget = new UsageBudgetStore(budgetPath, log, {})
    const st = reloadedBudget.status(reloadedUsage, "Asia/Shanghai", now + 5000)
    assert.equal(st.todayUsd, 1.1)
    assert.equal(st.todayTokens, 26_500)
    assert.equal(st.alertLevel, "exceeded")
    assert.equal(reloadedBudget.checkAndConsumeAlert(reloadedUsage, "Asia/Shanghai", now + 5000), undefined)

    const reportText = formatDailyReport(buildDailyReportData(reloadedUsage, "Asia/Shanghai", now + 5000))
    assert.match(reportText, /今日 Token \/ 费用/)
    assert.match(reportText, /\$1\.10/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
