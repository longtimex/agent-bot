import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import { ApprovalManager, assessHighRisk, type PendingApprovalView } from "../src/approvals.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("assessHighRisk detects dangerous commands in auto vs strict vs off modes", () => {
  assert.ok(assessHighRisk("请帮我执行 rm -rf /tmp/demo", "auto"))
  assert.ok(assessHighRisk("run git push --force origin main", "auto"))
  assert.ok(assessHighRisk("DROP TABLE users;", "auto"))
  assert.equal(assessHighRisk("帮我列出当前目录文件", "auto"), undefined)
  assert.equal(assessHighRisk("sudo systemctl status nginx", "auto"), undefined)
  assert.ok(assessHighRisk("sudo systemctl status nginx", "strict"))
  assert.equal(assessHighRisk("rm -rf /", "off"), undefined)
})

test("ApprovalManager pauses high-risk prompts until approved once, always, or rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-approvals-"))
  try {
    const path = join(dir, "approvals.json")
    const mgr = new ApprovalManager(path, log, {})
    const cards: PendingApprovalView[] = []
    mgr.onRequest((item) => cards.push(item))

    // 1. Approve once
    const p1 = mgr.guardPrompt("tg:1", "请执行 rm -rf build/")
    assert.equal(mgr.listPending().length, 1)
    assert.equal(cards.length, 1)
    const d1 = mgr.decide(cards[0]!.id, "once")
    assert.equal(d1.ok, true)
    await p1
    assert.equal(mgr.listPending().length, 0)

    // 2. Reject cancels execution
    const p2 = mgr.guardPrompt("tg:1", "执行 git push --force")
    assert.equal(cards.length, 2)
    mgr.decide(cards[1]!.id, "reject")
    await assert.rejects(p2, /未获批准/)

    // 3. Approve always caches patternKey for this session
    const p3 = mgr.guardPrompt("tg:1", "再执行一次 rm -rf dist/")
    assert.equal(cards.length, 3)
    mgr.decide(cards[2]!.id, "always")
    await p3
    // Next rm -rf in same session auto-passes without creating a new card
    await mgr.guardPrompt("tg:1", "rm -rf out/")
    assert.equal(cards.length, 3)
    // Clearing session allows re-arms the guard
    mgr.clearSessionAllows("tg:1")
    const ac = new AbortController()
    const p4 = mgr.guardPrompt("tg:1", "rm -rf cache/", ac.signal)
    assert.equal(cards.length, 4)
    ac.abort()
    await assert.rejects(p4, /未获批准/)

    // 4. Mode persists across restarts
    mgr.setMode("strict")
    const reloaded = new ApprovalManager(path, log, {})
    assert.equal(reloaded.mode, "strict")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
