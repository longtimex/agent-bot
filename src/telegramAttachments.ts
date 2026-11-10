import type { Bot } from "grammy"
import type { Message } from "grammy/types"
import { buildAttachmentSections } from "./attachmentInput.js"
import {
  attachmentKind,
  isTextAttachment,
  pruneInbox,
  readTextAttachment,
  saveAttachmentStream,
  type AttachmentDescriptor,
  type SavedAttachment,
} from "./attachments.js"
import { redactSecrets } from "./ccswitch.js"
import type { BotConfig, ModelRef } from "./config.js"
import type { Logger } from "./logger.js"
import type { Opencode, PromptFile } from "./opencode.js"
import { applyStt } from "./stt.js"
import type { Job } from "./telegram.js"
import { extensionFromMime } from "./telegramSupport.js"
import {
  attachmentFromRef,
  decodeFeishuFileId,
  FEISHU_RESOURCE_REFS,
  type FeishuResourceRef,
} from "./feishuAttachments.js"

const MAX_ATTACHMENTS = 4
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024

export interface AttachmentCommandDeps {
  bot: Bot
  cfg: BotConfig
  oc: Opencode
  maskToken: (text: string) => string
  log: Logger
  feishuStream?: (ref: FeishuResourceRef, signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array>>
}

export class TelegramAttachments {
  readonly #deps: AttachmentCommandDeps

  constructor(deps: AttachmentCommandDeps) {
    this.#deps = deps
  }

  collectAttachments(message: Message): AttachmentDescriptor[] {
    const attachments: AttachmentDescriptor[] = []
    const feishuRefs = (message as unknown as Record<string, unknown>)[FEISHU_RESOURCE_REFS]
    if (Array.isArray(feishuRefs)) {
      for (const ref of feishuRefs as FeishuResourceRef[]) attachments.push(attachmentFromRef(ref))
      return attachments.slice(0, MAX_ATTACHMENTS)
    }

    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1]!
      attachments.push({
        fileId: largest.file_id,
        kind: "image",
        name: `photo-${largest.file_id.slice(-8)}.jpg`,
        mime: "image/jpeg",
        size: largest.file_size,
      })
    }

    if (message.document) {
      const doc = message.document
      const mime = doc.mime_type ?? "application/octet-stream"
      attachments.push({
        fileId: doc.file_id,
        kind: attachmentKind(mime, doc.file_name),
        name: doc.file_name ?? `document-${doc.file_id.slice(-8)}${extensionFromMime(mime)}`,
        mime,
        size: doc.file_size,
      })
    }

    if (message.voice) {
      const mime = message.voice.mime_type ?? "audio/ogg"
      attachments.push({
        fileId: message.voice.file_id,
        kind: "audio",
        name: `voice-${message.voice.file_id.slice(-8)}${extensionFromMime(mime) || ".ogg"}`,
        mime,
        size: message.voice.file_size,
      })
    }

    if (message.audio) {
      const mime = message.audio.mime_type ?? "audio/mpeg"
      attachments.push({
        fileId: message.audio.file_id,
        kind: "audio",
        name: message.audio.file_name ?? `audio-${message.audio.file_id.slice(-8)}${extensionFromMime(mime) || ".mp3"}`,
        mime,
        size: message.audio.file_size,
      })
    }

    if (message.video) {
      const mime = message.video.mime_type ?? "video/mp4"
      attachments.push({
        fileId: message.video.file_id,
        kind: "video",
        name: message.video.file_name ?? `video-${message.video.file_id.slice(-8)}${extensionFromMime(mime) || ".mp4"}`,
        mime,
        size: message.video.file_size,
      })
    }

    return attachments.slice(0, MAX_ATTACHMENTS)
  }

  async downloadAttachment(chatId: number, att: AttachmentDescriptor, signal?: AbortSignal): Promise<SavedAttachment> {
    const feishuRef = decodeFeishuFileId(att.fileId)
    if (feishuRef) {
      if (!this.#deps.feishuStream) throw new Error("飞书附件下载器未配置")
      const source = await this.#deps.feishuStream(feishuRef, signal)
      const saved = await saveAttachmentStream(this.#deps.cfg.inboxDir, chatId, att.name, source)
      if (signal?.aborted) throw new Error("已取消下载")
      const result: SavedAttachment = { ...att, path: saved.path, bytes: saved.bytes }
      if (isTextAttachment(att.mime, saved.name)) {
        try {
          const { text, truncated } = readTextAttachment(result.path)
          result.text = text
          result.truncated = truncated
        } catch {
          // treat as binary if decoding fails
        }
      }
      return result
    }
    const file = await this.#deps.bot.api.getFile(att.fileId)
    if (!file.file_path) throw new Error("Telegram 未返回文件路径（文件可能超过 20MB）")

    const url = `https://api.telegram.org/file/bot${this.#deps.cfg.telegram.token}/${file.file_path}`
    let res: Response
    try {
      // /stop must cut downloads short too, not only the engine call after them
      const timeout = AbortSignal.timeout(60_000)
      res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (err) {
      // undici can echo the request URL, which carries the bot token
      throw new Error(`下载附件失败：${this.#deps.maskToken(redactSecrets((err as Error).message))}`)
    }
    if (!res.ok) {
      // An unread body keeps the undici socket out of the pool for good
      await res.body?.cancel().catch(() => {})
      throw new Error(`下载失败 (HTTP ${res.status})`)
    }
    // Stream the response into the inbox. Buffering the whole file first defeated
    // the point of the streaming parser and made a near-20MB Telegram file consume
    // its size on the Node heap before it ever reached disk.
    const body = res.body
    if (!body) throw new Error("下载失败：Telegram 返回了空响应")
    const maxBytes = this.#deps.cfg.maxInputBytes
    let bytes = 0
    const limited = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of body) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += data.byteLength
        // The Bot API refuses getFile above 20MB before this code sees the bytes.
        // Keep that platform boundary visible instead of presenting it as our cap.
        if (bytes > TELEGRAM_DOWNLOAD_LIMIT) {
          throw new Error("Telegram Bot API 单文件下载上限为 20MB，超过后无法通过 getFile 获取")
        }
        if (maxBytes > 0 && bytes > maxBytes) {
          throw new Error(`超过配置的 ${Math.round(maxBytes / 1024 / 1024)}MB 下载上限（MAX_INPUT_MB，0 表示不限）`)
        }
        yield data
      }
    }
    const saved = await saveAttachmentStream(this.#deps.cfg.inboxDir, chatId, att.name, limited())
    const result: SavedAttachment = { ...att, path: saved.path, bytes: saved.bytes }
    if (isTextAttachment(att.mime, saved.name)) {
      try {
        const { text, truncated } = readTextAttachment(saved.path)
        result.text = text
        result.truncated = truncated
      } catch {
        // treat as binary if decoding fails
      }
    }
    return result
  }

  async buildAttachmentInput(job: Job, model?: ModelRef, signal?: AbortSignal): Promise<{ text: string; files: PromptFile[] }> {
    const saved: SavedAttachment[] = []
    const failed: string[] = []

    for (const att of job.attachments ?? []) {
      try {
        saved.push(await this.downloadAttachment(job.chatId, att, signal))
      } catch (err) {
        // Telegram client errors can quote the API URL, which contains the bot token
        const detail = this.#deps.maskToken(redactSecrets(err instanceof Error ? err.message : String(err)))
        failed.push(`${att.name}: ${detail}`)
      }
    }
    pruneInbox(this.#deps.cfg.inboxDir)

    const caps = model ? await this.#deps.oc.inputCapabilities(model) : undefined
    const stt = await applyStt(saved, { stt: this.#deps.cfg.stt, modelCapabilities: caps })
    failed.push(...stt.errors)
    return buildAttachmentSections(job.text, { saved: stt.saved, failed, modelCapabilities: caps })
  }

}
