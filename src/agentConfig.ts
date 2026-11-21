import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { asRecord } from "./util.js"
import { readCodexConfig, type CodexProvider } from "./codexConfig.js"

/**
 * What an installed CLI says about itself, normalized across engines.
 *
 * Every agent worth listing models for keeps that information in its own config file: a relay
 * it was pointed at, and the model it runs by default. A CLI's own "list models" command is
 * not a substitute — `codex debug models` reports the vendor catalogue, which never includes a
 * relay-hosted name.
 */
export interface AgentConfigView {
  /** The model the CLI runs when nothing overrides it. */
  model?: string
  /** Named profiles and the model each one selects. */
  profiles?: Array<{ name: string; model: string }>
  /** Endpoints the config points at, each able to report its own model list. */
  providers: CodexProvider[]
}

interface JsonConfigSpec {
  /** Where the file lives; a function so the home directory is read at call time. */
  path: () => string
  /** Keys inside `env` that may hold the endpoint, in priority order. */
  baseURLKeys: string[]
  /** Keys inside `env` that may hold the key for that endpoint. */
  apiKeyKeys: string[]
  /** Shown as the provider name when the config names no provider of its own. */
  label: string
}

const JSON_CONFIGS: Record<string, JsonConfigSpec> = {
  claude: {
    path: () => join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "settings.json"),
    baseURLKeys: ["ANTHROPIC_BASE_URL"],
    apiKeyKeys: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
    label: "Claude 配置中的中转站",
  },
  gemini: {
    path: () => join(process.env.GEMINI_CONFIG_DIR?.trim() || join(homedir(), ".gemini"), "settings.json"),
    baseURLKeys: ["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL"],
    apiKeyKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    label: "Gemini 配置中的中转站",
  },
}

/**
 * The config an engine declares, or undefined when it has none this module understands.
 * Undefined is not an error: callers fall back to whatever probe the profile defines.
 */
export function readAgentConfig(engine: string): AgentConfigView | undefined {
  if (engine === "codex") {
    const codex = readCodexConfig()
    return codex ? { model: codex.model, profiles: codex.profiles, providers: codex.providers } : undefined
  }
  const spec = JSON_CONFIGS[engine]
  return spec ? readJsonConfig(spec) : undefined
}

function readJsonConfig(spec: JsonConfigSpec): AgentConfigView | undefined {
  const path = spec.path()
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // A malformed file is the CLI's to report; here it means "nothing known"
    return undefined
  }
  const root = asRecord(raw)
  if (!root) return undefined

  const model = typeof root.model === "string" && root.model.trim() ? root.model.trim() : undefined
  const env = asRecord(root.env) ?? {}
  const read = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = env[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
    return undefined
  }
  const baseURL = read(spec.baseURLKeys)
  // Without an endpoint there is nothing to ask, but the model name is still worth showing
  const providers: CodexProvider[] = baseURL
    ? [{ id: "default", name: spec.label, baseURL, apiKey: read(spec.apiKeyKeys) }]
    : []
  if (!model && providers.length === 0) return undefined
  return { model, providers }
}
