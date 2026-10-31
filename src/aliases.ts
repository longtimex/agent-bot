import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "./logger.js"

/**
 * Per-chat quick commands: an alias expands to stored text (a prompt or even
 * another command) before normal command dispatch. Persisted per chat in one
 * JSON file so a restart keeps the user's shortcuts.
 */
export interface AliasEntry {
  name: string
  /** The text a `/name` message expands to; may itself start with a command. */
  expansion: string
  createdAt: number
}

interface AliasFile {
  /** chatId → alias name → entry. */
  aliases: Record<string, Record<string, AliasEntry>>
}

/** Telegram only accepts [a-z0-9_] in commands, so aliases follow the same rule. */
const NAME_RE = /^[a-z][a-z0-9_]{1,31}$/
const MAX_PER_CHAT = 50
const MAX_EXPANSION_LENGTH = 4000

export function isValidAliasName(name: string): boolean {
  return NAME_RE.test(name)
}

export class AliasStore {
  readonly #path: string
  readonly #log: Logger
  /** Keyed by `${chatId}` then alias name. */
  readonly #data = new Map<string, Map<string, AliasEntry>>()
  #unreadable = false

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  add(chatId: number, name: string, expansion: string): AliasEntry {
    this.#assertWritable()
    const key = String(chatId)
    const normalized = name.toLowerCase()
    if (!isValidAliasName(normalized)) {
      throw new Error("快捷指令名只能包含小写字母、数字和下划线，且以字母开头（2-32 位）。")
    }
    const trimmed = expansion.trim()
    if (!trimmed) throw new Error("请提供指令内容，例如：/alias add code 审查当前目录的代码")
    if (trimmed.length > MAX_EXPANSION_LENGTH) {
      throw new Error(`指令内容不能超过 ${MAX_EXPANSION_LENGTH} 字。`)
    }
    const aliases = this.#data.get(key) ?? new Map<string, AliasEntry>()
    if (!aliases.has(normalized) && aliases.size >= MAX_PER_CHAT) {
      throw new Error(`每个会话最多创建 ${MAX_PER_CHAT} 个快捷指令，请先删除部分指令。`)
    }
    const entry: AliasEntry = { name: normalized, expansion: trimmed, createdAt: Date.now() }
    aliases.set(normalized, entry)
    this.#data.set(key, aliases)
    this.#save()
    return entry
  }

  /** Returns the expansion for `/name`, or undefined when the alias does not exist. */
  expand(chatId: number, name: string): string | undefined {
    return this.#data.get(String(chatId))?.get(name.toLowerCase())?.expansion
  }

  list(chatId: number): AliasEntry[] {
    return [...(this.#data.get(String(chatId))?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  }

  count(chatId: number): number {
    return this.#data.get(String(chatId))?.size ?? 0
  }

  remove(chatId: number, name: string): AliasEntry | undefined {
    this.#assertWritable()
    const aliases = this.#data.get(String(chatId))
    if (!aliases) return undefined
    const removed = aliases.get(name.toLowerCase())
    if (!removed) return undefined
    aliases.delete(name.toLowerCase())
    if (aliases.size === 0) this.#data.delete(String(chatId))
    this.#save()
    return removed
  }

  #load(): void {
    let raw: string
    try {
      raw = readFileSync(this.#path, "utf8")
    } catch {
      // Missing file is the normal first-run case
      return
    }
    try {
      const parsed = JSON.parse(raw) as AliasFile
      if (!parsed || typeof parsed !== "object" || typeof parsed.aliases !== "object" || parsed.aliases === null) {
        throw new Error("文件结构无效")
      }
      for (const [chatKey, entries] of Object.entries(parsed.aliases)) {
        if (!entries || typeof entries !== "object") continue
        const aliases = new Map<string, AliasEntry>()
        for (const [name, entry] of Object.entries(entries)) {
          if (!entry || typeof entry.expansion !== "string" || !entry.expansion.trim()) continue
          if (!isValidAliasName(name)) continue
          aliases.set(name.toLowerCase(), {
            name: name.toLowerCase(),
            expansion: entry.expansion,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
          })
        }
        if (aliases.size > 0) this.#data.set(chatKey, aliases)
      }
      this.#log.debug(`loaded ${this.#data.size} chat(s) of aliases from ${this.#path}`)
    } catch (err) {
      this.#unreadable = true
      this.#log.warn(`failed to read alias store ${this.#path}:`, (err as Error).message)
    }
  }

  #assertWritable(): void {
    if (!this.#unreadable) return
    throw new Error(
      `快捷指令文件 ${this.#path} 无法解析，为避免丢失已有指令已拒绝写入。请先修复该文件（或备份后删除）再重试。`,
    )
  }

  #save(): void {
    if (this.#unreadable) {
      this.#log.warn(`alias store ${this.#path} is unreadable; skipped writing it`)
      return
    }
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const payload: AliasFile = { aliases: {} }
      for (const [chatKey, aliases] of this.#data) {
        payload.aliases[chatKey] = Object.fromEntries(aliases)
      }
      const tmp = `${this.#path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.#path)
    } catch (err) {
      this.#log.warn(`failed to write alias store ${this.#path}:`, (err as Error).message)
    }
  }
}
