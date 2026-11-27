import { stripAnsi } from "./ccswitch.js"
import { asRecord } from "./util.js"
import type { CliParseMode } from "./agentCli.js"

const MAX_DRAFT_CHARS = 12_000

function pickStr(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

function capDraft(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_DRAFT_CHARS) return trimmed
  let start = trimmed.length - MAX_DRAFT_CHARS
  // Avoid cutting inside a UTF-16 surrogate pair (e.g. emoji or CJK extension B).
  const code = trimmed.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff && start + 1 < trimmed.length) start += 1
  return `…${trimmed.slice(start)}`
}

/**
 * Incrementally extracts assistant answer text from a running Agent CLI's stdout lines so
 * Telegram progress cards and Android chat bubbles show live streaming text (matching OpenCode).
 */
export class CliDraftTracker {
  readonly #mode: CliParseMode | undefined
  readonly #segments: string[] = []
  readonly #byKey = new Map<string, number>()
  #streaming = ""
  #lastEmitted = ""

  constructor(mode: CliParseMode | undefined) {
    this.#mode = mode
  }

  /** Accepts one decoded stdout line; returns the updated draft text when it changed. */
  acceptLine(rawLine: string): string | undefined {
    const clean = stripAnsi(rawLine)
    const trimmed = clean.trim()
    if (!trimmed) return undefined

    if (!this.#mode || this.#mode === "text") {
      this.#streaming = this.#streaming ? `${this.#streaming}\n${trimmed}` : trimmed
      return this.#emit()
    }

    if (!trimmed.startsWith("{")) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }
    const record = asRecord(parsed)
    if (!record) return undefined
    const type = typeof record.type === "string" ? record.type : ""

    if (this.#mode === "codex-jsonl") {
      if (type === "item.completed" || type === "item.updated") {
        const item = asRecord(record.item)
        if (item?.type === "agent_message") {
          const content = pickStr(item, ["text", "content", "message"])?.trim()
          if (content) {
            const itemId = pickStr(item, ["id"])
            if (itemId) this.#upsertKeyed(itemId, content)
            else this.#commitMessage(content, type === "item.updated")
            return this.#emit()
          }
        }
      } else if (type === "response.output_text.delta") {
        const delta = pickStr(record, ["delta", "text"])
        if (delta) {
          this.#streaming += delta
          return this.#emit()
        }
      }
      return undefined
    }

    if (this.#mode === "gemini-stream") {
      if (type === "message") {
        const role = typeof record.role === "string" ? record.role : ""
        if (role === "assistant" || role === "model") {
          const content = pickStr(record, ["content", "text"])
          if (content) {
            if (record.delta === true) {
              this.#streaming += content
            } else {
              this.#commitMessage(content, false)
            }
            return this.#emit()
          }
        }
      }
      return undefined
    }

    // claude-json / jsonl-result: Claude stream-json events or generic JSONL assistant lines
    if (type === "content_block_delta") {
      const delta = asRecord(record.delta)
      const chunk = delta ? pickStr(delta, ["text"]) : undefined
      if (chunk) {
        this.#streaming += chunk
        return this.#emit()
      }
      return undefined
    }
    if (type === "assistant") {
      const msg = asRecord(record.message)
      const blocks = Array.isArray(msg?.content) ? msg.content : []
      const parts = blocks
        .map((block) => {
          const item = asRecord(block)
          return item?.type === "text" && typeof item.text === "string" ? item.text : ""
        })
        .filter(Boolean)
      if (parts.length > 0) {
        const joined = parts.join("\n")
        const msgId = msg ? pickStr(msg, ["id"]) : undefined
        if (msgId) this.#upsertKeyed(msgId, joined)
        else this.#commitMessage(joined, false)
        return this.#emit()
      }
      return undefined
    }
    if (type === "result") {
      const result = pickStr(record, ["result", "text", "content"])
      if (result) {
        const current = this.#composed()
        if (!current) {
          this.#segments.push(result)
        } else if (result.startsWith(current)) {
          this.#segments.length = 0
          this.#byKey.clear()
          this.#streaming = ""
          this.#segments.push(result)
        } else if (!current.endsWith(result) && current !== result) {
          this.#commitMessage(result, false)
        }
        return this.#emit()
      }
    }
    return undefined
  }

  #upsertKeyed(key: string, content: string): void {
    this.#streaming = ""
    const existing = this.#byKey.get(key)
    if (existing !== undefined) {
      this.#segments[existing] = content
      return
    }
    this.#byKey.set(key, this.#segments.length)
    this.#segments.push(content)
  }

  #commitMessage(content: string, replaceLastOnPrefix: boolean): void {
    if (this.#streaming) {
      const streamed = this.#streaming.trim()
      this.#streaming = ""
      if (content === streamed || content.startsWith(streamed)) {
        this.#segments.push(content)
        return
      }
      this.#segments.push(streamed)
      this.#segments.push(content)
      return
    }
    const last = this.#segments.at(-1)
    if (last !== undefined) {
      if (content === last) return
      if (replaceLastOnPrefix && content.startsWith(last)) {
        this.#segments[this.#segments.length - 1] = content
        return
      }
    }
    this.#segments.push(content)
  }

  #composed(): string {
    if (!this.#streaming) return this.#segments.join("\n\n")
    if (this.#segments.length === 0) return this.#streaming
    return `${this.#segments.join("\n\n")}\n\n${this.#streaming}`
  }

  #emit(): string | undefined {
    const next = capDraft(this.#composed())
    if (!next || next === this.#lastEmitted) return undefined
    this.#lastEmitted = next
    return next
  }
}
