import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import { parseEnv } from "node:util"
import { AgentCliRegistry } from "./agentCli.js"
import { AgentCliInstaller } from "./agentInstaller.js"
import { installerChildEnv } from "./binPath.js"
import { resolveCcSwitchBin } from "./ccswitch.js"
import { resolveMagpieBin } from "./magpie.js"
import type { Logger } from "./logger.js"

const CC_SWITCH_SCRIPT = "scripts/install-cc-switch.sh"
const COMMAND_TIMEOUT_MS = 10 * 60_000
const MAGPIE_INSTALLER = "https://usemagpie.ai/install.sh"

export type ToolId = "magpie" | "cc-switch" | string

export interface ToolInstallResult {
  ok: boolean
  message: string
}

export interface ExternalCommandOptions {
  /** Extra variables for this command; they deliberately bypass the credential scrubber. */
  env?: NodeJS.ProcessEnv
}

export interface ToolWizardDeps {
  projectDir: string
  env: NodeJS.ProcessEnv
  ask: (question: string) => Promise<string>
  print: (line?: string) => void
  installAgent: (id: string) => Promise<ToolInstallResult>
  installCommand: (id: string) => ToolInstallResult & { command?: string }
  runExternal: (command: string, args: string[], options?: ExternalCommandOptions) => Promise<ToolInstallResult>
  detect: () => Promise<DetectedTools>
  isInteractive: boolean
  yes: boolean
  /** `false` only in explicit detection mode; the default wizard installs after confirmation. */
  allowExternal: boolean
}

export interface DetectedAgent {
  id: string
  label: string
  bin?: string
  installable: boolean
}

export interface DetectedTools {
  agents: DetectedAgent[]
  magpie?: string
  ccSwitch?: string
}

export interface ToolWizardOptions {
  projectDir?: string
  env?: NodeJS.ProcessEnv
  yes?: boolean
  interactive?: boolean
  /** Replace the detection scan, e.g. to reuse a scan the caller already made. */
  detected?: DetectedTools
  logger?: Logger
  allowExternal?: boolean
  deps?: Partial<ToolWizardDeps>
}

export interface ToolWizardResult {
  ok: boolean
  detected: DetectedTools
  installed: ToolId[]
  failed: ToolId[]
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function formatPath(path: string | undefined): string {
  return path ? `已安装（${path}）` : "未安装"
}

/** Read `.env` the same way the Bot does, without overriding an explicitly supplied environment. */
function loadProjectEnv(projectDir: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  try {
    const parsed = parseEnv(readFileSync(join(projectDir, ".env"), "utf8"))
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value
    }
  } catch {
    // .env is optional; detection still works from the current environment
  }
  return env
}

function projectPath(projectDir: string, value: string | undefined, fallback: string): string {
  return resolve(projectDir, value?.trim() || fallback)
}

export function buildToolDeps(options: ToolWizardOptions = {}): ToolWizardDeps {
  const projectDir = resolve(options.projectDir ?? process.cwd())
  const env = options.env ?? loadProjectEnv(projectDir, process.env)
  const logger = options.logger ?? silentLogger
  const dataDir = projectPath(projectDir, env.DATA_DIR, "data")
  const registry = new AgentCliRegistry({
    path: projectPath(projectDir, env.AGENT_CLI_CONFIG, join(dataDir, "agents.json")),
    log: logger,
  })
  const installer = new AgentCliInstaller(
    join(dataDir, "agent-cli-installs.json"),
    registry,
    logger,
    { proxyEnv: () => installerChildEnv(env) as Record<string, string> },
  )
  const installAgent = async (id: string): Promise<ToolInstallResult> => {
    const result = await installer.install(id)
    return { ok: result.ok, message: result.message }
  }
  const installCommand = (id: string) => {
    const profile = registry.get(id)
    if (!profile) return { ok: false, message: `未知 Agent：${id}` }
    const command = installer.installCommand(profile)
    return command
      ? { ok: true, message: `安装 ${profile.label}`, command }
      : { ok: false, message: `${profile.label} 没有自动安装方式` }
  }
  const runExternal = (
    command: string,
    args: string[],
    commandOptions: ExternalCommandOptions = {},
  ): Promise<ToolInstallResult> => {
    return new Promise((resolveResult) => {
      let settled = false
      let stderr = ""
      let stdout = ""
      const child = spawn(command, args, {
        cwd: projectDir,
        env: installerChildEnv({ ...env, ...commandOptions.env }) as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const finish = (result: ToolInstallResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveResult(result)
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        finish({ ok: false, message: `${command} 安装超时` })
      }, COMMAND_TIMEOUT_MS)
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      child.on("error", (error) => finish({ ok: false, message: `${command} 无法执行：${error.message}` }))
      child.on("close", (code) => {
        const output = `${stdout}\n${stderr}`.trim()
        finish({ ok: code === 0, message: code === 0 ? "安装完成" : output || `退出码 ${code ?? "null"}` })
      })
    })
  }
  const detect = async (): Promise<DetectedTools> => ({
    agents: registry.list().map((profile) => ({
      id: profile.id,
      label: profile.label,
      bin: registry.binPath(profile),
      installable: Boolean(profile.installSpec),
    })),
    magpie: resolveMagpieBin(env.MAGPIE_BIN, projectDir, env),
    ccSwitch: resolveCcSwitchBin(env.CC_SWITCH_BIN, projectDir, env),
  })

  return {
    projectDir,
    env,
    ask: async () => "",
    print: () => {},
    installAgent,
    installCommand,
    runExternal,
    detect,
    isInteractive: false,
    yes: false,
    allowExternal: true,
  }
}

function printDetection(deps: ToolWizardDeps, detected: DetectedTools): void {
  deps.print("")
  deps.print("🔎 检测已有工具")
  const installed = detected.agents.filter((agent) => agent.bin)
  const missing = detected.agents.filter((agent) => !agent.bin && agent.installable)
  if (installed.length > 0) {
    for (const agent of installed) deps.print(`  ✅ ${agent.label}：${agent.bin}`)
  } else {
    deps.print("  Agent CLI：未检测到")
  }
  if (missing.length > 0) deps.print(`  可安装：${missing.map((agent) => agent.label).join("、")}`)
  deps.print(`  magpie：${formatPath(detected.magpie)}`)
  deps.print(`  cc-switch：${formatPath(detected.ccSwitch)}`)
}

interface InstallChoice {
  id: ToolId
  label: string
  kind: "agent" | "magpie" | "cc-switch"
  agent?: DetectedAgent
}

function printInstallMenu(deps: ToolWizardDeps, choices: InstallChoice[]): void {
  deps.print("")
  deps.print("🧰 可安装的工具（可多选，例如 1,3；a 全选；直接回车跳过）")
  choices.forEach((choice, index) => {
    deps.print(`  ${index + 1}. ${choice.label}`)
  })
}

function parseSelection(raw: string, count: number): number[] {
  const value = raw.trim().toLowerCase()
  if (!value) return []
  if (["a", "all", "*", "全部"].includes(value)) return Array.from({ length: count }, (_, index) => index + 1)
  const selected = new Set<number>()
  for (const part of value.split(/[\s,，;；]+/)) {
    if (!/^\d+$/.test(part)) continue
    const index = Number(part)
    if (index >= 1 && index <= count) selected.add(index)
  }
  return [...selected].sort((a, b) => a - b)
}

async function installAgentChoice(deps: ToolWizardDeps, agent: DetectedAgent): Promise<boolean> {
  const command = deps.installCommand(agent.id)
  if (command.command) deps.print(`\n▶ 安装 ${agent.label}：${command.command}`)
  const result = await deps.installAgent(agent.id)
  if (result.ok) {
    deps.print(`✅ ${agent.label}：${result.message}`)
    return true
  }
  deps.print(`❌ ${agent.label}：${result.message}`)
  return false
}

async function installMagpie(deps: ToolWizardDeps): Promise<boolean> {
  deps.print(`\n▶ 安装 magpie：curl -fsSL ${MAGPIE_INSTALLER} | sh`)
  const installDir = join(deps.projectDir, "bin")
  const result = await deps.runExternal(
    "sh",
    ["-c", 'mkdir -p "$MAGPIE_BIN_DIR" && curl -fsSL "$MAGPIE_INSTALLER" | sh -s -- --tui'],
    { env: { MAGPIE_BIN_DIR: installDir, MAGPIE_INSTALLER } },
  )
  if (result.ok) {
    deps.print(`✅ magpie：${result.message}`)
    return true
  }
  deps.print(`❌ magpie：${result.message}`)
  deps.print(`  也可手动安装：curl -fsSL ${MAGPIE_INSTALLER} | sh，或设置 MAGPIE_BIN`)
  deps.print(`  本地查找位置：${join(deps.projectDir, "bin", "magpie")}`)
  return false
}

async function installCcSwitch(deps: ToolWizardDeps): Promise<boolean> {
  const script = join(deps.projectDir, CC_SWITCH_SCRIPT)
  if (!existsSync(script)) {
    deps.print(`❌ cc-switch：未找到安装脚本 ${script}`)
    return false
  }
  deps.print(`\n▶ 安装 cc-switch：bash ${CC_SWITCH_SCRIPT}`)
  const result = await deps.runExternal("bash", [script], {
    env: { CC_SWITCH_INSTALL_DIR: join(deps.projectDir, "bin") },
  })
  if (result.ok) {
    deps.print(`✅ cc-switch：${result.message}`)
    return true
  }
  deps.print(`❌ cc-switch：${result.message}`)
  return false
}

async function installChoice(deps: ToolWizardDeps, choice: InstallChoice): Promise<boolean> {
  if (choice.kind === "agent" && choice.agent) return installAgentChoice(deps, choice.agent)
  if (choice.kind === "magpie") return installMagpie(deps)
  return installCcSwitch(deps)
}

function missingChoices(detected: DetectedTools): InstallChoice[] {
  const choices: InstallChoice[] = detected.agents
    .filter((agent) => !agent.bin && agent.installable)
    .map((agent) => ({ id: agent.id, label: agent.label, kind: "agent", agent }))
  if (!detected.magpie) choices.push({ id: "magpie", label: "magpie 模型网关", kind: "magpie" })
  if (!detected.ccSwitch) choices.push({ id: "cc-switch", label: "cc-switch Provider 管理器", kind: "cc-switch" })
  return choices
}

export async function runToolWizard(options: ToolWizardOptions = {}): Promise<ToolWizardResult> {
  const defaults = buildToolDeps(options)
  const deps: ToolWizardDeps = {
    ...defaults,
    ...options.deps,
    isInteractive:
      options.interactive ?? options.deps?.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    yes: options.yes ?? options.deps?.yes ?? false,
    allowExternal: options.allowExternal ?? options.deps?.allowExternal ?? true,
  }
  const detected = options.detected ?? (await deps.detect())
  printDetection(deps, detected)
  const installed: ToolId[] = []
  const failed: ToolId[] = []
  const choices = missingChoices(detected)

  if (choices.length === 0) {
    deps.print("\n✅ 所有可管理的工具均已安装。")
    return { ok: true, detected, installed, failed }
  }
  if (!deps.allowExternal) return { ok: true, detected, installed, failed }

  let selected: InstallChoice[] = []
  if (deps.yes) {
    selected = choices
  } else if (deps.isInteractive) {
    printInstallMenu(deps, choices)
    const picked = parseSelection(await deps.ask("编号："), choices.length)
    selected = picked
      .map((index) => choices[index - 1])
      .filter((choice): choice is InstallChoice => Boolean(choice))
    if (selected.length === 0) deps.print("已跳过，未安装任何工具。")
  } else {
    deps.print("\n非交互式终端：仅执行检测。需要安装时运行 npm run setup:tools。")
  }

  for (const choice of selected) {
    if (await installChoice(deps, choice)) installed.push(choice.id)
    else failed.push(choice.id)
  }
  return { ok: failed.length === 0, detected, installed, failed }
}

export async function runToolWizardCli(): Promise<number> {
  const projectDir = resolve(process.cwd())
  const hasCurl = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0
  const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      [
        "Usage: npm run setup:tools -- [--check] [--yes]",
        "",
        "  --check  only detect installed Agent CLIs, magpie and cc-switch",
        "  --yes    install every missing item without asking (explicit automation only)",
        "",
        "Without flags, detection always runs and the installer asks what to install.",
      ].join("\n") + "\n",
    )
    return 0
  }
  const yes = process.argv.includes("--yes")
  const checkOnly = process.argv.includes("--check")
  if (!checkOnly && (!hasCurl || !hasBash)) {
    process.stderr.write("install-tools: magpie 与 cc-switch 的安装需要 curl 和 bash。\n")
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const result = await runToolWizard({
      projectDir,
      yes,
      interactive,
      allowExternal: !checkOnly,
      deps: {
        ask: (question) => rl.question(question),
        print: (line = "") => process.stdout.write(`${line}\n`),
      },
    })
    if (checkOnly) {
      process.stdout.write(`\n检测完成。缺失项可运行 npm run setup:tools 安装。\n`)
      return 0
    }
    process.stdout.write(`\n已安装：${result.installed.length ? result.installed.join("、") : "无"}\n`)
    if (result.failed.length > 0) process.stdout.write(`失败：${result.failed.join("、")}\n`)
    return result.ok ? 0 : 1
  } finally {
    rl.close()
  }
}
