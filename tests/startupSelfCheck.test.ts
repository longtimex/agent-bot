import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readStartupSelfCheck, writeStartupFailure, writeStartupSelfCheck } from "../src/startupSelfCheck.js"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-startup-check-"))
}

test("startup self-check writes an atomic private snapshot and an append-only history", () => {
  const dir = tempDir()
  try {
    const check = {
      at: "2026-01-02T03:04:05.000Z",
      version: "0.5.0",
      pid: 1234,
      release: "release-new",
      migration: { ok: true, toVersion: 1, message: "数据 schema 已是最新（v1）。" },
      notes: ["HTTP API 已启动"],
    }
    const path = writeStartupSelfCheck(dir, check)
    const first = readStartupSelfCheck(dir)
    assert.deepEqual(first, check)
    assert.equal(path, join(dir, "startup-check.json"))
    assert.equal(statSync(path).mode & 0o777, 0o600)

    writeStartupSelfCheck(dir, { ...check, at: "2026-01-02T03:04:06.000Z" })
    const lines = readFileSync(join(dir, "startup-checks.jsonl"), "utf8").trim().split("\n")
    assert.equal(lines.length, 2)
    assert.equal((JSON.parse(lines[1]!) as { at: string }).at, "2026-01-02T03:04:06.000Z")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reading a malformed self-check returns undefined instead of throwing", () => {
  const dir = tempDir()
  try {
    assert.equal(readStartupSelfCheck(dir), undefined)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "startup-check.json"), "{not-json")
    assert.equal(readStartupSelfCheck(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("startup failure is recorded for the supervisor, and a write failure never masks the original error", () => {
  const dir = tempDir()
  try {
    writeStartupFailure(dir, "Telegram token rejected", { version: "0.5.0", pid: 4321 })
    const check = readStartupSelfCheck(dir)
    assert.equal(check?.failure, "Telegram token rejected")
    assert.equal(check?.version, "0.5.0")
    assert.equal(check?.pid, 4321)
    assert.match(check?.notes.join("\n") ?? "", /启动失败/)

    // A file where the data directory should be makes both writes fail. The
    // helper must stay silent because it is called while handling the real error.
    assert.doesNotThrow(() => writeStartupFailure(join(dir, "startup-check.json"), "bind failed"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
