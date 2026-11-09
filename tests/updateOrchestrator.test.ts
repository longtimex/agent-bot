import assert from "node:assert/strict"
import test from "node:test"
import type { OpsResult } from "../src/ops.js"
import type { ReleaseManager, ReleaseRecord, ReleaseState, UpdateReport } from "../src/releaseManager.js"
import { UpdateOrchestrator } from "../src/updateOrchestrator.js"

interface Harness {
  updates: UpdateOrchestrator
  state: () => ReleaseState
  calls: string[]
}

function release(id: string, commit: string, version = "0.5.0"): ReleaseRecord {
  return { id, commit, version, createdAt: "2026-01-01T00:00:00.000Z", path: `/release/${id}` }
}

function makeHarness(
  options: {
    initial?: ReleaseState
    backup?: () => Promise<OpsResult & { file?: string }>
    build?: Awaited<ReturnType<ReleaseManager["buildStaging"]>>
    hasGit?: boolean
    hasNpm?: boolean
  } = {},
): Harness {
  let state: ReleaseState = structuredClone(options.initial ?? {})
  const calls: string[] = []
  const fake = {
    readState: () => state,
    writeState: (next: ReleaseState) => {
      state = next
    },
    buildStaging: async () => {
      calls.push("build")
      const result = options.build ?? { ok: false, steps: [], message: "not configured" }
      if (result.ok && result.release) state.pending = result.release
      return result
    },
    recordUpdate: (report: UpdateReport, status: "ok" | "failed" | "rolled-back", message: string) => {
      state.lastUpdate = {
        at: "2026-01-01T00:00:00.000Z",
        from: report.fromCommit ?? "",
        to: report.toCommit ?? "",
        status,
        message,
        report,
      }
    },
    prune: () => {},
    rollback: () => {
      if (!state.previous) return { ok: false, message: "没有可回滚的上一版 release。" }
      const target = state.previous
      state.previous = state.current
      state.current = target
      delete state.pending
      return { ok: true, release: target, message: `已回滚到 ${target.id}。` }
    },
  } as unknown as ReleaseManager
  return {
    updates: new UpdateOrchestrator({
      projectDir: "/project",
      releases: fake,
      releaseState: () => state,
      backup:
        options.backup ??
        (async () => {
          calls.push("backup")
          return { ok: true, message: "已备份。", steps: [] }
        }),
      updateTarget: () => ({ channel: "stable", ref: "origin/main" }),
      releaseVersion: () => "0.4.0",
      hasGit: () => options.hasGit ?? true,
      hasNpm: () => options.hasNpm ?? true,
    }),
    state: () => state,
    calls,
  }
}

test("update orchestrator backs up before building and records the pending release", async () => {
  const next = release("new", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  const h = makeHarness({
    build: { ok: true, message: "预构建完成。", steps: [], release: next },
  })
  const result = await h.updates.updateProject()
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls, ["backup", "build"])
  assert.equal(h.state().pending?.id, "new")
  assert.equal(h.state().current, undefined)
  assert.equal(h.state().lastUpdate?.status, "ok")
  assert.match(result.message, /重启 Bot/)
})

test("update orchestrator aborts before building when the backup fails", async () => {
  const h = makeHarness({
    backup: async () => ({ ok: false, message: "磁盘已满", steps: [] }),
    build: { ok: true, message: "should not run", steps: [], release: release("new", "bbbb") },
  })
  const result = await h.updates.updateProject()
  assert.equal(result.ok, false)
  assert.match(result.message, /自动备份失败/)
  assert.deepEqual(h.calls, [])
  assert.equal(h.state().pending, undefined)
})

test("update orchestrator treats an empty first-run data directory as a successful backup", async () => {
  const next = release("new", "cccccccccccccccccccccccccccccccccccccccc")
  const h = makeHarness({
    backup: async () => ({ ok: false, message: "data 目录里还没有可备份的状态文件。", steps: [] }),
    build: { ok: true, message: "预构建完成。", steps: [], release: next },
  })
  const result = await h.updates.updateProject()
  assert.equal(result.ok, true)
  assert.equal(h.state().pending?.id, "new")
})

test("update orchestrator refuses to start without git or npm", async () => {
  const noGit = makeHarness({ hasGit: false })
  assert.match((await noGit.updates.updateProject()).message, /未找到 git/)
  const noNpm = makeHarness({ hasNpm: false })
  assert.match((await noNpm.updates.updateProject()).message, /未找到 npm/)
})

test("a failed staging build records a failure and leaves no pending release", async () => {
  const h = makeHarness({ build: { ok: false, steps: [], message: "构建失败，已停止切换。" } })
  const result = await h.updates.updateProject()
  assert.equal(result.ok, false)
  assert.match(result.message, /构建失败/)
  assert.equal(h.state().pending, undefined)
  assert.equal(h.state().lastUpdate?.status, "failed")
})

test("cancel pending clears only the pending pointer and rollback swaps current/previous", () => {
  const old = release("old", "aaaa", "0.4.0")
  const next = release("pending", "bbbb")
  const h = makeHarness({ initial: { current: old, pending: next } })
  const cancelled = h.updates.cancelPending()
  assert.equal(cancelled.ok, true)
  assert.equal(h.state().current?.id, "old")
  assert.equal(h.state().pending, undefined)

  const rollbackHarness = makeHarness({ initial: { current: next, previous: old } })
  const rolled = rollbackHarness.updates.rollback()
  assert.equal(rolled.ok, true)
  assert.equal(rollbackHarness.state().current?.id, "old")
  assert.equal(rollbackHarness.state().previous?.id, "pending")
  assert.equal(rollbackHarness.state().lastUpdate?.status, "rolled-back")
})
