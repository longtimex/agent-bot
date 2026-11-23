import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

/**
 * What a CLI task changed in its working directory, and a way to take it back.
 *
 * A CLI engine edits files where it runs, and the only report the user got was the Agent's own
 * prose. Before each CLI task the working tree is snapshotted with `git stash create`, which
 * records tracked changes as a commit object without touching the tree, the index or the stash
 * list. Afterwards the diff against that snapshot is the task's own work: it is summarised under
 * the reply and kept per chat so `/undo` can restore it. Directories outside a git repository are
 * left alone; the task runs exactly as before.
 */
export interface WorkspaceSnapshot {
  root: string
  head: string
  /** Tree state before the task: a stash commit, or HEAD when the tree was clean. */
  base: string
  untracked: Set<string>
}

interface ChangeRecord {
  root: string
  head: string
  base: string
  /** Tracked paths the task changed, relative to root. */
  paths: string[]
  /** Untracked files the task created. */
  created: string[]
  /** Tree state right after the task, to refuse an undo over edits made since. */
  after: string
}

export interface FileChange {
  path: string
  added: number
  removed: number
}

const GIT_TIMEOUT_MS = 8_000
const MAX_LISTED = 12

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true })
  if (result.error || result.status !== 0) return undefined
  return result.stdout
}

function treeState(root: string, head: string): string | undefined {
  const stash = git(root, ["stash", "create"])
  if (stash === undefined) return undefined
  return stash.trim() || head
}

function untrackedFiles(root: string): Set<string> | undefined {
  const out = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  return out === undefined ? undefined : new Set(out.split("\0").filter(Boolean))
}

export function snapshotWorkspace(workDir: string): WorkspaceSnapshot | undefined {
  if (!existsSync(workDir)) return undefined
  const root = git(workDir, ["rev-parse", "--show-toplevel"])?.trim()
  if (!root) return undefined
  const head = git(root, ["rev-parse", "HEAD"])?.trim()
  if (!head) return undefined // a repository without commits has nothing to diff against
  const base = treeState(root, head)
  const untracked = untrackedFiles(root)
  if (!base || !untracked) return undefined
  return { root, head, base, untracked }
}

function numstat(root: string, base: string): FileChange[] | undefined {
  const out = git(root, ["diff", "--numstat", "--no-renames", base])
  if (out === undefined) return undefined
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t")
      // Binary files report "-" for both counts
      return { path: rest.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 }
    })
}

export class WorkspaceChanges {
  readonly #last = new Map<string, ChangeRecord>()

  /** Records the task's changes for `key` and returns the summary to append, if any. */
  finish(key: string, snapshot: WorkspaceSnapshot): string | undefined {
    const { root, base } = snapshot
    const tracked = numstat(root, base)
    const after = untrackedFiles(root)
    const head = git(root, ["rev-parse", "HEAD"])?.trim()
    if (!tracked || !after || !head) return undefined
    const created = [...after].filter((path) => !snapshot.untracked.has(path)).sort()
    if (tracked.length === 0 && created.length === 0) {
      this.#last.delete(key)
      return undefined
    }
    const state = treeState(root, head)
    if (state) {
      this.#last.set(key, {
        root,
        head: snapshot.head,
        base,
        paths: tracked.map((change) => change.path),
        created,
        after: `${head}:${state}`,
      })
    }
    return formatChanges(tracked, created, head !== snapshot.head, Boolean(state))
  }

  /** Restores the tree to how it was before the chat's last CLI task. */
  undo(key: string): { ok: boolean; message: string } {
    const record = this.#last.get(key)
    if (!record) return { ok: false, message: "没有可撤销的改动：只有上一次 CLI 任务在 git 仓库里的改动可以撤销。" }
    const head = git(record.root, ["rev-parse", "HEAD"])?.trim()
    if (!head) return { ok: false, message: "无法读取 git 仓库状态，未做任何改动。" }
    if (head !== record.head) {
      return {
        ok: false,
        message: `任务之后仓库多了新的 commit，无法自动撤销；如需回退请手动执行 git reset ${record.head.slice(0, 8)}。`,
      }
    }
    // Edits made after the task would be thrown away with it, so the tree must be unchanged since
    if (`${head}:${treeState(record.root, head)}` !== record.after) {
      return { ok: false, message: "任务结束后工作目录又有了新的改动，为避免覆盖已拒绝撤销。" }
    }
    if (record.paths.length > 0) {
      const restored = git(record.root, ["restore", `--source=${record.base}`, "--staged", "--worktree", "--", ...record.paths])
      if (restored === undefined) return { ok: false, message: "git restore 执行失败，工作目录未改动。" }
    }
    let removed = 0
    for (const path of record.created) {
      const full = resolve(record.root, path)
      const inside = relative(record.root, full)
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue
      try {
        rmSync(full, { force: true })
        removed += 1
      } catch {
        // a file that is already gone needs no undo
      }
    }
    this.#last.delete(key)
    return {
      ok: true,
      message: `↩️ 已撤销上一次任务的改动：恢复 ${record.paths.length} 个文件，删除 ${removed} 个新建文件。`,
    }
  }
}

function formatChanges(tracked: FileChange[], created: string[], committed: boolean, undoable: boolean): string {
  const added = tracked.reduce((sum, change) => sum + change.added, 0)
  const removed = tracked.reduce((sum, change) => sum + change.removed, 0)
  const count = tracked.length + created.length
  const lines = [`📝 本次改动：${count} 个文件（+${added} −${removed}）`]
  for (const change of tracked.slice(0, MAX_LISTED)) lines.push(`• ${change.path}（+${change.added} −${change.removed}）`)
  for (const path of created.slice(0, Math.max(0, MAX_LISTED - tracked.length))) lines.push(`• ${path}（新建）`)
  if (count > MAX_LISTED) lines.push(`…另有 ${count - MAX_LISTED} 个文件`)
  if (committed) lines.push("Agent 已提交了 commit，这部分需手动回退。")
  else if (undoable) lines.push("不满意可发送 /undo 撤销本次改动。")
  return lines.join("\n")
}

/** One per process: Telegram and the App share engineCall, and each chat key keeps its own record. */
export const workspaceChanges = new WorkspaceChanges()

