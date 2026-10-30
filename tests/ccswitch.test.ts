import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  CcSwitchError,
  CcSwitchService,
  assertSafeId,
  buildMcpDeeplink,
  buildPtyCommand,
  buildPromptDeeplink,
  buildSkillDeeplink,
  normalizeCcSwitchApp,
  parseMcpConfig,
  parseProviderList,
  parseSpeedtest,
  redactSecrets,
  resolveCcSwitchBin,
  shellQuote,
  toDeeplinkApp,
  stripAnsi,
} from "../src/ccswitch.js"

const PROVIDER_OUTPUT = `
┌────┬────────┬────────────┬──────────────────────────┐
│    │ ID     │ Name       │ API URL                  │
╞════╪════════╪════════════╪══════════════════════════╡
│ ✓  │ main   │ 主线路     │ https://api.example.com  │
├────┼────────┼────────────┼──────────────────────────┤
│    │ backup │ 备用线路   │ https://backup.example   │
│    │        │            │ /v1                      │
└────┴────────┴────────────┴──────────────────────────┘

ℹ Application: opencode
→ Current: main
`

const SPEEDTEST_OUTPUT = `
ℹ Testing provider '主线路'...
ℹ Endpoint: https://api.example.com

┌─────────────────────────┬──────────┬────────┐
│ Endpoint                │ Latency  │ Status │
╞═════════════════════════╪══════════╪════════╡
│ https://api.example.com │ 42 ms    │ 200    │
└─────────────────────────┴──────────┴────────┘

✓ Speedtest completed successfully
`

test("stripAnsi removes color codes and normalizes newlines", () => {
  assert.equal(stripAnsi("\u001b[32m✓\u001b[0m ok\r\n"), "✓ ok\n")
})

test("parseProviderList reads ids, names, urls and the current marker", () => {
  const providers = parseProviderList(PROVIDER_OUTPUT)
  assert.equal(providers.length, 2)
  assert.deepEqual(providers[0], {
    id: "main",
    name: "主线路",
    apiUrl: "https://api.example.com",
    current: true,
  })
  assert.equal(providers[1]!.id, "backup")
  assert.equal(providers[1]!.current, false)
  assert.equal(providers[1]!.apiUrl, "https://backup.example/v1")
})

test("parseProviderList falls back to the footer Current line", () => {
  const output = `
┌────┬──────┬───────┬─────────┐
│    │ ID   │ Name  │ API URL │
╞════╪══════╪═══════╪═════════╡
│    │ x    │ X     │ N/A     │
└────┴──────┴───────┴─────────┘
→ Current: x
`
  const providers = parseProviderList(output)
  assert.equal(providers.length, 1)
  assert.equal(providers[0]!.current, true)
  assert.equal(providers[0]!.apiUrl, "")
})

test("parseSpeedtest extracts latency and status", () => {
  const result = parseSpeedtest(SPEEDTEST_OUTPUT)
  assert.equal(result.ok, true)
  assert.equal(result.latencyMs, 42)
  assert.equal(result.endpoint, "https://api.example.com")
  assert.equal(result.status, "200")
})

test("parseSpeedtest reports failures", () => {
  const result = parseSpeedtest(`
┌──────────────────┬────────┬────────┐
│ Endpoint         │ Latency│ Status │
╞══════════════════╪════════╪════════╡
│ https://x.example│ Failed │ N/A    │
└──────────────────┴────────┴────────┘

Error: connection timed out
`)
  assert.equal(result.ok, false)
  assert.match(result.status ?? "", /connection timed out/)
})

test("CcSwitchService passes the app flag and validates ids", async () => {
  const calls: string[][] = []
  const service = new CcSwitchService({
    app: "codex",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: PROVIDER_OUTPUT, stderr: "" }
    },
  })

  const providers = await service.listProviders()
  assert.equal(providers.length, 2)
  assert.deepEqual(calls[0], ["--app", "codex", "provider", "list"])

  await service.useProvider("main")
  assert.deepEqual(calls[1], ["--app", "codex", "use", "main"])

  await assert.rejects(() => service.useProvider("--verbose"), CcSwitchError)
  await assert.rejects(() => service.useProvider("bad id"), CcSwitchError)
  assert.equal(calls.length, 2)
})

test("CcSwitchService surfaces stderr when the CLI exits non-zero", async () => {
  const service = new CcSwitchService({
    runner: async () => ({ code: 2, stdout: "", stderr: "\u001b[31mProvider 'nope' not found\u001b[0m\n" }),
  })
  await assert.rejects(() => service.useProvider("nope"), /Provider 'nope' not found/)
})

test("assertSafeId accepts normal provider ids and rejects option-like input", () => {
  assert.equal(assertSafeId("team-1.prod"), "team-1.prod")
  assert.equal(assertSafeId("anthropic/claude-sonnet"), "anthropic/claude-sonnet")
  assert.throws(() => assertSafeId("-x"), /不能以 - 开头/)
  assert.throws(() => assertSafeId("a b"), /不支持的字符/)
  assert.throws(() => assertSafeId(""), /不能为空/)
  assert.throws(() => assertSafeId(".."), /路径片段/)
  assert.throws(() => assertSafeId("../../etc/passwd"), /路径片段/)
  assert.throws(() => assertSafeId("a/../b"), /路径片段/)
})

test("normalizeCcSwitchApp maps friendly names to the CLI values", () => {
  assert.equal(normalizeCcSwitchApp("opencode"), "open-code")
  assert.equal(normalizeCcSwitchApp(" OpenClaw "), "open-claw")
  assert.equal(normalizeCcSwitchApp("claude"), "claude")
  assert.equal(normalizeCcSwitchApp(undefined), "open-code")
  assert.equal(normalizeCcSwitchApp(""), "open-code")
})

test("CcSwitchService normalizes the app before invoking the CLI", async () => {
  const calls: string[][] = []
  const service = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: PROVIDER_OUTPUT, stderr: "" }
    },
  })

  assert.equal(service.app, "open-code")
  await service.listProviders()
  assert.deepEqual(calls[0], ["--app", "open-code", "provider", "list"])
})

test("resolveCcSwitchBin prefers the project bin directory and honors explicit paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-switch-bin-"))
  try {
    const local = join(dir, "bin", "cc-switch")
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(local, "#!/bin/sh\nexit 0\n")
    chmodSync(local, 0o755)

    assert.equal(resolveCcSwitchBin(undefined, dir, { PATH: "" }), local)
    assert.equal(resolveCcSwitchBin(local, "/tmp", { PATH: "" }), local)
    assert.equal(resolveCcSwitchBin("cc-switch", "/tmp", { PATH: join(dir, "bin") }), local)
    assert.equal(resolveCcSwitchBin(join(dir, "missing"), dir, { PATH: "" }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("redactSecrets masks keys, tokens and URL credentials", () => {
  const raw = [
    "API Key: sk-supersecret123",
    '{"apiKey":"sk-json-secret","usageApiKey":"sk-usage","env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-secret"}}',
    "Authorization: Bearer abcdefghijklmnop",
    "https://user:passw0rd@example.com/v1",
    "ghp_abcdefghijklmnop",
  ].join("\n")
  const out = redactSecrets(raw)
  for (const secret of ["supersecret123", "sk-json-secret", "sk-usage", "sk-ant-secret", "abcdefghijklmnop", "passw0rd"]) {
    assert.ok(!out.includes(secret), `expected ${secret} to be redacted`)
  }
  assert.match(out, /API Key: \*\*\*/)
  assert.match(out, /"apiKey":"\*\*\*"/)
  assert.match(out, /user:\*\*\*@example\.com/)
})

test("redactSecrets masks quoted and semicolon-separated credentials", () => {
  // CLI/YAML dumps quote the value, and a greedy match used to swallow the
  // delimiter so the next pair in the same line stayed visible
  const raw = ["password: 'hunter2'", '--api-key="quoted-key"', "token=aaa;secret='bbb'", "secret: a,b"].join("\n")
  const out = redactSecrets(raw)
  for (const secret of ["hunter2", "quoted-key", "aaa", "bbb"]) {
    assert.ok(!out.includes(secret), `expected ${secret} to be redacted`)
  }
  assert.match(out, /password: '\*\*\*'/)
  assert.match(out, /--api-key="\*\*\*"/)
  assert.match(out, /token=\*\*\*;secret='\*\*\*'/)
})

test("deeplink builders encode the legacy app ids and base64 payloads", () => {
  const promptUrl = buildPromptDeeplink("open-code", "My Preset", "Hello world")
  const promptParams = new URLSearchParams(promptUrl.split("?")[1] ?? "")
  assert.equal(promptParams.get("resource"), "prompt")
  assert.equal(promptParams.get("app"), "opencode")
  assert.equal(promptParams.get("name"), "My Preset")
  assert.equal(Buffer.from(promptParams.get("content") ?? "", "base64url").toString(), "Hello world")

  const mcpUrl = buildMcpDeeplink("open-code", JSON.stringify({ foo: { command: "npx" } }))
  const mcpParams = new URLSearchParams(mcpUrl.split("?")[1] ?? "")
  assert.equal(mcpParams.get("apps"), "opencode")
  const config = JSON.parse(Buffer.from(mcpParams.get("config") ?? "", "base64url").toString()) as {
    mcpServers?: Record<string, unknown>
  }
  assert.deepEqual(config.mcpServers, { foo: { command: "npx" } })
  assert.throws(() => parseMcpConfig("not json"), CcSwitchError)
  assert.throws(() => parseMcpConfig("[]"), CcSwitchError)
})

test("runBare skips --app and runWithConfirm feeds a yes answer", async () => {
  const calls: Array<{ args: string[]; input?: string }> = []
  const service = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push({ args })
      return { code: 0, stdout: "ok\n", stderr: "" }
    },
    confirmRunner: async (args, input) => {
      calls.push({ args, input })
      return { code: 0, stdout: "deleted\n", stderr: "" }
    },
  })

  await service.runBare(["deeplink", "ccswitch://v1/import?resource=prompt"])
  await service.runWithConfirm(["provider", "delete", "foo"])

  assert.deepEqual(calls[0]!.args, ["deeplink", "ccswitch://v1/import?resource=prompt"])
  assert.deepEqual(calls[1]!.args, ["provider", "delete", "foo"])
  assert.equal(calls[1]!.input, "y\n")
})

test("cc-switch app names resolve only against declared aliases", () => {
  assert.equal(normalizeCcSwitchApp("opencode"), "open-code")
  assert.equal(normalizeCcSwitchApp(undefined), "open-code")
  assert.equal(normalizeCcSwitchApp("  OpenCode  "), "open-code")
  assert.equal(toDeeplinkApp("open-code"), "opencode")
  assert.equal(toDeeplinkApp("hermes"), "hermes")
  // Inherited Object.prototype names must not be returned where a CLI app id is expected
  assert.equal(normalizeCcSwitchApp("constructor"), "constructor")
  assert.equal(toDeeplinkApp("toString"), "toString")
})

test("prompt and skill deeplinks survive URL round-tripping", () => {
  const link = new URL(buildPromptDeeplink("open-code", "日报 v1", "line one\nline2 本"))
  assert.equal(link.protocol, "ccswitch:")
  assert.equal(link.searchParams.get("resource"), "prompt")
  assert.equal(link.searchParams.get("app"), "opencode")
  assert.equal(link.searchParams.get("name"), "日报 v1")
  const encoded = link.searchParams.get("content") ?? ""
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4)
  assert.equal(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    "line one\nline2 本",
  )

  const skill = new URL(buildSkillDeeplink("owner/my skill"))
  assert.equal(skill.searchParams.get("resource"), "skill")
  assert.equal(skill.searchParams.get("repo"), "owner/my skill")
})

test("runWithConfirm refuses a script build that cannot drive a pty", async () => {
  // BusyBox `script` ignores -qec and would block on stdin until the task times out
  const service = new CcSwitchService({
    app: "opencode",
    runner: async () => ({ code: 0, stdout: "ok\n", stderr: "" }),
    ptyProbe: async () => false,
  })

  await assert.rejects(
    () => service.runWithConfirm(["provider", "delete", "foo"]),
    (err: unknown) => err instanceof CcSwitchError && /util-linux/.test(err.message),
  )
})

test(
  "runWithConfirm decodes pty output without losing multibyte characters",
  { skip: !existsSync("/usr/bin/script") },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pty-"))
    try {
      // 70k three-byte characters: pipe reads must end mid-character at least once
      const bin = join(dir, "cc-switch")
      writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write("中".repeat(70000))\n')
      chmodSync(bin, 0o755)
      const service = new CcSwitchService({
        app: "opencode",
        bin,
        projectDir: dir,
        timeoutMs: 15_000,
        env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` },
      })

      const result = await service.runWithConfirm(["provider", "delete", "foo"])
      assert.equal(result.code, 0)
      assert.doesNotMatch(result.stdout, /\uFFFD/)
      assert.equal(result.stdout.split("中").length - 1, 70_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  "run enforces its deadline even when cc-switch ignores SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-hang-"))
    try {
      const bin = join(dir, "cc-switch")
      // Ignores the polite signal and exits on its own only well after the deadline
      writeFileSync(
        bin,
        '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {})\nsetTimeout(() => process.exit(0), 1_500)\n',
      )
      chmodSync(bin, 0o755)
      const service = new CcSwitchService({
        app: "opencode",
        bin,
        projectDir: dir,
        timeoutMs: 300,
        env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` },
      })

      const started = Date.now()
      const outcome = await Promise.race([
        service.run(["provider", "list"]).then(
          () => "resolved",
          (err: unknown) => err,
        ),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 1_200)),
      ])
      assert.ok(
        outcome instanceof CcSwitchError,
        `expected the deadline to reject, got ${String(outcome)}`,
      )
      assert.match(outcome.message, /执行超时/)
      assert.ok(Date.now() - started < 1_200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  "run names the output cap when cc-switch floods stdout",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-flood-"))
    try {
      const bin = join(dir, "cc-switch")
      writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(9 * 1024 * 1024))\n')
      chmodSync(bin, 0o755)
      const service = new CcSwitchService({
        app: "opencode",
        bin,
        projectDir: dir,
        timeoutMs: 30_000,
        env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` },
      })

      await assert.rejects(
        () => service.run(["provider", "list"]),
        (err: unknown) => err instanceof CcSwitchError && /8MB 上限/.test(err.message),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("importPrompt and importMcp call deeplink without the app flag", async () => {
  const calls: string[][] = []
  const service = new CcSwitchService({
    app: "open-code",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "✓ imported\n", stderr: "" }
    },
  })

  await service.importPrompt("Demo", "content")
  await service.importMcp('{"mcpServers":{"foo":{"command":"npx"}}}')
  await service.importSkill("owner/repo")

  assert.equal(calls.length, 3)
  for (const args of calls) {
    assert.equal(args[0], "deeplink")
    assert.ok(!args.includes("--app"))
  }
  const promptParams = new URLSearchParams(calls[0]![1]!.split("?")[1] ?? "")
  assert.equal(promptParams.get("app"), "opencode")
  await assert.rejects(() => service.importSkill("not a repo"), CcSwitchError)
  await assert.rejects(() => service.importSkill("owner/.."), CcSwitchError)
  await assert.rejects(() => service.importSkill("../repo"), CcSwitchError)
  assert.equal(calls.length, 3, "invalid skill names must not reach the CLI")
})

test("pty command quoting keeps shell metacharacters out of the spawned argv", () => {
  assert.equal(shellQuote("main"), "main")
  assert.equal(shellQuote("it's"), "'it'\\''s'")

  const dir = mkdtempSync(join(tmpdir(), "cc-pty-"))
  try {
    const marker = join(dir, "pwned")
    const probe = join(dir, "argv.sh")
    writeFileSync(probe, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
    chmodSync(probe, 0o755)

    const evil = `x; touch ${marker} #`
    const command = buildPtyCommand(probe, "cl aude", [evil, "safe-id"])
    // `script -c` evaluates its argument through /bin/sh, so run it the same way
    const out = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })

    assert.deepEqual(out.split("\n").filter(Boolean), ["--app", "cl aude", evil, "safe-id"])
    assert.ok(!existsSync(marker), "embedded command must not have executed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseSpeedtest does not take an unrelated checkmark for success", () => {
  const result = parseSpeedtest("✓ config loaded\n✗ connection refused\n")
  assert.equal(result.ok, false)

  // Older builds print only the checkmark on success, with no failure marker anywhere
  assert.equal(parseSpeedtest("✓ provider reachable\n").ok, true)
})
