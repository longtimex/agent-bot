import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

test("install.sh is valid POSIX shell and documents its options", () => {
  execFileSync("sh", ["-n", "install.sh"])
  const help = execFileSync("sh", ["install.sh", "--help"], { encoding: "utf8" })
  assert.match(help, /Usage: install\.sh/)
  assert.match(help, /--dry-run/)
  assert.match(help, /--setup/)
  assert.match(help, /--tools/)
  assert.match(help, /--check-tools/)
  assert.match(help, /--no-tools/)
  assert.match(help, /Telegram \/ Android \/ Feishu/)
  assert.match(help, /AGENT_BOT_DIR/)
  assert.match(help, /AGENT_BOT_TOOLS/)
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

test("install.sh re-reads the control channel after creating .env", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  const start = source.indexOf('if [ "$start_after" -eq 1 ]')
  assert.ok(start > 0)
  const beforeStart = source.slice(0, start)
  const finalRefresh = beforeStart.lastIndexOf("has_channel=0")
  const firstCheck = beforeStart.indexOf("if has_control_channel; then has_channel=1; fi")
  assert.ok(finalRefresh > firstCheck, "the channel must be re-read after the setup/file stages")
})

test("install.sh points at the client wizard for adding control clients later", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  assert.match(source, /npm run setup/)
  assert.match(source, /npm run clients/)
  assert.match(source, /Telegram \/ Android App \/ Feishu/)
})

test("install.sh detects and offers optional tools without blocking the deployment", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  assert.match(source, /npm run setup:tools -- --check/)
  assert.match(source, /npm run setup:tools/)
  assert.match(source, /npm run setup -- "\$setup_tools_flag"/)
  assert.match(source, /setup_tools_flag="--check-tools"/)
  assert.match(source, /setup_tools_flag="--no-tools"/)
  assert.match(source, /Agent CLI \/ magpie \/ cc-switch/)
  assert.match(source, /Tool detection did not finish/)
  assert.match(source, /AGENT_BOT_TOOLS must be/)
  assert.doesNotMatch(source, /Tool setup did not finish/)
})

test("install.sh rejects an unknown AGENT_BOT_TOOLS value before installing", () => {
  assert.throws(
    () =>
      execFileSync("sh", ["install.sh", "--dry-run", "--no-setup"], {
        encoding: "utf8",
        env: { ...process.env, AGENT_BOT_TOOLS: "bogus" },
        stdio: "pipe",
      }),
    (error: unknown) => {
      const failed = error as { status?: number; stderr?: Buffer | string }
      return failed.status === 1 && String(failed.stderr ?? "").includes("AGENT_BOT_TOOLS must be")
    },
  )
})

test("npm run setup documents the tool stage even without a TTY", () => {
  const help = execFileSync("npx", ["tsx", "src/setup-cli.ts", "--help"], {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  })
  assert.match(help, /npm run setup/)
  assert.match(help, /npm run clients/)
  assert.match(help, /--check-tools/)
  assert.match(help, /--no-tools/)
  assert.match(help, /Agent CLI \/ magpie \/ cc-switch/)
})

test("install.sh passes the selected tool mode into the client wizard", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  const wizard = source.slice(source.indexOf("if [ \"$want_setup\" != 0 ]"))
  assert.match(wizard, /npm run setup -- "\$setup_tools_flag"/)
  assert.match(wizard, /setup_tools_flag="--check-tools"/)
  assert.match(wizard, /setup_tools_flag="--no-tools"/)
  assert.match(wizard, /elif \[ "\$want_tools" != 0 \]/)
})

test("install.sh validates uninstall and systemd combinations before doing work", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  assert.match(source, /--purge-data requires --uninstall/)
  assert.match(source, /--systemd and --user-systemd are mutually exclusive/)
  assert.match(source, /npx --no-install tsx src\/bot-cli\.ts \$uninstall_args/)
  assert.match(source, /dist\/bot-cli\.js/)
})

test("install.sh accepts environment equivalents for automation", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  assert.match(source, /AGENT_BOT_SYSTEMD=0\|1\|user/)
  assert.match(source, /AGENT_BOT_START=0\|1/)
  assert.match(source, /AGENT_BOT_SKIP_DEPS=0\|1/)
  assert.match(source, /AGENT_BOT_SKIP_BUILD=0\|1/)
  assert.throws(
    () =>
      execFileSync("sh", ["install.sh", "--dry-run", "--no-setup"], {
        encoding: "utf8",
        env: { ...process.env, AGENT_BOT_SYSTEMD: "bogus" },
        stdio: "pipe",
      }),
    (error: unknown) => {
      const failed = error as { status?: number; stderr?: Buffer | string }
      return failed.status === 2 && String(failed.stderr ?? "").includes("AGENT_BOT_SYSTEMD")
    },
  )
})

test("install.sh installs systemd units even without --start", () => {
  const source = execFileSync("sh", ["-c", "cat install.sh"], { encoding: "utf8" })
  const units = source.indexOf('step "Installing systemd units..."')
  const start = source.indexOf('step "Starting the bot..."')
  assert.ok(units > 0 && start > units, "unit installation must be its own step before --start")
  assert.match(source, /npm run bot -- install --skip-deps --skip-build \$opencode_args "\$systemd_args"/)
})
