import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

test("install.sh is valid POSIX shell and documents its options", () => {
  execFileSync("sh", ["-n", "install.sh"])
  const help = execFileSync("sh", ["install.sh", "--help"], { encoding: "utf8" })
  assert.match(help, /Usage: install\.sh/)
  assert.match(help, /--dry-run/)
  assert.match(help, /--setup/)
  assert.match(help, /Telegram \/ Android \/ Feishu/)
  assert.match(help, /AGENT_BOT_DIR/)
})

test("install.sh recognizes Telegram, Feishu and Android API as control channels", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  assert.match(source, /has_channel/)
  assert.match(source, /FEISHU_APP_ID/)
  assert.match(source, /FEISHU_APP_SECRET/)
  assert.match(source, /API_PUBLIC_URL/)
  assert.match(source, /API_BIND/)
  assert.match(source, /0\.0\.0\.0/)
  assert.match(source, /"::"/)
  assert.match(source, /refusing to start without a configured Telegram, Android App or Feishu client/)
  assert.doesNotMatch(source, /refusing to start without TELEGRAM_BOT_TOKEN/)
})

test("install.sh points at the client wizard for adding control clients later", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  assert.match(source, /npm run setup/)
  assert.match(source, /npm run clients/)
  assert.match(source, /Telegram \/ Android App \/ Feishu/)
})
