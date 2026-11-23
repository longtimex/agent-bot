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
  /**
   * OpenCode session id, or the CLI's own resume id. Absent when the conversation never got one
   * (a stateless CLI, or no run succeeded): the entry still lists, so the App can bring back its
   * bubbles, but resuming it starts the engine fresh.
   */
  sessionID?: string
  title?: string
  /** OpenCode model the session ran with. */
  model?: { providerID: string; modelID: string; label: string }
  /** CLI model the session ran with. */
  cliModel?: string
  archivedAt: number
  /** Listed first and never evicted by the 20-entry cap. */
  pinned?: boolean
}

export type ArchiveInput = Omit<ArchivedSession, "id" | "archivedAt" | "pinned">

/** Pinned first, then newest first: the order every list and the cap work in. */
function rank(a: ArchivedSession, b: ArchivedSession): number {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.archivedAt - a.archivedAt
}

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
  if (record.sessionID !== undefined && (typeof record.sessionID !== "string" || !record.sessionID)) return undefined
  if (typeof record.archivedAt !== "number" || !Number.isFinite(record.archivedAt)) return undefined
  const entry: ArchivedSession = { id: record.id, engine: record.engine, archivedAt: record.archivedAt }
  if (typeof record.sessionID === "string") entry.sessionID = record.sessionID
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
  if (record.pinned === true) entry.pinned = true
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

  /** Pinned first, then newest first. */
  list(key: string): ArchivedSession[] {
    return [...(this.#read()[key] ?? [])].sort(rank)
  }

  /** Renames (an empty title clears it) or pins/unpins an entry. */
  update(key: string, id: string, patch: { title?: string | null; pinned?: boolean }): ArchivedSession | undefined {
    return this.#change((data) => {
      const entry = data[key]?.find((item) => item.id === id)
      if (!entry) return undefined
      if (patch.title !== undefined) {
        const title = cleanTitle(patch.title)
        if (title) entry.title = title
        else delete entry.title
      }
      if (patch.pinned !== undefined) {
        if (patch.pinned) entry.pinned = true
        else delete entry.pinned
      }
      return { ...entry }
    })
  }

  get(key: string, id: string): ArchivedSession | undefined {
    return this.#read()[key]?.find((entry) => entry.id === id)
  }

  /** Parks a session; the same engine session archived twice keeps one entry, the newest. */
  add(key: string, input: ArchiveInput): { added: ArchivedSession; evicted: ArchivedSession[] } {
    return this.park(key, undefined, input)
  }

  /**
   * Parks a conversation. A conversation that was itself resumed from the archive updates its own
   * entry (`id`) instead of adding a second one, which is what made switching back and forth look
   * like a single entry swapping places. `protect` is never evicted: it is the entry about to be
   * resumed.
   */
  park(
    key: string,
    id: string | undefined,
    input: ArchiveInput,
    protect?: string,
  ): { added: ArchivedSession; evicted: ArchivedSession[] } {
    return this.#change((data) => {
      const entries = data[key] ?? []
      const own = id ? entries.find((entry) => entry.id === id) : undefined
      const added: ArchivedSession = {
        ...input,
        id: own?.id ?? randomBytes(6).toString("hex"),
        archivedAt: this.#now(),
      }
      const title = cleanTitle(input.title) ?? own?.title
      if (title) added.title = title
      else delete added.title
      if (!added.sessionID) delete added.sessionID
      // Parking a resumed conversation again must not unpin it
      if (own?.pinned) added.pinned = true
      const rest = entries.filter(
        (entry) =>
          entry.id !== added.id &&
          !(added.sessionID && entry.engine === added.engine && entry.sessionID === added.sessionID),
      )
      // Ranked, so the cap evicts the oldest unpinned entries and a pin is kept
      const all = [...rest, added].sort(rank)
      const kept = all.slice(0, MAX_ARCHIVED_SESSIONS)
      const evicted = all.slice(MAX_ARCHIVED_SESSIONS)
      const saved = protect ? evicted.findIndex((entry) => entry.id === protect) : -1
      if (saved >= 0) {
        // Drop the oldest unprotected entry in its place
        const victim = [...kept].reverse().find((entry) => entry.id !== protect && entry.id !== added.id && !entry.pinned)
        if (victim) {
          kept.splice(kept.indexOf(victim), 1)
          evicted.splice(saved, 1, victim)
          kept.push(all.find((entry) => entry.id === protect)!)
        }
      }
      data[key] = kept.sort(rank)
      return { added, evicted }
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
 * Parks a chat's live conversation instead of deleting it. Shared by the App's POST /new and
 * Telegram's /new so both ends archive the same way.
 *
 * The title comes from the conversation itself (recorded on its first prompt), so every path
 * that parks it names it. A conversation with no engine session is still parked when it has a
 * title: the App keeps its bubbles under the entry. An OpenCode session pushed past the cap is
 * deleted on the server, which is the only place its disk space is reclaimed.
 */
export async function archiveLiveSession(
  store: SessionStore,
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  titleHint?: string,
  protect?: string,
): Promise<ArchivedSession | undefined> {
  const engine = store.getEngine(key)
  const opencode = engine === "opencode"
  const sessionID = opencode ? store.get(key) : store.getCliSession(key, engine)
  const title = store.getTitle(key) ?? titleHint
  const liveId = store.getArchiveId(key)
  if (!sessionID && !title && !liveId) return undefined
  const model = opencode ? store.getModel(key) : undefined
  const cliModel = opencode ? undefined : store.getCliModel(key, engine)
  const { added, evicted } = archive.park(
    key,
    liveId,
    {
      engine,
      ...(sessionID ? { sessionID } : {}),
      ...(title ? { title } : {}),
      ...(model ? { model } : {}),
      ...(cliModel ? { cliModel } : {}),
    },
    protect,
  )
  if (sessionID) {
    if (opencode) store.clearSession(key)
    else store.clearCliSession(key, engine)
  }
  for (const old of evicted) {
    if (old.engine === "opencode" && old.sessionID) await oc.deleteSession(old.sessionID).catch(() => {})
  }
  return added
}

/** A new conversation: the open one is parked, and the chat forgets its title and archive id. */
export async function startNewConversation(
  store: SessionStore,
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  titleHint?: string,
): Promise<ArchivedSession | undefined> {
  const parked = await archiveLiveSession(store, archive, oc, key, titleHint)
  store.setConversation(key, {})
  return parked
}

/**
 * Switches a chat back to a parked conversation. The entry stays in the list, marked as the
 * live one, and the open conversation is parked beside it, so both remain to switch between.
 */
export async function resumeArchivedSession(
  store: SessionStore,
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  id: string,
): Promise<{ target: ArchivedSession; parked?: ArchivedSession; alreadyCurrent?: boolean } | undefined> {
  const target = archive.get(key, id)
  if (!target) return undefined
  if (store.getArchiveId(key) === id) return { target, alreadyCurrent: true }
  const parked = await archiveLiveSession(store, archive, oc, key, undefined, id)
  store.setEngine(key, target.engine)
  if (target.engine === "opencode") {
    if (target.sessionID) store.set(key, target.sessionID)
    else store.clearSession(key)
    if (target.model) store.setModel(key, target.model)
    else store.clearModel(key)
  } else {
    store.setCliSession(key, target.engine, target.sessionID ?? "")
    store.setCliModel(key, target.engine, target.cliModel ?? "")
  }
  store.setConversation(key, { ...(target.title ? { title: target.title } : {}), archiveId: target.id })
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

/**
 * Renames or pins an entry. Renaming the open conversation's own entry also renames the
 * conversation, otherwise the next park would put back the title it had before.
 */
export function updateArchivedSession(
  store: SessionStore,
  archive: SessionArchiveStore,
  key: string,
  id: string,
  patch: { title?: string | null; pinned?: boolean },
): ArchivedSession | undefined {
  const updated = archive.update(key, id, patch)
  if (updated && patch.title !== undefined && store.getArchiveId(key) === id) store.setTitle(key, updated.title)
  return updated
}

/** Deletes a parked session, and its OpenCode context with it. */
export async function deleteArchivedSession(
  archive: SessionArchiveStore,
  oc: Pick<Opencode, "deleteSession">,
  key: string,
  id: string,
  store?: SessionStore,
): Promise<boolean> {
  const removed = archive.remove(key, id)
  if (!removed) return false
  // The live conversation's entry only goes from the list: its engine session is still in use
  if (store && store.getArchiveId(key) === id) {
    const title = store.getTitle(key)
    store.setConversation(key, title ? { title } : {})
    return true
  }
  if (removed.engine === "opencode" && removed.sessionID) await oc.deleteSession(removed.sessionID).catch(() => {})
  return true
}
