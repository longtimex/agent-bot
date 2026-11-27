import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import { AgentCustomModelStore } from "../src/agentCustomModels.js"
import { CliDraftTracker } from "../src/agentCliStream.js"
import { AuthFailureLimiter } from "../src/apiRateLimit.js"
import { installerChildEnv, opencodeServerEnv, scrubEnv } from "../src/binPath.js"
import { telegramMarkdownToFeishu } from "../src/feishuCards.js"
import { JobJournal } from "../src/jobJournal.js"
import { removeJsonPath, setJsonPath } from "../src/jsoncEdit.js"
import { createLogger } from "../src/logger.js"
import { isMetadataAddress, isPrivateAddress, pinnedLookup } from "../src/media.js"
import { escapeMarkdown } from "../src/messages.js"
import { multipartParts, readMultipartPart } from "../src/multipart.js"
import { OpsService } from "../src/ops.js"
import { parseReminder } from "../src/reminders.js"
import { ScheduleService } from "../src/scheduler.js"
import { SecretVault } from "../src/secretVault.js"
import { UsageBudgetStore } from "../src/usageBudget.js"
import { renderWebhookPrompt } from "../src/webhooks.js"
import { snapshotWorkspace, WorkspaceChanges } from "../src/workspaceChanges.js"

const log = createLogger("error")

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("AuthFailureLimiter keeps active cooldown past windowMs and fails closed when full", () => {
  let now = 1_000_000
  const limiter = new AuthFailureLimiter({
    maxFailures: 2,
    windowMs: 60_000,
    blockMs: 300_000,
    maxKeys: 2,
  })
  limiter.recordFailure("1.1.1.1", now)
  const blocked = limiter.recordFailure("1.1.1.1", now)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterSec >= 290)

  // After windowMs (60s), another failure must NOT clear the active 300s block
  now += 70_000
  const stillBlocked = limiter.recordFailure("1.1.1.1", now)
  assert.equal(stillBlocked.allowed, false)
  assert.ok(stillBlocked.retryAfterSec >= 220)

  // Fill every slot with an active cooldown; a new IP must fail closed without evicting live blocks
  limiter.recordFailure("2.2.2.2", now)
  limiter.recordFailure("2.2.2.2", now)
  assert.equal(limiter.recordFailure("3.3.3.3", now).allowed, false, "new IP fails closed when full of active cooldowns")
  assert.equal(limiter.check("1.1.1.1", now).allowed, false, "existing cooldown survives table saturation")
  assert.equal(limiter.check("2.2.2.2", now).allowed, false)
})

test("env scrubbing isolates Feishu callback secrets and opencode server env", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    TELEGRAM_BOT_TOKEN: "tg-secret",
    API_TOKEN: "api-secret",
    FEISHU_CALLBACK_VERIFICATION_TOKEN: "fs-verify",
    FEISHU_CALLBACK_ENCRYPT_KEY: "fs-encrypt",
    CUSTOM_PRIVATE_KEY: "priv-key",
    OPENCODE_SERVER_USERNAME: "oc-user",
    OPENCODE_SERVER_PASSWORD: "oc-pass",
  }

  const scrubbed = scrubEnv(base)
  assert.equal(scrubbed.FEISHU_CALLBACK_VERIFICATION_TOKEN, undefined)
  assert.equal(scrubbed.FEISHU_CALLBACK_ENCRYPT_KEY, undefined)
  assert.equal(scrubbed.TELEGRAM_BOT_TOKEN, undefined)

  const installer = installerChildEnv(base)
  assert.equal(installer.FEISHU_CALLBACK_ENCRYPT_KEY, undefined)
  assert.equal(installer.CUSTOM_PRIVATE_KEY, undefined)

  const ocEnv = opencodeServerEnv(base)
  assert.equal(ocEnv.TELEGRAM_BOT_TOKEN, undefined)
  assert.equal(ocEnv.API_TOKEN, undefined)
  assert.equal(ocEnv.FEISHU_CALLBACK_ENCRYPT_KEY, undefined)
  assert.equal(ocEnv.OPENCODE_SERVER_USERNAME, "oc-user")
  assert.equal(ocEnv.OPENCODE_SERVER_PASSWORD, "oc-pass")
})

test("pinnedLookup supports Node 20+ all:true and isPrivateAddress blocks zone/NAT64/unparseable IPv6", async () => {
  const fn = pinnedLookup("example.com", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
  const allResult = await new Promise<unknown>((resolve, reject) => {
    fn("example.com", { all: true }, (err, address) => {
      if (err) reject(err)
      else resolve(address)
    })
  })
  assert.deepEqual(allResult, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ])

  assert.equal(isPrivateAddress("fe80::1%eth0"), true)
  assert.equal(isPrivateAddress("64:ff9b:1::1.2.3.4"), true)
  assert.equal(isPrivateAddress("::ffff:0:127.0.0.1"), true)
  assert.equal(isPrivateAddress("fd00:ec2::254"), true)
  assert.equal(isMetadataAddress("fd00:ec2::254"), true)
  assert.equal(isMetadataAddress("::ffff:169.254.169.254"), true)
  assert.equal(isPrivateAddress("93.184.216.34"), false)
})

test("AgentCustomModelStore strips encrypted secret from public views and validates inputs", () => {
  const dir = tempDir("bot-acm-reg-")
  try {
    const store = new AgentCustomModelStore(join(dir, "models.json"), join(dir, "accounts.key"), log)
    const added = store.add("codex", {
      value: "gpt-5",
      label: "GPT 5",
      baseURL: "https://relay.example.com/v1",
      apiKey: "sk-live-secret-value",
    })
    assert.equal("secret" in added[0]!, false)
    assert.equal("secret" in store.list("codex")[0]!, false)
    assert.equal("secret" in store.all().codex![0]!, false)
    assert.throws(() => store.add("codex", { value: "bad", label: "bad", baseURL: "javascript:alert(1)" }))
    assert.deepEqual(store.list("toString"), [])
    assert.equal(store.endpointFor("constructor", "x"), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SecretVault.mask scrubs both raw and Markdown-escaped secrets", () => {
  const dir = tempDir("bot-vault-reg-")
  try {
    const vault = new SecretVault(join(dir, "vault.json"), log)
    const secret = "tok_abc*def[123]"
    vault.set("tg:1", "MY_TOKEN", secret)
    const escaped = escapeMarkdown(`failed with ${secret} here`)
    const masked = vault.mask(escaped)
    assert.equal(masked.includes("tok"), false)
    assert.equal(masked.includes("123"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("telegramMarkdownToFeishu preserves fenced and inline code content", () => {
  const src = "Run `a*b\\c` and *bold*:\n```ts\nconst x = a * b // \\n\n```"
  const out = telegramMarkdownToFeishu(src)
  assert.ok(out.includes("`a*b\\c`"), "inline code stays intact")
  assert.ok(out.includes("**bold**"), "outside bold converts")
  assert.ok(out.includes("const x = a * b // \\n"), "fenced code stays intact")
})

test("JobJournal peekRecovery + completeRecovery partitions recovery by channel", () => {
  const dir = tempDir("bot-journal-part-")
  try {
    const journal = new JobJournal<{ key: string; text: string }>(join(dir, "jobs.json"), log)
    journal.track("t1", { key: "tg:100", text: "tg msg" })
    journal.track("f1", { key: "fs:oc_1", text: "fs msg" })

    const reloaded = new JobJournal<{ key: string; text: string }>(join(dir, "jobs.json"), log)
    const fsRec = reloaded.peekRecovery(Date.now(), 30 * 60_000, (payload) => payload.key.startsWith("fs:"))
    assert.equal(fsRec.resume.length, 1)
    assert.equal(fsRec.resume[0]?.id, "f1")
    reloaded.completeRecovery(["f1"])

    // Telegram entry must remain untouched for Telegram recovery
    const tgRec = reloaded.peekRecovery(Date.now(), 30 * 60_000, (payload) => payload.key.startsWith("tg:"))
    assert.equal(tgRec.resume.length, 1)
    assert.equal(tgRec.resume[0]?.id, "t1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("jsoncEdit removes middle properties cleanly and inserts into trailing-comma single-line objects", () => {
  const middleDoc = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n'
  const removed = removeJsonPath(middleDoc, ["b"])
  assert.deepEqual(JSON.parse(removed), { a: 1, c: 3 })

  const trailingSingleLine = '{ "a": 1, }'
  const inserted = setJsonPath(trailingSingleLine, ["b"], 2)
  assert.deepEqual(JSON.parse(inserted.replace(/,\s*}/, "}")), { a: 1, b: 2 })
})

test("CliDraftTracker keeps surrogate pairs intact when capping long output", () => {
  const tracker = new CliDraftTracker("text")
  const chunk = "😀".repeat(7_000)
  const draft = tracker.acceptLine(chunk)
  assert.ok(draft)
  // First char after ellipsis must not be a lone low surrogate
  const afterEllipsis = draft!.charCodeAt(1)
  assert.equal(afterEllipsis >= 0xdc00 && afterEllipsis <= 0xdfff, false)
})

test("multipartParts parses RFC 5987 filename* without corrupting name and enforces field size cap", async () => {
  const boundary = "testbound123"
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file0"; filename="fallback.png"; filename*=UTF-8''%E4%B8%AD%E6%96%87.png\r\n` +
    `Content-Type: image/png\r\n\r\n` +
    `PNGDATA\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="big"\r\n\r\n` +
    `${"x".repeat(128)}\r\n` +
    `--${boundary}--\r\n`

  const req = Readable.from([Buffer.from(payload, "utf8")]) as unknown as IncomingMessage
  const seen: Array<{ name: string; filename?: string; body?: string }> = []
  let capped = false
  for await (const part of multipartParts(req, boundary)) {
    if (part.name === "big") {
      try {
        await readMultipartPart(part.data, 32)
      } catch {
        capped = true
      }
    } else {
      const buf = await readMultipartPart(part.data, 1024)
      seen.push({ name: part.name, filename: part.filename, body: buf.toString("utf8") })
    }
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.name, "file0")
  assert.equal(seen[0]?.filename, "中文.png")
  assert.equal(seen[0]?.body, "PNGDATA")
  assert.equal(capped, true)
})

test("parseReminder handles America/New_York DST spring-forward without shifting backwards", () => {
  // 2026-03-08 01:00 EST (06:00 UTC) — clocks jump from 02:00 EST straight to 03:00 EDT
  const now = Date.UTC(2026, 2, 8, 6, 0, 0)
  const parsed = parseReminder("02:30 spring check", now, "America/New_York")
  // Must NOT be 01:30 EST (06:30 UTC); should resolve forward to 03:30 EDT (07:30 UTC)
  assert.equal(parsed.dueAt, Date.UTC(2026, 2, 8, 7, 30, 0))
})

test("ScheduleService.resume skips stale missed occurrences of overdue repeating tasks", async () => {
  const dir = tempDir("bot-sched-resume-")
  try {
    const now = Date.now()
    let runs = 0
    const service = new ScheduleService(
      join(dir, "schedules.json"),
      async () => {
        runs += 1
        return "ok"
      },
      log,
      "Asia/Shanghai",
    )
    // Task became due 2 hours ago and stayed paused
    const task = service.add(1, 1, "every 30m check", { engine: "opencode" }, now - 2 * 3_600_000)
    service.pause(1, task.id)
    const resumed = service.resume(1, task.id, now)
    assert.ok((resumed?.dueAt ?? 0) > now, "resumed overdue repeat must jump to future slot")
    await service.tick(now)
    await service.idle()
    assert.equal(runs, 0, "must not immediately fire a stale catch-up run")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("OpsService.envList redacts URL credentials, exposes MEDIA_ALLOW_PRIVATE_URLS, and rejects empty int", () => {
  const dir = tempDir("bot-ops-env-")
  try {
    const envPath = join(dir, ".env")
    writeFileSync(
      envPath,
      "HTTP_PROXY=http://alice:supersecret@proxy.example.com:8080\nMEDIA_ALLOW_PRIVATE_URLS=1\n",
    )
    const ops = new OpsService({
      projectDir: dir,
      dataDir: join(dir, "data"),
      opencodeUrl: "http://127.0.0.1:4096",
      envPath,
      logPath: join(dir, "bot.log"),
    })
    const list = ops.envList()
    const proxyEntry = list.entries.find((e) => e.key === "HTTP_PROXY")
    assert.equal(proxyEntry?.secret, false)
    assert.equal(proxyEntry?.value?.includes("supersecret"), false)
    const privEntry = list.entries.find((e) => e.key === "MEDIA_ALLOW_PRIVATE_URLS")
    assert.equal(privEntry?.secret, false)
    assert.equal(privEntry?.value, "1")
    const emptyInt = ops.envSet("MAX_REPLY_CHARS", "")
    assert.equal(emptyInt.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderWebhookPrompt keeps $-replacement sequences literal", () => {
  const out = renderWebhookPrompt(
    {
      name: "demo",
      promptTemplate: "Event={{event}} Body={{payload}}",
    },
    "push",
    '{"diff":"$& $$ $1"}',
  )
  assert.ok(out.includes('{"diff":"$& $$ $1"}'))
})

test("UsageBudgetStore persists /budget off (0) across restarts without rebounding to env", () => {
  const dir = tempDir("bot-budget-reg-")
  try {
    const path = join(dir, "budget.json")
    const env = { USAGE_DAILY_BUDGET_USD: "12.5", USAGE_MONTHLY_BUDGET_USD: "99" }
    const first = new UsageBudgetStore(path, log, env)
    assert.equal(first.dailyUsd, 12.5)
    assert.equal(first.monthlyUsd, 99)

    first.setLimits({ dailyUsd: 0, monthlyUsd: 0 })
    const reloaded = new UsageBudgetStore(path, log, env)
    assert.equal(reloaded.dailyUsd, 0)
    assert.equal(reloaded.monthlyUsd, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("WorkspaceChanges isolates repos after /dir switch and protects edited new files from /undo", () => {
  const base = tempDir("bot-ws-reg-")
  const repoA = join(base, "repo-a")
  const repoB = join(base, "repo-b")
  const initRepo = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
    writeFileSync(join(dir, "README.md"), "init\n")
    execFileSync("git", ["add", "README.md"], { cwd: dir })
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir })
  }
  try {
    initRepo(repoA)
    initRepo(repoB)
    const tracker = new WorkspaceChanges(join(base, "ws.json"), log)

    // AI creates a new file in repoA
    const snap = snapshotWorkspace(repoA)
    assert.ok(snap)
    const createdPath = join(repoA, "new-file.txt")
    writeFileSync(createdPath, "from-ai\n")
    tracker.finish("tg:1", snap!)

    // Switching /dir to repoB must NOT diff or commit repoA
    const diffB = tracker.diff("tg:1", repoB)
    assert.equal(diffB.count, 0)
    const commitB = tracker.commit("tg:1", "should not commit repoA", repoB)
    assert.equal(commitB.ok, false)

    // User manually edits AI's created file in repoA -> /undo must refuse instead of deleting user edits
    writeFileSync(createdPath, "user-edited-after-ai\n")
    const undone = tracker.undo("tg:1")
    assert.equal(undone.ok, false)
    assert.equal(existsSync(createdPath), true)
    assert.equal(readFileSync(createdPath, "utf8"), "user-edited-after-ai\n")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
