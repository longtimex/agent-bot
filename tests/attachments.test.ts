import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import test from "node:test"
import { buildAttachmentSections } from "../src/attachmentInput.js"
import { OPENCODE_ATTACHMENT_LIMIT } from "../src/opencode.js"
import {
  isTextAttachment,
  pruneInbox,
  readTextAttachment,
  sanitizeFilename,
  saveAttachment,
} from "../src/attachments.js"

test("sanitizeFilename strips paths and unsafe characters", () => {
  assert.equal(sanitizeFilename("../../etc/passwd", "file.bin"), "passwd")
  assert.equal(sanitizeFilename("my report (final).pdf", "file.bin"), "my_report_(final).pdf")
  assert.equal(sanitizeFilename("***", "fallback.txt"), "fallback.txt")
  assert.equal(sanitizeFilename("report.ts", "file.bin"), "report.ts")
})

test("isTextAttachment detects code and text files", () => {
  assert.equal(isTextAttachment("application/octet-stream", "main.ts"), true)
  assert.equal(isTextAttachment("text/plain", "notes.bin"), true)
  assert.equal(isTextAttachment("application/json", "data.json"), true)
  assert.equal(isTextAttachment("image/jpeg", "photo.jpg"), false)
  assert.equal(isTextAttachment("application/pdf", "doc.pdf"), false)
})

test("saveAttachment writes the file and readTextAttachment truncates", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-"))
  try {
    const saved = saveAttachment(dir, 42, "app.log", Buffer.from("hello\nworld"))
    assert.equal(existsSync(saved.path), true)
    assert.equal(readFileSync(saved.path, "utf8"), "hello\nworld")
    assert.match(saved.name, /^42-\d+-app\.log$/)

    const { text, truncated } = readTextAttachment(saved.path, 5)
    assert.equal(text, "hello")
    assert.equal(truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveAttachment never overwrites an earlier upload with the same name", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 })
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-collision-"))
  try {
    const first = saveAttachment(dir, 42, "notes.txt", Buffer.from("first"))
    const second = saveAttachment(dir, 42, "notes.txt", Buffer.from("second"))
    assert.notEqual(first.path, second.path)
    assert.match(first.name, /^42-\d+-notes\.txt$/)
    assert.match(second.name, /^42-\d+-notes-1\.txt$/)
    assert.equal(readFileSync(first.path, "utf8"), "first")
    assert.equal(readFileSync(second.path, "utf8"), "second")
  } finally {
    t.mock.timers.reset()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pruneInbox removes expired files but keeps fresh ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-"))
  try {
    const oldFile = join(dir, "old.txt")
    const freshFile = join(dir, "fresh.txt")
    writeFileSync(oldFile, "old")
    writeFileSync(freshFile, "fresh")
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(oldFile, past, past)

    assert.equal(pruneInbox(dir, 24 * 60 * 60 * 1000), 1)
    assert.equal(existsSync(oldFile), false)
    assert.equal(existsSync(freshFile), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readTextAttachment never cuts a multi-byte character in half", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-"))
  try {
    const path = join(dir, "emoji.txt")
    writeFileSync(path, "abcd😀ef")
    const { text, truncated } = readTextAttachment(path, 5)
    assert.equal(text, "abcd", "a lone high surrogate would reach the prompt and the OpenCode JSON")
    assert.equal(truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readTextAttachment reads only the window it returns", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-"))
  try {
    const path = join(dir, "sparse.log")
    writeFileSync(path, "head")
    truncateSync(path, 128 * 1024 * 1024)
    const started = performance.now()
    const { text, truncated } = readTextAttachment(path, 1000)
    const elapsed = performance.now() - started

    assert.equal(text.length, 1000)
    assert.equal(truncated, true)
    assert.ok(elapsed < 50, `a 1 KB window took ${Math.round(elapsed)} ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveAttachment keeps uploads private to the service account", () => {
  // Uploaded files often carry API keys; a world-readable copy would expose them
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-mode-"))
  try {
    const inbox = join(dir, "inbox")
    const saved = saveAttachment(inbox, 42, ".env", Buffer.from("API_KEY=x"))
    assert.equal(statSync(saved.path).mode & 0o777, 0o600)
    assert.equal(statSync(inbox).mode & 0o777, 0o700)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveAttachment tightens an inbox directory created with a permissive umask", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-umask-"))
  try {
    const inbox = join(dir, "inbox")
    mkdirSync(inbox, { recursive: true })
    chmodSync(inbox, 0o775)
    const saved = saveAttachment(inbox, 42, "secret.txt", Buffer.from("token"))
    assert.equal(statSync(saved.path).mode & 0o777, 0o600)
    assert.equal(statSync(inbox).mode & 0o777, 0o700, "an already-existing inbox must not stay group/other-readable")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A CLI engine is spawned in the session work dir, which /dir (and the App's picker) can point
 * anywhere. A manifest path relative to the Bot's own cwd names nothing there, so the file the
 * user sent stops existing for the engine.
 */
test("the manifest names attachments by absolute path so any engine cwd resolves them", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-manifest-"))
  try {
    const text = saveAttachment(dir, 7, "notes.txt", Buffer.from("inline me"))
    const image = saveAttachment(dir, 7, "pixel.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const input = buildAttachmentSections("看一下", {
      saved: [
        { fileId: "f1", kind: "document", name: "notes.txt", mime: "text/plain", path: text.path, bytes: 9, text: "inline me" },
        { fileId: "f2", kind: "image", name: "pixel.png", mime: "image/png", path: image.path, bytes: 4 },
      ],
    })
    const listed = [...input.text.matchAll(/^- (?:文件|图片|音频): (\S+) /gm)].map((m) => m[1]!)
    assert.equal(listed.length, 2, "both attachments are listed for the engine")
    assert.ok(listed.every((p) => isAbsolute(p)), `manifest paths must be absolute, got ${listed.join(", ")}`)
    assert.ok(input.text.includes(`<file name="${text.path}">`), "the inlined copy carries the same path")
    assert.equal(input.files.length, 1, "the image still rides as a file reference")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("videos keep their own kind and default instruction", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-video-"))
  try {
    const video = saveAttachment(dir, 8, "clip.mp4", Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))
    const input = buildAttachmentSections("", {
      saved: [
        { fileId: "v1", kind: "video", name: "clip.mp4", mime: "video/mp4", path: video.path, bytes: 8 },
      ],
    })
    assert.match(input.text, /请查看并分析用户发送的视频/)
    assert.match(input.text, /^- 视频: .*clip\.mp4/m)
    assert.equal(input.files.length, 1, "a model with unknown capabilities still receives the video")
    assert.equal(input.files[0]?.mime, "video/mp4")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a model that rejects video is told where the saved file is instead of losing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-video-caps-"))
  try {
    const video = saveAttachment(dir, 9, "clip.mp4", Buffer.from("not-a-real-video"))
    const input = buildAttachmentSections("分析这个视频", {
      saved: [
        { fileId: "v2", kind: "video", name: "clip.mp4", mime: "video/mp4", path: video.path, bytes: 16 },
      ],
      modelCapabilities: { video: false },
    })
    assert.equal(input.files.length, 0)
    assert.match(input.text, /不支持视频输入/)
    assert.ok(input.text.includes(video.path), "the model can still inspect the file by absolute path")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a supported video is attached as a data file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-video-supported-"))
  try {
    const video = saveAttachment(dir, 10, "clip.mp4", Buffer.from("video-bytes"))
    const input = buildAttachmentSections("看看", {
      saved: [
        { fileId: "v3", kind: "video", name: "clip.mp4", mime: "video/mp4", path: video.path, bytes: 11 },
      ],
      modelCapabilities: { video: true },
    })
    assert.equal(input.files.length, 1)
    assert.deepEqual(input.files[0], { mime: "video/mp4", filename: "clip.mp4", path: video.path, size: 11 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("old 10MB and 15MB project ceilings no longer reject an attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-unlimited-"))
  try {
    const videoPath = join(dir, "large.mp4")
    writeFileSync(videoPath, "")
    truncateSync(videoPath, 16 * 1024 * 1024)
    const video = buildAttachmentSections("看看", {
      saved: [{ fileId: "v4", kind: "video", name: "large.mp4", mime: "video/mp4", path: videoPath, bytes: 16 * 1024 * 1024 }],
      modelCapabilities: { video: true },
    })
    assert.equal(video.files.length, 1)
    assert.equal(video.files[0]?.path, videoPath)

    const imagePath = join(dir, "large.png")
    writeFileSync(imagePath, "")
    truncateSync(imagePath, 11 * 1024 * 1024)
    const image = buildAttachmentSections("看看", {
      saved: [{ fileId: "i4", kind: "image", name: "large.png", mime: "image/png", path: imagePath, bytes: 11 * 1024 * 1024 }],
      modelCapabilities: { image: true },
    })
    assert.equal(image.files.length, 1, "the removed 10MB image ceiling must not linger")
    assert.doesNotMatch(image.text, /图片过大/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a file above OpenCode's own 20MB attachment ceiling keeps its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-opencode-limit-"))
  try {
    const videoPath = join(dir, "huge.mp4")
    writeFileSync(videoPath, "")
    truncateSync(videoPath, OPENCODE_ATTACHMENT_LIMIT + 1)
    const input = buildAttachmentSections("看看", {
      saved: [{
        fileId: "v5",
        kind: "video",
        name: "huge.mp4",
        mime: "video/mp4",
        path: videoPath,
        bytes: OPENCODE_ATTACHMENT_LIMIT + 1,
      }],
      modelCapabilities: { video: true },
    })
    assert.equal(input.files.length, 0, "OpenCode's platform limit still applies to direct attachments")
    assert.ok(input.text.includes(videoPath), "the whole file stays available through its absolute path")
    assert.match(input.text, /OpenCode 单附件 20MB/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("attachmentKind separates video from documents", async () => {
  const { attachmentKind } = await import("../src/attachments.js")
  assert.equal(attachmentKind("image/png"), "image")
  assert.equal(attachmentKind("audio/mp4"), "audio")
  assert.equal(attachmentKind("video/quicktime"), "video")
  assert.equal(attachmentKind("application/pdf"), "document")
  assert.equal(attachmentKind("application/octet-stream", "clip.MP4"), "video")
  assert.equal(attachmentKind("", "voice.m4a"), "audio")
  assert.equal(attachmentKind("application/octet-stream", "scan.jpeg"), "image")
  assert.equal(attachmentKind("application/octet-stream", "archive.zip"), "document")
})

test("media download MIME covers the formats attachments accept", async () => {
  const { mimeForName } = await import("../src/apiHttp.js")
  assert.equal(mimeForName("voice.opus"), "audio/ogg")
  assert.equal(mimeForName("voice.aac"), "audio/aac")
  assert.equal(mimeForName("voice.amr"), "audio/amr")
  assert.equal(mimeForName("clip.m4v"), "video/mp4")
  assert.equal(mimeForName("clip.mkv"), "video/x-matroska")
  assert.equal(mimeForName("clip.3gp"), "video/3gpp")
})

test("pruneInbox deletes an expired symlink itself and never follows it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-attachments-"))
  try {
    // 目标放在 inbox 目录之外:链接即使过期也只应删除链接本身
    const targetDir = join(dir, "outside")
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, "keep-me.txt")
    writeFileSync(target, "keep me")
    const link = join(dir, "stale-link.txt")
    symlinkSync(target, link)
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(link, past, past)

    const pruned = pruneInbox(dir)
    assert.equal(pruned, 1)
    assert.equal(existsSync(link), false, "the expired symlink is removed")
    assert.equal(existsSync(target), true, "the link target outside the inbox is untouched")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
