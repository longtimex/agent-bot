import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import { loadConfig } from "../src/config.js"

test("loadConfig refuses to start without a whitelist", () => {
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "token" }), /TELEGRAM_ALLOW_USERS/)
})

test("loadConfig allows the explicit allow-all escape hatch", () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_ALL_USERS: "1" })
  assert.equal(cfg.telegram.allowAll, true)
  assert.equal(cfg.telegram.allowUsers.size, 0)
})

test("loadConfig defaults both timeouts to ten minutes", () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_USERS: "1" })
  assert.equal(cfg.taskTimeoutMs, 600_000)
  assert.equal(cfg.taskMaxTimeoutMs, 600_000)
})

test("loadConfig defaults reminder timezone to Asia/Shanghai and rejects unknown zones", () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_USERS: "1" })
  assert.equal(cfg.reminderTimezone, "Asia/Shanghai")

  assert.equal(
    loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOW_USERS: "1",
      REMINDER_TIMEZONE: "Europe/Berlin",
    }).reminderTimezone,
    "Europe/Berlin",
  )

  assert.throws(
    () =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ALLOW_USERS: "1",
        REMINDER_TIMEZONE: "Mars/Olympus",
      }),
    /REMINDER_TIMEZONE/,
  )
})

test("loadConfig normalises LOG_LEVEL case and falls back on unknown values", () => {
  const level = (value?: string): string =>
    loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOW_USERS: "1",
      ...(value === undefined ? {} : { LOG_LEVEL: value }),
    }).logLevel

  assert.equal(level("DEBUG"), "debug")
  assert.equal(level(" Warn "), "warn")
  assert.equal(level("verbose"), "info")
  assert.equal(level(), "info")
})

test("loadConfig treats empty numeric env vars as unset", () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOW_USERS: "1",
    MAX_REPLY_LENGTH: "",
    MAX_MEDIA_MB: " ",
    MAX_INPUT_MB: "",
    TASK_MAX_TIMEOUT_MS: "",
  })
  assert.equal(cfg.maxReplyLength, 1500)
  assert.equal(cfg.maxMediaBytes, 20 * 1024 * 1024)
  assert.equal(cfg.maxInputBytes, 20 * 1024 * 1024)
  assert.equal(cfg.taskMaxTimeoutMs, cfg.taskTimeoutMs)
})

test("loadConfig keeps legacy timeout env and supports a longer hard cap", () => {
  const legacy = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOW_USERS: "1",
    OPENCODE_TIMEOUT_MS: "120000",
  })
  assert.equal(legacy.taskTimeoutMs, 120_000)
  assert.equal(legacy.taskMaxTimeoutMs, 120_000)

  const extended = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOW_USERS: "1",
    TASK_MAX_TIMEOUT_MS: "1800000",
  })
  assert.equal(extended.taskMaxTimeoutMs, 1_800_000)
})

test("loadConfig resolves the agent CLI profile path", () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOW_USERS: "1",
    DATA_DIR: "/tmp/bot-data",
  })
  assert.equal(cfg.agentCli.configPath, resolve("/tmp/bot-data", "agents.json"))

  const custom = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOW_USERS: "1",
    DATA_DIR: "/tmp/bot-data",
    AGENT_CLI_CONFIG: "config/my-agents.json",
  })
  assert.equal(custom.agentCli.configPath, resolve("config/my-agents.json"))
})

test("loadConfig configures cc-switch and validates the app", () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_USERS: "1" })
  assert.equal(cfg.ccswitch.app, "opencode")
  assert.equal(cfg.ccswitch.bin, undefined)

  const custom = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOW_USERS: "1",
    CC_SWITCH_APP: "codex",
    CC_SWITCH_BIN: "/opt/cc-switch/bin/cc-switch",
  })
  assert.equal(custom.ccswitch.app, "codex")
  assert.equal(custom.ccswitch.bin, "/opt/cc-switch/bin/cc-switch")

  assert.throws(
    () =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ALLOW_USERS: "1",
        CC_SWITCH_APP: "cursor",
      }),
    /CC_SWITCH_APP/,
  )
})
