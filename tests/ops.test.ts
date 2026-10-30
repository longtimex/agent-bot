import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parseEnv } from "node:util"
import { OpsService, type OpsCommandResult } from "../src/ops.js"

interface Call {
  command: string
  args: string[]
  timeoutMs: number
  env: NodeJS.ProcessEnv
}

function makeService(
  dir: string,
  responses: (command: string, args: string[]) => OpsCommandResult | undefined,
  overrides: Partial<ConstructorParameters<typeof OpsService>[0]> = {},
): { ops: OpsService; calls: Call[] } {
  const calls: Call[] = []
  const ops = new OpsService({
    projectDir: dir,
    dataDir: join(dir, "data"),
    opencodeUrl: "http://127.0.0.1:4096",
    envPath: join(dir, ".env"),
    logPath: join(dir, "data", "bot.log"),
    which: (bin) => `/usr/bin/${bin}`,
    run: async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs, env: options.env })
      return responses(command, args) ?? { code: 0, stdout: "", stderr: "" }
    },
    health: async () => false,
    ...overrides,
  })
  return { ops, calls }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-ops-"))
}

test("ops diagnostics reports git, opencode, cc-switch, disk and logs", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "data", "bot.log"), "bot log\n")
    writeFileSync(join(dir, "data", "opencode.log"), "oc log\n")
    const ccBin = join(dir, "bin", "cc-switch")
    writeFileSync(ccBin, "#!/bin/sh\n")
    chmodSync(ccBin, 0o755)

    const { ops, calls } = makeService(
      dir,
      (command, args) => {
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return { code: 0, stdout: "main\n", stderr: "" }
        }
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--short") {
          return { code: 0, stdout: "abc1234\n", stderr: "" }
        }
        if (command === "git" && args[0] === "status") {
          return { code: 0, stdout: " M src/x.ts\n", stderr: "" }
        }
        if (command === ccBin) return { code: 0, stdout: "cc-switch 1.2.3\n", stderr: "" }
        return undefined
      },
      { ccSwitchBin: ccBin, health: async () => true },
    )

    const diag = await ops.diagnostics()
    assert.deepEqual(diag.git, { branch: "main", commit: "abc1234", dirty: true })
    assert.equal(diag.opencode.reachable, true)
    assert.equal(diag.opencode.managed, false)
    assert.equal(diag.ccSwitch?.version, "cc-switch 1.2.3")
    assert.equal(diag.log.bytes, 8)
    assert.equal(diag.opencodeLog.bytes, 7)
    assert.ok(diag.disk && diag.disk.totalBytes > 0)
    assert.ok(diag.memory.totalBytes > 0)
    assert.equal(diag.systemd, false)
    assert.ok(calls.some((call) => call.command === "git" && call.args[0] === "status"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops cc-switch probe runs the real binary and parses its version", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir()
  try {
    // No `run` override here: this test covers the spawn-based #runCommand itself
    const ccBin = join(dir, "cc-switch")
    writeFileSync(ccBin, "#!/bin/sh\nprintf 'cc-switch 9.9.9\\n'\n")
    chmodSync(ccBin, 0o755)
    const ops = new OpsService({
      projectDir: dir,
      dataDir: join(dir, "data"),
      opencodeUrl: "http://127.0.0.1:4096",
      envPath: join(dir, ".env"),
      logPath: join(dir, "data", "bot.log"),
      ccSwitchBin: ccBin,
      // git is absent, so the probe does not depend on the host's repository state
      which: () => undefined,
      health: async () => false,
    })

    const diag = await ops.diagnostics()
    assert.equal(diag.git, undefined)
    assert.equal(diag.ccSwitch?.bin, ccBin)
    assert.equal(diag.ccSwitch?.version, "cc-switch 9.9.9")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops tailLogs strips ANSI, redacts secrets and limits lines", () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(
      join(dir, "data", "bot.log"),
      "\u001b[31mERROR\u001b[0m token=abcdef123456\nline2\nline3 sk-abcdefgh12345\n",
    )
    const { ops } = makeService(dir, () => undefined)
    const logs = ops.tailLogs("bot", 2)
    assert.equal(logs.ok, true)
    assert.equal(logs.missing, false)
    assert.doesNotMatch(logs.text, /\u001b\[/)
    assert.doesNotMatch(logs.text, /abcdef123456/)
    assert.doesNotMatch(logs.text, /sk-abcdefgh12345/)
    assert.match(logs.text, /line2/)
    assert.match(logs.text, /line3/)
    assert.doesNotMatch(logs.text, /ERROR/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops tailLogs reports missing files", () => {
  const dir = tempDir()
  try {
    const { ops } = makeService(dir, () => undefined)
    const logs = ops.tailLogs("bot", 20)
    assert.equal(logs.missing, true)
    assert.equal(logs.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops update aborts on a dirty worktree", async () => {
  const dir = tempDir()
  try {
    const { ops, calls } = makeService(dir, (command, args) => {
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: " M src/x.ts\n", stderr: "" }
      }
      return undefined
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, false)
    assert.match(result.message, /未提交/)
    assert.equal(calls.some((call) => call.args[0] === "pull"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops update runs pull, install and build in order", async () => {
  const dir = tempDir()
  try {
    const { ops, calls } = makeService(dir, (command, args) => {
      if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" }
      if (command === "git" && args[0] === "pull") return { code: 0, stdout: "Already up to date.\n", stderr: "" }
      if (command.endsWith("npm") && args[0] === "install") return { code: 0, stdout: "added 1 package\n", stderr: "" }
      if (command.endsWith("npm") && args[0] === "run") return { code: 0, stdout: "build ok\n", stderr: "" }
      return undefined
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, true)
    assert.match(result.message, /重启/)
    assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [
      ["status", "--porcelain"],
      ["pull", "--ff-only"],
      ["install", "--no-audit"],
      ["run", "build"],
    ])
    assert.equal(calls[1]?.args[0], "pull")
    assert.equal(calls[2]?.args[0], "install")
    assert.equal(calls[3]?.args[0], "run")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops runs install, build and check without the bot's provider credentials", async () => {
  const dir = tempDir()
  const saved = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "sk-credential-for-test"
  try {
    const { ops, calls } = makeService(dir, () => undefined)
    assert.equal((await ops.updateProject()).ok, true)
    assert.equal((await ops.runCheck()).ok, true)

    // git and the repo scripts are pulled code: only git keeps the live environment
    const npmCalls = calls.filter((call) => call.command.endsWith("npm"))
    assert.equal(npmCalls.length, 3)
    for (const call of npmCalls) {
      assert.equal(call.env.OPENAI_API_KEY, undefined, `${call.args.join(" ")} must not see provider keys`)
    }
    const status = calls.find((call) => call.command === "git" && call.args[0] === "status")
    assert.equal(status?.env.OPENAI_API_KEY, "sk-credential-for-test")
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops update stops when the build fails", async () => {
  const dir = tempDir()
  try {
    const { ops } = makeService(dir, (command, args) => {
      if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" }
      if (command === "git" && args[0] === "pull") return { code: 0, stdout: "", stderr: "" }
      if (command.endsWith("npm") && args[0] === "install") return { code: 0, stdout: "", stderr: "" }
      if (command.endsWith("npm") && args[0] === "run") return { code: 2, stdout: "", stderr: "tsc failed\n" }
      return undefined
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, false)
    assert.match(result.message, /构建失败/)
    assert.match(result.steps.at(-1)?.output ?? "", /tsc failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops restart refuses under systemd and spawns the script otherwise", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "dist"), { recursive: true })
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(join(dir, "dist", "index.js"), "// bot\n")
    writeFileSync(join(dir, "scripts", "restart.sh"), "#!/usr/bin/env bash\n")

    const underSystemd = makeService(dir, () => undefined, { systemd: true })
    const refused = await underSystemd.ops.restartBot()
    assert.equal(refused.ok, false)
    assert.match(refused.message, /systemd/)

    const spawns: Array<{ command: string; args: string[] }> = []
    const normal = makeService(dir, () => undefined, {
      systemd: false,
      spawnDetached: (command, args) => {
        spawns.push({ command, args })
        return 4242
      },
    })
    const restarted = await normal.ops.restartBot()
    assert.equal(restarted.ok, true)
    assert.match(restarted.message, /4242/)
    assert.deepEqual(spawns, [{ command: "bash", args: [join(dir, "scripts", "restart.sh")] }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops restart rejects missing build output", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(join(dir, "scripts", "restart.sh"), "#!/usr/bin/env bash\n")
    const { ops } = makeService(dir, () => undefined, { systemd: false })
    const result = await ops.restartBot()
    assert.equal(result.ok, false)
    assert.match(result.message, /dist\/index\.js/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops starts opencode with curated args and records the pid", async () => {
  const dir = tempDir()
  try {
    let started = false
    const spawns: Array<{ command: string; args: string[] }> = []
    const { ops } = makeService(dir, () => undefined, {
      health: async () => started,
      spawnService: (command, args) => {
        spawns.push({ command, args })
        started = true
        return 4321
      },
    })
    const result = await ops.startOpencode()
    assert.equal(result.ok, true)
    assert.match(result.message, /4321/)
    assert.deepEqual(spawns, [
      { command: "/usr/bin/opencode", args: ["serve", "--port", "4096", "--hostname", "127.0.0.1"] },
    ])
    assert.equal(readFileSync(join(dir, "data", "opencode.pid"), "utf8").trim(), "4321")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops does not start opencode twice or manage remote URLs", async () => {
  const dir = tempDir()
  try {
    let spawns = 0
    const running = makeService(dir, () => undefined, {
      health: async () => true,
      spawnService: () => {
        spawns++
        return 1
      },
    })
    const already = await running.ops.startOpencode()
    assert.equal(already.ok, true)
    assert.match(already.message, /已在运行/)
    assert.equal(spawns, 0)

    const remote = makeService(dir, () => undefined, {
      opencodeUrl: "http://10.0.0.5:4096",
      health: async () => false,
      spawnService: () => {
        spawns++
        return 1
      },
    })
    const refused = await remote.ops.startOpencode()
    assert.equal(refused.ok, false)
    assert.match(refused.message, /非本机/)
    assert.equal(spawns, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops refuses to stop opencode it does not own and clears stale pid files", async () => {
  const dir = tempDir()
  try {
    const unmanaged = makeService(dir, () => undefined, { health: async () => true })
    const refused = await unmanaged.ops.stopOpencode()
    assert.equal(refused.ok, false)
    assert.match(refused.message, /不是由 Bot 启动/)

    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, "data", "opencode.pid"), "999999\n")
    const stale = makeService(dir, () => undefined, { health: async () => false })
    const result = await stale.ops.stopOpencode()
    assert.equal(result.ok, true)
    assert.match(result.message, /未在运行/)
    assert.equal(statSafe(join(dir, "data", "opencode.pid")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops installs cc-switch only with a valid version", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true })
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "scripts", "install-cc-switch.sh"), "#!/usr/bin/env bash\n")
    const ccBin = join(dir, "bin", "cc-switch")
    writeFileSync(ccBin, "#!/bin/sh\n")
    chmodSync(ccBin, 0o755)

    const { ops, calls } = makeService(
      dir,
      (command, args) => {
        if (command === ccBin) return { code: 0, stdout: "cc-switch 2.0.0\n", stderr: "" }
        if (command === "bash") return { code: 0, stdout: "Installed\n", stderr: "" }
        return undefined
      },
      { ccSwitchBin: ccBin },
    )

    const installed = await ops.installCcSwitch(false)
    assert.equal(installed.ok, true)
    assert.match(installed.message, /2\.0\.0/)
    assert.deepEqual(calls[0]?.args, [join(dir, "scripts", "install-cc-switch.sh"), "latest"])

    calls.length = 0
    const updated = await ops.installCcSwitch(true, "v1.2.3")
    assert.equal(updated.ok, true)
    assert.deepEqual(calls[0]?.args, [join(dir, "scripts", "install-cc-switch.sh"), "v1.2.3", "--force"])

    calls.length = 0
    const invalid = await ops.installCcSwitch(true, "1.2.3; rm -rf /")
    assert.equal(invalid.ok, false)
    assert.equal(calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops env editing writes 0600, preserves comments and masks secrets", () => {
  const dir = tempDir()
  try {
    writeFileSync(
      join(dir, ".env"),
      "# bot config\nLOG_LEVEL=info\nTELEGRAM_BOT_TOKEN=super-secret-token\n",
    )
    const { ops } = makeService(dir, () => undefined)

    const listed = ops.envList()
    assert.equal(listed.exists, true)
    assert.equal(listed.entries.find((entry) => entry.key === "TELEGRAM_BOT_TOKEN")?.value, undefined)
    assert.equal(listed.entries.find((entry) => entry.key === "TELEGRAM_BOT_TOKEN")?.secret, true)
    assert.equal(listed.entries.find((entry) => entry.key === "LOG_LEVEL")?.value, "info")

    const set = ops.envSet("LOG_LEVEL", "debug")
    assert.equal(set.ok, true)
    assert.match(set.message, /重启/)
    const content = readFileSync(join(dir, ".env"), "utf8")
    assert.match(content, /# bot config/)
    assert.match(content, /LOG_LEVEL=debug/)
    assert.match(content, /TELEGRAM_BOT_TOKEN=super-secret-token/)
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600)

    const spaced = ops.envSet("PROXY_TEST_URL", "https://example.com/path?q=1#frag")
    assert.equal(spaced.ok, true)
    assert.equal(ops.envList().entries.find((entry) => entry.key === "PROXY_TEST_URL")?.value, "https://example.com/path?q=1#frag")

    const unset = ops.envUnset("LOG_LEVEL")
    assert.equal(unset.ok, true)
    assert.doesNotMatch(readFileSync(join(dir, ".env"), "utf8"), /^LOG_LEVEL=/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops env values survive the parser the bot reloads .env with", () => {
  const dir = tempDir()
  try {
    const { ops } = makeService(dir, () => undefined)
    const cases: Array<[string, string]> = [
      ["PROXY_TEST_URL", "https://example.com/path?q=1#frag"],
      ["AGENT_CLI_CONFIG", "/data/back\\slash/agents.json"],
      ["AGENT_CLI_CONFIG", '/data/quo"te/agents.json'],
      ["CC_SWITCH_BIN", "/data/it's/cc-switch"],
      ["CC_SWITCH_BIN", "/data/has space/bin"],
      ["CC_SWITCH_BIN", "/data/a\tb"],
    ]
    for (const [key, value] of cases) {
      assert.equal(ops.envSet(key, value).ok, true, value)
      // process.loadEnvFile uses this same parser on the next start
      const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"))
      assert.equal(env[key], value)
      assert.equal(ops.envList().entries.find((entry) => entry.key === key)?.value, value)
    }

    // Single quote plus a backslash has no .env spelling that parses back identically
    const rejected = ops.envSet("AGENT_CLI_CONFIG", "/data/it's\\agents.json")
    assert.equal(rejected.ok, false)
    assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).AGENT_CLI_CONFIG, '/data/quo"te/agents.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops env rejects unknown keys, invalid values and newlines", () => {
  const dir = tempDir()
  try {
    const { ops } = makeService(dir, () => undefined)
    assert.equal(ops.envSet("HOME", "/tmp").ok, false)
    assert.equal(ops.envSet("LOG_LEVEL", "verbose").ok, false)
    assert.equal(ops.envSet("REMINDER_TIMEZONE", "Mars/Olympus").ok, false)
    assert.equal(ops.envSet("OPENCODE_AGENT", "assistant\nrm -rf /").ok, false)
    assert.equal(ops.envSet("MAX_INPUT_MB", "500").ok, false)
    assert.equal(ops.envSet("MAX_INPUT_MB", "20").ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops whitelist key is validated but only writable through its command", () => {
  const dir = tempDir()
  try {
    const { ops } = makeService(dir, () => undefined)

    assert.equal(ops.envSet("TELEGRAM_ALLOW_USERS", "12, 34").ok, false)
    assert.match(ops.envSet("TELEGRAM_ALLOW_USERS", "12, 34").message, /请使用 \/access 修改/)
    assert.equal(ops.envUnset("TELEGRAM_ALLOW_USERS").ok, false)
    assert.equal(ops.envList().entries.find((entry) => entry.key === "TELEGRAM_ALLOW_USERS"), undefined)

    // the dedicated command passes the flag and shares the same validation
    assert.equal(ops.envSet("TELEGRAM_ALLOW_USERS", "7,99", true).ok, true)
    assert.match(readFileSync(join(dir, ".env"), "utf8"), /^TELEGRAM_ALLOW_USERS=7,99$/m)
    assert.equal(ops.envSet("TELEGRAM_ALLOW_USERS", "7; rm -rf /", true).ok, false)
    assert.equal(ops.envSet("TELEGRAM_ALLOW_USERS", "", true).ok, false)
    assert.equal(ops.envSet("TELEGRAM_ALLOW_USERS", "1".repeat(21), true).ok, false)
    assert.equal(ops.envList().entries.find((entry) => entry.key === "TELEGRAM_ALLOW_USERS")?.editable, false)
    assert.equal(ops.envSet("TELEGRAM_ALLOW_USERS", "7,99", true).message.includes("立即生效"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops env ignores inherited prototype keys", () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, ".env"), "TOSTRING=1\n")
    const { ops } = makeService(dir, () => undefined)

    const set = ops.envSet("toString", "abc")
    assert.equal(set.ok, false)
    assert.match(set.message, /不支持在 Telegram 中修改 TOSTRING/)
    assert.equal(ops.envSet("constructor", "x").ok, false)
    assert.equal(ops.envUnset("constructor").ok, false)
    assert.match(ops.envUnset("toString").message, /不支持在 Telegram 中修改 TOSTRING/)
    assert.equal(ops.envList().entries.find((entry) => entry.key === "TOSTRING")?.editable, false)
    assert.equal(readFileSync(join(dir, ".env"), "utf8").includes("TOSTRING=1"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function statSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

test(
  "ops refuses to start a second opencode while the managed one is unhealthy",
  { skip: !existsSync("/proc/self/cmdline") },
  async () => {
    const dir = tempDir()
    // A process whose cmdline reads "<dir>/opencode serve": that is all #managedPid checks.
    // No exec here on purpose — exec would replace the argv the check looks at.
    const fakeBin = join(dir, "opencode")
    // exit 0 after sleep keeps some shells from exec-optimising the last command
    writeFileSync(fakeBin, "#!/bin/sh\nsleep 30\nexit 0\n")
    chmodSync(fakeBin, 0o755)
    const child = spawn(fakeBin, ["serve"], { detached: true, stdio: "ignore" })
    child.unref()
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8")
          if (cmdline.includes("opencode") && cmdline.includes("serve")) break
        } catch {
          // not visible yet
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      mkdirSync(join(dir, "data"), { recursive: true })
      writeFileSync(join(dir, "data", "opencode.pid"), `${child.pid}\n`)
      let spawns = 0
      const { ops } = makeService(dir, () => undefined, {
        health: async () => false,
        spawnService: () => {
          spawns++
          return 999
        },
      })
      const result = await ops.startOpencode()
      assert.equal(result.ok, false)
      assert.match(result.message, /已在运行.*健康检查未通过/)
      assert.equal(spawns, 0, "a second server must not be spawned")
      assert.equal(readFileSync(join(dir, "data", "opencode.pid"), "utf8").trim(), String(child.pid))
    } finally {
      // Detached, so the whole group must go or the sleep child outlives the test
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        try {
          process.kill(child.pid!, "SIGKILL")
        } catch {
          // already gone
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
