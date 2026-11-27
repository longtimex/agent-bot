import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { redactSecrets } from "./ccswitch.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"
import { clip, escapeMarkdown } from "./messages.js"

/**
 * What a task changed in its working directory, plus Diff preview, persistent multi-step
 * undo and confirmed git commit.
 *
 * Before each task (CLI or OpenCode) the working tree is snapshotted with `git stash create`,
 * which records tracked changes as a commit object without touching the tree, the index or the
 * stash list. Afterwards the diff against that snapshot is summarised under the reply and pushed
 * onto a per-chat stack (persisted to `data/workspace-changes.json` when configured) so `/diff`,
 * `/undo` and `/commit` keep working across Bot restarts.
 */
export interface WorkspaceSnapshot {
  root: string
  head: string
  /** Tree state before the task: a stash commit, or HEAD when the tree was clean. */
  base: string
  untracked: Set<string>
}

interface ChangeRecord {
  id: string
  root: string
  head: string
  base: string
  /** Tracked paths the task changed, relative to root. */
  paths: string[]
  /** Untracked files the task created. */
  created: string[]
  /** SHA-256 content hashes of `created` files right after the task, to protect manual edits. */
  createdHashes?: Record<string, string>
  /** Tree state right after the task, to refuse an undo over edits made since. */
  after: string
  createdAt: number
  added: number
  removed: number
  engine?: string
}

export interface FileChange {
  path: string
  added: number
  removed: number
}

export interface WorkspaceFileDiff {
  path: string
  status: "modified" | "added" | "deleted"
  added: number
  removed: number
  patch: string
}

export interface WorkspaceHistoryEntry {
  id: string
  root: string
  createdAt: number
  files: number
  added: number
  removed: number
  engine?: string
  undoable: boolean
}

export interface WorkspaceDiffView {
  ok: boolean
  message?: string
  root?: string
  head?: string
  count: number
  added: number
  removed: number
  files: WorkspaceFileDiff[]
  truncated: boolean
  undoable: boolean
  recordsCount: number
  history: WorkspaceHistoryEntry[]
}

export interface UndoResult {
  ok: boolean
  message: string
  remaining: number
}

export interface CommitResult {
  ok: boolean
  message: string
  commitHash?: string
  filesCount?: number
}

const GIT_TIMEOUT_MS = 8_000
const MAX_LISTED = 12
const MAX_RECORDS_PER_CHAT = 10
const MAX_DIFF_FILES = 30
const MAX_FILE_PATCH_CHARS = 8_000
const MAX_TOTAL_PATCH_CHARS = 32_000
const MAX_NEW_FILE_READ_BYTES = 64 * 1024
const MAX_COMMIT_MSG_CHARS = 500

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

/** Deterministic tree hash for `commitOrTree`, independent of `git stash create`'s commit timestamp. */
function treeHash(root: string, commitOrTree: string): string | undefined {
  return git(root, ["rev-parse", `${commitOrTree}^{tree}`])?.trim()
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

function numstat(root: string, base: string, paths?: string[]): FileChange[] | undefined {
  const args = ["diff", "--numstat", "--no-renames", base]
  if (paths && paths.length > 0) args.push("--", ...paths)
  const out = git(root, args)
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

function readNewFilePatch(root: string, relPath: string): { added: number; patch: string; truncated: boolean } {
  const full = resolve(root, relPath)
  const inside = relative(root, full)
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(full)) {
    return { added: 0, patch: "[文件不可读取]", truncated: false }
  }
  try {
    const stat = statSync(full)
    if (!stat.isFile()) return { added: 0, patch: "[非普通文件]", truncated: false }
    const buf = readFileSync(full)
    const sample = buf.subarray(0, Math.min(buf.length, 4096))
    if (sample.includes(0)) return { added: 0, patch: "[二进制文件]", truncated: false }
    const slice = buf.length > MAX_NEW_FILE_READ_BYTES ? buf.subarray(0, MAX_NEW_FILE_READ_BYTES) : buf
    const text = redactSecrets(slice.toString("utf8"))
    const lines = text.split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    const rawPatch = [`--- /dev/null`, `+++ b/${relPath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n")
    const over = buf.length > MAX_NEW_FILE_READ_BYTES || rawPatch.length > MAX_FILE_PATCH_CHARS
    const patch = over ? `${clip(rawPatch, MAX_FILE_PATCH_CHARS) ?? ""}\n…（已截断）` : rawPatch
    return { added: lines.length, patch, truncated: over }
  } catch {
    return { added: 0, patch: "[读取失败]", truncated: false }
  }
}

function hashFile(root: string, relPath: string): string | undefined {
  const full = resolve(root, relPath)
  const inside = relative(root, full)
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(full)) return undefined
  try {
    if (!statSync(full).isFile()) return undefined
    return createHash("sha256").update(readFileSync(full)).digest("hex")
  } catch {
    return undefined
  }
}

function sanitizeRecord(raw: unknown): ChangeRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.root !== "string" || !r.root || typeof r.head !== "string" || typeof r.base !== "string" || typeof r.after !== "string") {
    return undefined
  }
  const paths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string" && p.length > 0) : []
  const created = Array.isArray(r.created) ? r.created.filter((p): p is string => typeof p === "string" && p.length > 0) : []
  let createdHashes: Record<string, string> | undefined
  if (r.createdHashes && typeof r.createdHashes === "object" && !Array.isArray(r.createdHashes)) {
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.createdHashes as Record<string, unknown>)) {
      if (typeof v === "string" && v) map[k] = v
    }
    if (Object.keys(map).length > 0) createdHashes = map
  }
  return {
    id: typeof r.id === "string" && r.id ? r.id : randomBytes(4).toString("hex"),
    root: r.root,
    head: r.head,
    base: r.base,
    paths,
    created,
    ...(createdHashes ? { createdHashes } : {}),
    after: r.after,
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    added: typeof r.added === "number" && Number.isFinite(r.added) ? r.added : 0,
    removed: typeof r.removed === "number" && Number.isFinite(r.removed) ? r.removed : 0,
    ...(typeof r.engine === "string" && r.engine ? { engine: r.engine } : {}),
  }
}

export class WorkspaceChanges {
  readonly #stacks = new Map<string, ChangeRecord[]>()
  #path?: string
  #log?: Logger

  constructor(path?: string, log?: Logger) {
    if (path) this.configure(path, log)
  }

  /** Enables disk persistence so undo history survives Bot restarts. */
  configure(path: string, log?: Logger): void {
    this.#path = path
    this.#log = log
    this.#load()
  }

  /** Records the task's changes for `key` and returns the summary to append, if any. */
  finish(key: string, snapshot: WorkspaceSnapshot, engine?: string): string | undefined {
    const { root, base } = snapshot
    const tracked = numstat(root, base)
    const after = untrackedFiles(root)
    const head = git(root, ["rev-parse", "HEAD"])?.trim()
    if (!tracked || !after || !head) return undefined
    const created = [...after].filter((path) => !snapshot.untracked.has(path)).sort()
    if (tracked.length === 0 && created.length === 0) return undefined
    const added = tracked.reduce((sum, change) => sum + change.added, 0)
    const removed = tracked.reduce((sum, change) => sum + change.removed, 0)
    const state = treeState(root, head)
    const afterTree = state ? treeHash(root, state) : undefined
    if (afterTree) {
      const createdHashes: Record<string, string> = {}
      for (const relPath of created) {
        const digest = hashFile(root, relPath)
        if (digest) createdHashes[relPath] = digest
      }
      const stack = this.#stacks.get(key) ?? []
      stack.push({
        id: randomBytes(4).toString("hex"),
        root,
        head: snapshot.head,
        base,
        paths: tracked.map((change) => change.path),
        created,
        ...(Object.keys(createdHashes).length > 0 ? { createdHashes } : {}),
        after: `${head}:${afterTree}`,
        createdAt: Date.now(),
        added,
        removed,
        ...(engine ? { engine } : {}),
      })
      if (stack.length > MAX_RECORDS_PER_CHAT) stack.splice(0, stack.length - MAX_RECORDS_PER_CHAT)
      this.#stacks.set(key, stack)
      this.#save()
    }
    return formatChanges(tracked, created, head !== snapshot.head, Boolean(afterTree))
  }

  #createdUnchanged(record: ChangeRecord): boolean {
    if (!record.createdHashes) return true
    for (const relPath of record.created) {
      const expected = record.createdHashes[relPath]
      if (!expected) continue
      const current = hashFile(record.root, relPath)
      if (current !== expected) return false
    }
    return true
  }

  /** Returns whether the top record matches the current tree state without intervening edits. */
  #isUndoable(record: ChangeRecord): boolean {
    if (!existsSync(record.root)) return false
    const head = git(record.root, ["rev-parse", "HEAD"])?.trim()
    if (!head || head !== record.head) return false
    const state = treeState(record.root, head)
    const currentTree = state ? treeHash(record.root, state) : undefined
    if (!currentTree || `${head}:${currentTree}` !== record.after) return false
    return this.#createdUnchanged(record)
  }

  /** History stack for `key`, newest first. */
  history(key: string): WorkspaceHistoryEntry[] {
    const stack = this.#stacks.get(key) ?? []
    return [...stack].reverse().map((record, index) => ({
      id: record.id,
      root: record.root,
      createdAt: record.createdAt,
      files: record.paths.length + record.created.length,
      added: record.added,
      removed: record.removed,
      ...(record.engine ? { engine: record.engine } : {}),
      undoable: index === 0 ? this.#isUndoable(record) : false,
    }))
  }

  /** Returns unified file diffs for the latest task or live working-tree edits. */
  diff(key: string, workDir?: string): WorkspaceDiffView {
    const stack = this.#stacks.get(key) ?? []
    const top = stack.at(-1)
    const entries = this.history(key)
    const currentRoot = workDir && existsSync(workDir)
      ? git(workDir, ["rev-parse", "--show-toplevel"])?.trim()
      : undefined

    // Only show the top undo record when it belongs to the active repository (if workDir is set).
    if (top && existsSync(top.root) && (!currentRoot || top.root === currentRoot)) {
      const undoable = this.#isUndoable(top)
      const head = git(top.root, ["rev-parse", "--short", "HEAD"])?.trim()
      const trackedStats = numstat(top.root, top.base, top.paths) ?? []
      const liveCreated = top.created.filter((p) => existsSync(resolve(top.root, p)))
      if (trackedStats.length > 0 || liveCreated.length > 0) {
        return this.#buildDiffView(top.root, head, top.base, trackedStats, liveCreated, undoable, entries)
      }
    }

    // Fallback: inspect live uncommitted changes in the chat's working directory
    const probeDir = workDir ?? top?.root
    if (!probeDir || !existsSync(probeDir)) {
      return { ok: true, message: "当前工作目录没有 git 改动。", count: 0, added: 0, removed: 0, files: [], truncated: false, undoable: false, recordsCount: stack.length, history: entries }
    }
    const root = currentRoot ?? git(probeDir, ["rev-parse", "--show-toplevel"])?.trim()
    const head = root ? git(root, ["rev-parse", "--short", "HEAD"])?.trim() : undefined
    if (!root || !head) {
      return { ok: true, message: "当前工作目录不是有效的 git 仓库（或尚无提交）。", count: 0, added: 0, removed: 0, files: [], truncated: false, undoable: false, recordsCount: stack.length, history: entries }
    }
    const trackedStats = numstat(root, "HEAD") ?? []
    const untracked = [...(untrackedFiles(root) ?? [])].sort()
    if (trackedStats.length === 0 && untracked.length === 0) {
      return { ok: true, root, head, message: "当前工作目录干净，没有未提交改动。", count: 0, added: 0, removed: 0, files: [], truncated: false, undoable: false, recordsCount: stack.length, history: entries }
    }
    return this.#buildDiffView(root, head, "HEAD", trackedStats, untracked, false, entries)
  }

  #buildDiffView(
    root: string,
    head: string | undefined,
    base: string,
    trackedStats: FileChange[],
    created: string[],
    undoable: boolean,
    history: WorkspaceHistoryEntry[],
  ): WorkspaceDiffView {
    const files: WorkspaceFileDiff[] = []
    let totalChars = 0
    let truncated = false
    let added = 0
    let removed = 0

    for (const item of trackedStats) {
      added += item.added
      removed += item.removed
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true
        continue
      }
      const deleted = !existsSync(resolve(root, item.path))
      let patch = ""
      if (totalChars < MAX_TOTAL_PATCH_CHARS) {
        const raw = git(root, ["diff", "--no-color", "--no-ext-diff", "-U3", base, "--", item.path]) ?? ""
        const clean = redactSecrets(raw.trimEnd())
        const budget = Math.min(MAX_FILE_PATCH_CHARS, MAX_TOTAL_PATCH_CHARS - totalChars)
        if (clean.length > budget) {
          patch = `${clip(clean, budget) ?? ""}\n…（已截断）`
          truncated = true
        } else {
          patch = clean
        }
        totalChars += patch.length
      } else {
        patch = "…（总大小超出预览上限）"
        truncated = true
      }
      files.push({
        path: item.path,
        status: deleted ? "deleted" : "modified",
        added: item.added,
        removed: item.removed,
        patch,
      })
    }

    for (const relPath of created) {
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true
        continue
      }
      const createdInfo = readNewFilePatch(root, relPath)
      added += createdInfo.added
      let patch = createdInfo.patch
      if (createdInfo.truncated) truncated = true
      if (totalChars + patch.length > MAX_TOTAL_PATCH_CHARS) {
        const budget = Math.max(0, MAX_TOTAL_PATCH_CHARS - totalChars)
        patch = budget > 120 ? `${clip(patch, budget) ?? ""}\n…（已截断）` : "…（总大小超出预览上限）"
        truncated = true
      }
      totalChars += patch.length
      files.push({ path: relPath, status: "added", added: createdInfo.added, removed: 0, patch })
    }

    return {
      ok: true,
      root,
      head,
      count: trackedStats.length + created.length,
      added,
      removed,
      files,
      truncated,
      undoable,
      recordsCount: history.length,
      history,
    }
  }

  /** Restores the tree to how it was before the chat's latest recorded task. */
  undo(key: string): UndoResult {
    const stack = this.#stacks.get(key)
    const record = stack?.at(-1)
    if (!record || !stack) {
      return { ok: false, message: "没有可撤销的改动：只有任务在 git 仓库里的改动可以撤销。", remaining: 0 }
    }
    const head = git(record.root, ["rev-parse", "HEAD"])?.trim()
    if (!head) return { ok: false, message: "无法读取 git 仓库状态，未做任何改动。", remaining: stack.length }
    if (head !== record.head) {
      return {
        ok: false,
        message: `任务之后仓库多了新的 commit，无法自动撤销；如需回退请手动执行 git reset ${record.head.slice(0, 8)}。`,
        remaining: stack.length,
      }
    }
    // Edits made after the task (including manual edits to untracked files it created)
    // would be thrown away, so both the git tree and created-file hashes must match.
    const state = treeState(record.root, head)
    const currentTree = state ? treeHash(record.root, state) : undefined
    if (!currentTree || `${head}:${currentTree}` !== record.after || !this.#createdUnchanged(record)) {
      return { ok: false, message: "任务结束后工作目录又有了新的改动，为避免覆盖已拒绝撤销。", remaining: stack.length }
    }
    if (record.paths.length > 0) {
      const restored = git(record.root, ["restore", `--source=${record.base}`, "--staged", "--worktree", "--", ...record.paths])
      if (restored === undefined) return { ok: false, message: "git restore 执行失败，工作目录未改动。", remaining: stack.length }
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
    stack.pop()
    if (stack.length === 0) this.#stacks.delete(key)
    this.#save()
    const suffix = stack.length > 0 ? `（另有 ${stack.length} 条更早的改动记录可继续 /undo）` : ""
    return {
      ok: true,
      message: `↩️ 已撤销上一次任务的改动：恢复 ${record.paths.length} 个文件，删除 ${removed} 个新建文件。${suffix}`,
      remaining: stack.length,
    }
  }

  /** Stages and commits all current workspace changes in the chat's git repository. */
  commit(key: string, rawMessage: string, workDir?: string): CommitResult {
    const message = rawMessage.trim()
    if (!message) return { ok: false, message: "请提供提交说明，例如：/commit 修复登录超时问题" }
    if (message.length > MAX_COMMIT_MSG_CHARS || /[\u0000-\u001f\u007f]/.test(message)) {
      return { ok: false, message: `提交说明无效（不能包含控制字符，且上限 ${MAX_COMMIT_MSG_CHARS} 字）。` }
    }
    const stack = this.#stacks.get(key)
    // Prefer the chat's active workDir so switching /dir never commits an older repo.
    const probeDir = workDir ?? stack?.at(-1)?.root
    if (!probeDir || !existsSync(probeDir)) {
      return { ok: false, message: "当前工作目录不可用，无法提交。" }
    }
    const root = git(probeDir, ["rev-parse", "--show-toplevel"])?.trim()
    if (!root) return { ok: false, message: "当前工作目录不是 git 仓库，无法提交。" }
    const status = git(root, ["status", "--porcelain"])
    if (status === undefined) return { ok: false, message: "无法读取 git 状态。" }
    const dirtyLines = status.split("\n").filter(Boolean)
    if (dirtyLines.length === 0) return { ok: false, message: "工作目录干净，没有可提交的改动。" }

    if (git(root, ["add", "-A"]) === undefined) {
      return { ok: false, message: "git add 执行失败，未创建提交。" }
    }
    const commitRes = spawnSync("git", ["commit", "-m", message], {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    if (commitRes.error || commitRes.status !== 0) {
      // Unstage changes so a failed commit does not pollute the index or break /undo.
      git(root, ["reset", "--mixed", "HEAD"])
      const detail = redactSecrets((commitRes.stderr || commitRes.stdout || commitRes.error?.message || "未知错误").trim()).slice(0, 300)
      return { ok: false, message: `git commit 失败：${detail}` }
    }
    const hash = git(root, ["rev-parse", "--short", "HEAD"])?.trim()
    // Undo records targeting the previous HEAD are now superseded by this commit
    if (stack) {
      const kept = stack.filter((entry) => entry.root !== root)
      if (kept.length > 0) this.#stacks.set(key, kept)
      else this.#stacks.delete(key)
      this.#save()
    }
    return {
      ok: true,
      commitHash: hash,
      filesCount: dirtyLines.length,
      message: `✅ 已提交 ${dirtyLines.length} 项改动${hash ? `（${hash}）` : ""}：${message}`,
    }
  }

  #load(): void {
    if (!this.#path) return
    const parsed = readJsonObject(this.#path, (msg) => this.#log?.warn(msg))
    if (!parsed) return
    const chats = parsed.chats && typeof parsed.chats === "object" ? (parsed.chats as Record<string, unknown>) : {}
    this.#stacks.clear()
    for (const [key, rawList] of Object.entries(chats)) {
      if (!Array.isArray(rawList)) continue
      const items = rawList.map(sanitizeRecord).filter((item): item is ChangeRecord => item !== undefined).slice(-MAX_RECORDS_PER_CHAT)
      if (items.length > 0) this.#stacks.set(key, items)
    }
  }

  #save(): void {
    if (!this.#path) return
    const chats: Record<string, ChangeRecord[]> = {}
    for (const [key, list] of this.#stacks) {
      if (list.length > 0) chats[key] = list
    }
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify({ version: 1, chats }, null, 2)}\n`)
    } catch (err) {
      this.#log?.warn("failed to persist workspace changes:", (err as Error).message)
    }
  }
}

export function formatDiffForChat(view: WorkspaceDiffView): string {
  if (view.count === 0) return `📂 *代码改动*\n\n${escapeMarkdown(view.message ?? "当前工作目录没有未提交改动。")}`
  const header = [
    `📝 *代码改动*：${view.count} 个文件（+${view.added} −${view.removed}）`,
    ...(view.head ? [`• HEAD：\`${escapeMarkdown(view.head)}\`${view.undoable ? " · 支持 `/undo`" : ""}`] : []),
    ...(view.recordsCount > 1 ? [`• 持久化撤销栈：${view.recordsCount} 条记录`] : []),
    "",
  ]
  const fileLines = view.files.slice(0, MAX_LISTED).map((f) => {
    const tag = f.status === "added" ? "新建" : f.status === "deleted" ? "删除" : `+${f.added} −${f.removed}`
    return `• \`${escapeMarkdown(f.path)}\`（${tag}）`
  })
  if (view.count > MAX_LISTED) fileLines.push(`…另有 ${view.count - MAX_LISTED} 个文件`)

  const patchBudget = 2200
  let patchText = ""
  for (const file of view.files) {
    if (!file.patch) continue
    const block = `# ${file.path}\n${file.patch}\n`
    if (patchText.length + block.length > patchBudget) {
      patchText += `${clip(block, Math.max(0, patchBudget - patchText.length)) ?? ""}\n…（完整 diff 请在安卓 App「代码改动」查看）`
      break
    }
    patchText += block
  }
  const safePatch = patchText.replace(/```/g, "'''").trim()
  return [
    ...header,
    ...fileLines,
    ...(safePatch ? ["", "```diff", safePatch, "```"] : []),
    "",
    "提交：`/commit <提交说明>` · 撤销：`/undo`",
  ].join("\n")
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
  else if (undoable) lines.push("可发送 /diff 查看详情、/undo 撤销或 /commit <说明> 提交。")
  return lines.join("\n")
}

/** One per process: Telegram and the App share engineCall, and each chat key keeps its own record. */
export const workspaceChanges = new WorkspaceChanges()
