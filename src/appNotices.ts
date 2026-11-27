import { randomBytes } from "node:crypto"
import { withFileLock } from "./fileLock.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"

/**
 * Notices for an App-only deployment.
 *
 * A reminder needs a push target. Telegram and Feishu have one; the App does not, because
 * Android kills background processes and Doze defers alarms. So when no chat is bound, the
 * bot writes the reminder here instead and the App picks it up the next time it opens.
 *
 * This is a mailbox, not a notification: it is delivered when the App asks for it.
 */
export interface AppNotice {
  id: string
  kind: "reminder" | "schedule" | "report" | "system"
  text: string
  /** When the notice was raised, in epoch milliseconds. */
  at: number
}

export interface NoticeInput {
  kind: AppNotice["kind"]
  text: string
  at?: number
}

/**
 * Pseudo chat id for the App mailbox. Telegram chat ids are never 0, and the bridge branches
 * on this value instead of trying to send a message into a chat that does not exist.
 */
export const APP_CHAT_ID = 0

const MAX_NOTICES = 200
const MAX_TEXT = 4000

export class NoticeStore {
  readonly #path: string
  readonly #log: Logger
  #notices: AppNotice[] = []

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  get size(): number {
    return this.#notices.length
  }

  push(input: NoticeInput): AppNotice {
    // Wrap the full load-mutate-save transaction in the file lock so concurrent writers
    // never lose each other's notices.
    return withFileLock(this.#path, () => {
      this.#load()
      const text = input.text.trim().slice(0, MAX_TEXT)
      const notice: AppNotice = {
        id: randomBytes(6).toString("hex"),
        kind: input.kind,
        text,
        at: input.at ?? Date.now(),
      }
      this.#notices.push(notice)
      // Oldest first: a mailbox that grows forever is a disk leak on a long-lived bot
      if (this.#notices.length > MAX_NOTICES) this.#notices = this.#notices.slice(-MAX_NOTICES)
      this.#saveUnlocked()
      return notice
    })
  }

  /** Notices raised after [since]; without it the newest [limit] are returned. */
  list(since?: number, limit = 100): AppNotice[] {
    this.#load()
    const filtered = since === undefined ? this.#notices : this.#notices.filter((notice) => notice.at > since)
    return filtered.slice(-limit)
  }

  clear(): number {
    return withFileLock(this.#path, () => {
      this.#load()
      const count = this.#notices.length
      this.#notices = []
      this.#saveUnlocked()
      return count
    })
  }

  #load(): void {
    // readJsonObject quarantines corrupt JSON aside to `*.corrupt-<ts>` before starting empty.
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message))
    if (!parsed) {
      this.#notices = []
      return
    }
    const list = parsed.notices
    if (!Array.isArray(list)) {
      this.#notices = []
      return
    }
    const notices: AppNotice[] = []
    for (const item of list) {
      const record = asRecord(item)
      if (!record) continue
      const kind = record.kind
      if (kind !== "reminder" && kind !== "schedule" && kind !== "report" && kind !== "system") continue
      if (typeof record.text !== "string" || typeof record.at !== "number") continue
      notices.push({
        id: typeof record.id === "string" ? record.id : randomBytes(6).toString("hex"),
        kind,
        text: record.text,
        at: record.at,
      })
    }
    this.#notices = notices.slice(-MAX_NOTICES)
  }

  #saveUnlocked(): void {
    const body = JSON.stringify({ version: 1, notices: this.#notices }, null, 2)
    writePrivateAtomic(this.#path, `${body}\n`)
  }
}
