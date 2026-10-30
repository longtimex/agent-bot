import { execFile, spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import { extendedEnv, extendedPath } from "./binPath.js"
import { clip, clipTail } from "./messages.js"

export const CC_SWITCH_APPS = [
  "claude",
  "codex",
  "gemini",
  "open-code",
  "opencode",
  "hermes",
  "open-claw",
  "openclaw",
  "pi",
] as const

// Newer cc-switch releases spell these with a hyphen; keep accepting both.
const APP_ALIASES: Record<string, string> = {
  opencode: "open-code",
  openclaw: "open-claw",
}

// Deep links still use the legacy (unhyphenated) app ids.
const DEEPLINK_APPS: Record<string, string> = {
  "open-code": "opencode",
  "open-claw": "openclaw",
}

/**
 * Own-property lookups only: an inherited name such as "constructor" would
 * otherwise be returned as a function where callers expect an app id string.
 */
function aliasOf(map: Record<string, string>, app: string): string | undefined {
  return Object.hasOwn(map, app) ? map[app] : undefined
}

export function normalizeCcSwitchApp(value: string | undefined): string {
  const app = (value ?? "opencode").trim().toLowerCase() || "opencode"
  return aliasOf(APP_ALIASES, app) ?? app
}

export function toDeeplinkApp(app: string): string {
  return aliasOf(DEEPLINK_APPS, app) ?? app
}

export interface CcSwitchProvider {
  id: string
  name: string
  apiUrl: string
  current: boolean
}

export interface CcSwitchSpeedtest {
  ok: boolean
  endpoint?: string
  latencyMs?: number
  status?: string
  raw: string
}

export interface CcSwitchRunResult {
  code: number
  stdout: string
  stderr: string
}

export type CcSwitchRunner = (args: string[], options: { timeoutMs: number }) => Promise<CcSwitchRunResult>

export type CcSwitchConfirmRunner = (
  args: string[],
  input: string,
  options: { timeoutMs: number },
) => Promise<CcSwitchRunResult>

export interface CcSwitchOptions {
  bin?: string
  app?: string
  projectDir?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  speedtestTimeoutMs?: number
  runner?: CcSwitchRunner
  confirmRunner?: CcSwitchConfirmRunner
  /** Checks that `script` understands `-qec`; injectable so tests need no real pty. */
  ptyProbe?: (scriptPath: string, env: NodeJS.ProcessEnv) => Promise<boolean>
}

export class CcSwitchError extends Error {}

const DEFAULT_TIMEOUT_MS = 20_000
const SPEEDTEST_TIMEOUT_MS = 90_000
const KILL_ESCALATION_MS = 5_000
const MAX_ID_LENGTH = 128
const MAX_OUTPUT = 8 * 1024 * 1024

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\u001b\][^\u0007]*\u0007?/g, "")
    .replace(/\r\n?/g, "\n")
}

export function redactSecrets(text: string): string {
  return text
    .replace(
      /("(?:[^"\\]*(?:api[\s_-]?key|token|secret|password|authorization|credential)[^"\\]*)"\s*:\s*")([^"]*)(")/gi,
      "$1***$3",
    )
    .replace(
      // The value may be quoted (`password: 'x'` is what a CLI dump looks like);
      // without the optional quote pair the secret itself never got masked
      /\b((?:api[\s_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|private[\s_-]?key)\s*[:=]\s*)(['"]?)([^\s"'\\,;]+)(\2)/gi,
      "$1$2***$4",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b(ghp_|gho_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi, "$1***$3")
}

export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

export function buildPromptDeeplink(app: string, name: string, content: string): string {
  const params = new URLSearchParams({
    resource: "prompt",
    app: toDeeplinkApp(app),
    name,
    content: toBase64Url(content),
  })
  return `ccswitch://v1/import?${params.toString()}`
}

export function parseMcpConfig(input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new CcSwitchError("MCP 配置必须是合法 JSON。")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CcSwitchError("MCP 配置必须是 JSON 对象。")
  }
  const obj = parsed as Record<string, unknown>
  const servers = obj.mcpServers
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return JSON.stringify(obj)
  }
  const values = Object.values(obj)
  if (values.length > 0 && values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
    return JSON.stringify({ mcpServers: obj })
  }
  throw new CcSwitchError(
    'MCP 配置需包含 mcpServers 对象，或直接提供 { "服务器ID": { "command": ... } }。',
  )
}

export function buildMcpDeeplink(app: string, input: string, apps?: string[]): string {
  const config = parseMcpConfig(input)
  const targets = (apps && apps.length > 0 ? apps : [app]).map(toDeeplinkApp)
  const params = new URLSearchParams({
    resource: "mcp",
    config: toBase64Url(config),
    apps: targets.join(","),
  })
  return `ccswitch://v1/import?${params.toString()}`
}

export function buildSkillDeeplink(repo: string): string {
  const params = new URLSearchParams({ resource: "skill", repo })
  return `ccswitch://v1/import?${params.toString()}`
}

export function assertSafeId(value: string, label = "ID"): string {
  const trimmed = value.trim()
  if (!trimmed) throw new CcSwitchError(`${label} 不能为空。`)
  if (trimmed.length > MAX_ID_LENGTH) throw new CcSwitchError(`${label} 过长。`)
  if (trimmed.startsWith("-")) throw new CcSwitchError(`${label} 不能以 - 开头。`)
  if (!/^[\w.:@+/-]+$/.test(trimmed)) {
    throw new CcSwitchError(`${label} 含有不支持的字符：${trimmed}`)
  }
  // IDs may contain "/" (e.g. provider/model), but never path traversal segments
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new CcSwitchError(`${label} 不能包含路径片段 . 或 ..`)
  }
  return trimmed
}

function isExecutable(path: string): boolean {
  try {
    // X_OK also succeeds on directories; spawning one would fail with EACCES.
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = extendedPath(env.PATH ?? "")
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

export function resolveCcSwitchBin(
  explicit: string | undefined,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit) {
    if (!isAbsolute(explicit) && !explicit.includes("/") && !explicit.includes("\\")) {
      return resolveOnPath(explicit, env)
    }
    const candidate = isAbsolute(explicit) ? explicit : resolve(projectDir, explicit)
    return isExecutable(candidate) ? candidate : undefined
  }
  const local = join(projectDir, "bin", "cc-switch")
  if (isExecutable(local)) return local
  return resolveOnPath("cc-switch", env)
}

function defaultRunner(bin: string, cwd: string, env: NodeJS.ProcessEnv): CcSwitchRunner {
  return (args, { timeoutMs }) =>
    new Promise<CcSwitchRunResult>((resolvePromise, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }
      const child = execFile(
        bin,
        args,
        { cwd, env, maxBuffer: MAX_OUTPUT, windowsHide: true },
        (error, stdout, stderr) => {
          const out = String(stdout ?? "")
          const err = String(stderr ?? "")
          if (!error) {
            finish(() => resolvePromise({ code: 0, stdout: out, stderr: err }))
            return
          }
          const code = (error as { code?: unknown }).code
          if (typeof code === "number") {
            finish(() => resolvePromise({ code, stdout: out, stderr: err }))
            return
          }
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            finish(() =>
              reject(
                new CcSwitchError(`cc-switch 输出超过 ${Math.round(MAX_OUTPUT / 1024 / 1024)}MB 上限，已中止。`),
              ),
            )
            return
          }
          finish(() => reject(new CcSwitchError(`无法执行 cc-switch：${(error as Error).message}`)))
        },
      )
      // execFile's own timeout sends a single SIGTERM and then waits for exit; a
      // cc-switch that ignores it would keep this promise pending forever, so the
      // deadline is owned here and escalates to SIGKILL like the pty path does
      timer = setTimeout(() => {
        child.kill("SIGTERM")
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        }, KILL_ESCALATION_MS)
        escalate.unref()
        finish(() => reject(new CcSwitchError(`cc-switch 执行超时（${Math.round(timeoutMs / 1000)} 秒）。`)))
      }, timeoutMs)
    })
}

function errorDetail(result: CcSwitchRunResult): string {
  // The error text is shown verbatim in Telegram, and cc-switch likes to echo the
  // config it failed on, so redact here instead of trusting every caller to do it.
  const stderr = redactSecrets(stripAnsi(result.stderr)).trim()
  const stdout = redactSecrets(stripAnsi(result.stdout)).trim()
  const detail = stderr || stdout || `退出码 ${result.code}`
  return detail.length > 1200 ? `${clip(detail, 1200)}…` : detail
}

/**
 * `script -c` hands its argument to `/bin/sh`, so every token of the pty command
 * is quoted here. Safe characters stay bare for readability; anything else is
 * single-quoted with the standard `'\''` escape, which neutralises metacharacters
 * coming from user-supplied provider or skill names.
 */
export function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Shell command handed to `script -qec`; the only place cc-switch runs through a shell. */
export function buildPtyCommand(bin: string, app: string, args: string[]): string {
  return [bin, "--app", app, ...args].map(shellQuote).join(" ")
}

function tableCells(line: string): string[] | undefined {
  if (!/[│┆]/.test(line)) return undefined
  const cells = line.split(/[│┆]/).map((cell) => cell.trim())
  if (cells.length > 0 && cells[0] === "") cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop()
  if (cells.length === 0) return undefined
  if (cells.every((cell) => /^[-─═╞╪┼┌┐└┘├┤┬┴]*$/.test(cell))) return undefined
  return cells
}

export function parseProviderList(output: string): CcSwitchProvider[] {
  const lines = stripAnsi(output).split("\n")
  const providers: CcSwitchProvider[] = []
  let headers: string[] | undefined
  let idIndex = -1
  let nameIndex = -1
  let urlIndex = -1

  for (const line of lines) {
    const cells = tableCells(line)
    if (!cells) continue
    if (!headers && cells.some((cell) => cell === "ID") && cells.some((cell) => cell === "Name")) {
      headers = cells
      idIndex = cells.indexOf("ID")
      nameIndex = cells.indexOf("Name")
      urlIndex = cells.indexOf("API URL")
      continue
    }
    if (!headers) continue
    const id = idIndex >= 0 ? (cells[idIndex] ?? "") : ""
    if (!id) {
      if (providers.length > 0 && urlIndex >= 0) {
        const wrapped = cells[urlIndex] ?? ""
        const last = providers[providers.length - 1]!
        if (wrapped) last.apiUrl = last.apiUrl ? `${last.apiUrl}${wrapped}` : wrapped
      }
      continue
    }
    const marker = idIndex > 0 ? (cells[idIndex - 1] ?? "") : ""
    providers.push({
      id,
      name: nameIndex >= 0 ? (cells[nameIndex] ?? "") : "",
      apiUrl: urlIndex >= 0 && cells[urlIndex] !== "N/A" ? (cells[urlIndex] ?? "") : "",
      current: marker.includes("✓"),
    })
  }

  const currentMatch = /(?:^|\n)\s*(?:→|ℹ)?\s*Current:\s*(\S+)/.exec(stripAnsi(output))
  const currentId = currentMatch?.[1]
  if (currentId) {
    for (const provider of providers) provider.current = provider.id === currentId
  }

  if (providers.length === 0 && currentId) {
    providers.push({ id: currentId, name: currentId, apiUrl: "", current: true })
  }

  return providers
}

export function parseSpeedtest(output: string): CcSwitchSpeedtest {
  const cleaned = stripAnsi(output)
  // A bare ✓ can belong to any line ("config loaded"); only the summary line proves the
  // whole test passed. Without it, accept ✓ only when nothing in the output reports a failure.
  const failed = /Error:|✗|\bFailed\b|\bTimeout\b/.test(cleaned)
  const result: CcSwitchSpeedtest = {
    ok: /Speedtest completed successfully/.test(cleaned) || (!failed && /✓/.test(cleaned)),
    raw: cleaned.trim(),
  }

  for (const line of cleaned.split("\n")) {
    const cells = tableCells(line)
    if (!cells || cells.length < 3) continue
    const latencyIndex = cells.findIndex((cell) => /\bms\b|\bFailed\b|\bTimeout\b/i.test(cell))
    if (latencyIndex < 0) continue
    result.endpoint = cells[latencyIndex - 1]
    const latency = /(\d+)\s*ms/.exec(cells[latencyIndex] ?? "")
    if (latency) {
      result.latencyMs = Number(latency[1])
      result.ok = true
    } else {
      result.ok = false
    }
    result.status = cells[latencyIndex + 1]
    break
  }

  const error = /Error:\s*(.+)/.exec(cleaned)
  if (error) {
    result.ok = false
    result.status = error[1]!.trim()
  }

  return result
}

/** BusyBox `script` has no `-qec`, so only util-linux can drive the confirm prompt. */
function probeScript(scriptPath: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(scriptPath, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      resolvePromise(false)
      return
    }
    let output = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolvePromise(false)
    }, 5_000)
    timer.unref()
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolvePromise(false)
    })
    child.on("close", () => {
      clearTimeout(timer)
      resolvePromise(/util-linux/i.test(output))
    })
  })
}

export class CcSwitchService {
  readonly #app: string
  readonly #projectDir: string
  readonly #env: NodeJS.ProcessEnv
  readonly #timeoutMs: number
  readonly #speedtestTimeoutMs: number
  readonly #runnerOverride?: CcSwitchRunner
  readonly #confirmRunnerOverride?: CcSwitchConfirmRunner
  readonly #ptyProbe: (scriptPath: string, env: NodeJS.ProcessEnv) => Promise<boolean>
  #explicitBin?: string
  #bin?: string
  #version?: string

  constructor(options: CcSwitchOptions = {}) {
    this.#app = normalizeCcSwitchApp(options.app)
    this.#projectDir = options.projectDir ?? process.cwd()
    this.#env = extendedEnv(options.env ?? process.env)
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#speedtestTimeoutMs = options.speedtestTimeoutMs ?? SPEEDTEST_TIMEOUT_MS
    this.#runnerOverride = options.runner
    this.#confirmRunnerOverride = options.confirmRunner
    this.#ptyProbe = options.ptyProbe ?? probeScript
    this.#explicitBin = options.bin
  }

  get app(): string {
    return this.#app
  }

  get deeplinkApp(): string {
    return toDeeplinkApp(this.#app)
  }

  get bin(): string | undefined {
    if (this.#runnerOverride) return this.#explicitBin ?? "cc-switch (runner)"
    if (!this.#bin) {
      this.#bin = resolveCcSwitchBin(this.#explicitBin, this.#projectDir, this.#env)
    }
    return this.#bin
  }

  get available(): boolean {
    return this.bin !== undefined
  }

  #ensureBin(): string {
    const bin = this.bin
    if (!bin) {
      throw new CcSwitchError(
        "未找到 cc-switch 可执行文件。运行 `npm run cc-switch:install` 安装，或设置 CC_SWITCH_BIN。",
      )
    }
    return bin
  }

  async run(args: string[], timeoutMs = this.#timeoutMs): Promise<CcSwitchRunResult> {
    const bin = this.#ensureBin()
    const runner =
      this.#runnerOverride ?? defaultRunner(bin, this.#projectDir, { ...this.#env, NO_COLOR: "1" })
    const result = await runner(["--app", this.#app, ...args], { timeoutMs })
    if (result.code !== 0) {
      throw new CcSwitchError(errorDetail(result))
    }
    return result
  }

  // Deep links reject the global --app flag; the app is encoded in the URL.
  async runBare(args: string[], timeoutMs = this.#timeoutMs): Promise<CcSwitchRunResult> {
    const bin = this.#ensureBin()
    const runner =
      this.#runnerOverride ?? defaultRunner(bin, this.#projectDir, { ...this.#env, NO_COLOR: "1" })
    const result = await runner(args, { timeoutMs })
    if (result.code !== 0) {
      throw new CcSwitchError(errorDetail(result))
    }
    return result
  }

  async runWithConfirm(args: string[], timeoutMs = this.#timeoutMs): Promise<CcSwitchRunResult> {
    const result = this.#confirmRunnerOverride
      ? await this.#confirmRunnerOverride(args, "y\n", { timeoutMs })
      : await this.#runPty(args, timeoutMs)
    if (result.code !== 0) {
      throw new CcSwitchError(errorDetail(result))
    }
    return result
  }

  async #runPty(args: string[], timeoutMs: number): Promise<CcSwitchRunResult> {
    const bin = this.#ensureBin()
    const script = resolveOnPath("script", this.#env)
    if (!script) {
      throw new CcSwitchError("未找到 script 命令，无法自动确认交互式操作；请在服务器安装 util-linux。")
    }
    // A BusyBox build ignores `-qec` and would sit reading stdin until the task times out
    if (!(await this.#ptyProbe(script, this.#env))) {
      throw new CcSwitchError(
        "`script` 不是 util-linux 版本（可能是 BusyBox），无法自动确认交互式操作；请在服务器安装 util-linux。",
      )
    }
    const command = buildPtyCommand(bin, this.#app, args)
    return new Promise<CcSwitchRunResult>((resolvePromise, reject) => {
      const child = spawn(script, ["-qec", command, "/dev/null"], {
        cwd: this.#projectDir,
        env: { ...this.#env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      // Decoders keep a multibyte character split across two pipe reads intact;
      // per-chunk toString() would turn it into replacement characters
      const out = new StringDecoder("utf8")
      const err = new StringDecoder("utf8")
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stdout = clipTail(stdout + out.end(), MAX_OUTPUT)
        stderr = clipTail(stderr + err.end(), MAX_OUTPUT)
        fn()
      }
      const timer = setTimeout(() => {
        // SIGTERM first so the pty child can flush; escalate if it lingers
        child.kill("SIGTERM")
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        }, KILL_ESCALATION_MS)
        escalate.unref()
        finish(() => reject(new CcSwitchError(`cc-switch 执行超时（${Math.round(timeoutMs / 1000)} 秒）。`)))
      }, timeoutMs)
      // Keep a rolling tail of each stream: capping only stdout let a chatty stderr
      // grow without limit, and killing on overflow aborted an otherwise healthy run
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = clipTail(stdout + out.write(chunk), MAX_OUTPUT)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = clipTail(stderr + err.write(chunk), MAX_OUTPUT)
      })
      child.on("error", (error) => {
        finish(() => reject(new CcSwitchError(`无法执行 cc-switch：${error.message}`)))
      })
      child.on("close", (code) => {
        finish(() => resolvePromise({ code: code ?? 1, stdout, stderr }))
      })
      // The child may exit before reading the confirmation; without this guard the
      // resulting EPIPE on stdin surfaces as an uncaught stream error
      child.stdin?.on("error", () => {})
      child.stdin?.write("y\n")
      child.stdin?.end()
    })
  }

  async importPrompt(name: string, content: string): Promise<string> {
    const preset = name.trim()
    if (!preset) throw new CcSwitchError("提示词名称不能为空。")
    if (!content.trim()) throw new CcSwitchError("提示词内容不能为空。")
    const result = await this.runBare(["deeplink", buildPromptDeeplink(this.#app, preset, content)], this.#speedtestTimeoutMs)
    return stripAnsi(result.stdout).trim()
  }

  async importMcp(input: string, apps?: string[]): Promise<string> {
    const result = await this.runBare(["deeplink", buildMcpDeeplink(this.#app, input, apps)], this.#speedtestTimeoutMs)
    return stripAnsi(result.stdout).trim()
  }

  async importSkill(repo: string): Promise<string> {
    const value = repo.trim()
    // [\w.-]+ alone would accept "owner/..", which is not a repository name
    if (!/^[\w.-]+\/[\w.-]+$/.test(value) || value.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new CcSwitchError("技能仓库格式应为 owner/name。")
    }
    const result = await this.runBare(["deeplink", buildSkillDeeplink(value)], this.#speedtestTimeoutMs)
    return stripAnsi(result.stdout).trim()
  }

  async version(): Promise<string | undefined> {
    if (this.#version) return this.#version
    if (!this.available) return undefined
    try {
      const bin = this.#ensureBin()
      const runner = this.#runnerOverride ?? defaultRunner(bin, this.#projectDir, this.#env)
      const result = await runner(["--version"], { timeoutMs: this.#timeoutMs })
      if (result.code !== 0) return undefined
      this.#version = stripAnsi(result.stdout).trim().split("\n")[0]
      return this.#version
    } catch {
      return undefined
    }
  }

  async listProviders(): Promise<CcSwitchProvider[]> {
    const result = await this.run(["provider", "list"])
    return parseProviderList(result.stdout)
  }

  async useProvider(id: string): Promise<string> {
    const safeId = assertSafeId(id, "Provider ID")
    const result = await this.run(["use", safeId])
    return stripAnsi(result.stdout).trim()
  }

  async speedtest(id: string): Promise<CcSwitchSpeedtest> {
    const result = await this.run(
      ["provider", "speedtest", assertSafeId(id, "Provider ID")],
      this.#speedtestTimeoutMs,
    )
    return parseSpeedtest(result.stdout || result.stderr)
  }

  async streamCheck(id: string): Promise<string> {
    const result = await this.run(
      ["provider", "stream-check", assertSafeId(id, "Provider ID")],
      this.#speedtestTimeoutMs,
    )
    return stripAnsi(result.stdout).trim()
  }

  async fetchModels(id: string): Promise<string> {
    const result = await this.run(["provider", "fetch-models", assertSafeId(id, "Provider ID")], this.#speedtestTimeoutMs)
    return stripAnsi(result.stdout).trim()
  }

  async listMcp(): Promise<string> {
    const result = await this.run(["mcp", "list"])
    return stripAnsi(result.stdout).trim()
  }

  async syncMcp(): Promise<string> {
    const result = await this.run(["mcp", "sync"])
    return stripAnsi(result.stdout).trim()
  }

  async listPrompts(): Promise<string> {
    const result = await this.run(["prompts", "list"])
    return stripAnsi(result.stdout).trim()
  }

  async activatePrompt(id: string): Promise<string> {
    const result = await this.run(["prompts", "activate", assertSafeId(id, "提示词 ID")])
    return stripAnsi(result.stdout).trim()
  }

  async deactivatePrompt(): Promise<string> {
    const result = await this.run(["prompts", "deactivate"])
    return stripAnsi(result.stdout).trim()
  }

  async envTools(): Promise<string> {
    const result = await this.run(["env", "tools"])
    return stripAnsi(result.stdout).trim()
  }

  async envCheck(): Promise<string> {
    const result = await this.run(["env", "check"])
    return stripAnsi(result.stdout).trim()
  }

  async proxyShow(): Promise<string> {
    const result = await this.run(["proxy", "show"])
    return stripAnsi(result.stdout).trim()
  }
}
