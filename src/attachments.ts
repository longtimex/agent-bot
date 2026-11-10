import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { clip } from "./messages.js"

export type AttachmentKind = "image" | "audio" | "video" | "document"

/**
 * One classification used by the API, Telegram and Feishu paths. A provider may
 * answer `application/octet-stream` (or nothing) for an ordinary MP4/voice note,
 * so a known extension is the fallback rather than a reason to discard the kind.
 */
export function attachmentKind(mime: string, name = ""): AttachmentKind {
  const value = mime.trim().toLowerCase()
  if (value.startsWith("image/")) return "image"
  if (value.startsWith("audio/")) return "audio"
  if (value.startsWith("video/")) return "video"
  const extension = name.trim().toLowerCase().lastIndexOf(".")
  const suffix = extension >= 0 ? name.trim().toLowerCase().slice(extension) : ""
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"].includes(suffix)) return "image"
  if ([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".amr"].includes(suffix)) return "audio"
  if ([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".3gp", ".avi"].includes(suffix)) return "video"
  return "document"
}

export interface AttachmentDescriptor {
  fileId: string
  kind: AttachmentKind
  name: string
  mime: string
  size?: number
}

export interface SavedAttachment extends AttachmentDescriptor {
  path: string
  bytes: number
  text?: string
  truncated?: boolean
}

const INLINE_LIMIT = 60_000
const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".yml", ".yaml",
  ".toml", ".ini", ".cfg", ".conf", ".xml", ".html", ".htm", ".css", ".scss", ".js", ".mjs",
  ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp",
  ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql", ".graphql", ".proto",
  ".diff", ".patch", ".tex", ".r", ".lua", ".pl", ".swift", ".dart", ".vue", ".svelte",
])

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|sql|x-sh|x-python|x-httpd-php|toml|x-toml))/

export function isTextAttachment(mime: string, name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf(".")
  if (dot >= 0 && TEXT_EXTENSIONS.has(lower.slice(dot))) return true
  if (lower === "dockerfile" || lower === "makefile" || lower.endsWith(".dockerfile")) return true
  return TEXT_MIME.test(mime.toLowerCase())
}

export function sanitizeFilename(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const cleaned = base
    .replace(/[^\w.\-()\u4e00-\u9fa5 ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80)
  return cleaned && !/^[._-]+$/.test(cleaned) ? cleaned : fallback
}

export function saveAttachment(dir: string, chatId: number, name: string, data: Buffer): { path: string; name: string } {
  const path = reserveAttachmentPath(dir, chatId, name)
  writeFileSync(path, data, { mode: 0o600 })
  return { path, name: path.split(/[\\/]/).pop()! }
}

/** A unique, private inbox path; the caller writes the bytes. */
function reserveAttachmentPath(dir: string, chatId: number, name: string): string {
  // Uploads routinely carry config files with API keys: keep them private to the
  // service account instead of relying on the host umask.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdirSync's mode only applies when it creates the directory. A startup-created
  // inbox (or one from an older release) can still be 0775, and the upload must not
  // inherit that exposure just because the directory already existed.
  chmodSync(dir, 0o700)
  const base = `${chatId}-${Date.now()}-${sanitizeFilename(name, "file.bin")}`
  // Two uploads of the same file in the same millisecond (an album, a retried update)
  // would otherwise share one name and silently overwrite each other
  let finalName = base
  const dot = base.lastIndexOf(".")
  for (let n = 1; existsSync(join(dir, finalName)); n += 1) {
    finalName = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`
  }
  const path = join(dir, finalName)
  return path
}

/**
 * Streams an upload straight to the inbox. Memory use stays at one chunk, so a
 * phone video is limited by disk space rather than by the Node heap. The partial
 * file is removed when the client disconnects or the stream fails.
 */
export async function saveAttachmentStream(
  dir: string,
  chatId: number,
  name: string,
  source: AsyncIterable<Uint8Array>,
): Promise<{ path: string; name: string; bytes: number }> {
  const path = reserveAttachmentPath(dir, chatId, name)
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      callback(null, chunk)
    },
  })
  try {
    await pipeline(source, meter, createWriteStream(path, { mode: 0o600 }))
    if (bytes === 0) {
      unlinkSync(path)
      throw new Error("附件为空")
    }
  } catch (err) {
    try {
      unlinkSync(path)
    } catch {
      // no partial file was created
    }
    throw err
  }
  return { path, name: path.split(/[\\/]/).pop()!, bytes }
}

export function readTextAttachment(path: string, limit = INLINE_LIMIT): { text: string; truncated: boolean } {
  const cap = Math.max(0, Math.floor(limit))
  const size = statSync(path).size
  // Read only the window that is shown: a 20 MB log would otherwise be decoded in
  // full, and the UTF-8 decode plus its copies block every other chat
  const want = Math.min(size, cap * 4 + 4)
  const buffer = Buffer.allocUnsafe(want)
  const fd = openSync(path, "r")
  let bytesRead = 0
  try {
    while (bytesRead < want) {
      const step = readSync(fd, buffer, bytesRead, want - bytesRead, bytesRead)
      if (step === 0) break
      bytesRead += step
    }
  } finally {
    closeSync(fd)
  }
  // A cut in the middle of a multi-byte character decodes to one trailing placeholder
  const decoded = buffer.toString("utf8", 0, bytesRead)
  const text = bytesRead < size ? decoded.replace(/\ufffd$/, "") : decoded
  const shown = clip(text, cap) ?? ""
  return { text: shown, truncated: bytesRead < size || shown.length < text.length }
}

export function pruneInbox(dir: string, maxAgeMs = INBOX_MAX_AGE_MS): number {
  if (!existsSync(dir)) return 0
  let pruned = 0
  const now = Date.now()
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === ".gitkeep") continue
      const path = join(dir, entry)
      try {
        const stat = statSync(path)
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(path)
          pruned++
        }
      } catch {
        // ignore entry errors
      }
    }
  } catch {
    // ignore readdir errors
  }
  return pruned
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
