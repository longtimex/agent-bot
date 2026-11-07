import { execFile } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import process from "node:process"
import { childEnv, extendedPath } from "./binPath.js"
import { redactSecrets, stripAnsi } from "./ccswitch.js"
import { clip } from "./messages.js"

/** magpie's local gateway defaults to this address in every released build. */
export const MAGPIE_DEFAULT_URL = "http://127.0.0.1:3425"
/** Provider/model/quota commands reach the network and can take a while. */
export const MAGPIE_LONG_TIMEOUT_MS = 90_000
/** `magpie update` may download a new binary before replacing the running one. */
export const MAGPIE_UPDATE_TIMEOUT_MS = 180_000
const DEFAULT_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 8_000
const KILL_ESCALATION_MS = 5_000
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_ID_LENGTH = 160

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/

export class MagpieError extends Error {
  name = "MagpieError"
}

/** A command ran but exited non-zero; the message is magpie's own (redacted) explanation. */
export class MagpieRunError extends MagpieError {
  name = "MagpieRunError"
}

export interface MagpieRunResult {
  code: number
  stdout: string
  stderr: string
}

export type MagpieRunner = (args: string[], options: { timeoutMs: number }) => Promise<MagpieRunResult>

export interface MagpieOptions {
  bin?: string
  projectDir?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  longTimeoutMs?: number
  gatewayUrl?: string
  runner?: MagpieRunner
}

export interface MagpieOverview {
  available: boolean
  bin?: string
  version?: string
  gatewayUrl: string
  healthy: boolean
  error?: string
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
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

/**
 * `MAGPIE_BIN` wins; otherwise the repo-local ./bin/magpie the install script drops in,
 * then PATH. Resolution is repeated on every access for the same reason cc-switch's is:
 * an upgrade can replace the binary while the bot keeps running.
 */
export function resolveMagpieBin(
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
  const local = join(projectDir, "bin", "magpie")
  if (isExecutable(local)) return local
  return resolveOnPath("magpie", env)
}

function defaultRunner(bin: string, cwd: string, env: NodeJS.ProcessEnv): MagpieRunner {
  return (args, { timeoutMs }) =>
    new Promise<MagpieRunResult>((resolvePromise, reject) => {
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
            finish(() => reject(new MagpieError(`magpie 输出超过 ${Math.round(MAX_OUTPUT / 1024 / 1024)}MB 上限，已中止。`)))
            return
          }
          finish(() => reject(new MagpieError(`无法执行 magpie：${(error as Error).message}`)))
        },
      )
      // A CLI that ignores SIGTERM would leave this promise pending forever; escalate.
      timer = setTimeout(() => {
        child.kill("SIGTERM")
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        }, KILL_ESCALATION_MS)
        escalate.unref()
        finish(() => reject(new MagpieError(`magpie 执行超时（${Math.round(timeoutMs / 1000)} 秒）。`)))
      }, timeoutMs)
    })
}

function errorDetail(result: MagpieRunResult): string {
  const stderr = redactSecrets(stripAnsi(result.stderr)).trim()
  const stdout = redactSecrets(stripAnsi(result.stdout)).trim()
  const detail = stderr || stdout || `退出码 ${result.code}`
  return detail.length > 1200 ? `${clip(detail, 1200)}…` : detail
}

function clean(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, "\n").trim()
}

/** The one-line, redacted form of any magpie failure for a chat/API response. */
export function magpieErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(stripAnsi(raw)).trim() || "magpie 操作失败"
}

function assertToken(value: string, label: string, max = MAX_ID_LENGTH): string {
  const trimmed = value.trim()
  if (!trimmed) throw new MagpieError(`${label}不能为空。`)
  if (trimmed.length > max) throw new MagpieError(`${label}过长（上限 ${max} 字）。`)
  if (CONTROL_CHARS.test(trimmed)) throw new MagpieError(`${label}不能包含控制字符。`)
  return trimmed
}

/** Provider/agent/group ids are handed to magpie as one argv word, so keep them boring. */
export function assertMagpieId(value: string, label = "ID"): string {
  const trimmed = assertToken(value, label)
  if (trimmed.startsWith("-")) throw new MagpieError(`${label}不能以 - 开头。`)
  if (!/^[\w.:@+/-]+$/.test(trimmed)) {
    throw new MagpieError(`${label}只能包含字母、数字与 _ . : @ + / -。`)
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new MagpieError(`${label}不能包含 . 或 .. 路径段。`)
  }
  return trimmed
}

/** A provider preset id (deepseek, openai, kimi…). */
export function assertPreset(value: string): string {
  const trimmed = assertToken(value, "Provider 预设").toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    throw new MagpieError(`Provider 预设名称不合法：${trimmed}`)
  }
  return trimmed
}

/** An agent word magpie's CLI accepts (claude, codex, gemini, opencode, …). */
export function assertAgent(value: string): string {
  const trimmed = assertToken(value, "Agent").toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(trimmed)) throw new MagpieError(`Agent 名称不合法：${trimmed}`)
  return trimmed
}

/** A model reference such as `deepseek/deepseek-chat`; magpie also accepts bare ids. */
export function assertModelRef(value: string): string {
  const trimmed = assertToken(value, "模型", 200)
  if (/\s/.test(trimmed)) throw new MagpieError("模型引用不能包含空格（provider/model）。")
  if (trimmed.startsWith("-")) throw new MagpieError("模型引用不能以 - 开头。")
  return trimmed
}

/**
 * The magpie CLI, wrapped once so Telegram and the HTTP API share the same argv
 * validation, timeouts and redaction. Nothing here opens a UI or a foreground
 * server; those words are rejected by ./magpieGuards.ts before they reach it.
 */
export class MagpieService {
  readonly #projectDir: string
  readonly #env: NodeJS.ProcessEnv
  readonly #timeoutMs: number
  readonly #longTimeoutMs: number
  readonly #gatewayUrl: string
  readonly #runnerOverride?: MagpieRunner
  #explicitBin?: string

  constructor(options: MagpieOptions = {}) {
    this.#projectDir = options.projectDir ?? process.cwd()
    // magpie is a third-party binary whose argv can come from chat input; it gets the
    // same scrubbed environment as the agent CLIs (no bot token, no provider secrets).
    this.#env = childEnv(options.env ?? process.env)
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#longTimeoutMs = options.longTimeoutMs ?? MAGPIE_LONG_TIMEOUT_MS
    this.#gatewayUrl = (options.gatewayUrl ?? MAGPIE_DEFAULT_URL).replace(/\/+$/, "")
    this.#runnerOverride = options.runner
    this.#explicitBin = options.bin
  }

  get gatewayUrl(): string {
    return this.#gatewayUrl
  }

  get bin(): string | undefined {
    if (this.#runnerOverride) return this.#explicitBin ?? "magpie (runner)"
    return resolveMagpieBin(this.#explicitBin, this.#projectDir, this.#env)
  }

  get available(): boolean {
    return this.bin !== undefined
  }

  #ensureBin(): string {
    const bin = this.bin
    if (!bin) {
      throw new MagpieError(
        "未找到 magpie 可执行文件。安装：curl -fsSL https://usemagpie.ai/install.sh | sh，或设置 MAGPIE_BIN。",
      )
    }
    return bin
  }

  async run(args: string[], timeoutMs = this.#timeoutMs): Promise<MagpieRunResult> {
    const bin = this.#ensureBin()
    const runner =
      this.#runnerOverride ?? defaultRunner(bin, this.#projectDir, { ...this.#env, NO_COLOR: "1", CLICOLOR: "0" })
    const result = await runner(args, { timeoutMs })
    if (result.code !== 0) throw new MagpieRunError(errorDetail(result))
    return result
  }

  /** Runs a command and returns its cleaned, redacted stdout (or stderr when stdout is empty). */
  async text(args: string[], timeoutMs = this.#timeoutMs): Promise<string> {
    const result = await this.run(args, timeoutMs)
    return clean(result.stdout || result.stderr)
  }

  async version(): Promise<string | undefined> {
    try {
      const out = await this.text(["--version"], HEALTH_TIMEOUT_MS)
      const match = /magpie\s+([^\s]+)/i.exec(out)
      return (match?.[1] ?? out.split("\n")[0])?.trim() || undefined
    } catch {
      return undefined
    }
  }

  /** `magpie healthcheck` exits 0 only when the local gateway answers. */
  async healthy(): Promise<boolean> {
    try {
      await this.run(["healthcheck"], HEALTH_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  async overview(): Promise<MagpieOverview> {
    const bin = this.bin
    if (!bin) {
      return { available: false, gatewayUrl: this.#gatewayUrl, healthy: false }
    }
    let error: string | undefined
    let version: string | undefined
    try {
      version = await this.version()
    } catch (err) {
      error = redactSecrets(err instanceof Error ? err.message : String(err))
    }
    return {
      available: true,
      bin,
      version,
      gatewayUrl: this.#gatewayUrl,
      healthy: await this.healthy(),
      ...(error ? { error } : {}),
    }
  }

  // ---- read-only views -------------------------------------------------------

  listDetectedAgents(): Promise<string> {
    return this.text(["ls"])
  }

  listSupportedAgents(): Promise<string> {
    return this.text(["agents"])
  }

  listProviders(): Promise<string> {
    return this.text(["providers"])
  }

  listPresets(): Promise<string> {
    return this.text(["presets"])
  }

  listModels(agent?: string): Promise<string> {
    return agent ? this.text(["models", assertAgent(agent)]) : this.text(["models"])
  }

  listGroups(): Promise<string> {
    return this.text(["groups"])
  }

  quota(provider?: string): Promise<string> {
    return provider
      ? this.text(["quota", assertMagpieId(provider, "Provider")], this.#longTimeoutMs)
      : this.text(["quota"], this.#longTimeoutMs)
  }

  usage(range?: string): Promise<string> {
    const allowed = new Set(["today", "7d", "30d", "all"])
    const value = range?.trim().toLowerCase()
    return value && allowed.has(value)
      ? this.text(["usage", value], this.#longTimeoutMs)
      : this.text(["usage"], this.#longTimeoutMs)
  }

  listSettings(): Promise<string> {
    return this.text(["settings", "list"])
  }

  daemonStatus(): Promise<string> {
    return this.text(["daemon", "status"])
  }

  listSessions(): Promise<string> {
    return this.text(["sessions"], this.#longTimeoutMs)
  }

  listAccounts(): Promise<string> {
    return this.text(["accounts"], this.#longTimeoutMs)
  }

  showAgent(agent: string): Promise<string> {
    return this.text([assertAgent(agent)])
  }

  // ---- writes ----------------------------------------------------------------

  /** `magpie <agent> <model>` — the one place every agent's model is picked. */
  async setAgentModel(agent: string, model: string): Promise<string> {
    const result = await this.run([assertAgent(agent), assertModelRef(model)], this.#longTimeoutMs)
    return clean(result.stdout || result.stderr)
  }

  async addProvider(preset: string, key: string): Promise<string> {
    // The key is the one argument a chat must never see echoed back.
    const result = await this.run(["provider", "add", assertPreset(preset), assertToken(key, "API Key", 500)])
    return redactSecrets(clean(result.stdout || result.stderr))
  }

  async providerAction(action: "test" | "models" | "rm", id: string): Promise<string> {
    const result = await this.run(["provider", action, assertMagpieId(id, "Provider")], this.#longTimeoutMs)
    return redactSecrets(clean(result.stdout || result.stderr))
  }

  async addGroup(name: string, pairs: string[]): Promise<string> {
    const safeName = assertMagpieId(name, "路由组名称")
    if (pairs.length === 0) throw new MagpieError("路由组至少需要一个 key=value，例如 models=a/b,c/d。")
    for (const pair of pairs) {
      if (!/^[a-z][a-z0-9_-]*=[^\s]+$/i.test(pair)) {
        throw new MagpieError(`无法解析路由组参数 ${pair}，请按 key=value 书写。`)
      }
    }
    const result = await this.run(["group", "add", safeName, ...pairs], this.#longTimeoutMs)
    return clean(result.stdout || result.stderr)
  }

  removeGroup(id: string): Promise<string> {
    return this.text(["group", "rm", assertMagpieId(id, "路由组")], this.#longTimeoutMs)
  }

  sync(): Promise<string> {
    return this.text(["sync"], this.#longTimeoutMs)
  }

  updateCheck(): Promise<string> {
    return this.text(["update", "check"], MAGPIE_UPDATE_TIMEOUT_MS)
  }

  update(): Promise<string> {
    return this.text(["update"], MAGPIE_UPDATE_TIMEOUT_MS)
  }

  daemon(action: "start" | "stop" | "restart"): Promise<string> {
    return this.text(["daemon", action], action === "start" ? this.#longTimeoutMs : this.#timeoutMs)
  }

  async runRaw(args: string[]): Promise<string> {
    if (args.length === 0) throw new MagpieError("缺少 magpie 参数。")
    const result = await this.run(args, this.#longTimeoutMs)
    return redactSecrets(clean(result.stdout || result.stderr))
  }
}
