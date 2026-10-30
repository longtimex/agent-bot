import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs"
import { lookup } from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { redactSecrets } from "./ccswitch.js"
import { sanitizeFilename } from "./attachments.js"

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

// The target class is bounded on purpose: an unbounded lazy `[^\]\r\n]*?` scans to
// the end of the reply for every `[[ image:` prefix that never closes, so a long
// model reply full of stray prefixes would block the event loop for seconds.
const DIRECTIVE = /\[\[\s*(image|voice|video|file)\s*:\s*([^\]\r\n]{0,1024}?)\s*\]\]/gi
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

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/
const INLINE_CODE = /`[^`\n]+`/g

/** Byte ranges of the reply that are code: a directive there is an example, not an instruction. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let offset = 0
  let fenceStart = -1
  let fenceMark = ""
  for (const line of text.split("\n")) {
    const start = offset
    const end = offset + line.length + 1
    if (fenceStart < 0) {
      const mark = FENCE_OPEN.exec(line)?.[1]
      if (mark) {
        fenceStart = start
        fenceMark = mark
      }
    } else if (line.trimStart().startsWith(fenceMark)) {
      ranges.push([fenceStart, end])
      fenceStart = -1
    }
    offset = end
  }
  // An unterminated fence swallows the rest of the reply, as Telegram renders it
  if (fenceStart >= 0) ranges.push([fenceStart, text.length])

  for (const match of text.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0
    if (ranges.some(([from, to]) => start >= from && start < to)) continue
    ranges.push([start, start + match[0].length])
  }
  return ranges
}

function insideRanges(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([from, to]) => index >= from && index < to)
}

export function parseReply(input: string): ParseResult {
  const parts: ReplyPart[] = []
  let dropped = 0
  let cursor = 0
  let mediaCount = 0
  let code: Array<[number, number]> | undefined

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
    // Scanned lazily: most replies contain no directive at all
    code ??= codeRanges(input)
    if (insideRanges(code, index)) continue
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

  const outboxRoot = resolve(outboxDir)
  const stripped = target.replace(/^(?:\.\/)?(?:data\/)?outbox[\\/]/i, "")
  const hostPath = isAbsolute(stripped) ? resolve(stripped) : resolve(outboxRoot, stripped)
  const lexicalRel = relative(outboxRoot, hostPath)

  if (!lexicalRel || lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    throw new Error("本地媒体必须放在 data/outbox 目录内")
  }
  if (!existsSync(hostPath)) {
    throw new Error(`文件不存在: outbox/${lexicalRel.split(sep).join("/")}`)
  }

  // Resolve symlinks before the containment check so outbox links cannot escape.
  // Compare against the real outbox root, otherwise a symlinked outbox directory
  // itself (data/outbox -> /mnt/media) would reject every legitimate file.
  const outboxReal = realpathSync(outboxRoot)
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
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

/** Expand an IPv6 address (optionally ending in a dotted IPv4) into 8 16-bit groups. */
function parseIPv6Groups(raw: string): number[] | undefined {
  let ip = raw
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (dotted) {
    const v4 = dotted[1]!.split(".").map(Number)
    if (v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    ip = `${ip.slice(0, dotted.index)}${hi}:${lo}`
  }
  const halves = ip.split("::")
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - left.length - right.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right]
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN))
  return values.every((value) => Number.isInteger(value)) ? values : undefined
}

function embeddedIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function isPrivateIPv6(ip: string): boolean {
  const groups = parseIPv6Groups(ip)
  if (!groups) return false
  const zero = (from: number, to: number): boolean => groups.slice(from, to).every((value) => value === 0)

  // :: (unspecified) and ::1 (loopback), including fully expanded spellings
  if (zero(0, 8)) return true
  if (zero(0, 7) && groups[7] === 1) return true

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses
  if (zero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isPrivateIPv4(embeddedIPv4(groups[6]!, groups[7]!))
  }

  // NAT64 (64:ff9b::/96) can map straight onto internal IPv4 hosts
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) {
    return isPrivateIPv4(embeddedIPv4(groups[6]!, groups[7]!))
  }

  // 6to4 embeds the target IPv4 in the first two groups after 2002:
  if (groups[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(groups[1]!, groups[2]!))

  // Teredo tunnels to an arbitrary IPv4 endpoint; treat the whole prefix as unsafe
  if (groups[0] === 0x2001 && groups[1] === 0) return true

  // Unique local (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8)
  if ((groups[0]! & 0xfe00) === 0xfc00) return true
  if ((groups[0]! & 0xffc0) === 0xfe80) return true
  if ((groups[0]! & 0xff00) === 0xff00) return true
  return false
}

export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase()
  const version = isIP(value)
  if (version === 4) return isPrivateIPv4(value)
  if (version === 6) return isPrivateIPv6(value)
  return false
}

export interface GuardedUrl {
  url: URL
  /**
   * Validated addresses for the hostname. The download must reuse these instead of
   * re-resolving, otherwise DNS could rebinding to an internal host after the check.
   */
  pins: string[]
}

/**
 * How a remote media URL may be quoted back to the chat and the log: the query
 * of an agent-supplied link usually carries the signature or token that grants
 * access to it, so only host and path are safe to repeat.
 */
export function safeMediaTarget(target: string): string {
  try {
    const url = new URL(target)
    return redactSecrets(`${url.protocol}//${url.host}${url.pathname}`)
  } catch {
    return "[无效链接]"
  }
}

export async function assertUrlAllowed(target: string, allowPrivate: boolean): Promise<GuardedUrl> {
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
  // Without the private-address guard there is nothing to pin to
  if (allowPrivate) return { url, pins: [] }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("不允许访问本机或内网地址的媒体链接")
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("不允许访问本机或内网地址的媒体链接")
    return { url, pins: [] }
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
  return { url, pins: addresses.map((entry) => entry.address) }
}

/**
 * A connector lookup that only ever resolves `host` to the addresses validated by
 * assertUrlAllowed. Any other hostname fails, so a redirect cannot rebind the
 * download to an internal address after the check.
 */
export function pinnedLookup(host: string, pins: readonly string[]): LookupFunction {
  const familyFor = (address: string): 4 | 6 => (isIP(address) === 6 ? 6 : 4)
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== host.toLowerCase()) {
      callback(new Error(`媒体下载只允许连接已校验的主机 ${host}`), [], 0)
      return
    }
    const requested = options?.family
    const match = pins.find((address) => !requested || requested === 0 || familyFor(address) === requested)
    if (!match) {
      callback(new Error(`媒体下载没有可用的已校验地址（${host}）`), [], 0)
      return
    }
    callback(null, match, familyFor(match))
  }
}

function nameFromUrl(target: string, kind: MediaKind): string {
  const fallback = `remote.${KIND_EXT[kind]}`
  try {
    const pathname = new URL(target).pathname
    const name = decodeURIComponent(pathname.split("/").pop() ?? "")
    // The remote server chooses this name and it reaches both the log and the
    // Telegram attachment name, so it gets the same filter as an upload
    if (name) return sanitizeFilename(name, fallback)
  } catch {
    // fall through to a generated name
  }
  return fallback
}

export function pruneOutbox(outboxDir: string, maxAgeMs = 3 * 24 * 60 * 60 * 1000): number {
  if (!existsSync(outboxDir)) return 0
  const now = Date.now()
  const protectedFiles = new Set(["sample.png", "sample.jpg", "sample.mp4", "test.txt", ".gitkeep"])

  // resolveMedia allows nested paths, so walk subdirectories too
  const walk = (dir: string, top: boolean): number => {
    let pruned = 0
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (top && protectedFiles.has(entry.name)) continue
      // Never follow links: a linked directory could point outside the outbox
      if (entry.isSymbolicLink()) continue
      const fullPath = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          pruned += walk(fullPath, false)
        } else if (entry.isFile() && now - statSync(fullPath).mtimeMs > maxAgeMs) {
          unlinkSync(fullPath)
          pruned++
        }
      } catch {
        // ignore entry errors
      }
    }
    return pruned
  }

  return walk(outboxDir, true)
}
