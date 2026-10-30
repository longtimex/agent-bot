import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
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
