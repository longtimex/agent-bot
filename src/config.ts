import { existsSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import type { LogLevel } from "./logger.js"

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface BotConfig {
  telegram: {
    token?: string
    allowUsers: Set<string>
    allowAll: boolean
  }
  opencode: {
    url: string
    username: string
    password?: string
    agent?: string
    model?: ModelRef
  }
  taskTimeoutMs: number
  taskMaxTimeoutMs: number
  maxReplyLength: number
  maxMediaBytes: number
  mediaAllowPrivateUrls: boolean
  maxInputBytes: number
  reminderTimezone: string
  dataDir: string
  outboxDir: string
  inboxDir: string
  logLevel: LogLevel
}

function loadDotEnv(): void {
  if (!existsSync(".env")) return
  try {
    process.loadEnvFile(".env")
  } catch {
    // .env is optional; ignore parse errors and fall back to the environment
  }
}

function csv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function int(value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function pick(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function validateTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
  } catch {
    throw new Error(`拒绝启动：REMINDER_TIMEZONE 无效（${value}）。请使用 IANA 时区名，例如 Asia/Shanghai。`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  loadDotEnv()

  const tgToken = pick(env.TELEGRAM_BOT_TOKEN)
  const tgUsers = csv(env.TELEGRAM_ALLOW_USERS)
  const tgAllowAll = bool(env.TELEGRAM_ALLOW_ALL_USERS, false)

  if (!tgToken) {
    throw new Error("拒绝启动：未配置 TELEGRAM_BOT_TOKEN。请在 .env 中设置。")
  }

  if (tgUsers.size === 0 && !tgAllowAll) {
    throw new Error(
      "拒绝启动：TELEGRAM_ALLOW_USERS 为空。请在 .env 中填写允许使用的 Telegram 用户 ID（逗号分隔），" +
        "或显式设置 TELEGRAM_ALLOW_ALL_USERS=1 放行所有用户。",
    )
  }

  const providerID = pick(env.OPENCODE_MODEL_PROVIDER)
  const modelID = pick(env.OPENCODE_MODEL_ID)
  const dataDir = resolve(pick(env.DATA_DIR) ?? "./data")
  const taskTimeoutMs = int(pick(env.TASK_TIMEOUT_MS) ?? env.OPENCODE_TIMEOUT_MS, 600_000, 10_000)
  const taskMaxTimeoutMs = int(env.TASK_MAX_TIMEOUT_MS, taskTimeoutMs, taskTimeoutMs)

  return {
    telegram: {
      token: tgToken,
      allowUsers: tgUsers,
      allowAll: tgAllowAll,
    },
    opencode: {
      url: (pick(env.OPENCODE_URL) ?? "http://127.0.0.1:4096").replace(/\/+$/, ""),
      username: pick(env.OPENCODE_SERVER_USERNAME) ?? "opencode",
      password: pick(env.OPENCODE_SERVER_PASSWORD),
      agent: pick(env.OPENCODE_AGENT) ?? "assistant",
      model: providerID && modelID ? { providerID, modelID } : undefined,
    },
    taskTimeoutMs,
    taskMaxTimeoutMs,
    reminderTimezone: validateTimezone(pick(env.REMINDER_TIMEZONE) ?? "Asia/Shanghai"),
    maxReplyLength: int(env.MAX_REPLY_LENGTH, 1500, 100, 4000),
    maxMediaBytes: int(env.MAX_MEDIA_MB, 20, 1, 100) * 1024 * 1024,
    mediaAllowPrivateUrls: bool(env.MEDIA_ALLOW_PRIVATE_URLS, false),
    // Telegram Bot API only serves files up to 20MB via getFile
    maxInputBytes: int(env.MAX_INPUT_MB, 20, 1, 20) * 1024 * 1024,
    dataDir,
    outboxDir: resolve(dataDir, "outbox"),
    inboxDir: resolve(dataDir, "inbox"),
    logLevel: (pick(env.LOG_LEVEL) as LogLevel | undefined) ?? "info",
  }
}
