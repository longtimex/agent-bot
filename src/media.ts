import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

export type MediaKind = "image" | "voice" | "video" | "file"

export type ReplyPart =
  | { type: "text"; text: string }
  | { type: "media"; kind: MediaKind; target: string }

export interface ParseResult {
  parts: ReplyPart[]
  dropped: number
}

export interface ResolvedMedia {
  target: string
  name: string
  isUrl: boolean
  size: number
  hostPath?: string
}

const DIRECTIVE = /\[\[\s*(image|voice|video|file)\s*:\s*([^\]\r\n]*?)\s*\]\]/gi
const MAX_MEDIA_PER_REPLY = 5

const KIND_EXT: Record<MediaKind, string> = {
  image: "png",
  voice: "mp3",
  video: "mp4",
  file: "bin",
}

const KIND_LABEL: Record<MediaKind, string> = {
  image: "图片",
  voice: "语音",
  video: "视频",
  file: "文件",
}

export function mediaLabel(kind: MediaKind): string {
  return KIND_LABEL[kind]
}

export function parseReply(input: string): ParseResult {
  const parts: ReplyPart[] = []
  let dropped = 0
  let cursor = 0
  let mediaCount = 0

  const flushText = (raw: string): void => {
    const text = raw.trim()
    if (!text) return
    const previous = parts[parts.length - 1]
    if (previous?.type === "text") {
      previous.text = `${previous.text}\n${text}`
    } else {
      parts.push({ type: "text", text })
    }
  }

  for (const match of input.matchAll(DIRECTIVE)) {
    const index = match.index ?? 0
    flushText(input.slice(cursor, index))
    cursor = index + match[0].length

    const kindRaw = match[1]
    const target = match[2]?.trim()
    if (!kindRaw || !target || mediaCount >= MAX_MEDIA_PER_REPLY) {
      dropped += 1
      continue
    }

    parts.push({ type: "media", kind: kindRaw.toLowerCase() as MediaKind, target })
    mediaCount += 1
  }

  flushText(input.slice(cursor))
  return { parts, dropped }
}

export function resolveMedia(
  kind: MediaKind,
  rawTarget: string,
  outboxDir: string,
  maxBytes: number,
): ResolvedMedia {
  const target = rawTarget.trim()
  if (!target) throw new Error("媒体地址为空")

  if (/^https?:\/\//i.test(target)) {
    return { target, name: nameFromUrl(target, kind), isUrl: true, size: 0 }
  }

  const stripped = target.replace(/^(?:\.\/)?(?:data\/)?outbox[\\/]/i, "")
  const hostPath = isAbsolute(stripped) ? resolve(stripped) : resolve(outboxDir, stripped)
  const outboxReal = realpathSync(outboxDir)
  const lexicalRel = relative(outboxReal, hostPath)

  if (!lexicalRel || lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    throw new Error("本地媒体必须放在 data/outbox 目录内")
  }
  if (!existsSync(hostPath)) {
    throw new Error(`文件不存在: outbox/${lexicalRel.split(sep).join("/")}`)
  }

  // Resolve symlinks before the containment check so outbox links cannot escape
  const realHostPath = realpathSync(hostPath)
  const rel = relative(outboxReal, realHostPath)

  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("本地媒体必须放在 data/outbox 目录内")
  }

  const stat = statSync(realHostPath)
  if (!stat.isFile()) throw new Error("目标不是文件")
  if (stat.size === 0) throw new Error("文件是空的")
  if (stat.size > maxBytes) {
    throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`)
  }

  return {
    target: realHostPath,
    name: basename(realHostPath),
    isUrl: false,
    size: stat.size,
    hostPath: realHostPath,
  }
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateIPv6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (mapped) return isPrivateIPv4(mapped[1] as string)

  const compatible = /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (compatible) return isPrivateIPv4(compatible[1] as string)

  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (hexMapped) return isPrivateIPv4(embeddedIPv4(hexMapped[1] as string, hexMapped[2] as string))

  // 6to4 embeds the target IPv4 in the first two groups after 2002:
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(ip)
  if (sixToFour) {
    if (isPrivateIPv4(embeddedIPv4(sixToFour[1] as string, sixToFour[2] as string))) return true
  }

  // Teredo tunnels to an arbitrary IPv4 endpoint; treat the whole prefix as unsafe
  if (/^2001:0{1,4}:/.test(ip)) return true

  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true
  return /^fe[89ab][0-9a-f]:/.test(ip)
}

function embeddedIPv4(highHex: string, lowHex: string): string {
  const high = parseInt(highHex, 16)
  const low = parseInt(lowHex, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase()
  const version = isIP(value)
  if (version === 4) return isPrivateIPv4(value)
  if (version === 6) return isPrivateIPv6(value)
  return false
}

export async function assertUrlAllowed(target: string, allowPrivate: boolean): Promise<URL> {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error("媒体地址无效")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("媒体链接仅支持 http/https")
  }
  if (url.username || url.password) {
    throw new Error("媒体链接不能包含认证信息")
  }
  if (allowPrivate) return url

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("不允许访问本机或内网地址的媒体链接")
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("不允许访问本机或内网地址的媒体链接")
    return url
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error(`无法解析媒体地址: ${hostname}`)
  }
  if (addresses.length === 0) throw new Error(`无法解析媒体地址: ${hostname}`)
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("不允许访问本机或内网地址的媒体链接")
  }
  return url
}

function nameFromUrl(target: string, kind: MediaKind): string {
  try {
    const pathname = new URL(target).pathname
    const name = decodeURIComponent(pathname.split("/").pop() ?? "")
    if (name) return name
  } catch {
    // fall through to a generated name
  }
  return `remote.${KIND_EXT[kind]}`
}

export function pruneOutbox(outboxDir: string, maxAgeMs = 3 * 24 * 60 * 60 * 1000): number {
  if (!existsSync(outboxDir)) return 0
  let pruned = 0
  const now = Date.now()
  const protectedFiles = new Set(["sample.png", "sample.jpg", "sample.mp4", "test.txt", ".gitkeep"])

  try {
    const entries = readdirSync(outboxDir)
    for (const entry of entries) {
      if (protectedFiles.has(entry)) continue
      const fullPath = join(outboxDir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath)
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
