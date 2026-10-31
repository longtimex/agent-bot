import { readFileSync } from "node:fs"
import { relative, sep } from "node:path"
import { formatBytes, type SavedAttachment } from "./attachments.js"
import type { PromptFile } from "./opencode.js"

export const MAX_ATTACH_FILE_BYTES = 10 * 1024 * 1024
export const MAX_ATTACH_TOTAL_BYTES = 15 * 1024 * 1024
const MAX_INLINE_TEXT_TOTAL = 100_000

/** The subset of opencode /provider capabilities that gate direct file attachment. */
export interface ModelCapabilities {
  image?: boolean
  audio?: boolean
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
 * current model accepts (images / audio / PDF) attached as data.
 */
export function buildAttachmentSections(text: string, opts: AttachmentSectionsOptions): AttachmentInput {
  const { saved } = opts
  const notes: string[] = []
  const blocks: string[] = []
  const files: PromptFile[] = []
  let inlineChars = 0

  for (const item of saved) {
    const rel = relative(process.cwd(), item.path).split(sep).join("/")
    const label = item.kind === "image" ? "图片" : item.kind === "audio" ? "音频" : "文件"
    notes.push(`- ${label}: ${rel} (${item.mime}, ${formatBytes(item.bytes)})`)

    if (item.text !== undefined) {
      if (inlineChars + item.text.length > MAX_INLINE_TEXT_TOTAL) {
        notes.push("  （文本内容过多，已跳过内联）")
        continue
      }
      inlineChars += item.text.length
      const suffix = item.truncated ? ' truncated="true"' : ""
      blocks.push(`<file name="${rel}"${suffix}>\n${item.text}\n</file>`)
      continue
    }

    const asFile = (): PromptFile => ({ mime: item.mime, filename: item.name, data: readFileSync(item.path) })
    // `caps === undefined` means the model is not listed by /provider (a custom model,
    // or /provider was unreachable), not that it rejects the attachment. Refusing then
    // would silently discard the user's image, so only a known `false` blocks it.
    const caps = opts.modelCapabilities
    const tooBig = item.bytes > MAX_ATTACH_FILE_BYTES
    if (item.kind === "image") {
      if (caps?.image === false) notes.push("  （当前模型不支持图片输入，无法直接查看）")
      else if (tooBig) notes.push("  （图片过大，未直接附加）")
      else files.push(asFile())
    } else if (item.kind === "audio") {
      if (caps?.audio === false) notes.push("  （当前模型不支持音频输入，无法转写）")
      else if (tooBig) notes.push("  （音频过大，未直接附加）")
      else files.push(asFile())
    } else if (item.mime === "application/pdf") {
      if (caps?.pdf === false) notes.push("  （当前模型不支持 PDF 输入，无法直接阅读）")
      else if (tooBig) notes.push("  （PDF 过大，未直接附加）")
      else files.push(asFile())
    }
  }

  const header =
    text ||
    (saved.some((item) => item.kind === "audio")
      ? "请转写这段音频并回应相关内容。"
      : saved.some((item) => item.kind === "image")
        ? "请查看用户发送的图片并回应。"
        : "请阅读用户发送的文件并回应。")

  const sections = [header]
  if (notes.length > 0) sections.push(`[用户附件]\n${notes.join("\n")}`)
  if (blocks.length > 0) sections.push(blocks.join("\n\n"))
  if (opts.failed && opts.failed.length > 0) sections.push(`[附件处理失败]\n${opts.failed.join("\n")}`)
  return { text: sections.join("\n\n"), files }
}
