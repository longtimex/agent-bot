import { readJsonObject } from "./jsonStore.js"
import type { Logger } from "./logger.js"

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  costUsd?: number
}

interface ModelPricePerMillion {
  input: number
  output: number
  cacheRead?: number
}

/**
 * Fallback per-1M-token USD pricing table used only when an engine reports token
 * counts without an explicit USD cost. Operators can override or extend this via
 * `data/model-pricing.json` (`{ "pattern": { "input": 3, "output": 15, "cacheRead": 0.3 } }`).
 */
const BUILTIN_PRICING: Array<{ pattern: RegExp; price: ModelPricePerMillion }> = [
  { pattern: /claude[-_ ]?(?:opus|4[-.]?opus|3[-.]?opus)/i, price: { input: 15, output: 75, cacheRead: 1.5 } },
  { pattern: /claude[-_ ]?(?:sonnet|3\.5|3\.7|4[-.]?sonnet)/i, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { pattern: /claude[-_ ]?haiku/i, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
  { pattern: /gpt-5|codex/i, price: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { pattern: /gpt-4o-mini|gpt-4\.1-mini|o4-mini|o3-mini/i, price: { input: 0.4, output: 1.6, cacheRead: 0.1 } },
  { pattern: /gpt-4o|gpt-4\.1|o3\b/i, price: { input: 2.5, output: 10, cacheRead: 1.25 } },
  { pattern: /gemini[-_ ]?(?:2\.5|3)[-_ .]?pro/i, price: { input: 1.25, output: 10, cacheRead: 0.31 } },
  { pattern: /gemini[-_ ]?(?:2\.5|2\.0|3)[-_ .]?flash/i, price: { input: 0.15, output: 0.6, cacheRead: 0.0375 } },
  { pattern: /deepseek[-_ ]?(?:r1|reasoner)/i, price: { input: 0.55, output: 2.19, cacheRead: 0.14 } },
  { pattern: /deepseek/i, price: { input: 0.27, output: 1.1, cacheRead: 0.07 } },
  { pattern: /qwen|kimi|glm/i, price: { input: 0.5, output: 2, cacheRead: 0.1 } },
  { pattern: /grok/i, price: { input: 3, output: 15, cacheRead: 0.75 } },
]

let customPricing: Array<{ match: string; price: ModelPricePerMillion }> = []

export function configureModelPricing(path: string, log?: Logger): void {
  const parsed = readJsonObject(path, (msg) => log?.warn(msg))
  if (!parsed) {
    customPricing = []
    return
  }
  const next: Array<{ match: string; price: ModelPricePerMillion }> = []
  for (const [key, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== "object") continue
    const rec = raw as Record<string, unknown>
    const input = Number(rec.input)
    const output = Number(rec.output)
    const cacheRead = rec.cacheRead === undefined ? undefined : Number(rec.cacheRead)
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) continue
    next.push({
      match: key.toLowerCase(),
      price: {
        input,
        output,
        ...(cacheRead !== undefined && Number.isFinite(cacheRead) && cacheRead >= 0 ? { cacheRead } : {}),
      },
    })
  }
  customPricing = next
}

function lookupPrice(model?: string): ModelPricePerMillion | undefined {
  if (!model) return undefined
  const lower = model.toLowerCase()
  for (const entry of customPricing) {
    if (lower.includes(entry.match)) return entry.price
  }
  for (const entry of BUILTIN_PRICING) {
    if (entry.pattern.test(model)) return entry.price
  }
  return undefined
}

export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value * 1_000_000) / 1_000_000
}

export function estimateCostUsd(
  model: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
): number {
  const price = lookupPrice(model)
  if (!price) return 0
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0)
  // Some engines include cached tokens inside inputTokens; charge cacheRead at discounted rate without going negative.
  const billableInput = Math.max(0, usage.inputTokens)
  const output = Math.max(0, usage.outputTokens)
  const usd =
    (billableInput * price.input + output * price.output + cacheRead * (price.cacheRead ?? price.input * 0.25)) /
    1_000_000
  return roundUsd(usd)
}

function posInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function posFloat(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? roundUsd(value) : 0
}

function finalizeUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  reportedCost: number,
  model?: string,
): TokenUsage | undefined {
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && reportedCost === 0) return undefined
  const costUsd = reportedCost > 0 ? reportedCost : estimateCostUsd(model, { inputTokens, outputTokens, cacheReadTokens })
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  }
}

/** Extracts token and cost figures from OpenCode's `response.info` metadata. */
export function extractOpencodeUsage(info: unknown, model?: string): TokenUsage | undefined {
  if (!info || typeof info !== "object") return undefined
  const rec = info as Record<string, unknown>
  const tokens = rec.tokens && typeof rec.tokens === "object" ? (rec.tokens as Record<string, unknown>) : undefined
  const cache = tokens?.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : undefined
  const inputTokens = posInt(tokens?.input)
  const outputTokens = posInt(tokens?.output) + posInt(tokens?.reasoning)
  const cacheReadTokens = posInt(cache?.read)
  const reportedCost = posFloat(rec.cost)
  const modelId = typeof rec.modelID === "string" ? rec.modelID : model
  return finalizeUsage(inputTokens, outputTokens, cacheReadTokens, reportedCost, modelId)
}

function readUsageBlock(obj: Record<string, unknown>): { input: number; output: number; cacheRead: number } {
  return {
    input: posInt(obj.input_tokens) || posInt(obj.prompt_tokens) || posInt(obj.promptTokenCount),
    output: posInt(obj.output_tokens) || posInt(obj.completion_tokens) || posInt(obj.candidatesTokenCount),
    cacheRead:
      posInt(obj.cache_read_input_tokens) ||
      posInt(obj.cached_input_tokens) ||
      posInt(obj.cachedContentTokenCount),
  }
}

/** Extracts token and cost figures from raw CLI stdout across Claude, Codex, and Gemini modes. */
export function extractCliUsage(
  mode: string | undefined,
  rawStdout: string,
  model?: string,
): TokenUsage | undefined {
  if (!rawStdout.trim() || !mode || mode === "text") return undefined

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let reportedCost = 0

  const inspectRecord = (rec: Record<string, unknown>, additive: boolean): void => {
    const cost = posFloat(rec.total_cost_usd) || posFloat(rec.cost_usd) || posFloat(rec.cost)
    if (cost > 0) reportedCost = additive ? roundUsd(reportedCost + cost) : cost

    const usageObj =
      (rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : undefined) ??
      (rec.stats && typeof rec.stats === "object" ? (rec.stats as Record<string, unknown>) : undefined) ??
      (rec.usageMetadata && typeof rec.usageMetadata === "object"
        ? (rec.usageMetadata as Record<string, unknown>)
        : undefined)

    if (usageObj) {
      const counts = readUsageBlock(usageObj)
      if (counts.input || counts.output || counts.cacheRead) {
        if (additive) {
          inputTokens += counts.input
          outputTokens += counts.output
          cacheReadTokens += counts.cacheRead
        } else {
          inputTokens = counts.input
          outputTokens = counts.output
          cacheReadTokens = counts.cacheRead
        }
      }
    }
  }

  if (mode === "claude-json") {
    try {
      const parsed = JSON.parse(rawStdout.trim()) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        inspectRecord(parsed as Record<string, unknown>, false)
        return finalizeUsage(inputTokens, outputTokens, cacheReadTokens, reportedCost, model)
      }
    } catch {
      // Fall through to line-by-line JSONL scan (claude --output-format stream-json).
    }
  }

  const lines = rawStdout.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith("{")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const rec = parsed as Record<string, unknown>
    if (mode === "codex-jsonl") {
      if (rec.type === "turn.completed") inspectRecord(rec, true)
    } else if (mode === "gemini-stream") {
      if (rec.type === "result" || rec.stats || rec.usageMetadata) inspectRecord(rec, false)
    } else {
      if (rec.type === "result" || rec.total_cost_usd !== undefined || rec.usage !== undefined) {
        inspectRecord(rec, false)
      }
    }
  }

  return finalizeUsage(inputTokens, outputTokens, cacheReadTokens, reportedCost, model)
}

export function formatTokens(total: number): string {
  const n = Math.max(0, Math.round(total))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(n)
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
