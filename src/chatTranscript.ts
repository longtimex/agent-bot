import { randomBytes } from "node:crypto"
import { redactSecrets } from "./ccswitch.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import { clip } from "./messages.js"
import { maskSecretValues } from "./secretVault.js"

export interface TranscriptMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: number
  engine?: string
  model?: string
  source?: string
}

const MAX_MESSAGES_PER_CHAT = 80
const MAX_MESSAGE_CHARS = 16_000

function sanitizeMessage(raw: unknown): TranscriptMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  if (r.role !== "user" && r.role !== "assistant") return undefined
  if (typeof r.text !== "string" || !r.text) return undefined
  return {
    id: typeof r.id === "string" && r.id ? r.id : randomBytes(4).toString("hex"),
    role: r.role,
    text: r.text.slice(0, MAX_MESSAGE_CHARS),
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : Date.now(),
    ...(typeof r.engine === "string" && r.engine ? { engine: r.engine } : {}),
    ...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
    ...(typeof r.source === "string" && r.source ? { source: r.source } : {}),
  }
}

/**
 * Server-side recent conversation transcript per chat key (`tg:*`, `fs:*`, `api:app`).
 * Powers phone reinstall recovery (`GET /sync/messages`) and true cross-client session handoff
 * (`POST /sync/handoff`) where Telegram/Feishu context and bubbles carry over to Android.
 */
export class ChatTranscriptStore {
  readonly #path: string
  readonly #log: Logger
  readonly #chats = new Map<string, TranscriptMessage[]>()

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  append(
    key: string,
    input: { role: "user" | "assistant"; text: string; engine?: string; model?: string; source?: string; at?: number },
  ): TranscriptMessage | undefined {
    const cleaned = clip(redactSecrets(maskSecretValues(input.text)).trim(), MAX_MESSAGE_CHARS)
    if (!cleaned) return undefined
    const entry: TranscriptMessage = {
      id: randomBytes(4).toString("hex"),
      role: input.role,
      text: cleaned,
      at: input.at ?? Date.now(),
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.source ? { source: input.source } : {}),
    }
    const list = this.#chats.get(key) ?? []
    list.push(entry)
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)
    this.#chats.set(key, list)
    this.#save()
    return entry
  }

  list(key: string, limit = 60): TranscriptMessage[] {
    const list = this.#chats.get(key) ?? []
    const cap = Math.max(1, Math.min(MAX_MESSAGES_PER_CHAT, Math.floor(limit)))
    return list.slice(-cap).map((item) => ({ ...item }))
  }

  clear(key: string): void {
    if (!this.#chats.delete(key)) return
    this.#save()
  }

  /** Copies recent messages from `fromKey` into `toKey` for cross-client handoff. */
  copy(fromKey: string, toKey: string): TranscriptMessage[] {
    const source = this.#chats.get(fromKey) ?? []
    const cloned = source.slice(-MAX_MESSAGES_PER_CHAT).map((item) => ({ ...item }))
    this.#chats.set(toKey, cloned)
    this.#save()
    return cloned.map((item) => ({ ...item }))
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (msg) => this.#log.warn(msg))
    if (!parsed) return
    const chats = parsed.chats && typeof parsed.chats === "object" ? (parsed.chats as Record<string, unknown>) : {}
    for (const [key, rawList] of Object.entries(chats)) {
      if (!Array.isArray(rawList)) continue
      const items = rawList.map(sanitizeMessage).filter((item): item is TranscriptMessage => item !== undefined).slice(-MAX_MESSAGES_PER_CHAT)
      if (items.length > 0) this.#chats.set(key, items)
    }
  }

  #save(): void {
    const chats: Record<string, TranscriptMessage[]> = {}
    for (const [key, list] of this.#chats) {
      if (list.length > 0) chats[key] = list
    }
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify({ version: 1, chats }, null, 2)}\n`)
    } catch (err) {
      this.#log.warn("failed to persist chat transcripts:", (err as Error).message)
    }
  }
}

/** Formats a concise Telegram/Feishu completion push for an App-initiated task. */
export function formatAppTaskNotice(input: {
  engine: string
  model?: string
  ms: number
  outcome: "ok" | "failed" | "cancelled"
  prompt: string
  reply?: string
  error?: string
}): string {
  const icon = input.outcome === "ok" ? "✅" : "❌"
  const state = input.outcome === "ok" ? "已完成" : "失败"
  const sec = Math.max(1, Math.round(input.ms / 1000))
  const dur = sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`
  const target = input.model ? `${input.engine} · ${input.model}` : input.engine
  const question = clip(redactSecrets(input.prompt).replace(/\s+/g, " ").trim(), 100) ?? ""
  const body = clip(redactSecrets(maskSecretValues(input.outcome === "ok" ? (input.reply ?? "") : (input.error ?? ""))).trim(), 400) ?? ""
  return `📱 App 任务${state} ${icon}（${target} · ${dur}）\n提问：${question}${body ? `\n\n${body}` : ""}`
}
