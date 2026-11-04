import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

test("install.sh is valid POSIX shell and documents its options", () => {
  execFileSync("sh", ["-n", "install.sh"])
  const help = execFileSync("sh", ["install.sh", "--help"], { encoding: "utf8" })
  assert.match(help, /Usage: install\.sh/)
  assert.match(help, /--dry-run/)
  assert.match(help, /AGENT_BOT_DIR/)
})
