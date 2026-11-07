import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createLogger, rotateLogIfNeeded, pruneRotatedLogs } from "../src/logger.js"

test("rotateLogIfNeeded copies and truncates an oversized log", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-log-"))
  try {
    const path = join(dir, "bot.log")
    writeFileSync(path, "x".repeat(2048))

    const rotated = rotateLogIfNeeded(path, 1024, Date.UTC(2026, 9, 28, 12, 0, 0))
    assert.ok(rotated)
    assert.equal(readFileSync(path, "utf8"), "")
    assert.equal(readFileSync(rotated as string, "utf8").length, 2048)
    assert.equal(readdirSync(dir).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rotateLogIfNeeded leaves small or missing logs alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-log-"))
  try {
    const path = join(dir, "bot.log")
    assert.equal(rotateLogIfNeeded(path, 1024), undefined)

    writeFileSync(path, "small")
    assert.equal(rotateLogIfNeeded(path, 1024), undefined)
    assert.equal(readFileSync(path, "utf8"), "small")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pruneRotatedLogs keeps only the newest rotated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-log-"))
  try {
    const path = join(dir, "bot.log")
    writeFileSync(path, "current")
    for (let i = 1; i <= 9; i++) {
      writeFileSync(`${path}.2026102${i}-000000`, `old-${i}`)
    }

    assert.equal(pruneRotatedLogs(path, 3), 6)
    const left = readdirSync(dir).sort()
    assert.deepEqual(left, [
      "bot.log",
      "bot.log.20261027-000000",
      "bot.log.20261028-000000",
      "bot.log.20261029-000000",
    ])
    assert.equal(pruneRotatedLogs(path, 3), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("createLogger keeps credentials out of every line it writes", () => {
  const captured: unknown[][] = []
  const sinks = { log: console.log, warn: console.warn, error: console.error }
  const restore = (): void => {
    console.log = sinks.log
    console.warn = sinks.warn
    console.error = sinks.error
  }
  console.log = (...args: unknown[]) => captured.push(args)
  console.warn = (...args: unknown[]) => captured.push(args)
  console.error = (...args: unknown[]) => captured.push(args)
  try {
    const log = createLogger("debug")
    log.info("provider add failed", "api_key: sk-proj-abcdef0123456789")
    log.error("telegram getMe failed", "7654321098:AAHabcdEfghIjklMnopQrstUvwxYZ1234")
    log.warn("proxy env written", "socks5://user:s3cret@proxy.test:1080")
  } finally {
    restore()
  }

  const text = captured.map((args) => args.join(" ")).join("\n")
  assert.ok(!text.includes("sk-proj-abcdef0123456789"), text)
  assert.ok(!text.includes("7654321098:AAHabcdEfghIjklMnopQrstUvwxYZ1234"), text)
  assert.ok(!text.includes("s3cret"), text)
  assert.ok(text.includes("provider add failed"), text)
})
