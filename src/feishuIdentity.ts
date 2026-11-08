import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"

const STATE_VERSION = 1
/**
 * Feishu identities use a private negative namespace. Telegram private chats
 * are positive, so the two transports can never alias one another even when a
 * real Telegram id happens to fall in the old 2_000_000_000+ range.
 */
const MIN_FEISHU_ID = -2_147_483_648
const FIRST_FEISHU_ID = -2_000_000_000
const MAX_FEISHU_ID = -1

interface IdentityRecord {
  kind: "user" | "chat"
  externalId: string
  numericId: number
  updatedAt: string
  /** For a chat record, the Feishu user who is allowed to own its scheduled pushes. */
  ownerNumericId?: number
}

interface IdentityFile {
  version: number
  nextId: number
  users: Record<string, IdentityRecord>
  chats: Record<string, IdentityRecord>
}

export interface FeishuIdentityState {
  users: Record<string, IdentityRecord>
  chats: Record<string, IdentityRecord>
  nextId: number
}

function defaultState(): IdentityFile {
  return { version: STATE_VERSION, nextId: FIRST_FEISHU_ID, users: {}, chats: {} }
}

function sanitizeRecord(value: unknown, kind: IdentityRecord["kind"]): IdentityRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== kind || typeof record.externalId !== "string" || !record.externalId) return undefined
  if (!Number.isInteger(record.numericId) || !isFeishuNumericId(record.numericId as number)) {
    return undefined
  }
  const sanitized: IdentityRecord = {
    kind,
    externalId: record.externalId,
    numericId: record.numericId as number,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
  }
  if (kind === "chat" && Number.isInteger(record.ownerNumericId) && isFeishuNumericId(record.ownerNumericId as number)) {
    sanitized.ownerNumericId = record.ownerNumericId as number
  }
  return sanitized
}

/**
 * Maps opaque Feishu open_id/chat_id values onto stable numeric IDs. Reminder,
 * schedule, session and usage stores are keyed by number, so assigning each
 * external identity a persisted number keeps every existing store format and
 * migration untouched. Users and chats have separate namespaces because one
 * Feishu open_id may own a p2p chat whose chat_id is a different value.
 */
export class FeishuIdentityStore {
  readonly #path: string
  readonly #log: Logger
  readonly #state: IdentityFile
  readonly #byNumeric = new Map<number, IdentityRecord>()

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#state = this.#load()
    for (const record of [...Object.values(this.#state.users), ...Object.values(this.#state.chats)]) {
      this.#byNumeric.set(record.numericId, record)
    }
  }

  #load(): IdentityFile {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message)) as Partial<IdentityFile> | undefined
    if (!raw) return defaultState()
    const state = defaultState()
    let nextId =
      Number.isInteger(raw.nextId) && isFeishuNumericId(raw.nextId as number) ? (raw.nextId as number) : FIRST_FEISHU_ID
    const used = new Set<number>()
    for (const kind of ["users", "chats"] as const) {
      const source = raw[kind] && typeof raw[kind] === "object" ? raw[kind] : {}
      for (const [externalId, candidate] of Object.entries(source)) {
        const record = sanitizeRecord(candidate, kind === "users" ? "user" : "chat")
        if (!record || record.externalId !== externalId || used.has(record.numericId)) continue
        used.add(record.numericId)
        state[kind][externalId] = record
        nextId = Math.max(nextId, record.numericId + 1)
      }
    }
    state.nextId = nextId > MAX_FEISHU_ID ? MAX_FEISHU_ID + 1 : nextId
    return state
  }

  #allocate(kind: IdentityRecord["kind"], externalId: string): IdentityRecord {
    let numericId = this.#state.nextId
    if (numericId > MAX_FEISHU_ID) {
      // A reclaim pass cannot reuse a live ID, but old IDs that were removed from the
      // whitelist may still be free. Fail loudly if the range is actually exhausted.
      for (let candidate = FIRST_FEISHU_ID; candidate <= MAX_FEISHU_ID; candidate++) {
        if (!this.#byNumeric.has(candidate)) {
          numericId = candidate
          break
        }
      }
      if (numericId > MAX_FEISHU_ID) throw new Error("飞书身份编号已耗尽")
    }
    const record: IdentityRecord = { kind, externalId, numericId, updatedAt: new Date().toISOString() }
    const bucket = kind === "user" ? this.#state.users : this.#state.chats
    bucket[externalId] = record
    this.#byNumeric.set(numericId, record)
    this.#state.nextId = Math.max(this.#state.nextId, numericId + 1)
    this.#save()
    return record
  }

  #save(): void {
    const file: IdentityFile = {
      version: STATE_VERSION,
      nextId: this.#state.nextId,
      users: this.#state.users,
      chats: this.#state.chats,
    }
    try {
      writePrivateAtomic(this.#path, JSON.stringify(file, null, 2))
    } catch (err) {
      this.#log.warn(`failed to save Feishu identity map: ${(err as Error).message}`)
    }
  }

  user(openId: string): number {
    return this.#for("user", openId)
  }

  chat(chatId: string): number {
    return this.#for("chat", chatId)
  }

  /**
   * Persists the first whitelisted Feishu chat as the owner target. Keeping the
   * relation in the identity file means a restart does not lose the owner while
   * the process is waiting for the next inbound message.
   */
  bindOwner(chatId: string, ownerNumericId: number): void {
    if (!chatId || !Number.isInteger(ownerNumericId) || !isFeishuNumericId(ownerNumericId)) return
    const record = this.#state.chats[chatId] ?? this.#allocate("chat", chatId)
    if (record.ownerNumericId === ownerNumericId) return
    // First whitelisted chat wins; switching the daily report every time a
    // second user messages the bot would make delivery unpredictable.
    if (record.ownerNumericId !== undefined) return
    record.ownerNumericId = ownerNumericId
    record.updatedAt = new Date().toISOString()
    this.#save()
  }

  ownerChatId(): number | undefined {
    for (const record of Object.values(this.#state.chats)) {
      if (record.ownerNumericId !== undefined) return record.numericId
    }
    return undefined
  }

  /** The user identity paired with the notification chat, not the chat's own id. */
  ownerUserId(): number | undefined {
    for (const record of Object.values(this.#state.chats)) {
      if (record.ownerNumericId !== undefined) return record.ownerNumericId
    }
    return undefined
  }

  #for(kind: IdentityRecord["kind"], externalId: string): number {
    if (!externalId) throw new Error(kind === "user" ? "缺少飞书 open_id" : "缺少飞书 chat_id")
    const bucket = kind === "user" ? this.#state.users : this.#state.chats
    return bucket[externalId]?.numericId ?? this.#allocate(kind, externalId).numericId
  }

  userOpenId(numericId: number): string | undefined {
    return this.#byNumeric.get(numericId)?.kind === "user" ? this.#byNumeric.get(numericId)?.externalId : undefined
  }

  chatOpenId(numericId: number): string | undefined {
    return this.#byNumeric.get(numericId)?.kind === "chat" ? this.#byNumeric.get(numericId)?.externalId : undefined
  }

  chatExternalId(numericId: number): string | undefined {
    const record = this.#byNumeric.get(numericId)
    return record?.kind === "chat" ? record.externalId : undefined
  }

  /** Whether this numeric id was allocated by this store, not merely range-shaped like one. */
  hasNumericId(numericId: number): boolean {
    return this.#byNumeric.has(numericId)
  }

  snapshot(): FeishuIdentityState {
    return {
      users: { ...this.#state.users },
      chats: { ...this.#state.chats },
      nextId: this.#state.nextId,
    }
  }
}

/** The reserved negative id range used by the persisted Feishu identity map. */
export function isFeishuNumericId(id: number): boolean {
  return Number.isInteger(id) && id >= MIN_FEISHU_ID && id <= MAX_FEISHU_ID
}
