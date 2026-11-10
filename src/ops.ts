import { spawn } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { freemem, totalmem } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import { childEnv, installerChildEnv } from "./binPath.js"
import { CC_SWITCH_APPS, redactSecrets, resolveCcSwitchBin, stripAnsi } from "./ccswitch.js"
import { FEISHU_OPEN_ID_RE } from "./config.js"
import { whichSync } from "./agentCli.js"
import { EXIT_DRAIN_MS, terminateProcess } from "./childKill.js"
import { rotateLogIfNeeded } from "./logger.js"
import type { Logger } from "./logger.js"
import { clip, clipTail } from "./messages.js"
import { ReleaseManager, type ReleaseState } from "./releaseManager.js"
import { buildReleaseDiagnostics, resolveUpdateTarget, UpdateChecker, type ReleaseDiagnostics } from "./updateChecker.js"
import { UpdateOrchestrator } from "./updateOrchestrator.js"
import { readStartupSelfCheck, type StartupSelfCheck } from "./startupSelfCheck.js"
import { buildReleaseOverview, type ReleaseOverview } from "./releaseStatus.js"

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024
const MAX_STEP_OUTPUT = 1500
const LOG_TAIL_BYTES = 256 * 1024
const OPENCODE_START_WAIT_MS = 8_000
const VERSION_RE = /^(?:latest|v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?)$/

export interface OpsCommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface OpsStep {
  label: string
  ok: boolean
  code: number | null
  output: string
}

export interface OpsResult {
  ok: boolean
  message: string
  steps: OpsStep[]
  /** Absolute path of the artifact the operation produced (data backup). */
  file?: string
}

export interface OpsDiagnostics {
  node: string
  platform: string
  pid: number
  systemd: boolean
  projectDir: string
  uptimeSec: number
  git?: { branch: string; commit: string; dirty: boolean }
  opencode: { url: string; reachable: boolean; managed: boolean; pid?: number }
  ccSwitch?: { bin: string; version?: string }
  log: { path: string; bytes: number }
  opencodeLog: { path: string; bytes: number }
  disk?: { freeBytes: number; totalBytes: number }
  memory: { freeBytes: number; totalBytes: number }
  /** Epoch ms of the newest archive in data/backups/, undefined when never backed up. */
  lastBackupAt?: number
  /** Managed release state; absent on a plain checkout before the first update. */
  release?: ReleaseDiagnostics
  /** Update channel/fork target this installation follows. */
  update?: { channel: string; ref: string }
  /** Last startup self-check; undefined before the first successful/failed start. */
  startup?: StartupSelfCheck
}

export interface OpsLogResult {
  ok: boolean
  missing: boolean
  path: string
  bytes: number
  text: string
}

export interface OpsEnvEntry {
  key: string
  value?: string
  secret: boolean
  editable: boolean
}

export interface OpsEnvList {
  exists: boolean
  entries: OpsEnvEntry[]
}

export interface OpsEnvResult {
  ok: boolean
  message: string
}

export interface OpsServiceOptions {
  projectDir: string
  dataDir: string
  opencodeUrl: string
  ccSwitchBin?: string
  logPath?: string
  envPath?: string
  proxyEnv?: () => Record<string, string>
  health?: () => Promise<boolean>
  run?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<OpsCommandResult>
  spawnDetached?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => number | undefined
  spawnService?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string },
  ) => number | undefined
  which?: (bin: string) => string | undefined
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  systemd?: boolean
  nodeVersion?: string
  /** Release directory manager; defaults to data/releases beside the checkout. */
  releases?: ReleaseManager
}

interface EnvRule {
  hint: string
  validate: (value: string) => string | undefined
}

function intRule(min: number, max: number): EnvRule {
  return {
    hint: `${min} ~ ${max} 的整数`,
    validate: (value) => {
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed >= min && parsed <= max ? undefined : `需要 ${min} ~ ${max} 的整数`
    },
  }
}

function enumRule(values: readonly string[]): EnvRule {
  return {
    hint: values.join(" / "),
    validate: (value) => (values.includes(value) ? undefined : `可选值：${values.join("、")}`),
  }
}

const boolRule: EnvRule = {
  hint: "0 或 1",
  validate: (value) =>
    ["0", "1", "true", "false", "yes", "no", "on", "off"].includes(value.toLowerCase())
      ? undefined
      : "只接受 0 / 1",
}

const pathRule: EnvRule = {
  hint: "文件或目录路径",
  validate: (value) =>
    value.startsWith("-") || value.includes("\0") ? "路径不能以 - 开头或包含空字符" : undefined,
}

function urlRule(optional: boolean): EnvRule {
  return {
    hint: optional ? "http(s) URL，留空表示默认" : "http(s) URL",
    validate: (value) => {
      if (!value) return optional ? undefined : "不能为空"
      try {
        const parsed = new URL(value)
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "只支持 http:// 或 https://"
      } catch {
        return "URL 格式无效"
      }
    },
  }
}

function timezoneRule(value: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return undefined
  } catch {
    return "需要 IANA 时区名，例如 Asia/Shanghai"
  }
}

/**
 * The whitelist is written through `/access`, which keeps the acting administrator in the
 * list; validating it here means both paths share one rule.
 */
function allowUsersRule(value: string): string | undefined {
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (ids.length === 0) return "至少需要 1 个 Telegram 用户 ID"
  if (ids.length > 200) return "白名单最多 200 个 ID"
  const bad = ids.filter((item) => !/^\d{1,20}$/.test(item))
  return bad.length > 0 ? `用户 ID 只能是数字（收到：${bad.join("、")}）` : undefined
}

/** Feishu open_ids are opaque but always carry the `ou_` prefix and no whitespace. */
function allowOpenIdsRule(value: string): string | undefined {
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (ids.length === 0) return "至少需要 1 个飞书 open_id"
  if (ids.length > 200) return "白名单最多 200 个 open_id"
  const bad = ids.filter((item) => !FEISHU_OPEN_ID_RE.test(item))
  return bad.length > 0 ? `open_id 应形如 ou_xxx（收到：${bad.join("、")}）` : undefined
}

const ENV_RULES: Record<string, EnvRule> = {
  TASK_TIMEOUT_MS: intRule(10_000, 86_400_000),
  TASK_MAX_TIMEOUT_MS: intRule(10_000, 86_400_000),
  MAX_REPLY_LENGTH: intRule(100, 4000),
  MAX_MEDIA_MB: intRule(1, 100),
  MAX_INPUT_MB: intRule(0, 100_000),
  REMINDER_TIMEZONE: { hint: "IANA 时区", validate: timezoneRule },
  LOG_LEVEL: enumRule(["debug", "info", "warn", "error"]),
  STARTUP_NOTICE: boolRule,
  USAGE_DAILY_REPORT: boolRule,
  USAGE_DAILY_REPORT_TIME: {
    hint: "HH:MM（24 小时制，按 REMINDER_TIMEZONE）",
    validate: (value) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? undefined : "时间格式无效，应为 HH:MM"),
  },
  STT_BASE_URL: urlRule(true),
  STT_MODEL: {
    hint: "转写模型名（如 whisper-1）",
    validate: (value) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? undefined : "模型名格式无效"),
  },
  STT_LANGUAGE: {
    hint: "语言代码（如 zh，可留空）",
    validate: (value) => (/^[A-Za-z]{2,8}(-[A-Za-z0-9]+)*$/.test(value) ? undefined : "语言代码格式无效"),
  },
  MEDIA_ALLOW_PRIVATE_URLS: boolRule,
  API_ENCRYPTION: boolRule,
  TELEGRAM_ALLOW_ALL_USERS: boolRule,
  TELEGRAM_ALLOW_USERS: { hint: "逗号分隔的 Telegram 用户 ID（请用 /access 修改）", validate: allowUsersRule },
  FEISHU_ALLOW_ALL_USERS: boolRule,
  FEISHU_ALLOW_OPEN_IDS: { hint: "逗号分隔的飞书 open_id（请用 /access 修改）", validate: allowOpenIdsRule },
  FEISHU_CALLBACK_ENABLED: boolRule,
  FEISHU_CALLBACK_PORT: intRule(1, 65535),
  FEISHU_CALLBACK_BIND: {
    hint: "回调监听地址（如 0.0.0.0 或 127.0.0.1）",
    validate: (value) => (value.trim() ? undefined : "监听地址不能为空"),
  },
  FEISHU_CALLBACK_PATH: {
    hint: "回调路径（以 / 开头，如 /feishu/card）",
    validate: (value) =>
      /^\/[A-Za-z0-9._~/-]+$/.test(value) && !value.includes("//") ? undefined : "路径无效",
  },
  OPENCODE_URL: urlRule(false),
  OPENCODE_AGENT: {
    hint: "agent 名称（字母、数字、点、下划线、连字符）",
    validate: (value) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? undefined : "agent 名称格式无效"),
  },
  CC_SWITCH_APP: enumRule(CC_SWITCH_APPS),
  CC_SWITCH_BIN: pathRule,
  AGENT_CLI_CONFIG: pathRule,
  PROXY_TEST_URL: urlRule(true),
}

export const OPS_ENV_RULES: Readonly<Record<string, EnvRule>> = ENV_RULES
export const OPS_ENV_KEYS = Object.keys(ENV_RULES)

/**
 * Keys whose `.env` value is only meaningful together with the running bot's own state.
 * Editing them through `/env` would let the file and the live process disagree, so the
 * dedicated command owns the write.
 */
export const OPS_COMMAND_MANAGED_KEYS: ReadonlySet<string> = new Set([
  "TELEGRAM_ALLOW_USERS",
  "FEISHU_ALLOW_OPEN_IDS",
])

/** Written to .env and applied to the running bot at the same time, so no /restart is needed. */
export const OPS_HOT_ENV_KEYS: ReadonlySet<string> = new Set([
  "REMINDER_TIMEZONE",
  "TELEGRAM_ALLOW_USERS",
  "FEISHU_ALLOW_OPEN_IDS",
])

const SECRET_KEY_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|_KEY$|API_KEY)/i
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquoteEnv(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Values are read back by Node's own .env parser (process.loadEnvFile): single-quoted
 * content is kept verbatim, double quotes still expand `\n` and cannot contain a quote,
 * and backslash escapes are not undone. So prefer single quotes, and refuse the
 * combinations no quoting style round-trips instead of writing a value that silently
 * changes on the next restart.
 */
function quoteEnv(value: string): string | undefined {
  if (!value) return ""
  if (/^[A-Za-z0-9_./:@%+,~-]+$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  if (!/["\\]/.test(value)) return `"${value}"`
  return undefined
}

function lineMatchesKey(line: string, key: string): boolean {
  const match = ENV_LINE_RE.exec(line)
  return Boolean(match && match[1] === key)
}

function firstLine(text: string): string {
  return stripAnsi(text).split(/\r?\n/, 1)[0]?.trim() ?? ""
}

export class OpsService {
  readonly #projectDir: string
  readonly #dataDir: string
  readonly #opencodeUrl: string
  readonly #ccSwitchBin?: string
  readonly #logPath: string
  readonly #opencodeLogPath: string
  readonly #pidPath: string
  readonly #envPath: string
  readonly #proxyEnv?: () => Record<string, string>
  readonly #healthFn?: () => Promise<boolean>
  readonly #runOverride?: OpsServiceOptions["run"]
  readonly #spawnDetachedOverride?: OpsServiceOptions["spawnDetached"]
  readonly #spawnServiceOverride?: OpsServiceOptions["spawnService"]
  readonly #which: (bin: string) => string | undefined
  readonly #kill: (pid: number, signal: NodeJS.Signals) => void
  readonly #sleep: (ms: number) => Promise<void>
  readonly #systemd: boolean
  readonly #nodeVersion: string
  readonly #log?: Logger
  readonly #releases: ReleaseManager
  readonly #updates: UpdateOrchestrator
  readonly #updateChecker: UpdateChecker

  constructor(options: OpsServiceOptions, logger?: Logger) {
    this.#projectDir = resolve(options.projectDir)
    this.#dataDir = resolve(options.dataDir)
    this.#opencodeUrl = options.opencodeUrl
    this.#ccSwitchBin = options.ccSwitchBin
    this.#log = logger
    const logFromEnv = process.env.BOT_LOG_FILE?.trim()
    this.#logPath = options.logPath
      ? resolve(options.logPath)
      : logFromEnv
        ? resolve(logFromEnv)
        : join(this.#dataDir, "bot.log")
    this.#opencodeLogPath = join(this.#dataDir, "opencode.log")
    this.#pidPath = join(this.#dataDir, "opencode.pid")
    this.#envPath = options.envPath ? resolve(options.envPath) : join(this.#projectDir, ".env")
    this.#proxyEnv = options.proxyEnv
    this.#healthFn = options.health
    this.#runOverride = options.run
    this.#spawnDetachedOverride = options.spawnDetached
    this.#spawnServiceOverride = options.spawnService
    this.#which = options.which ?? ((bin) => whichSync(bin))
    this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))
    this.#systemd = options.systemd ?? Boolean(process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID)
    this.#nodeVersion = options.nodeVersion ?? process.version
    this.#releases =
      options.releases ??
      new ReleaseManager({
        projectDir: this.#projectDir,
        dataDir: this.#dataDir,
        run: (command, args, options) => this.#runCommandIn(options.cwd, command, args, options.timeoutMs, options.env),
        which: this.#which,
        env: process.env,
      })
    this.#updateChecker = new UpdateChecker({
      run: (command, args, timeoutMs) => this.#runCommand(command, args, timeoutMs),
      which: this.#which,
      releaseState: () => this.releaseState(),
    })
    this.#updates = new UpdateOrchestrator({
      projectDir: this.#projectDir,
      releases: this.#releases,
      releaseState: () => this.releaseState(),
      backup: () => this.backupData(),
      updateTarget: () => this.updateTarget(),
      releaseVersion: () => this.#gitVersionFallback(),
      hasGit: () => Boolean(this.#which("git")),
      hasNpm: () => Boolean(this.#which("npm")),
    })
  }

  releaseState(): ReleaseState {
    return this.#releases.readState()
  }

  #gitVersionFallback(): string {
    try {
      const pkg = JSON.parse(readFileSync(join(this.#projectDir, "package.json"), "utf8")) as { version?: string }
      return pkg.version || "dev"
    } catch {
      return "dev"
    }
  }

  get logPath(): string {
    return this.#logPath
  }

  get opencodeLogPath(): string {
    return this.#opencodeLogPath
  }

  get systemd(): boolean {
    return this.#systemd
  }

  async diagnostics(): Promise<OpsDiagnostics> {
    const [git, reachable, ccSwitch] = await Promise.all([
      this.#gitInfo(),
      this.#checkHealth(),
      this.#ccSwitchInfo(),
    ])
    const pid = this.#managedPid()
    let disk: OpsDiagnostics["disk"]
    try {
      const info = statfsSync(this.#projectDir)
      disk = { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize }
    } catch {
      disk = undefined
    }
    const startup = readStartupSelfCheck(this.#dataDir)
    return {
      node: this.#nodeVersion,
      platform: `${process.platform} ${process.arch}`,
      pid: process.pid,
      systemd: this.#systemd,
      projectDir: this.#projectDir,
      uptimeSec: Math.round(process.uptime()),
      git,
      opencode: { url: this.#opencodeUrl, reachable, managed: pid !== undefined, pid },
      ccSwitch,
      log: { path: this.#logPath, bytes: this.#fileSize(this.#logPath) },
      opencodeLog: { path: this.#opencodeLogPath, bytes: this.#fileSize(this.#opencodeLogPath) },
      disk,
      memory: { freeBytes: freemem(), totalBytes: totalmem() },
      // 恒为数字（0 = 从未备份）：编码器会丢弃 undefined,而 App 模型按必填解码
      lastBackupAt: this.#lastBackupAt() ?? 0,
      ...this.#releaseDiagnostics(),
      ...(startup ? { startup } : {}),
    }
  }

  /** Newest archive's mtime from data/backups/; undefined when never backed up. */
  #lastBackupAt(): number | undefined {
    const backupDir = join(this.#dataDir, "backups")
    if (!existsSync(backupDir)) return undefined
    try {
      const newest = readdirSync(backupDir)
        .filter((name) => name.startsWith("backup-") && name.endsWith(".tar.gz"))
        .sort()
        .pop()
      return newest ? statSync(join(backupDir, newest)).mtimeMs : undefined
    } catch {
      return undefined
    }
  }

  /** Dry-run update check: fetch upstream and count new commits; changes nothing locally. */
  /**
   * Packs the JSON state stores into data/backups/ (latest 5 kept) for migration
   * or safekeeping. The pairing token is deliberately excluded: it is a secret,
   * and a fresh machine regenerates one on first start anyway.
   */
  async backupData(): Promise<OpsResult & { file?: string }> {
    if (!this.#which("tar")) return { ok: false, message: "未找到 tar，无法打包备份。", steps: [] }
    const steps: OpsStep[] = []

    // 配对令牌与消息加密密钥都属于秘密，不进备份：令牌在新机自动重生，加密密钥
    // 重新扫码配对即可获得——把任何一个打进 tar.gz 都等于把它们发到聊天里。
    // A missing/unreadable data dir simply means there is nothing to back up yet.
    const files = existsSync(this.#dataDir)
      ? readdirSync(this.#dataDir).filter(
          (name) => name.endsWith(".json") && name !== "api-token.json" && name !== "api-enc-key.json",
        )
      : []
    if (files.length === 0) {
      return { ok: false, message: "data 目录里还没有可备份的状态文件。", steps }
    }
    const backupDir = join(this.#dataDir, "backups")
    mkdirSync(backupDir, { recursive: true })
    const now = new Date()
    const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
    // Milliseconds in the name: two backups in the same second must not overwrite each other
    const out = join(
      backupDir,
      `backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}.tar.gz`,
    )
    const tar = await this.#runCommand("tar", ["-czf", out, "-C", this.#dataDir, ...files], 60_000)
    steps.push(this.#step("打包状态文件", tar))
    if (tar.code !== 0) {
      return { ok: false, message: "打包失败，请根据输出排查。", steps }
    }

    // Keep the newest 5 archives so long-running bots do not fill the disk
    const archives = readdirSync(backupDir)
      .filter((name) => name.startsWith("backup-") && name.endsWith(".tar.gz"))
      .sort()
    for (const stale of archives.slice(0, Math.max(0, archives.length - 5))) {
      unlinkSync(join(backupDir, stale))
    }

    const kb = (statSync(out).size / 1024).toFixed(1)
    return {
      ok: true,
      file: out,
      message: `📦 已备份 ${files.length} 个状态文件（${kb} KB）。配对令牌未包含：新机器首次启动会自动重新生成。`,
      steps,
    }
  }

  updateTarget(): { channel: string; ref: string } {
    return resolveUpdateTarget()
  }

  /** Dry-run update check: fetch upstream and count new commits; changes nothing locally. */
  checkUpdate(): Promise<OpsResult> {
    return this.#updateChecker.check()
  }

  updateProject(): Promise<OpsResult> {
    return this.#updates.updateProject()
  }

  cancelPendingRelease(): OpsResult {
    return this.#updates.cancelPending()
  }

  rollbackRelease(): OpsResult {
    return this.#updates.rollback()
  }

  #releaseDiagnostics(): Pick<OpsDiagnostics, "release" | "update"> {
    return buildReleaseDiagnostics(this.releaseState(), this.updateTarget())
  }

  /**
   * Cheap payload for the App's release card; avoids the full diagnostics probes.
   */
  releaseOverview(): ReleaseOverview {
    return buildReleaseOverview(
      this.releaseState(),
      this.updateTarget(),
      readStartupSelfCheck(this.#dataDir),
      this.#lastBackupAt() ?? 0,
    )
  }

  async runCheck(): Promise<OpsResult> {
    const npm = this.#which("npm")
    if (!npm) return { ok: false, message: "未找到 npm，无法运行检查。", steps: [] }
    // The checks execute code from the repo (tsc, tests, build scripts), so they get
    // the same credential-free environment as an install
    const result = await this.#runCommand(npm, ["run", "check"], 15 * 60_000, this.#installerEnv())
    return {
      ok: result.code === 0,
      message:
        result.code === 0
          ? "检查通过（类型检查 + 单元测试 + 构建）。"
          : "检查失败，请根据输出修复后重试；Bot 仍在运行旧版本。",
      steps: [this.#step("npm run check", result)],
    }
  }

  async restartBot(): Promise<OpsResult> {
    if (this.#systemd) {
      return {
        ok: false,
        message:
          "当前 Bot 由 systemd 管理，已拒绝使用脚本重启，避免与 systemd 争抢实例锁。\n" +
          "请执行 `sudo systemctl restart telegram-bot`（或你的服务名）；新 release 会在启动时生效，健康检查失败时请手动切回上一版。",
        steps: [],
      }
    }
    const applyScript = join(this.#projectDir, "scripts", "apply-release.sh")
    const restartScript = join(this.#projectDir, "scripts", "restart.sh")
    const script = existsSync(applyScript) ? applyScript : restartScript
    if (!existsSync(script)) return { ok: false, message: "未找到 scripts/restart.sh 或 scripts/apply-release.sh，无法重启。", steps: [] }
    // An update is activated from data/releases/store, so the checkout's dist/index.js
    // may be absent or older than the running release. Accept either a usable current
    // release or, for a plain checkout, the built dist entrypoint.
    if (!this.#releases.currentEntry() && !existsSync(join(this.#projectDir, "dist", "index.js"))) {
      return { ok: false, message: "未找到可启动的 release 或 dist/index.js，请先运行构建（/ops 中的「运行检查」或 /update）。", steps: [] }
    }
    const pid = this.#spawnDetached("bash", [script])
    if (!pid) return { ok: false, message: "重启进程启动失败，请检查脚本权限与 Node 环境。", steps: [] }
    return {
      ok: true,
      message:
        `已触发重启（脚本 PID ${pid}），Bot 将在数秒内重新连接。` +
        (existsSync(applyScript) ? "新版本启动后会做健康检查，失败会自动回滚。" : ""),
      steps: [],
    }
  }

  async opencodeStatus(): Promise<{ reachable: boolean; managed: boolean; pid?: number; url: string }> {
    const reachable = await this.#checkHealth()
    const pid = this.#managedPid()
    return { reachable, managed: pid !== undefined, pid, url: this.#opencodeUrl }
  }

  async startOpencode(): Promise<OpsResult> {
    const status = await this.opencodeStatus()
    if (status.reachable) {
      return {
        ok: true,
        message: `OpenCode 已在运行${status.pid ? `（PID ${status.pid}）` : ""}。`,
        steps: [],
      }
    }
    // The pid file is only reported while that process is really an `opencode serve`, so
    // starting another one here would leave two servers fighting for the port and would
    // overwrite the pid file with the newcomer's.
    if (status.managed && status.pid) {
      return {
        ok: false,
        message:
          `OpenCode 进程已在运行（PID ${status.pid}），但健康检查未通过。\n` +
          `请查看日志：${this.#opencodeLogPath}；需要重新启动时请先在 /ops 中停止 OpenCode。`,
        steps: [],
      }
    }
    const target = this.#loopbackTarget()
    if (!target) {
      return {
        ok: false,
        message: "OPENCODE_URL 指向非本机地址，Bot 无法在远端主机上管理 OpenCode 服务。",
        steps: [],
      }
    }
    const bin = this.#which("opencode")
    if (!bin) {
      return {
        ok: false,
        message: "未找到 opencode 可执行文件。可发送 `/agents install opencode-cli` 安装。",
        steps: [],
      }
    }

    mkdirSync(this.#dataDir, { recursive: true })
    rotateLogIfNeeded(this.#opencodeLogPath)
    const args = ["serve", "--port", String(target.port), "--hostname", target.host]
    const pid = this.#spawnService(bin, args)
    if (!pid) {
      return {
        ok: false,
        message: `OpenCode 启动失败，请查看日志：${this.#opencodeLogPath}`,
        steps: [],
      }
    }
    this.#writePid(pid)
    this.#log?.info(`started opencode serve (pid ${pid}) on ${target.host}:${target.port}`)

    const deadline = Date.now() + OPENCODE_START_WAIT_MS
    while (Date.now() < deadline) {
      if (await this.#checkHealth()) {
        return {
          ok: true,
          message: `OpenCode 已启动（PID ${pid}，${target.host}:${target.port}）。`,
          steps: [],
        }
      }
      if (!this.#alive(pid)) break
      await this.#sleep(500)
    }
    return {
      ok: false,
      message: `OpenCode 进程已启动（PID ${pid}），但健康检查未通过。请查看日志：${this.#opencodeLogPath}`,
      steps: [],
    }
  }

  async stopOpencode(): Promise<OpsResult> {
    const pid = this.#managedPid()
    const reachable = await this.#checkHealth()
    if (!pid) {
      if (reachable) {
        return {
          ok: false,
          message:
            "OpenCode 正在运行，但不是由 Bot 启动的（未找到 data/opencode.pid），已拒绝停止。\n" +
            "请手动停止后，再用 Bot 启动以接管。",
          steps: [],
        }
      }
      return { ok: true, message: "OpenCode 未在运行。", steps: [] }
    }

    try {
      this.#kill(pid, "SIGTERM")
    } catch {
      this.#removePid()
      return { ok: true, message: `OpenCode（PID ${pid}）已不存在。`, steps: [] }
    }

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      // Identity check, not mere liveness: a recycled or zombie pid must not be SIGKILLed
      if (!this.#isOpencodeProcess(pid)) break
      await this.#sleep(200)
    }
    if (this.#isOpencodeProcess(pid)) {
      try {
        this.#kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
      await this.#sleep(200)
    }
    this.#removePid()
    this.#log?.info(`stopped opencode serve (pid ${pid})`)
    return { ok: true, message: `已停止 OpenCode（PID ${pid}）。`, steps: [] }
  }

  async restartOpencode(): Promise<OpsResult> {
    const status = await this.opencodeStatus()
    if (status.reachable && !status.managed) {
      return {
        ok: false,
        message:
          "OpenCode 正在运行，但不是由 Bot 启动的（未找到 data/opencode.pid），已拒绝重启。\n" +
          "请手动停止后，再用 Bot 启动以接管。",
        steps: [],
      }
    }
    if (status.managed) {
      const stopped = await this.stopOpencode()
      if (!stopped.ok) return stopped
    }
    return this.startOpencode()
  }

  async installCcSwitch(force = false, version = "latest"): Promise<OpsResult> {
    if (!VERSION_RE.test(version)) {
      return { ok: false, message: "版本号格式无效，只接受 latest 或 v1.2.3。", steps: [] }
    }
    const script = join(this.#projectDir, "scripts", "install-cc-switch.sh")
    if (!existsSync(script)) {
      return { ok: false, message: "未找到 scripts/install-cc-switch.sh。", steps: [] }
    }
    const args = [script, version, ...(force ? ["--force"] : [])]
    // The script downloads and unpacks a binary; it has no use for provider keys.
    const result = await this.#runCommand("bash", args, 5 * 60_000, this.#installerEnv())
    const step = this.#step("install-cc-switch.sh", result)
    if (result.code !== 0) {
      return { ok: false, message: "cc-switch 安装/更新失败，请查看输出。", steps: [step] }
    }
    const info = await this.#ccSwitchInfo()
    return {
      ok: true,
      message: info?.version
        ? `cc-switch 已就绪：${info.version}`
        : "cc-switch 安装命令已完成。发送 /cc 验证是否可用。",
      steps: [step],
    }
  }

  tailLogs(source: "bot" | "opencode" = "bot", lines = 80): OpsLogResult {
    const path = source === "opencode" ? this.#opencodeLogPath : this.#logPath
    const limit = Math.min(400, Math.max(1, Math.floor(lines)))
    if (!existsSync(path)) {
      return { ok: false, missing: true, path, bytes: 0, text: "" }
    }
    const size = this.#fileSize(path)
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    let text = ""
    try {
      const length = size - start
      const buffer = Buffer.alloc(length)
      const fd = openSync(path, "r")
      try {
        // A single readSync may legally return fewer bytes than requested
        let read = 0
        while (read < length) {
          const chunk = readSync(fd, buffer, read, length - read, start + read)
          if (chunk === 0) break
          read += chunk
        }
      } finally {
        closeSync(fd)
      }
      text = buffer.toString("utf8")
      if (start > 0) {
        const newline = text.indexOf("\n")
        if (newline >= 0) text = text.slice(newline + 1)
      }
    } catch (err) {
      return {
        ok: false,
        missing: false,
        path,
        bytes: size,
        text: err instanceof Error ? err.message : String(err),
      }
    }
    const cleaned = stripAnsi(redactSecrets(text)).trim()
    const all = cleaned ? cleaned.split(/\r?\n/) : []
    return { ok: true, missing: false, path, bytes: size, text: all.slice(-limit).join("\n") }
  }

  envList(): OpsEnvList {
    if (!existsSync(this.#envPath)) return { exists: false, entries: [] }
    let content = ""
    try {
      content = readFileSync(this.#envPath, "utf8")
    } catch {
      return { exists: false, entries: [] }
    }
    const entries: OpsEnvEntry[] = []
    for (const line of content.split(/\r?\n/)) {
      const match = ENV_LINE_RE.exec(line)
      if (!match || !match[1]) continue
      const key = match[1]
      const secret = SECRET_KEY_RE.test(key)
      entries.push({
        key,
        value: secret ? undefined : unquoteEnv(match[2] ?? ""),
        secret,
        editable: Object.hasOwn(ENV_RULES, key) && !OPS_COMMAND_MANAGED_KEYS.has(key),
      })
    }
    return { exists: true, entries }
  }

  envSet(rawKey: string, rawValue: string, managed = false): OpsEnvResult {
    const key = rawKey.trim().toUpperCase()
    // hasOwn keeps inherited names like "TOSTRING" out of the rule lookup
    const rule = Object.hasOwn(ENV_RULES, key) ? ENV_RULES[key] : undefined
    if (!rule) {
      return {
        ok: false,
        message: `不支持在聊天中修改 ${key || "该配置"}。可修改：${OPS_ENV_KEYS.join("、")}`,
      }
    }
    if (!managed && OPS_COMMAND_MANAGED_KEYS.has(key)) {
      return { ok: false, message: `${key} 请使用 /access 修改：它会同时更新运行中的白名单，并阻止把自己移出。` }
    }
    const value = rawValue.trim()
    if (value.length > 500) return { ok: false, message: "配置值过长（上限 500 字符）。" }
    if (/[\r\n\0]/.test(value)) return { ok: false, message: "配置值不能包含换行或空字符。" }
    const error = rule.validate(value)
    if (error) return { ok: false, message: `${key} 无效：${error}。` }

    const quoted = quoteEnv(value)
    if (quoted === undefined) {
      return {
        ok: false,
        message: `${key} 同时含有单引号与双引号/反斜杠，无法安全写入 .env；请改用其他路径或值。`,
      }
    }
    const content = existsSync(this.#envPath) ? readFileSync(this.#envPath, "utf8") : ""
    const rows = content ? content.split(/\r?\n/) : []
    const line = `${key}=${quoted}`
    const index = rows.findIndex((row) => lineMatchesKey(row, key))
    const filtered = rows.filter((row) => !lineMatchesKey(row, key))
    if (index >= 0) filtered.splice(Math.min(index, filtered.length), 0, line)
    else filtered.push(line)
    while (filtered.length > 0 && filtered[filtered.length - 1] === "") filtered.pop()
    this.#writeEnv(`${filtered.join("\n")}\n`)
    this.#log?.info(`updated .env key ${key}`)
    return {
      ok: true,
      message: OPS_HOT_ENV_KEYS.has(key)
        ? `已更新 ${key}，立即生效，无需重启。`
        : `已更新 ${key}。重启 Bot 后生效（发送 /restart）；若修改的是 OpenCode 相关配置，还需重启 OpenCode 服务。`,
    }
  }

  envUnset(rawKey: string): OpsEnvResult {
    const key = rawKey.trim().toUpperCase()
    if (!Object.hasOwn(ENV_RULES, key)) {
      return { ok: false, message: `不支持在聊天中修改 ${key || "该配置"}。` }
    }
    if (OPS_COMMAND_MANAGED_KEYS.has(key)) {
      return { ok: false, message: `${key} 请使用 /access del <ID> 逐项删除：清空白名单会让所有人都无法使用 Bot。` }
    }
    if (!existsSync(this.#envPath)) return { ok: false, message: "未找到 .env 文件。" }
    const content = readFileSync(this.#envPath, "utf8")
    const rows = content.split(/\r?\n/)
    if (!rows.some((row) => lineMatchesKey(row, key))) {
      return { ok: false, message: `.env 中没有设置 ${key}。` }
    }
    const filtered = rows.filter((row) => !lineMatchesKey(row, key))
    while (filtered.length > 0 && filtered[filtered.length - 1] === "") filtered.pop()
    this.#writeEnv(`${filtered.join("\n")}\n`)
    this.#log?.info(`removed .env key ${key}`)
    return { ok: true, message: `已删除 ${key}，将使用默认值。重启 Bot 后生效。` }
  }

  #writeEnv(content: string): void {
    mkdirSync(dirname(this.#envPath), { recursive: true })
    const temp = `${this.#envPath}.${process.pid}.tmp`
    writeFileSync(temp, content, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, this.#envPath)
    chmodSync(this.#envPath, 0o600)
  }

  async #gitInfo(): Promise<OpsDiagnostics["git"]> {
    if (!this.#which("git")) return undefined
    const [branch, commit, status] = await Promise.all([
      this.#runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], 10_000),
      this.#runCommand("git", ["rev-parse", "--short", "HEAD"], 10_000),
      this.#runCommand("git", ["status", "--porcelain"], 30_000),
    ])
    if (branch.code !== 0 || commit.code !== 0) return undefined
    return {
      branch: firstLine(branch.stdout) || "HEAD",
      commit: firstLine(commit.stdout) || "unknown",
      dirty: Boolean(stripAnsi(status.stdout).trim()),
    }
  }

  async #ccSwitchInfo(): Promise<OpsDiagnostics["ccSwitch"]> {
    const bin = resolveCcSwitchBin(this.#ccSwitchBin, this.#projectDir, process.env)
    if (!bin) return undefined
    const result = await this.#runCommand(bin, ["--version"], 8_000)
    const version = firstLine(result.stdout || result.stderr)
    return { bin, version: version || undefined }
  }

  async #checkHealth(): Promise<boolean> {
    if (!this.#healthFn) return false
    try {
      return await this.#healthFn()
    } catch {
      return false
    }
  }

  #loopbackTarget(): { host: string; port: number } | undefined {
    let url: URL
    try {
      url = new URL(this.#opencodeUrl)
    } catch {
      return undefined
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return undefined
    const port = url.port ? Number(url.port) : 4096
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return { host: hostname === "localhost" ? "127.0.0.1" : hostname, port }
  }

  #managedPid(): number | undefined {
    let raw: string
    try {
      raw = readFileSync(this.#pidPath, "utf8").trim()
    } catch {
      return undefined
    }
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0 || !this.#isOpencodeProcess(pid)) {
      this.#removePid()
      return undefined
    }
    return pid
  }

  #isOpencodeProcess(pid: number): boolean {
    try {
      process.kill(pid, 0)
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ")
      return /\bopencode\b/.test(cmdline) && /\bserve\b/.test(cmdline)
    } catch {
      return false
    }
  }

  #alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  #writePid(pid: number): void {
    try {
      mkdirSync(this.#dataDir, { recursive: true })
      writeFileSync(this.#pidPath, `${pid}\n`, { mode: 0o600 })
      chmodSync(this.#pidPath, 0o600)
    } catch (err) {
      this.#log?.warn(`failed to write ${this.#pidPath}:`, (err as Error).message)
    }
  }

  #removePid(): void {
    try {
      unlinkSync(this.#pidPath)
    } catch {
      // already gone
    }
  }

  #fileSize(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  #env(): NodeJS.ProcessEnv {
    return childEnv({ ...process.env, ...this.#proxyEnv?.() })
  }

  /**
   * `npm install` runs lifecycle scripts written by package authors, so it gets the
   * same credential-free environment as `/agents install`; opencode itself keeps its keys.
   */
  #installerEnv(): NodeJS.ProcessEnv {
    return installerChildEnv({ ...process.env, ...this.#proxyEnv?.() })
  }

  #spawnDetached(command: string, args: string[]): number | undefined {
    const env = this.#env()
    if (this.#spawnDetachedOverride) {
      return this.#spawnDetachedOverride(command, args, { cwd: this.#projectDir, env })
    }
    try {
      const child = spawn(command, args, { cwd: this.#projectDir, env, detached: true, stdio: "ignore" })
      child.unref()
      child.on("error", () => {})
      return child.pid
    } catch (err) {
      this.#log?.warn(`failed to spawn ${command}:`, (err as Error).message)
      return undefined
    }
  }

  #spawnService(command: string, args: string[]): number | undefined {
    const env = this.#env()
    if (this.#spawnServiceOverride) {
      return this.#spawnServiceOverride(command, args, {
        cwd: this.#projectDir,
        env,
        logPath: this.#opencodeLogPath,
      })
    }
    let fd: number
    try {
      mkdirSync(this.#dataDir, { recursive: true })
      fd = openSync(this.#opencodeLogPath, "a", 0o600)
    } catch (err) {
      this.#log?.warn(`failed to open ${this.#opencodeLogPath}:`, (err as Error).message)
      return undefined
    }
    try {
      const child = spawn(command, args, {
        cwd: this.#projectDir,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
      })
      child.unref()
      child.on("error", () => {})
      return child.pid
    } catch (err) {
      this.#log?.warn(`failed to spawn opencode:`, (err as Error).message)
      return undefined
    } finally {
      closeSync(fd)
    }
  }

  #runCommand(
    command: string,
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env: NodeJS.ProcessEnv = this.#env(),
  ): Promise<OpsCommandResult> {
    return this.#runCommandIn(this.#projectDir, command, args, timeoutMs, env)
  }

  #runCommandIn(
    cwd: string,
    command: string,
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env: NodeJS.ProcessEnv = this.#env(),
  ): Promise<OpsCommandResult> {
    if (this.#runOverride) return this.#runOverride(command, args, { cwd, env, timeoutMs })
    return new Promise((resolvePromise) => {
      // detached puts npm/bash in its own process group, so a timeout stops the lifecycle
      // scripts and downloads it started instead of leaving them mutating node_modules
      // while a retry runs. Output is capped like everywhere else, not rejected.
      const child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      let timedOut = false
      let drainTimer: NodeJS.Timeout | null = null
      const out = new StringDecoder("utf8")
      const err = new StringDecoder("utf8")
      const finish = (code: number | null, extra?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (drainTimer) clearTimeout(drainTimer)
        child.stdout?.destroy()
        child.stderr?.destroy()
        stdout = clipTail(stdout + out.end(), MAX_OUTPUT_CHARS)
        stderr = clipTail(stderr + err.end(), MAX_OUTPUT_CHARS)
        const message = extra ? (stderr ? `${stderr}\n${extra}` : extra) : stderr
        resolvePromise({ code, stdout, stderr: message, ...(timedOut ? { timedOut } : {}) })
      }
      const timer = setTimeout(() => {
        timedOut = true
        terminateProcess(child)
      }, timeoutMs)
      timer.unref()

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = clipTail(stdout + out.write(chunk), MAX_OUTPUT_CHARS)
        armDrain()
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = clipTail(stderr + err.write(chunk), MAX_OUTPUT_CHARS)
        armDrain()
      })
      // `close` waits for every pipe to reach EOF, and a lifecycle script or npm hook that
      // leaves a detached helper holding the write end open never delivers it — the step
      // would hang with #opsActionRunning set, blocking every later action. Once the
      // process is gone, keep waiting only while output still arrives.
      const armDrain = (): void => {
        if (settled || (child.exitCode === null && child.signalCode === null)) return
        if (drainTimer) clearTimeout(drainTimer)
        drainTimer = setTimeout(() => {
          // Signal while the read ends are still open, so the orphan that holds the pipes
          // is actually stopped; finish() destroys them and would mark them drained
          terminateProcess(child)
          finish(child.exitCode)
        }, EXIT_DRAIN_MS)
        drainTimer.unref()
      }
      child.once("exit", armDrain)
      child.on("error", (error) => finish(null, error.message))
      child.on("close", (code) => finish(code))
    })
  }

  #step(label: string, result: OpsCommandResult): OpsStep {
    return {
      label,
      ok: result.code === 0,
      code: result.code,
      output: this.#output(result),
    }
  }

  #output(result: OpsCommandResult): string {
    const text = stripAnsi(redactSecrets(`${result.stdout}\n${result.stderr}`)).trim()
    if (!text) return ""
    if (text.length <= MAX_STEP_OUTPUT) return text
    // The halves go back to Telegram, which rejects a cut that splits a surrogate pair
    return `${clip(text, MAX_STEP_OUTPUT / 2) ?? ""}\n…\n${clipTail(text, MAX_STEP_OUTPUT / 2)}`
  }
}
