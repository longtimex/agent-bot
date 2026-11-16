/**
 * Narrowing helpers that were copied into every JSON parser. Keeping one copy means a fix
 * to the edge cases lands everywhere: `null`, arrays and primitives are not records.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Every element must be a string; a mixed array is treated as malformed, not filtered. */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string")
  return items.length === value.length ? items : undefined
}
