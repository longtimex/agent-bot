import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { InputFile } from "grammy"
import type { InlineKeyboard } from "grammy"
import type { Message } from "grammy/types"
import { buildFeishuCard } from "./feishuCards.js"
import { asFeishuApi, type FeishuApiLike, type FeishuClientLike } from "./feishuTypes.js"

const FEISHU_IMAGE_LIMIT = 10 * 1024 * 1024
const FEISHU_FILE_LIMIT = 30 * 1024 * 1024
const MAX_CACHE_ENTRIES = 2_000

/** Opus duration from the Ogg page granule, or undefined when the header is unusable. */
function oggOpusDurationMs(data: Buffer): number | undefined {
  if (data.length < 28 || data.toString("ascii", 0, 4) !== "OggS") return undefined
  if (data[4] !== 0) return undefined
  // The last page's granule is the sample count at 48 kHz (RFC 7845 §4)
  let last = data.length - 27
  while (last >= 0 && data.toString("ascii", last, last + 4) !== "OggS") last -= 1
  if (last < 0 || last + 14 > data.length || last + 27 + data[last + 26]! > data.length) return undefined
  const samples = data.readBigUInt64LE(last + 6)
  return samples > 0n ? Number(samples / 48n) : undefined
}

/** MP4 duration from the movie header, without pulling in an ffprobe dependency. */
function mp4DurationMs(data: Buffer): number | undefined {
  const readSize = (at: number): number => {
    const size = data.readUInt32BE(at)
    return size === 1 && at + 16 <= data.length ? Number(data.readBigUInt64BE(at + 8)) : size
  }
  const walk = (from: number, to: number, depth: number): number | undefined => {
    if (depth > 6) return undefined
    let offset = from
    while (offset + 8 <= to) {
      const size = readSize(offset)
      const type = data.toString("ascii", offset + 4, offset + 8)
      if (size < 8 || offset + size > to) break
      if (type === "mvhd") {
        const version = data[offset + 8]
        const base = offset + 12
        if (version === 0 && base + 16 <= offset + size) {
          const timescale = data.readUInt32BE(base + 8)
          const duration = data.readUInt32BE(base + 12)
          return timescale > 0 ? Math.round((duration / timescale) * 1000) : undefined
        }
        if (version === 1 && base + 28 <= offset + size) {
          const timescale = data.readUInt32BE(base + 16)
          const duration = data.readBigUInt64BE(base + 20)
          return timescale > 0 ? Number((duration / BigInt(timescale)) * 1000n) : undefined
        }
      }
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) {
        const found = walk(offset + 8, offset + size, depth + 1)
        if (found !== undefined) return found
      }
      offset += size
    }
    return undefined
  }
  return data.length >= 12 ? walk(0, data.length, 0) : undefined
}

interface CachedMessage {
  feishuId: string
  chatId: number
  syntheticId: number
}

interface CachedChat {
  receiveId: string
  numericId: number
}

function receiveIdType(id: string): "chat_id" | "open_id" {
  return id.startsWith("oc_") ? "chat_id" : "open_id"
}

function contentJson(card: unknown): string {
  return JSON.stringify(card)
}

function fileTypeFor(name: string, mime: string | undefined, kind: "voice" | "video" | "document"): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  if (kind === "voice") return "opus"
  if (kind === "video") return "mp4"
  const ext = name.toLowerCase().split(".").pop() ?? ""
  if (ext === "pdf") return "pdf"
  if (["doc", "docx"].includes(ext)) return "doc"
  if (["xls", "xlsx", "csv"].includes(ext)) return "xls"
  if (["ppt", "pptx"].includes(ext)) return "ppt"
  if (mime?.startsWith("image/")) return "stream"
  return "stream"
}

function durationFor(data: Buffer, fileType: "opus" | "mp4"): number | undefined {
  try {
    return fileType === "opus" ? oggOpusDurationMs(data) : mp4DurationMs(data)
  } catch {
    return undefined
  }
}

/** Reads a grammY InputFile-like source, including local paths, for Feishu uploads. */
async function inputBytes(value: unknown): Promise<{ data: Buffer; name?: string }> {
  if (value instanceof InputFile) {
    const raw = await value.toRaw()
    if (raw instanceof Uint8Array) {
      // Buffer is a Uint8Array subclass, but copy it anyway: an upload adapter must
      // not retain a caller-owned buffer that Telegram code may mutate or reuse.
      return { data: Buffer.from(raw), name: value.filename }
    }
    if (typeof raw === "object" && raw !== null && Symbol.asyncIterator in raw) {
      const chunks: Buffer[] = []
      for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
      return { data: Buffer.concat(chunks), name: value.filename }
    }
    if (typeof raw === "object" && raw !== null && Symbol.iterator in raw) {
      const chunks: Buffer[] = []
      for (const chunk of raw as Iterable<Uint8Array>) chunks.push(Buffer.from(chunk))
      return { data: Buffer.concat(chunks), name: value.filename }
    }
    throw new Error("无法读取待发送文件")
  }
  if (typeof value === "string") return { data: readFileSync(value), name: basename(value) }
  if (value instanceof URL) return { data: readFileSync(value), name: basename(value.pathname) }
  if (value instanceof Uint8Array) return { data: Buffer.from(value) }
  if (Buffer.isBuffer(value)) return { data: value }
  throw new Error("无法读取待发送文件")
}

/**
 * Translates the handful of Bot API methods the bridge actually calls into
 * Feishu APIs. Everything else still goes to Telegram, so one TelegramBot
 * instance can serve both channels. The map from synthetic Telegram ids to
 * Feishu message ids is bounded because panels are edited frequently.
 */
export class FeishuOutbound {
  readonly #api: FeishuApiLike
  readonly #bySynthetic = new Map<number, CachedMessage>()
  readonly #byFeishu = new Map<string, CachedMessage>()
  readonly #chats = new Map<string, CachedChat>()
  #nextSynthetic = 1_000_000_000
  readonly callbackToasts = new Map<string, string>()

  constructor(client: FeishuClientLike) {
    this.#api = asFeishuApi(client)
  }

  get api(): FeishuApiLike {
    return this.#api
  }

  /** Canonical Feishu id for a synthetic Telegram chat/message id. */
  feishuMessageId(syntheticId: number): string | undefined {
    return this.#bySynthetic.get(syntheticId)?.feishuId
  }

  syntheticMessageId(feishuId: string): number | undefined {
    return this.#byFeishu.get(feishuId)?.syntheticId
  }

  registerInbound(messageId: string, chatId: number): number {
    const existing = this.#byFeishu.get(messageId)
    if (existing) return existing.syntheticId
    const syntheticId = this.#nextSynthetic++
    const entry = { feishuId: messageId, chatId, syntheticId }
    this.#byFeishu.set(messageId, entry)
    this.#bySynthetic.set(syntheticId, entry)
    this.#trim()
    return syntheticId
  }

  /** Records the external chat id behind a synthetic chat id; never holds message content. */
  registerChat(receiveId: string, chatId: number): void {
    if (!receiveId) return
    this.#chats.set(receiveId, { receiveId, numericId: chatId })
  }

  /** Feishu receive id for outbound calls. Inbound messages register the exact id. */
  receiveIdForChat(chatId: number): string | undefined {
    for (const entry of this.#chats.values()) {
      if (entry.numericId === chatId) return entry.receiveId
    }
    return undefined
  }

  /** Resolves the chat for a button click whose callback payload omitted open_chat_id. */
  chatForFeishuMessage(feishuId: string): number | undefined {
    return this.#byFeishu.get(feishuId)?.chatId
  }

  #trim(): void {
    while (this.#byFeishu.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#byFeishu.keys().next()
      if (oldest.done) break
      const entry = this.#byFeishu.get(oldest.value)
      this.#byFeishu.delete(oldest.value)
      if (entry) this.#bySynthetic.delete(entry.syntheticId)
    }
  }

  #remember(feishuId: string, chatId: number): number {
    const syntheticId = this.#nextSynthetic++
    const entry = { feishuId, chatId, syntheticId }
    this.#byFeishu.set(feishuId, entry)
    this.#bySynthetic.set(syntheticId, entry)
    this.#trim()
    return syntheticId
  }

  chatFor(messageId: number): number | undefined {
    return this.#bySynthetic.get(messageId)?.chatId
  }

  async sendMessage(chatId: number, receiveId: string, text: string, keyboard?: InlineKeyboard): Promise<Message> {
    this.registerChat(receiveId, chatId)
    const card = buildFeishuCard(text, keyboard)
    const response = await this.#api.im.v1.message.create({
      params: { receive_id_type: receiveIdType(receiveId) },
      data: { receive_id: receiveId, msg_type: "interactive", content: contentJson(card) },
    })
    const id = response.data?.message_id
    if (!id) throw new Error("飞书未返回 message_id")
    const messageId = this.#remember(id, chatId)
    return {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      text,
    } as Message
  }

  async editMessage(messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const feishuId = this.feishuMessageId(messageId)
    if (!feishuId) throw new Error("飞书消息不存在或已过期")
    await this.#api.im.v1.message.patch({
      path: { message_id: feishuId },
      data: { content: contentJson(buildFeishuCard(text, keyboard)) },
    })
  }

  async deleteMessage(messageId: number): Promise<void> {
    const feishuId = this.feishuMessageId(messageId)
    if (!feishuId) return
    await this.#api.im.v1.message.delete({ path: { message_id: feishuId } })
    this.#bySynthetic.delete(messageId)
    this.#byFeishu.delete(feishuId)
  }

  async sendImage(chatId: number, receiveId: string, file: unknown, caption?: string): Promise<Message> {
    const { data, name } = await inputBytes(file)
    if (data.byteLength > FEISHU_IMAGE_LIMIT) {
      return this.sendDocument(chatId, receiveId, file, name, caption)
    }
    const uploaded = await this.#api.im.v1.image.create({ data: { image_type: "message", image: data } })
    const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key
    if (!imageKey) throw new Error("飞书图片上传失败")
    return this.#sendRaw(chatId, receiveId, "image", { image_key: imageKey }, caption)
  }

  async sendDocument(chatId: number, receiveId: string, file: unknown, name?: string, caption?: string): Promise<Message> {
    const source = await inputBytes(file)
    const fileName = name ?? source.name ?? "file.bin"
    if (source.data.byteLength > FEISHU_FILE_LIMIT) {
      throw new Error(`飞书文件超过 ${Math.round(FEISHU_FILE_LIMIT / 1024 / 1024)}MB 上限`)
    }
    const uploaded = await this.#api.im.v1.file.create({
      data: {
        file_type: fileTypeFor(fileName, undefined, "document"),
        file_name: fileName,
        file: source.data,
      },
    })
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key
    if (!fileKey) throw new Error("飞书文件上传失败")
    return this.#sendRaw(chatId, receiveId, "file", { file_key: fileKey, file_name: fileName }, caption)
  }

  async sendVoice(chatId: number, receiveId: string, file: unknown, caption?: string): Promise<Message> {
    const source = await inputBytes(file)
    const fileName = source.name ?? "voice.opus"
    const uploaded = await this.#api.im.v1.file.create({
      data: {
        file_type: "opus",
        file_name: fileName,
        duration: durationFor(source.data, "opus"),
        file: source.data,
      },
    })
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key
    if (!fileKey) throw new Error("飞书语音上传失败")
    return this.#sendRaw(chatId, receiveId, "audio", { file_key: fileKey }, caption)
  }

  async sendVideo(chatId: number, receiveId: string, file: unknown, caption?: string): Promise<Message> {
    const source = await inputBytes(file)
    const fileName = source.name ?? "video.mp4"
    const uploaded = await this.#api.im.v1.file.create({
      data: {
        file_type: "mp4",
        file_name: fileName,
        duration: durationFor(source.data, "mp4"),
        file: source.data,
      },
    })
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key
    if (!fileKey) throw new Error("飞书视频上传失败")
    return this.#sendRaw(chatId, receiveId, "media", { file_key: fileKey }, caption)
  }

  async #sendRaw(chatId: number, receiveId: string, msgType: string, content: Record<string, unknown>, caption?: string): Promise<Message> {
    this.registerChat(receiveId, chatId)
    const response = await this.#api.im.v1.message.create({
      params: { receive_id_type: receiveIdType(receiveId) },
      data: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) },
    })
    const id = response.data?.message_id
    if (!id) throw new Error("飞书未返回 message_id")
    const messageId = this.#remember(id, chatId)
    // Feishu image/file messages have no caption field. Send it as a second
    // card so /api's QR caption, media descriptions and error contexts survive.
    if (caption) await this.sendMessage(chatId, receiveId, caption)
    return {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      caption,
    } as Message
  }

  async answerCallback(queryId: string, text?: string): Promise<boolean> {
    if (!text) return false
    this.callbackToasts.set(queryId, text)
    return true
  }
}

/**
 * Installs a Bot API transformer on a grammY Bot. It only intercepts targets
 * that belong to the Feishu identity namespace; Telegram calls continue to
 * reach the original `prev` implementation unchanged.
 */
export function installFeishuTransformer(
  bot: { api: { config: { use(transformer: unknown): unknown } } },
  outbound: FeishuOutbound,
  channel: {
    isFeishuId(id: number): boolean
    receiveIdForChat?(chatId: number): string | undefined
  },
): void {
  bot.api.config.use(async (prev: unknown, method: string, payload: Record<string, unknown>) => {
    const chatId = typeof payload.chat_id === "number" ? payload.chat_id : undefined
    // answerCallbackQuery carries only its query id. Feishu query ids use the
    // `fs:` prefix, so this branch must come before chat-id routing.
    if (method === "answerCallbackQuery" && String(payload.callback_query_id ?? "").startsWith("fs:")) {
      await outbound.answerCallback(
        String(payload.callback_query_id),
        typeof payload.text === "string" ? payload.text : undefined,
      )
      return { ok: true, result: true }
    }
    const isFeishu = chatId !== undefined && channel.isFeishuId(chatId)
    if (!isFeishu) return (prev as (...args: unknown[]) => Promise<unknown>)(method, payload)

    if (method === "sendChatAction") {
      return { ok: true, result: true }
    }
    if (method === "getFile") {
      throw new Error("飞书文件应通过 messageResource 下载")
    }

    const receiveId = channel.receiveIdForChat?.(chatId) ?? outbound.receiveIdForChat(chatId)
    if (!receiveId) throw new Error("飞书聊天映射不存在")
    if (method === "sendMessage") {
      const keyboard = payload.reply_markup as InlineKeyboard | undefined
      return { ok: true, result: await outbound.sendMessage(chatId, receiveId, String(payload.text ?? ""), keyboard) }
    }
    if (method === "editMessageText") {
      const messageId = Number(payload.message_id)
      const keyboard = payload.reply_markup as InlineKeyboard | undefined
      await outbound.editMessage(messageId, String(payload.text ?? ""), keyboard)
      return { ok: true, result: true }
    }
    if (method === "deleteMessage") {
      await outbound.deleteMessage(Number(payload.message_id))
      return { ok: true, result: true }
    }
    const caption = typeof payload.caption === "string" ? payload.caption : undefined
    if (method === "sendPhoto") {
      return { ok: true, result: await outbound.sendImage(chatId, receiveId, payload.photo, caption) }
    }
    if (method === "sendDocument") {
      return { ok: true, result: await outbound.sendDocument(chatId, receiveId, payload.document, undefined, caption) }
    }
    if (method === "sendVoice") {
      return { ok: true, result: await outbound.sendVoice(chatId, receiveId, payload.voice, caption) }
    }
    if (method === "sendVideo") {
      return { ok: true, result: await outbound.sendVideo(chatId, receiveId, payload.video, caption) }
    }
    if (method === "setMyCommands") {
      return { ok: true, result: true }
    }
    return (prev as (...args: unknown[]) => Promise<unknown>)(method, payload)
  })
}
