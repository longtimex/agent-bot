import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "./logger.js"

export type BackendEngine = "opencode" | "qoder"

export interface SessionRecord {
  sessionID: string
  qoderSessionID?: string
  engine?: BackendEngine
  qoderModel?: string
  updatedAt: string
  model?: {
    providerID: string
    modelID: string
    label: string
  }
}

export class SessionStore {
  readonly #path: string
  readonly #log: Logger
  #data: Record<string, SessionRecord> = {}

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  get(key: string): string | undefined {
    return this.#data[key]?.sessionID
  }

  clearSession(key: string): void {
    const existing = this.#data[key]
    if (existing) {
      existing.sessionID = ""
      existing.updatedAt = new Date().toISOString()
      this.#save()
    }
  }

  set(key: string, sessionID: string): void {
    const existing = this.#data[key]
    this.#data[key] = {
      sessionID,
      qoderSessionID: existing?.qoderSessionID,
      engine: existing?.engine,
      qoderModel: existing?.qoderModel,
      updatedAt: new Date().toISOString(),
      model: existing?.model,
    }
    this.#save()
  }

  getQoderSessionID(key: string): string | undefined {
    return this.#data[key]?.qoderSessionID
  }

  setQoderSessionID(key: string, qoderSessionID: string): void {
    const existing = this.#data[key]
    if (existing) {
      existing.qoderSessionID = qoderSessionID
      existing.updatedAt = new Date().toISOString()
    } else {
      this.#data[key] = {
        sessionID: "",
        qoderSessionID,
        updatedAt: new Date().toISOString(),
      }
    }
    this.#save()
  }

  getEngine(key: string): BackendEngine {
    return this.#data[key]?.engine ?? "opencode"
  }

  setEngine(key: string, engine: BackendEngine): void {
    const existing = this.#data[key]
    if (existing) {
      existing.engine = engine
      existing.updatedAt = new Date().toISOString()
    } else {
      this.#data[key] = {
        sessionID: "",
        engine,
        updatedAt: new Date().toISOString(),
      }
    }
    this.#save()
  }

  getQoderModel(key: string): string | undefined {
    return this.#data[key]?.qoderModel
  }

  setQoderModel(key: string, qoderModel: string): void {
    const existing = this.#data[key]
    if (existing) {
      existing.qoderModel = qoderModel
      existing.updatedAt = new Date().toISOString()
    } else {
      this.#data[key] = {
        sessionID: "",
        qoderModel,
        updatedAt: new Date().toISOString(),
      }
    }
    this.#save()
  }

  getModel(key: string): { providerID: string; modelID: string; label: string } | undefined {
    return this.#data[key]?.model
  }

  setModel(key: string, model: { providerID: string; modelID: string; label: string }): void {
    const existing = this.#data[key]
    if (existing) {
      existing.model = model
      existing.updatedAt = new Date().toISOString()
    } else {
      this.#data[key] = {
        sessionID: "",
        updatedAt: new Date().toISOString(),
        model,
      }
    }
    this.#save()
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, SessionRecord>
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value.sessionID === "string") {
          this.#data[key] = value
        }
      }
      this.#log.debug(`loaded ${Object.keys(this.#data).length} session(s) from ${this.#path}`)
    } catch (err) {
      this.#log.warn(`failed to read session store ${this.#path}:`, (err as Error).message)
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.#data, null, 2))
      renameSync(tmp, this.#path)
    } catch (err) {
      this.#log.warn("failed to persist session store:", (err as Error).message)
    }
  }
}
