import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { OPS_ENV_RULES } from "../src/ops.js"
import { startupNoticeText } from "../src/telegram.js"
import { appVersion } from "../src/version.js"

test("startup notice mentions bot name, version, timezone and the menu hint", () => {
  const text = startupNoticeText({ username: "test_bot", version: "0.2.0", opencodeOk: true, timezone: "Asia/Shanghai" })
  assert.match(text, /Bot 已上线 @test_bot/)
  assert.match(text, /v0\.2\.0/)
  assert.match(text, /✅ 可达/)
  assert.doesNotMatch(text, /不可达/)
  assert.match(text, /Asia\/Shanghai/)
  assert.match(text, /\/menu/)
})

test("startup notice omits the @name when unknown and points at serve commands when OpenCode is down", () => {
  const text = startupNoticeText({ version: "0.2.0", opencodeOk: false, timezone: "UTC" })
  assert.ok(!text.includes("@"))
  assert.match(text, /❌ 不可达/)
  assert.match(text, /npm run serve/)
  assert.match(text, /\/service opencode start/)
  assert.match(text, /UTC/)
})

test("STARTUP_NOTICE is a /env-managed boolean key", () => {
  assert.ok("STARTUP_NOTICE" in OPS_ENV_RULES)
})

test("loadConfig parses STARTUP_NOTICE=0 as disabled and defaults to enabled", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7" }
  assert.equal(loadConfig({ ...base, STARTUP_NOTICE: "0" }).startupNotice, false)
  assert.equal(loadConfig({ ...base, STARTUP_NOTICE: "1" }).startupNotice, true)
  assert.equal(loadConfig({ ...base }).startupNotice, true)
})

test("appVersion reads the package version", () => {
  assert.match(appVersion(), /^\d+\.\d+\.\d+$|^dev$/)
})
