import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import { installerChildEnv } from "./binPath.js"
import { redactSecrets, stripAnsi } from "./ccswitch.js"
import { readJsonObject } from "./jsonStore.js"
import { clipTail } from "./messages.js"
import { terminateProcess, whichSync, type AgentCliProfile, type AgentCliRegistry, type AgentInstallMethod } from "./agentCli.js"
import type { Logger } from "./logger.js"

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_CHARS = 200_000
const MAX_MESSAGE_OUTPUT = 900
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const PACKAGE_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
// A non-root service (systemd, container) usually cannot write npm's global prefix.
const PERMISSION_ERROR_RE = /EACCES|EPERM|permission denied|insufficient privilege|operation not permitted/i
const EXTERNALLY_MANAGED_RE = /externally-managed-environment|externally managed/i
// Only these retry flags may ever reach argv, including from the persisted install record
const EXTRA_ARG_RE = /^--(?:prefix=[/~][\w.@+:/ -]{1,200}|break-system-packages)$/

function sanitizeExtraArgs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const args = raw.filter((value): value is string => typeof value === "string" && EXTRA_ARG_RE.test(value))
  return args.length ? [...new Set(args)] : undefined
}

export interface ManagedAgent {
  engine: string
  method: AgentInstallMethod
  package: string
  bin: string
  installedAt: string
  /** Extra flags the install actually needed (unwritable npm prefix, externally managed Python). */
  extraArgs?: string[]
}

export interface AgentCommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

interface AgentRunner {
  path: string
  display: string
  args: string[]
}

export interface AgentActionResult {
  ok: boolean
  message: string
  output?: string
}

export interface AgentInstallerOptions {
  which?: (bin: string) => string | undefined
  run?: (command: string, args: string[], env: Record<string, string>) => Promise<AgentCommandResult>
  proxyEnv?: () => Record<string, string>
  timeoutMs?: number
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export class AgentCliInstaller {
  readonly #path: string
  readonly #registry: AgentCliRegistry
  readonly #log: Logger
  readonly #which: (bin: string) => string | undefined
  readonly #run: (command: string, args: string[], env: Record<string, string>) => Promise<AgentCommandResult>
  readonly #proxyEnv?: () => Record<string, string>
  readonly #timeoutMs: number
  #managed: Record<string, ManagedAgent> = {}
  #busy = false

  constructor(path: string, registry: AgentCliRegistry, log: Logger, options: AgentInstallerOptions = {}) {
    this.#path = path
    this.#registry = registry
    this.#log = log
    this.#which = options.which ?? ((bin) => whichSync(bin))
    this.#run = options.run ?? ((command, args, env) => this.#spawn(command, args, env))
    this.#proxyEnv = options.proxyEnv
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#load()
  }

  installable(): AgentCliProfile[] {
    return this.#registry.list().filter((profile) => profile.installSpec)
  }

  managed(): ManagedAgent[] {
    return Object.values(this.#managed).sort((a, b) => a.engine.localeCompare(b.engine))
  }

  isManaged(engine: string): boolean {
    // Own-property check: engine ids come from user input, and "constructor"
    // would otherwise read the inherited Object value and look "managed"
    return Object.hasOwn(this.#managed, engine)
  }

  installed(profile: AgentCliProfile): string | undefined {
    return this.#registry.binPath(profile)
  }

  /** The exact command shown to the user before installing. */
  installCommand(profile: AgentCliProfile): string | undefined {
    const spec = profile.installSpec
    if (!spec) return undefined
    return this.#commandFor(spec.method, spec.package)
  }

  #recordFor(engine: string): ManagedAgent | undefined {
    return Object.hasOwn(this.#managed, engine) ? this.#managed[engine] : undefined
  }

  /** The command used to upgrade a Bot-managed CLI in place. */
  updateCommand(engine: string): string | undefined {
    const record = this.#recordFor(engine)
    if (!record) return undefined
    return this.#commandFor(record.method, record.package, record.extraArgs)
  }

  uninstallCommand(engine: string): string | undefined {
    const record = this.#recordFor(engine)
    if (!record) return undefined
    if (record.method !== "npm") {
      const flag = record.extraArgs?.includes("--break-system-packages") ? " --break-system-packages" : ""
      return `${this.#pythonName()} -m pip uninstall -y${flag} ${record.package}`
    }
    const prefix = record.extraArgs?.find((arg) => arg.startsWith("--prefix="))
    return `npm uninstall -g${prefix ? ` ${prefix}` : ""} ${record.package}`
  }

  #commandFor(method: AgentInstallMethod, pkg: string, extraArgs?: string[]): string {
    const flags = extraArgs?.length ? ` ${extraArgs.join(" ")}` : ""
    return method === "npm"
      ? `npm install -g${flags} ${pkg}`
      : `${this.#pythonName()} -m pip install --user${flags} ${pkg}`
  }

  #pythonName(): string {
    return this.#which("python3") ? "python3" : "python"
  }

  /**
   * Runs an install or upgrade, retrying once with the fallback flags an
   * unwritable npm prefix or a PEP 668 externally managed Python requires, and
   * reports the flags that were actually used so the caller can persist them for
   * the later update and uninstall commands.
   */
  async #runWithFallback(
    method: AgentInstallMethod,
    pkg: string,
    runner: AgentRunner,
    extraArgs: string[] | undefined,
  ): Promise<{ result: AgentCommandResult; runner: AgentRunner; extraArgs: string[] | undefined }> {
    const result = await this.#run(runner.path, runner.args, this.#env())
    if (result.code === 0) return { result, runner, extraArgs }
    const retryArgs = this.#fallbackArgs(method, `${result.stdout}\n${result.stderr}`, extraArgs)
    if (!retryArgs) return { result, runner, extraArgs }
    const fallback = this.#runnerFor(method, pkg, false, retryArgs)
    if (!fallback) return { result, runner, extraArgs }
    this.#log.info(`agent CLI ${pkg}: retrying with ${retryArgs.join(" ")}`)
    if (method === "npm") mkdirSync(join(homedir(), ".npm-global"), { recursive: true })
    const retry = await this.#run(fallback.path, fallback.args, this.#env())
    return { result: retry, runner: fallback, extraArgs: retryArgs }
  }

  /**
   * The flag list a retry needs, or undefined when the failure is unrelated to the
   * install location. A previous custom `--prefix` is replaced rather than doubled:
   * npm would otherwise resolve two competing prefixes.
   */
  #fallbackArgs(
    method: AgentInstallMethod,
    raw: string,
    current: string[] | undefined,
  ): string[] | undefined {
    const have = current ?? []
    if (method === "npm" && PERMISSION_ERROR_RE.test(raw)) {
      const prefix = `--prefix=${join(homedir(), ".npm-global")}`
      return have.includes(prefix) ? undefined : [...have.filter((arg) => !arg.startsWith("--prefix=")), prefix]
    }
    if (method === "pip" && EXTERNALLY_MANAGED_RE.test(raw)) {
      return have.includes("--break-system-packages") ? undefined : [...have, "--break-system-packages"]
    }
    return undefined
  }

  async install(engine: string): Promise<AgentActionResult> {
    const profile = this.#registry.get(engine)
    if (!profile) return { ok: false, message: `未知的 Agent 引擎：${engine}` }
    const spec = profile.installSpec
    if (!spec) {
      const hint = profile.install ? `\n请手动安装：${profile.install}` : "\n该 CLI 没有可自动执行的安装方式。"
      return { ok: false, message: `${profile.label} 暂不支持在 Telegram 内自动安装。${hint}` }
    }
    const existing = this.#registry.binPath(profile)
    if (existing) {
      return { ok: false, message: `已检测到 ${profile.label}：${existing}\n如需更新请手动执行 \`${this.installCommand(profile)}\`.` }
    }
    if (this.#busy) return { ok: false, message: "已有安装或卸载任务正在进行，请稍后再试。" }

    const runner = this.#runnerFor(spec.method, spec.package, false)
    if (!runner) {
      return {
        ok: false,
        message:
          spec.method === "npm"
            ? "未找到 npm，请先安装 Node.js / npm。"
            : "未找到 python3 / python，请先安装 Python 3。",
      }
    }

    this.#busy = true
    this.#log.info(`installing agent CLI ${profile.id} via ${spec.method}: ${runner.display} ${runner.args.join(" ")}`)
    try {
      const ran = await this.#runWithFallback(spec.method, spec.package, runner, undefined)
      const { result, extraArgs } = ran
      const output = this.#formatOutput(result)
      if (result.code !== 0) {
        const reason = result.timedOut ? "安装超时" : `安装命令退出码 ${result.code ?? "null"}`
        return { ok: false, message: `${profile.label} ${reason}。`, output }
      }

      this.#registry.reload(true)
      const bin = this.#registry.binPath(profile)
      this.#managed[profile.id] = {
        engine: profile.id,
        method: spec.method,
        package: spec.package,
        bin: bin ?? profile.bin,
        installedAt: new Date().toISOString(),
        ...(extraArgs ? { extraArgs } : {}),
      }
      this.#save()
      const note = extraArgs
        ? `\n提示：默认安装位置不可用，已使用 \`${extraArgs.join(" ")}\` 完成安装。`
        : ""
      return {
        ok: true,
        message: bin
          ? `已安装 ${profile.label}（${bin}）。发送 \`/agent ${profile.id}\` 切换使用。${note}`
          : `安装命令执行成功，但未在 PATH 中检测到 \`${profile.bin}\`。请检查 npm/pip 的全局 bin 目录是否在 PATH 中。${note}`,
        output,
      }
    } finally {
      this.#busy = false
    }
  }

  async update(engine: string): Promise<AgentActionResult> {
    const record = this.#recordFor(engine)
    if (!record) {
      return {
        ok: false,
        message: "只能更新由 Bot 通过 `/agents install` 安装的 CLI；其他方式安装的版本请手动升级。",
      }
    }
    if (this.#busy) return { ok: false, message: "已有安装或卸载任务正在进行，请稍后再试。" }

    const runner = this.#runnerFor(record.method, record.package, false, record.extraArgs)
    if (!runner) {
      return {
        ok: false,
        message: record.method === "npm" ? "未找到 npm，无法更新。" : "未找到 python3 / python，无法更新。",
      }
    }

    const profile = this.#registry.get(engine)
    const label = profile?.label ?? engine
    this.#busy = true
    this.#log.info(`updating agent CLI ${engine} via ${record.method}: ${runner.display} ${runner.args.join(" ")}`)
    try {
      const ran = await this.#runWithFallback(record.method, record.package, runner, record.extraArgs)
      const result = ran.result
      const output = this.#formatOutput(result)
      if (result.code !== 0) {
        const reason = result.timedOut ? "更新超时" : `更新命令退出码 ${result.code ?? "null"}`
        return { ok: false, message: `${label} ${reason}。`, output }
      }

      this.#registry.reload(true)
      const bin = profile ? this.#registry.binPath(profile) : undefined
      // A fallback that kicked in here must also apply to the next update and to uninstall
      const widened = ran.extraArgs?.join(" ") !== record.extraArgs?.join(" ")
      this.#managed[engine] = {
        ...record,
        bin: bin ?? record.bin,
        installedAt: new Date().toISOString(),
        ...(ran.extraArgs ? { extraArgs: ran.extraArgs } : {}),
      }
      this.#save()
      return {
        ok: true,
        message:
          (bin
            ? `已更新 ${label}（${bin}）。`
            : `更新命令执行成功，但未在 PATH 中检测到 \`${record.bin}\`。请检查 npm/pip 的全局 bin 目录是否在 PATH 中。`) +
          (widened && ran.extraArgs
            ? `\n提示：默认安装位置不可用，已改用 \`${ran.extraArgs.join(" ")}\` 完成更新，后续更新与卸载沿用该位置。`
            : ""),
        output,
      }
    } finally {
      this.#busy = false
    }
  }

  async uninstall(engine: string): Promise<AgentActionResult> {
    const record = this.#recordFor(engine)
    if (!record) {
      return {
        ok: false,
        message: "只能卸载由 Bot 通过 `/agent install` 安装的 CLI；系统预装或其他方式安装的版本请手动管理。",
      }
    }
    if (this.#busy) return { ok: false, message: "已有安装或卸载任务正在进行，请稍后再试。" }

    const runner = this.#runnerFor(record.method, record.package, true, record.extraArgs)
    if (!runner) {
      return {
        ok: false,
        message:
          record.method === "npm"
            ? "未找到 npm，无法卸载。"
            : "未找到 python3 / python，无法卸载。",
      }
    }

    this.#busy = true
    this.#log.info(`uninstalling agent CLI ${engine} via ${record.method}: ${runner.display} ${runner.args.join(" ")}`)
    try {
      const result = await this.#run(runner.path, runner.args, this.#env())
      const output = this.#formatOutput(result)
      if (result.code !== 0) {
        const reason = result.timedOut ? "卸载超时" : `卸载命令退出码 ${result.code ?? "null"}`
        return { ok: false, message: `卸载 ${engine} ${reason}。`, output }
      }

      delete this.#managed[engine]
      this.#save()
      this.#registry.reload(true)
      const profile = this.#registry.get(engine)
      const still = profile ? this.#registry.binPath(profile) : undefined
      return {
        ok: true,
        message: still
          ? `已执行卸载，但仍在 \`${still}\` 检测到可执行文件，可能是其他方式安装的版本。`
          : `已卸载 ${profile?.label ?? engine}。`,
        output,
      }
    } finally {
      this.#busy = false
    }
  }

  #runnerFor(
    method: AgentInstallMethod,
    pkg: string,
    uninstall: boolean,
    extraArgs?: string[],
  ): AgentRunner | undefined {
    if (!PACKAGE_RE.test(pkg)) return undefined
    const flags = extraArgs?.length ? [...extraArgs] : []
    if (method === "npm") {
      const path = this.#which("npm")
      if (!path) return undefined
      return {
        path,
        display: "npm",
        args: [uninstall ? "uninstall" : "install", "-g", ...flags, pkg],
      }
    }
    const path = this.#which("python3") ?? this.#which("python")
    if (!path) return undefined
    // PEP 668 blocks `pip uninstall` as well, so the flag that allowed the install
    // must be repeated here; `--prefix` is npm-only and never valid for pip
    const pipFlags = flags.filter((arg) => arg === "--break-system-packages")
    return {
      path,
      display: path.includes("python3") ? "python3" : "python",
      args: uninstall
        ? ["-m", "pip", "uninstall", "-y", ...pipFlags, pkg]
        : ["-m", "pip", "install", "--user", ...flags, pkg],
    }
  }

  #env(): Record<string, string> {
    return installerChildEnv({ ...process.env, ...this.#proxyEnv?.() }) as Record<string, string>
  }

  #formatOutput(result: AgentCommandResult): string | undefined {
    const output = stripAnsi(redactSecrets(`${result.stdout}\n${result.stderr}`)).trim()
    if (!output) return undefined
    return clipTail(output, MAX_MESSAGE_OUTPUT)
  }

  #spawn(command: string, args: string[], env: Record<string, string>): Promise<AgentCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      let timedOut = false
      // Installing is long-running and pipes are never read again once we resolve, so
      // the endpoints must be released explicitly or the child keeps them open.
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve({ code, stdout, stderr, timedOut })
      }
      const timer = setTimeout(() => {
        timedOut = true
        this.#terminate(child)
        finish(null)
      }, this.#timeoutMs)

      // A multi-byte sequence split across chunks must not decode into U+FFFD, which
      // would corrupt the Chinese text the installer echoes.
      const out = new StringDecoder("utf8")
      const err = new StringDecoder("utf8")
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = clipTail(stdout + out.write(chunk), MAX_OUTPUT_CHARS)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = clipTail(stderr + err.write(chunk), MAX_OUTPUT_CHARS)
      })
      child.on("close", (code) => finish(code))
      child.on("error", (error) => {
        stderr = clipTail(`${stderr}\n${error.message}`, MAX_OUTPUT_CHARS)
        finish(null)
      })
    })
  }

  #terminate(child: ChildProcess): void {
    terminateProcess(child)
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message))
    if (!parsed) return
    for (const [engine, raw] of Object.entries(parsed)) {
      const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
      if (!record) continue
      const method = record.method
      if (method !== "npm" && method !== "pip") continue
      const pkg = asString(record.package)
      const bin = asString(record.bin)
      const installedAt = asString(record.installedAt)
      if (!ENGINE_ID_RE.test(engine) || !pkg || !PACKAGE_RE.test(pkg) || !bin || !installedAt) continue
      const extraArgs = sanitizeExtraArgs(record.extraArgs)
      this.#managed[engine] = extraArgs
        ? { engine, method, package: pkg, bin, installedAt, extraArgs }
        : { engine, method, package: pkg, bin, installedAt }
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.tmp`
      writeFileSync(temp, `${JSON.stringify(this.#managed, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn(`failed to save ${this.#path}:`, (err as Error).message)
    }
  }
}
