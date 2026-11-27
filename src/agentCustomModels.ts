import { decryptPayload, encryptPayload } from "./apiCrypto.js"
import { withFileLock } from "./fileLock.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"
import { loadOrCreateSecretKey } from "./secretKey.js"

/**
 * Model ids an operator adds by hand for a CLI engine.
 *
 * A CLI takes the model name as a plain `--model` argument, so a provider that ships a new
 * model before this bot's built-in table knows about it can still be picked. Discovery results
 * win over a hand-written entry with the same value, because the CLI's own list is authoritative
 * about which names exist on that machine.
 */
export interface CustomAgentModel {
  /** What gets passed to the CLI; the only field that matters at run time. */
  value: string
  label: string
  /** Endpoint this model alone talks to; falls back to the engine-level relay. */
  baseURL?: string
}

interface StoredCustomAgentModel extends CustomAgentModel {
  secret?: string
}

/** A model's own endpoint plus its decrypted key, ready to become env vars. */
export interface CustomModelEndpoint {
  baseURL: string
  apiKey?: string
}

const MAX_PER_ENGINE = 40
const VALUE_MAX = 120
const LABEL_MAX = 60
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function toPublicModel(entry: StoredCustomAgentModel): CustomAgentModel {
  return {
    value: entry.value,
    label: entry.label,
    ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
  }
}

function validateModelBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (CONTROL_CHARS.test(trimmed)) throw new Error("baseURL 不能包含控制字符")
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("baseURL 格式不合法")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseURL 需要以 http:// 或 https:// 开头")
  }
  return trimmed
}

export class AgentCustomModelStore {
  readonly #path: string
  readonly #keyPath: string
  readonly #log: Logger

  /** [keyPath] is the account key: one data directory, one local secret. */
  constructor(path: string, keyPath: string, log: Logger) {
    this.#path = path
    this.#keyPath = keyPath
    this.#log = log
  }

  /** Endpoint attached to one model, decrypted; undefined when it has none of its own. */
  endpointFor(engine: string, value: string): CustomModelEndpoint | undefined {
    const loaded = this.#load()
    const list = Object.hasOwn(loaded, engine) ? loaded[engine] : undefined
    const entry = list?.find((model) => model.value === value)
    if (!entry?.baseURL) return undefined
    const apiKey = entry.secret ? this.#decrypt(entry.secret, engine) : undefined
    return { baseURL: entry.baseURL, ...(apiKey ? { apiKey } : {}) }
  }

  #decrypt(secret: string, engine: string): string | undefined {
    try {
      return decryptPayload(this.#keyBuffer(), secret)
    } catch {
      this.#log.warn(`model key for ${engine} could not be decrypted`)
      return undefined
    }
  }

  /** Same file and format the account vault uses: one data directory, one local secret. */
  #keyBuffer(): Buffer {
    return loadOrCreateSecretKey(this.#keyPath, {
      onCreate: (path) => this.#log.info(`model key created at ${path}`),
    })
  }

  all(): Record<string, CustomAgentModel[]> {
    const out: Record<string, CustomAgentModel[]> = {}
    for (const [engine, list] of Object.entries(this.#load())) {
      out[engine] = list.map(toPublicModel)
    }
    return out
  }

  list(engine: string): CustomAgentModel[] {
    const loaded = this.#load()
    return (Object.hasOwn(loaded, engine) ? loaded[engine]! : []).map(toPublicModel)
  }

  add(engine: string, model: CustomAgentModel & { apiKey?: string }): CustomAgentModel[] {
    const value = model.value.trim().slice(0, VALUE_MAX)
    const label = model.label.trim().slice(0, LABEL_MAX) || value
    if (!value) throw new Error("模型 ID 不能为空")
    if (value.startsWith("-") || /\s/.test(value) || CONTROL_CHARS.test(value)) {
      throw new Error("模型 ID 不能以 - 开头或包含空白/控制字符")
    }
    const baseURL = model.baseURL?.trim() ? validateModelBaseUrl(model.baseURL) : undefined
    const entry: StoredCustomAgentModel = { value, label }
    if (baseURL) entry.baseURL = baseURL
    // Only the URL without a key is meaningless, so a key is stored next to it, encrypted
    if (baseURL && model.apiKey) entry.secret = encryptPayload(this.#keyBuffer(), model.apiKey)
    return this.#mutate((data) => {
      const current = Object.hasOwn(data, engine) ? data[engine]! : []
      // Re-adding the same value updates its label instead of creating a duplicate entry
      const next = [...current.filter((item) => item.value !== value), entry].slice(-MAX_PER_ENGINE)
      data[engine] = next
      return { result: next.map(toPublicModel), changed: true }
    })
  }

  remove(engine: string, value: string): boolean {
    return this.#mutate((data) => {
      const current = Object.hasOwn(data, engine) ? data[engine]! : []
      const next = current.filter((entry) => entry.value !== value)
      if (next.length === current.length) return { result: false, changed: false }
      if (next.length > 0) data[engine] = next
      else delete data[engine]
      return { result: true, changed: true }
    })
  }

  /**
   * One read-modify-write under the cross-process lock. The bot and the App each hold their
   * own store over this file, and an unlocked load-then-save let the later writer erase a model
   * the other had just added. Reading inside the lock makes each edit apply to the latest file.
   */
  #mutate<T>(
    fn: (data: Record<string, StoredCustomAgentModel[]>) => { result: T; changed: boolean },
  ): T {
    return withFileLock(this.#path, () => {
      const data = this.#load()
      const { result, changed } = fn(data)
      if (changed) this.#save(data)
      return result
    })
  }

  #load(): Record<string, StoredCustomAgentModel[]> {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    const engines = asRecord(raw?.engines)
    const result = Object.create(null) as Record<string, StoredCustomAgentModel[]>
    if (!engines) return result
    for (const [engine, entries] of Object.entries(engines)) {
      if (!Array.isArray(entries)) continue
      const models: StoredCustomAgentModel[] = []
      for (const entry of entries) {
        const record = asRecord(entry)
        const value = typeof record?.value === "string" ? record.value.trim() : ""
        if (!value) continue
        const model: StoredCustomAgentModel = {
          value,
          label: typeof record?.label === "string" && record.label ? record.label : value,
        }
        if (typeof record?.baseURL === "string" && record.baseURL) model.baseURL = record.baseURL
        if (typeof record?.secret === "string" && record.secret) model.secret = record.secret
        models.push(model)
      }
      if (models.length > 0) result[engine] = models.slice(-MAX_PER_ENGINE)
    }
    return result
  }

  #save(data: Record<string, StoredCustomAgentModel[]>): void {
    writePrivateAtomic(
      this.#path,
      `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), engines: data }, null, 2)}\n`,
      // Per-process temp name: two writers must never share (and clobber) one staging file
      `${this.#path}.${process.pid}.tmp`,
    )
  }
}
