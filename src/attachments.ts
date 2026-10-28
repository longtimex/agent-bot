import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type AttachmentKind = "image" | "audio" | "document"

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
  mkdirSync(dir, { recursive: true })
  const finalName = `${chatId}-${Date.now()}-${sanitizeFilename(name, "file.bin")}`
  const path = join(dir, finalName)
  writeFileSync(path, data)
  return { path, name: finalName }
}

export function readTextAttachment(path: string, limit = INLINE_LIMIT): { text: string; truncated: boolean } {
  const raw = readFileSync(path, "utf8")
  if (raw.length <= limit) return { text: raw, truncated: false }
  return { text: raw.slice(0, limit), truncated: true }
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
