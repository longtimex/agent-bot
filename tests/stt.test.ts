import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig, StartupConfigError } from "../src/config.js"
import { buildAttachmentSections } from "../src/attachmentInput.js"
import { applyStt, transcribeAudio, type SttConfig } from "../src/stt.js"
import type { SavedAttachment } from "../src/attachments.js"

const STT: SttConfig = { baseUrl: "https://stt.example/v1", apiKey: "sk-test", model: "whisper-1" }

function audioItem(overrides: Partial<SavedAttachment> = {}): SavedAttachment {
  return {
    kind: "audio",
    name: "voice.ogg",
    mime: "audio/ogg",
    path: "/tmp/voice.ogg",
    bytes: 1000,
    ...overrides,
  }
}

function fakeFetch(response: unknown, ok = true, status = 200): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(url), init })
    return new Response(ok ? JSON.stringify(response) : String(response), { status: ok ? 200 : status })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

test("transcribeAudio posts the file to /audio/transcriptions with model and auth", async () => {
  const { fetch, calls } = fakeFetch({ text: "  你好，记得喝水  " })
  const text = await transcribeAudio("/tmp/voice.ogg", STT, { fetchImpl: fetch, readFile: () => Buffer.from("ogg") })
  assert.equal(text, "你好，记得喝水")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, "https://stt.example/v1/audio/transcriptions")
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer sk-test")
  const form = calls[0]!.init.body as FormData
  assert.equal(form.get("model"), "whisper-1")
  const file = form.get("file")
  assert.ok(file instanceof File)
  assert.equal(file.name, "voice.ogg")
})

test("transcribeAudio forwards language when configured", async () => {
  const { fetch, calls } = fakeFetch({ text: "hi" })
  await transcribeAudio("/tmp/v.ogg", { ...STT, language: "zh" }, { fetchImpl: fetch, readFile: () => Buffer.alloc(0) })
  assert.equal((calls[0]!.init.body as FormData).get("language"), "zh")
})

test("transcribeAudio raises on http errors and empty results", async () => {
  const bad = fakeFetch("quota exceeded", false, 429)
  await assert.rejects(
    transcribeAudio("/tmp/v.ogg", STT, { fetchImpl: bad.fetch, readFile: () => Buffer.alloc(0) }),
    /HTTP 429/,
  )
  const empty = fakeFetch({ text: "   " })
  await assert.rejects(
    transcribeAudio("/tmp/v.ogg", STT, { fetchImpl: empty.fetch, readFile: () => Buffer.alloc(0) }),
    /空结果/,
  )
})

test("applyStt only rewrites audio the model cannot accept", async () => {
  const { fetch } = fakeFetch({ text: "转写内容" })
  const deps = { fetchImpl: fetch, readFile: () => Buffer.alloc(0) }
  const voice = audioItem()
  const image = audioItem({ kind: "image", name: "pic.png", mime: "image/png", path: "/tmp/pic.png" })

  // The model rejects audio: every voice note becomes inline text, images untouched
  const result = await applyStt([voice, image], { stt: STT, modelCapabilities: { audio: false } }, deps)
  assert.match(result.saved[0]!.text!, /语音转写/)
  assert.match(result.saved[0]!.text!, /转写内容/)
  assert.equal(result.saved[1]!.text, undefined)
  assert.deepEqual(result.errors, [])

  // The model accepts audio: items pass through untouched
  const accepted = audioItem({ name: "song.mp3", path: "/tmp/song.mp3" })
  const passthrough = await applyStt([accepted], { stt: STT, modelCapabilities: { audio: true } }, deps)
  assert.equal(passthrough.saved[0]!.text, undefined, "audio the model accepts must stay attached as data")
})

test("applyStt is a pass-through without a config and collects failures per file", async () => {
  const untouched = audioItem()
  const off = await applyStt([untouched], { modelCapabilities: { audio: false } })
  assert.equal(off.saved[0]!.text, undefined)
  assert.equal(off.saved[0], untouched, "no config must not clone or touch items")

  const failing = fakeFetch("boom", false, 500)
  const result = await applyStt([audioItem()], { stt: STT, modelCapabilities: { audio: false } }, {
    fetchImpl: failing.fetch,
    readFile: () => Buffer.alloc(0),
  })
  assert.equal(result.saved[0]!.text, undefined, "a failed transcription keeps the original item")
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0]!, /voice.ogg/)
})

test("transcribed voice renders as inline text instead of the transcribe-me header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-stt-"))
  try {
    const path = join(dir, "voice.ogg")
    writeFileSync(path, "ogg")
    const transcribed = audioItem({ path, text: "（语音转写）\n帮我看看今天的安排" })
    const out = buildAttachmentSections("", { saved: [transcribed], modelCapabilities: { audio: false } })
    assert.doesNotMatch(out.text, /请转写这段音频/)
    assert.match(out.text, /帮我看看今天的安排/)
    assert.match(out.text, /- 音频: /)
    assert.equal(out.files.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadConfig parses the STT block and rejects a bad base url", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7" }
  assert.equal(loadConfig(base).stt, undefined)
  const on = loadConfig({ ...base, STT_BASE_URL: "https://api.groq.com/openai/v1", STT_API_KEY: "gsk", STT_LANGUAGE: "zh" })
  assert.deepEqual(on.stt, {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "gsk",
    model: "whisper-1",
    language: "zh",
  })
  assert.throws(() => loadConfig({ ...base, STT_BASE_URL: "ftp://x" }), StartupConfigError)
})
