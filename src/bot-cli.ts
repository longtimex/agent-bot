import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { whichSync } from "./agentCli.js"
import { isSafeDataRoot, removeManaged, removeUnit, writeManagedFile } from "./lifecycle-files.js"
import { parseLifecycleOptions, type LifecycleOptions } from "./lifecycle-options.js"
import { createLogger } from "./logger.js"
import { OpsService } from "./ops.js"
import { parseSetupToolMode, setupFromCli } from "./setup.js"
import {
  checkHealth,
  isAlive,
  loadRuntimeEnv,
  localOpencodeTarget,
  opencodeHealthy,
  projectEnv,
  readInstallManifest,
  readPackageVersion,
  readRuntimeState,
  runtimePaths,
  startOpencode,
  stopBot,
  stopOpencode,
  tailFile,
  writeInstallManifest,
  type InstallManifest,
  type RuntimeState,
  type Supervisor,
} from "./runtime.js"
import { restartSystemdRelease } from "./release-restart.js"

const USAGE = `Agent Bot lifecycle

Usage:
  npm run bot -- <command> [options]
  agent-bot <command> [options]

Commands:
  install            install dependencies, build, and write the install manifest
  setup              configure control clients and optional tools
  doctor             read-only environment, config, process and health checks
  status             show the selected entry, supervisor and process state
  logs [bot|opencode] [lines]
                     print the tail of a log (default: bot, 100 lines)
  run                run the current release in the foreground
  start              start OpenCode and the Bot under the selected supervisor
  stop               stop the Bot and a Bot-managed OpenCode
  restart            stop, activate a pending release, then start and verify
  update             build a pending release through the existing release gate
  uninstall          stop services and remove Bot-managed launcher/unit files
  opencode <cmd>     start|stop|status|restart a Bot-managed OpenCode

Options:
  --systemd          install/use system units (requires sudo)
  --user-systemd     install/use a systemd --user unit
  --docker           select the Docker supervisor
  --no-opencode      do not start a Bot-managed OpenCode
  --skip-deps        install: reuse existing node_modules
  --skip-build       install: reuse an existing dist/ build
  --keep-data        uninstall: keep data/ and .env (default)
  --purge-data       uninstall: delete data/ and .env after the confirmation
  --yes              uninstall: skip the interactive confirmation
  --dry-run          install/uninstall: print actions without changing anything
  --apply            update: activate and restart after a successful build
  --help             show this help
`


type Options = LifecycleOptions

function printState(state: RuntimeState): void {
  const manifest = readInstallManifest(state.paths.projectDir)
  console.log(`project    ${state.paths.projectDir}`)
  console.log(`data       ${state.paths.dataDir}`)
  console.log(`supervisor ${manifest?.supervisor ?? state.supervisor}`)
  console.log(`entry      ${state.entry ?? "(not built)"}`)
  console.log(`release    ${state.releaseId}`)
  console.log(`bot        ${state.bot ? `running (PID ${state.bot.pid})` : "stopped"}`)
  console.log(`opencode   ${state.opencode ? `running (PID ${state.opencode.pid})` : "not managed"}`)
  console.log(`log        ${state.paths.logPath}`)
}

function status(): number {
  const state = readRuntimeState()
  printState(state)
  if (state.startup) {
    const suffix = state.startup.failure ? ` failed: ${state.startup.failure}` : ""
    console.log(`startup    ${state.startup.at}${suffix}`)
  }
  return 0
}

function doctor(): number {
  const state = readRuntimeState()
  const env = projectEnv(state.paths.projectDir)
  const manifest = readInstallManifest(state.paths.projectDir)
  const supervisor = selectedSupervisor(state, {
    systemd: false,
    userSystemd: false,
    docker: false,
    setup: false,
    skipDeps: false,
    skipBuild: false,
    opencode: true,
    requireOpencode: false,
    keepData: true,
    purgeData: false,
    yes: false,
    dryRun: false,
    apply: false,
  })
  let failed = 0
  const check = (label: string, ok: boolean, detail: string): void => {
    if (!ok) failed += 1
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`)
  }
  check("project", existsSync(join(state.paths.projectDir, "package.json")), state.paths.projectDir)
  check("node", Boolean(whichSync("node", env.PATH)), process.version)
  check("npm", Boolean(whichSync("npm", env.PATH)), whichSync("npm", env.PATH) ?? "not found")
  check("git", Boolean(whichSync("git", env.PATH)), whichSync("git", env.PATH) ?? "not found")
  check("dotenv", existsSync(state.paths.envPath), state.paths.envPath)
  check("entry", state.entrySource !== "missing", state.entry ?? "run: npm run build")
  const processManaged = supervisor !== "systemd" || manifest?.supervisor === "systemd"
  check(
    "bot process",
    processManaged,
    state.bot ? `PID ${state.bot.pid}` : supervisor === "systemd" ? "managed by systemd" : "bot is stopped",
  )
  const opencode = whichSync("opencode", env.PATH)
  check("opencode CLI", Boolean(opencode), opencode ?? "not found")
  const health = state.bot
    ? checkHealth(state.paths, {
        expectedRelease: state.releaseId,
        expectedPid: state.bot.pid,
      })
    : supervisor === "systemd"
      ? checkHealth(state.paths, { expectedRelease: state.releaseId })
      : { ok: false, stdout: "", stderr: "bot is stopped" }
  check("readiness", health.ok, (health.stdout || health.stderr).trim())
  if (state.startup?.failure) check("startup", false, state.startup.failure)
  if (manifest) {
    check("install manifest", true, `${manifest.supervisor} ${manifest.installedAt}`)
    for (const unit of [manifest.unitPath, manifest.opencodeUnitPath]) {
      if (unit) check("unit", existsSync(unit), unit)
    }
  } else {
    console.log("info install manifest: absent (plain checkout)")
  }
  return failed === 0 ? 0 : 1
}

function logs(args: string[]): number {
  const state = readRuntimeState()
  const source = args[0] === "opencode" ? "opencode" : "bot"
  const requested = Number(args[1] ?? 100)
  const lines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 2_000) : 100
  const result = tailFile(source === "opencode" ? state.paths.opencodeLogPath : state.paths.logPath, lines)
  if (result.missing) {
    console.error(`log not found: ${result.path}`)
    return 1
  }
  process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`)
  return 0
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function runNpm(projectDir: string, args: string[]): boolean {
  const npm = whichSync("npm") ?? "npm"
  return spawnSync(npm, args, { cwd: projectDir, env: projectEnv(projectDir), stdio: "inherit" }).status === 0
}

function ensureOpencode(projectDir: string): void {
  if (whichSync("opencode")) {
    console.log(`opencode CLI: ${whichSync("opencode")}`)
    return
  }
  console.log("Installing the opencode CLI…")
  const npm = whichSync("npm") ?? "npm"
  const result = spawnSync(npm, ["install", "-g", "opencode-ai", "--no-audit", "--no-fund"], {
    cwd: projectDir,
    env: projectEnv(projectDir),
    stdio: "inherit",
  })
  if (result.status !== 0) {
    console.error("Could not install opencode-ai globally; run: sudo npm install -g opencode-ai")
  }
}

function renderBotUnit(projectDir: string, user: string | undefined, userScope: boolean): string {
  const userLine = userScope || !user ? "" : `User=${user}\n`
  const paths = runtimePaths(projectDir, projectEnv(projectDir))
  return `# managed by agent-bot
[Unit]
Description=Agent Bot (Telegram / Feishu / Android)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=${projectDir}
Environment=NODE_ENV=production
Environment=AGENT_BOT_HOME=${projectDir}
Environment=AGENT_BOT_SUPERVISOR=systemd
Environment=BOT_LOG_FILE=${paths.logPath}
EnvironmentFile=${join(projectDir, ".env")}
ExecStart=${process.execPath} ${join(projectDir, "dist", "bot-cli.js")} run
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${userScope ? "default.target" : "multi-user.target"}
`
}

function renderOpencodeUnit(projectDir: string, user: string | undefined, userScope: boolean): string | undefined {
  const bin = whichSync("opencode")
  if (!bin) return undefined
  const target = localOpencodeTarget(projectEnv(projectDir))
  if (!target) return undefined
  const userLine = userScope || !user ? "" : `User=${user}\n`
  return `# managed by agent-bot
[Unit]
Description=OpenCode server for Agent Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=${projectDir}
EnvironmentFile=${join(projectDir, ".env")}
ExecStart=${bin} serve --port ${target.port} --hostname ${target.host}
Restart=always
RestartSec=3

[Install]
WantedBy=${userScope ? "default.target" : "multi-user.target"}
`
}

function installLauncher(projectDir: string): string | undefined {
  const env = projectEnv(projectDir)
  if (env.AGENT_BOT_NO_LAUNCHER === "1") return undefined
  const path = resolve(env.AGENT_BOT_LAUNCHER ?? join(homedir(), ".local", "bin", "agent-bot"))
  if (existsSync(path) && !readFileSync(path, "utf8").includes("managed by agent-bot")) {
    console.error(`launcher already exists and is not managed by agent-bot: ${path}`)
    return undefined
  }
  writeManagedFile(
    path,
    `#!/bin/sh\n# managed by agent-bot\nif [ ! -f ${shellQuote(join(projectDir, "dist", "bot-cli.js"))} ]; then\n  echo "agent-bot: run npm run bot -- install in ${projectDir} first" >&2\n  exit 1\nfi\nexec ${shellQuote(process.execPath)} ${shellQuote(join(projectDir, "dist", "bot-cli.js"))} "$@"\n`,
    0o755,
  )
  return path
}

function installFile(source: string, destination: string, userScope: boolean): boolean {
  const root = process.getuid?.() === 0
  const command = userScope || root ? "install" : "sudo"
  const args =
    command === "sudo"
      ? ["-n", "install", "-m", "0644", source, destination]
      : ["-m", "0644", source, destination]
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) {
    console.error(`could not install ${destination}; generated copy: ${source}`)
    console.error(`${result.stderr ?? ""}`.trim())
    return false
  }
  return true
}

function installSystemd(
  projectDir: string,
  userScope: boolean,
  startOpencode: boolean,
): Partial<InstallManifest> | undefined {
  const user = process.env.SUDO_USER ?? process.env.USER
  const unit = "agent-bot.service"
  const opencodeUnit = "agent-bot-opencode.service"
  const base = userScope ? join(homedir(), ".config", "systemd", "user") : "/etc/systemd/system"
  const unitPath = join(base, unit)
  const opencodeUnitPath = join(base, opencodeUnit)
  const generated = join(projectDir, "deploy", "generated")
  const botContent = renderBotUnit(projectDir, user, userScope)
  const opencodeContent = startOpencode ? renderOpencodeUnit(projectDir, user, userScope) : undefined
  writeManagedFile(join(generated, unit), botContent, 0o644)
  if (opencodeContent) writeManagedFile(join(generated, opencodeUnit), opencodeContent, 0o644)
  if (!installFile(join(generated, unit), unitPath, userScope)) return undefined
  if (opencodeContent && !installFile(join(generated, opencodeUnit), opencodeUnitPath, userScope)) return undefined
  const reload = systemctl(["daemon-reload"], userScope)
  if (!reload.ok) {
    console.error(`could not reload systemd: ${reload.output}`)
    return undefined
  }
  const enabled = systemctl(["enable", unit], userScope)
  if (!enabled.ok) console.error(`could not enable ${unit}: ${enabled.output}`)
  if (opencodeContent) {
    const enabledOpencode = systemctl(["enable", opencodeUnit], userScope)
    if (!enabledOpencode.ok) {
      console.error(`could not enable ${opencodeUnit}: ${enabledOpencode.output}`)
    }
  }
  return {
    unitPath,
    unitName: unit,
    ...(opencodeContent ? { opencodeUnitPath, opencodeUnitName: opencodeUnit } : {}),
    systemdScope: userScope ? "user" : "system",
  }
}

async function install(options: Options, args: string[], projectDir = process.cwd()): Promise<number> {
  loadRuntimeEnv(projectDir)
  if (!existsSync(join(projectDir, "package.json"))) {
    console.error(`not an agent-bot checkout: ${projectDir}`)
    return 1
  }
  if (options.dryRun) {
    console.log(`would install dependencies${options.skipDeps ? " (skipped)" : ""} and build${options.skipBuild ? " (skipped)" : ""} in ${projectDir}`)
    if (options.systemd || options.userSystemd) console.log("would generate and install systemd units")
    if (options.skipBuild && !existsSync(join(projectDir, "dist", "bot-cli.js"))) {
      console.error("--skip-build requires an existing dist/bot-cli.js")
      return 1
    }
    return 0
  }
  if (!options.skipDeps) {
    console.log("Installing dependencies…")
    if (!runNpm(projectDir, ["ci", "--no-audit", "--no-fund"])) {
      console.error("npm ci failed")
      return 1
    }
  }
  if (!options.skipBuild) {
    console.log("Building…")
    if (!runNpm(projectDir, ["run", "build"])) {
      console.error("npm run build failed")
      return 1
    }
  }
  if (!existsSync(join(projectDir, "dist", "bot-cli.js"))) {
    console.error("the build did not produce dist/bot-cli.js; run npm run build")
    return 1
  }
  if (options.opencode) ensureOpencode(projectDir)
  if (!existsSync(join(projectDir, ".env"))) {
    const example = join(projectDir, ".env.example")
    if (existsSync(example)) {
      copyFileSync(example, join(projectDir, ".env"))
      chmodSync(join(projectDir, ".env"), 0o600)
      console.log("Created .env from .env.example (mode 600).")
    }
  }
  const launcher = installLauncher(projectDir)
  const previous = readInstallManifest(projectDir)
  const unitInfo =
    options.systemd || options.userSystemd
      ? installSystemd(projectDir, options.userSystemd, options.opencode)
      : undefined
  if ((options.systemd || options.userSystemd) && !unitInfo) return 1
  const supervisor: Supervisor = options.docker ? "docker" : unitInfo ? "systemd" : "script"
  const manifest: InstallManifest = {
    version: 1,
    projectDir,
    supervisor,
    installedAt: new Date().toISOString(),
    ...(launcher ? { launcher } : {}),
    ...unitInfo,
  }
  const manifestPath = writeInstallManifest(projectDir, manifest)
  console.log(`Installed ${readPackageVersion(projectDir)} in ${projectDir}`)
  console.log(`manifest: ${manifestPath}`)
  if (launcher) console.log(`launcher: ${launcher}`)
  if (unitInfo?.unitPath) console.log(`unit: ${unitInfo.unitPath}`)
  if (previous?.supervisor === "systemd" && (!unitInfo || !options.opencode)) {
    const previousUserScope = previous.systemdScope === "user"
    const staleBotUnit = !unitInfo || previous.unitPath !== unitInfo.unitPath ? previous.unitPath : undefined
    const staleOpencodeUnit = !unitInfo || !options.opencode ? previous.opencodeUnitPath : undefined
    if (staleOpencodeUnit && previous.opencodeUnitName) {
      systemctl(["disable", "--now", previous.opencodeUnitName], previousUserScope)
    }
    if (staleBotUnit && previous.unitName) {
      systemctl(["disable", "--now", previous.unitName], previousUserScope)
    }
    let removed = false
    if (staleOpencodeUnit) removed = removeUnit(staleOpencodeUnit, previousUserScope, false) || removed
    if (staleBotUnit) removed = removeUnit(staleBotUnit, previousUserScope, false) || removed
    if (removed) systemctl(["daemon-reload"], previousUserScope)
  }
  if (options.setup) return setup(args)
  console.log("Next: npm run bot -- setup, then npm run bot -- start")
  return 0
}

async function setup(args: string[] = []): Promise<number> {
  const result = await setupFromCli({ tools: parseSetupToolMode(args) })
  return result.ok || result.reason === "cancelled" ? 0 : 1
}

function selectedSupervisor(state: RuntimeState, options: Options): Supervisor {
  if (options.docker) return "docker"
  if (options.systemd || options.userSystemd) return "systemd"
  // A managed install records its supervisor in data/install.json. Prefer that
  // over runtime detection so `npm run bot -- status` also works from a plain
  // terminal after `install --systemd`, where INVOCATION_ID is absent.
  const manifest = readInstallManifest(state.paths.projectDir)
  if (manifest?.supervisor) return manifest.supervisor
  return state.supervisor
}

function unitNames(manifest: InstallManifest | undefined): { bot: string; opencode?: string } {
  return {
    bot: manifest?.unitName ?? "agent-bot.service",
    ...(manifest?.opencodeUnitName ? { opencode: manifest.opencodeUnitName } : {}),
  }
}

function systemctl(args: string[], userScope: boolean): { ok: boolean; output: string } {
  const root = process.getuid?.() === 0
  const command = userScope || root ? "systemctl" : "sudo"
  const finalArgs = userScope
    ? ["--user", ...args]
    : command === "sudo"
      ? ["-n", "systemctl", ...args]
      : args
  const result = spawnSync(command, finalArgs, { encoding: "utf8" })
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() }
}

function startSystemd(state: RuntimeState, options: Options): number {
  void options
  const manifest = readInstallManifest(state.paths.projectDir)
  if (!manifest) {
    console.error("systemd supervisor selected, but no install manifest; run npm run bot -- install --systemd")
    return 1
  }
  const userScope = manifest.systemdScope === "user"
  const units = unitNames(manifest)
  if (units.opencode) systemctl(["start", units.opencode], userScope)
  const result = systemctl(["start", units.bot], userScope)
  if (!result.ok) {
    console.error(`could not start ${units.bot}: ${result.output}`)
    return 1
  }
  console.log(`started ${units.bot}${userScope ? " (user scope)" : ""}`)
  return 0
}

async function start(options: Options): Promise<number> {
  const state = readRuntimeState()
  const supervisor = selectedSupervisor(state, options)
  if (supervisor === "docker") {
    console.error("Docker supervisor: run `docker compose up -d --build` on the host.")
    return 1
  }
  if (supervisor === "systemd") return startSystemd(state, options)
  return startScript(state, options)
}

async function stop(options: Options): Promise<number> {
  const state = readRuntimeState()
  const manifest = readInstallManifest(state.paths.projectDir)
  const supervisor = selectedSupervisor(state, options)
  if (supervisor === "docker") {
    console.error("Docker supervisor: run `docker compose down` on the host.")
    return 1
  }
  if (supervisor === "systemd") {
    if (!manifest) {
      console.error("systemd supervisor selected, but no install manifest; refusing to stop an unowned unit.")
      return 1
    }
    const userScope = manifest.systemdScope === "user"
    const units = unitNames(manifest)
    let ok = true
    if (units.opencode) {
      const result = systemctl(["stop", units.opencode], userScope)
      if (!result.ok && !/not loaded|not found/i.test(result.output)) ok = false
    }
    const result = systemctl(["stop", units.bot], userScope)
    if (!result.ok) {
      console.error(`could not stop ${units.bot}: ${result.output}`)
      ok = false
    }
    return ok ? 0 : 1
  }
  console.log(await stopBot(state.paths))
  console.log(await stopOpencode(state.paths))
  return 0
}

async function restartSystemd(state: RuntimeState, options: Options): Promise<number> {
  void options
  return restartSystemdRelease(state, { systemctl, unitNames })
}

async function restart(options: Options): Promise<number> {
  const state = readRuntimeState()
  const supervisor = selectedSupervisor(state, options)
  if (supervisor === "docker") {
    console.error("Docker supervisor: rebuild and restart the container on the host.")
    return 1
  }
  if (supervisor === "systemd") return restartSystemd(state, options)
  const { releaseManager, recordReleaseRollback, recordReleaseSuccess } = await import("./release-restart.js")
  const releases = releaseManager(state.paths.projectDir, state.paths.dataDir)
  const pending = releases.readState().pending
  if (pending) {
    const activated = releases.activatePending()
    if (!activated.ok) {
      console.error(activated.message)
      return 1
    }
    console.log(activated.message)
  }
  console.log(await stopBot(state.paths))
  console.log(await stopOpencode(state.paths))
  const code = await startScript(readRuntimeState(), options)
  if (code === 0) {
    if (pending) recordReleaseSuccess(releases, "新版本已通过健康检查。")
    return 0
  }
  if (!pending) return code
  const rollback = releases.rollback()
  if (!rollback.ok) {
    console.error(`启动失败，且无法回滚：${rollback.message}`)
    return code
  }
  recordReleaseRollback(releases, pending, rollback.release, rollback.message)
  console.error(`启动失败，已回滚：${rollback.message}`)
  const restored = await startScript(readRuntimeState(), options)
  return restored === 0 ? 1 : code
}

async function update(options: Options): Promise<number> {
  const state = readRuntimeState()
  const env = projectEnv(state.paths.projectDir)
  const logger = createLogger((env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info")
  const ops = new OpsService(
    {
      projectDir: state.paths.projectDir,
      dataDir: state.paths.dataDir,
      opencodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:4096",
      logPath: state.paths.logPath,
      envPath: state.paths.envPath,
      health: () => opencodeHealthy(env),
      systemd: selectedSupervisor(state, options) === "systemd",
    },
    logger,
  )
  const result = await ops.updateProject()
  console.log(result.message)
  for (const step of result.steps) {
    console.log(`${step.ok ? "ok  " : "FAIL"} ${step.label}`)
    if (!step.ok && step.output) console.log(step.output)
  }
  if (!result.ok) return 1
  if (options.apply) return restart(options)
  console.log("Run `npm run bot -- restart` to activate the pending release.")
  return 0
}

async function opencodeCommand(args: string[], options: Options): Promise<number> {
  void options
  const state = readRuntimeState()
  const env = projectEnv(state.paths.projectDir)
  const command = args[0] ?? "status"
  if (command === "status") {
    const healthy = await opencodeHealthy(env)
    console.log(`opencode ${healthy ? "healthy" : "unavailable"}${state.opencode ? ` (PID ${state.opencode.pid})` : ""}`)
    return healthy ? 0 : 1
  }
  if (command === "start") {
    const result = await startOpencode(state.paths, env)
    console.log(result.message)
    return result.ok ? 0 : 1
  }
  if (command === "stop") {
    console.log(await stopOpencode(state.paths))
    return 0
  }
  if (command === "restart") {
    console.log(await stopOpencode(state.paths))
    const result = await startOpencode(state.paths, env)
    console.log(result.message)
    return result.ok ? 0 : 1
  }
  console.error(`unknown opencode command: ${command}`)
  return 1
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question).then((answer) => {
    rl.close()
    return /^y(es)?$/i.test(answer.trim())
  })
}

async function uninstall(options: Options, projectDir = process.cwd()): Promise<number> {
  const state = readRuntimeState(projectDir)
  const manifest = readInstallManifest(projectDir)
  if (options.purgeData && !isSafeDataRoot(state.paths.dataDir, state.paths.projectDir)) {
    console.error(`refusing to purge an unsafe data directory: ${state.paths.dataDir}`)
    return 1
  }
  // A unit can remain after a previous install manifest was overwritten by a
  // script-mode install. Stop it when the manifest still owns it; otherwise fall
  // back to the PID/health identity used by script mode.
  const stopCommands = manifest?.supervisor === "systemd"
    ? () => {
        const userScope = manifest.systemdScope === "user"
        let ok = true
        for (const unit of [manifest.opencodeUnitName, manifest.unitName].filter(
          (value): value is string => Boolean(value),
        )) {
          const disabled = systemctl(["disable", "--now", unit], userScope)
          if (!disabled.ok && !/not loaded|not found|No such file/i.test(disabled.output)) {
            console.error(`could not disable ${unit}: ${disabled.output}`)
            ok = false
          }
        }
        return ok
      }
    : manifest?.supervisor === "docker"
      ? () => {
          console.log("Docker supervisor: run `docker compose down` on the host to stop the container.")
          return true
        }
      : async () => {
          if (!state.bot && !state.opencode) return true
          console.log(await stopBot(state.paths))
          console.log(await stopOpencode(state.paths))
          return true
        }
  if (!options.yes && !options.dryRun) {
    const scope = options.purgeData
      ? "停止服务、删除 launcher/unit 以及 data/ 和 .env"
      : "停止服务并删除 launcher/unit，保留 data/ 和 .env"
    const ok = await confirm(`将${scope}。继续？[y/N] `)
    if (!ok) {
      console.error("uninstall cancelled; pass --yes for non-interactive use")
      return 1
    }
  }
  if (options.dryRun) {
    if (manifest?.supervisor === "systemd") {
      const userScope = manifest.systemdScope === "user"
      for (const unit of [manifest.opencodeUnitName, manifest.unitName].filter(
        (value): value is string => Boolean(value),
      )) {
        console.log(`would disable and stop unit: ${unit}${userScope ? " (user scope)" : ""}`)
      }
    } else if (manifest?.supervisor === "docker") {
      console.log("would leave Docker to `docker compose down` on the host")
    } else if (state.bot || state.opencode) {
      console.log("would stop the Bot and a Bot-managed OpenCode")
    }
    if (manifest?.launcher) removeManaged(manifest.launcher, "launcher", true)
    if (manifest?.unitPath) removeUnit(manifest.unitPath, manifest.systemdScope === "user", true)
    if (manifest?.opencodeUnitPath) {
      removeUnit(manifest.opencodeUnitPath, manifest.systemdScope === "user", true)
    }
    if (options.purgeData) {
      console.log(`would remove data: ${state.paths.dataDir}`)
      console.log(`would remove .env: ${state.paths.envPath}`)
    } else {
      console.log(`would keep data: ${state.paths.dataDir}`)
      console.log(`would keep .env: ${state.paths.envPath}`)
    }
    return 0
  }
  if (!(await stopCommands())) return 1
  let ok = true
  if (manifest?.launcher) ok = removeManaged(manifest.launcher, "launcher", options.dryRun) && ok
  if (manifest?.unitPath) ok = removeUnit(manifest.unitPath, manifest.systemdScope === "user", options.dryRun) && ok
  if (manifest?.opencodeUnitPath) {
    ok = removeUnit(manifest.opencodeUnitPath, manifest.systemdScope === "user", options.dryRun) && ok
  }
  if (manifest?.supervisor === "systemd" && !options.dryRun) {
    systemctl(["daemon-reload"], manifest.systemdScope === "user")
  }
  if (options.purgeData) {
    for (const [path, label] of [
      [state.paths.dataDir, "data"],
      [state.paths.envPath, ".env"],
    ] as const) {
      if (options.dryRun) {
        console.log(`would remove ${label}: ${path}`)
      } else {
        try {
          rmSync(path, { recursive: true, force: true })
          console.log(`removed ${label}: ${path}`)
        } catch (err) {
          console.error(`could not remove ${label} ${path}: ${err instanceof Error ? err.message : String(err)}`)
          ok = false
        }
      }
    }
  } else if (!options.dryRun) {
    for (const path of [state.paths.pidPath, state.paths.lockPath, state.paths.opencodePidPath]) {
      rmSync(path, { force: true })
    }
  }
  if (manifest && !options.dryRun) rmSync(join(state.paths.dataDir, "install.json"), { force: true })
  if (ok) console.log("uninstall complete; the repository itself was left in place.")
  return ok ? 0 : 1
}

async function runForeground(): Promise<number> {
  const state = readRuntimeState()
  if (!state.entry) {
    console.error("no usable entry; run npm run build first")
    return 1
  }
  const env = { ...projectEnv(state.paths.projectDir), BOT_LOG_FILE: state.paths.logPath }
  const child = spawn(process.execPath, [state.entry], { cwd: state.paths.projectDir, env, stdio: "inherit" })
  const forward = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
  const onSigterm = (): void => forward("SIGTERM")
  const onSigint = (): void => forward("SIGINT")
  process.once("SIGTERM", onSigterm)
  process.once("SIGINT", onSigint)
  return await new Promise<number>((resolvePromise) => {
    child.once("error", (err) => {
      console.error(err.message)
      resolvePromise(1)
    })
    child.once("close", (code) => {
      process.removeListener("SIGTERM", onSigterm)
      process.removeListener("SIGINT", onSigint)
      resolvePromise(code ?? 1)
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitForHealth(state: RuntimeState, pid: number, startedAt: string): Promise<boolean> {
  const timeoutMs = Number(process.env.RELEASE_HEALTH_TIMEOUT ?? "45") * 1_000
  const intervalMs = Number(process.env.RELEASE_HEALTH_INTERVAL ?? "1") * 1_000
  const deadline = Date.now() + Math.max(1_000, timeoutMs)
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return false
    if (
      checkHealth(state.paths, {
        expectedRelease: state.releaseId,
        expectedPid: pid,
        startedAt,
      }).ok
    ) {
      return true
    }
    await wait(Math.max(100, intervalMs))
  }
  return false
}

async function startManagedOpencode(state: RuntimeState, options: Options): Promise<boolean> {
  const env = projectEnv(state.paths.projectDir)
  if (!options.opencode || !localOpencodeTarget(env)) return true
  const result = await startOpencode(state.paths, env)
  if (result.ok) {
    console.log(result.message)
    return true
  }
  console.error(`OpenCode: ${result.message}`)
  return !options.requireOpencode
}

async function startScript(state: RuntimeState, options: Options): Promise<number> {
  if (state.bot) {
    console.log(`Bot 已在运行（PID ${state.bot.pid}）；如需重启请使用 npm run bot -- restart。`)
    return 0
  }
  if (!state.entry) {
    console.error("no usable entry; run npm run bot -- install or npm run build first")
    return 1
  }
  if (!(await startManagedOpencode(state, options))) return 1
  mkdirSync(state.paths.dataDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const logFd = openSync(state.paths.logPath, "a", 0o600)
  try {
    const child = spawn(process.execPath, [state.entry], {
      cwd: state.paths.projectDir,
      env: { ...projectEnv(state.paths.projectDir), BOT_LOG_FILE: state.paths.logPath },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    })
    child.unref()
    if (!child.pid) {
      console.error("Bot 启动失败：没有返回 PID。")
      return 1
    }
    writeFileSync(state.paths.pidPath, `${child.pid}\n`, { mode: 0o600 })
    console.log(`Bot 已启动（PID ${child.pid}），等待本次启动自检…`)
    if (await waitForHealth(state, child.pid, startedAt)) {
      console.log("Bot readiness check passed.")
      return 0
    }
    console.error(`Bot 未通过启动检查；日志：${state.paths.logPath}`)
    const recent = tailFile(state.paths.logPath, 20)
    if (!recent.missing) process.stderr.write(`${recent.text}\n`)
    await stopBot(state.paths)
    return 1
  } finally {
    closeSync(logFd)
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, args, options } = parseLifecycleOptions(argv)
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE)
    return 0
  }
  if (options.systemd && options.userSystemd) {
    console.error("--systemd and --user-systemd are mutually exclusive")
    return 1
  }
  if (options.docker && (options.systemd || options.userSystemd)) {
    console.error("--docker cannot be combined with --systemd or --user-systemd")
    return 1
  }
  if (options.purgeData && command !== "uninstall") {
    console.error("--purge-data is only valid with uninstall")
    return 1
  }
  if (command === "status") return status()
  if (command === "doctor") return doctor()
  if (command === "logs") return logs(args)
  if (command === "run") return runForeground()
  if (command === "opencode") return opencodeCommand(args, options)
  if (command === "install") return install(options, args)
  if (command === "setup") return setup(args)
  if (command === "start") return start(options)
  if (command === "stop") return stop(options)
  if (command === "restart") return restart(options)
  if (command === "update") return update(options)
  if (command === "uninstall") return uninstall(options)
  console.error(`unknown command: ${command}\n\n${USAGE}`)
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code
  })
}

export { main }
