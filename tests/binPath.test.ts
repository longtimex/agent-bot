import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { childEnv, extendedEnv, extendedPath, installerChildEnv, releaseChildEnv, scrubEnv } from "../src/binPath.js"

test("extendedPath appends existing per-user bin dirs and skips missing ones", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-path-"))
  try {
    mkdirSync(join(home, ".cargo", "bin"), { recursive: true })
    const result = extendedPath("/usr/bin:/bin", home)
    assert.ok(result.startsWith("/usr/bin:/bin"), "system entries must keep their order and priority")
    assert.ok(result.includes(join(home, ".cargo", "bin")), result)
    assert.ok(!result.includes(join(home, ".bun")), "a directory that does not exist must not be advertised")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a bin directory created after the first lookup becomes discoverable", () => {
  // npm/pip installs done from Telegram create ~/.npm-global/bin long after startup,
  // and the agent must be detected without restarting the bot
  const home = mkdtempSync(join(tmpdir(), "bot-path-late-"))
  try {
    assert.ok(!extendedPath("/usr/bin", home).includes(join(home, ".npm-global", "bin")))
    mkdirSync(join(home, ".npm-global", "bin"), { recursive: true })
    assert.ok(extendedPath("/usr/bin", home).includes(join(home, ".npm-global", "bin")))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("extendedEnv extends PATH without touching the other variables", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-path-env-"))
  try {
    mkdirSync(join(home, "bin"), { recursive: true })
    const env = extendedEnv({ PATH: `/usr/bin${":"}${home}/bin`, FOO: "bar", HOME: home })
    assert.equal(env.FOO, "bar")
    const parts = (env.PATH ?? "").split(":")
    assert.equal(parts.filter((part) => part === join(home, "bin")).length, 1, env.PATH)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("scrubEnv always removes the bot's own access control values", () => {
  const env = scrubEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    TELEGRAM_BOT_TOKEN: "123:secret",
    TELEGRAM_ALLOW_USERS: "1,2",
    TELEGRAM_ALLOW_ALL_USERS: "1",
    FEISHU_APP_ID: "cli_0123456789abcdef",
    FEISHU_APP_SECRET: "tenant-secret",
    FEISHU_ALLOW_OPEN_IDS: "ou_owner",
    FEISHU_ALLOW_ALL_USERS: "1",
    OPENCODE_SERVER_USERNAME: "bot",
    OPENCODE_SERVER_PASSWORD: "pw",
    API_TOKEN: "bearer-for-the-bot-itself",
    STT_API_KEY: "sk-transcribe",
    SNIPER_EMAIL: "me@example.com",
    SNIPER_PASSWORD: "pw",
    UNDEFINED_ONE: undefined,
    KEEP: "yes",
  })
  for (const name of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOW_USERS",
    "TELEGRAM_ALLOW_ALL_USERS",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ALLOW_OPEN_IDS",
    "FEISHU_ALLOW_ALL_USERS",
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_SERVER_PASSWORD",
    "API_TOKEN",
    "STT_API_KEY",
    "SNIPER_EMAIL",
    "SNIPER_PASSWORD",
    "UNDEFINED_ONE",
  ]) {
    assert.ok(!(name in env), `${name} must not reach a child process`)
  }
  assert.equal(env.KEEP, "yes")
})

test("a running CLI keeps its provider keys but loses the bot token", () => {
  // The CLI talks to its own provider, so dropping ANTHROPIC_API_KEY would break every agent run
  const env = childEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-x", TELEGRAM_BOT_TOKEN: "1:tok" })
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-x")
  assert.ok(!("TELEGRAM_BOT_TOKEN" in env))
  assert.ok((env.PATH ?? "").startsWith("/usr/bin"), env.PATH)
})

test("a running CLI cannot hand itself the bot's own root token", () => {
  // Approvals are bypassed by design, so an injected instruction runs real commands here:
  // API_TOKEN would let it drive git pull, npm install and /dir/browse over the bot itself
  const env = childEnv({ PATH: "/usr/bin", API_TOKEN: "0123456789abcdef", ANTHROPIC_API_KEY: "sk-ant-x" })
  assert.ok(!("API_TOKEN" in env))
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-x")
})

test("an installer drops every credential-shaped variable", () => {
  // npm runs lifecycle scripts written by the package author; those must not see secrets
  const env = installerChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-x",
    HF_TOKEN: "tok",
    DB_PASSWORD: "pw",
    GH_TOKEN: "ghp_x",
    MY_APP_SECRET: "s",
    NPM_CONFIG_REGISTRY: "https://registry.example",
    TELEGRAM_BOT_TOKEN: "1:tok",
  })
  for (const name of ["ANTHROPIC_API_KEY", "HF_TOKEN", "DB_PASSWORD", "GH_TOKEN", "MY_APP_SECRET", "TELEGRAM_BOT_TOKEN"]) {
    assert.ok(!(name in env), `${name} must not reach an installer`)
  }
  assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.example")
  assert.ok((env.PATH ?? "").startsWith("/usr/bin"), env.PATH)
})

test("a release gate does not inherit ambient Node or data routing", () => {
  // Instabox injects a headed-browser preload through NODE_OPTIONS. That module
  // belongs to the desktop wrapper, not this repository, and made every forked
  // test in the release gate fail before it could even import its test file.
  const env = releaseChildEnv({
    PATH: "/usr/bin",
    NODE_OPTIONS: "--require /usr/local/lib/instabox/headed-browser.cjs",
    DATA_DIR: "/data/workspace/live-instance/data",
    KEEP: "yes",
  })
  assert.ok(!("NODE_OPTIONS" in env))
  assert.ok(!("DATA_DIR" in env), "gate tests must use the staging checkout's own ./data")
  assert.equal(env.KEEP, "yes")
})
