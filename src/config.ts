import { existsSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { CC_SWITCH_APPS } from "./ccswitch.js"
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
  ccswitch: {
    bin?: string
    app: string
  }
  agentCli: {
    /** Optional data/agents.json with custom profiles / built-in overrides. */
    configPath: string
  }
  /** HTTP API used by the companion Android app; Telegram keeps working regardless. */
  api: {
    enabled: boolean
    port: number
    bind: string
    /** When empty, a token is generated on first start and stored in data/api-token.json. */
    token?: string
  }
  dataDir: string
  outboxDir: string
  inboxDir: string
  logLevel: LogLevel
  /** "Bot 已上线" ping to the owner chat after a successful start; false turns it off. */
  startupNotice?: boolean
  /** Scheduled daily usage summary pushed to the owner chat. */
  usageReport?: {
    enabled: boolean
    /** Push time "HH:MM" (24 h), resolved in REMINDER_TIMEZONE. */
    time: string
  }
}

/** A startup configuration problem: the message is the guidance, so no stack is printed. */
export class StartupConfigError extends Error {
  name = "StartupConfigError"
}

/** Telegram connection is missing, which the first-run wizard can resolve. */
export class ConfigError extends StartupConfigError {
  name = "ConfigError"
}

/** Same loader as the bot, so CLI tools resolve DATA_DIR and friends from `.env`. */
export function loadDotEnvFile(): void {
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
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function pick(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Hand-edited `.env` files often spell LOG_LEVEL in caps; /env set only accepts lowercase. */
function logLevel(value: string | undefined): LogLevel {
  const level = value?.trim().toLowerCase()
  return level === "debug" || level === "info" || level === "warn" || level === "error" ? level : "info"
}

export function validateTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
  } catch {
    throw new StartupConfigError(`拒绝启动：REMINDER_TIMEZONE 无效（${value}）。请使用 IANA 时区名，例如 Asia/Shanghai。`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  loadDotEnvFile()

  const tgToken = pick(env.TELEGRAM_BOT_TOKEN)
  const tgUsers = csv(env.TELEGRAM_ALLOW_USERS)
  const tgAllowAll = bool(env.TELEGRAM_ALLOW_ALL_USERS, false)

  if (!tgToken) {
    throw new ConfigError("拒绝启动：未配置 TELEGRAM_BOT_TOKEN。请在 .env 中设置。")
  }

  if (tgUsers.size === 0 && !tgAllowAll) {
    throw new ConfigError(
      "拒绝启动：TELEGRAM_ALLOW_USERS 为空。请在 .env 中填写允许使用的 Telegram 用户 ID（逗号分隔），" +
        "或显式设置 TELEGRAM_ALLOW_ALL_USERS=1 放行所有用户。",
    )
  }

  const providerID = pick(env.OPENCODE_MODEL_PROVIDER)
  const modelID = pick(env.OPENCODE_MODEL_ID)
  const dataDir = resolve(pick(env.DATA_DIR) ?? "./data")
  const taskTimeoutMs = int(pick(env.TASK_TIMEOUT_MS) ?? env.OPENCODE_TIMEOUT_MS, 600_000, 10_000)
  const taskMaxTimeoutMs = int(env.TASK_MAX_TIMEOUT_MS, taskTimeoutMs, taskTimeoutMs)
  const ccswitchApp = pick(env.CC_SWITCH_APP) ?? "opencode"
  if (!CC_SWITCH_APPS.includes(ccswitchApp as (typeof CC_SWITCH_APPS)[number])) {
    throw new StartupConfigError(
      `拒绝启动：CC_SWITCH_APP 无效（${ccswitchApp}）。可选值：${CC_SWITCH_APPS.join("、")}。`,
    )
  }
  const agentCliConfig = pick(env.AGENT_CLI_CONFIG)

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
    ccswitch: {
      bin: pick(env.CC_SWITCH_BIN),
      app: ccswitchApp,
    },
    agentCli: {
      configPath: agentCliConfig ? resolve(agentCliConfig) : resolve(dataDir, "agents.json"),
    },
    api: {
      enabled: bool(env.API_ENABLED, true),
      port: int(env.API_PORT, 3080, 1, 65535),
      bind: pick(env.API_BIND) ?? "127.0.0.1",
      token: pick(env.API_TOKEN),
    },
    maxReplyLength: int(env.MAX_REPLY_LENGTH, 1500, 100, 4000),
    maxMediaBytes: int(env.MAX_MEDIA_MB, 20, 1, 100) * 1024 * 1024,
    mediaAllowPrivateUrls: bool(env.MEDIA_ALLOW_PRIVATE_URLS, false),
    // Telegram Bot API only serves files up to 20MB via getFile
    maxInputBytes: int(env.MAX_INPUT_MB, 20, 1, 20) * 1024 * 1024,
    dataDir,
    outboxDir: resolve(dataDir, "outbox"),
    inboxDir: resolve(dataDir, "inbox"),
    logLevel: logLevel(env.LOG_LEVEL),
    startupNotice: bool(env.STARTUP_NOTICE, true),
    usageReport: {
      enabled: bool(env.USAGE_DAILY_REPORT, false),
      time: validateReportTime(pick(env.USAGE_DAILY_REPORT_TIME) ?? "21:00"),
    },
  }
}

/** "HH:MM" 24-hour clock; an invalid value must fail at startup, not silently never fire. */
function validateReportTime(value: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new StartupConfigError(`拒绝启动：USAGE_DAILY_REPORT_TIME 无效（${value}）。请使用 24 小时制 HH:MM，例如 21:00。`)
  }
  return value
}
