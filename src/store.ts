import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { readJsonObject } from "./jsonStore.js"
import type { Logger } from "./logger.js"

/** Engine ids are dynamic: `opencode`, `qoder`, `claude`, or any custom profile. */
export type BackendEngine = string

export interface SessionRecord {
  sessionID: string
  engine?: BackendEngine
  updatedAt: string
  model?: {
    providerID: string
    modelID: string
    label: string
  }
  cliSessions?: Record<string, string>
  cliModels?: Record<string, string>
  /** Per-chat working directory for CLI engines; absent means the Bot's own cwd. */
  dir?: string
  /** Legacy fields kept only for one-time migration from the Qoder-only version. */
  qoderSessionID?: string
  qoderModel?: string
}

/**
 * Null-prototype maps: chat keys come from the data file and engine ids from
 * user-managed profiles, so an inherited name such as "constructor" or
 * "__proto__" must neither read back as stored state nor replace the prototype.
 */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function cloneMap(map: Record<string, string> | undefined): Record<string, string> {
  return Object.assign(emptyMap<string>(), map ?? {})
}

function sanitizeMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined
  const map = emptyMap<string>()
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw) map[key] = raw
  }
  return map
}

const MAX_DIR_CHARS = 512

/** Only an absolute, control-character-free path is accepted back from disk. */
function sanitizeDir(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (!isAbsolute(text) || text.length > MAX_DIR_CHARS || /[\u0000-\u001f\u007f]/.test(text)) return undefined
  return text
}

function sanitizeModel(value: unknown): SessionRecord["model"] | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.providerID !== "string" || !record.providerID) return undefined
  if (typeof record.modelID !== "string" || !record.modelID) return undefined
  return {
    providerID: record.providerID,
    modelID: record.modelID,
    label: typeof record.label === "string" && record.label ? record.label : record.modelID,
  }
}

/**
 * Own-property read for the per-engine maps. Engine ids come from user input,
 * so an inherited name such as "constructor" must not resolve to a prototype value.
 */
function ownValue(map: Record<string, string> | undefined, engine: string): string | undefined {
  return map && Object.hasOwn(map, engine) ? map[engine] : undefined
}

export class SessionStore {
  readonly #path: string
  readonly #log: Logger
  #data: Record<string, SessionRecord> = emptyMap<SessionRecord>()

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
      ...existing,
      sessionID,
      updatedAt: new Date().toISOString(),
    }
    this.#save()
  }

  getEngine(key: string): BackendEngine {
    return this.#data[key]?.engine || "opencode"
  }

  setEngine(key: string, engine: BackendEngine): void {
    const existing = this.#data[key]
    this.#data[key] = {
      ...(existing ?? { sessionID: "" }),
      engine,
      updatedAt: new Date().toISOString(),
    }
    this.#save()
  }

  getCliSession(key: string, engine: string): string | undefined {
    return ownValue(this.#data[key]?.cliSessions, engine)
  }

  setCliSession(key: string, engine: string, sessionID: string): void {
    const existing = this.#data[key] ?? { sessionID: "", updatedAt: "" }
    const cliSessions = cloneMap(existing.cliSessions)
    if (sessionID) cliSessions[engine] = sessionID
    else delete cliSessions[engine]
    this.#data[key] = {
      ...existing,
      cliSessions,
      updatedAt: new Date().toISOString(),
    }
    this.#save()
  }

  clearCliSession(key: string, engine: string): void {
    this.setCliSession(key, engine, "")
  }

  getCliModel(key: string, engine: string): string | undefined {
    return ownValue(this.#data[key]?.cliModels, engine)
  }

  setCliModel(key: string, engine: string, model: string): void {
    const existing = this.#data[key] ?? { sessionID: "", updatedAt: "" }
    const cliModels = cloneMap(existing.cliModels)
    if (model) cliModels[engine] = model
    else delete cliModels[engine]
    this.#data[key] = {
      ...existing,
      cliModels,
      updatedAt: new Date().toISOString(),
    }
    this.#save()
  }

  getModel(key: string): { providerID: string; modelID: string; label: string } | undefined {
    return this.#data[key]?.model
  }

  /** Working directory chosen with `/dir`, or undefined to use the Bot's own cwd. */
  getDir(key: string): string | undefined {
    return this.#data[key]?.dir
  }

  setDir(key: string, dir: string): void {
    const existing = this.#data[key] ?? { sessionID: "", updatedAt: "" }
    this.#data[key] = { ...existing, dir, updatedAt: new Date().toISOString() }
    this.#save()
  }

  clearDir(key: string): boolean {
    const existing = this.#data[key]
    if (!existing?.dir) return false
    delete existing.dir
    existing.updatedAt = new Date().toISOString()
    this.#save()
    return true
  }

  /** Every chat-level model selection, so deleting a model can find who still points at it. */
  listModelRefs(): Array<{ key: string; providerID: string; modelID: string }> {
    const refs: Array<{ key: string; providerID: string; modelID: string }> = []
    for (const [key, record] of Object.entries(this.#data)) {
      if (record?.model) refs.push({ key, providerID: record.model.providerID, modelID: record.model.modelID })
    }
    return refs
  }

  clearModel(key: string): boolean {
    const existing = this.#data[key]
    if (!existing?.model) return false
    delete existing.model
    existing.updatedAt = new Date().toISOString()
    this.#save()
    return true
  }

  setModel(key: string, model: { providerID: string; modelID: string; label: string }): void {
    const existing = this.#data[key]
    this.#data[key] = {
      ...(existing ?? { sessionID: "" }),
      model,
      updatedAt: new Date().toISOString(),
    }
    this.#save()
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message)) as
      | Record<string, SessionRecord>
      | undefined
    if (!parsed) return
    try {
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value.sessionID !== "string") continue

        const cliSessions = sanitizeMap(value.cliSessions) ?? emptyMap<string>()
        const cliModels = sanitizeMap(value.cliModels) ?? emptyMap<string>()
        // Legacy flat qoder fields: only strings may enter maps that later feed CLI argv
        if (typeof value.qoderSessionID === "string") cliSessions.qoder ??= value.qoderSessionID
        if (typeof value.qoderModel === "string") cliModels.qoder ??= value.qoderModel

        this.#data[key] = {
          sessionID: value.sessionID,
          engine: typeof value.engine === "string" && value.engine ? value.engine : undefined,
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
          model: sanitizeModel(value.model),
          dir: sanitizeDir(value.dir),
          cliSessions: Object.keys(cliSessions).length > 0 ? cliSessions : undefined,
          cliModels: Object.keys(cliModels).length > 0 ? cliModels : undefined,
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
      writeFileSync(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 })
      renameSync(tmp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn("failed to persist session store:", (err as Error).message)
    }
  }
}
