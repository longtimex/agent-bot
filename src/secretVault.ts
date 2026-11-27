import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { decryptPayload, encryptPayload } from "./apiCrypto.js"
import { writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import { escapeMarkdown } from "./messages.js"
import { loadOrCreateSecretKey } from "./secretKey.js"

/**
 * Secrets the user typed into a 安全输入 card, kept away from the model.
 *
 * When an Agent needs a token in the middle of a task (pushing to GitHub, calling an API), the
 * only way used to be pasting it into the chat: it then went to the model provider, into the
 * session transcript, the task history and possibly the logs. A card now collects it instead and
 * it lands here: encrypted with the data directory's key (`accounts.key`), scoped to one chat,
 * gone after 24 hours. The Agent only ever learns where to read it:
 *
 * - a file per secret under data/secrets/<chat>/, written 0600 right before a task of that chat
 *   starts and removed when it ends (Codex and other CLIs filter *TOKEN* variables out of their
 *   shell, so the file is the path that always works);
 * - for CLI engines also an environment variable of the same name.
 *
 * Every outgoing reply, progress line and error is scrubbed of the stored values.
 */
export const SECRET_TTL_MS = 24 * 60 * 60_000
export const MAX_SECRET_LENGTH = 8_192
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
/** Variables that change how a program starts or where it loads code from. */
const FORBIDDEN_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "TEMP", "TMP", "ENV", "IFS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "EDITOR", "VISUAL", "PAGER", "TERM",
])
const FORBIDDEN_PREFIXES = ["LD_", "DYLD_", "NODE_", "NPM_", "GIT_", "PYTHON", "BASH_", "PERL", "RUBY", "JAVA_", "OPENCODE_", "TELEGRAM_", "FEISHU_", "BOT_"]
/** Shorter values are too likely to appear in ordinary text to be scrubbed from it. */
const MIN_MASK_LENGTH = 6

export function secretNameProblem(raw: string): string | undefined {
  const name = raw.trim().toUpperCase()
  if (!NAME_RE.test(name)) return "名称只能用大写字母、数字和下划线，以字母开头，2–64 个字符"
  if (FORBIDDEN_NAMES.has(name) || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "这个名称会影响程序的启动方式，不能作为密钥名"
  }
  return undefined
}

export function secretValueProblem(value: string): string | undefined {
  if (!value) return "值不能为空"
  if (value.length > MAX_SECRET_LENGTH) return `值太长（上限 ${MAX_SECRET_LENGTH} 字符）`
  if (value.includes("\0")) return "值里不能有空字符"
  return undefined
}

interface StoredSecret {
  value: string
  purpose?: string
  expiresAt: number
}

export interface SecretInfo {
  name: string
  purpose?: string
  expiresAt: number
}

export class SecretVault {
  readonly #path: string
  readonly #keyPath: string
  readonly #filesRoot: string
  readonly #log: Logger
  #key?: Buffer
  readonly #chats = new Map<string, Map<string, StoredSecret>>()
  /** Decrypted values, for scrubbing; rebuilt whenever an entry changes. */
  #plain: string[] = []

  constructor(dataDir: string, log: Logger) {
    this.#path = resolve(dataDir, "task-secrets.json")
    this.#keyPath = resolve(dataDir, "accounts.key")
    this.#filesRoot = resolve(dataDir, "secrets")
    this.#log = log
    // Files only exist while a task runs; any left behind belong to a process that is gone
    rmSync(this.#filesRoot, { recursive: true, force: true })
    this.#load()
  }

  set(chat: string, rawName: string, value: string, purpose?: string, now = Date.now()): void {
    const name = rawName.trim().toUpperCase()
    const problem = secretNameProblem(name) ?? secretValueProblem(value)
    if (problem) throw new Error(problem)
    const entries = this.#chats.get(chat) ?? new Map<string, StoredSecret>()
    entries.set(name, { value: encryptPayload(this.#secretKey(), value), purpose: purpose?.slice(0, 200), expiresAt: now + SECRET_TTL_MS })
    this.#chats.set(chat, entries)
    this.#changed()
  }

  has(chat: string, name: string, now = Date.now()): boolean {
    const entry = this.#chats.get(chat)?.get(name.toUpperCase())
    return Boolean(entry && entry.expiresAt > now)
  }

  list(chat: string, now = Date.now()): SecretInfo[] {
    this.#prune(now)
    return [...(this.#chats.get(chat) ?? new Map<string, StoredSecret>())].map(([name, entry]) => ({
      name,
      ...(entry.purpose ? { purpose: entry.purpose } : {}),
      expiresAt: entry.expiresAt,
    }))
  }

  clear(chat: string): number {
    const count = this.#chats.get(chat)?.size ?? 0
    if (count === 0) return 0
    this.#chats.delete(chat)
    this.#changed()
    return count
  }

  /** Decrypted values of one chat, for a CLI child's environment. */
  env(chat: string, now = Date.now()): Record<string, string> {
    this.#prune(now)
    const out: Record<string, string> = {}
    for (const [name, entry] of this.#chats.get(chat) ?? []) {
      const value = this.#decrypt(entry.value)
      if (value !== undefined) out[name] = value
    }
    return out
  }

  /** Where the files of a chat appear while its task runs; stable, so a prompt can name it. */
  dirFor(chat: string): string {
    return join(this.#filesRoot, createHash("sha256").update(chat).digest("hex").slice(0, 16))
  }

  /** Writes one file per secret for the duration of a task; the returned function removes them. */
  materialize(chat: string): () => void {
    const values = this.env(chat)
    const dir = this.dirFor(chat)
    if (Object.keys(values).length === 0) return () => {}
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      for (const [name, value] of Object.entries(values)) {
        const path = join(dir, name)
        writeFileSync(path, value, { mode: 0o600 })
        chmodSync(path, 0o600)
      }
    } catch (err) {
      this.#log.warn("failed to prepare the secret files for a task:", (err as Error).message)
    }
    return () => rmSync(dir, { recursive: true, force: true })
  }

  /** Replaces every stored value in outgoing text; a no-op while nothing is stored. */
  mask(text: string): string {
    let out = text
    for (const value of this.#plain) {
      if (out.includes(value)) out = out.split(value).join("***")
      const escaped = escapeMarkdown(value)
      if (escaped !== value && out.includes(escaped)) out = out.split(escaped).join("***")
    }
    return out
  }

  #prune(now: number): void {
    let changed = false
    for (const [chat, entries] of this.#chats) {
      for (const [name, entry] of entries) {
        if (entry.expiresAt <= now) {
          entries.delete(name)
          changed = true
        }
      }
      if (entries.size === 0) this.#chats.delete(chat)
    }
    if (changed) this.#changed()
  }

  #secretKey(): Buffer {
    this.#key ??= loadOrCreateSecretKey(this.#keyPath)
    return this.#key
  }

  #decrypt(payload: string): string | undefined {
    try {
      return decryptPayload(this.#secretKey(), payload)
    } catch {
      return undefined
    }
  }

  #changed(): void {
    const plain: string[] = []
    for (const entries of this.#chats.values()) {
      for (const entry of entries.values()) {
        const value = this.#decrypt(entry.value)
        if (value && value.length >= MIN_MASK_LENGTH) plain.push(value)
      }
    }
    // Longest first, so a value that contains another is replaced whole
    this.#plain = plain.sort((a, b) => b.length - a.length)
    const chats: Record<string, Record<string, StoredSecret>> = {}
    for (const [chat, entries] of this.#chats) chats[chat] = Object.fromEntries(entries)
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify({ version: 1, chats }, null, 2)}\n`)
    } catch (err) {
      this.#log.warn("failed to save the secret vault:", (err as Error).message)
    }
  }

  #load(): void {
    let raw: string
    try {
      raw = readFileSync(this.#path, "utf8")
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as { chats?: Record<string, Record<string, StoredSecret>> }
      for (const [chat, entries] of Object.entries(parsed.chats ?? {})) {
        const map = new Map<string, StoredSecret>()
        for (const [name, entry] of Object.entries(entries ?? {})) {
          if (typeof entry?.value === "string" && Number.isFinite(entry.expiresAt)) map.set(name, entry)
        }
        if (map.size > 0) this.#chats.set(chat, map)
      }
      this.#prune(Date.now())
      this.#changed()
    } catch (err) {
      this.#log.warn("ignoring an unreadable secret vault:", (err as Error).message)
    }
  }
}

// One vault per process, shared by both control surfaces and the engine call sites
let active: SecretVault | undefined

export function configureSecretVault(vault: SecretVault | undefined): void {
  active = vault
}

export function activeSecretVault(): SecretVault | undefined {
  return active
}

export function secretEnvFor(chat: string): Record<string, string> {
  return active?.env(chat) ?? {}
}

export function maskSecretValues(text: string): string {
  return active ? active.mask(text) : text
}
