import { whichSync } from "./agentCli.js"
import { ReleaseManager, type ReleaseRecord } from "./releaseManager.js"
import {
  checkHealth,
  readInstallManifest,
  readRuntimeState,
  type InstallManifest,
  type RuntimeState,
} from "./runtime.js"

interface SystemctlResult {
  ok: boolean
  output: string
}

export interface SystemdRestartDeps {
  systemctl: (args: string[], userScope: boolean) => SystemctlResult
  unitNames: (manifest: InstallManifest | undefined) => { bot: string; opencode?: string }
  readManifest?: (projectDir: string) => InstallManifest | undefined
  readState?: (projectDir: string) => RuntimeState
  probeHealth?: (state: RuntimeState) => boolean
  sleep?: (ms: number) => Promise<void>
  healthTimeoutMs?: number
  healthIntervalMs?: number
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function releaseManager(projectDir: string, dataDir: string): ReleaseManager {
  return new ReleaseManager({
    projectDir,
    dataDir,
    run: async () => ({ code: 1, stdout: "", stderr: "restart does not build" }),
    which: whichSync,
  })
}

export function recordReleaseSuccess(releases: ReleaseManager, message: string): void {
  const state = releases.readState()
  const current = state.current
  if (!current) return
  releases.recordUpdate(
    {
      fromCommit: current.previousCommit,
      toCommit: current.commit,
      toVersion: current.version,
      steps: [],
      apiReachable: true,
    },
    "ok",
    message,
  )
}

export function recordReleaseRollback(
  releases: ReleaseManager,
  failed: ReleaseRecord | undefined,
  restored: ReleaseRecord | undefined,
  message: string,
): void {
  releases.recordUpdate(
    {
      fromCommit: failed?.commit,
      toCommit: restored?.commit,
      fromVersion: failed?.version,
      toVersion: restored?.version,
      steps: [],
    },
    "rolled-back",
    message,
  )
}

/**
 * RELEASE_HEALTH_TIMEOUT / RELEASE_HEALTH_INTERVAL in seconds. Both callers used to multiply the
 * raw value: a typo such as `60s` or `1m` became NaN, the deadline NaN, the wait loop never ran,
 * and every update was rolled back as unhealthy with nothing saying why. An empty value meant a
 * 0–1s window, which rolls back a healthy release on any slow machine. Anything unusable now
 * falls back to the default instead.
 */
export function releaseHealthTiming(env: NodeJS.ProcessEnv = process.env): { timeoutMs: number; intervalMs: number } {
  const seconds = (raw: string | undefined, fallback: number, min: number): number => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isFinite(value) && value > 0 ? Math.max(min, value) : fallback
  }
  return {
    timeoutMs: seconds(env.RELEASE_HEALTH_TIMEOUT, 45, 5) * 1_000,
    intervalMs: seconds(env.RELEASE_HEALTH_INTERVAL, 1, 0.1) * 1_000,
  }
}

async function waitForServiceHealth(
  projectDir: string,
  startedAt: string,
  deps: SystemdRestartDeps,
): Promise<RuntimeState | undefined> {
  const timing = releaseHealthTiming()
  const timeoutMs = deps.healthTimeoutMs ?? timing.timeoutMs
  const intervalMs = deps.healthIntervalMs ?? timing.intervalMs
  const deadline = Date.now() + timeoutMs
  const sleep = deps.sleep ?? defaultSleep
  const readState = deps.readState ?? readRuntimeState
  const probeHealth =
    deps.probeHealth ??
    ((latest: RuntimeState): boolean =>
      Boolean(
        latest.bot &&
          checkHealth(latest.paths, {
            expectedRelease: latest.releaseId,
            expectedPid: latest.bot.pid,
            startedAt,
          }).ok,
      ))
  while (Date.now() < deadline) {
    const latest = readState(projectDir)
    if (probeHealth(latest)) return latest
    await sleep(intervalMs)
  }
  return undefined
}

function restartUnits(
  deps: SystemdRestartDeps,
  units: { bot: string; opencode?: string },
  userScope: boolean,
): boolean {
  if (units.opencode) deps.systemctl(["restart", units.opencode], userScope)
  const result = deps.systemctl(["restart", units.bot], userScope)
  if (!result.ok) console.error(`could not restart ${units.bot}: ${result.output}`)
  return result.ok
}

export async function restartSystemdRelease(state: RuntimeState, deps: SystemdRestartDeps): Promise<number> {
  const manifest = (deps.readManifest ?? readInstallManifest)(state.paths.projectDir)
  if (!manifest) {
    console.error("systemd supervisor selected, but no install manifest; run npm run bot -- install --systemd")
    return 1
  }
  const userScope = manifest.systemdScope === "user"
  const units = deps.unitNames(manifest)
  const releases = releaseManager(state.paths.projectDir, state.paths.dataDir)
  const pending = releases.readState().pending
  let activated: ReleaseRecord | undefined
  if (pending) {
    const result = releases.activatePending()
    if (!result.ok) {
      console.error(result.message)
      return 1
    }
    activated = result.release
    console.log(result.message)
  }
  const startedAt = new Date().toISOString()
  if (!restartUnits(deps, units, userScope)) {
    if (pending) {
      const rollback = releases.rollback()
      if (rollback.ok) restartUnits(deps, units, userScope)
    }
    return 1
  }
  const healthy = await waitForServiceHealth(state.paths.projectDir, startedAt, deps)
  if (healthy) {
    console.log("Bot readiness check passed.")
    if (pending) recordReleaseSuccess(releases, "新版本已通过健康检查。")
    return 0
  }
  console.error("systemd restart did not pass the readiness check; check journalctl/systemctl status.")
  if (!pending) return 1
  const rollback = releases.rollback()
  if (!rollback.ok) {
    console.error(`启动失败，且无法回滚：${rollback.message}`)
    return 1
  }
  recordReleaseRollback(releases, activated, rollback.release, rollback.message)
  console.error(`启动失败，已回滚：${rollback.message}`)
  if (!restartUnits(deps, units, userScope)) return 1
  // The update failed even if the rollback is healthy; report failure to the caller.
  await waitForServiceHealth(state.paths.projectDir, new Date().toISOString(), deps)
  return 1
}
