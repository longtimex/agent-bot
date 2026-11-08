import { zonedParts } from "./reminders.js"
import { BOT_MENU_COMMANDS } from "./help.js"

/** Text of the one-shot "Bot 已上线" ping sent to the owner chat after polling connects. */
export function startupNoticeText(opts: {
  username?: string
  version: string
  opencodeOk: boolean
  timezone: string
  channel?: "telegram" | "feishu"
}): string {
  const feishu = opts.channel === "feishu"
  const who = opts.username ? ` @${opts.username}` : ""
  const opencode = opts.opencodeOk
    ? "OpenCode 服务：✅ 可达"
    : feishu
      ? "OpenCode 服务：❌ 不可达（运行 npm run serve，或在这里发送 /service opencode start）"
      : "OpenCode 服务：❌ 不可达（运行 npm run serve，或在 Telegram 里发送 /service opencode start）"
  return [
    `✅ ${feishu ? "飞书 Bot" : "Bot"} 已上线${who} · v${opts.version}`,
    opencode,
    `时区 ${opts.timezone} · 发送 /menu 打开功能菜单`,
  ].join("\n")
}

/** Buttons for /timezone; anything else can still be typed as /timezone <IANA 名称>. */
export const TIMEZONE_PRESETS = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
]

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

export function formatDateTime(timestamp: number, timeZone: string): string {
  const parts = zonedParts(timestamp, timeZone)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}


export function describeRemainingLabel(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} 天`
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时`
  return `${minutes} 分钟`
}

export function isMessageNotModified(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const description = (err as { description?: string } | undefined)?.description ?? ""
  return /message is not modified/i.test(`${message} ${description}`)
}



/**
 * `/cc provider add 名称 键=值…` → the same validated draft the HTTP form sends.
 * Returns an error string for the chat instead of throwing, so a typo stays advice.
 */

export function extensionFromMime(mime: string | undefined): string {
  switch (mime) {
    case "application/pdf": return ".pdf"
    case "image/png": return ".png"
    case "image/jpeg": return ".jpg"
    case "image/gif": return ".gif"
    case "image/webp": return ".webp"
    case "audio/mpeg": return ".mp3"
    case "audio/ogg": return ".ogg"
    case "audio/wav": return ".wav"
    case "audio/mp4": return ".m4a"
    case "application/zip": return ".zip"
    default: return ""
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const USER_ID_RE = /^\d{1,20}$/

/** Numeric Telegram IDs only, deduped and ascending, as stored in TELEGRAM_ALLOW_USERS. */
export function sortUserIds(ids: Iterable<string>): string[] {
  const unique = new Set<string>()
  for (const raw of ids) {
    const id = raw.trim()
    if (USER_ID_RE.test(id)) unique.add(id)
  }
  return [...unique].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

export function parseAllowUsers(value: string): string[] {
  return sortUserIds(value.split(","))
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}

/** 与输入编辑距离 ≤1 的菜单命令;短词与完全匹配返回 undefined,避免误提示。 */
export function nearestMenuCommand(word: string): string | undefined {
  const name = word.replace(/^\/+/, "").toLowerCase()
  if (name.length < 3) return undefined
  let best: { name: string; dist: number } | undefined
  for (const item of BOT_MENU_COMMANDS) {
    const dist = levenshtein(name, item.command)
    if (!best || dist < best.dist) best = { name: item.command, dist }
  }
  return best && best.name !== name && best.dist <= 1 ? best.name : undefined
}

