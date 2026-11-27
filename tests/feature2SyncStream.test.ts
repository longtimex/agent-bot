import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { CliDraftTracker } from "../src/agentCliStream.js"
import { ChatTranscriptStore, formatAppTaskNotice } from "../src/chatTranscript.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("CliDraftTracker extracts streaming drafts for codex, gemini, claude and plain text", () => {
  const codex = new CliDraftTracker("codex-jsonl")
  assert.equal(codex.acceptLine('{"type":"thread.started","thread_id":"t1"}'), undefined)
  assert.equal(codex.acceptLine('{"type":"item.completed","item":{"type":"agent_message","text":"第一步"}}'), "第一步")
  assert.equal(codex.acceptLine('{"type":"item.completed","item":{"type":"agent_message","text":"第二步"}}'), "第一步\n\n第二步")

  const gemini = new CliDraftTracker("gemini-stream")
  assert.equal(gemini.acceptLine('{"type":"message","role":"assistant","content":"你好","delta":true}'), "你好")
  assert.equal(gemini.acceptLine('{"type":"message","role":"assistant","content":"世界","delta":true}'), "你好世界")

  const claude = new CliDraftTracker("claude-json")
  assert.equal(claude.acceptLine('{"type":"content_block_delta","delta":{"text":"Hello "}}'), "Hello")
  assert.equal(claude.acceptLine('{"type":"content_block_delta","delta":{"text":"Claude"}}'), "Hello Claude")

  const text = new CliDraftTracker("text")
  assert.equal(text.acceptLine("\u001b[32mline 1\u001b[0m"), "line 1")
  assert.equal(text.acceptLine("line 2"), "line 1\nline 2")
})

test("ChatTranscriptStore persists redacted transcripts and copies across clients on handoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-transcript-"))
  const file = join(dir, "transcripts.json")
  try {
    const store = new ChatTranscriptStore(file, log)
    store.append("tg:42", { role: "user", text: "部署用 api_key=sk-secret1234567890", source: "telegram" })
    store.append("tg:42", { role: "assistant", text: "已完成部署", engine: "claude", source: "telegram" })

    const reloaded = new ChatTranscriptStore(file, log)
    const tg = reloaded.list("tg:42")
    assert.equal(tg.length, 2)
    assert.ok(!tg[0]!.text.includes("sk-secret1234567890"), "secrets must be scrubbed from persisted transcripts")

    const copied = reloaded.copy("tg:42", "api:app")
    assert.equal(copied.length, 2)
    assert.equal(reloaded.list("api:app")[1]?.text, "已完成部署")

    const notice = formatAppTaskNotice({
      engine: "claude",
      model: "sonnet",
      ms: 65_000,
      outcome: "ok",
      prompt: "检查构建日志",
      reply: "全部通过",
    })
    assert.match(notice, /App 任务已完成/)
    assert.match(notice, /1分5秒/)
    assert.match(notice, /全部通过/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
