import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"
import { withFileLock } from "./fileLock.js"
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
    // Merge what another instance wrote first: the bridge and the API each hold one
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
    this.#save()
    return notice
  }

  /** Notices raised after [since]; without it the newest [limit] are returned. */
  list(since?: number, limit = 100): AppNotice[] {
    this.#load()
    const filtered = since === undefined ? this.#notices : this.#notices.filter((notice) => notice.at > since)
    return filtered.slice(-limit)
  }

  clear(): number {
    const count = this.#notices.length
    this.#notices = []
    this.#save()
    return count
  }

  #load(): void {
    let raw: string
    try {
      raw = readFileSync(this.#path, "utf8")
    } catch {
      // Missing means empty; a deleted file must not leave stale entries in memory
      this.#notices = []
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A damaged mailbox must not block the bot; the reminders themselves live elsewhere
      this.#log.warn(`app notices unreadable: ${this.#path}`)
      return
    }
    const list = asRecord(parsed)?.notices
    if (!Array.isArray(list)) return
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

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const body = JSON.stringify({ version: 1, notices: this.#notices }, null, 2)
    withFileLock(this.#path, () => {
      const tmp = `${this.#path}.${process.pid}.tmp`
      writeFileSync(tmp, `${body}\n`, { mode: 0o600 })
      renameSync(tmp, this.#path)
    })
  }
}
