import { extname } from "node:path"
import type { Message } from "grammy/types"
import type { AttachmentDescriptor } from "./attachments.js"
import type { FeishuApiLike } from "./feishuTypes.js"

export const FEISHU_FILE_PREFIX = "feishu:"
/** Internal marker on a synthetic grammY Message carrying every resource in one Feishu event. */
export const FEISHU_RESOURCE_REFS = "__feishuResourceRefs"

export interface FeishuResourceRef {
  messageId: string
  fileKey: string
  type: "image" | "file" | "audio" | "video"
  name: string
  mime: string
}

/** The Telegram-shaped file_id carries everything the downloader needs without a cache. */
export function encodeFeishuFileId(ref: FeishuResourceRef): string {
  return `${FEISHU_FILE_PREFIX}${Buffer.from(JSON.stringify(ref), "utf8").toString("base64url")}`
}

export function decodeFeishuFileId(fileId: string): FeishuResourceRef | undefined {
  if (!fileId.startsWith(FEISHU_FILE_PREFIX)) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(fileId.slice(FEISHU_FILE_PREFIX.length), "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object") return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.messageId !== "string" || !record.messageId) return undefined
    if (typeof record.fileKey !== "string" || !record.fileKey) return undefined
    if (record.type !== "image" && record.type !== "file" && record.type !== "audio" && record.type !== "video") return undefined
    if (typeof record.name !== "string" || !record.name) return undefined
    if (typeof record.mime !== "string" || !record.mime) return undefined
    return {
      messageId: record.messageId,
      fileKey: record.fileKey,
      type: record.type,
      name: record.name,
      mime: record.mime,
    }
  } catch {
    return undefined
  }
}

function extensionFor(ref: FeishuResourceRef): string {
  const existing = extname(ref.name)
  if (existing) return existing
  if (ref.type === "image") return ".jpg"
  if (ref.type === "audio") return ".opus"
  if (ref.type === "video") return ".mp4"
  return ".bin"
}

/** Feishu reuses file_key as a file identifier, but a real filename is preferable. */
function safeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function parsedContent(message: Message): Record<string, unknown> | undefined {
  const text = (message.caption ?? message.text ?? "").trim()
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * The Feishu event is mapped to a Telegram Message so downstream command code
 * is untouched. The synthetic message keeps the raw resource metadata in an
 * unused text field, while the normal media fields make the existing
 * TelegramAttachments collector find the file. `feishu:` file ids decode back
 * to the exact resource instead of requiring a message-id cache.
 */
export function feishuMessageToTelegram(message: Message, refs: FeishuResourceRef[]): Message {
  if (refs.length === 0) return message
  const first = refs[0]!
  const fileId = encodeFeishuFileId(first)
  // Telegram has one media slot per message; rich posts can carry several
  // images/files. The collector reads this marker first, while the native
  // field below keeps grammY's message:photo/document/voice routing working.
  const withRefs = { ...message, [FEISHU_RESOURCE_REFS]: refs } as Message
  if (first.type === "image") {
    return {
      ...withRefs,
      photo: [{ file_id: fileId, file_unique_id: first.fileKey, width: 0, height: 0 }],
    }
  }
  if (first.type === "audio") {
    return {
      ...withRefs,
      voice: { file_id: fileId, file_unique_id: first.fileKey, duration: 0, mime_type: first.mime },
    }
  }
  if (first.type === "video") {
    return {
      ...withRefs,
      video: {
        file_id: fileId,
        file_unique_id: first.fileKey,
        width: 0,
        height: 0,
        duration: 0,
        file_name: first.name || `video-${first.fileKey.slice(-8)}.mp4`,
        mime_type: first.mime,
      },
    }
  }
  return {
    ...withRefs,
    document: {
      file_id: fileId,
      file_unique_id: first.fileKey,
      file_name: first.name || `file-${first.fileKey.slice(-8)}${extensionFor(first)}`,
      mime_type: first.mime,
    },
  }
}

export interface FeishuAttachmentDownloadDeps {
  client: FeishuApiLike
  /** 0 disables the application-level ceiling. */
  maxBytes: number
}

/** Streaming download into memory; callers that need disk use the stream variant below. */
export async function downloadFeishuResource(
  deps: FeishuAttachmentDownloadDeps,
  ref: FeishuResourceRef,
  signal?: AbortSignal,
): Promise<Buffer> {
  // The message-resource endpoint accepts image/file/audio/media. A video is
  // downloaded as `media`; passing `video` makes Feishu reject the request.
  const resourceType = ref.type === "video" ? "media" : ref.type
  const response = await deps.client.im.v1.messageResource.get({
    params: { type: resourceType },
    path: { message_id: ref.messageId, file_key: ref.fileKey },
  })
  const stream = response.getReadableStream()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      if (signal?.aborted) throw new Error("已取消下载")
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += data.byteLength
      if (deps.maxBytes > 0 && total > deps.maxBytes) {
        throw new Error(`超过配置的 ${Math.round(deps.maxBytes / 1024 / 1024)}MB 下载上限（MAX_INPUT_MB，0 表示不限）`)
      }
      chunks.push(data)
    }
  } finally {
    // Node streams expose destroy; the SDK's readable is a Node stream.
    ;(stream as { destroy?: () => void }).destroy?.()
  }
  return Buffer.concat(chunks, total)
}

export interface FeishuStreamDeps {
  client: FeishuApiLike
  /** 0 disables the application-level ceiling. */
  maxBytes: number
  signal?: AbortSignal
}

/** Streams a Feishu resource without holding the whole file in memory. */
export async function* openFeishuResourceStream(
  deps: FeishuStreamDeps,
  ref: FeishuResourceRef,
): AsyncGenerator<Uint8Array> {
  const resourceType = ref.type === "video" ? "media" : ref.type
  const response = await deps.client.im.v1.messageResource.get({
    params: { type: resourceType },
    path: { message_id: ref.messageId, file_key: ref.fileKey },
  })
  const stream = response.getReadableStream() as AsyncIterable<Buffer | Uint8Array> & { destroy?: () => void }
  let total = 0
  try {
    for await (const chunk of stream) {
      if (deps.signal?.aborted) throw new Error("已取消下载")
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += data.byteLength
      if (deps.maxBytes > 0 && total > deps.maxBytes) {
        throw new Error(`超过配置的 ${Math.round(deps.maxBytes / 1024 / 1024)}MB 下载上限（MAX_INPUT_MB，0 表示不限）`)
      }
      yield data
    }
  } finally {
    stream.destroy?.()
  }
}

export function attachmentFromRef(ref: FeishuResourceRef): AttachmentDescriptor {
  return {
    fileId: encodeFeishuFileId(ref),
    kind: ref.type === "image" ? "image" : ref.type === "audio" ? "audio" : ref.type === "video" ? "video" : "document",
    name: ref.name,
    mime: ref.mime,
  }
}

/** Feishu file names are optional; a stable synthetic name keeps extension handling useful. */
export function feishuRefFromFile(
  messageId: string,
  fileKey: string,
  type: FeishuResourceRef["type"],
  raw: Record<string, unknown> = {},
): FeishuResourceRef {
  const fileName = safeText(raw.file_name) ?? safeText(raw.name)
  const mime =
    safeText(raw.mime_type) ??
    (type === "image" ? "image/jpeg" : type === "audio" ? "audio/opus" : type === "video" ? "video/mp4" : "application/octet-stream")
  const fallbackName =
    type === "image"
      ? `image-${fileKey.slice(-8)}.jpg`
      : type === "audio"
        ? `audio-${fileKey.slice(-8)}.opus`
        : type === "video"
          ? `video-${fileKey.slice(-8)}.mp4`
          : `file-${fileKey.slice(-8)}.bin`
  return {
    messageId,
    fileKey,
    type,
    name: fileName ?? fallbackName,
    mime,
  }
}

/** Kept for message parsers that have already extracted the local content JSON. */
export function feishuContentObject(message: Message): Record<string, unknown> | undefined {
  return parsedContent(message)
}
