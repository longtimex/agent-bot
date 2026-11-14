import type { AgentCliRegistry } from "./agentCli.js"
import type { AgentModelCatalog } from "./agentModelCatalog.js"

export interface CliModelCallbackDeps {
  registry: AgentCliRegistry
  catalog: AgentModelCatalog
}

/**
 * Decode `cmodel:<engine>:<id|position>` and the older `qmodel:<id>`.
 *
 * New panels put the model id in the callback, because an index can point at a
 * different model after the catalogue is refreshed. Panels drawn by older versions
 * still carry a position, so a purely numeric value is never treated as a literal
 * model id for a non-strict CLI profile.
 */
export function resolveCliModelCallback(
  data: string,
  deps: CliModelCallbackDeps,
): { engine: string; model?: string } {
  if (data.startsWith("qmodel:")) {
    const engine = "qoder"
    return { engine, model: deps.catalog.resolve(engine, data.slice("qmodel:".length)) }
  }

  const payload = data.slice("cmodel:".length)
  // Split on the first colon only: a model id may itself contain one.
  const at = payload.indexOf(":")
  const engine = at < 0 ? payload : payload.slice(0, at)
  const value = at < 0 ? "" : payload.slice(at + 1)
  const listed = value !== "" ? deps.catalog.find(engine, value)?.id : undefined
  const position = value !== "" && /^\d+$/.test(value) ? Number(value) : undefined
  const indexed = position === undefined
    ? undefined
    : deps.registry.get(engine)?.models?.[position]?.id ?? deps.catalog.findIndex(engine, position)
  // A listed id wins over positional parsing, but an unknown numeric value is a stale
  // position, not a model literally named "9".
  const model = listed ?? indexed ?? (position !== undefined ? undefined : deps.catalog.resolve(engine, value))
  return { engine, model }
}
