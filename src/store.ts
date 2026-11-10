import { isAbsolute } from "node:path"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { withFileLock } from "./lock.js"
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
    this.#change((data) => {
      const existing = data[key]
      if (!existing) return { changed: false, result: undefined }
      existing.sessionID = ""
      existing.updatedAt = new Date().toISOString()
      return { changed: true, result: undefined }
    })
  }

  set(key: string, sessionID: string): void {
    this.#change((data) => {
      const existing = data[key]
      data[key] = {
        ...existing,
        sessionID,
        updatedAt: new Date().toISOString(),
      }
      return { changed: true, result: undefined }
    })
  }

  getEngine(key: string): BackendEngine {
    return this.#data[key]?.engine || "opencode"
  }

  /** The engine the user (or a previous switch) actually chose, if any. */
  getExplicitEngine(key: string): BackendEngine | undefined {
    const engine = this.#data[key]?.engine?.trim()
    return engine ? engine : undefined
  }

  setEngine(key: string, engine: BackendEngine): void {
    this.#change((data) => {
      const existing = data[key]
      data[key] = {
        ...(existing ?? { sessionID: "" }),
        engine,
        updatedAt: new Date().toISOString(),
      }
      return { changed: true, result: undefined }
    })
  }

  getCliSession(key: string, engine: string): string | undefined {
    return ownValue(this.#data[key]?.cliSessions, engine)
  }

  setCliSession(key: string, engine: string, sessionID: string): void {
    this.#change((data) => {
      const existing = data[key] ?? { sessionID: "", updatedAt: "" }
      const cliSessions = cloneMap(existing.cliSessions)
      if (sessionID) cliSessions[engine] = sessionID
      else delete cliSessions[engine]
      data[key] = {
        ...existing,
        cliSessions,
        updatedAt: new Date().toISOString(),
      }
      return { changed: true, result: undefined }
    })
  }

  clearCliSession(key: string, engine: string): void {
    this.setCliSession(key, engine, "")
  }

  getCliModel(key: string, engine: string): string | undefined {
    return ownValue(this.#data[key]?.cliModels, engine)
  }

  setCliModel(key: string, engine: string, model: string): void {
    this.#change((data) => {
      const existing = data[key] ?? { sessionID: "", updatedAt: "" }
      const cliModels = cloneMap(existing.cliModels)
      if (model) cliModels[engine] = model
      else delete cliModels[engine]
      data[key] = {
        ...existing,
        cliModels,
        updatedAt: new Date().toISOString(),
      }
      return { changed: true, result: undefined }
    })
  }

  getModel(key: string): { providerID: string; modelID: string; label: string } | undefined {
    return this.#data[key]?.model
  }

  /** Working directory chosen with `/dir`, or undefined to use the Bot's own cwd. */
  getDir(key: string): string | undefined {
    return this.#data[key]?.dir
  }

  setDir(key: string, dir: string): void {
    this.#change((data) => {
      const existing = data[key] ?? { sessionID: "", updatedAt: "" }
      data[key] = { ...existing, dir, updatedAt: new Date().toISOString() }
      return { changed: true, result: undefined }
    })
  }

  clearDir(key: string): boolean {
    return this.#change((data) => {
      const existing = data[key]
      if (!existing?.dir) return { changed: false, result: false }
      delete existing.dir
      existing.updatedAt = new Date().toISOString()
      return { changed: true, result: true }
    })
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
    return this.#change((data) => {
      const existing = data[key]
      if (!existing?.model) return { changed: false, result: false }
      delete existing.model
      existing.updatedAt = new Date().toISOString()
      return { changed: true, result: true }
    })
  }

  setModel(key: string, model: { providerID: string; modelID: string; label: string }): void {
    this.#change((data) => {
      const existing = data[key]
      data[key] = {
        ...(existing ?? { sessionID: "" }),
        model,
        updatedAt: new Date().toISOString(),
      }
      return { changed: true, result: undefined }
    })
  }

  /**
   * Every mutation re-reads the file while holding a sibling lock, then writes the
   * merged result atomically. Without that transaction, a long-running Bot and
   * `npm run models -- del --force` could each save a stale full-file snapshot and
   * silently erase the other's chat record.
   */
  #change<T>(apply: (data: Record<string, SessionRecord>) => { changed: boolean; result: T }): T {
    return withFileLock(`${this.#path}.lock`, this.#log, () => {
      this.#data = this.#read()
      const outcome = apply(this.#data)
      if (outcome.changed) this.#save()
      return outcome.result
    })
  }

  #load(): void {
    this.#data = this.#read()
    this.#log.debug(`loaded ${Object.keys(this.#data).length} session(s) from ${this.#path}`)
  }

  #read(): Record<string, SessionRecord> {
    const data = emptyMap<SessionRecord>()
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message)) as
      | Record<string, SessionRecord>
      | undefined
    if (!parsed) return data
    try {
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value.sessionID !== "string") continue

        const cliSessions = sanitizeMap(value.cliSessions) ?? emptyMap<string>()
        const cliModels = sanitizeMap(value.cliModels) ?? emptyMap<string>()
        // Legacy flat qoder fields: only strings may enter maps that later feed CLI argv
        if (typeof value.qoderSessionID === "string") cliSessions.qoder ??= value.qoderSessionID
        if (typeof value.qoderModel === "string") cliModels.qoder ??= value.qoderModel

        // 空壳记录(sessionID 为空且无任何其他状态)不进内存:/new、恢复默认等操作
        // 会留下只剩 updatedAt 的记录,长期累积让 sessions.json 缓慢膨胀
        const record: SessionRecord = {
          sessionID: value.sessionID,
          engine: typeof value.engine === "string" && value.engine ? value.engine : undefined,
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
          model: sanitizeModel(value.model),
          dir: sanitizeDir(value.dir),
          cliSessions: Object.keys(cliSessions).length > 0 ? cliSessions : undefined,
          cliModels: Object.keys(cliModels).length > 0 ? cliModels : undefined,
        }
        const isShell =
          !record.sessionID &&
          !record.engine &&
          !record.model &&
          !record.dir &&
          !record.cliSessions &&
          !record.cliModels
        if (!isShell) data[key] = record
      }
      return data
    } catch (err) {
      this.#log.warn(`failed to read session store ${this.#path}:`, (err as Error).message)
      return data
    }
  }

  #save(): void {
    try {
      writePrivateAtomic(this.#path, JSON.stringify(this.#data, null, 2))
    } catch (err) {
      this.#log.warn("failed to persist session store:", (err as Error).message)
    }
  }
}
