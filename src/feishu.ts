import type { Message } from "grammy/types"
import type { Update } from "grammy/types"
import type { BotConfig } from "./config.js"
import { FeishuOutbound } from "./feishuApi.js"
import { feishuMessageToTelegram, feishuRefFromFile, type FeishuResourceRef } from "./feishuAttachments.js"
import { parseFeishuCardAction } from "./feishuCards.js"
import { FeishuIdentityStore } from "./feishuIdentity.js"
import { asFeishuApi, type FeishuApiLike, type FeishuClientLike } from "./feishuTypes.js"
import type { Logger } from "./logger.js"
import type { TelegramBridge } from "./telegram.js"

const MAX_SEEN = 2_000
const EVENT_RESPONSE_DEADLINE_MS = 2_500

interface FeishuMessageEvent {
  event_id?: string
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
  }
  sender?: {
    sender_id?: { open_id?: string }
    sender_type?: string
  }
}

interface FeishuCardEvent {
  event_id?: string
  token?: string
  context?: { open_message_id?: string; open_chat_id?: string }
  open_message_id?: string
  open_chat_id?: string
  operator?: { open_id?: string }
  action?: { value?: unknown; tag?: string }
}

export interface FeishuServiceDeps {
  cfg: BotConfig
  client: FeishuClientLike
  ws: {
    start(params: { eventDispatcher: unknown }): Promise<void>
    close(params?: { force?: boolean }): void
  }
  dispatcher: {
    register(handles: Record<string, (event: unknown) => Promise<unknown> | unknown>): unknown
  }
  bridge: TelegramBridge
  log: Logger
  identities: FeishuIdentityStore
  outbound: FeishuOutbound
  /** Optional hook used by the service to defer owner initialization until a mapped chat exists. */
  onFirstChat?: () => void
  /** The transport has no usable connection and cannot recover on its own. */
  onFatal?: (err: Error) => void
}

interface ParsedEvent {
  text: string
  refs: FeishuResourceRef[]
}

function decodeContent(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Feishu injects `@_user_N` placeholders before mentions, including a leading bot mention. */
export function stripLeadingMentions(text: string): string {
  let out = text.trim()
  while (/^@_[A-Za-z0-9_]+(?:\s+|$)/.test(out)) {
    out = out.replace(/^@_[A-Za-z0-9_]+\s*/, "")
  }
  return out.trim()
}

function postTextAndRefs(content: Record<string, unknown>, messageId: string): ParsedEvent {
  const localized = ["zh_cn", "en_us", "ja_jp"]
    .map((key) => content[key])
    .find((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
  const body = localized ?? content
  const lines: string[] = []
  const refs: FeishuResourceRef[] = []
  if (typeof body.title === "string" && body.title.trim()) lines.push(body.title.trim())
  for (const paragraph of Array.isArray(body.content) ? body.content : []) {
    if (!Array.isArray(paragraph)) continue
    let line = ""
    for (const element of paragraph) {
      if (!element || typeof element !== "object") continue
      const item = element as Record<string, unknown>
      const tag = item.tag
      if (tag === "text" || tag === "a") line += String(item.text ?? "")
      else if (tag === "at") line += item.user_id === "all" ? "@all" : String(item.user_name ?? "")
      else if (tag === "img" && typeof item.image_key === "string") refs.push(feishuRefFromFile(messageId, item.image_key, "image", item))
      else if (tag === "media" && typeof item.file_key === "string") refs.push(feishuRefFromFile(messageId, item.file_key, "file", item))
      else if (typeof item.text === "string") line += item.text
    }
    lines.push(line)
  }
  return { text: stripLeadingMentions(lines.join("\n").trim()), refs }
}

/** Extracts text and downloadable resources from the Feishu message types users can send. */
export function parseFeishuMessage(messageId: string, messageType: string | undefined, raw: string | undefined): ParsedEvent {
  const content = decodeContent(raw)
  if (messageType === "text") return { text: stripLeadingMentions(String(content.text ?? "")), refs: [] }
  if (messageType === "post") return postTextAndRefs(content, messageId)
  if (messageType === "image" && typeof content.image_key === "string") {
    return { text: "", refs: [feishuRefFromFile(messageId, content.image_key, "image", content)] }
  }
  if (messageType === "file" && typeof content.file_key === "string") {
    return { text: "", refs: [feishuRefFromFile(messageId, content.file_key, "file", content)] }
  }
  if (messageType === "audio" && typeof content.file_key === "string") {
    return { text: "", refs: [feishuRefFromFile(messageId, content.file_key, "audio", content)] }
  }
  if ((messageType === "media" || messageType === "video") && typeof content.file_key === "string") {
    return { text: "", refs: [feishuRefFromFile(messageId, content.file_key, "video", content)] }
  }
  return { text: "", refs: [] }
}

function syntheticMessageId(feishuId: string, outbound: FeishuOutbound): number {
  return outbound.syntheticMessageId(feishuId) ?? outbound.registerInbound(feishuId, 0)
}

function isGroup(event: FeishuMessageEvent): boolean {
  return event.message?.chat_type !== "p2p"
}

/**
 * Translates Feishu events into synthetic grammY Updates. The bridge then runs
 * the exact Telegram command stack, so menus, buttons, reminders, schedules,
 * operations and admin commands stay in one place. Long-running command work
 * is submitted asynchronously: Feishu retries an event if the handler blocks
 * for roughly three seconds.
 */
export class FeishuService {
  readonly #deps: FeishuServiceDeps
  readonly #seenEvents = new Map<string, number>()
  readonly #seenActions = new Map<string, number>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  #nextUpdateId = 5_000_000_000
  #started = false

  constructor(deps: FeishuServiceDeps) {
    this.#deps = deps
  }

  /** Test seam and graceful close for the runtime wrapper. */
  get started(): boolean {
    return this.#started
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#deps.dispatcher.register({
      "im.message.receive_v1": (raw: unknown) => this.#receive(raw as FeishuMessageEvent),
      "card.action.trigger": (raw: unknown) => this.handleCardAction(raw as FeishuCardEvent),
    })
    void this.#deps.ws.start({ eventDispatcher: this.#deps.dispatcher }).catch((err: unknown) => {
      const failure = err instanceof Error ? err : new Error(String(err))
      this.#deps.log.error("飞书长连接启动失败：", failure.message)
      this.#deps.onFatal?.(failure)
    })
    this.#deps.log.info("Feishu long connection starting")
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#deps.ws.close({ force: true })
    this.#started = false
  }

  /** Bounded dedupe: Feishu redelivers an unacknowledged event, but not forever. */
  #once(map: Map<string, number>, key: string): boolean {
    if (!key) return true
    if (map.has(key)) return false
    map.set(key, Date.now())
    while (map.size > MAX_SEEN) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
    return true
  }

  async #receive(event: FeishuMessageEvent): Promise<unknown> {
    const message = event.message
    if (!message?.message_id || !message.chat_id) return undefined
    const openId = event.sender?.sender_id?.open_id
    if (!openId || event.sender?.sender_type === "app") return undefined
    if (isGroup(event)) return undefined
    if (!this.#once(this.#seenEvents, event.event_id ?? message.message_id)) return undefined

    const userId = this.#deps.identities.user(openId)
    const chatId = this.#deps.identities.chat(message.chat_id)
    if (this.#ownerEligible(openId)) this.#deps.identities.bindOwner(message.chat_id, userId)
    this.#deps.outbound.registerChat(message.chat_id, chatId)
    this.#deps.outbound.registerInbound(message.message_id, chatId)
    const parsed = parseFeishuMessage(message.message_id, message.message_type, message.content)
    const timestamp = Math.floor(Date.now() / 1000)
    const base = {
      message_id: syntheticMessageId(message.message_id, this.#deps.outbound),
      date: timestamp,
      chat: { id: chatId, type: "private" as const, first_name: openId },
      from: { id: userId, is_bot: false, first_name: openId },
    }
    const hasMedia = parsed.refs.length > 0
    const synthetic = feishuMessageToTelegram(
      {
        ...base,
        text: hasMedia ? undefined : parsed.text,
        caption: hasMedia ? parsed.text || undefined : undefined,
      } as Message,
      parsed.refs,
    )
    const update = {
      update_id: this.#nextUpdateId++,
      message: synthetic,
    } as Update
    // Reminders and the usage report can start only once an owner chat exists.
    this.#deps.onFirstChat?.()
    void this.#deps.bridge.handleUpdate(update).catch((err: unknown) => {
      this.#deps.log.error("飞书消息处理失败：", err instanceof Error ? err.message : String(err))
    })
    return undefined
  }

  /** Shared by the long connection and the HTTP callback transport. */
  async handleCardAction(event: FeishuCardEvent): Promise<Record<string, unknown> | undefined> {
    const parsed = parseFeishuCardAction(event)
    if (!parsed) return undefined
    // A genuine redelivery repeats event_id/token. The old action-key dedupe also
    // swallowed a legitimate second click on the same button.
    const dedupeKey =
      parsed.eventId ?? parsed.token ?? `${parsed.openMessageId}:${parsed.openId}:${parsed.data}:${event.token ?? ""}`
    if (!this.#once(this.#seenActions, dedupeKey)) return undefined
    const userId = this.#deps.identities.user(parsed.openId)
    const cachedChat = this.#deps.outbound.chatForFeishuMessage(parsed.openMessageId)
    const chatKey = parsed.openChatId ?? (cachedChat !== undefined ? this.#deps.identities.chatExternalId(cachedChat) : undefined)
    if (!chatKey) return undefined
    const chatId = this.#deps.identities.chat(chatKey)
    this.#deps.outbound.registerChat(chatKey, chatId)
    if (this.#ownerEligible(parsed.openId)) this.#deps.identities.bindOwner(chatKey, userId)
    this.#deps.onFirstChat?.()
    const messageId = syntheticMessageId(parsed.openMessageId, this.#deps.outbound)
    const queryId = `fs:${parsed.openMessageId}:${this.#nextUpdateId++}`
    const update = {
      update_id: this.#nextUpdateId++,
      callback_query: {
        id: queryId,
        from: { id: userId, is_bot: false, first_name: parsed.openId },
        chat_instance: String(chatId),
        data: parsed.data,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private" as const, first_name: parsed.openId },
          text: "panel",
        },
      },
    } as Update
    const work = this.#deps.bridge.handleUpdate(update).catch((err: unknown) => {
      this.#deps.log.error("飞书按钮处理失败：", err instanceof Error ? err.message : String(err))
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), EVENT_RESPONSE_DEADLINE_MS)
      this.#timers.add(timer)
    })
    try {
      const toast = await Promise.race([
        work.then(() => {
          const value = this.#deps.outbound.callbackToasts.get(queryId)
          this.#deps.outbound.callbackToasts.delete(queryId)
          return value
        }),
        timeout,
      ])
      return toast ? { toast: { type: "info", content: toast } } : undefined
    } finally {
      if (timer) {
        clearTimeout(timer)
        this.#timers.delete(timer)
      }
    }
  }

  #ownerEligible(openId: string): boolean {
    const feishu = this.#deps.cfg.feishu
    return Boolean(feishu && (feishu.allowAll || feishu.allowOpenIds.has(openId)))
  }
}

export { asFeishuApi, FeishuApiLike }
