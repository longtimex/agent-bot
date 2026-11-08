import { unlinkSync } from "node:fs"
import type { Bot } from "grammy"
import type { Message } from "grammy/types"
import { buildAttachmentSections, MAX_ATTACH_TOTAL_BYTES } from "./attachmentInput.js"
import {
  isTextAttachment,
  pruneInbox,
  readTextAttachment,
  saveAttachment,
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
const MAX_ATTACH_FILE_BYTES = 10 * 1024 * 1024
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024

export interface AttachmentCommandDeps {
  bot: Bot
  cfg: BotConfig
  oc: Opencode
  maskToken: (text: string) => string
  log: Logger
  feishuDownload?: (ref: FeishuResourceRef, signal?: AbortSignal) => Promise<Buffer>
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
        kind: mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "document",
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
        kind: "document",
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
      if (!this.#deps.feishuDownload) throw new Error("飞书附件下载器未配置")
      const data = await this.#deps.feishuDownload(feishuRef, signal)
      if (signal?.aborted) throw new Error("已取消下载")
      if (data.byteLength > this.#deps.cfg.maxInputBytes) {
        throw new Error(`超过 ${Math.round(this.#deps.cfg.maxInputBytes / 1024 / 1024)}MB 上限`)
      }
      const saved = saveAttachment(this.#deps.cfg.inboxDir, chatId, att.name, data)
      const result: SavedAttachment = { ...att, path: saved.path, bytes: data.byteLength }
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
    const data = Buffer.from(await res.arrayBuffer())
    // MAX_INPUT_MB may be raised for Feishu's 100MB message-resource API; the
    // Bot API's getFile endpoint still refuses anything over 20MB.
    const telegramLimit = Math.min(this.#deps.cfg.maxInputBytes, TELEGRAM_DOWNLOAD_LIMIT)
    if (data.byteLength > telegramLimit) {
      throw new Error(`超过 ${Math.round(telegramLimit / 1024 / 1024)}MB 上限`)
    }

    const saved = saveAttachment(this.#deps.cfg.inboxDir, chatId, att.name, data)
    const result: SavedAttachment = { ...att, path: saved.path, bytes: data.byteLength }
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
    let totalBytes = 0

    for (const att of job.attachments ?? []) {
      if (totalBytes + (att.size ?? 0) > MAX_ATTACH_TOTAL_BYTES) {
        failed.push(`${att.name}: 附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
        continue
      }
      try {
        const item = await this.downloadAttachment(job.chatId, att, signal)
        if (totalBytes + item.bytes > MAX_ATTACH_TOTAL_BYTES) {
          failed.push(`${att.name}: 附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
          // The copy is already on disk; drop it so oversized batches do not fill the inbox
          try {
            unlinkSync(item.path)
          } catch {
            // already gone
          }
          continue
        }
        totalBytes += item.bytes
        saved.push(item)
      } catch (err) {
        // Telegram client errors can quote the API URL, which contains the bot token
        const detail = this.#deps.maskToken(redactSecrets(err instanceof Error ? err.message : String(err)))
        failed.push(`${att.name}: ${detail}`)
      }
    }
    pruneInbox(this.#deps.cfg.inboxDir)

    const caps = model ? await this.#deps.oc.inputCapabilities(model) : undefined
    const stt = await applyStt(saved, { stt: this.#deps.cfg.stt, modelCapabilities: caps, maxBytes: MAX_ATTACH_FILE_BYTES })
    failed.push(...stt.errors)
    return buildAttachmentSections(job.text, { saved: stt.saved, failed, modelCapabilities: caps })
  }

}
