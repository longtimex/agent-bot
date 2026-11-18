import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { decryptPayload, encryptPayload } from "./apiCrypto.js"
import { withFileLock } from "./fileLock.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"

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

/** A model's own endpoint plus its decrypted key, ready to become env vars. */
export interface CustomModelEndpoint {
  baseURL: string
  apiKey?: string
}

const MAX_PER_ENGINE = 40
const VALUE_MAX = 120
const LABEL_MAX = 60

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
    const entry = this.#load()[engine]?.find((model) => model.value === value)
    if (!entry?.baseURL) return undefined
    const secret = (entry as CustomAgentModel & { secret?: string }).secret
    const apiKey = secret ? this.#decrypt(secret, engine) : undefined
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
    if (existsSync(this.#keyPath)) {
      const raw = readFileSync(this.#keyPath, "utf8").trim()
      if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
      throw new Error(`账号密钥 ${this.#keyPath} 格式无效，请从备份恢复该文件。`)
    }
    return withFileLock(this.#keyPath, () => {
      if (existsSync(this.#keyPath)) {
        const raw = readFileSync(this.#keyPath, "utf8").trim()
        if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
      }
      mkdirSync(dirname(this.#keyPath), { recursive: true })
      const key = randomBytes(32)
      writeFileSync(this.#keyPath, `${key.toString("hex")}\n`, { mode: 0o600 })
      this.#log.info(`model key created at ${this.#keyPath}`)
      return key
    })
  }

  all(): Record<string, CustomAgentModel[]> {
    return this.#load()
  }

  list(engine: string): CustomAgentModel[] {
    return this.#load()[engine] ?? []
  }

  add(engine: string, model: CustomAgentModel & { apiKey?: string }): CustomAgentModel[] {
    const value = model.value.trim().slice(0, VALUE_MAX)
    const label = model.label.trim().slice(0, LABEL_MAX) || value
    if (!value) throw new Error("模型 ID 不能为空")
    const baseURL = model.baseURL?.trim()
    const entry: CustomAgentModel & { secret?: string } = { value, label }
    if (baseURL) entry.baseURL = baseURL
    // Only the URL without a key is meaningless, so a key is stored next to it, encrypted
    if (baseURL && model.apiKey) entry.secret = encryptPayload(this.#keyBuffer(), model.apiKey)
    const data = this.#load()
    const current = data[engine] ?? []
    // Re-adding the same value updates its label instead of creating a duplicate entry
    const next = [...current.filter((entry) => entry.value !== value), entry].slice(-MAX_PER_ENGINE)
    data[engine] = next
    this.#save(data)
    return next
  }

  remove(engine: string, value: string): boolean {
    const data = this.#load()
    const current = data[engine] ?? []
    const next = current.filter((entry) => entry.value !== value)
    if (next.length === current.length) return false
    if (next.length > 0) data[engine] = next
    else delete data[engine]
    this.#save(data)
    return true
  }

  #load(): Record<string, CustomAgentModel[]> {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    const engines = asRecord(raw?.engines)
    if (!engines) return {}
    const result: Record<string, CustomAgentModel[]> = {}
    for (const [engine, entries] of Object.entries(engines)) {
      if (!Array.isArray(entries)) continue
      const models: CustomAgentModel[] = []
      for (const entry of entries) {
        const record = asRecord(entry)
        const value = typeof record?.value === "string" ? record.value.trim() : ""
        if (!value) continue
        const model: CustomAgentModel & { secret?: string } = {
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

  #save(data: Record<string, CustomAgentModel[]>): void {
    writePrivateAtomic(
      this.#path,
      `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), engines: data }, null, 2)}\n`,
    )
  }
}
