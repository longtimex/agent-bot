import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { loadConfig } from "../src/config.js"

test("loadConfig refuses to start without a whitelist", () => {
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "token" }), /TELEGRAM_ALLOW_USERS/)
})

test("loadConfig can start with Feishu alone", () => {
  const cfg = loadConfig({
    FEISHU_APP_ID: "cli_0123456789abcdef",
    FEISHU_APP_SECRET: "secret",
    FEISHU_ALLOW_OPEN_IDS: "ou_owner,ou_second",
    TELEGRAM_ALLOW_USERS: "unused-without-token",
  })
  assert.equal(cfg.telegram.token, undefined)
  assert.equal(cfg.feishu?.appId, "cli_0123456789abcdef")
  assert.deepEqual([...(cfg.feishu?.allowOpenIds ?? [])], ["ou_owner", "ou_second"])
})

test("loadConfig can start with an Android API alone, but not with the sample loopback bind", () => {
  const cfg = loadConfig({ API_ENABLED: "1", API_BIND: "192.168.1.10" })
  assert.equal(cfg.api.enabled, true)
  assert.equal(cfg.telegram.token, undefined)
  assert.equal(cfg.feishu, undefined)

  assert.throws(
    () => loadConfig({ API_ENABLED: "1", API_BIND: "127.0.0.1" }),
    /尚未配置可用的控制端/,
    "the sample .env must not count as a configured Android client",
  )
  assert.throws(() => loadConfig({ API_ENABLED: "1", API_BIND: "localhost" }), /尚未配置可用的控制端/)
  assert.throws(
    () => loadConfig({ API_BIND: "0.0.0.0" }),
    /尚未配置可用的控制端/,
    "a wildcard bind has no address the phone can use until API_PUBLIC_URL is set",
  )
  assert.throws(() => loadConfig({ API_BIND: "::" }), /尚未配置可用的控制端/)
  assert.throws(() => loadConfig({ API_ENABLED: "0", API_PUBLIC_URL: "https://bot.example.com" }), /尚未配置可用的控制端/)

  const publicUrl = loadConfig({
    API_ENABLED: "1",
    API_BIND: "0.0.0.0",
    API_PUBLIC_URL: "https://bot.example.com/agent-bot",
  })
  assert.equal(publicUrl.api.publicUrl, "https://bot.example.com/agent-bot")
})

test("loadConfig treats a concrete API bind as an Android control client", () => {
  const cfg = loadConfig({ API_ENABLED: "1", API_BIND: "192.168.1.10", API_PORT: "3080" })
  assert.equal(cfg.api.bind, "192.168.1.10")
  assert.equal(cfg.api.port, 3080)

  assert.throws(() => loadConfig({ API_ENABLED: "0", API_BIND: "192.168.1.10" }), /尚未配置可用的控制端/)
})

test("loadConfig accepts mixed-case Feishu app ids but still rejects malformed ids", () => {
  const cfg = loadConfig({
    FEISHU_APP_ID: "cli_AbCdEf0123456789",
    FEISHU_APP_SECRET: "secret",
    FEISHU_ALLOW_OPEN_IDS: "ou_owner",
  })
  assert.equal(cfg.feishu?.appId, "cli_AbCdEf0123456789")

  // The SDK's WSClient silently refuses anything that is not cli_ + 16 hex
  // characters, so a valid-looking alphanumeric ID must fail at startup.
  for (const bad of ["cli_0123", "cli_0123456789abcde-", "cli_0123456789abcdefg", "cli_0123456789ghijklmn"]) {
    assert.throws(
      () => loadConfig({ FEISHU_APP_ID: bad, FEISHU_APP_SECRET: "secret", FEISHU_ALLOW_OPEN_IDS: "ou_owner" }),
      /FEISHU_APP_ID 格式无效/,
      bad,
    )
  }
})

test("loadConfig validates Feishu credentials and whitelist at startup", () => {
  assert.throws(() => loadConfig({ FEISHU_APP_ID: "cli_0123456789abcdef" }), /必须同时配置/)
  assert.throws(
    () => loadConfig({ FEISHU_APP_ID: "app-id", FEISHU_APP_SECRET: "secret", FEISHU_ALLOW_OPEN_IDS: "ou_owner" }),
    /FEISHU_APP_ID 格式无效/,
  )
  assert.throws(
    () =>
      loadConfig({
        FEISHU_APP_ID: "cli_0123456789abcdef",
        FEISHU_APP_SECRET: "secret",
        FEISHU_ALLOW_OPEN_IDS: "owner@example.com",
      }),
    /FEISHU_ALLOW_OPEN_IDS 含无效 open_id/,
  )
  assert.throws(
    () =>
      loadConfig({
        FEISHU_APP_ID: "cli_0123456789abcdef",
        FEISHU_APP_SECRET: "secret",
      }),
    /FEISHU_ALLOW_OPEN_IDS 为空/,
  )
})

test("loadConfig allows the explicit allow-all escape hatch", () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_ALL_USERS: "1" })
  assert.equal(cfg.telegram.allowAll, true)
  assert.equal(cfg.telegram.allowUsers.size, 0)
})

test("loadConfig gates the Feishu card callback and its verification credentials", () => {
  const base = {
    FEISHU_APP_ID: "cli_0123456789abcdef",
    FEISHU_APP_SECRET: "secret",
    FEISHU_ALLOW_OPEN_IDS: "ou_owner",
  }
  assert.equal(loadConfig(base).feishu?.callback, undefined)
  assert.throws(
    () => loadConfig({ ...base, FEISHU_CALLBACK_ENABLED: "1" }),
    /需要验签凭据/,
  )
  const cfg = loadConfig({
    ...base,
    FEISHU_CALLBACK_ENABLED: "1",
    FEISHU_CALLBACK_VERIFICATION_TOKEN: "verify-token",
  })
  assert.equal(cfg.feishu?.callback?.enabled, true)
  assert.equal(cfg.feishu?.callback?.port, 3081)
  assert.equal(cfg.feishu?.callback?.bind, "127.0.0.1")
  assert.equal(cfg.feishu?.callback?.path, "/feishu/card")
  assert.equal(cfg.feishu?.callback?.verificationToken, "verify-token")
  assert.throws(
    () => loadConfig({ ...base, FEISHU_CALLBACK_PATH: "feishu/card" }),
    /FEISHU_CALLBACK_PATH 无效/,
  )
  assert.throws(
    () => loadConfig({ ...base, FEISHU_CALLBACK_PATH: "/feishu//card" }),
    /FEISHU_CALLBACK_PATH 无效/,
  )
  const encrypted = loadConfig({
    ...base,
    FEISHU_CALLBACK_ENABLED: "1",
    FEISHU_CALLBACK_ENCRYPT_KEY: "encrypt-key",
  })
  assert.equal(encrypted.feishu?.callback?.encryptKey, "encrypt-key")
})

test("loadConfig defaults both timeouts to ten minutes", () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_USERS: "1" })
  assert.equal(cfg.taskTimeoutMs, 600_000)
  assert.equal(cfg.taskMaxTimeoutMs, 600_000)
})

/**
 * The App dials this address and appends /api/v1 itself, so the value has to be the base the
 * requests land on: an origin, or the subpath a reverse proxy mounts the bot under. A query, a
 * fragment or a non-HTTP scheme would aim every request somewhere the operator did not mean, so
 * those still stop startup with the reason.
 */
test("loadConfig takes API_PUBLIC_URL as an origin or a mount subpath", () => {
  const base = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_USERS: "1" }
  assert.equal(loadConfig(base).api.publicUrl, undefined)
  assert.equal(loadConfig({ ...base, API_PUBLIC_URL: "" }).api.publicUrl, undefined)
  assert.equal(loadConfig({ ...base, API_PUBLIC_URL: "https://bot.example.com" }).api.publicUrl, "https://bot.example.com")
  assert.equal(loadConfig({ ...base, API_PUBLIC_URL: "http://192.168.1.10:3080/" }).api.publicUrl, "http://192.168.1.10:3080")

  // A bot mounted behind nginx on a shared domain: the prefix is the whole point of the setting.
  assert.equal(
    loadConfig({ ...base, API_PUBLIC_URL: "https://bot.example.com/agent-bot" }).api.publicUrl,
    "https://bot.example.com/agent-bot",
  )
  assert.equal(
    loadConfig({ ...base, API_PUBLIC_URL: "https://bot.example.com/agent-bot/" }).api.publicUrl,
    "https://bot.example.com/agent-bot",
  )
  // Operators paste the line /api prints; that is an endpoint, so the base is what remains.
  assert.equal(
    loadConfig({ ...base, API_PUBLIC_URL: "https://bot.example.com/agent-bot/api/v1" }).api.publicUrl,
    "https://bot.example.com/agent-bot",
  )
  assert.equal(
    loadConfig({ ...base, API_PUBLIC_URL: "https://bot.example.com/api/v1" }).api.publicUrl,
    "https://bot.example.com",
  )
  // Credentials in the address would be handed to every phone that scans the QR.
  assert.equal(
    loadConfig({ ...base, API_PUBLIC_URL: "https://user:pass@bot.example.com/agent" }).api.publicUrl,
    "https://bot.example.com/agent",
  )
  assert.equal(
    loadConfig({ ...base, API_PUBLIC_URL: "https://bot.example.com//" }).api.publicUrl,
    "https://bot.example.com",
  )

  for (const bad of [
    "bot.example.com",
    "ftp://bot.example.com",
    "http://:3080",
    "not a url",
    "https://bot.example.com/agent?token=1",
    "https://bot.example.com/agent#x",
    "https://bot.example.com/a//b",
  ]) {
    assert.throws(
      () => loadConfig({ ...base, API_PUBLIC_URL: bad }),
      /API_PUBLIC_URL/,
      `API_PUBLIC_URL=${bad} must be refused, not half-accepted`,
    )
  }
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

/**
 * `docker compose up` on a host that has no .env mounts an empty *directory* at that path.
 * Skipping it silently made the only symptom a missing Telegram token.
 */
test("loadConfig names the real problem when .env is a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-config-dotenv-"))
  mkdirSync(join(dir, ".env"))
  const previous = process.cwd()
  process.chdir(dir)
  try {
    assert.throws(
      () => loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOW_USERS: "1" }),
      /\.env 是一个目录/,
    )
  } finally {
    process.chdir(previous)
    rmSync(dir, { recursive: true, force: true })
  }
})
