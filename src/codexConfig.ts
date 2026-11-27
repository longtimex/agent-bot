import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"
import { scrubEnv } from "./binPath.js"
import { assertNotCloudMetadataUrl, readBoundedResponseText } from "./media.js"
import { asRecord } from "./util.js"

/**
 * What a Codex installation says about itself.
 *
 * `codex debug models` lists the vendor catalogue — a fixed table of GPT names that has
 * nothing to do with what an operator configured. When a relay is set up, the only models
 * that actually answer are the one named in `model` and whatever that relay reports, so the
 * config file (plus the provider's own `/models`) is the authoritative source.
 */
export interface CodexProvider {
  id: string
  name: string
  baseURL?: string
  /** Resolved from `env_key`; absent when the variable is not set in this process. */
  apiKey?: string
}

export interface CodexConfig {
  /** The model Codex runs with when nothing else is passed. */
  model?: string
  providers: CodexProvider[]
  /** Named profiles and the model each names (`codex -p <name>`). */
  profiles: Array<{ name: string; model: string }>
}

export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
  return join(home, "config.toml")
}

/** Parsed config, or undefined when the file is missing or unreadable. */
export function readCodexConfig(): CodexConfig | undefined {
  const path = codexConfigPath()
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = parse(readFileSync(path, "utf8"))
  } catch {
    // A malformed file is the CLI's problem to report; from here it means "nothing known"
    return undefined
  }
  const root = asRecord(raw)
  if (!root) return undefined

  const model = typeof root.model === "string" && root.model.trim() ? root.model.trim() : undefined

  const safeEnv = scrubEnv(process.env)
  const providersRaw = asRecord(root.model_providers) ?? {}
  const providers: CodexProvider[] = Object.entries(providersRaw).flatMap(([id, value]) => {
    const spec = asRecord(value)
    if (!spec) return []
    const baseURL = typeof spec.base_url === "string" && spec.base_url.trim() ? spec.base_url.trim() : undefined
    const envKey = typeof spec.env_key === "string" && spec.env_key.trim() ? spec.env_key.trim() : undefined
    // Read only from the scrubbed child environment so ~/.codex/config.toml can never exfiltrate BOT_ONLY secrets
    const apiKey = envKey && Object.hasOwn(safeEnv, envKey) ? safeEnv[envKey]?.trim() : undefined
    return [{ id, name: typeof spec.name === "string" && spec.name ? spec.name : id, baseURL, apiKey }]
  })

  const profilesRaw = asRecord(root.profiles) ?? {}
  const profiles = Object.entries(profilesRaw).flatMap(([name, value]) => {
    const spec = asRecord(value)
    const named = typeof spec?.model === "string" ? spec.model.trim() : ""
    return named ? [{ name, model: named }] : []
  })

  return { model, providers, profiles }
}

/**
 * Models the provider itself reports. Empty when the endpoint is unreachable or does not
 * implement `/models` — the caller then falls back to what the config file names.
 */
export async function fetchProviderModels(provider: CodexProvider, timeoutMs = 6_000): Promise<string[]> {
  if (!provider.baseURL) return []
  try {
    const target = `${provider.baseURL.replace(/\/+$/, "")}/models`
    await assertNotCloudMetadataUrl(target)
    const res = await fetch(target, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return []
    }
    const text = await readBoundedResponseText(res, 1024 * 1024)
    const body = JSON.parse(text) as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(body?.data)) return []
    return body.data
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter((id): id is string => Boolean(id))
  } catch {
    return []
  }
}
