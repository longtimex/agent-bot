import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import { liveSessions, parseArgs } from "../src/model-cli.js"
import { SessionStore } from "../src/store.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("parseArgs accepts --key=value and --key value forms", () => {
  const parsed = parseArgs(["add", "fast", "custom/x", "--label=Fast", "--desc", "Very fast", "--attach"])
  assert.deepEqual(parsed.positionals, ["add", "fast", "custom/x"])
  assert.equal(parsed.flags.get("--label"), "Fast")
  assert.equal(parsed.flags.get("--desc"), "Very fast")
  assert.equal(parsed.flags.get("--attach"), true)
})

test("parseArgs rejects a value flag followed by another flag", () => {
  // `--label --desc x` would otherwise store the literal label "--desc"
  assert.throws(() => parseArgs(["add", "k", "p/m", "--label", "--desc", "x"]), /--label 缺少参数值/)
  assert.throws(() => parseArgs(["add", "k", "p/m", "--output"]), /--output 缺少参数值/)
})

test("liveSessions reads the file on every call so a concurrent Bot write survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-model-cli-"))
  try {
    const path = join(dir, "sessions.json")
    const seed = new SessionStore(path, log)
    seed.set("tg:1", "ses_1")
    seed.setModel("tg:1", { providerID: "custom", modelID: "x", label: "X" })

    const sessions = liveSessions(path)
    // The Bot picks a model for another chat after the CLI captured its handle
    const bot = new SessionStore(path, log)
    bot.set("tg:2", "ses_2")
    bot.setModel("tg:2", { providerID: "custom", modelID: "y", label: "Y" })

    assert.equal(sessions.clearModel("tg:1"), true)
    const after = new SessionStore(path, log)
    assert.equal(after.getModel("tg:1"), undefined, "the targeted chat must be reset")
    assert.equal(after.getModel("tg:2")?.modelID, "y", "a chat saved meanwhile must not be lost")
    assert.equal(after.get("tg:2"), "ses_2")

    assert.deepEqual(
      sessions.listModelRefs().map((ref) => ref.key),
      ["tg:2"],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
