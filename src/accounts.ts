import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"
import { decryptPayload, encryptPayload } from "./apiCrypto.js"
import { withFileLock } from "./fileLock.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"

/**
 * A password manager for the bot's owner: named entries grouped by a free-form category.
 *
 * Passwords are encrypted with AES-256-GCM under a key that lives in its own file, not in
 * `accounts.json`. That split matters for backups: `/ops backup` packs `data/*.json`, so a
 * backup carries the ciphertext to another machine but never the key that opens it.
 */
export interface AccountEntry {
  id: string
  /** Unique, case-insensitive; what `/account show` resolves. */
  name: string
  category: string
  username: string
  /** Ciphertext at rest. Absent when the entry has no password. */
  secret?: string
  url?: string
  notes?: string
  createdAt: number
  updatedAt: number
}

export interface AccountInput {
  name: string
  username: string
  password?: string
  category?: string
  url?: string
  notes?: string
}

export const DEFAULT_CATEGORY = "未分类"
const MAX_ACCOUNTS = 500
const MAX_NAME = 60
const MAX_FIELD = 500
const ID_RE = /^[a-z0-9]{8,32}$/

function text(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

export class AccountStore {
  readonly #path: string
  readonly #keyPath: string
  readonly #log: Logger
  readonly #accounts = new Map<string, AccountEntry>()
  #key?: Buffer
  #unreadable = false

  constructor(path: string, keyPath: string, log: Logger) {
    this.#path = path
    this.#keyPath = keyPath
    this.#log = log
    this.#load()
  }

  get size(): number {
    return this.#accounts.size
  }

  add(input: AccountInput): AccountEntry {
    this.#assertWritable()
    const name = this.#checkName(input.name)
    const existing = this.find(name)
    if (existing) throw new Error(`账号「${name}」已存在，请换一个名称或先删除旧条目。`)
    if (this.#accounts.size >= MAX_ACCOUNTS) throw new Error(`最多保存 ${MAX_ACCOUNTS} 条账号。`)

    const now = Date.now()
    const entry: AccountEntry = {
      id: randomBytes(8).toString("hex"),
      name,
      category: text(input.category, 40) ?? DEFAULT_CATEGORY,
      username: text(input.username) ?? "",
      url: text(input.url),
      notes: text(input.notes),
      createdAt: now,
      updatedAt: now,
    }
    const password = input.password?.trim()
    if (password) entry.secret = encryptPayload(this.#keyBuffer(), password)
    this.#accounts.set(entry.id, entry)
    this.#save()
    return entry
  }

  /** Newest first within a category; `category` empty means every entry. */
  list(category?: string): AccountEntry[] {
    const wanted = category?.trim()
    return [...this.#accounts.values()]
      .filter((entry) => !wanted || entry.category === wanted)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Category names with counts, so a panel can offer them without a fixed list. */
  categories(): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>()
    for (const entry of this.#accounts.values()) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  /** Resolves by name (case-insensitive) or by id. */
  find(ref: string): AccountEntry | undefined {
    const trimmed = ref.trim()
    if (ID_RE.test(trimmed)) {
      const byId = this.#accounts.get(trimmed)
      if (byId) return byId
    }
    const lower = trimmed.toLowerCase()
    return [...this.#accounts.values()].find((entry) => entry.name.toLowerCase() === lower)
  }

  /** Decrypts the password for a deliberate reveal; never part of a list response. */
  reveal(ref: string): { entry: AccountEntry; password: string } | undefined {
    const entry = this.find(ref)
    if (!entry) return undefined
    if (!entry.secret) return { entry, password: "" }
    return { entry, password: decryptPayload(this.#keyBuffer(), entry.secret) }
  }

  remove(ref: string): AccountEntry | undefined {
    this.#assertWritable()
    const entry = this.find(ref)
    if (!entry) return undefined
    this.#accounts.delete(entry.id)
    this.#save()
    return entry
  }

  #checkName(raw: string): string {
    const name = raw.trim()
    if (!name) throw new Error("请提供账号名称，例如：/account add GitHub | me@example.com")
    if (name.length > MAX_NAME) throw new Error(`名称不能超过 ${MAX_NAME} 字。`)
    if (/[\n\r]/.test(name)) throw new Error("名称不能包含换行。")
    return name
  }

  #keyBuffer(): Buffer {
    if (this.#key) return this.#key
    if (existsSync(this.#keyPath)) {
      const raw = readFileSync(this.#keyPath, "utf8").trim()
      if (!/^[0-9a-f]{64}$/i.test(raw)) {
        // Regenerating it would silently orphan every stored password
        throw new Error(`账号密钥 ${this.#keyPath} 格式无效，请从备份恢复该文件。`)
      }
      this.#key = Buffer.from(raw, "hex")
      return this.#key
    }
    mkdirSync(dirname(this.#keyPath), { recursive: true })
    const key = randomBytes(32)
    writeFileSync(this.#keyPath, `${key.toString("hex")}\n`, { mode: 0o600 })
    this.#log.info(`account key created at ${this.#keyPath}`)
    this.#key = key
    return key
  }

  #assertWritable(): void {
    if (!this.#unreadable) return
    throw new Error(
      `账号库 ${this.#path} 无法解析，为避免覆盖已有条目已拒绝写入。请修复该文件或备份后删除再重试。`,
    )
  }

  #load(): void {
    let raw: string
    try {
      raw = readFileSync(this.#path, "utf8")
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.#unreadable = true
      this.#log.warn(`account store unreadable: ${this.#path}`)
      return
    }
    const root = asRecord(parsed)
    const list = root?.accounts
    if (!Array.isArray(list)) {
      this.#unreadable = list !== undefined
      if (this.#unreadable) this.#log.warn(`account store has no accounts array: ${this.#path}`)
      return
    }
    for (const item of list) {
      const record = asRecord(item)
      if (!record) continue
      const id = typeof record.id === "string" && ID_RE.test(record.id) ? record.id : undefined
      const name = text(record.name, MAX_NAME)
      if (!id || !name) continue
      const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now()
      this.#accounts.set(id, {
        id,
        name,
        category: text(record.category, 40) ?? DEFAULT_CATEGORY,
        username: text(record.username) ?? "",
        secret: typeof record.secret === "string" && record.secret ? record.secret : undefined,
        url: text(record.url),
        notes: text(record.notes),
        createdAt,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : createdAt,
      })
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const body = JSON.stringify({ version: 1, accounts: [...this.#accounts.values()] }, null, 2)
    withFileLock(this.#path, () => {
      const tmp = `${this.#path}.${process.pid}.tmp`
      // Keep an existing 0600 mode: the file holds ciphertext, but its category and notes
      // are still readable metadata
      let mode = 0o600
      try {
        mode = statSync(this.#path).mode & 0o777
      } catch {
        // new file: use the private default
      }
      writeFileSync(tmp, `${body}\n`, { mode })
      renameSync(tmp, this.#path)
      if (!existsSync(this.#path)) throw new Error("账号库写入失败")
    })
  }
}
