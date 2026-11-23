import { chmodSync, copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { OpsResult, OpsStep } from "./ops.js"
import type { ReleaseManager, ReleaseState } from "./releaseManager.js"

/**
 * `.env` holds the configuration and keys an update must not lose either, but it lives beside
 * the code, not in data/, so the state archive (which restore-backup unpacks into data/) does not
 * carry it. A copy goes next to the archive under the same name; a copy whose archive was pruned
 * goes with it, so the two always match.
 */
export function keepEnvCopy(projectDir: string, archive: string): OpsStep {
  const label = "备份 .env"
  const env = join(projectDir, ".env")
  if (!existsSync(env)) return { label, ok: true, code: 0, output: "没有 .env，跳过" }
  try {
    const copy = archive.replace(/\.tar\.gz$/, ".env")
    copyFileSync(env, copy)
    chmodSync(copy, 0o600)
    const dir = dirname(archive)
    for (const name of readdirSync(dir)) {
      if (!/^backup-.*\.env$/.test(name)) continue
      if (!existsSync(join(dir, name.replace(/\.env$/, ".tar.gz")))) unlinkSync(join(dir, name))
    }
    return { label, ok: true, code: 0, output: copy }
  } catch (err) {
    return { label, ok: false, code: 1, output: err instanceof Error ? err.message : String(err) }
  }
}

export interface UpdateOrchestratorDeps {
  projectDir: string
  releases: ReleaseManager
  releaseState: () => ReleaseState
  backup: () => Promise<OpsResult & { file?: string }>
  updateTarget: () => { channel: string; ref: string }
  releaseVersion: () => string
  hasGit: () => boolean
  hasNpm: () => boolean
}

/**
 * Update lifecycle:
 *   1. back up state;
 *   2. build and gate a separate tree;
 *   3. leave it pending until the supervisor restarts into it.
 * No step mutates the running checkout or its dist/ directory.
 */
export class UpdateOrchestrator {
  readonly #deps: UpdateOrchestratorDeps
  #running = false

  constructor(deps: UpdateOrchestratorDeps) {
    this.#deps = deps
  }

  async updateProject(): Promise<OpsResult> {
    if (this.#running) return { ok: false, message: "已有更新正在执行，请稍后再试。", steps: [] }
    this.#running = true
    try {
      if (!this.#deps.hasGit()) return { ok: false, message: "未找到 git，无法更新项目。", steps: [] }
      if (!this.#deps.hasNpm()) return { ok: false, message: "未找到 npm，无法安装依赖。", steps: [] }
      const steps: OpsStep[] = []
      const target = this.#deps.updateTarget()
      const before = this.#deps.releaseState()
      const fromCommit = before.current?.commit ?? undefined
      const fromVersion = before.current?.version ?? this.#deps.releaseVersion()

      const backup = await this.#deps.backup()
      steps.push(...backup.steps)
      if (!backup.ok && backup.message.includes("没有可备份")) {
        steps.push({ label: "自动备份状态", ok: true, code: 0, output: "首次运行，暂无状态文件" })
      } else if (!backup.ok) {
        return { ok: false, message: `自动备份失败，已中止更新：${backup.message}`, steps }
      }
      if (backup.file) {
        const env = keepEnvCopy(this.#deps.projectDir, backup.file)
        steps.push(env)
        if (!env.ok) return { ok: false, message: `备份 .env 失败，已中止更新：${env.output}`, steps }
      }

      const built = await this.#deps.releases.buildStaging(target.ref)
      steps.push(...built.steps)
      if (!built.ok || !built.release) {
        this.#deps.releases.recordUpdate({ fromCommit, fromVersion, steps }, "failed", built.message)
        return { ok: false, message: built.message, steps }
      }

      this.#deps.releases.recordUpdate(
        {
          fromCommit,
          toCommit: built.release.commit,
          fromVersion,
          toVersion: built.release.version,
          steps,
        },
        "ok",
        "预构建与发布门禁通过，等待重启应用。",
      )
      this.#deps.releases.prune()
      return {
        ok: true,
        message:
          `✅ 已预构建 ${built.release.commit.slice(0, 8)}（v${built.release.version}），发布门禁通过。\n` +
          (backup.file ? `📦 更新前已备份数据：${basename(backup.file)}（含 .env 副本），可用 npm run backup:restore 恢复。\n` : "") +
          "当前进程仍运行旧版本；点击「重启 Bot」应用。启动失败会自动回滚，旧版本保留。",
        steps,
      }
    } finally {
      this.#running = false
    }
  }

  cancelPending(): OpsResult {
    const state = this.#deps.releaseState()
    if (!state.pending) return { ok: false, message: "没有等待应用的预构建版本。", steps: [] }
    const pending = state.pending
    delete state.pending
    this.#deps.releases.writeState(state)
    return { ok: true, message: `已丢弃预构建 ${pending.commit.slice(0, 8)}。当前版本未受影响。`, steps: [] }
  }

  rollback(): OpsResult {
    const state = this.#deps.releaseState()
    if (state.pending) return this.cancelPending()
    const result = this.#deps.releases.rollback()
    if (result.ok) {
      this.#deps.releases.recordUpdate(
        {
          fromCommit: state.current?.commit,
          toCommit: result.release?.commit,
          fromVersion: state.current?.version,
          toVersion: result.release?.version,
          steps: [],
        },
        "rolled-back",
        result.message,
      )
    }
    return {
      ok: result.ok,
      message: result.message + (result.ok ? " 点击「重启 Bot」使回滚版本生效。" : ""),
      steps: [],
    }
  }
}

