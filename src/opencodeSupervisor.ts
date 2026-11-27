import { existsSync } from "node:fs"
import type { Logger } from "./logger.js"
import {
  localOpencodeTarget,
  opencodeHealthy,
  readInstallManifest,
  startOpencode,
  stopOpencode,
  type RuntimePaths,
} from "./runtime.js"

/**
 * On-demand lifecycle for the local OpenCode server.
 *
 * The server used to be started at boot and left running, so a bot that mostly answers on
 * CLI engines kept a few hundred MB resident for nothing, and the ops panel showed a
 * permanent "not running" for an engine nobody used. Now the server is started by the first
 * task that needs it and stopped again once it has been idle for a while.
 *
 * Stopping is safe: OpenCode persists sessions on disk, so a chat keeps its context across a
 * restart (verified against 1.19.5). Only a server this process started is ever stopped —
 * one started by systemd or by hand is left alone.
 */

export interface OpencodeSupervisorOptions {
  paths: RuntimePaths
  env: NodeJS.ProcessEnv
  log: Logger
  onDemand: boolean
  idleStopMs: number
  tickMs?: number
  now?: () => number
  /** Test seams; production uses the real runtime helpers. */
  healthy?: () => Promise<boolean>
  start?: () => Promise<{ ok: boolean; message: string }>
  stop?: () => Promise<string>
  localTarget?: () => { host: string; port: number } | undefined
  unitManaged?: () => boolean
}

export class OpencodeSupervisor {
  readonly #log: Logger
  readonly #onDemand: boolean
  readonly #idleStopMs: number
  readonly #now: () => number
  readonly #healthyFn: () => Promise<boolean>
  readonly #startFn: () => Promise<{ ok: boolean; message: string }>
  readonly #stopFn: () => Promise<string>
  readonly #localTargetFn: () => { host: string; port: number } | undefined
  readonly #unitManagedFn: () => boolean
  #active = 0
  #lastUsed: number
  #starting?: Promise<boolean>
  /** In-flight idle stop; ensureRunning waits for it instead of racing it. */
  #stopping?: Promise<void>
  /** True only for a server this process started (or a previous run left behind). */
  #managed: boolean
  #timer: NodeJS.Timeout

  constructor(options: OpencodeSupervisorOptions) {
    this.#log = options.log
    this.#onDemand = options.onDemand
    this.#idleStopMs = options.idleStopMs
    this.#now = options.now ?? Date.now
    this.#healthyFn = options.healthy ?? (() => opencodeHealthy(options.env))
    this.#startFn = options.start ?? (() => startOpencode(options.paths, options.env))
    this.#stopFn = options.stop ?? (() => stopOpencode(options.paths))
    this.#localTargetFn = options.localTarget ?? (() => localOpencodeTarget(options.env))
    this.#unitManagedFn =
      options.unitManaged ?? (() => Boolean(readInstallManifest(options.paths.projectDir)?.opencodeUnitPath))
    this.#lastUsed = this.#now()
    // A pid file from an earlier run means the bot owns that process, so it may be reclaimed
    this.#managed = existsSync(options.paths.opencodePidPath)
    this.#timer = setInterval(() => void this.tick(), options.tickMs ?? 60_000)
    this.#timer.unref()
  }

  /** Marks one task that talks to OpenCode; the returned function must run in a `finally`. */
  track(): () => void {
    this.#active += 1
    this.#lastUsed = this.#now()
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active = Math.max(0, this.#active - 1)
      this.#lastUsed = this.#now()
    }
  }

  /**
   * Makes sure the server answers before a request. Returns false when it cannot be started
   * here: a remote `OPENCODE_URL`, a systemd unit that owns the service, or a failed spawn.
   * Concurrent callers share one start, so two chats cannot spawn two servers.
   */
  async ensureRunning(): Promise<boolean> {
    if (!this.#onDemand) return true
    // An idle stop may be mid-flight: a health check now would still see the dying server
    // and report it usable. Let the stop finish, then decide on a fresh health check.
    if (this.#stopping) await this.#stopping
    if (await this.#healthy()) {
      this.#lastUsed = this.#now()
      return true
    }
    if (!this.#localTargetFn()) return false
    if (this.#unitManagedFn()) {
      this.#log.warn("OpenCode 由 systemd 单元托管，按需模式不会自行启动；请用 systemctl 启动该单元")
      return false
    }
    const run = (this.#starting ??= this.#start())
    try {
      return await run
    } finally {
      if (this.#starting === run) this.#starting = undefined
    }
  }

  dispose(): void {
    clearInterval(this.#timer)
  }

  async #healthy(): Promise<boolean> {
    return this.#healthyFn().catch(() => false)
  }

  async #start(): Promise<boolean> {
    const result = await this.#startFn()
    if (!result.ok) {
      this.#log.warn(`OpenCode 按需启动失败：${result.message}`)
      return false
    }
    this.#managed = true
    this.#lastUsed = this.#now()
    this.#log.info(`OpenCode 按需启动：${result.message}`)
    return true
  }

  /** Idle sweep; exposed so tests can drive the clock instead of waiting for the interval. */
  async tick(): Promise<void> {
    if (!this.#onDemand || this.#idleStopMs <= 0) return
    if (this.#active > 0 || !this.#managed) return
    if (this.#now() - this.#lastUsed < this.#idleStopMs) return
    await this.#stopIfIdle()
  }

  async #stopIfIdle(): Promise<void> {
    if (this.#stopping) return this.#stopping
    const run = this.#runStop().finally(() => {
      if (this.#stopping === run) this.#stopping = undefined
    })
    this.#stopping = run
    return run
  }

  #idle(): boolean {
    return this.#active === 0 && this.#managed && this.#now() - this.#lastUsed >= this.#idleStopMs
  }

  async #runStop(): Promise<void> {
    try {
      // Re-check: a task may have arrived between the tick and this call
      if (!this.#idle()) return
      if (!(await this.#healthy())) {
        this.#managed = false
        return
      }
      // The health check above is an await: a task that started during it saw a healthy
      // server and is about to use it, so stopping now would cut it off. Check once more.
      if (!this.#idle()) return
      const message = await this.#stopFn()
      this.#managed = false
      this.#log.info(`OpenCode 空闲回收：${message}`)
    } catch (err) {
      this.#log.warn(`OpenCode 空闲回收失败：${(err as Error).message}`)
    }
  }
}

let active: OpencodeSupervisor | undefined

/** Configured once by the bot entry point; tests leave it unset, which disables the feature. */
export function configureOpencodeSupervisor(supervisor: OpencodeSupervisor | undefined): void {
  if (active && active !== supervisor) active.dispose()
  active = supervisor
}

export function activeOpencodeSupervisor(): OpencodeSupervisor | undefined {
  return active
}
