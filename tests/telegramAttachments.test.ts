import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Bot } from "grammy"
import type { Message } from "grammy/types"
import type { BotConfig } from "../src/config.js"
import type { Logger } from "../src/logger.js"
import type { Opencode } from "../src/opencode.js"
import { TelegramAttachments } from "../src/telegramAttachments.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "bot-attachments-"))
  const cfg = { inboxDir: dir, maxInputBytes: 20 * 1024 * 1024, stt: undefined } as unknown as BotConfig
  const oc = { inputCapabilities: async () => undefined } as unknown as Opencode
  const commands = new TelegramAttachments({
    bot: {} as Bot,
    cfg,
    oc,
    maskToken: (text) => text,
    log,
  })
  return { commands, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("collectAttachments classifies photos, documents, voice and audio", () => {
  const h = harness()
  try {
    const message = {
      photo: [{ file_id: "photo-12345678", file_size: 100 }],
      document: { file_id: "doc-12345678", file_name: "report.pdf", mime_type: "application/pdf", file_size: 200 },
      voice: { file_id: "voice-12345678", mime_type: "audio/ogg", file_size: 300 },
      audio: { file_id: "audio-12345678", mime_type: "audio/mpeg", file_size: 400 },
    } as unknown as Message
    const result = h.commands.collectAttachments(message)
    assert.equal(result.length, 4)
    assert.equal(result[0]?.kind, "image")
    assert.equal(result[0]?.name, "photo-12345678.jpg")
    assert.equal(result[1]?.kind, "document")
    assert.equal(result[1]?.name, "report.pdf")
    assert.equal(result[2]?.kind, "audio")
    assert.equal(result[3]?.kind, "audio")
  } finally {
    h.cleanup()
  }
})

test("collectAttachments caps the batch at four and handles empty messages", () => {
  const h = harness()
  try {
    const empty = h.commands.collectAttachments({} as Message)
    assert.deepEqual(empty, [])
    const message = {
      photo: [{ file_id: "p1", file_size: 1 }],
      document: { file_id: "d1", file_name: "a.bin", mime_type: "application/octet-stream" },
      voice: { file_id: "v1", mime_type: "audio/ogg" },
      audio: { file_id: "a2", mime_type: "audio/mpeg" },
    } as unknown as Message
    assert.equal(h.commands.collectAttachments(message).length, 4)
  } finally {
    h.cleanup()
  }
})
