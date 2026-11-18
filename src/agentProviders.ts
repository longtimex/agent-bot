import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { decryptPayload, encryptPayload } from "./apiCrypto.js"
import { withFileLock } from "./fileLock.js"
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
  readonly #keyPath: string
  readonly #log: Logger

  /** [keyPath] is the account key: one data directory, one local secret. */
  constructor(path: string, keyPath: string, log: Logger) {
    this.#path = path
    this.#keyPath = keyPath
    this.#log = log
  }

  get(engine: string): AgentProviderConfig | undefined {
    return this.#load()[engine]
  }

  /** Passing undefined removes the relay, so the engine goes back to its own default. */
  set(engine: string, config: AgentProviderConfig | undefined): void {
    const all = this.#load()
    // The key is encrypted so a backup or a copied data directory carries no usable credential
    if (config?.baseURL) {
      all[engine] = {
        baseURL: config.baseURL,
        ...(config.apiKey ? { secret: encryptPayload(this.#keyBuffer(), config.apiKey) } : {}),
      }
    }
    else delete all[engine]
    writePrivateAtomic(
      this.#path,
      `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), engines: all }, null, 2)}\n`,
    )
  }

  /**
   * Variables a spawn of [engine] needs. [override] is the endpoint of the model being run,
   * which wins over the engine-level relay — that is what lets two models of one CLI talk to
   * two different relays.
   */
  envFor(engine: string, override?: { baseURL: string; apiKey?: string }): Record<string, string> {
    const keys = ENV_KEYS[engine]
    const config = override ?? this.get(engine)
    if (!keys || !config) return {}
    const env: Record<string, string> = { [keys.baseURL]: config.baseURL }
    if (config.apiKey) env[keys.apiKey] = config.apiKey
    return env
  }

  /** Same file and format the account vault uses: one data directory, one local secret. */
  #keyBuffer(): Buffer {
    if (existsSync(this.#keyPath)) {
      const raw = readFileSync(this.#keyPath, "utf8").trim()
      if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
      throw new Error(`账号密钥 ${this.#keyPath} 格式无效，请从备份恢复该文件。`)
    }
    return withFileLock(this.#keyPath, () => {
      // Another store may have created it while this one waited for the lock
      if (existsSync(this.#keyPath)) {
        const raw = readFileSync(this.#keyPath, "utf8").trim()
        if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
      }
      mkdirSync(dirname(this.#keyPath), { recursive: true })
      const key = randomBytes(32)
      writeFileSync(this.#keyPath, `${key.toString("hex")}\n`, { mode: 0o600 })
      this.#log.info(`agent key created at ${this.#keyPath}`)
      return key
    })
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
      let apiKey: string | undefined
      if (typeof record?.secret === "string" && record.secret) {
        try {
          apiKey = decryptPayload(this.#keyBuffer(), record.secret)
        } catch {
          // A key rotated elsewhere leaves this entry unreadable; keep the URL, drop the key
          this.#log.warn(`relay key for ${engine} could not be decrypted`)
        }
      } else if (typeof record?.apiKey === "string" && record.apiKey) {
        // Written before the key was encrypted; still honoured, rewritten on the next save
        apiKey = record.apiKey
      }
      result[engine] = { baseURL, ...(apiKey ? { apiKey } : {}) }
    }
    return result
  }
}
