import { whichSync, type AgentCliRegistry } from "./agentCli.js"

/**
 * Which engine a conversation with no explicit choice starts on.
 *
 * Order: the value saved from the App, then the `DEFAULT_ENGINE` env, then the first engine
 * that is actually on PATH. OpenCode is only the last resort — a machine that never installed
 * it should not start every session on an engine that cannot run, which is what the old
 * hardcoded default did.
 */
export function resolveDefaultEngine(
  registry: AgentCliRegistry,
  saved?: string,
  configured?: string,
): string {
  for (const candidate of [saved, configured]) {
    if (!candidate) continue
    // opencode is the built-in engine and has no CLI profile, so registry.resolve misses it
    if (candidate.trim().toLowerCase() === "opencode") return "opencode"
    const id = registry.resolve(candidate)
    if (id) return id
  }
  for (const profile of registry.list()) {
    if (profile.bin && whichSync(profile.bin)) return profile.id
  }
  return "opencode"
}
