/** How a CLI prints its model catalog. `auto` accepts JSON or one model per line. */
export type AgentModelProbeFormat = "auto" | "json" | "lines"

/** A fixed, non-interactive command that asks the CLI for the models this account may use. */
export interface AgentCliModelProbe {
  args: string[]
  format?: AgentModelProbeFormat
  timeoutMs?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string")
  return items.length === value.length ? items : undefined
}

export function sanitizeModelProbe(value: unknown, label: string): AgentCliModelProbe | undefined {
  if (value === undefined || value === null) return undefined
  const record = asRecord(value)
  if (!record) throw new Error(`${label}.modelProbe 必须是对象`)
  const args = stringArray(record.args)
  if (!args || args.length === 0) throw new Error(`${label}.modelProbe.args 必须是非空字符串数组`)
  if (args.some((arg) => !arg || arg.length > 240 || /[\u0000-\u001f\u007f]/.test(arg))) {
    throw new Error(`${label}.modelProbe.args 含空白项、控制字符或超长参数`)
  }
  const formatRaw = typeof record.format === "string" ? record.format : undefined
  if (formatRaw !== undefined && !["auto", "json", "lines"].includes(formatRaw)) {
    throw new Error(`${label}.modelProbe.format 必须是 auto、json 或 lines`)
  }
  const timeout = record.timeoutMs
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1_000 || timeout > 120_000)
  ) {
    throw new Error(`${label}.modelProbe.timeoutMs 必须是 1000 到 120000 之间的数字`)
  }
  return {
    args,
    format: (formatRaw as AgentModelProbeFormat | undefined) ?? "auto",
    timeoutMs: timeout as number | undefined,
  }
}
