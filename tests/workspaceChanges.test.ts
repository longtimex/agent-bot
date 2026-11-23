import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { WorkspaceChanges, snapshotWorkspace } from "../src/workspaceChanges.js"

const hasGit = spawnSync("git", ["--version"]).status === 0

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-ws-changes-"))
  const run = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  run("init", "-q")
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
