import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"

/**
 * A third-party relay ("中转站") a CLI engine should talk to instead of its vendor.
 *
 * The relay is configured by environment variables rather than by editing each CLI's own
 * config file: the formats differ (toml, json, dotenv) and a mistake there breaks the CLI for
 * every other use. Setting the variable for one spawn is reversible and needs no file edits.
 */
export interface AgentProviderConfig {
  baseURL: string
  apiKey?: string
}

/** Which variables each CLI reads for a custom endpoint. Others are left alone. */
const ENV_KEYS: Record<string, { baseURL: string; apiKey: string }> = {
  codex: { baseURL: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
  claude: { baseURL: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_AUTH_TOKEN" },
  gemini: { baseURL: "GOOGLE_GEMINI_BASE_URL", apiKey: "GEMINI_API_KEY" },
  qoder: { baseURL: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
}

export function supportsRelay(engine: string): boolean {
  return engine in ENV_KEYS
}

export class AgentProviderStore {
  readonly #path: string
  readonly #log: Logger

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
  }

  get(engine: string): AgentProviderConfig | undefined {
    return this.#load()[engine]
  }

  /** Passing undefined removes the relay, so the engine goes back to its own default. */
  set(engine: string, config: AgentProviderConfig | undefined): void {
    const all = this.#load()
    if (config?.baseURL) all[engine] = { baseURL: config.baseURL, ...(config.apiKey ? { apiKey: config.apiKey } : {}) }
    else delete all[engine]
    writePrivateAtomic(
      this.#path,
      `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), engines: all }, null, 2)}\n`,
    )
  }

  /** Variables a spawn of [engine] needs; empty when no relay is configured. */
  envFor(engine: string): Record<string, string> {
    const keys = ENV_KEYS[engine]
    const config = this.get(engine)
    if (!keys || !config) return {}
    const env: Record<string, string> = { [keys.baseURL]: config.baseURL }
    if (config.apiKey) env[keys.apiKey] = config.apiKey
    return env
  }

  #load(): Record<string, AgentProviderConfig> {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    const engines = asRecord(raw?.engines)
    if (!engines) return {}
    const result: Record<string, AgentProviderConfig> = {}
    for (const [engine, value] of Object.entries(engines)) {
      const record = asRecord(value)
      const baseURL = typeof record?.baseURL === "string" ? record.baseURL.trim() : ""
      if (!baseURL) continue
      result[engine] = {
        baseURL,
        ...(typeof record?.apiKey === "string" && record.apiKey ? { apiKey: record.apiKey } : {}),
      }
    }
    return result
  }
}
