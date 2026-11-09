import { randomBytes } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"
import { installerChildEnv } from "./binPath.js"
import { writePrivateAtomic } from "./jsonStore.js"
import type { OpsCommandResult, OpsStep } from "./ops.js"

export interface ReleaseRecord {
  id: string
  commit: string
  version: string
  createdAt: string
  path: string
  previousCommit?: string
}

export interface UpdateReport {
  fromCommit?: string
  toCommit?: string
  fromVersion?: string
  toVersion?: string
  apiReachable?: boolean
  engine?: string
  steps: OpsStep[]
}

export interface ReleaseState {
  current?: ReleaseRecord
  previous?: ReleaseRecord
  pending?: ReleaseRecord
  lastUpdate?: {
    at: string
    from: string
    to: string
    status: "ok" | "failed" | "rolled-back"
    message: string
    report: UpdateReport
  }
}

export interface ReleasePaths {
  root: string
  releases: string
  state: string
}

export interface ReleaseCommandRunner {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<OpsCommandResult>
}

export interface ReleaseManagerOptions {
  projectDir: string
  dataDir: string
  releasesDir?: string
  statePath?: string
  run: ReleaseCommandRunner
  which?: (bin: string) => string | undefined
  env?: NodeJS.ProcessEnv
}

const DEFAULT_KEEP = 3
const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 10 * 60_000
const GATE_TIMEOUT_MS = 20 * 60_000
const GIT_TIMEOUT_MS = 5 * 60_000

function stamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
}

function releaseVersion(path: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version?: unknown }
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "dev"
  } catch {
    return "dev"
  }
}

function outputStep(label: string, result: OpsCommandResult): OpsStep {
  const output = `${result.stdout}\n${result.stderr}`.trim()
  return { label, ok: result.code === 0, code: result.code, output: output.slice(-1_500) }
}

export class ReleaseManager {
  readonly #projectDir: string
  readonly #dataDir: string
  readonly #paths: ReleasePaths
  readonly #run: ReleaseCommandRunner
  readonly #which: (bin: string) => string | undefined
  readonly #env?: NodeJS.ProcessEnv

  constructor(options: ReleaseManagerOptions) {
    this.#projectDir = resolve(options.projectDir)
    this.#dataDir = resolve(options.dataDir)
    const root = resolve(options.releasesDir ?? join(this.#dataDir, "releases"))
    this.#paths = {
      root,
      releases: join(root, "store"),
      state: resolve(options.statePath ?? join(root, "state.json")),
    }
    this.#run = options.run
    this.#which = options.which ?? (() => undefined)
    this.#env = options.env
  }

  get paths(): ReleasePaths {
    return this.#paths
  }

  get buildRoot(): string {
    return this.#paths.releases
  }

  readState(): ReleaseState {
    if (!existsSync(this.#paths.state)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#paths.state, "utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      return parsed as ReleaseState
    } catch {
      return {}
    }
  }

  writeState(state: ReleaseState): void {
    mkdirSync(this.#paths.root, { recursive: true })
    writePrivateAtomic(this.#paths.state, `${JSON.stringify(state, null, 2)}\n`)
  }

  isUsable(release: ReleaseRecord | undefined): release is ReleaseRecord {
    return Boolean(release?.path && existsSync(join(release.path, "dist", "index.js")))
  }

  currentEntry(): string | undefined {
    const current = this.readState().current
    return this.isUsable(current) ? join(current.path, "dist", "index.js") : undefined
  }

  currentReleaseDir(): string | undefined {
    const current = this.readState().current
    return this.isUsable(current) ? current.path : undefined
  }

  async buildStaging(branch?: string): Promise<{
    ok: boolean
    steps: OpsStep[]
    release?: ReleaseRecord
    message: string
  }> {
    const steps: OpsStep[] = []
    const git = this.#which("git") ?? "git"
    const npm = this.#which("npm") ?? "npm"
    const env = this.#env ?? process.env
    if (!existsSync(this.#projectDir)) return { ok: false, steps, message: `项目目录不存在：${this.#projectDir}` }

    mkdirSync(this.#paths.root, { recursive: true })
    mkdirSync(this.#paths.releases, { recursive: true })
    const workDir = join(this.#paths.root, `.staging-${process.pid}-${stamp()}-${randomBytes(2).toString("hex")}`)

    try {
      const status = await this.#run(git, ["status", "--porcelain"], { cwd: this.#projectDir, env, timeoutMs: 60_000 })
      steps.push(outputStep("检查工作区", status))
      if (status.code !== 0) return { ok: false, steps, message: "无法读取 git 状态，已中止更新。" }
      if (status.stdout.trim()) {
        return { ok: false, steps, message: "工作区有未提交的改动，已中止更新。请先提交或暂存改动后再试。" }
      }

      const checkoutHead = await this.#run(git, ["rev-parse", "HEAD"], {
        cwd: this.#projectDir,
        env,
        timeoutMs: 30_000,
      })
      const previousCommit = checkoutHead.code === 0 ? checkoutHead.stdout.trim() : ""

      // A clone of the local checkout keeps `origin` pointing at that local path.
      // Fetching it would only refresh stale refs that were copied with the clone,
      // never the real upstream. Resolve the configured remote first and clone that.
      const remote = await this.#run(git, ["remote", "get-url", "origin"], {
        cwd: this.#projectDir,
        env,
        timeoutMs: 30_000,
      })
      const remoteUrl = remote.stdout.trim()
      if (remote.code !== 0 || !remoteUrl || remoteUrl.startsWith("-")) {
        return { ok: false, steps, message: "无法读取 origin 远端地址，请先配置 git remote，或改用 check:update 检查分支。" }
      }

      const upstream = await this.#run(
        git,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        { cwd: this.#projectDir, env, timeoutMs: 30_000 },
      )
      steps.push(outputStep("读取上游分支", upstream))
      if (upstream.code !== 0) return { ok: false, steps, message: "当前分支没有配置上游分支，无法在线更新。" }
      const target = branch?.trim() || upstream.stdout.trim()
      if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.startsWith("-")) {
        return { ok: false, steps, message: `上游分支名称无效：${target}` }
      }

      const clone = await this.#run(git, ["clone", "--no-hardlinks", "--quiet", remoteUrl, workDir], {
        cwd: this.#paths.root,
        env,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      steps.push(outputStep("复制当前 checkout", clone))
      if (clone.code !== 0) throw new Error("无法创建临时构建目录，已中止更新。")

      const fetch = await this.#run(git, ["fetch", "--quiet", "origin"], { cwd: workDir, env, timeoutMs: GIT_TIMEOUT_MS })
      steps.push(outputStep("git fetch origin", fetch))
      if (fetch.code !== 0) throw new Error("无法连接远端仓库（网络问题或仓库不可达），请稍后再试。")

      const checkout = await this.#run(git, ["checkout", "--detach", target], {
        cwd: workDir,
        env,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      steps.push(outputStep(`git checkout ${target}`, checkout))
      if (checkout.code !== 0) throw new Error(`无法切换到 ${target}，已中止更新。`)

      const head = await this.#run(git, ["rev-parse", "HEAD"], { cwd: workDir, env, timeoutMs: 30_000 })
      steps.push(outputStep("读取目标提交", head))
      if (head.code !== 0) throw new Error("无法读取目标提交，已中止更新。")
      const commit = head.stdout.trim()

      if (existsSync(join(this.#projectDir, ".env"))) {
        copyFileSync(join(this.#projectDir, ".env"), join(workDir, ".env"))
        chmodSync(join(workDir, ".env"), 0o600)
      }

      const installArgs = existsSync(join(workDir, "package-lock.json"))
        ? ["ci", "--no-audit", "--no-fund"]
        : ["install", "--no-audit", "--no-fund"]
      const install = await this.#run(npm, installArgs, {
        cwd: workDir,
        env: installerChildEnv(env),
        timeoutMs: INSTALL_TIMEOUT_MS,
      })
      steps.push(outputStep(`npm ${installArgs[0]}`, install))
      if (install.code !== 0) throw new Error("依赖安装失败，已停止构建，旧版本仍在运行。")

      const gate = await this.#run(npm, ["run", "check:release"], {
        cwd: workDir,
        env: installerChildEnv(env),
        timeoutMs: GATE_TIMEOUT_MS,
      })
      steps.push(outputStep("npm run check:release", gate))
      if (gate.code !== 0) throw new Error("发布门禁失败，已停止切换，旧版本仍在运行。")

      const build = await this.#run(npm, ["run", "build"], {
        cwd: workDir,
        env: installerChildEnv(env),
        timeoutMs: BUILD_TIMEOUT_MS,
      })
      steps.push(outputStep("npm run build", build))
      if (build.code !== 0) throw new Error("构建失败，已停止切换，旧版本仍在运行。")
      if (!existsSync(join(workDir, "dist", "index.js"))) throw new Error("构建成功但缺少 dist/index.js，已中止更新。")

      const id = `${stamp()}-${commit.slice(0, 8)}`
      const releaseDir = join(this.#paths.releases, id)
      renameSync(workDir, releaseDir)
      const state = this.readState()
      const release: ReleaseRecord = {
        id,
        commit,
        version: releaseVersion(releaseDir),
        createdAt: new Date().toISOString(),
        path: releaseDir,
        ...(state.current?.commit
          ? { previousCommit: state.current.commit }
          : previousCommit
            ? { previousCommit }
            : {}),
      }
      state.pending = release
      this.writeState(state)
      return { ok: true, steps, release, message: `已在 ${releaseDir} 完成预构建与发布门禁。` }
    } catch (err) {
      rmSync(workDir, { recursive: true, force: true })
      return { ok: false, steps, message: err instanceof Error ? err.message : String(err) }
    }
  }

  activatePending(): { ok: boolean; release?: ReleaseRecord; message: string } {
    const state = this.readState()
    const pending = state.pending
    if (!this.isUsable(pending)) return { ok: false, message: "没有可激活的预构建 release。" }
    if (state.current) state.previous = state.current
    else {
      // The first managed update starts from the checkout, which is not in the
      // release store yet. Record it as the rollback target as well; otherwise a
      // failed first activation has no previous release to return to.
      const checkout = join(this.#projectDir, "dist", "index.js")
      if (existsSync(checkout)) {
        state.previous = {
          id: "checkout",
          commit: pending.previousCommit ?? "checkout",
          version: releaseVersion(this.#projectDir),
          createdAt: new Date().toISOString(),
          path: this.#projectDir,
        }
      }
    }
    state.current = pending
    delete state.pending
    this.writeState(state)
    return { ok: true, release: pending, message: `已激活 release ${pending.id}（${pending.commit.slice(0, 8)}）。` }
  }

  rollback(): { ok: boolean; release?: ReleaseRecord; message: string } {
    const state = this.readState()
    if (!this.isUsable(state.previous)) return { ok: false, message: "没有可回滚的上一版 release。" }
    const failed = state.current
    const target = state.previous
    state.previous = failed
    state.current = target
    delete state.pending
    this.writeState(state)
    return { ok: true, release: target, message: `已回滚到 release ${target.id}（${target.commit.slice(0, 8)}）。` }
  }

  recordUpdate(report: UpdateReport, status: "ok" | "failed" | "rolled-back", message: string): void {
    const state = this.readState()
    state.lastUpdate = {
      at: new Date().toISOString(),
      from: report.fromCommit ?? "",
      to: report.toCommit ?? "",
      status,
      message,
      report,
    }
    this.writeState(state)
  }

  prune(keep = DEFAULT_KEEP): void {
    try {
      const state = this.readState()
      const keepDirs = new Set(
        [state.current?.path, state.previous?.path, state.pending?.path].filter((value): value is string => Boolean(value)),
      )
      const entries = readdirSync(this.#paths.releases, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.#paths.releases, entry.name))
        .filter((dir) => !keepDirs.has(dir))
        .sort()
      const removeCount = Math.max(0, entries.length - Math.max(0, keep - keepDirs.size))
      for (const stale of entries.slice(0, removeCount)) rmSync(stale, { recursive: true, force: true })
      for (const stage of readdirSync(this.#paths.root, { withFileTypes: true })) {
        if (stage.isDirectory() && stage.name.startsWith(".staging-")) {
          rmSync(join(this.#paths.root, stage.name), { recursive: true, force: true })
        }
      }
    } catch {
      // Retention is housekeeping; never fail a completed release over it.
    }
  }
}


