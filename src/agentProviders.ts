import { decryptPayload, encryptPayload } from "./apiCrypto.js"
import { withFileLock } from "./fileLock.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"
import { loadOrCreateSecretKey } from "./secretKey.js"

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
    // Encrypt before taking the lock: creating the key may itself wait on another process
    const secret = config?.baseURL && config.apiKey ? encryptPayload(this.#keyBuffer(), config.apiKey) : undefined
    // The bot and the App each hold a store over this file; loading outside the lock let the
    // later save erase a relay the other had just configured for a different engine
    withFileLock(this.#path, () => {
      // Work on the stored records, not on #load()'s decrypted view: writing that view back put
      // every other engine's relay key on disk in plain text, and dropped the key of any entry
      // that failed to decrypt. Only the engine being set changes; the rest keep their ciphertext.
      const all = this.#loadStored()
      // The key is encrypted so a backup or a copied data directory carries no usable credential
      if (config?.baseURL) {
        all[engine] = { baseURL: config.baseURL, ...(secret ? { secret } : {}) }
      } else delete all[engine]
      writePrivateAtomic(
        this.#path,
        `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), engines: all }, null, 2)}\n`,
        `${this.#path}.${process.pid}.tmp`,
      )
    })
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
    return loadOrCreateSecretKey(this.#keyPath, {
      onCreate: (path) => this.#log.info(`agent key created at ${path}`),
    })
  }

  /** Records as stored, with a pre-encryption plain `apiKey` encrypted on the way through. */
  #loadStored(): Record<string, { baseURL: string; secret?: string }> {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    const engines = asRecord(raw?.engines)
    const result: Record<string, { baseURL: string; secret?: string }> = {}
    if (!engines) return result
    for (const [engine, value] of Object.entries(engines)) {
      const record = asRecord(value)
      const baseURL = typeof record?.baseURL === "string" ? record.baseURL.trim() : ""
      if (!baseURL) continue
      if (typeof record?.secret === "string" && record.secret) {
        result[engine] = { baseURL, secret: record.secret }
      } else if (typeof record?.apiKey === "string" && record.apiKey) {
        result[engine] = { baseURL, secret: encryptPayload(this.#keyBuffer(), record.apiKey) }
      } else {
        result[engine] = { baseURL }
      }
    }
    return result
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
