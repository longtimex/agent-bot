import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parseEnv } from "node:util"
import { failureDigest } from "../src/failureDigest.js"
import { OpsService, type OpsCommandResult } from "../src/ops.js"

interface Call {
  command: string
  args: string[]
  timeoutMs: number
  env: NodeJS.ProcessEnv
  cwd: string
}

function makeService(
  dir: string,
  responses: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => OpsCommandResult | undefined,
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
      calls.push({ command, args, timeoutMs: options.timeoutMs, env: options.env, cwd: options.cwd })
      return responses(command, args, options) ?? { code: 0, stdout: "", stderr: "" }
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
      // CI runners and developer machines may themselves run under systemd.
      // Pin it so this test covers the diagnostics payload, not the host.
      { ccSwitchBin: ccBin, health: async () => true, systemd: false },
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

test("ops diagnostics rounds a fractional backup mtime to a JSON-safe integer", async () => {
  const dir = tempDir()
  try {
    const backupDir = join(dir, "data", "backups")
    mkdirSync(backupDir, { recursive: true })
    const archive = join(backupDir, "backup-20261110-151932109.tar.gz")
    writeFileSync(archive, "archive")
    // statSync().mtimeMs can carry a fractional nanosecond remainder on Linux. Kotlin's
    // Long decoder rejects it, so the API must not forward the raw value. utimesSync takes
    // microseconds, and Node 24 may print a whole millisecond even when the nanosecond
    // value is fractional; check the fraction against mtimeNs and the product's floor
    // against the same mtimeMs the service reads.
    const seconds = 1_794_323_972.109
    utimesSync(archive, seconds, seconds)
    const stat = statSync(archive, { bigint: true })
    assert.notEqual(stat.mtimeNs % 1_000_000n, 0n, "the fixture must expose a fractional mtime")
    const expected = Math.floor(statSync(archive).mtimeMs)

    const { ops } = makeService(dir, () => undefined)
    const diag = await ops.diagnostics()
    assert.equal(diag.lastBackupAt, expected)
    assert.ok(Number.isSafeInteger(diag.lastBackupAt))
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

/** Mimics the clone + npm lifecycle enough for ReleaseManager to produce a usable release. */
function releaseBuildResponder(
  command: string,
  args: string[],
  options: { cwd: string },
  overrides: { gateCode?: number; buildCode?: number; version?: string } = {},
): OpsCommandResult | undefined {
  if (command.endsWith("git") && args[0] === "remote" && args[1] === "get-url") {
    return { code: 0, stdout: "https://github.com/longtimex/agent-bot.git\n", stderr: "" }
  }
  if (command.endsWith("git") && args[0] === "status") return { code: 0, stdout: "", stderr: "" }
  if (command.endsWith("git") && args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
    return { code: 0, stdout: "origin/main\n", stderr: "" }
  }
  if (command.endsWith("git") && args[0] === "clone") {
    const workDir = args.at(-1)!
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, "package-lock.json"), "{}")
    writeFileSync(join(workDir, "package.json"), JSON.stringify({ version: overrides.version ?? "0.4.0" }))
    return { code: 0, stdout: "cloned\n", stderr: "" }
  }
  if (command.endsWith("git") && args[0] === "fetch") return { code: 0, stdout: "", stderr: "" }
  if (command.endsWith("git") && args[0] === "checkout") return { code: 0, stdout: "", stderr: "" }
  if (command.endsWith("git") && args[0] === "rev-parse" && args[1] === "HEAD") {
    return { code: 0, stdout: "abcdef0123456789abcdef0123456789abcdef01\n", stderr: "" }
  }
  if (command.endsWith("npm") && args[0] === "ci") {
    mkdirSync(join(options.cwd, "node_modules"), { recursive: true })
    return { code: 0, stdout: "installed\n", stderr: "" }
  }
  if (command.endsWith("npm") && args[0] === "run" && args[1] === "check:release") {
    return overrides.gateCode
      ? { code: overrides.gateCode, stdout: "", stderr: "gate failed\n" }
      : { code: 0, stdout: "gate ok\n", stderr: "" }
  }
  if (command.endsWith("npm") && args[0] === "run" && args[1] === "build") {
    if (overrides.buildCode) return { code: overrides.buildCode, stdout: "", stderr: "tsc failed\n" }
    mkdirSync(join(options.cwd, "dist"), { recursive: true })
    writeFileSync(join(options.cwd, "dist", "index.js"), "// built\n")
    return { code: 0, stdout: "build ok\n", stderr: "" }
  }
  return undefined
}

test("ops update aborts on a dirty worktree", async () => {
  const dir = tempDir()
  try {
    const { ops, calls } = makeService(dir, (command, args) => {
      if (command.endsWith("git") && args[0] === "status") {
        return { code: 0, stdout: " M src/x.ts\n", stderr: "" }
      }
      return undefined
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, false)
    assert.match(result.message, /未提交/)
    assert.equal(calls.some((call) => call.args[0] === "pull"), false)
    assert.equal(calls.some((call) => call.args[0] === "clone"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops update builds an isolated release and leaves it pending", async () => {
  const dir = tempDir()
  try {
    const { ops, calls } = makeService(dir, (command, args, options) => {
      return releaseBuildResponder(command, args, options)
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, true)
    assert.match(result.message, /重启 Bot/)
    assert.match(result.message, /重启 Bot/)
    const commands = calls.map((call) => `${call.command} ${call.args.join(" ")}`)
    const clone = calls.find((call) => call.command.endsWith("git") && call.args[0] === "clone")
    assert.ok(clone)
    assert.equal(clone.args[3], "https://github.com/longtimex/agent-bot.git")
    assert.ok(commands.some((entry) => entry.endsWith(" ci --no-audit --no-fund")))
    assert.ok(commands.some((entry) => entry.endsWith(" run check:release")))
    assert.ok(commands.some((entry) => entry.endsWith(" run build")))
    assert.ok(!calls.some((call) => call.args[0] === "pull"), "an update must never pull into the running checkout")
    const state = ops.releaseState()
    assert.equal(state.pending?.commit, "abcdef0123456789abcdef0123456789abcdef01")
    assert.equal(state.pending?.version, "0.4.0")
    assert.equal(state.current, undefined)
    assert.ok(state.pending?.path.startsWith(join(dir, "data", "releases", "store")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops update and check never expose provider credentials to npm scripts", async () => {
  const dir = tempDir()
  const saved = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "sk-credential-for-test"
  try {
    const { ops, calls } = makeService(dir, (command, args, options) => {
      return releaseBuildResponder(command, args, options)
    })
    assert.equal((await ops.updateProject()).ok, true)
    assert.equal((await ops.runCheck()).ok, true)

    const npmCalls = calls.filter((call) => call.command.endsWith("npm"))
    assert.equal(npmCalls.length, 4)
    for (const call of npmCalls) {
      assert.equal(call.env.OPENAI_API_KEY, undefined, `${call.args.join(" ")} must not see provider keys`)
    }
    const gitCalls = calls.filter((call) => call.command.endsWith("git"))
    assert.ok(gitCalls.length > 0)
    for (const call of gitCalls) assert.equal(call.env.OPENAI_API_KEY, "sk-credential-for-test")
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failed check keeps the names of failing tests instead of only the tail counts", async () => {
  const dir = tempDir()
  try {
    const noise = "still running\n".repeat(500)
    const failures = Array.from({ length: 5 }, (_, i) =>
      `not ok ${i + 1} - the release guard fails case ${i + 1}\n  ---\n  error: 'expected true'\n  ---`
    ).join("\n")
    const { ops } = makeService(dir, (command, args) => {
      if (command.endsWith("npm") && args.join(" ") === "run check") {
        return { code: 1, stdout: `${noise}${failures}\n${noise}1..937\n# fail 5\n`, stderr: "" }
      }
      return undefined
    })

    const result = await ops.runCheck()
    assert.equal(result.ok, false)
    const output = result.steps[0]?.output ?? ""
    for (let i = 1; i <= 5; i += 1) assert.match(output, new RegExp(`not ok ${i} - the release guard fails case ${i}`))
    assert.match(output, /失败明细：/)
    assert.ok(output.length <= 1500, `the step output must stay bounded, was ${output.length}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("failureDigest ignores passing tests and bounds a broken reporter", () => {
  const passing = "ok 1 - works\n".repeat(100)
  assert.equal(failureDigest(passing, 600), "")
  const many = Array.from({ length: 80 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`).join("\n")
  const digest = failureDigest(many, 600)
  assert.match(digest, /^失败明细：\n- not ok 1 - case 1/)
  assert.ok(digest.length <= 600, `digest must stay bounded, was ${digest.length}`)
})

test("ops update stops at the release gate without building or activating", async () => {
  const dir = tempDir()
  try {
    const { ops, calls } = makeService(dir, (command, args, options) => {
      return releaseBuildResponder(command, args, options, { gateCode: 2 })
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, false)
    assert.match(result.message, /门禁/)
    assert.ok(!calls.some((call) => call.args[0] === "run" && call.args[1] === "build"))
    assert.equal(ops.releaseState().pending, undefined)
    assert.equal(ops.releaseState().lastUpdate?.status, "failed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops update reports a build failure and records no pending release", async () => {
  const dir = tempDir()
  try {
    const { ops } = makeService(dir, (command, args, options) => {
      return releaseBuildResponder(command, args, options, { buildCode: 2 })
    })
    const result = await ops.updateProject()
    assert.equal(result.ok, false)
    assert.match(result.message, /构建失败/)
    assert.equal(ops.releaseState().pending, undefined)
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

test("ops restart accepts a usable managed release when the checkout has no dist", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(join(dir, "scripts", "apply-release.sh"), "#!/usr/bin/env bash\n")
    const releasePath = join(dir, "data", "releases", "store", "managed")
    mkdirSync(join(releasePath, "dist"), { recursive: true })
    writeFileSync(join(releasePath, "dist", "index.js"), "// managed\n")
    writeFileSync(join(releasePath, "package.json"), JSON.stringify({ version: "0.5.0" }))
    const statePath = join(dir, "data", "releases", "state.json")
    mkdirSync(join(dir, "data", "releases"), { recursive: true })
    writeFileSync(
      statePath,
      JSON.stringify({
        current: {
          id: "managed",
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          version: "0.5.0",
          createdAt: "",
          path: releasePath,
        },
      }),
    )
    const { ReleaseManager } = await import("../src/releaseManager.js")
    const releases = new ReleaseManager({
      projectDir: dir,
      dataDir: join(dir, "data"),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    })
    const spawns: string[] = []
    const { ops } = makeService(dir, () => undefined, {
      systemd: false,
      releases,
      spawnDetached: (_command, args) => {
        spawns.push(args[0] ?? "")
        return 5150
      },
    })
    const result = await ops.restartBot()
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /5150/)
    assert.deepEqual(spawns, [join(dir, "scripts", "apply-release.sh")])
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
      (command, _args) => {
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
    assert.equal(ops.envSet("MAX_INPUT_MB", "0").ok, true)
    assert.equal(ops.envSet("MAX_INPUT_MB", "500").ok, true)
    assert.equal(ops.envSet("MAX_INPUT_MB", "100000").ok, true)
    assert.equal(ops.envSet("MAX_INPUT_MB", "100001").ok, false)
    assert.equal(ops.envSet("TASK_MAX_TIMEOUT_MS", "0").ok, true)
    assert.equal(ops.envSet("TASK_MAX_TIMEOUT_MS", "86400000").ok, true)
    assert.equal(ops.envSet("TASK_MAX_TIMEOUT_MS", "600000").ok, true)
    assert.equal(ops.envSet("TASK_MAX_TIMEOUT_MS", "86400001").ok, false)
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
    assert.match(set.message, /不支持在聊天中修改 TOSTRING/)
    assert.equal(ops.envSet("constructor", "x").ok, false)
    assert.equal(ops.envUnset("constructor").ok, false)
    assert.match(ops.envUnset("toString").message, /不支持在聊天中修改 TOSTRING/)
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

test("ops backupData packs the JSON stores and never the pairing token", async () => {
  const dir = tempDir()
  const dataDir = join(dir, "data")
  mkdirSync(dataDir, { recursive: true })
  for (const name of ["usage.json", "reminders.json", "api-token.json", "api-enc-key.json"]) {
    writeFileSync(join(dataDir, name), "{}")
  }
  const { ops, calls } = makeService(
    dir,
    (_command, args) => {
      // 模拟 tar 真正落盘,让 existsSync/体积断言有据可依
      if (args[0] === "-czf" && args[1]) writeFileSync(args[1], "tarball-bytes")
      return { code: 0, stdout: "", stderr: "" }
    },
    { dataDir },
  )
  try {
    // Older releases (or an operator's mkdir) may have left this directory readable by
    // the host's other users; the next backup must close it as well as the new archive.
    mkdirSync(join(dataDir, "backups"), { recursive: true })
    chmodSync(join(dataDir, "backups"), 0o775)
    const result = await ops.backupData()
    assert.equal(result.ok, true)
    assert.ok(result.file, "the backup reports the archive path")
    assert.match(result.file!, /backups\/backup-\d{8}-\d{9}\.tar\.gz$/)
    assert.ok(existsSync(result.file!))
    assert.equal(statSync(join(dataDir, "backups")).mode & 0o777, 0o700, "an existing backup directory must be private")
    assert.equal(statSync(result.file!).mode & 0o777, 0o600, "the archive must be private")
    // tar 收到的就是 data/ 下的状态文件,且不含配对令牌
    const tarCall = calls.find((call) => call.command === "tar")
    assert.ok(tarCall, "backup runs tar")
    assert.deepEqual(tarCall!.args.slice(0, 4), ["-czf", result.file, "-C", dataDir])
    assert.ok(tarCall!.args.includes("usage.json"))
    assert.ok(tarCall!.args.includes("reminders.json"))
    assert.ok(!tarCall!.args.includes("api-token.json"), "the pairing token stays out of backups")
    assert.ok(!tarCall!.args.includes("api-enc-key.json"), "the encryption pairing key stays out of backups")

    // 只保留最近 5 份:预置 7 份更旧的归档(名字排序在今天之前),再备份一次应剩 5
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(dataDir, "backups", `backup-2026010${i}-000000000.tar.gz`), "old")
    }
    await ops.backupData()
    const kept = readdirSync(join(dataDir, "backups")).filter((name) => name.endsWith(".tar.gz"))
    assert.equal(kept.length, 5)
    assert.ok(!kept.some((name) => name.startsWith("backup-20260100")), "the oldest archives get pruned first")
    for (const name of kept) {
      assert.equal(statSync(join(dataDir, "backups", name)).mode & 0o777, 0o600, `${name} must be private`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ops backupData fails cleanly without data or tar", async () => {
  const empty = makeService(tempDir(), () => ({ code: 0, stdout: "", stderr: "" }), { dataDir: join(tempDir(), "missing") })
  {
    const result = await empty.ops.backupData()
    assert.equal(result.ok, false)
    assert.match(result.message, /没有可备份/)
  }

  const noTar = makeService(tempDir(), () => ({ code: 0, stdout: "", stderr: "" }), { which: (bin) => (bin === "tar" ? undefined : `/usr/bin/${bin}`) })
  {
    const result = await noTar.ops.backupData()
    assert.equal(result.ok, false)
    assert.match(result.message, /未找到 tar/)
  }
})
