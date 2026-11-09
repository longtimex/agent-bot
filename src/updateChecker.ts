import { stripAnsi } from "./ccswitch.js"
import type { OpsCommandResult, OpsResult, OpsStep } from "./ops.js"
import type { ReleaseState } from "./releaseManager.js"

export interface UpdateTarget {
  channel: string
  ref: string
}

export interface UpdateCheckerDeps {
  run: (command: string, args: string[], timeoutMs: number) => Promise<OpsCommandResult>
  which: (bin: string) => string | undefined
  releaseState: () => ReleaseState
  env?: NodeJS.ProcessEnv
}

function firstLine(text: string): string {
  return stripAnsi(text).split(/\r?\n/, 1)[0]?.trim() ?? ""
}

/** The branch/ref an update follows. `UPDATE_CHANNEL=beta` opts into the beta branch. */
export function resolveUpdateTarget(env: NodeJS.ProcessEnv = process.env): UpdateTarget {
  const rawChannel = (env.UPDATE_CHANNEL ?? "stable").trim().toLowerCase()
  const channel = rawChannel === "beta" ? "beta" : "stable"
  const branch = (env.UPDATE_BRANCH ?? (channel === "beta" ? "beta" : "main")).trim()
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    return { channel, ref: "origin/main" }
  }
  return { channel, ref: `origin/${branch}` }
}

export interface ReleaseDiagnostics {
  label: string
  current?: string
  previous?: string
  pending?: string
  lastUpdateAt?: string
  lastUpdateStatus?: string
  lastUpdateMessage?: string
}

export function buildReleaseDiagnostics(state: ReleaseState, target: UpdateTarget): {
  release: ReleaseDiagnostics
  update: UpdateTarget
} {
  const current = state.current
  const label = current ? `${current.commit.slice(0, 8)} v${current.version}` : "checkout"
  return {
    update: target,
    release: {
      label,
      ...(current ? { current: current.id } : {}),
      ...(state.previous ? { previous: state.previous.id } : {}),
      ...(state.pending ? { pending: state.pending.id } : {}),
      ...(state.lastUpdate
        ? {
            lastUpdateAt: state.lastUpdate.at,
            lastUpdateStatus: state.lastUpdate.status,
            lastUpdateMessage: state.lastUpdate.message,
          }
        : {}),
    },
  }
}

/**
 * Read-only update check. It fetches the configured remote ref so a stale local
 * remote-tracking branch does not hide new commits, then compares against the
 * commit the running release was built from (not necessarily checkout HEAD).
 */
export class UpdateChecker {
  readonly #deps: UpdateCheckerDeps

  constructor(deps: UpdateCheckerDeps) {
    this.#deps = deps
  }

  target(): UpdateTarget {
    return resolveUpdateTarget(this.#deps.env ?? process.env)
  }

  async check(): Promise<OpsResult> {
    const steps: OpsStep[] = []
    if (!this.#deps.which("git")) return { ok: false, message: "未找到 git，无法检查更新。", steps }
    const target = this.target()
    const run = this.#deps.run
    const step = (label: string, result: OpsCommandResult): OpsStep => ({
      label,
      ok: result.code === 0,
      code: result.code,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-1_500),
    })

    const fetch = await run("git", ["fetch", "--quiet", "origin"], 60_000)
    steps.push(step("git fetch origin", fetch))
    if (fetch.code !== 0) {
      return { ok: false, message: "无法连接远端仓库（网络问题或仓库不可达），请稍后再试。", steps }
    }
    const verify = await run("git", ["rev-parse", "--verify", "--quiet", `${target.ref}^{commit}`], 15_000)
    steps.push(step(`读取 ${target.ref}`, verify))
    if (verify.code !== 0) {
      return {
        ok: false,
        message: `更新通道 ${target.channel} 的目标分支 ${target.ref} 不存在。请检查 UPDATE_BRANCH，或改用 stable。`,
        steps,
      }
    }
    const state = this.#deps.releaseState()
    const base = state.current?.commit ?? "HEAD"
    const behind = await run("git", ["rev-list", "--count", `${base}..${target.ref}`], 15_000)
    steps.push(step("比较提交数", behind))
    const count = Number.parseInt(stripAnsi(behind.stdout).trim(), 10)
    if (!Number.isFinite(count)) return { ok: false, message: "无法读取远端提交数，请稍后再试。", steps }
    const label = `${target.channel} · ${target.ref}`
    if (count === 0) return { ok: true, message: `✅ 已是最新：${label} 没有新提交。`, steps }
    const log = await run("git", ["log", "--oneline", "-5", `${base}..${target.ref}`], 15_000)
    const sample = stripAnsi(log.stdout || log.stderr).trim()
    return {
      ok: true,
      message:
        `⬇️ ${label} 落后 ${count} 个提交${sample ? `：\n${sample}` : ""}。\n` +
        (state.pending
          ? `已有预构建版本等待应用（${state.pending.commit.slice(0, 8)}），点击「重启 Bot」应用。`
          : "点击「⬆️ 更新项目」预构建；完成后重启 Bot 应用，启动失败会自动回滚。"),
      steps,
    }
  }
}

export function releaseLabel(state: ReleaseState, fallback: string): string {
  const current = state.current
  return current ? `${firstLine(current.commit).slice(0, 8)} v${current.version}` : fallback
}
