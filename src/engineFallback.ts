/**
 * Engine availability, shared by the Telegram bridge and the HTTP API.
 *
 * A session without an explicit engine falls back to the configured default, and that
 * default is `opencode`. When opencode is uninstalled (or its server is down) every
 * message on such a session fails before any model is reached, which reads as "no agent
 * works any more". Only an *implicit* choice may be replaced: a user who picked an engine
 * keeps it, so the error stays truthful.
 */

/** Minimal slice of AgentCliRegistry, so tests can pass a literal instead of a real one. */
export interface EngineAvailability {
  list(): Array<{ id: string; label: string; bin: string }>
  get(id: string): { id: string; label: string; bin: string } | undefined
  binPath(profile: { bin: string }): string | undefined
  label(id: string): string
}

/** A health probe per message would be a round trip; both callers share this window. */
export const OPENCODE_HEALTH_CACHE_MS = 10_000

/** Cached opencode health probe, owned by whoever talks to the server. */
export class OpencodeHealth {
  #at = 0
  #healthy = false

  constructor(private readonly probe: () => Promise<boolean>) {}

  async isHealthy(): Promise<boolean> {
    if (Date.now() - this.#at < OPENCODE_HEALTH_CACHE_MS) return this.#healthy
    this.#at = Date.now()
    this.#healthy = await this.probe().catch(() => false)
    return this.#healthy
  }
}

/** Most common replacements first, then anything installed. */
const PREFERRED = ["codex", "claude"]

/** An installed CLI engine other than `exclude`, or undefined when none is usable. */
export function pickInstalledEngine(registry: EngineAvailability, exclude?: string): string | undefined {
  const installed = registry.list().filter((profile) => profile.id !== exclude && registry.binPath(profile))
  for (const id of PREFERRED) {
    if (installed.some((profile) => profile.id === id)) return id
  }
  return installed[0]?.id
}

export interface UsableEngineInput {
  /** The engine the session resolved to. */
  engine: string
  /** True when a user or task override chose it, so replacing it would be a surprise. */
  explicit: boolean
  registry: EngineAvailability
  /** Cached probe of the opencode server; only called for the built-in engine. */
  opencodeHealthy: () => Promise<boolean>
}

export interface UsableEngine {
  engine: string
  /** Set only when the engine was replaced; names the engine that answers, not why. */
  note?: string
}

export async function resolveUsableEngine(input: UsableEngineInput): Promise<UsableEngine> {
  const { engine, explicit, registry } = input
  if (explicit) return { engine }

  if (engine === "opencode") {
    if (await input.opencodeHealthy()) return { engine }
    const fallback = pickInstalledEngine(registry, engine)
    if (!fallback) return { engine }
    // The reason belongs in the log, not in the answer: the reader only needs to know
    // which engine is answering them. The profile label reads better than the bare id.
    return { engine: fallback, note: `本次使用 ${registry.get(fallback)?.label ?? registry.label(fallback)}` }
  }

  const profile = registry.get(engine)
  if (profile && registry.binPath(profile)) return { engine }
  const fallback = pickInstalledEngine(registry, engine)
  if (!fallback) return { engine }
  return { engine: fallback, note: `本次使用 ${registry.get(fallback)?.label ?? registry.label(fallback)}` }
}
