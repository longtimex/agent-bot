import assert from "node:assert/strict"
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
