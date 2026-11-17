import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AccountStore } from "../src/accounts.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-account-cli-"))
  return {
    dir,
    store: () => new AccountStore(join(dir, "accounts.json"), join(dir, "accounts.key"), log),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function run(dir: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/account-cli.ts", ...args], {
    env: { ...process.env, DATA_DIR: dir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

test("account cli prints nothing but the password, so $() substitution works", () => {
  const f = fixture()
  try {
    f.store().add({ name: "Cli", username: "u1", password: "p@ss", category: "开发" })
    const out = run(f.dir, ["get", "cli"])
    assert.equal(out.trim(), "p@ss")
  } finally {
    f.close()
  }
})

test("account cli --json carries the account, url and custom fields", () => {
  const f = fixture()
  try {
    f.store().add({
      name: "Full",
      username: "me@example.com",
      password: "secret",
      category: "社交运营",
      url: "https://example.com",
      tags: ["小红书"],
      extras: { 负责人: "小王" },
    })
    const parsed = JSON.parse(run(f.dir, ["get", "Full", "--json"])) as Record<string, unknown>
    assert.equal(parsed.username, "me@example.com")
    assert.equal(parsed.password, "secret")
    assert.equal(parsed.url, "https://example.com")
    assert.deepEqual(parsed.tags, ["小红书"])
    assert.deepEqual(parsed.extras, { 负责人: "小王" })
  } finally {
    f.close()
  }
})

test("account cli list shows names and categories without any password", () => {
  const f = fixture()
  try {
    const store = f.store()
    store.add({ name: "One", username: "u1", password: "p1", category: "开发" })
    store.add({ name: "Two", username: "u2", password: "p2", category: "社交" })
    const out = run(f.dir, ["list"])
    assert.match(out, /One\t开发\tu1/)
    assert.match(out, /Two\t社交\tu2/)
    assert.ok(!out.includes("p1") && !out.includes("p2"))
  } finally {
    f.close()
  }
})

test("account cli logs every read so a leaked credential can be traced", () => {
  const f = fixture()
  try {
    f.store().add({ name: "Audited", username: "u", password: "p" })
    run(f.dir, ["get", "audited"])
    const logPath = join(f.dir, "account-access.log")
    assert.ok(existsSync(logPath), "the read must leave a line behind")
    const line = readFileSync(logPath, "utf8").trim()
    assert.match(line, /get\tAudited\tpid=/)
  } finally {
    f.close()
  }
})

test("account cli fails loudly on an unknown name", () => {
  const f = fixture()
  try {
    f.store().add({ name: "Known", username: "u", password: "p" })
    assert.throws(() => run(f.dir, ["get", "missing"]), /Command failed/)
  } finally {
    f.close()
  }
})
