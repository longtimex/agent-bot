import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  isValidToken,
  maskToken,
  parseClientSelection,
  parseFeishuOpenIds,
  parseSetupToolMode,
  parseUserIds,
  runClientSetup,
  runFeishuSetup,
  runSetup,
  upsertEnv,
  writeEnvFile,
  type SetupDeps,
} from "../src/setup.js"

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"

function jsonResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status === 200, result, description: status === 200 ? undefined : String(result) }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function feishuTokenResponse(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t-test-token" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function fakeFetch(me: unknown, updates: unknown[], rejectGetMe = false): typeof fetch {
  let updateCalls = 0
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const method = url.slice(url.lastIndexOf("/") + 1)
    if (method === "getMe") {
      if (rejectGetMe) return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })
      return jsonResponse(me)
    }
    if (method === "getUpdates") {
      updateCalls += 1
      // First call drains pending updates, later calls return the simulated message
      return jsonResponse(updateCalls === 1 ? [] : updates)
    }
    throw new Error(`unexpected Telegram method: ${method}`)
  }) as typeof fetch
}

function ownerUpdate(id = 777, username = "alice"): unknown {
  return {
    update_id: 101,
    message: {
      chat: { id, type: "private" },
      from: { id, is_bot: false, username, first_name: "Alice" },
    },
  }
}

function harness(envPath: string, answers: string[], fetchImpl: typeof fetch, detectTimeoutMs = 1_000) {
  const pending = [...answers]
  const lines: string[] = []
  const deps: SetupDeps = {
    ask: async (question) => {
      if (pending.length === 0) throw new Error(`unexpected prompt: ${question}`)
      return pending.shift() as string
    },
    print: (line = "") => lines.push(line),
    fetch: fetchImpl,
    envPath,
    detectTimeoutMs,
  }
  return { deps, pending, lines }
}

test("setup helpers validate tokens, mask secrets and parse whitelist ids", () => {
  assert.equal(isValidToken(TOKEN), true)
  assert.equal(isValidToken(` ${TOKEN} `), true)
  assert.equal(isValidToken("123456789:short"), false)
  assert.equal(isValidToken("not-a-token"), false)

  const masked = maskToken(TOKEN)
  assert.ok(!masked.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"))
  assert.match(masked, /^123456789:\*\*\*[A-Za-z0-9_-]{4}$/)

  assert.deepEqual(parseUserIds("123, 456 789，abc 0 -1"), [123, 456, 789])
  assert.deepEqual(parseUserIds("42,42"), [42])

  assert.deepEqual(parseClientSelection("1,3"), ["telegram", "feishu"])
  assert.deepEqual(parseClientSelection("安卓 飞书"), ["android", "feishu"])
  assert.deepEqual(parseClientSelection("a"), ["telegram", "android", "feishu"])
  assert.deepEqual(parseClientSelection("3,1,3"), ["telegram", "feishu"])
  assert.deepEqual(parseClientSelection("unknown"), [])
  assert.deepEqual(parseFeishuOpenIds("ou_a, ou_b，ou_a"), ["ou_a", "ou_b"])
  assert.equal(parseSetupToolMode([]), "install")
  assert.equal(parseSetupToolMode(["--check-tools"]), "check")
  assert.equal(parseSetupToolMode(["--no-tools"]), "off")
  assert.equal(parseSetupToolMode(["--clients-only"]), "off")
})

test("upsertEnv replaces telegram keys and keeps comments and unrelated values", () => {
  const before = "# keep me\nA=1\nTELEGRAM_BOT_TOKEN=old\nTELEGRAM_ALLOW_USERS=\nB=2\n"
  const after = upsertEnv(before, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOW_USERS: "42,43" })
  assert.match(after, /# keep me/)
  assert.match(after, /^A=1$/m)
  assert.match(after, /^B=2$/m)
  assert.match(after, new RegExp(`^TELEGRAM_BOT_TOKEN=${TOKEN}$`, "m"))
  assert.match(after, /^TELEGRAM_ALLOW_USERS=42,43$/m)
  assert.ok(after.endsWith("\n"))
  assert.equal(after.match(/TELEGRAM_BOT_TOKEN=/g)?.length, 1)

  const appended = upsertEnv("LOG_LEVEL=info\n", { TELEGRAM_BOT_TOKEN: TOKEN })
  assert.match(appended, /^LOG_LEVEL=info$/m)
  assert.match(appended, /首次连接向导/)
  assert.match(appended, new RegExp(`^TELEGRAM_BOT_TOKEN=${TOKEN}$`, "m"))
})

test("writeEnvFile writes the file with mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-env-"))
  try {
    const path = join(dir, ".env")
    writeEnvFile(path, "A=1\n")
    assert.equal(readFileSync(path, "utf8"), "A=1\n")
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runSetup connects, auto-detects the owner and writes .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-auto-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, "# keep me\nLOG_LEVEL=info\n")
    const { deps, pending } = harness(
      envPath,
      [TOKEN, "y", "", "y"],
      fakeFetch({ id: 1, username: "demo_bot", first_name: "Demo" }, [ownerUpdate()]),
    )

    const result = await runSetup(deps)
    assert.equal(result.ok, true)
    assert.equal(result.botUsername, "demo_bot")
    assert.deepEqual(result.users, [777])
    assert.equal(pending.length, 0)

    const env = readFileSync(envPath, "utf8")
    assert.match(env, /# keep me/)
    assert.match(env, /^LOG_LEVEL=info$/m)
    assert.match(env, new RegExp(`^TELEGRAM_BOT_TOKEN=${TOKEN}$`, "m"))
    assert.match(env, /^TELEGRAM_ALLOW_USERS=777$/m)
    assert.equal(statSync(envPath).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runSetup falls back to manual user ids when detection times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-manual-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, "LOG_LEVEL=debug\n")
    const { deps, pending } = harness(
      envPath,
      [TOKEN, "123, 456 789", "y"],
      fakeFetch({ id: 1, username: "demo_bot" }, []),
      0,
    )

    const result = await runSetup(deps)
    assert.equal(result.ok, true)
    assert.deepEqual(result.users, [123, 456, 789])
    assert.equal(pending.length, 0)

    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^LOG_LEVEL=debug$/m)
    assert.match(env, /^TELEGRAM_ALLOW_USERS=123,456,789$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runSetup leaves .env untouched when the token cannot be verified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-fail-"))
  try {
    const envPath = join(dir, ".env")
    const original = "LOG_LEVEL=info\n"
    writeFileSync(envPath, original)
    const { deps, pending } = harness(envPath, [TOKEN, "n", "n"], fakeFetch(undefined, [], true))

    const result = await runSetup(deps)
    assert.equal(result.ok, false)
    assert.equal(pending.length, 0)
    assert.equal(readFileSync(envPath, "utf8"), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runSetup cancels without creating .env when the token prompt is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-cancel-"))
  try {
    const envPath = join(dir, ".env")
    const { deps, pending } = harness(envPath, [""], fakeFetch({ id: 1, username: "demo_bot" }, []))
    const result = await runSetup(deps)
    assert.equal(result.ok, false)
    assert.equal(result.reason, "cancelled")
    assert.equal(pending.length, 0)
    assert.equal(existsSync(envPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("upsertEnv replaces every duplicate of a key so the last line is never stale", () => {
  // dotenv takes the last value, so leaving a second copy with the old token would
  // start the bot with a token the wizard just reported as replaced
  const before = `TELEGRAM_BOT_TOKEN=old\nA=1\nTELEGRAM_BOT_TOKEN=older\n`
  const after = upsertEnv(before, { TELEGRAM_BOT_TOKEN: TOKEN })
  assert.equal(after.match(new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN}`, "g"))?.length, 2)
  assert.ok(!after.includes("old"), after)
  assert.match(after, /^A=1$/m)
})

test("runSetup keeps edits another process made to .env while the wizard was open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-race-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, `# keep me\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    const base = fakeFetch({ id: 1, username: "demo_bot", first_name: "Demo" }, [ownerUpdate()])
    let appended = false
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!appended && String(input).endsWith("/getUpdates")) {
        appended = true
        writeFileSync(
          envPath,
          `${readFileSync(envPath, "utf8")}MAX_MEDIA_MB=30\n`,
        )
      }
      return base(input, init)
    }) as typeof fetch
    const { deps } = harness(envPath, ["y", "y", "", "y"], racing)

    const result = await runSetup(deps)
    assert.equal(result.ok, true)
    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^MAX_MEDIA_MB=30$/m, "a value written meanwhile must survive the wizard")
    assert.match(env, /^# keep me$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("apiCall failures redact the token that the error URL would otherwise echo", async () => {
  const token = "123456789:AAExampleTokenForRedactionTest"
  const leaked: string[] = []
  // getMe 网络错误:undici 的 message 会带上完整 URL(含 token),redactToken 必须遮蔽
  const deps = {
    ask: async (question: string) => {
      if (question.includes("粘贴")) return token
      if (question.includes("重试")) return "n"
      return ""
    },
    print: (line = "") => {
      leaked.push(line)
    },
    fetch: (async (url: string | URL | Request) => {
      throw new Error(`fetch failed: ${String(url)}`)
    }) as unknown as typeof fetch,
    envPath: "/tmp/does-not-matter.env",
  }

  // 三次 getMe 重试都失败 → 向导询问是否仍保存 → 回 n 走取消分支
  const result = await runSetup(deps)
  assert.equal(result.ok, false)
  const failureLine = leaked.find((line) => line.includes("连接 Telegram 失败"))
  assert.ok(failureLine, "the failure branch printed its warning")
  assert.ok(!failureLine.includes(token), "the token must be masked in the printed failure")
  assert.match(failureLine, /\*\*\*/)
})

test("runClientSetup accepts Android alone and writes a usable pairing configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-android-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, "# keep me\nLOG_LEVEL=info\nAPI_BIND=127.0.0.1\n")
    const { deps, pending, lines } = harness(
      envPath,
      ["2", "0.0.0.0", "3080", "http://192.168.1.10:3080", "y"],
      fakeFetch(undefined, []),
    )

    const result = await runClientSetup(deps)
    assert.equal(result.ok, true)
    assert.deepEqual(result.clients, ["android"])
    assert.equal(result.api?.url, "http://192.168.1.10:3080")
    assert.equal(pending.length, 0)

    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^# keep me$/m)
    assert.match(env, /^LOG_LEVEL=info$/m)
    assert.match(env, /^API_ENABLED=1$/m)
    assert.match(env, /^API_BIND=0\.0\.0\.0$/m)
    assert.match(env, /^API_PORT=3080$/m)
    assert.match(env, /^API_PUBLIC_URL=http:\/\/192\.168\.1\.10:3080$/m)
    assert.match(env, /^API_TOKEN=[0-9a-f]{48}$/m)
    assert.ok(lines.some((line) => line.includes("http://192.168.1.10:3080/api/v1")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the Android wizard re-asks when API_BIND is a port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-android-port-"))
  try {
    const envPath = join(dir, ".env")
    const { deps, pending, lines } = harness(
      envPath,
      ["2", "3080", "0.0.0.0", "3080", "http://192.168.1.10:3080", "y"],
      fakeFetch(undefined, []),
    )

    const result = await runClientSetup(deps)
    assert.equal(result.ok, true)
    assert.equal(pending.length, 0)
    assert.ok(lines.some((line) => line.includes("这是端口号")), "the hint must name the mistaken field")
    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^API_BIND=0\.0\.0\.0$/m)
    assert.match(env, /^API_PORT=3080$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runClientSetup continues into the optional tool stage after saving the client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-tools-"))
  try {
    const envPath = join(dir, ".env")
    const { deps, pending } = harness(
      envPath,
      ["2", "0.0.0.0", "3080", "http://192.168.1.10:3080", "y"],
      fakeFetch(undefined, []),
    )
    const calls: string[] = []
    const result = await runClientSetup({
      ...deps,
      setupTools: async () => {
        calls.push("tools")
        assert.match(readFileSync(envPath, "utf8"), /^API_TOKEN=[0-9a-f]{48}$/m)
        return { ok: true, installed: ["magpie"], failed: [] }
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.tools, { ok: true, installed: ["magpie"], failed: [] })
    assert.deepEqual(calls, ["tools"])
    assert.equal(pending.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failed optional tool stage does not undo a saved client or fail setup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-tools-fail-"))
  try {
    const envPath = join(dir, ".env")
    const { deps } = harness(
      envPath,
      ["2", "0.0.0.0", "3080", "http://192.168.1.10:3080", "y"],
      fakeFetch(undefined, []),
    )
    const result = await runClientSetup({
      ...deps,
      setupTools: async () => ({ ok: false, installed: [], failed: ["magpie"] }),
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.tools, { ok: false, installed: [], failed: ["magpie"] })
    assert.match(readFileSync(envPath, "utf8"), /^API_PUBLIC_URL=http:\/\/192\.168\.1\.10:3080$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runFeishuSetup validates credentials and writes a callback-safe configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-feishu-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, "LOG_LEVEL=debug\n")
    const { deps, pending } = harness(
      envPath,
      ["cli_0123456789abcdef", "secret-value", "ou_owner", "", "y", "", "verify-me", "y"],
      (async () => feishuTokenResponse()) as typeof fetch,
    )

    const result = await runFeishuSetup(deps)
    assert.equal(result.ok, true)
    assert.deepEqual(result.clients, ["feishu"])
    assert.equal(pending.length, 0)

    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^FEISHU_APP_ID=cli_0123456789abcdef$/m)
    assert.match(env, /^FEISHU_APP_SECRET=secret-value$/m)
    assert.match(env, /^FEISHU_ALLOW_OPEN_IDS=ou_owner$/m)
    assert.match(env, /^FEISHU_ALLOW_ALL_USERS=0$/m)
    assert.match(env, /^FEISHU_CALLBACK_ENABLED=1$/m)
    assert.match(env, /^FEISHU_CALLBACK_VERIFICATION_TOKEN=verify-me$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("adding Feishu later preserves existing Telegram configuration and comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-add-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, `# existing deployment\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ALLOW_USERS=777\n# trailing note\n`)
    const { deps, pending } = harness(
      envPath,
      ["3", "cli_0123456789abcdef", "secret-value", "ou_owner", "", "n", "y"],
      (async () => feishuTokenResponse()) as typeof fetch,
    )

    const result = await runClientSetup(deps)
    assert.equal(result.ok, true)
    assert.deepEqual(result.clients, ["feishu"])
    assert.equal(pending.length, 0)

    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^# existing deployment$/m)
    assert.match(env, new RegExp(`^TELEGRAM_BOT_TOKEN=${TOKEN}$`, "m"))
    assert.match(env, /^TELEGRAM_ALLOW_USERS=777$/m)
    assert.match(env, /^# trailing note$/m)
    assert.match(env, /^FEISHU_APP_ID=cli_0123456789abcdef$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runFeishuSetup retries an invalid app id before writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-setup-feishu-invalid-"))
  try {
    const envPath = join(dir, ".env")
    writeFileSync(envPath, "LOG_LEVEL=info\n")
    const { deps, pending } = harness(
      envPath,
      ["bad-id", "cli_0123456789abcdef", "secret-value", "ou_owner", "", "y", "", "verify-me", "y"],
      (async () => feishuTokenResponse()) as typeof fetch,
    )
    const result = await runFeishuSetup(deps)
    assert.equal(result.ok, true)
    assert.equal(pending.length, 0)
    const env = readFileSync(envPath, "utf8")
    assert.match(env, /^FEISHU_CALLBACK_VERIFICATION_TOKEN=verify-me$/m)
    assert.doesNotMatch(env, /^FEISHU_APP_ID=bad-id$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
