import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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
