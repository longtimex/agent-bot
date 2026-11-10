import { sep } from "node:path"
import { formatBytes, type SavedAttachment } from "./attachments.js"
import { OPENCODE_ATTACHMENT_LIMIT, type PromptFile } from "./opencode.js"

const MAX_INLINE_TEXT_TOTAL = 100_000

/** The subset of opencode /provider capabilities that gate direct file attachment. */
export interface ModelCapabilities {
  image?: boolean
  audio?: boolean
  video?: boolean
  pdf?: boolean
}

export interface AttachmentSectionsOptions {
  saved: SavedAttachment[]
  failed?: string[]
  modelCapabilities?: ModelCapabilities
}

export interface AttachmentInput {
  text: string
  files: PromptFile[]
}

/**
 * Turns saved attachments into the prompt sections shared by Telegram and the
 * HTTP API: an [用户附件] manifest, inlined text files, and binary files the
 * current model accepts (images / audio / video / PDF) attached by path.
 */
export function buildAttachmentSections(text: string, opts: AttachmentSectionsOptions): AttachmentInput {
  const { saved } = opts
  const notes: string[] = []
  const blocks: string[] = []
  const files: PromptFile[] = []
  let inlineChars = 0

  for (const item of saved) {
    // CLI engines run in the session work dir, which /dir can point anywhere: only an
    // absolute path names this file for every cwd a task can start in.
    const shown = item.path.split(sep).join("/")
    const label = item.kind === "image"
      ? "图片"
      : item.kind === "audio"
        ? "音频"
        : item.kind === "video"
          ? "视频"
          : "文件"
    notes.push(`- ${label}: ${shown} (${item.mime}, ${formatBytes(item.bytes)})`)

    if (item.text !== undefined) {
      if (inlineChars + item.text.length > MAX_INLINE_TEXT_TOTAL) {
        notes.push("  （文本内容过多，已跳过内联）")
        continue
      }
      inlineChars += item.text.length
      const suffix = item.truncated ? ' truncated="true"' : ""
      blocks.push(`<file name="${shown}"${suffix}>\n${item.text}\n</file>`)
      continue
    }

    const asFile = (): PromptFile | undefined => {
      if (item.bytes > OPENCODE_ATTACHMENT_LIMIT) {
        notes.push("  （超过 OpenCode 单附件 20MB 上限；文件已完整保存到上述路径，可用文件工具读取）")
        return undefined
      }
      return { mime: item.mime, filename: item.name, path: item.path, size: item.bytes }
    }
    // `caps === undefined` means the model is not listed by /provider (a custom model,
    // or /provider was unreachable), not that it rejects the attachment. Refusing then
    // would silently discard the user's image, so only a known `false` blocks it.
    const caps = opts.modelCapabilities
    if (item.kind === "image") {
      if (caps?.image === false) notes.push("  （当前模型不支持图片输入，无法直接查看）")
      else {
        const file = asFile()
        if (file) files.push(file)
      }
    } else if (item.kind === "audio") {
      if (caps?.audio === false) notes.push("  （当前模型不支持音频输入，无法转写）")
      else {
        const file = asFile()
        if (file) files.push(file)
      }
    } else if (item.kind === "video") {
      if (caps?.video === false) {
        notes.push("  （当前模型不支持视频输入；视频已保存到上述路径，可用 ffprobe/ffmpeg 或文件工具读取）")
      } else {
        const file = asFile()
        if (file) files.push(file)
      }
    } else if (item.mime === "application/pdf") {
      if (caps?.pdf === false) notes.push("  （当前模型不支持 PDF 输入，无法直接阅读）")
      else {
        const file = asFile()
        if (file) files.push(file)
      }
    }
  }

  const header =
    text ||
    (saved.some((item) => item.kind === "audio" && item.text === undefined)
      ? "请转写这段音频并回应相关内容。"
      : saved.some((item) => item.kind === "video")
        ? "请查看并分析用户发送的视频，回应其中的内容。"
      : saved.some((item) => item.kind === "image")
        ? "请查看用户发送的图片并回应。"
        : "请阅读用户发送的文件并回应。")

  const sections = [header]
  if (notes.length > 0) sections.push(`[用户附件]\n${notes.join("\n")}`)
  if (blocks.length > 0) sections.push(blocks.join("\n\n"))
  if (opts.failed && opts.failed.length > 0) sections.push(`[附件处理失败]\n${opts.failed.join("\n")}`)
  return { text: sections.join("\n\n"), files }
}
