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
  const cfg = { inboxDir: dir, maxInputBytes: 0, stt: undefined } as unknown as BotConfig
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

function downloadHarness(fileBytes: number) {
  let fetchCalls = 0
  const bot = {
    api: {
      getFile: async () => ({ file_path: "files/media" }),
    },
  } as unknown as Bot
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response(Buffer.alloc(fileBytes, 1), { status: 200 })
  }) as typeof fetch
  const cfg = {
    inboxDir: mkdtempSync(join(tmpdir(), "bot-attachments-download-")),
    maxInputBytes: 0,
    telegram: { token: "test-token" },
  } as unknown as BotConfig
  const commands = new TelegramAttachments({
    bot,
    cfg,
    oc: { inputCapabilities: async () => ({ image: true, audio: true, video: true, pdf: true }) } as unknown as Opencode,
    maskToken: (text) => text,
    log,
  })
  return {
    commands,
    fetchCalls: () => fetchCalls,
    restore: () => {
      globalThis.fetch = originalFetch
      rmSync((cfg as unknown as { inboxDir: string }).inboxDir, { recursive: true, force: true })
    },
  }
}

test("a 16MB video is no longer rejected by the removed project ceiling", async () => {
  const h = downloadHarness(16 * 1024 * 1024)
  try {
    const input = await h.commands.buildAttachmentInput(
      {
        key: 1,
        chatId: 1,
        text: "看看这个视频",
        attachments: [{
          fileId: "video-large",
          kind: "video",
          name: "clip.mp4",
          mime: "video/mp4",
          size: 16 * 1024 * 1024,
        }],
      } as never,
      { providerID: "custom", modelID: "video" },
    )
    assert.equal(input.files.length, 1, "a 16MB video must be attached")
    assert.doesNotMatch(input.text, /超过|上限/)
  } finally {
    h.restore()
  }
})

test("an image above the old 10MB ceiling is downloaded instead of refused", async () => {
  const h = downloadHarness(11 * 1024 * 1024)
  try {
    const input = await h.commands.buildAttachmentInput(
      {
        key: 1,
        chatId: 1,
        text: "看看这张图",
        attachments: [{
          fileId: "image-large",
          kind: "image",
          name: "photo.jpg",
          mime: "image/jpeg",
          size: 11 * 1024 * 1024,
        }],
      } as never,
    )
    assert.equal(h.fetchCalls(), 1, "the declared size must not be refused before downloading")
    assert.equal(input.files.length, 1)
    assert.doesNotMatch(input.text, /超过|上限/)
  } finally {
    h.restore()
  }
})

test("Telegram's own 20MB getFile ceiling is reported as a platform limit", async () => {
  const h = downloadHarness(20 * 1024 * 1024 + 1)
  try {
    const input = await h.commands.buildAttachmentInput(
      {
        key: 1,
        chatId: 1,
        text: "看看这个视频",
        attachments: [{
          fileId: "video-platform-limit",
          kind: "video",
          name: "clip.mp4",
          mime: "video/mp4",
        }],
      } as never,
    )
    assert.equal(input.files.length, 0)
    assert.match(input.text, /Telegram Bot API 单文件下载上限为 20MB/)
  } finally {
    h.restore()
  }
})

test("collectAttachments classifies photos, documents, voice, audio and video", () => {
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
    const video = h.commands.collectAttachments({
      video: { file_id: "video-12345678", file_name: "clip.mp4", mime_type: "video/mp4", file_size: 500 },
    } as unknown as Message)
    assert.equal(video[0]?.kind, "video", "a video is not a generic document")
    assert.equal(video[0]?.name, "clip.mp4")
    const opaqueVideo = h.commands.collectAttachments({
      document: { file_id: "video-87654321", file_name: "phone-clip.MOV", mime_type: "application/octet-stream" },
    } as unknown as Message)
    assert.equal(opaqueVideo[0]?.kind, "video", "a provider's generic MIME must not erase a video's kind")
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
