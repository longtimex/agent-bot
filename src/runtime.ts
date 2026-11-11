import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"
import { parseEnv } from "node:util"
import { whichSync } from "./agentCli.js"
import { loadDotEnvFile } from "./config.js"
import { ReleaseManager } from "./releaseManager.js"
import { readStartupSelfCheck, type StartupSelfCheck } from "./startupSelfCheck.js"

export type Supervisor = "script" | "systemd" | "docker"

export interface RuntimePaths {
  projectDir: string
  dataDir: string
  envPath: string
  logPath: string
  opencodeLogPath: string
  pidPath: string
  lockPath: string
  opencodePidPath: string
  startupPath: string
}

export interface ProcessIdentity {
  pid: number
  startTime?: string
}

export interface RuntimeState {
  paths: RuntimePaths
  supervisor: Supervisor
  bot?: ProcessIdentity
  opencode?: ProcessIdentity
  entry?: string
  releaseId: string
  entrySource: "release" | "checkout" | "missing"
  startup?: StartupSelfCheck
}

export interface HealthResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface HealthOptions {
  expectedRelease?: string
  expectedPid?: number
  startedAt?: string
  timeoutMs?: number
}

export interface InstallManifest {
  version: 1
  projectDir: string
  launcher?: string
  unitPath?: string
  unitName?: string
  opencodeUnitPath?: string
  opencodeUnitName?: string
  systemdScope?: "system" | "user"
  supervisor: Supervisor
  installedAt: string
}

const MANIFEST = "install.json"
const BOT_ENTRY = "dist/index.js"
const OPENCODE_START_WAIT_MS = 8_000

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Linux start time (field 22 of /proc/<pid>/stat) detects a recycled PID. */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const close = stat.lastIndexOf(")")
    if (close < 0) return undefined
    return stat.slice(close + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return undefined
  const startTime = processStartTime(pid)
  return { pid, ...(startTime ? { startTime } : {}) }
}

/** Read the lock format written by acquireLock: `<pid> <start-time>`. */
export function readLockIdentity(path: string): ProcessIdentity | undefined {
  try {
    const [rawPid, storedStart] = readFileSync(path, "utf8").trim().split(/\s+/, 2)
    const pid = Number(rawPid)
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return undefined
    const currentStart = processStartTime(pid)
    if (storedStart && currentStart && storedStart !== currentStart) return undefined
    return { pid, ...(currentStart ? { startTime: currentStart } : {}) }
  } catch {
    return undefined
  }
}

function commandLine(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim()
  } catch {
    return undefined
  }
}

function isBotCommand(pid: number): boolean {
  const command = commandLine(pid)
  return Boolean(command && (command.includes(BOT_ENTRY) || command.includes("src/index.ts")))
}

function isOpencodeCommand(pid: number): boolean {
  const command = commandLine(pid)
  return Boolean(command && /\bopencode\b/.test(command) && /\bserve\b/.test(command))
}

function readPidIdentity(path: string, predicate: (pid: number) => boolean): ProcessIdentity | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim())
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid) || !predicate(pid)) return undefined
    const startTime = processStartTime(pid)
    return { pid, ...(startTime ? { startTime } : {}) }
  } catch {
    return undefined
  }
}

function removeStale(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

export function runtimePaths(projectDir = process.cwd(), env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const root = resolve(env.AGENT_BOT_HOME?.trim() || projectDir)
  const dataDir = resolve(root, env.DATA_DIR?.trim() || "data")
  return {
    projectDir: root,
    dataDir,
    envPath: join(root, ".env"),
    logPath: resolve(env.BOT_LOG_FILE?.trim() || join(dataDir, "bot.log")),
    opencodeLogPath: join(dataDir, "opencode.log"),
    pidPath: join(dataDir, "bot.pid"),
    lockPath: join(dataDir, "bot.lock"),
    opencodePidPath: join(dataDir, "opencode.pid"),
    startupPath: join(dataDir, "startup-check.json"),
  }
}

/**
 * Resolve `.env` without mutating the caller's environment. `base` keeps its explicit
 * overrides so `DATA_DIR=` can still be cleared on purpose, while an explicit project
 * a caller is inspecting stays anchored to that project's file instead of the Bot's
 * exported variables leaking into it.
 */
export function projectEnv(
  projectDir: string,
  base: NodeJS.ProcessEnv = process.env,
  options: { preferProject?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  try {
    const file = join(projectDir, ".env")
    if (existsSync(file)) {
      for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
        if (options.preferProject || env[key] === undefined) env[key] = value
      }
    }
  } catch {
    // The CLI still works with an explicitly supplied environment.
  }
  return env
}

/** Preserve the library entry point: load .env into process.env for in-process callers. */
export function loadRuntimeEnv(projectDir: string): NodeJS.ProcessEnv {
  if (projectDir === process.cwd()) {
    loadDotEnvFile()
    return process.env
  }
  return projectEnv(projectDir)
}

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  const explicit = env.AGENT_BOT_SUPERVISOR?.trim().toLowerCase()
  if (explicit === "systemd" || explicit === "docker" || explicit === "script") return explicit
  if (env.INVOCATION_ID || env.SYSTEMD_EXEC_PID) return "systemd"
  if (existsSync("/.dockerenv") || env.container === "docker") return "docker"
  return "script"
}

export function readInstallManifest(projectDir = process.cwd()): InstallManifest | undefined {
  let dataDir: string
  try {
    dataDir = runtimePaths(projectDir, projectEnv(projectDir, process.env, { preferProject: true })).dataDir
  } catch {
    dataDir = runtimePaths(projectDir).dataDir
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, MANIFEST), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const manifest = parsed as Partial<InstallManifest>
    if (manifest.version !== 1 || typeof manifest.projectDir !== "string") return undefined
    return manifest as InstallManifest
  } catch {
    return undefined
  }
}

export function writeInstallManifest(projectDir: string, manifest: InstallManifest): string {
  const dataDir = runtimePaths(projectDir, projectEnv(projectDir, process.env, { preferProject: true })).dataDir
  mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, MANIFEST)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
  return path
}

function currentEntry(paths: RuntimePaths): { entry?: string; source: RuntimeState["entrySource"] } {
  const releases = new ReleaseManager({
    projectDir: paths.projectDir,
    dataDir: paths.dataDir,
    run: async () => ({ code: 1, stdout: "", stderr: "runtime status does not build" }),
    which: whichSync,
  })
  const releaseEntry = releases.currentEntry()
  if (releaseEntry) return { entry: releaseEntry, source: "release" }
  const checkout = join(paths.projectDir, BOT_ENTRY)
  return existsSync(checkout) ? { entry: checkout, source: "checkout" } : { source: "missing" }
}

export function readRuntimeState(projectDir = process.cwd()): RuntimeState {
  const env = projectEnv(projectDir, process.env, { preferProject: true })
  const paths = runtimePaths(projectDir, env)
  const lock = readLockIdentity(paths.lockPath)
  const fromPid = lock ? undefined : readPidIdentity(paths.pidPath, isBotCommand)
  if (!lock && !fromPid) removeStale(paths.pidPath)
  const opencode = readPidIdentity(paths.opencodePidPath, isOpencodeCommand)
  if (!opencode) removeStale(paths.opencodePidPath)
  const current = currentEntry(paths)
  const startup = readStartupSelfCheck(paths.dataDir)
  const bot = lock ?? fromPid
  const releases = new ReleaseManager({
    projectDir: paths.projectDir,
    dataDir: paths.dataDir,
    run: async () => ({ code: 1, stdout: "", stderr: "runtime status does not build" }),
    which: (bin) => whichSync(bin, env.PATH),
  })
  const releaseId = releases.readState().current?.id ?? "checkout"
  return {
    paths,
    supervisor: detectSupervisor(env),
    ...(bot ? { bot } : {}),
    ...(opencode ? { opencode } : {}),
    ...(current.entry ? { entry: current.entry } : {}),
    releaseId,
    entrySource: current.source,
    ...(startup ? { startup } : {}),
  }
}

export function checkHealth(paths: RuntimePaths, options: HealthOptions = {}): HealthResult {
  const script = join(paths.projectDir, "scripts", "release-health.mjs")
  if (!existsSync(script)) return { ok: false, stdout: "", stderr: `health probe missing: ${script}` }
  const env: NodeJS.ProcessEnv = {
    ...projectEnv(paths.projectDir),
    DATA_DIR: paths.dataDir,
    ...(options.expectedRelease ? { RELEASE_EXPECTED_ID: options.expectedRelease } : {}),
    ...(options.expectedPid ? { RELEASE_EXPECTED_PID: String(options.expectedPid) } : {}),
    ...(options.startedAt ? { RELEASE_START_AT: options.startedAt } : {}),
  }
  return runHealthProbe(script, paths.projectDir, env, options.timeoutMs ?? 6_000)
}

function runHealthProbe(script: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): HealthResult {
  const result = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8", timeout: timeoutMs })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  return !isAlive(pid)
}

async function stopProcess(identity: ProcessIdentity | undefined, label: string, timeoutMs = 10_000): Promise<string> {
  if (!identity) return `${label}未运行。`
  try {
    process.kill(identity.pid, "SIGTERM")
  } catch {
    return `${label}（PID ${identity.pid}）已不存在。`
  }
  if (!(await waitForExit(identity.pid, timeoutMs))) {
    try {
      process.kill(identity.pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  return `${label}已停止（PID ${identity.pid}）。`
}

export async function stopBot(paths: RuntimePaths): Promise<string> {
  const lock = readLockIdentity(paths.lockPath)
  const pid = lock ?? readPidIdentity(paths.pidPath, isBotCommand)
  const result = await stopProcess(pid, "Bot ")
  removeStale(paths.pidPath)
  if (!readLockIdentity(paths.lockPath)) removeStale(paths.lockPath)
  return result
}

export async function stopOpencode(paths: RuntimePaths): Promise<string> {
  const identity = readPidIdentity(paths.opencodePidPath, isOpencodeCommand)
  const result = await stopProcess(identity, "OpenCode ")
  removeStale(paths.opencodePidPath)
  return result
}

export function localOpencodeTarget(env: NodeJS.ProcessEnv): { host: string; port: number } | undefined {
  try {
    const url = new URL(env.OPENCODE_URL ?? "http://127.0.0.1:4096")
    const host = url.hostname.replace(/^\[|\]$/g, "")
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return undefined
    return { host: host === "localhost" ? "127.0.0.1" : host, port: url.port ? Number(url.port) : 4096 }
  } catch {
    return undefined
  }
}

export async function opencodeHealthy(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const url = new URL("/global/health", env.OPENCODE_URL ?? "http://127.0.0.1:4096")
    const password = env.OPENCODE_SERVER_PASSWORD
    const headers = password
      ? {
          authorization: `Basic ${Buffer.from(
            `${env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`,
          ).toString("base64")}`,
        }
      : undefined
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return false
    }
    const body = (await res.json()) as { healthy?: boolean }
    return body.healthy === true
  } catch {
    return false
  }
}

export async function startOpencode(
  paths: RuntimePaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; message: string }> {
  if (await opencodeHealthy(env)) return { ok: true, message: "OpenCode 已在运行。" }
  const managed = readPidIdentity(paths.opencodePidPath, isOpencodeCommand)
  if (managed) {
    return {
      ok: false,
      message: `OpenCode 进程已在运行（PID ${managed.pid}），但健康检查未通过；请先停止或查看 ${paths.opencodeLogPath}。`,
    }
  }
  const target = localOpencodeTarget(env)
  if (!target) return { ok: false, message: "OPENCODE_URL 不是本机地址，无法在本机启动 OpenCode。" }
  const bin = whichSync(env.OPENCODE_BIN ?? "opencode")
  if (!bin) return { ok: false, message: "未找到 opencode CLI；请先安装 opencode-ai。" }
  mkdirSync(paths.dataDir, { recursive: true })
  const fd = openSync(paths.opencodeLogPath, "a", 0o600)
  try {
    const child = spawn(bin, ["serve", "--port", String(target.port), "--hostname", target.host], {
      cwd: paths.projectDir,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    })
    child.unref()
    if (!child.pid) return { ok: false, message: "OpenCode 启动失败：没有返回 PID。" }
    writeFileSync(paths.opencodePidPath, `${child.pid}\n`, { mode: 0o600 })
    const deadline = Date.now() + OPENCODE_START_WAIT_MS
    while (Date.now() < deadline) {
      if (await opencodeHealthy(env)) return { ok: true, message: `OpenCode 已启动（PID ${child.pid}）。` }
      if (!isAlive(child.pid)) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    }
    return { ok: false, message: `OpenCode 已启动（PID ${child.pid}），但健康检查未通过，请查看 ${paths.opencodeLogPath}。` }
  } finally {
    closeSync(fd)
  }
}

export function tailFile(path: string, lines = 100): { path: string; text: string; missing: boolean } {
  try {
    const content = readFileSync(path, "utf8")
    const all = content.split(/\r?\n/)
    return { path, text: all.slice(-Math.max(1, lines)).join("\n"), missing: false }
  } catch {
    return { path, text: "", missing: true }
  }
}

export function readPackageVersion(projectDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : "unknown"
  } catch {
    return "unknown"
  }
}

