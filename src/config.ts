import { existsSync, statSync } from "node:fs"
import { isIP } from "node:net"
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
  /** Optional Feishu (Lark) control channel. Telegram and Feishu may run together. */
  feishu?: {
    appId: string
    appSecret: string
    allowOpenIds: Set<string>
    allowAll: boolean
    /** Interactive-card callbacks use a public HTTP endpoint; message events stay on the long connection. */
    callback?: FeishuCallbackConfig
  }
  opencode: {
    url: string
    username: string
    password?: string
    agent?: string
  }
  taskTimeoutMs: number
  /**
   * Overall wall-clock ceiling for one task. `0` disables the ceiling and leaves
   * the inactivity watchdog as the only bound, which is the right default for
   * agents that legitimately stream progress for many hours.
   */
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
  /** magpie console; the CLI is optional and the gateway URL is informational. */
  magpie: {
    bin?: string
    gatewayUrl: string
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
    /** The address the App should dial; needed when the bot sits behind a proxy or a NAT. */
    publicUrl?: string
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
  /** Optional OpenAI-compatible speech-to-text for voice notes; present only when STT_BASE_URL is set. */
  stt?: {
    baseUrl: string
    apiKey?: string
    model: string
    language?: string
  }
  /** Message-level encryption for the App API (AES-256-GCM under a pairing key). */
  encryption: {
    enabled: boolean
  }
}

export interface FeishuCallbackConfig {
  enabled: boolean
  port: number
  bind: string
  path: string
  verificationToken?: string
  encryptKey?: string
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
  if (statSync(".env").isDirectory()) {
    // `docker compose up` with a missing host file silently mounts an empty *directory* at
    // ./.env, and skipping it would only surface later as "尚未配置可用的控制端".
    throw new ConfigError(
      "拒绝启动：.env 是一个目录，不是文件。多半是宿主机上没有 .env，Docker 自动建了同名目录；" +
        "先执行 cp .env.example .env 并填好配置，再重新 docker compose up。",
    )
  }
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

/** A bind that only accepts connections from the same machine cannot be dialled by the App. */
export function isLoopbackApiBind(bind: string): boolean {
  const host = bind.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1") return true
  return isIP(host) === 4 && host.startsWith("127.")
}

/** Wildcard and loopback binds do not tell a phone which address to dial for a pairing QR. */
export function isConcreteApiBind(bind: string): boolean {
  const host = bind.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!host || host === "0.0.0.0" || host === "::") return false
  return !isLoopbackApiBind(host)
}

/**
 * `API_BIND=3080` is the other half of the address/port pair, not a host. Node will
 * parse the bare number as an IPv4 shorthand (`0.0.12.8`) and fail only inside
 * listen(), after startup has already reported the bot as running.
 */
export function isPortLikeApiBind(bind: string): boolean {
  const value = bind.trim()
  if (!/^\d{1,5}$/.test(value)) return false
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export interface ControlClientEvidence {
  telegram: boolean
  feishu: boolean
  android: boolean
}

/**
 * Whether the environment contains any control-client configuration. This is intentionally
 * broader than validation: a half-filled Feishu block must surface its own error instead of
 * being mistaken for a first run and overwritten by the wizard.
 */
export function controlClientEvidence(env: NodeJS.ProcessEnv = process.env): ControlClientEvidence {
  const apiBind = pick(env.API_BIND) ?? "127.0.0.1"
  const apiPublicUrl = pick(env.API_PUBLIC_URL)
  return {
    telegram: Boolean(pick(env.TELEGRAM_BOT_TOKEN)),
    feishu: Boolean(pick(env.FEISHU_APP_ID) || pick(env.FEISHU_APP_SECRET)),
    // A wildcard bind is not a phone-reachable address: without API_PUBLIC_URL the
    // operator can only guess the host and the /api pairing QR cannot be generated.
    android: bool(env.API_ENABLED, true) && Boolean(apiPublicUrl || isConcreteApiBind(apiBind)),
  }
}

export function hasControlClientEvidence(env: NodeJS.ProcessEnv = process.env): boolean {
  const evidence = controlClientEvidence(env)
  return evidence.telegram || evidence.feishu || evidence.android
}

/**
 * The long-connection client only accepts `cli_` plus 16 hex characters and
 * otherwise declines to connect without surfacing an error. Validate the same
 * shape here so a typo cannot leave a Feishu-only process looking healthy but
 * silently deaf.
 */
export const FEISHU_APP_ID_RE = /^cli_[0-9a-f]{16}$/i
export const FEISHU_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,64}$/

function feishuIds(value: Set<string>): string | undefined {
  const invalid = [...value].filter((id) => !FEISHU_OPEN_ID_RE.test(id))
  return invalid.length > 0 ? invalid.join("、") : undefined
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

/**
 * The 24-hour default is a runaway guard, not a task budget. The sample `.env`
 * used to ship 600000, and deployments copied it verbatim, so merely changing
 * the code default would leave every existing chat killed at ten minutes. Only
 * that exact legacy sample value is migrated; a deliberately chosen hard cap
 * (including 10 minutes) is still honoured.
 */
const LEGACY_HARD_TIMEOUT_MS = 600_000
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000

function taskMaxTimeout(value: string | undefined, idleTimeoutMs: number): number {
  const raw = value?.trim()
  if (!raw) return DEFAULT_HARD_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_HARD_TIMEOUT_MS
  if (parsed === LEGACY_HARD_TIMEOUT_MS && idleTimeoutMs === LEGACY_HARD_TIMEOUT_MS) {
    return DEFAULT_HARD_TIMEOUT_MS
  }
  if (parsed <= 0) return 0
  return Math.max(idleTimeoutMs, Math.floor(parsed))
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
  const feishuAppId = pick(env.FEISHU_APP_ID)
  const feishuAppSecret = pick(env.FEISHU_APP_SECRET)
  const feishuUsers = csv(env.FEISHU_ALLOW_OPEN_IDS)
  const feishuAllowAll = bool(env.FEISHU_ALLOW_ALL_USERS, false)
  const feishuCallbackEnabled = bool(env.FEISHU_CALLBACK_ENABLED, false)
  const feishuCallbackPort = int(env.FEISHU_CALLBACK_PORT, 3081, 1, 65535)
  const feishuCallbackBind = pick(env.FEISHU_CALLBACK_BIND) ?? "127.0.0.1"
  const feishuCallbackPath = pick(env.FEISHU_CALLBACK_PATH) ?? "/feishu/card"
  const feishuCallbackVerificationToken = pick(env.FEISHU_CALLBACK_VERIFICATION_TOKEN)
  const feishuCallbackEncryptKey = pick(env.FEISHU_CALLBACK_ENCRYPT_KEY)
  const apiEnabled = bool(env.API_ENABLED, true)
  const apiPort = int(env.API_PORT, 3080, 1, 65535)
  const apiBind = pick(env.API_BIND) ?? "127.0.0.1"
  if (isPortLikeApiBind(apiBind)) {
    throw new StartupConfigError(
      `拒绝启动：API_BIND=${apiBind} 是端口号，不是监听地址。监听地址请填 IP 或主机名（例如 127.0.0.1、0.0.0.0），端口请填 API_PORT。`,
    )
  }
  const apiPublicUrl = parseApiPublicUrl(pick(env.API_PUBLIC_URL))
  const apiToken = pick(env.API_TOKEN)
  // The API is on by default, but the sample .env binds it to loopback. Treating that as a
  // configured control client would let an untouched .env start a bot no phone can reach.
  const androidConfigured = apiEnabled && Boolean(apiPublicUrl || isConcreteApiBind(apiBind))

  if (Boolean(feishuAppId) !== Boolean(feishuAppSecret)) {
    throw new StartupConfigError("拒绝启动：FEISHU_APP_ID 与 FEISHU_APP_SECRET 必须同时配置。")
  }
  if (!tgToken && !feishuAppId && !androidConfigured) {
    throw new ConfigError(
      "拒绝启动：尚未配置可用的控制端。请配置 Telegram（TELEGRAM_BOT_TOKEN）、飞书" +
        "（FEISHU_APP_ID/FEISHU_APP_SECRET）或安卓 App（API_PUBLIC_URL，或把 API_BIND 改为手机可达的具体地址；" +
        "不能只监听 0.0.0.0 或 ::）。" +
        "可运行 npm run setup 进入向导。",
    )
  }
  if (tgToken && tgUsers.size === 0 && !tgAllowAll) {
    throw new ConfigError(
      "拒绝启动：TELEGRAM_ALLOW_USERS 为空。请在 .env 中填写允许使用的 Telegram 用户 ID（逗号分隔），" +
        "或显式设置 TELEGRAM_ALLOW_ALL_USERS=1 放行所有用户。",
    )
  }
  if (feishuAppId && !FEISHU_APP_ID_RE.test(feishuAppId)) {
    throw new StartupConfigError(
      `拒绝启动：FEISHU_APP_ID 格式无效（${feishuAppId}）。应形如 cli_0123456789abcdef（cli_ 后 16 位十六进制字符）。`,
    )
  }
  const invalidFeishuIds = feishuIds(feishuUsers)
  if (invalidFeishuIds) {
    throw new StartupConfigError(
      `拒绝启动：FEISHU_ALLOW_OPEN_IDS 含无效 open_id（${invalidFeishuIds}）。每项应形如 ou_xxx。`,
    )
  }
  if (feishuAppId && feishuUsers.size === 0 && !feishuAllowAll) {
    throw new StartupConfigError(
      "拒绝启动：FEISHU_ALLOW_OPEN_IDS 为空。请填写允许使用的飞书 open_id（逗号分隔），" +
        "或显式设置 FEISHU_ALLOW_ALL_USERS=1 放行所有用户。",
    )
  }
  if (feishuCallbackEnabled && !feishuAppId) {
    throw new StartupConfigError("拒绝启动：FEISHU_CALLBACK_ENABLED=1 需要同时配置 FEISHU_APP_ID/FEISHU_APP_SECRET。")
  }
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(feishuCallbackPath) || feishuCallbackPath.includes("//")) {
    throw new StartupConfigError(
      `拒绝启动：FEISHU_CALLBACK_PATH 无效（${feishuCallbackPath}）。请使用以 / 开头且不含查询参数的路径，例如 /feishu/card。`,
    )
  }
  if (!feishuCallbackBind.trim()) {
    throw new StartupConfigError("拒绝启动：FEISHU_CALLBACK_BIND 不能为空。")
  }
  if (feishuCallbackEnabled && !feishuCallbackVerificationToken && !feishuCallbackEncryptKey) {
    throw new StartupConfigError(
      "拒绝启动：飞书卡片回调需要验签凭据。请配置 FEISHU_CALLBACK_VERIFICATION_TOKEN 或 FEISHU_CALLBACK_ENCRYPT_KEY。",
    )
  }

  const dataDir = resolve(pick(env.DATA_DIR) ?? "./data")
  const taskTimeoutMs = int(pick(env.TASK_TIMEOUT_MS) ?? env.OPENCODE_TIMEOUT_MS, 600_000, 10_000)
  const taskMaxTimeoutMs = taskMaxTimeout(env.TASK_MAX_TIMEOUT_MS, taskTimeoutMs)
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
    feishu: feishuAppId
      ? {
          appId: feishuAppId,
          appSecret: feishuAppSecret!,
          allowOpenIds: feishuUsers,
          allowAll: feishuAllowAll,
          callback: feishuCallbackEnabled
            ? {
                enabled: true,
                port: feishuCallbackPort,
                bind: feishuCallbackBind,
                path: feishuCallbackPath,
                verificationToken: feishuCallbackVerificationToken,
                encryptKey: feishuCallbackEncryptKey,
              }
            : undefined,
        }
      : undefined,
    opencode: {
      url: (pick(env.OPENCODE_URL) ?? "http://127.0.0.1:4096").replace(/\/+$/, ""),
      username: pick(env.OPENCODE_SERVER_USERNAME) ?? "opencode",
      password: pick(env.OPENCODE_SERVER_PASSWORD),
      agent: pick(env.OPENCODE_AGENT) ?? "assistant",
    },
    taskTimeoutMs,
    taskMaxTimeoutMs,
    reminderTimezone: validateTimezone(pick(env.REMINDER_TIMEZONE) ?? "Asia/Shanghai"),
    ccswitch: {
      bin: pick(env.CC_SWITCH_BIN),
      app: ccswitchApp,
    },
    magpie: {
      bin: pick(env.MAGPIE_BIN),
      gatewayUrl: parseGatewayUrl(pick(env.MAGPIE_URL)),
    },
    agentCli: {
      configPath: agentCliConfig ? resolve(agentCliConfig) : resolve(dataDir, "agents.json"),
    },
    api: {
      enabled: apiEnabled,
      port: apiPort,
      bind: apiBind,
      publicUrl: apiPublicUrl,
      token: apiToken,
    },
    maxReplyLength: int(env.MAX_REPLY_LENGTH, 1500, 100, 4000),
    maxMediaBytes: int(env.MAX_MEDIA_MB, 20, 1, 100) * 1024 * 1024,
    mediaAllowPrivateUrls: bool(env.MEDIA_ALLOW_PRIVATE_URLS, false),
    // 0 means no application-level ceiling. Telegram's getFile endpoint still has
    // its own 20MB limit; that is reported by the channel instead of being hidden
    // behind this setting.
    maxInputBytes: parseInputLimitBytes(env.MAX_INPUT_MB),
    dataDir,
    outboxDir: resolve(dataDir, "outbox"),
    inboxDir: resolve(dataDir, "inbox"),
    logLevel: logLevel(env.LOG_LEVEL),
    startupNotice: bool(env.STARTUP_NOTICE, true),
    usageReport: {
      enabled: bool(env.USAGE_DAILY_REPORT, false),
      time: validateReportTime(pick(env.USAGE_DAILY_REPORT_TIME) ?? "21:00"),
    },
    stt: parseStt(env),
    encryption: {
      enabled: bool(env.API_ENCRYPTION, false),
    },
  }
}

/** `MAX_INPUT_MB=0` disables the project-level inbound ceiling. */
export function parseInputLimitBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0
  return int(value, 0, 0, 100_000) * 1024 * 1024
}

/** magpie's local gateway is informational: only protocol+host[:port], no path/query. */
function parseGatewayUrl(value: string | undefined): string {
  const raw = value ?? "http://127.0.0.1:3425"
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new StartupConfigError(`拒绝启动：MAGPIE_URL 无效（${raw}）。请使用形如 http://127.0.0.1:3425 的地址。`)
  }
  if (!/^https?:$/.test(url.protocol) || !url.host) {
    throw new StartupConfigError(`拒绝启动：MAGPIE_URL 只能是协议+主机+端口（${raw}）。`)
  }
  return `${url.protocol}//${url.host}`
}

/** STT stays off until STT_BASE_URL is set; the model then defaults to whisper-1. */
function parseStt(env: NodeJS.ProcessEnv): BotConfig["stt"] {
  const baseUrl = pick(env.STT_BASE_URL)
  if (!baseUrl) return undefined
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new StartupConfigError(`拒绝启动：STT_BASE_URL 无效（${baseUrl}）。请以 http:// 或 https:// 开头。`)
  }
  return {
    baseUrl,
    apiKey: pick(env.STT_API_KEY),
    model: pick(env.STT_MODEL) ?? "whisper-1",
    language: pick(env.STT_LANGUAGE),
  }
}

/**
 * The address the App dials. A subpath is allowed and kept: a bot mounted behind nginx on a shared
 * domain is reached at https://域名/agent-bot, and the App appends `/api/v1` to whatever the QR hands
 * it. Only values that would point the App somewhere the operator did not mean are refused, and a
 * pasted API endpoint is trimmed back to the base it stands for.
 */
export function parseApiPublicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new StartupConfigError(`拒绝启动：API_PUBLIC_URL 无效（${value}）。请使用形如 https://bot.example.com 的地址。`)
  }
  if (!/^https?:$/.test(url.protocol) || !url.host || url.search || url.hash) {
    throw new StartupConfigError(
      `拒绝启动：API_PUBLIC_URL 只能是协议+主机+可选子路径（${value}），例如 https://bot.example.com、http://192.168.1.10:3080 或 https://bot.example.com/agent-bot。`,
    )
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`.replace(/\/api(?:\/v1)?$/, "")
  if (!/^https?:\/\/[^/?#]+(?:\/[^/?#]+)*$/.test(base)) {
    throw new StartupConfigError(`拒绝启动：API_PUBLIC_URL 的路径无效（${value}），路径各段不能为空。`)
  }
  return base
}

/** "HH:MM" 24-hour clock; an invalid value must fail at startup, not silently never fire. */
function validateReportTime(value: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new StartupConfigError(`拒绝启动：USAGE_DAILY_REPORT_TIME 无效（${value}）。请使用 24 小时制 HH:MM，例如 21:00。`)
  }
  return value
}
