import { randomBytes } from "node:crypto"
import { withFileLock } from "./fileLock.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import type { Opencode } from "./opencode.js"
import type { BackendEngine, SessionStore } from "./store.js"

/**
 * Past conversations a chat can switch back to.
 *
 * 新建会话 used to delete the OpenCode session (or drop the CLI's session id), so the old
 * context was gone for good. It is now parked here instead: engine, the engine's own session
 * id and the model it ran with. Resuming puts those back, and because the engine still holds
 * the session the Agent remembers the conversation. Only the newest entries per chat are kept;
 * an evicted OpenCode session is returned so the caller can delete it on the server.
 */
export const MAX_ARCHIVED_SESSIONS = 20
const TITLE_MAX = 60
const ID_RE = /^[0-9a-f]{12}$/

export interface ArchivedSession {
  id: string
  engine: BackendEngine
  /** OpenCode session id, or the CLI's own resume id. */
  sessionID: string
  title?: string
  /** OpenCode model the session ran with. */
  model?: { providerID: string; modelID: string; label: string }
  /** CLI model the session ran with. */
  cliModel?: string
  archivedAt: number
}

export type ArchiveInput = Omit<ArchivedSession, "id" | "archivedAt">

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return text ? text.slice(0, TITLE_MAX) : undefined
}

function sanitize(value: unknown): ArchivedSession | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !ID_RE.test(record.id)) return undefined
  if (typeof record.engine !== "string" || !record.engine) return undefined
  if (typeof record.sessionID !== "string" || !record.sessionID) return undefined
  if (typeof record.archivedAt !== "number" || !Number.isFinite(record.archivedAt)) return undefined
  const entry: ArchivedSession = {
    id: record.id,
    engine: record.engine,
    sessionID: record.sessionID,
    archivedAt: record.archivedAt,
  }
  const title = cleanTitle(record.title)
  if (title) entry.title = title
  const model = record.model as Record<string, unknown> | undefined
  if (model && typeof model.providerID === "string" && typeof model.modelID === "string") {
    entry.model = {
      providerID: model.providerID,
      modelID: model.modelID,
      label: typeof model.label === "string" && model.label ? model.label : model.modelID,
    }
  }
  if (typeof record.cliModel === "string" && record.cliModel) entry.cliModel = record.cliModel
  return entry
}

export class SessionArchiveStore {
  readonly #path: string
  readonly #log: Logger
  readonly #now: () => number

  constructor(path: string, log: Logger, now: () => number = Date.now) {
    this.#path = path
    this.#log = log
    this.#now = now
  }

  /** Newest first. */
  list(key: string): ArchivedSession[] {
    return [...(this.#read()[key] ?? [])].sort((a, b) => b.archivedAt - a.archivedAt)
  }

  get(key: string, id: string): ArchivedSession | undefined {
    return this.#read()[key]?.find((entry) => entry.id === id)
  }

  /** Parks a session; the same engine session archived twice keeps one entry, the newest. */
  add(key: string, input: ArchiveInput): { added: ArchivedSession; evicted: ArchivedSession[] } {
    return this.#change((data) => {
      const added: ArchivedSession = {
        ...input,
        title: cleanTitle(input.title),
        id: randomBytes(6).toString("hex"),
        archivedAt: this.#now(),
      }
      if (!added.title) delete added.title
      const rest = (data[key] ?? []).filter(
        (entry) => !(entry.engine === input.engine && entry.sessionID === input.sessionID),
      )
      const all = [...rest, added].sort((a, b) => b.archivedAt - a.archivedAt)
      data[key] = all.slice(0, MAX_ARCHIVED_SESSIONS)
      return { added, evicted: all.slice(MAX_ARCHIVED_SESSIONS) }
    })
  }

  remove(key: string, id: string): ArchivedSession | undefined {
    return this.#change((data) => {
      const entries = data[key] ?? []
      const found = entries.find((entry) => entry.id === id)
      if (!found) return undefined
      const rest = entries.filter((entry) => entry.id !== id)
      if (rest.length > 0) data[key] = rest
      else delete data[key]
      return found
    })
  }

  #change<T>(fn: (data: Record<string, ArchivedSession[]>) => T): T {
    return withFileLock(this.#path, () => {
      const data = this.#read()
      const result = fn(data)
      writePrivateAtomic(
        this.#path,
        `${JSON.stringify({ version: 1, chats: data }, null, 2)}\n`,
        `${this.#path}.${process.pid}.tmp`,
      )
      return result
    })
  }

  #read(): Record<string, ArchivedSession[]> {
    const data = Object.create(null) as Record<string, ArchivedSession[]>
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    const chats = raw?.chats
    if (!chats || typeof chats !== "object") return data
    for (const [key, value] of Object.entries(chats as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const entries = value.map(sanitize).filter((entry): entry is ArchivedSession => entry !== undefined)
      if (entries.length > 0) data[key] = entries.slice(0, MAX_ARCHIVED_SESSIONS)
    }
    return data
  }
}

/**
 * Parks a chat's live session instead of deleting it. Shared by the App's POST /new and
 * Telegram's /new so both ends archive the same way. Returns undefined when there is no
 * context to keep; an OpenCode session pushed past the cap is deleted on the server, which is
 * the only place its disk space is reclaimed.
 */
export async function archiveLiveSession(
  store: SessionStore,
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  title?: string,
): Promise<ArchivedSession | undefined> {
  const engine = store.getEngine(key)
  const opencode = engine === "opencode"
  const sessionID = opencode ? store.get(key) : store.getCliSession(key, engine)
  if (!sessionID) return undefined
  const model = opencode ? store.getModel(key) : undefined
  const cliModel = opencode ? undefined : store.getCliModel(key, engine)
  const { added, evicted } = archive.add(key, {
    engine,
    sessionID,
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(cliModel ? { cliModel } : {}),
  })
  if (opencode) store.clearSession(key)
  else store.clearCliSession(key, engine)
  for (const old of evicted) {
    if (old.engine === "opencode") await oc.deleteSession(old.sessionID).catch(() => {})
  }
  return added
}

/**
 * Switches a chat back to a parked session; the open one is parked in its place. The target is
 * taken out of the archive first, so parking the open session can never evict it.
 */
export async function resumeArchivedSession(
  store: SessionStore,
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  id: string,
): Promise<{ target: ArchivedSession; parked?: ArchivedSession } | undefined> {
  const target = archive.remove(key, id)
  if (!target) return undefined
  const parked = await archiveLiveSession(store, archive, oc, key)
  store.setEngine(key, target.engine)
  if (target.engine === "opencode") {
    store.set(key, target.sessionID)
    if (target.model) store.setModel(key, target.model)
    else store.clearModel(key)
  } else {
    store.setCliSession(key, target.engine, target.sessionID)
    store.setCliModel(key, target.engine, target.cliModel ?? "")
  }
  return { target, ...(parked ? { parked } : {}) }
}

/**
 * Uploads live in data/inbox for INBOX_RETENTION_MS. A session parked longer than that can still
 * be resumed, but the files its context points at are gone, so the Agent would answer "不存在"
 * to a question about them. Undefined while they can still be on disk.
 */
export function staleAttachmentNotice(entry: ArchivedSession, retentionMs: number, now = Date.now()): string | undefined {
  if (now - entry.archivedAt <= retentionMs) return undefined
  const hours = Math.round(retentionMs / 3_600_000)
  return `这个会话存入已超过 ${hours} 小时，当时发送的附件已被自动清理；如需 Agent 再看，请重新发送。`
}

/** Deletes a parked session, and its OpenCode context with it. */
export async function deleteArchivedSession(
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  id: string,
): Promise<boolean> {
  const removed = archive.remove(key, id)
  if (!removed) return false
  if (removed.engine === "opencode") await oc.deleteSession(removed.sessionID).catch(() => {})
  return true
}
