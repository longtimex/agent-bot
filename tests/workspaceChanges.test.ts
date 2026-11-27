import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { WorkspaceChanges, formatDiffForChat, snapshotWorkspace } from "../src/workspaceChanges.js"

const hasGit = spawnSync("git", ["--version"]).status === 0

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-ws-changes-"))
  const run = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  run("init", "-q")
  run("config", "core.autocrlf", "false")
  run("config", "user.email", "t@example.com")
  run("config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n")
  writeFileSync(join(dir, "keep.txt"), "user edit in progress\n")
  run("add", "a.txt")
  run("commit", "-q", "-m", "init")
  return dir
}

test("a task's edits are summarised and /undo puts the tree back", { skip: !hasGit }, () => {
  const dir = repo()
  try {
    const changes = new WorkspaceChanges()
    const before = snapshotWorkspace(dir)
    assert.ok(before)
    // The task edits a tracked file and creates one
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n")
    writeFileSync(join(dir, "new.ts"), "export {}\n")
    const summary = changes.finish("chat", before)
    assert.match(summary ?? "", /2 个文件/)
    assert.match(summary ?? "", /a\.txt（\+2 −1）/)
    assert.match(summary ?? "", /new\.ts（新建）/)
    assert.match(summary ?? "", /\/undo/)

    const undone = changes.undo("chat")
    assert.equal(undone.ok, true, undone.message)
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n")
    assert.equal(existsSync(join(dir, "new.ts")), false)
    // A file that was already untracked before the task is the user's, not the task's
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "user edit in progress\n")
    assert.equal(changes.undo("chat").ok, false, "an undo is spent once used")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("undo refuses to throw away edits made after the task", { skip: !hasGit }, () => {
  const dir = repo()
  try {
    const changes = new WorkspaceChanges()
    const before = snapshotWorkspace(dir)!
    writeFileSync(join(dir, "a.txt"), "task\n")
    changes.finish("chat", before)
    writeFileSync(join(dir, "a.txt"), "user kept going\n")
    const refused = changes.undo("chat")
    assert.equal(refused.ok, false)
    assert.match(refused.message, /新的改动/)
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "user kept going\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a task that changes nothing, or runs outside git, reports nothing", { skip: !hasGit }, () => {
  const dir = repo()
  const plain = mkdtempSync(join(tmpdir(), "bot-ws-plain-"))
  try {
    const changes = new WorkspaceChanges()
    assert.equal(changes.finish("chat", snapshotWorkspace(dir)!), undefined)
    assert.equal(snapshotWorkspace(plain), undefined, "outside a repository nothing is snapshotted")
    assert.equal(changes.undo("chat").ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
})

test("workspace changes persist multi-step undo stack across restarts and produce diffs", { skip: !hasGit }, () => {
  const dir = repo()
  const storeDir = mkdtempSync(join(tmpdir(), "bot-ws-store-"))
  const storePath = join(storeDir, "workspace-changes.json")
  try {
    const changes = new WorkspaceChanges(storePath)
    const snap1 = snapshotWorkspace(dir)!
    writeFileSync(join(dir, "a.txt"), "one\nstep1\n")
    changes.finish("chat", snap1, "opencode")

    const snap2 = snapshotWorkspace(dir)!
    writeFileSync(join(dir, "a.txt"), "one\nstep2\n")
    writeFileSync(join(dir, "extra.ts"), "export const v = 2\n")
    changes.finish("chat", snap2, "claude")

    // Simulate a process restart by loading from the same store file
    const reloaded = new WorkspaceChanges(storePath)
    const diff = reloaded.diff("chat", dir)
    assert.equal(diff.ok, true)
    assert.equal(diff.count, 2)
    assert.equal(diff.undoable, true)
    assert.equal(diff.recordsCount, 2)
    assert.ok(diff.files.some((f) => f.path === "a.txt" && f.patch.includes("+step2")))
    assert.ok(diff.files.some((f) => f.path === "extra.ts" && f.status === "added" && f.patch.includes("+export const v = 2")))
    assert.match(formatDiffForChat(diff), /代码改动/)

    // First undo rolls back step2 and leaves step1 intact & still undoable
    const undo2 = reloaded.undo("chat")
    assert.equal(undo2.ok, true, undo2.message)
    assert.equal(undo2.remaining, 1)
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\nstep1\n")
    assert.equal(existsSync(join(dir, "extra.ts")), false)

    // Second undo rolls back step1 to original committed content
    const undo1 = reloaded.undo("chat")
    assert.equal(undo1.ok, true, undo1.message)
    assert.equal(undo1.remaining, 0)
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(storeDir, { recursive: true, force: true })
  }
})

test("workspace commit stages changes, records commit hash and clears obsolete undo records", { skip: !hasGit }, () => {
  const dir = repo()
  try {
    const changes = new WorkspaceChanges()
    const snap = snapshotWorkspace(dir)!
    writeFileSync(join(dir, "a.txt"), "one\ncommitted\n")
    changes.finish("chat", snap, "claude")

    assert.equal(changes.commit("chat", "   ", dir).ok, false)
    const committed = changes.commit("chat", "feat: commit from bot", dir)
    assert.equal(committed.ok, true, committed.message)
    assert.ok(committed.commitHash && committed.commitHash.length >= 6)
    assert.equal(changes.history("chat").length, 0)
    assert.equal(changes.diff("chat", dir).count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
