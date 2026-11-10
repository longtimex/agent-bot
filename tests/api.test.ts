import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server } from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { ApiServer, resolveApiToken, CC_EXEC_COMMANDS, CC_VIEWS } from "../src/api.js"
import { AndroidReleaseService } from "../src/androidRelease.js"
import { ccBlockedReason, ccConfirmPlan } from "../src/ccGuards.js"
import { AgentCliRegistry } from "../src/agentCli.js"
import type { AgentCliInstaller } from "../src/agentInstaller.js"
import type { BotConfig } from "../src/config.js"
import { CC_SUB_ALIASES } from "../src/help.js"
import { TaskHistoryStore } from "../src/history.js"
import type { Logger } from "../src/logger.js"
import { ModelAdmin } from "../src/modelAdmin.js"
import { ProxyService } from "../src/proxy.js"
import { AliasStore } from "../src/aliases.js"
import { Opencode } from "../src/opencode.js"
import type { OpsService } from "../src/ops.js"
import { CcSwitchError, CcSwitchRunError, type CcSwitchService } from "../src/ccswitch.js"
import { ReminderService } from "../src/reminders.js"
import { ScheduleService } from "../src/scheduler.js"
import { SessionStore } from "../src/store.js"
import type { AgentCliService } from "../src/agentCli.js"
import { UsageStore } from "../src/usage.js"
import { appModelNames, appModelShape } from "./support/appModels.js"
import { appRequestUrl, normalizeAppBaseUrl } from "./support/appBaseUrl.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error(...a: unknown[]) { console.error("LOG-ERR", ...a) } }
const TOKEN = "test-token-0123456789abcdef"

interface Harness {
  api: ApiServer
  base: string
  store: SessionStore
  usage: UsageStore
  history: TaskHistoryStore
  reminders: ReminderService
  schedules: ScheduleService
  registry: AgentCliRegistry
  dataDir: string
  cleanup: () => Promise<void>
  ocCalls: Array<{ text: string; files: Array<{ mime?: string; filename?: string }> }>
  installs: string[]
  ccCalls: string[]
  magpieCalls: string[]
  releaseActions: string[]
  /** Makes the next cc-switch read fail, for a route that writes first and then re-reads. */
  ccFailNextRead: () => void
  /** Simulates the owner appearing or changing after the API server has started. */
  setOwner: (chatId: number, userId?: number) => void
}

export async function withApi(
  promptImpl: (key: string, engine: string, text: string, onProgress?: (s: string) => void, signal?: AbortSignal) => Promise<string>,
  run: (h: Harness) => Promise<void>,
  encKey?: Buffer,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-bot-api-"))
  const store = new SessionStore(join(dir, "sessions.json"), log)
  // The real store, keyed exactly as Telegram keys it, so per-session views are tested
  // against the shapes the App decodes rather than a stub that always answers zero.
  const usage = new UsageStore(join(dir, "usage.json"), log, "Asia/Shanghai")
  const history = new TaskHistoryStore(join(dir, "history.json"), log)
  const reminders = new ReminderService(
    join(dir, "reminders.json"),
    () => {},
    log,
    "Asia/Shanghai",
    () => true,
  )
  const registry = new AgentCliRegistry({ path: join(dir, "agents.json"), log })
  const schedules = new ScheduleService(join(dir, "schedules.json"), () => {}, log, "Asia/Shanghai", registry)
  const agents = {
    registry,
    defaultWorkDir: dir,
    // Mirrors AgentCliService.workDir: a stored dir only counts while it still exists
    workDir: (key: string) => {
      const custom = store.getDir(key)
      return custom && existsSync(custom) ? custom : dir
    },
    prompt: (key: string, engine: string, text: string, _m: unknown, onProgress?: (s: string) => void, signal?: AbortSignal) =>
      promptImpl(key, engine, text, onProgress, signal),
  } as unknown as AgentCliService
  const ocCalls: Array<{ text: string; files: Array<{ mime?: string; filename?: string }> }> = []
  const oc = {
    health: async () => true,
    deleteSession: async () => {},
    createSession: async () => `sess-${Math.random().toString(36).slice(2, 8)}`,
    inputCapabilities: async () => undefined,
    prompt: async (_sid: string, text: string, options?: { files?: Array<{ mime?: string; filename?: string }> }) => {
      ocCalls.push({ text, files: options?.files ?? [] })
      return `回复：${text.slice(0, 40)}`
    },
    subscribeSession: () => () => {},
    abortSession: async () => {},
  } as unknown as Opencode
  const models = new ModelAdmin(join(dir, "models.json"), dir, "assistant", store)
  // Instant success so proxy management tests stay fast and offline
  const aliases = new AliasStore(join(dir, "aliases.json"), log)
  const allowUsers = new Set(["42", "7"])
  const access = {
    list: () => ({ users: [...allowUsers], allowAll: false }),
    add: (ids: string[]) => {
      for (const id of ids) {
        if (!/^\d{1,20}$/.test(id)) return { ok: false, message: `用户 ID 只能是 20 位以内的数字（收到：${id}）。` }
      }
      for (const id of ids) allowUsers.add(id)
      return { ok: true, message: `已加入白名单：${ids.join("、")}。` }
    },
    remove: (ids: string[]) => {
      for (const id of ids) {
        if (!allowUsers.has(id)) return { ok: false, message: "这些用户不在白名单中。" }
      }
      if (ids.includes("42")) return { ok: false, message: "不能把自己移出白名单，否则你将无法再控制 Bot。" }
      if (allowUsers.size - ids.length === 0) return { ok: false, message: "白名单不能为空。" }
      for (const id of ids) allowUsers.delete(id)
      return { ok: true, message: `已移出白名单：${ids.join("、")}。` }
    },
  }
  const proxies = new ProxyService(join(dir, "proxies.json"), log, {
    envPath: join(dir, "proxy.env"),
    tester: async () => {},
  })
  const releaseActions: string[] = []
  const ops = {
    releaseState: () => ({
      current: {
        id: "20261108-120000-abc",
        commit: "0123456789abcdef0123456789abcdef01234567",
        version: "0.4.0",
        createdAt: "2026-11-08T12:00:00.000Z",
        path: join(dir, "data", "releases", "store", "20261108-120000-abc"),
      },
      previous: {
        id: "20261107-120000-def",
        commit: "89abcdef0123456789abcdef0123456789abcdef",
        version: "0.3.0",
        createdAt: "2026-11-07T12:00:00.000Z",
        path: join(dir, "data", "releases", "store", "20261107-120000-def"),
      },
      pending: undefined,
      lastUpdate: {
        at: "2026-11-08T12:00:00.000Z",
        from: "89abcdef",
        to: "01234567",
        status: "ok" as const,
        message: "新版本已通过健康检查。",
        report: { steps: [] },
      },
    }),
    releaseLabel: () => "01234567 v0.4.0",
    releaseOverview: () => ({
      release: {
        label: "01234567 v0.4.0",
        current: "20261108-120000-abc",
        previous: "20261107-120000-def",
        lastUpdateAt: "2026-11-08T12:00:00.000Z",
        lastUpdateStatus: "ok",
        lastUpdateMessage: "新版本已通过健康检查。",
      },
      update: { channel: "stable", ref: "origin/main" },
      startup: {
        at: "2026-11-08T12:00:00.000Z",
        version: "0.4.0",
        pid: process.pid,
        commit: "0123456789abcdef0123456789abcdef01234567",
        release: "20261108-120000-abc",
        previousRelease: "20261107-120000-def",
        migration: { ok: true, fromVersion: "1", toVersion: "1", message: "数据 schema 已是最新（v1）。" },
        api: { requested: true, reachable: true },
        engine: "claude",
        notes: ["HTTP API 已启动", "数据迁移检查通过"],
      },
      lastBackupAt: 0,
    }),
    cancelPendingRelease: () => {
      releaseActions.push("cancel-pending")
      return { ok: false, message: "没有等待应用的预构建版本。", steps: [] }
    },
    rollbackRelease: () => {
      releaseActions.push("rollback")
      return { ok: false, message: "没有可回滚的上一版 release。", steps: [] }
    },
    diagnostics: async () => ({
      node: process.version,
      platform: "linux x64",
      pid: process.pid,
      systemd: false,
      projectDir: dir,
      uptimeSec: 1,
      opencode: { url: "http://127.0.0.1:1", reachable: true, managed: false },
      log: { path: join(dir, "bot.log"), bytes: 10 },
      opencodeLog: { path: join(dir, "opencode.log"), bytes: 0 },
      memory: { freeBytes: 1, totalBytes: 2 },
      lastBackupAt: 0,
      release: {
        label: "01234567 v0.4.0",
        current: "20261108-120000-abc",
        previous: "20261107-120000-def",
        lastUpdateAt: "2026-11-08T12:00:00.000Z",
        lastUpdateStatus: "ok",
        lastUpdateMessage: "新版本已通过健康检查。",
      },
      update: { channel: "stable", ref: "origin/main" },
      startup: {
        at: "2026-11-08T12:00:00.000Z",
        version: "0.4.0",
        pid: process.pid,
        commit: "0123456789abcdef0123456789abcdef01234567",
        release: "20261108-120000-abc",
        previousRelease: "20261107-120000-def",
        migration: { ok: true, fromVersion: "1", toVersion: "1", message: "数据 schema 已是最新（v1）。" },
        api: { requested: true, reachable: true },
        engine: "claude",
        notes: ["HTTP API 已启动", "数据迁移检查通过"],
      },
    }),
    tailLogs: (source: string, lines: number) => ({
      ok: true,
      missing: false,
      path: join(dir, `${source}.log`),
      bytes: 10,
      text: `${source}-${lines}`,
    }),
    opencodeStatus: async () => ({ reachable: true, managed: true, pid: 123, url: "http://127.0.0.1:4096" }),
    runCheck: async () => ({
      ok: true,
      message: "检查通过。",
      steps: [{ label: "npm run check", ok: true, code: 0, output: "ok" }],
    }),
    updateProject: async () => {
      releaseActions.push("update")
      return {
        ok: false,
        message: "工作区有未提交的改动，已中止更新。",
        steps: [{ label: "检查工作区", ok: true, code: 0, output: " M src/api.ts" }],
      }
    },
    restartBot: async () => {
      releaseActions.push("restart")
      return { ok: true, message: "已触发重启。", steps: [] }
    },
    startOpencode: async () => ({ ok: true, message: "OpenCode 已启动。", steps: [] }),
    stopOpencode: async () => ({ ok: true, message: "OpenCode 已停止。", steps: [] }),
    restartOpencode: async () => ({ ok: true, message: "OpenCode 已重启。", steps: [] }),
    // The App's 检查更新 and 备份下载 buttons read these two; without them those routes 500.
    checkUpdate: async () => ({
      ok: true,
      message: "落后 2 个提交。",
      steps: [{ label: "git fetch", ok: true, code: 0, output: "behind 2" }],
    }),
    backupData: async () => {
      const file = join(dir, "backup.tar.gz")
      writeFileSync(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
      return { ok: true, message: "备份已生成。", steps: [], file }
    },
    installCcSwitch: async (update: boolean) => {
      ccCalls.push(update ? "ops:cc-update" : "ops:cc-install")
      return { ok: true, message: update ? "cc-switch 已更新。" : "cc-switch 已安装。", steps: [] }
    },
    envList: () => ({
      exists: true,
      entries: [...envEntries].map(([key, value]) => ({ key, value, secret: false, editable: key !== "TELEGRAM_ALLOW_USERS" })),
    }),
    envSet: (rawKey: string, value: string) => {
      const key = rawKey.trim().toUpperCase()
      if (key === "TELEGRAM_ALLOW_USERS") return { ok: false, message: `${key} 请使用 /access 修改。` }
      if (key === "BOGUS") return { ok: false, message: "不支持修改 BOGUS。" }
      envEntries.set(key, value)
      return { ok: true, message: `已更新 ${key}。` }
    },
    envUnset: (rawKey: string) => {
      const key = rawKey.trim().toUpperCase()
      if (!envEntries.delete(key)) return { ok: false, message: `未设置 ${key}。` }
      return { ok: true, message: `已删除 ${key}。` }
    },
  } as unknown as OpsService
  const installs: string[] = []
  const ccCalls: string[] = []
  const apkBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from("agent-bot-test-apk")])
  const androidDir = join(dir, "data", "android", "releases")
  mkdirSync(androidDir, { recursive: true })
  writeFileSync(join(androidDir, "agent-bot-v1.1.0.apk"), apkBytes)
  writeFileSync(join(dir, "data", "android-release.json"), JSON.stringify({
    versionName: "1.1.0",
    versionCode: 1_001_000,
    apk: "android/releases/agent-bot-v1.1.0.apk",
    sha256: createHash("sha256").update(apkBytes).digest("hex"),
    size: apkBytes.length,
    notes: "测试更新",
    publishedAt: "2026-11-08T00:00:00Z",
  }))
  let ccFailsOneRead = false
  const ccswitch = {
    available: true,
    app: "opencode",
    // cc-switch only takes raw settings JSON for this app, and the form must know
    supportsProviderFields: false,
    bin: "/usr/local/bin/cc-switch",
    listProviders: async () => [
      { id: "p1", name: "Alpha", apiUrl: "https://a.example", current: true },
      { id: "p2", name: "Beta", apiUrl: "https://b.example", current: false },
    ],
    version: async () => "cc-switch 1.2.3",
    useProvider: async (id: string) => {
      ccCalls.push(`use:${id}`)
      return `switched ${id}`
    },
    speedtest: async (id: string) => {
      ccCalls.push(`test:${id}`)
      return { ok: true, latencyMs: 42, status: "200", raw: "pong 42ms" }
    },
    listMcp: async () => "mcp list output",
    syncMcp: async () => {
      ccCalls.push("mcp:sync")
      return "synced"
    },
    listPrompts: async () => "prompts list",
    activatePrompt: async (id: string) => {
      ccCalls.push(`prompt:${id}`)
      return "activated"
    },
    deactivatePrompt: async () => {
      ccCalls.push("prompt:off")
      return "off"
    },
    envTools: async () => "tools output",
    envCheck: async () => "check ok",
    streamCheck: async (id: string) => {
      ccCalls.push(`stream:${id}`)
      return "stream ok: first token in 120ms"
    },
    fetchModels: async (id: string) => {
      ccCalls.push(`models:${id}`)
      return "gpt-5, gpt-5-codex"
    },
    importMcp: async (input: string) => {
      ccCalls.push(`mcp:import:${input.slice(0, 12)}`)
      return "imported"
    },
    importPrompt: async (name: string, content: string) => {
      ccCalls.push(`prompt:new:${name}:${content.length}`)
      return "created"
    },
    proxyShow: async () => "proxy http://127.0.0.1:7890",
    addProvider: async (draft: { name: string; template?: string; apiKey?: string }) => {
      if (draft.template === "nope") throw new CcSwitchError("未知的 Provider 模板，可用：custom。")
      if (draft.name === "dup") throw new CcSwitchRunError("该 Provider 名称已存在")
      ccCalls.push(`provider:new:${draft.name}:${draft.template ?? ""}`)
      const key = draft.apiKey ?? ""
      const stdout = key ? `created ${draft.name} with ${key}` : `created ${draft.name}`
      return { code: 0, stdout, stderr: "" }
    },
    run: async (args: string[]) => {
      ccCalls.push(`run:${args.join(" ")}`)
      // Hermes memory is answered like the real CLI, so the screen's read/write contract
      // (limits wording, the "empty" sentence, `--yes` on a clear) is exercised for real
      if (args[0] === "hermes" && args[1] === "memory" && (args[2] === "limits" || args[2] === "show")) {
        if (ccFailsOneRead) {
          ccFailsOneRead = false
          throw new CcSwitchRunError("cc-switch 读取失败：数据库被占用")
        }
      }
      if (args[0] === "hermes" && args[1] === "memory") {
        if (args[2] === "limits") {
          return {
            code: 0,
            stdout:
              "Hermes memory limits:\n  memory:  2200 chars  (enabled: true)\n  user:    1375 chars  (enabled: false)\n",
            stderr: "",
          }
        }
        if (args[2] === "show") {
          // cc-switch puts the kind before the word "memory" in this sentence
          return args[3] === "user"
            ? { code: 0, stdout: "Hermes user memory is empty (file not created yet)\n", stderr: "" }
            : { code: 0, stdout: "旧记忆\n第二行\n", stderr: "" }
        }
        if (args[2] === "set") return { code: 0, stdout: `✓ Wrote ${args[5]?.length ?? 0} bytes`, stderr: "" }
        return { code: 0, stdout: `✓ ${args.slice(2).join(" ")}`, stderr: "" }
      }
      return { code: 0, stdout: `view ${args.join(" ")}`, stderr: "" }
    },
    runBare: async (args: string[]) => {
      ccCalls.push(`bare:${args[0]}:${args.slice(1).join(" ").slice(0, 20)}`)
      return { code: 0, stdout: `bare ${args.join(" ")}`, stderr: "" }
    },
    runWithConfirm: async (args: string[]) => {
      ccCalls.push(`confirm:${args.join(" ")}`)
      return { code: 0, stdout: `did ${args.join(" ")}`, stderr: "" }
    },
  } as unknown as CcSwitchService
  const envEntries = new Map<string, string>([
    ["LOG_LEVEL", "info"],
    ["OPENCODE_URL", "http://127.0.0.1:1"],
  ])
  const managed = new Set<string>(["codex"])
  const installer = {
    isManaged: (engine: string) => managed.has(engine),
    installCommand: (profile: { id: string; installSpec?: unknown }) =>
      profile.installSpec ? `install ${profile.id}` : undefined,
    updateCommand: (engine: string) => (managed.has(engine) ? `update ${engine}` : undefined),
    uninstallCommand: (engine: string) => (managed.has(engine) ? `uninstall ${engine}` : undefined),
    install: async (engine: string) => {
      installs.push(engine)
      managed.add(engine)
      return { ok: true, message: `installed ${engine}`, output: "npm ok" }
    },
    update: async (engine: string) => ({ ok: true, message: `updated ${engine}` }),
    uninstall: async (engine: string) => {
      managed.delete(engine)
      return { ok: true, message: `removed ${engine}` }
    },
  } as unknown as AgentCliInstaller
  const magpieCalls: string[] = []
  const magpie = {
    available: true,
    bin: "/usr/local/bin/magpie",
    gatewayUrl: "http://127.0.0.1:3425",
    overview: async () => ({
      available: true,
      bin: "/usr/local/bin/magpie",
      version: "magpie 1.2.3",
      gatewayUrl: "http://127.0.0.1:3425",
      healthy: true,
    }),
    runRaw: async (args: string[]) => {
      magpieCalls.push(args.join(" "))
      return `magpie: ${args.join(" ")}`
    },
    addProvider: async (preset: string, key: string) => {
      magpieCalls.push(`add:${preset}`)
      void key
      return "provider added"
    },
    setAgentModel: async (agent: string, model: string) => {
      magpieCalls.push(`set:${agent}:${model}`)
      return "model set"
    },
    addGroup: async (name: string, pairs: string[]) => {
      magpieCalls.push(`group:${name}:${pairs.join(",")}`)
      return "group added"
    },
  }

  const cfg = {
    opencode: { url: "http://127.0.0.1:1", username: "opencode", agent: "assistant" },
    taskTimeoutMs: 10_000,
    taskMaxTimeoutMs: 10_000,
    dataDir: dir,
    inboxDir: join(dir, "inbox"),
    outboxDir: join(dir, "outbox"),
    maxMediaBytes: 20 * 1024 * 1024,
    api: { enabled: true, port: 0, bind: "127.0.0.1" },
    telegram: { allowUsers: new Set(["42"]), allowAll: false },
  } as unknown as BotConfig

  let currentTz = "Asia/Shanghai"
  let ownerChatId: number | undefined = 42
  let ownerUserId: number | undefined = 42
  const api = new ApiServer(
    {
      cfg,
      oc,
      agents,
      store,
      log,
      usage,
      history,
      reminders,
      schedules,
      models,
      proxies,
      aliases,
      access,
      timezone: () => currentTz,
      setTimezone: (zone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone })
        } catch {
          return { ok: false, message: `REMINDER_TIMEZONE 无效：${zone}。` }
        }
        currentTz = zone
        return { ok: true, message: "已更新时区，立即生效。" }
      },
      ops,
      installer,
      androidRelease: new AndroidReleaseService({ projectDir: dir }),
      ccswitch,
      magpie: magpie as unknown as import("../src/magpie.js").MagpieService,
      fetchMedia: async (target: string) => Buffer.from(`remote:${target}`),
      ownerChatId: () => ownerChatId,
      ownerUserId: () => ownerUserId,
    },
    TOKEN,
    encKey,
  )
  // Deterministic engine for the prompts: the CLI stub resolves immediately.
  store.setEngine("api:app", "claude")
  await api.start()
  const endpoint = api.endpoint
  if (!endpoint) throw new Error("api server did not report an endpoint")
  const base = endpoint
  try {
    await run({
      api,
      base,
      store,
      usage,
      history,
      reminders,
      schedules,
      registry,
      dataDir: dir,
      cleanup: () => api.stop(),
      ocCalls,
      installs,
      ccCalls,
      magpieCalls,
      releaseActions,
      ccFailNextRead: () => {
        ccFailsOneRead = true
      },
      setOwner: (chatId, userId = chatId) => {
        ownerChatId = chatId
        ownerUserId = userId
      },
    })
  } finally {
    await api.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

export function authHeaders(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" }
}

test("resolveApiToken generates once and reuses the stored token", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bot-token-"))
  try {
    const cfg = { dataDir: dir, api: { enabled: true, port: 3080, bind: "127.0.0.1" } } as unknown as BotConfig
    const first = resolveApiToken(cfg)
    assert.ok(first.length >= 16)
    const second = resolveApiToken(cfg)
    assert.equal(second, first)
    const stored = JSON.parse(readFileSync(join(dir, "api-token.json"), "utf8")) as { token: string }
    assert.equal(stored.token, first)
    const stat = readFileSync(join(dir, "api-token.json"), { flag: "r" })
    assert.ok(stat)
    // An explicit API_TOKEN always wins
    const override = resolveApiToken({ ...cfg, api: { ...cfg.api, token: "explicit-token" } } as unknown as BotConfig)
    assert.equal(override, "explicit-token")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("api rejects unauthenticated requests", async () => {
  await withApi(async () => "ok", async (h) => {
    const noAuth = await fetch(`${h.base}/api/v1/health`)
    assert.equal(noAuth.status, 401)
    const badToken = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders("wrong") })
    assert.equal(badToken.status, 401)
    const ok = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as { ok: boolean; name: string }
    assert.equal(body.ok, true)
    assert.equal(body.name, "agent-bot")
  })
})

test("api adds security headers and gzips large JSON when the client asks", async () => {
  await withApi(async () => "ok", async (h) => {
    const health = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
    assert.equal(health.headers.get("cache-control"), "no-store")
    assert.equal(health.headers.get("x-content-type-options"), "nosniff")
    assert.equal(health.headers.get("x-frame-options"), "DENY")
    assert.equal(health.headers.get("referrer-policy"), "no-referrer")

    // /help is well over the compression threshold and is plain JSON, unlike SSE/media
    const help = await fetch(`${h.base}/api/v1/help`, {
      headers: { ...authHeaders(), "accept-encoding": "gzip" },
    })
    assert.equal(help.headers.get("content-encoding"), "gzip")
    const parsed = (await help.json()) as { commands: unknown[] }
    assert.ok(Array.isArray(parsed.commands))
  })
})

test("api answers with a Date the App can turn into a clock offset", async () => {
  await withApi(async () => "ok", async (h) => {
    const res = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
    const date = res.headers.get("date")
    // The App reads its server-clock offset off this one header on every response: a body field
    // would need a new endpoint, and an SSE frame carries no such field at all. Kotlin parses it
    // with RFC_1123_DATE_TIME, so the shape has to stay exactly that.
    assert.ok(date, "every JSON answer has to carry a Date header")
    assert.match(date, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
    assert.ok(Math.abs(Date.parse(date) - Date.now()) < 1_500, `${date} is more than a second away from now`)
  })
})

test("api rate-limits repeated bad bearer tokens without locking out the right one", async () => {
  await withApi(async () => "ok", async (h) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders("not-the-token") })
      assert.equal(res.status, 401)
    }
    const blocked = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders("not-the-token") })
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1)
    // Every phone behind one nginx is the same socket address, which is what this budget is
    // keyed on: a device holding the correct token must not be refused for another's failures,
    // or the App goes silent for the whole cooldown and re-scanning the QR changes nothing.
    const correct = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
    assert.equal(correct.status, 200)
    // …and the attacker's cooldown survives that success, so it cannot be laundered away.
    const still = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders("not-the-token") })
    assert.equal(still.status, 429)
  })
})

test("api runs a task end to end and records history", async () => {
  await withApi(
    async (_key, _engine, text, onProgress) => {
      onProgress?.("思考中…")
      return `回复：${text}`
    },
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "你好" }),
      })
      assert.equal(created.status, 202)
      const { task } = (await created.json()) as { task: { id: string } }

      let done = false
      let final: { status: string; reply?: string; progress?: string } | undefined
      for (let i = 0; i < 50 && !done; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
        final = ((await res.json()) as { task: { status: string; reply?: string; progress?: string } }).task
        done = final.status === "done"
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(final?.status, "done")
      assert.equal(final?.reply, "回复：你好")

      const history = await fetch(`${h.base}/api/v1/history`, { headers: authHeaders() })
      const entries = ((await history.json()) as { history: Array<{ prompt: string; outcome: string }> }).history
      assert.equal(entries[0]?.prompt, "你好")
      assert.equal(entries[0]?.outcome, "ok")
    },
  )
})

test("api surfaces task media and serves local and remote files", async () => {
  await withApi(
    async (_key, _engine, text) =>
      text.includes("远程") ? "[[file: https://example.com/report.pdf]]" : "这是图片\n[[image: pic.png]]",
    async (h) => {
      const outbox = join(h.dataDir, "outbox")
      mkdirSync(outbox, { recursive: true })
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      writeFileSync(join(outbox, "pic.png"), png)

      const submit = async (text: string): Promise<string> => {
        const res = await fetch(`${h.base}/api/v1/task`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text }),
        })
        assert.equal(res.status, 202)
        return ((await res.json()) as { task: { id: string } }).task.id
      }
      const waitDone = async (id: string) => {
        for (let i = 0; i < 50; i++) {
          const res = await fetch(`${h.base}/api/v1/task/${id}`, { headers: authHeaders() })
          const task = (
            (await res.json()) as {
              task: {
                status: string
                reply: string
                media?: Array<{ index: number; kind: string; label: string; name: string; size: number; remote: boolean }>
              }
            }
          ).task
          if (task.status === "done") return task
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error("task did not finish")
      }

      const localId = await submit("画一张图")
      const local = await waitDone(localId)
      assert.equal(local.reply, "这是图片")
      assert.deepEqual(local.media, [
        { index: 0, kind: "image", label: "图片", name: "pic.png", size: png.byteLength, remote: false },
      ])

      const localFile = await fetch(`${h.base}/api/v1/task/${localId}/media/0`, { headers: authHeaders() })
      assert.equal(localFile.status, 200)
      assert.equal(localFile.headers.get("content-type"), "image/png")
      assert.deepEqual(Buffer.from(await localFile.arrayBuffer()), png)

      const missing = await fetch(`${h.base}/api/v1/task/${localId}/media/3`, { headers: authHeaders() })
      assert.equal(missing.status, 404)

      const remoteId = await submit("远程报告")
      const remote = await waitDone(remoteId)
      assert.equal(remote.reply, "")
      assert.equal(remote.media?.[0]?.remote, true)
      assert.equal(remote.media?.[0]?.name, "report.pdf")
      const remoteFile = await fetch(`${h.base}/api/v1/task/${remoteId}/media/0`, { headers: authHeaders() })
      assert.equal(remoteFile.status, 200)
      assert.equal(remoteFile.headers.get("content-type"), "application/pdf")
      assert.equal(await remoteFile.text(), "remote:https://example.com/report.pdf")
    },
  )
})

/**
 * Telegram answers "⚠️ 图片发送失败：…" when a media directive cannot be delivered. An App user
 * would otherwise read a reply that simply stops short of the attachment they asked for.
 */
test("api tells the client when a media directive cannot be delivered", async () => {
  await withApi(
    async (_key, _engine, text) =>
      text === "missing"
        ? "图在这儿 [[image:gone.png]]"
        : text === "escape"
          ? "看图 [[image:/etc/hostname]]"
          : "多张 [[image:a.png]] [[image:b.png]] [[image:c.png]] [[image:d.png]] [[image:e.png]] [[image:f.png]]",
    async (h) => {
      const outbox = join(h.dataDir, "outbox")
      mkdirSync(outbox, { recursive: true })
      for (const name of ["a.png", "b.png", "c.png", "d.png", "e.png"]) {
        writeFileSync(join(outbox, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      }
      const settle = async (prompt: string): Promise<{ reply: string; media?: unknown[] }> => {
        const res = await fetch(`${h.base}/api/v1/task`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text: prompt }),
        })
        const { task } = (await res.json()) as { task: { id: string } }
        for (let i = 0; i < 50; i++) {
          const poll = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
          const done = ((await poll.json()) as { task: { status: string; reply?: string; media?: unknown[] } }).task
          if (done.status === "done") return { reply: done.reply ?? "", media: done.media }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error("task did not finish")
      }

      const missing = await settle("missing")
      assert.match(missing.reply, /图片发送失败：文件不存在/)
      assert.equal(missing.media?.length ?? 0, 0, "an undeliverable file stays off the media list")

      const escape = await settle("escape")
      assert.match(escape.reply, /本地媒体必须放在 data\/outbox 目录内/, "the note names the containment rule")
      assert.equal(escape.media?.length ?? 0, 0)

      const many = await settle("many")
      assert.match(many.reply, /有 1 个附件标记无法识别或超出 5 个上限/)
      assert.equal(many.media?.length, 5)
    },
  )
})

test("api stop cancels a running task", async () => {
  await withApi(
    (_key, _engine, _text, _onProgress, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("已取消当前任务。")))
      }),
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "长任务" }),
      })
      const { task } = (await created.json()) as { task: { id: string } }
      await new Promise((resolve) => setTimeout(resolve, 50))
      const stopped = await fetch(`${h.base}/api/v1/stop`, { method: "POST", headers: authHeaders() })
      assert.equal(stopped.status, 200)
      let status = ""
      for (let i = 0; i < 50 && status !== "cancelled"; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
        status = ((await res.json()) as { task: { status: string } }).task.status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(status, "cancelled")
    },
  )
})

test("api waits for the live task before it rewires the session", async () => {
  let release: (() => void) | undefined
  await withApi(
    async (_key, _engine, text) => {
      if (text !== "挂起任务") return "ok"
      return new Promise<string>((resolve) => {
        release = () => resolve("回复：挂起任务")
      })
    },
    async (h) => {
      const call = (path: string, body?: unknown) =>
        fetch(`${h.base}/api/v1/${path}`, {
          method: "POST",
          headers: authHeaders(),
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      const liveDir = mkdtempSync(join(tmpdir(), "agent-bot-live-"))
      try {
        h.store.setEngine("tg:42", "codex")
        h.store.setCliSession("api:app", "claude", "sess-live")
        h.store.setDir("api:app", liveDir)

        const created = await call("task", { text: "挂起任务" })
        assert.equal(created.status, 202)
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Telegram answers 任务执行中 for each of these instead of dropping the session
        // the running task is writing to, so the App gets the same refusal and the same /stop hint.
        const refused: Array<[string, unknown]> = [
          ["new", undefined],
          ["model", { model: "default" }],
          ["dir", { reset: true }],
          ["dir", { dir: liveDir }],
          ["peers/follow", { scope: "telegram" }],
        ]
        for (const [path, body] of refused) {
          const res = await call(path, body)
          assert.equal(res.status, 409, `POST /${path} must wait for the running task`)
          assert.match(((await res.json()) as { error: string }).error, /任务执行中，请先停止当前任务再/)
        }
        assert.equal(h.store.getCliSession("api:app", "claude"), "sess-live")
        assert.equal(h.store.getDir("api:app"), liveDir)
        assert.equal(h.store.getEngine("api:app"), "claude")

        // A queued prompt waits too, and past Telegram's own depth the App is refused
        const accepted: number[] = []
        for (let i = 0; i < 6; i++) accepted.push((await call("task", { text: `排队 ${i}` })).status)
        assert.deepEqual(accepted, [202, 202, 202, 202, 409, 409])
        const overflow = JSON.stringify(await (await call("task", { text: "第六条" })).json())
        assert.match(overflow, /最多排队 4 条/)

        // Switching engines only points the *next* task elsewhere, so this one stays allowed
        const engine = await call("agent", { engine: "opencode" })
        assert.equal(engine.status, 200)
        assert.equal(h.store.getEngine("api:app"), "opencode")

        release?.()
        for (let i = 0; i < 100; i++) {
          const queue = (await (await fetch(`${h.base}/api/v1/queue`, { headers: authHeaders() })).json()) as {
            tasks: unknown[]
          }
          if (queue.tasks.length === 0) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        // Back on the CLI engine, /new clears that engine's session id once nothing runs
        await call("agent", { engine: "claude" })
        const settled = await call("new")
        assert.equal(settled.status, 200)
        assert.equal(h.store.getCliSession("api:app", "claude"), undefined)
        const resetDir = await call("dir", { reset: true })
        assert.equal(resetDir.status, 200)
        assert.equal(h.store.getDir("api:app"), undefined)
      } finally {
        rmSync(liveDir, { recursive: true, force: true })
      }
    },
  )
})

test("api switch engine, reset session and list models", async () => {
  await withApi(async () => "ok", async (h) => {
    const postEngine = (engine: string) =>
      fetch(`${h.base}/api/v1/agent`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ engine }),
      })
    const first = await postEngine("opencode")
    assert.equal(first.status, 200)
    // Telegram's note travels with the switch, so the App can show the same one
    assert.equal(((await first.json()) as { message: string }).message, "已切换至 OpenCode")

    const switched = await postEngine("claude")
    assert.equal(switched.status, 200)
    const session = (await switched.json()) as {
      message: string
      session: { engine: string; engineLabel: string }
    }
    assert.equal(session.session.engine, "claude")
    // A CLI that is not on PATH is still selected, but the answer says so
    assert.match(session.message, /^已切换至 Claude Code/)

    // CLI sessions reset through /new
    h.store.setCliSession("api:app", "claude", "sess-1")
    const reset = await fetch(`${h.base}/api/v1/new`, { method: "POST", headers: authHeaders() })
    assert.equal(reset.status, 200)
    assert.equal(h.store.getCliSession("api:app", "claude"), undefined)

    const models = await fetch(`${h.base}/api/v1/models`, { headers: authHeaders() })
    const body = (await models.json()) as { models: { models: Array<{ id?: string; label: string }> } }
    assert.ok(body.models.models.length > 0)

    // `/agents` hands a client everything Telegram's `/engine <word>` matching uses:
    // aliases, the executable name, whether context carries over, and if models are switchable
    const agentList = (await (await fetch(`${h.base}/api/v1/agents`, { headers: authHeaders() })).json()) as {
      agents: Array<{ id: string; aliases?: string[]; bin?: string; sessionMode?: string; supportsModel?: boolean }>
    }
    const claude = agentList.agents.find((agent) => agent.id === "claude")
    assert.ok(claude, "the engine list must include the claude profile")
    assert.deepEqual(claude.aliases, ["claude-code", "anthropic"])
    assert.equal(claude.bin, "claude")
    assert.equal(claude.sessionMode, "preassign")
    assert.equal(claude.supportsModel, true)
    // Typing an alias switches to the same engine the id would
    await postEngine("opencode")
    const byAlias = await postEngine("anthropic")
    assert.equal(byAlias.status, 200)
    assert.equal(((await byAlias.json()) as { session: { engine: string } }).session.engine, "claude")
    // Asking for the engine already in use answers like Telegram instead of rewriting it
    const sameEngine = await postEngine("claude")
    assert.match(((await sameEngine.json()) as { message: string }).message, /无需切换/)

    // The app can list another engine's models for a one-off pin, without switching
    await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "opencode" }),
    })
    const other = await fetch(`${h.base}/api/v1/models?engine=claude`, { headers: authHeaders() })
    assert.equal(other.status, 200)
    const otherBody = (await other.json()) as { models: { engine: string; models: Array<{ id?: string }> } }
    assert.equal(otherBody.models.engine, "claude")
    assert.ok(otherBody.models.models.some((model) => model.id === "sonnet"))
    const stillOpencode = await fetch(`${h.base}/api/v1/session`, { headers: authHeaders() })
    assert.equal(((await stillOpencode.json()) as { engine: string }).engine, "opencode")

    const badEngine = await fetch(`${h.base}/api/v1/models?engine=nope`, { headers: authHeaders() })
    assert.equal(badEngine.status, 400)

    const unknown = await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "nope" }),
    })
    assert.equal(unknown.status, 400)
  })
})

test("api model switch matches Telegram's reset-word and context rules", async () => {
  await withApi(async () => "ok", async (h) => {
    const setModel = (body: Record<string, unknown>) =>
      fetch(`${h.base}/api/v1/model`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      })

    // An engine that declares a model literally named `auto`; Telegram keeps that model
    // reachable instead of reading the word as "restore the default"
    writeFileSync(
      join(h.dataDir, "agents.json"),
      JSON.stringify({
        agents: {
          autoeng: {
            bin: "autoeng",
            supportsModel: true,
            models: [
              { id: "auto", label: "Auto Mode" },
              { id: "fast", label: "Fast" },
            ],
          },
        },
      }),
    )
    const switched = await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "autoeng" }),
    })
    assert.equal(switched.status, 200)

    h.store.setCliSession("api:app", "autoeng", "ctx-1")
    const declared = await setModel({ model: "auto" })
    assert.equal(declared.status, 200)
    assert.match(((await declared.json()) as { message: string }).message, /模型已切换为 Auto Mode/)
    assert.equal(h.store.getCliModel("api:app", "autoeng"), "auto")
    // A model change must not carry the previous model's context over
    assert.equal(h.store.getCliSession("api:app", "autoeng"), undefined)

    // The App's button is an explicit reset, so the same word drops the pick instead
    h.store.setCliSession("api:app", "autoeng", "ctx-2")
    const forced = await setModel({ model: "auto", reset: true })
    assert.equal(forced.status, 200)
    assert.match(((await forced.json()) as { message: string }).message, /已取消本会话的模型选择/)
    assert.equal(h.store.getCliModel("api:app", "autoeng"), undefined)
    assert.equal(h.store.getCliSession("api:app", "autoeng"), undefined)

    // Reset words the API used to reject as model names now work on a CLI too
    h.store.setCliModel("api:app", "autoeng", "fast")
    for (const word of ["reset", "clear", "恢复默认"]) {
      const reset = await setModel({ model: word })
      assert.equal(reset.status, 200, word)
      assert.equal(h.store.getCliModel("api:app", "autoeng"), undefined, word)
      h.store.setCliModel("api:app", "autoeng", "fast")
    }
    // With nothing selected the answer is the same note Telegram sends, not an error
    h.store.setCliModel("api:app", "autoeng", "")
    const already = await setModel({ model: "default" })
    assert.equal(already.status, 200)
    assert.match(((await already.json()) as { message: string }).message, /本会话没有独立的模型选择/)

    // OpenCode: a reset word restores the configured default and drops the session id
    await fetch(`${h.base}/api/v1/agent`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ engine: "opencode" }) })
    h.store.setModel("api:app", { providerID: "custom", modelID: "x-old", label: "Old" })
    h.store.set("api:app", "sess-9")
    const ocReset = await setModel({ model: "reset" })
    assert.equal(ocReset.status, 200)
    assert.equal(h.store.getModel("api:app"), undefined)
    assert.ok(!h.store.get("api:app"))

    const ocPick = await setModel({ model: "opus" })
    assert.equal(ocPick.status, 200)
    assert.equal(h.store.getModel("api:app")?.modelID, "claude-opus-5-5-high")
    h.store.set("api:app", "sess-live")
    // Repicking the current model keeps the conversation, exactly as Telegram reports
    const sameAgain = await setModel({ model: "opus" })
    assert.match(((await sameAgain.json()) as { message: string }).message, /无需切换/)
    assert.equal(h.store.get("api:app"), "sess-live")

    const unknownWord = await setModel({ model: "nope-not-a-model" })
    assert.equal(unknownWord.status, 400)
    const missing = await setModel({})
    assert.equal(missing.status, 400)
  })
})

test("api reminders and schedules create, list and delete", async () => {
  await withApi(async () => "ok", async (h) => {
    const added = await fetch(`${h.base}/api/v1/reminders`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "30m 喝水" }),
    })
    assert.equal(added.status, 201)
    const { reminder } = (await added.json()) as { reminder: { id: number; text: string } }
    assert.equal(reminder.text, "喝水")

    const bad = await fetch(`${h.base}/api/v1/reminders`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "立刻喝水" }),
    })
    assert.equal(bad.status, 400)

    const listed = await fetch(`${h.base}/api/v1/reminders`, { headers: authHeaders() })
    const list = ((await listed.json()) as { reminders: Array<{ id: number }> }).reminders
    assert.equal(list.length, 1)

    const removed = await fetch(`${h.base}/api/v1/reminders/${reminder.id}`, { method: "DELETE", headers: authHeaders() })
    assert.equal(removed.status, 200)

    const scheduled = await fetch(`${h.base}/api/v1/schedules`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "30m 检查服务器" }),
    })
    assert.equal(scheduled.status, 201)
    const { schedule } = (await scheduled.json()) as { schedule: { id: number; paused: boolean; target: string } }
    assert.equal(schedule.paused, false)
    // The app lists the run target the way Telegram does: "engine / model".
    assert.match(schedule.target, /\s\/\s/)

    const flagged = await fetch(`${h.base}/api/v1/schedules`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "--engine claude --model sonnet 1h 巡检" }),
    })
    assert.equal(flagged.status, 201)
    const { schedule: flaggedTask } = (await flagged.json()) as {
      schedule: { id: number; engine: string; target: string }
    }
    assert.equal(flaggedTask.engine, "claude")
    assert.equal(flaggedTask.target, "Claude Code / sonnet")
    await fetch(`${h.base}/api/v1/schedules/${flaggedTask.id}`, { method: "DELETE", headers: authHeaders() })

    const ran = await fetch(`${h.base}/api/v1/schedules/${schedule.id}/run`, {
      method: "POST",
      headers: authHeaders(),
    })
    assert.equal(ran.status, 200)
    const ranBody = (await ran.json()) as { ok: boolean; message: string }
    assert.equal(ranBody.ok, true)
    assert.match(ranBody.message, /立即执行/)

    const paused = await fetch(`${h.base}/api/v1/schedules/${schedule.id}/pause`, {
      method: "POST",
      headers: authHeaders(),
    })
    assert.equal(((await paused.json()) as { schedule: { paused: boolean } }).schedule.paused, true)

    const deleted = await fetch(`${h.base}/api/v1/schedules/${schedule.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    })
    assert.equal(deleted.status, 200)

    const gone = await fetch(`${h.base}/api/v1/schedules/${schedule.id}/run`, {
      method: "POST",
      headers: authHeaders(),
    })
    assert.equal(gone.status, 404)
  })
})

test("api work dir can be viewed, changed and reset", async () => {
  await withApi(async () => "ok", async (h) => {
    const initial = await fetch(`${h.base}/api/v1/dir`, { headers: authHeaders() })
    assert.equal(initial.status, 200)
    const start = (await initial.json()) as { workDir: string; defaultWorkDir: string; custom: string | null }
    assert.equal(start.workDir, h.dataDir)
    assert.equal(start.defaultWorkDir, h.dataDir)
    assert.equal(start.custom, null)

    // Switching drops the CLI session: it belongs to the old directory
    h.store.setCliSession("api:app", "claude", "sess-old")
    const changed = await fetch(`${h.base}/api/v1/dir`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ dir: h.dataDir }),
    })
    assert.equal(changed.status, 200)
    const changedBody = (await changed.json()) as { dir: { custom: string | null } }
    assert.equal(changedBody.dir.custom, h.dataDir)
    assert.equal(h.store.getDir("api:app"), h.dataDir)
    assert.equal(h.store.getCliSession("api:app", "claude"), undefined)

    const missingField = await fetch(`${h.base}/api/v1/dir`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    assert.equal(missingField.status, 400)

    const noSuchDir = await fetch(`${h.base}/api/v1/dir`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ dir: "/definitely/not/a/real/dir" }),
    })
    assert.equal(noSuchDir.status, 400)

    const reset = await fetch(`${h.base}/api/v1/dir`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reset: true }),
    })
    assert.equal(reset.status, 200)
    assert.equal(h.store.getDir("api:app"), undefined)
  })
})

test("api lists server directories for the App picker without touching the session", async () => {
  await withApi(async () => "ok", async (h) => {
    const browse = async (query: string) =>
      await fetch(`${h.base}/api/v1/dir/browse${query}`, { headers: authHeaders() })
    const root = mkdtempSync(join(tmpdir(), "agent-bot-browse-"))
    try {
      mkdirSync(join(root, "zeta"))
      mkdirSync(join(root, "Alpha"))
      mkdirSync(join(root, ".hidden"))
      mkdirSync(join(root, "link-target"))
      writeFileSync(join(root, "notes.txt"), "x")
      symlinkSync(join(root, "link-target"), join(root, "linked"))
      symlinkSync(join(root, "nowhere"), join(root, "broken"))

      const res = await browse(`?path=${encodeURIComponent(root)}`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        path: string
        parent: string | null
        home: string
        cwd: string
        defaultWorkDir: string
        sessionDir: string
        dirs: Array<{ name: string; path: string }>
        truncated: boolean
      }
      // Directories only, hidden entries skipped, a symlinked directory followed and a
      // dangling one dropped — that is the whole surface this endpoint has
      assert.deepEqual(
        body.dirs.map((entry) => entry.name),
        ["Alpha", "link-target", "linked", "zeta"],
      )
      assert.equal(body.dirs[0]?.path, join(root, "Alpha"))
      assert.equal(lstatSync(join(root, "broken")).isSymbolicLink(), true, "the dangling link exists, so it was filtered")
      assert.equal(body.path, root)
      assert.equal(body.parent, dirname(root))
      assert.equal(body.home, homedir())
      assert.equal(body.defaultWorkDir, h.dataDir)
      assert.equal(body.sessionDir, h.dataDir)
      assert.equal(body.truncated, false)

      // Browsing is read-only: the session still runs in its default directory
      h.store.setCliSession("api:app", "claude", "sess-keep")
      await browse(`?path=${encodeURIComponent(root)}`)
      assert.equal(h.store.getDir("api:app"), undefined)
      assert.equal(h.store.getCliSession("api:app", "claude"), "sess-keep")

      // No path and `~` both go through the same resolver POST /dir uses
      const empty = (await (await browse("")).json()) as { path: string }
      assert.equal(empty.path, h.dataDir)
      const tilde = (await (await browse("?path=%7E")).json()) as { path: string }
      assert.equal(tilde.path, homedir())

      const notADir = await browse(`?path=${encodeURIComponent(join(root, "notes.txt"))}`)
      assert.equal(notADir.status, 400)
      assert.match(((await notADir.json()) as { error: string }).error, /不是目录/)
      const missing = await browse("?path=%2Fdefinitely%2Fnot%2Fa%2Freal%2Fdir")
      assert.equal(missing.status, 400)
      const control = await browse(`?path=${encodeURIComponent(`${root}\u0007`)}`)
      assert.equal(control.status, 400)
      const fsRoot = await browse("?path=%2F")
      assert.equal(fsRoot.status, 400, "the filesystem root is refused as a working directory, so also here")
      const wrongMethod = await fetch(`${h.base}/api/v1/dir/browse?path=${encodeURIComponent(root)}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ dir: root }),
      })
      assert.equal(wrongMethod.status, 405)
      assert.equal(h.store.getDir("api:app"), undefined, "a rejected browse must not set a directory")
      const unknownSub = await fetch(`${h.base}/api/v1/dir/nope`, { headers: authHeaders() })
      assert.equal(unknownSub.status, 404)
      // A path segment used to be ignored here, so `POST /dir/nope` set the directory anyway
      const postUnknown = await fetch(`${h.base}/api/v1/dir/nope`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ dir: root }),
      })
      assert.equal(postUnknown.status, 404)
      assert.equal(h.store.getDir("api:app"), undefined)

      // A wide directory is capped rather than dumped whole into a dialog
      for (let i = 0; i < 205; i++) mkdirSync(join(root, `bulk-${i}`))
      const capped = (await (await browse(`?path=${encodeURIComponent(root)}`)).json()) as {
        dirs: unknown[]
        truncated: boolean
      }
      assert.equal(capped.dirs.length, 200)
      assert.equal(capped.truncated, true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("api reports the Telegram session and lets the App adopt it", async () => {
  await withApi(async () => "ok", async (h) => {
    // A work dir only counts when it exists, so use a real one
    const peerDir = mkdtempSync(join(tmpdir(), "agent-bot-peer-"))
    try {
      // The Telegram end usually runs something else; the App should see that, not guess it
      h.store.setEngine("tg:42", "codex")
      h.store.setCliModel("tg:42", "codex", "gpt-5.1-codex")
      h.store.setDir("tg:42", peerDir)
      // Usage is keyed the same way on both ends, so the App can report real activity here
      h.usage.record("tg:42", { engine: "codex", model: "gpt-5.1-codex", ms: 1200, outcome: "ok" })
      h.history.record("tg:42", { prompt: "SECRET-CHAT-TEXT", engine: "codex", ms: 1200, outcome: "ok" })

      const list = await fetch(`${h.base}/api/v1/peers`, { headers: authHeaders() })
      assert.equal(list.status, 200)
      const { peers } = (await list.json()) as {
        peers: Array<{
          scope: string
          label: string
          current: boolean
          activity: { lastAt: number; lastEngine: string | null; todayTasks: number; todayOk: number; totalTasks: number }
          session: Record<string, unknown>
        }>
      }
      const app = peers.find((peer) => peer.scope === "app")
      const telegram = peers.find((peer) => peer.scope === "telegram")
      assert.equal(app?.current, true)
      assert.equal(telegram?.current, false)
      assert.equal(telegram?.session.engine, "codex")
      assert.equal(telegram?.session.workDir, peerDir)
      assert.ok((telegram?.activity.lastAt ?? 0) > 0, "the Telegram peer must report when it last ran")
      assert.equal(telegram?.activity.lastEngine, "codex")
      assert.equal(telegram?.activity.todayTasks, 1)
      assert.equal(telegram?.activity.todayOk, 1)
      assert.equal(telegram?.activity.totalTasks, 1)
      assert.equal(app?.activity.todayTasks, 0, "the App's own usage must not leak into the Telegram counts")
      // A peer's internal key is `tg:<chatId>` and its prompts are chat content, so neither
      // may travel; queue depth is never claimed either, since this server only tracks App tasks
      const payload = JSON.stringify(peers)
      assert.equal(Object.hasOwn(telegram?.session ?? {}, "key"), false)
      assert.ok(!payload.includes("tg:42"), "the session key must stay server-side")
      assert.ok(!payload.includes("SECRET-CHAT-TEXT"), "chat text must never reach the peers view")
      assert.ok(!/"queued"|"running"/.test(payload), "peers must not report queue depth this server cannot see")

      const follow = await fetch(`${h.base}/api/v1/peers/follow`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ scope: "telegram" }),
      })
      assert.equal(follow.status, 200)
      const followed = (await follow.json()) as { message: string; session: { engine: string; workDir?: string } }
      assert.match(followed.message, /已跟随/)
      assert.equal(h.store.getEngine("api:app"), "codex")
      assert.equal(h.store.getCliModel("api:app", "codex"), "gpt-5.1-codex")
      assert.equal(h.store.getDir("api:app"), peerDir)
      assert.equal(followed.session.engine, "codex")

      // Repeating it changes nothing, so the message says so instead of claiming a switch
      const again = await fetch(`${h.base}/api/v1/peers/follow`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      })
      assert.match(((await again.json()) as { message: string }).message, /已经一致/)

      // Following one's own session is refused, not silently applied
      const self = await fetch(`${h.base}/api/v1/peers/follow`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ scope: "app" }),
      })
      assert.equal(self.status, 409)
    } finally {
      rmSync(peerDir, { recursive: true, force: true })
    }
  })
})

test("api timezone can be viewed and switched", async () => {
  await withApi(async () => "ok", async (h) => {
    const before = await fetch(`${h.base}/api/v1/timezone`, { headers: authHeaders() })
    assert.equal(((await before.json()) as { timezone: string }).timezone, "Asia/Shanghai")

    const bad = await fetch(`${h.base}/api/v1/timezone`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ timezone: "Not/AZone" }),
    })
    assert.equal(bad.status, 400)

    const ok = await fetch(`${h.base}/api/v1/timezone`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ timezone: "Europe/Berlin" }),
    })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { timezone: string }).timezone, "Europe/Berlin")

    const after = await fetch(`${h.base}/api/v1/timezone`, { headers: authHeaders() })
    assert.equal(((await after.json()) as { timezone: string }).timezone, "Europe/Berlin")
  })
})

test("api queue clear cancels queued tasks but keeps the running one", async () => {
  await withApi(
    (_key, _engine, _text, _onProgress, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("已取消当前任务。")))
      }),
    async (h) => {
      const submit = async (text: string): Promise<string> => {
        const res = await fetch(`${h.base}/api/v1/task`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text }),
        })
        assert.equal(res.status, 202)
        return ((await res.json()) as { task: { id: string } }).task.id
      }
      const first = await submit("执行中")
      const second = await submit("排队一")
      const third = await submit("排队二")
      await new Promise((resolve) => setTimeout(resolve, 60))

      const cleared = await fetch(`${h.base}/api/v1/queue/clear`, {
        method: "POST",
        headers: authHeaders(),
      })
      assert.equal(cleared.status, 200)
      assert.deepEqual(((await cleared.json()) as { cleared: string[] }).cleared, [second, third])

      const rest = await fetch(`${h.base}/api/v1/queue`, { headers: authHeaders() })
      const tasks = ((await rest.json()) as { tasks: Array<{ id: string; status: string }> }).tasks
      assert.deepEqual(tasks.map((task) => task.id), [first])
      assert.equal(tasks[0]?.status, "running")

      await fetch(`${h.base}/api/v1/stop`, { method: "POST", headers: authHeaders() })
    },
  )
})

/**
 * One phone can send three messages in a second, and a CLI engine keeps its conversation in a
 * single session file: two of its processes writing the same session at once corrupts the context
 * the user is paying for. Rapid-fire sends must therefore run one at a time and all answer.
 */
test("api runs tasks from one session one at a time and answers every one", async () => {
  let live = 0
  let overlap = 0
  await withApi(
    async (_key, _engine, text, onProgress) => {
      live++
      if (live > 1) overlap++
      onProgress?.(`处理中：${text}`)
      await new Promise((resolve) => setTimeout(resolve, 40))
      live--
      return `答复 ${text}`
    },
    async (h) => {
      const submit = async (text: string): Promise<string> => {
        const res = await fetch(`${h.base}/api/v1/task`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text }),
        })
        assert.equal(res.status, 202)
        return ((await res.json()) as { task: { id: string } }).task.id
      }
      const ids = [await submit("第一条"), await submit("第二条"), await submit("第三条")]

      const settled: Array<{ id: string; status: string; reply: string; progress?: string }> = []
      for (const id of ids) {
        for (let i = 0; i < 100; i++) {
          const res = await fetch(`${h.base}/api/v1/task/${id}`, { headers: authHeaders() })
          const task = (
            (await res.json()) as {
              task: { status: string; reply: string; progress?: string }
            }
          ).task
          if (task.status === "done" || task.status === "failed") {
            settled.push({ id, status: task.status, reply: task.reply, progress: task.progress })
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }

      assert.equal(overlap, 0, "two engine runs shared one session")
      assert.equal(settled.length, 3, "every queued task answered")
      assert.deepEqual(
        settled.map((task) => task.reply),
        ["答复 第一条", "答复 第二条", "答复 第三条"],
      )
      assert.deepEqual(settled.map((task) => task.id), ids, "tasks settle in submission order")
    },
  )
})

test("api stop does not wait for a client still holding a task stream", async () => {
  await withApi(
    (_key, _engine, _text, _onProgress, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("已取消当前任务。")))
      }),
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "一直被看的任务" }),
      })
      const { task } = (await created.json()) as { task: { id: string } }
      const stream = await fetch(`${h.base}/api/v1/task/${task.id}/events`, { headers: authHeaders() })
      assert.equal(stream.status, 200)
      const reader = stream.body!.getReader()
      await reader.read()

      const started = Date.now()
      await h.cleanup()
      const elapsed = Date.now() - started
      // A stopped bot has to release the port and let the process exit while a phone is
      // still watching a task; waiting for that client means waiting for its timeout
      assert.ok(elapsed < 3_000, `stop waited ${elapsed}ms for a stream that is still open`)
      await reader.cancel().catch(() => {})
    },
  )
})

test("api queue lists queued tasks and stops a single task", async () => {
  await withApi(
    (_key, _engine, _text, _onProgress, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("已取消当前任务。")))
      }),
    async (h) => {
      const submit = async (text: string): Promise<string> => {
        const res = await fetch(`${h.base}/api/v1/task`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text }),
        })
        assert.equal(res.status, 202)
        return ((await res.json()) as { task: { id: string } }).task.id
      }
      const first = await submit("第一个")
      const second = await submit("第二个")
      await new Promise((resolve) => setTimeout(resolve, 60))

      const queued = await fetch(`${h.base}/api/v1/queue`, { headers: authHeaders() })
      const queue = ((await queued.json()) as { tasks: Array<{ id: string; status: string }> }).tasks
      assert.equal(queue.length, 2)
      assert.equal(queue.find((t) => t.id === first)?.status, "running")
      assert.equal(queue.find((t) => t.id === second)?.status, "queued")

      const stoppedQueued = await fetch(`${h.base}/api/v1/task/${second}/stop`, {
        method: "POST",
        headers: authHeaders(),
      })
      assert.equal(stoppedQueued.status, 200)
      assert.equal(((await stoppedQueued.json()) as { task: { status: string } }).task.status, "cancelled")

      const stoppedRunning = await fetch(`${h.base}/api/v1/task/${first}/stop`, {
        method: "POST",
        headers: authHeaders(),
      })
      assert.equal(stoppedRunning.status, 200)

      let status = ""
      for (let i = 0; i < 50 && status !== "cancelled"; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${first}`, { headers: authHeaders() })
        status = ((await res.json()) as { task: { status: string } }).task.status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(status, "cancelled")

      const alreadyDone = await fetch(`${h.base}/api/v1/task/${first}/stop`, {
        method: "POST",
        headers: authHeaders(),
      })
      assert.equal(alreadyDone.status, 409)
    },
  )
})

test("api task retry replays the stored prompt, engine, model pin and attachments", async () => {
  const seen: string[] = []
  let attempts = 0
  await withApi(
    async (_key, engine, text) => {
      attempts += 1
      seen.push(`${engine}|${text}`)
      if (attempts === 1) throw new Error("模拟引擎故障")
      return "重试后的回复"
    },
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          text: "看这个文件",
          engine: "claude",
          model: "haiku",
          attachments: [{ name: "note.txt", mime: "text/plain", data: "SGVsbG8=" }],
        }),
      })
      assert.equal(created.status, 202)
      const first = (await created.json()) as {
        task: { id: string; engine: string; model?: string; attachmentCount?: number }
      }
      assert.equal(first.task.engine, "claude")
      assert.equal(first.task.model, "haiku")
      assert.equal(first.task.attachmentCount, 1)

      let status = ""
      for (let i = 0; i < 50 && status !== "failed"; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${first.task.id}`, { headers: authHeaders() })
        status = ((await res.json()) as { task: { status: string } }).task.status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(status, "failed")

      const retry = await fetch(`${h.base}/api/v1/task/${first.task.id}/retry`, {
        method: "POST",
        headers: authHeaders(),
      })
      assert.equal(retry.status, 202)
      const retried = (await retry.json()) as {
        ok: boolean
        retriedFrom: string
        task: { id: string; status: string; engine: string; model?: string; attachmentCount?: number }
      }
      // The app sends no body here, so everything must come from the server's copy
      assert.equal(retried.retriedFrom, first.task.id)
      assert.notEqual(retried.task.id, first.task.id)
      assert.equal(retried.task.engine, "claude")
      assert.equal(retried.task.model, "haiku")
      assert.equal(retried.task.attachmentCount, 1)

      let doneStatus = retried.task.status
      for (let i = 0; i < 50 && doneStatus !== "done"; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${retried.task.id}`, { headers: authHeaders() })
        doneStatus = ((await res.json()) as { task: { status: string } }).task.status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(doneStatus, "done")

      assert.equal(seen.length, 2)
      for (const call of seen) {
        assert.match(call, /^claude\|/)
        assert.match(call, /看这个文件/)
        assert.match(call, /note\.txt/)
        assert.match(call, /Hello/)
      }
    },
  )
})

test("api task retry refuses a live task and an unknown id", async () => {
  await withApi(
    (_key, _engine, _text, _onProgress, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("已取消当前任务。")))
      }),
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "执行中" }),
      })
      const id = ((await created.json()) as { task: { id: string } }).task.id
      await new Promise((resolve) => setTimeout(resolve, 60))

      const running = await fetch(`${h.base}/api/v1/task/${id}/retry`, { method: "POST", headers: authHeaders() })
      assert.equal(running.status, 409)
      assert.match(((await running.json()) as { error: string }).error, /请先停止/)

      const missing = await fetch(`${h.base}/api/v1/task/t-does-not-exist/retry`, {
        method: "POST",
        headers: authHeaders(),
      })
      assert.equal(missing.status, 404)

      // A cancelled task is finished, so retrying it is exactly Telegram's behaviour
      await fetch(`${h.base}/api/v1/task/${id}/stop`, { method: "POST", headers: authHeaders() })
      let status = ""
      for (let i = 0; i < 50 && status !== "cancelled"; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${id}`, { headers: authHeaders() })
        status = ((await res.json()) as { task: { status: string } }).task.status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(status, "cancelled")

      const retry = await fetch(`${h.base}/api/v1/task/${id}/retry`, { method: "POST", headers: authHeaders() })
      assert.equal(retry.status, 202)
      const body = (await retry.json()) as { task: { id: string; status: string } }
      assert.notEqual(body.task.id, id)

      await fetch(`${h.base}/api/v1/stop`, { method: "POST", headers: authHeaders() })
    },
  )
})

/**
 * The App's queue screen re-runs finished prompts from `GET /tasks`, because that is the only
 * list carrying a task id: `history` rows show a cleaned prompt with nothing to retry, and
 * `GET /queue` answers the live ones alone. So the settled rows, their order and what they hide
 * are the contract the phone depends on.
 */
test("api tasks keeps the settled records the App re-runs from and /queue drops", async () => {
  type Row = { id: string; status: string; text: string; createdAt: number; finishedAt?: number; reply?: string }
  await withApi(async () => "回复", async (h) => {
    const submit = async (text: string): Promise<string> => {
      const res = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text }),
      })
      return ((await res.json()) as { task: { id: string } }).task.id
    }
    const settle = async (id: string): Promise<Row> => {
      for (let i = 0; i < 100; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${id}`, { headers: authHeaders() })
        const row = ((await res.json()) as { task: Row }).task
        if (row.status !== "queued" && row.status !== "running") return row
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`task ${id} never settled`)
    }
    const list = async (query = ""): Promise<Row[]> => {
      const res = await fetch(`${h.base}/api/v1/tasks${query}`, { headers: authHeaders() })
      assert.equal(res.status, 200)
      return ((await res.json()) as { tasks: Row[] }).tasks
    }

    const first = await submit("重发我")
    // Letting it settle first gives the two records distinct timestamps, so the ordering
    // assertion below is about the response and not about how fast the seed ran.
    assert.equal((await settle(first)).status, "done")
    const second = await submit("最新一条")
    await settle(second)

    const rows = await list()
    for (const id of [first, second]) assert.ok(rows.some((row) => row.id === id), `${id} must survive as a record`)
    const stamps = rows.map((row) => row.createdAt)
    assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), "records arrive newest first")

    const older = rows.find((row) => row.id === first)!
    assert.equal(older.text, "重发我")
    assert.equal(older.reply, "回复")
    assert.ok((older.finishedAt ?? 0) >= older.createdAt)
    // A record must not smuggle the session key or the abort controller out of the server
    assert.equal("key" in older, false)
    assert.equal("controller" in older, false)

    // /queue is Telegram's live view: both of these have finished, so neither appears
    const queue = (await (await fetch(`${h.base}/api/v1/queue`, { headers: authHeaders() })).json()) as {
      tasks: Row[]
    }
    assert.equal(queue.tasks.length, 0)

    assert.equal((await list("?limit=1")).length, 1)
    // A silly or unusable limit keeps answering: clamped to one row, or back to the default
    assert.equal((await list("?limit=0")).length, 1)
    assert.equal((await list("?limit=abc")).length, rows.length)

    // The phone's 重试 button posts exactly this: an id read straight out of the record list
    const retry = await fetch(`${h.base}/api/v1/task/${first}/retry`, { method: "POST", headers: authHeaders() })
    assert.equal(retry.status, 202)
    const retried = (await retry.json()) as { retriedFrom: string; task: Row }
    assert.equal(retried.retriedFrom, first)
    assert.equal(retried.task.text, "重发我")
    await settle(retried.task.id)
  })
})

test("api ops exposes diagnostics and log tails", async () => {
  await withApi(async () => "ok", async (h) => {
    const diag = await fetch(`${h.base}/api/v1/ops/diag`, { headers: authHeaders() })
    assert.equal(diag.status, 200)
    const body = (await diag.json()) as { diagnostics: { node: string; opencode: { reachable: boolean } } }
    assert.equal(body.diagnostics.opencode.reachable, true)
    assert.ok(body.diagnostics.node)

    const logs = await fetch(`${h.base}/api/v1/ops/logs?source=opencode&lines=50`, { headers: authHeaders() })
    assert.equal(logs.status, 200)
    const log = (await logs.json()) as { ok: boolean; text: string; path: string }
    assert.equal(log.ok, true)
    assert.equal(log.text, "opencode-50")
    assert.match(log.path, /opencode\.log$/)

    // Lines are clamped, not rejected
    const clamped = await fetch(`${h.base}/api/v1/ops/logs?lines=99999`, { headers: authHeaders() })
    assert.equal(((await clamped.json()) as { text: string }).text, "bot-400")
  })
})

test("api agent install, update and uninstall honour guards", async () => {
  await withApi(async () => "ok", async (h) => {
    const installed = await fetch(`${h.base}/api/v1/agents/amp/install`, { method: "POST", headers: authHeaders() })
    assert.equal(installed.status, 200)
    const installedBody = (await installed.json()) as { ok: boolean; agent: { managed: boolean } }
    assert.equal(installedBody.ok, true)
    assert.equal(installedBody.agent.managed, true)
    assert.deepEqual(h.installs, ["amp"])

    // Installing over a binary already on PATH is refused. Whether claude exists
    // depends on the machine running the suite, so ask the same lookup the API uses
    // instead of hardcoding an environment-specific expectation.
    const claude = h.registry.get("claude")
    const already = await fetch(`${h.base}/api/v1/agents/claude/install`, { method: "POST", headers: authHeaders() })
    assert.equal(already.status, claude && h.registry.binPath(claude) ? 409 : 200)

    const unknown = await fetch(`${h.base}/api/v1/agents/nope/install`, { method: "POST", headers: authHeaders() })
    assert.equal(unknown.status, 404)

    const badAction = await fetch(`${h.base}/api/v1/agents/amp/bogus`, { method: "POST", headers: authHeaders() })
    assert.equal(badAction.status, 404)

    const notManaged = await fetch(`${h.base}/api/v1/agents/qwen/update`, { method: "POST", headers: authHeaders() })
    assert.equal(notManaged.status, 409)

    // Uninstalling the engine the app session is using is refused
    h.store.setEngine("api:app", "amp")
    const inUse = await fetch(`${h.base}/api/v1/agents/amp/uninstall`, { method: "POST", headers: authHeaders() })
    assert.equal(inUse.status, 409)

    h.store.setEngine("api:app", "opencode")
    const removed = await fetch(`${h.base}/api/v1/agents/amp/uninstall`, { method: "POST", headers: authHeaders() })
    assert.equal(removed.status, 200)
    assert.equal(((await removed.json()) as { ok: boolean }).ok, true)

    const updated = await fetch(`${h.base}/api/v1/agents/codex/update`, { method: "POST", headers: authHeaders() })
    assert.equal(updated.status, 200)
    assert.equal(((await updated.json()) as { message: string }).message, "updated codex")
  })
})

test("api lists the built-in OpenCode engine beside the CLIs", async () => {
  await withApi(async () => "ok", async (h) => {
    const listed = await fetch(`${h.base}/api/v1/agents`, { headers: authHeaders() })
    assert.equal(listed.status, 200)
    type AgentRow = { id: string; installed: boolean; installable: boolean; updateable: boolean; uninstallable: boolean }
    const rows = ((await listed.json()) as { agents: AgentRow[] }).agents
    const builtIn = rows.find((row) => row.id === "opencode")
    assert.ok(builtIn, "GET /agents must offer the engine that POST /agent accepts")
    assert.equal(builtIn.installed, true)
    // It ships with the bot, so no client may be offered an install, update or removal
    assert.equal(builtIn.installable, false)
    assert.equal(builtIn.updateable, false)
    assert.equal(builtIn.uninstallable, false)
    assert.ok(new Set(rows.map((row) => row.id)).size === rows.length, "engine ids must stay unique")

    const refused = await fetch(`${h.base}/api/v1/agents/opencode/install`, { method: "POST", headers: authHeaders() })
    assert.equal(refused.status, 404)

    // The point of listing it: a session on a CLI engine can be handed back
    const switchTo = async (engine: string): Promise<string> => {
      const res = await fetch(`${h.base}/api/v1/agent`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ engine }),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { session: { engine: string } }
      return body.session.engine
    }
    assert.equal(await switchTo("claude"), "claude")
    assert.equal(await switchTo("opencode"), "opencode")
  })
})

test("api manages proxies with masked urls", async () => {
  await withApi(async () => "ok", async (h) => {
    const empty = await fetch(`${h.base}/api/v1/proxy`, { headers: authHeaders() })
    assert.equal(empty.status, 200)
    const emptyBody = (await empty.json()) as { active: number | null; proxies: unknown[] }
    assert.equal(emptyBody.active, null)
    assert.equal(emptyBody.proxies.length, 0)

    const bad = await fetch(`${h.base}/api/v1/proxy`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url: "ftp://127.0.0.1:21" }),
    })
    assert.equal(bad.status, 400)

    const added = await fetch(`${h.base}/api/v1/proxy`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url: "socks5://user:pass@127.0.0.1:1080", name: "公司代理" }),
    })
    assert.equal(added.status, 201)
    const addedBody = (await added.json()) as { proxy: { id: number; name: string; url: string; active: boolean } }
    assert.equal(addedBody.proxy.name, "公司代理")
    // Credentials never leave the server: the app only sees the masked URL
    assert.equal(addedBody.proxy.url, "socks5://user:***@127.0.0.1:1080")
    assert.equal(addedBody.proxy.active, false)

    const used = await fetch(`${h.base}/api/v1/proxy/${addedBody.proxy.id}/use`, { method: "POST", headers: authHeaders() })
    assert.equal(used.status, 200)
    const listed = await fetch(`${h.base}/api/v1/proxy`, { headers: authHeaders() })
    const listBody = (await listed.json()) as { active: number | null; proxies: Array<{ id: number; active: boolean }> }
    assert.equal(listBody.active, addedBody.proxy.id)
    assert.equal(listBody.proxies[0]?.active, true)

    const tested = await fetch(`${h.base}/api/v1/proxy/${addedBody.proxy.id}/test`, { method: "POST", headers: authHeaders() })
    assert.equal(tested.status, 200)
    assert.equal(((await tested.json()) as { ok: boolean }).ok, true)

    const off = await fetch(`${h.base}/api/v1/proxy/off`, { method: "POST", headers: authHeaders() })
    assert.equal(off.status, 200)
    const afterOff = await fetch(`${h.base}/api/v1/proxy`, { headers: authHeaders() })
    assert.equal(((await afterOff.json()) as { active: number | null }).active, null)

    const removed = await fetch(`${h.base}/api/v1/proxy/${addedBody.proxy.id}`, { method: "DELETE", headers: authHeaders() })
    assert.equal(removed.status, 200)
    const afterRemove = await fetch(`${h.base}/api/v1/proxy`, { headers: authHeaders() })
    assert.equal(((await afterRemove.json()) as { proxies: unknown[] }).proxies.length, 0)

    const missingTest = await fetch(`${h.base}/api/v1/proxy/99/test`, { method: "POST", headers: authHeaders() })
    assert.equal(missingTest.status, 404)
    const missingUse = await fetch(`${h.base}/api/v1/proxy/99/use`, { method: "POST", headers: authHeaders() })
    assert.equal(missingUse.status, 404)
    const missingDelete = await fetch(`${h.base}/api/v1/proxy/99`, { method: "DELETE", headers: authHeaders() })
    assert.equal(missingDelete.status, 404)
  })
})

test("api manages alias shortcuts and expands them in tasks", async () => {
  await withApi(async (_key, _engine, text) => `回复：${text}`, async (h) => {
    const empty = await fetch(`${h.base}/api/v1/aliases`, { headers: authHeaders() })
    assert.equal(empty.status, 200)
    assert.equal(((await empty.json()) as { aliases: unknown[] }).aliases.length, 0)

    const badName = await fetch(`${h.base}/api/v1/aliases`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Bad-Name", expansion: "x" }),
    })
    assert.equal(badName.status, 400)
    const noExpansion = await fetch(`${h.base}/api/v1/aliases`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "code" }),
    })
    assert.equal(noExpansion.status, 400)

    const created = await fetch(`${h.base}/api/v1/aliases`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "/code", expansion: "审查当前目录" }),
    })
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as { alias: { name: string; expansion: string } }
    // A leading slash is accepted for convenience and stripped
    assert.equal(createdBody.alias.name, "code")

    const listed = await fetch(`${h.base}/api/v1/aliases`, { headers: authHeaders() })
    const listBody = (await listed.json()) as { aliases: Array<{ name: string; expansion: string }> }
    assert.equal(listBody.aliases.length, 1)
    assert.equal(listBody.aliases[0]?.expansion, "审查当前目录")

    // Expansion happens at submit time, so the engine receives the full prompt
    await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "opencode" }),
    })
    const submitted = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "/code 现在" }),
    })
    assert.equal(submitted.status, 202)
    const { task } = (await submitted.json()) as { task: { id: string } }
    let status = ""
    for (let i = 0; i < 50 && status !== "done"; i++) {
      const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
      status = ((await res.json()) as { task: { status: string } }).task.status
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(status, "done")
    assert.equal(h.ocCalls[0]?.text, "审查当前目录 现在")

    // Unknown shortcuts stay verbatim
    const plain = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "/nope hello" }),
    })
    const plainTask = (await plain.json()) as { task: { id: string } }
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${h.base}/api/v1/task/${plainTask.task.id}`, { headers: authHeaders() })
      if (((await res.json()) as { task: { status: string } }).task.status === "done") break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(h.ocCalls[1]?.text, "/nope hello")

    const removed = await fetch(`${h.base}/api/v1/aliases/code`, { method: "DELETE", headers: authHeaders() })
    assert.equal(removed.status, 200)
    const again = await fetch(`${h.base}/api/v1/aliases/code`, { method: "DELETE", headers: authHeaders() })
    assert.equal(again.status, 404)
  })
})

test("api lists and mutates the access whitelist with lockout guards", async () => {
  await withApi(async () => "ok", async (h) => {
    const listed = await fetch(`${h.base}/api/v1/access`, { headers: authHeaders() })
    assert.equal(listed.status, 200)
    const listBody = (await listed.json()) as { users: string[]; allowAll: boolean }
    assert.deepEqual(listBody.users, ["42", "7"])
    assert.equal(listBody.allowAll, false)

    const bad = await fetch(`${h.base}/api/v1/access`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: "not-a-number" }),
    })
    assert.equal(bad.status, 400)

    const added = await fetch(`${h.base}/api/v1/access`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: "123" }),
    })
    assert.equal(added.status, 200)
    const addedBody = (await added.json()) as { ok: boolean; users: string[] }
    assert.ok(addedBody.users.includes("123"))

    // Removing the owner would lock the Telegram side out
    const self = await fetch(`${h.base}/api/v1/access/42`, { method: "DELETE", headers: authHeaders() })
    assert.equal(self.status, 400)

    const removed = await fetch(`${h.base}/api/v1/access/7`, { method: "DELETE", headers: authHeaders() })
    assert.equal(removed.status, 200)
    const afterRemove = (await removed.json()) as { users: string[] }
    assert.ok(!afterRemove.users.includes("7"))

    const missing = await fetch(`${h.base}/api/v1/access/999`, { method: "DELETE", headers: authHeaders() })
    assert.equal(missing.status, 400)
  })
})

test("api exposes service status and runs ops actions", async () => {
  await withApi(async () => "ok", async (h) => {
    const service = await fetch(`${h.base}/api/v1/ops/service`, { headers: authHeaders() })
    assert.equal(service.status, 200)
    const svc = (await service.json()) as { service: { reachable: boolean; managed: boolean; pid?: number } }
    assert.equal(svc.service.reachable, true)
    assert.equal(svc.service.managed, true)
    assert.equal(svc.service.pid, 123)

    const check = await fetch(`${h.base}/api/v1/ops/check`, { method: "POST", headers: authHeaders() })
    assert.equal(check.status, 200)
    const checked = (await check.json()) as { result: { ok: boolean; steps: Array<{ label: string }> } }
    assert.equal(checked.result.ok, true)
    assert.equal(checked.result.steps[0]?.label, "npm run check")

    const update = await fetch(`${h.base}/api/v1/ops/update`, { method: "POST", headers: authHeaders() })
    assert.equal(update.status, 200)
    assert.equal(((await update.json()) as { result: { ok: boolean } }).result.ok, false)

    const started = await fetch(`${h.base}/api/v1/ops/service/start`, { method: "POST", headers: authHeaders() })
    assert.equal(started.status, 200)
    assert.equal(((await started.json()) as { result: { message: string } }).result.message, "OpenCode 已启动。")

    const restarted = await fetch(`${h.base}/api/v1/ops/restart`, { method: "POST", headers: authHeaders() })
    assert.equal(restarted.status, 200)

    const unknown = await fetch(`${h.base}/api/v1/ops/nope`, { method: "POST", headers: authHeaders() })
    assert.equal(unknown.status, 404)
    const badService = await fetch(`${h.base}/api/v1/ops/service/explode`, { method: "POST", headers: authHeaders() })
    assert.equal(badService.status, 404)
  })
})

test("api manages custom models", async () => {
  await withApi(async () => "ok", async (h) => {
    const empty = await fetch(`${h.base}/api/v1/models/custom`, { headers: authHeaders() })
    assert.equal(empty.status, 200)
    const emptyBody = (await empty.json()) as { models: unknown[]; agents: unknown[] }
    assert.equal(emptyBody.models.length, 0)
    assert.ok(Array.isArray(emptyBody.agents))

    const bad = await fetch(`${h.base}/api/v1/models/custom`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key: "Bad Key", providerID: "custom", modelID: "x" }),
    })
    assert.equal(bad.status, 400)

    const added = await fetch(`${h.base}/api/v1/models/custom`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key: "my-test", providerID: "custom", modelID: "test-model", label: "测试模型" }),
    })
    assert.equal(added.status, 200)
    const addedBody = (await added.json()) as { model: { key: string; label: string; providerID: string } }
    assert.equal(addedBody.model.key, "my-test")
    assert.equal(addedBody.model.label, "测试模型")

    const duplicate = await fetch(`${h.base}/api/v1/models/custom`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key: "my-test", providerID: "custom", modelID: "other-model" }),
    })
    assert.equal(duplicate.status, 400)

    const listed = await fetch(`${h.base}/api/v1/models/custom`, { headers: authHeaders() })
    const listedBody = (await listed.json()) as { models: Array<{ key: string; modelID: string }> }
    assert.equal(listedBody.models.length, 1)
    assert.equal(listedBody.models[0]?.modelID, "test-model")

    const removed = await fetch(`${h.base}/api/v1/models/custom/my-test`, { method: "DELETE", headers: authHeaders() })
    assert.equal(removed.status, 200)
    const missing = await fetch(`${h.base}/api/v1/models/custom/my-test`, { method: "DELETE", headers: authHeaders() })
    assert.equal(missing.status, 404)

    // Telegram's `/cc model add` flags ride on the same body the App sends, and a junk
    // number must not reach opencode.json
    const postModel = (body: Record<string, unknown>) =>
      fetch(`${h.base}/api/v1/models/custom`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    for (const contextWindow of [-5, 0, 1.5, "200000", 2e9]) {
      const refused = await postModel({ key: "flag-test", providerID: "custom", modelID: "flag-model", contextWindow })
      assert.equal(refused.status, 400, `contextWindow ${JSON.stringify(contextWindow)} must be refused`)
      assert.match(((await refused.json()) as { error: string }).error, /contextWindow 需要/)
    }
    const stillEmpty = (await (await fetch(`${h.base}/api/v1/models/custom`, { headers: authHeaders() })).json()) as {
      models: unknown[]
    }
    assert.equal(stillEmpty.models.length, 0, "a refused add must not write the registry")

    const flagged = await postModel({
      key: "flag-test",
      providerID: "custom",
      modelID: "flag-model",
      attachment: true,
      contextWindow: 200_000,
      outputLimit: 64_000,
    })
    assert.equal(flagged.status, 200)
    const flaggedMessage = ((await flagged.json()) as { message: string }).message
    // The App sees the same capability sentence Telegram prints, including whether it landed
    assert.match(flaggedMessage, /模型能力/)
    assert.match(flaggedMessage, /支持图片输入、上下文 200000、输出上限 64000/)
    await fetch(`${h.base}/api/v1/models/custom/flag-test`, { method: "DELETE", headers: authHeaders() })
  })
})

test("api returns 404 for unknown paths and 400 for bad bodies", async () => {
  await withApi(async () => "ok", async (h) => {
    const notFound = await fetch(`${h.base}/api/v1/nope`, { headers: authHeaders() })
    assert.equal(notFound.status, 404)
    const badBody = await fetch(`${h.base}/api/v1/task`, { method: "POST", headers: authHeaders(), body: "not json" })
    assert.equal(badBody.status, 400)
    const empty = await fetch(`${h.base}/api/v1/task`, { method: "POST", headers: authHeaders(), body: "{}" })
    assert.equal(empty.status, 400)
  })
})

test("api task accepts base64 attachments end to end", async () => {
  await withApi(async () => "ok", async (h) => {
    await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "opencode" }),
    })

    const textB64 = Buffer.from("hello attachment", "utf8").toString("base64")
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    const created = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        text: "看看这两个附件",
        attachments: [
          { name: "notes.txt", mime: "text/plain", data: textB64 },
          { name: "pixel.png", mime: "image/png", data: pngB64 },
        ],
      }),
    })
    assert.equal(created.status, 202)
    const { task } = (await created.json()) as { task: { id: string; attachmentCount?: number } }
    assert.equal(task.attachmentCount, 2)

    let status = ""
    for (let i = 0; i < 50 && status !== "done"; i++) {
      const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
      status = ((await res.json()) as { task: { status: string } }).task.status
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(status, "done")

    // The text file is inlined into the prompt; the image rides as a data file
    assert.equal(h.ocCalls.length, 1)
    const call = h.ocCalls[0]!
    assert.match(call.text, /\[用户附件\]/)
    assert.match(call.text, /<file name="[^"]*notes\.txt">/)
    assert.match(call.text, /hello attachment/)
    assert.equal(call.files.length, 1)
    assert.equal(call.files[0]?.mime, "image/png")
    // saveAttachment prefixes chatId+timestamp for uniqueness
    assert.match(call.files[0]?.filename ?? "", /pixel\.png$/)
  })
})

test("api task accepts attachment-only messages with a default header", async () => {
  await withApi(async () => "ok", async (h) => {
    await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "opencode" }),
    })

    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    const created = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "", attachments: [{ name: "shot.png", mime: "image/png", data: pngB64 }] }),
    })
    assert.equal(created.status, 202)
    const { task } = (await created.json()) as { task: { id: string } }

    let status = ""
    for (let i = 0; i < 50 && status !== "done"; i++) {
      const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
      status = ((await res.json()) as { task: { status: string } }).task.status
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(status, "done")

    assert.equal(h.ocCalls.length, 1)
    const call = h.ocCalls[0]!
    assert.match(call.text, /^请查看用户发送的图片并回应。/)
    assert.equal(call.files.length, 1)

    // History needs a label for a prompt that had no text of its own.
    const history = await fetch(`${h.base}/api/v1/history?limit=5`, { headers: authHeaders() })
    const { history: entries } = (await history.json()) as { history: Array<{ prompt: string }> }
    assert.equal(entries[0]?.prompt, "（图片）")
  })
})

test("api history windows the list but still reports the stored total", async () => {
  await withApi(async () => "ok", async (h) => {
    const base = Date.now()
    for (let i = 0; i < 25; i++) {
      h.history.record("api:app", { prompt: `任务 ${i}`, engine: "claude", ms: 10, outcome: "ok" }, base + i)
    }

    const windowed = await fetch(`${h.base}/api/v1/history?limit=20`, { headers: authHeaders() })
    const body = (await windowed.json()) as { history: Array<{ prompt: string }>; total: number }
    assert.equal(body.history.length, 20)
    // The app renders its own "已显示 N / 共 M 条" line from this.
    assert.equal(body.total, 25)
    assert.equal(body.history[0]?.prompt, "任务 24")

    const clamped = await fetch(`${h.base}/api/v1/history?limit=500`, { headers: authHeaders() })
    const clampedBody = (await clamped.json()) as { history: unknown[]; total: number }
    assert.equal(clampedBody.history.length, 25)
    assert.equal(clampedBody.total, 25)

    // A non-numeric window must fall back to the default, not answer with an empty list
    for (const query of ["limit=abc", "limit=", "limit=0"]) {
      const res = await fetch(`${h.base}/api/v1/history?${query}`, { headers: authHeaders() })
      const parsed = (await res.json()) as { history: unknown[] }
      assert.equal(res.status, 200)
      assert.ok(parsed.history.length > 0, query)
    }
    const garbage = await fetch(`${h.base}/api/v1/history?limit=abc`, { headers: authHeaders() })
    assert.equal(((await garbage.json()) as { history: unknown[] }).history.length, 20)

    const cleared = await fetch(`${h.base}/api/v1/history`, { method: "DELETE", headers: authHeaders() })
    assert.equal(((await cleared.json()) as { cleared: number }).cleared, 25)
    const after = await fetch(`${h.base}/api/v1/history`, { headers: authHeaders() })
    assert.equal(((await after.json()) as { total: number }).total, 0)
  })
})

test("api task engine override runs that engine and leaves the session default alone", async () => {
  const seen: string[] = []
  await withApi(
    async (_key, engine, text) => {
      seen.push(`${engine} ${text}`)
      return "ok"
    },
    async (h) => {
      await fetch(`${h.base}/api/v1/agent`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ engine: "opencode" }),
      })

      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "临时用 Claude", engine: "claude" }),
      })
      assert.equal(created.status, 202)
      const { task } = (await created.json()) as { task: { id: string; engine: string } }
      assert.equal(task.engine, "claude")

      let status = ""
      for (let i = 0; i < 50 && status !== "done"; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
        status = ((await res.json()) as { task: { status: string } }).task.status
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(status, "done")
      assert.deepEqual(seen, ["claude 临时用 Claude"])

      const session = await fetch(`${h.base}/api/v1/session`, { headers: authHeaders() })
      const body = (await session.json()) as { engine: string }
      assert.equal(body.engine, "opencode")

      const unknown = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "x", engine: "nope" }),
      })
      assert.equal(unknown.status, 400)
    },
  )
})

test("api task model override pins one run without touching the session default", async () => {
  await withApi(async () => "ok", async (h) => {
    await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "opencode" }),
    })
    const before = await fetch(`${h.base}/api/v1/session`, { headers: authHeaders() })
    const startModel = ((await before.json()) as { model: string | null }).model

    const created = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "这条用 Gemini", model: "gemini" }),
    })
    assert.equal(created.status, 202)
    const { task } = (await created.json()) as { task: { id: string; model?: string } }
    assert.equal(task.model, "gemini")

    let status = ""
    for (let i = 0; i < 50 && status !== "done"; i++) {
      const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
      status = ((await res.json()) as { task: { status: string } }).task.status
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(status, "done")

    // The run is recorded against the resolved model, so history shows what actually ran.
    const entry = h.history.list("api:app", 1)[0]
    assert.equal(entry?.model, "Gemini 3.8 Flash")

    const after = await fetch(`${h.base}/api/v1/session`, { headers: authHeaders() })
    const body = (await after.json()) as { model: string | null }
    assert.equal(body.model, startModel)

    const bad = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "x", model: "完全不存在" }),
    })
    assert.equal(bad.status, 400)
    const message = ((await bad.json()) as { error: string }).error
    assert.match(message, /未识别的模型/)
    // A rejected pin never enters the queue
    assert.equal(h.ocCalls.length, 1)
  })
})

test("api task rejects invalid attachments", async () => {
  await withApi(async () => "ok", async (h) => {
    const badMime = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "x", attachments: [{ name: "a.bin", mime: "not a mime", data: "AAAA" }] }),
    })
    assert.equal(badMime.status, 400)

    const badBase64 = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "x", attachments: [{ name: "a.bin", mime: "image/png", data: "!!!not-base64!!!" }] }),
    })
    assert.equal(badBase64.status, 400)

    const tooMany = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        text: "x",
        attachments: [1, 2, 3, 4, 5].map((n) => ({ name: `f${n}.txt`, mime: "text/plain", data: "QQ==" })),
      }),
    })
    assert.equal(tooMany.status, 400)
  })
})

test("api exposes the cc-switch console with allowlisted actions", async () => {
  await withApi(async () => "ok", async (h) => {
    const status = await fetch(`${h.base}/api/v1/cc`, { headers: authHeaders() })
    assert.equal(status.status, 200)
    const body = (await status.json()) as {
      available: boolean
      app: string
      version: string | null
      current: string | null
      providers: Array<{ id: string; current: boolean }>
    }
    assert.equal(body.available, true)
    assert.equal(body.app, "opencode")
    assert.equal(body.version, "cc-switch 1.2.3")
    assert.equal(body.current, "p1")
    assert.deepEqual(body.providers.map((p) => p.id), ["p1", "p2"])

    const use = await fetch(`${h.base}/api/v1/cc/use`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: "p2" }),
    })
    assert.equal(use.status, 200)
    assert.match(((await use.json()) as { message: string }).message, /p2/)

    const testDefault = await fetch(`${h.base}/api/v1/cc/test`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    assert.equal(testDefault.status, 200)
    const measured = (await testDefault.json()) as { ok: boolean; id: string; latencyMs: number }
    assert.equal(measured.ok, true)
    assert.equal(measured.id, "p1")
    assert.equal(measured.latencyMs, 42)

    const badUse = await fetch(`${h.base}/api/v1/cc/use`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    assert.equal(badUse.status, 400)

    const proxy = await fetch(`${h.base}/api/v1/cc/proxy`, { headers: authHeaders() })
    assert.match(((await proxy.json()) as { text: string }).text, /127\.0\.0\.1:7890/)

    const mcp = await fetch(`${h.base}/api/v1/cc/mcp`, { headers: authHeaders() })
    assert.equal(((await mcp.json()) as { text: string }).text, "mcp list output")

    const sync = await fetch(`${h.base}/api/v1/cc/mcp/sync`, { method: "POST", headers: authHeaders() })
    assert.equal(sync.status, 200)

    const prompts = await fetch(`${h.base}/api/v1/cc/prompts`, { headers: authHeaders() })
    assert.equal(((await prompts.json()) as { text: string }).text, "prompts list")

    const activate = await fetch(`${h.base}/api/v1/cc/prompts/activate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: "review" }),
    })
    assert.equal(activate.status, 200)
    const noPrompt = await fetch(`${h.base}/api/v1/cc/prompts/activate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    assert.equal(noPrompt.status, 400)
    const deactivate = await fetch(`${h.base}/api/v1/cc/prompts/deactivate`, {
      method: "POST",
      headers: authHeaders(),
    })
    assert.equal(deactivate.status, 200)

    const envTools = await fetch(`${h.base}/api/v1/cc/env?mode=tools`, { headers: authHeaders() })
    const toolsBody = (await envTools.json()) as { mode: string; text: string }
    assert.equal(toolsBody.mode, "tools")
    assert.equal(toolsBody.text, "tools output")
    const envCheck = await fetch(`${h.base}/api/v1/cc/env`, { headers: authHeaders() })
    assert.equal(((await envCheck.json()) as { mode: string }).mode, "check")

    assert.deepEqual(h.ccCalls, ["use:p2", "test:p1", "mcp:sync", "prompt:review", "prompt:off"])

    const unknown = await fetch(`${h.base}/api/v1/cc/whatever`, { headers: authHeaders() })
    assert.equal(unknown.status, 404)

    const install = await fetch(`${h.base}/api/v1/ops/cc`, { method: "POST", headers: authHeaders() })
    assert.equal(install.status, 200)
    const update = await fetch(`${h.base}/api/v1/ops/cc-update`, { method: "POST", headers: authHeaders() })
    assert.equal(update.status, 200)
    assert.deepEqual(h.ccCalls.slice(-2), ["ops:cc-install", "ops:cc-update"])
  })
})

test("api views and edits non-secret env config", async () => {
  await withApi(async () => "ok", async (h) => {
    const initial = await fetch(`${h.base}/api/v1/config`, { headers: authHeaders() })
    assert.equal(initial.status, 200)
    const view = (await initial.json()) as {
      exists: boolean
      entries: Array<{ key: string; value?: string; editable: boolean }>
      editableKeys: string[]
    }
    assert.equal(view.exists, true)
    assert.equal(view.entries.find((entry) => entry.key === "LOG_LEVEL")?.value, "info")
    assert.ok(view.editableKeys.includes("LOG_LEVEL"))
    assert.ok(!view.editableKeys.includes("TELEGRAM_ALLOW_USERS"))

    const updated = await fetch(`${h.base}/api/v1/config/LOG_LEVEL`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ value: "debug" }),
    })
    assert.equal(updated.status, 200)
    const afterUpdate = (await updated.json()) as { config: { entries: Array<{ key: string; value?: string }> } }
    assert.equal(afterUpdate.config.entries.find((entry) => entry.key === "LOG_LEVEL")?.value, "debug")

    const added = await fetch(`${h.base}/api/v1/config/MAX_MEDIA_MB`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ value: "25" }),
    })
    assert.equal(added.status, 200)

    // REMINDER_TIMEZONE takes the live-apply path through setTimezone
    const tz = await fetch(`${h.base}/api/v1/config/REMINDER_TIMEZONE`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ value: "Europe/Berlin" }),
    })
    assert.equal(tz.status, 200)
    const health = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
    assert.equal(((await health.json()) as { timezone: string }).timezone, "Europe/Berlin")

    const badTz = await fetch(`${h.base}/api/v1/config/REMINDER_TIMEZONE`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ value: "Not/AZone" }),
    })
    assert.equal(badTz.status, 400)

    const managed = await fetch(`${h.base}/api/v1/config/TELEGRAM_ALLOW_USERS`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ value: "1" }),
    })
    assert.equal(managed.status, 400)

    const noValue = await fetch(`${h.base}/api/v1/config/LOG_LEVEL`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    assert.equal(noValue.status, 400)

    const removed = await fetch(`${h.base}/api/v1/config/MAX_MEDIA_MB`, {
      method: "DELETE",
      headers: authHeaders(),
    })
    assert.equal(removed.status, 200)
    const removedAgain = await fetch(`${h.base}/api/v1/config/MAX_MEDIA_MB`, {
      method: "DELETE",
      headers: authHeaders(),
    })
    assert.equal(removedAgain.status, 400)
  })
})

test("api assigns agent models and exposes read-only cc views", async () => {
  await withApi(async () => "ok", async (h) => {
    const agentDir = join(h.dataDir, ".opencode", "agent")
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, "reviewer.md"), "---\ndescription: 代码审查\n---\n你是审查员。\n")
    writeFileSync(join(agentDir, "assistant.md"), "---\ndescription: 主助手\n---\n你是助手。\n")

    const assigned = await fetch(`${h.base}/api/v1/models/assign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agent: "reviewer", model: "sonnet" }),
    })
    assert.equal(assigned.status, 200)
    const body = (await assigned.json()) as {
      message: string
      result: { agent: string; model: string; label: string }
    }
    assert.equal(body.result.agent, "reviewer")
    assert.equal(body.result.model, "custom/claude-sonnet-5-5-high")
    assert.match(body.message, /reviewer/)

    const file = readFileSync(join(agentDir, "reviewer.md"), "utf8")
    assert.match(file, /model: custom\/claude-sonnet-5-5-high/)

    const listed = await fetch(`${h.base}/api/v1/models/custom`, { headers: authHeaders() })
    const agents = ((await listed.json()) as { agents: Array<{ name: string; model?: string }> }).agents
    assert.equal(agents.find((agent) => agent.name === "reviewer")?.model, "custom/claude-sonnet-5-5-high")

    // Assigning the bot's own opencode agent also switches the app session
    h.store.setEngine("api:app", "opencode")
    const self = await fetch(`${h.base}/api/v1/models/assign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agent: "self", model: "sonnet" }),
    })
    assert.equal(self.status, 200)
    const selfBody = (await self.json()) as { sessionMessage: string | null; session: { model?: string } }
    assert.match(selfBody.sessionMessage ?? "", /模型已切换/)
    assert.equal(selfBody.session.model, "claude-sonnet-5-5-high")

    const ghost = await fetch(`${h.base}/api/v1/models/assign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agent: "ghost", model: "sonnet" }),
    })
    assert.equal(ghost.status, 400)

    const badModel = await fetch(`${h.base}/api/v1/models/assign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agent: "reviewer", model: "nope" }),
    })
    assert.equal(badModel.status, 400)

    const missing = await fetch(`${h.base}/api/v1/models/assign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agent: "reviewer" }),
    })
    assert.equal(missing.status, 400)

    const view = await fetch(`${h.base}/api/v1/cc/view?name=config`, { headers: authHeaders() })
    assert.equal(view.status, 200)
    const viewBody = (await view.json()) as { name: string; text: string }
    assert.equal(viewBody.name, "config")
    assert.equal(viewBody.text, "view config show")

    const unknownView = await fetch(`${h.base}/api/v1/cc/view?name=rm-rf`, { headers: authHeaders() })
    assert.equal(unknownView.status, 400)
    assert.deepEqual(h.ccCalls.slice(-1), ["run:config show"])

    // Views the bot also runs must be reachable from the app: same output, same arguments.
    for (const [name, args] of [
      ["daemon", "daemon status"],
      ["settings", "settings show"],
      ["sessions", "sessions list"],
      ["auth", "auth status"],
      ["skills", "skills list"],
      ["failover", "failover show"],
    ]) {
      const res = await fetch(`${h.base}/api/v1/cc/view?name=${name}`, { headers: authHeaders() })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { name: string; text: string }
      assert.equal(body.name, name)
      assert.equal(body.text, `view ${args}`)
    }
    assert.deepEqual(h.ccCalls.slice(-6), [
      "run:daemon status",
      "run:settings show",
      "run:sessions list",
      "run:auth status",
      "run:skills list",
      "run:failover show",
    ])
  })
})

test("api exposes the cc view catalog and its targeted views", async () => {
  await withApi(async () => "ok", async (h) => {
    const list = await fetch(`${h.base}/api/v1/cc/views`, { headers: authHeaders() })
    assert.equal(list.status, 200)
    const views = (await list.json()) as {
      views: Array<{ name: string; label: string; needsTarget: boolean; targetLabel: string }>
    }
    // The app renders these verbatim, so every entry carries a usable title
    assert.ok(views.views.length > 7)
    assert.ok(views.views.every((view) => view.label.length > 0))
    assert.equal(views.views.find((view) => view.name === "config")?.needsTarget, false)
    const skillInfo = views.views.find((view) => view.name === "skill-info")
    assert.equal(skillInfo?.needsTarget, true)
    assert.equal(skillInfo?.targetLabel, "技能目录或 ID")

    const session = await fetch(`${h.base}/api/v1/cc/view?name=session-show&target=abc123`, {
      headers: authHeaders(),
    })
    assert.equal(session.status, 200)
    assert.equal(((await session.json()) as { text: string }).text, "view sessions show abc123")

    const prompt = await fetch(`${h.base}/api/v1/cc/view?name=prompt-show&target=review`, { headers: authHeaders() })
    assert.equal(((await prompt.json()) as { text: string }).text, "view prompts show review")

    // Network-bound views still answer through the same route
    const discover = await fetch(`${h.base}/api/v1/cc/view?name=skills-discover`, { headers: authHeaders() })
    assert.equal(discover.status, 200)

    // A view that needs an argument says so instead of running a half command
    const missingTarget = await fetch(`${h.base}/api/v1/cc/view?name=prompt-show`, { headers: authHeaders() })
    assert.equal(missingTarget.status, 400)
    assert.match(((await missingTarget.json()) as { error: string }).error, /需要提示词 ID/)

    // The target can never turn into a flag of its own
    const flagTarget = await fetch(`${h.base}/api/v1/cc/view?name=session-show&target=--help`, {
      headers: authHeaders(),
    })
    assert.equal(flagTarget.status, 400)

    assert.deepEqual(h.ccCalls.slice(-3), [
      "run:sessions show abc123",
      "run:prompts show review",
      "run:skills discover",
    ])
  })
})

test("api cc token tables let the app resolve typed /cc words", async () => {
  await withApi(async () => "ok", async (h) => {
    const [viewsRes, execRes] = await Promise.all([
      fetch(`${h.base}/api/v1/cc/views`, { headers: authHeaders() }),
      fetch(`${h.base}/api/v1/cc/exec`, { headers: authHeaders() }),
    ])
    const { views } = (await viewsRes.json()) as { views: Array<{ name: string; tokens: string[] }> }
    const { commands } = (await execRes.json()) as { commands: Array<{ name: string; tokens: string[] }> }

    // Every entry must carry at least one two-word token pair
    assert.ok(views.every((v) => v.tokens.length > 0), "every cc view must expose at least one token pair")
    assert.ok(commands.every((c) => c.tokens.length > 0), "every cc exec command must expose at least one token pair")

    const providerCurrent = views.find((v) => v.name === "provider-current")
    assert.ok(providerCurrent?.tokens.includes("provider current"), "provider-current must list its canonical pair")

    const providerDelete = commands.find((c) => c.name === "provider-delete")
    assert.ok(providerDelete?.tokens.includes("provider delete"))
    assert.ok(providerDelete?.tokens.includes("provider del"), "provider del alias must reach the app")
    assert.ok(providerDelete?.tokens.includes("provider rm"), "provider rm alias must reach the app")

    // Primary token pairs are unique across views (no two views share the same first pair)
    const viewPrimaries = views.map((v) => v.tokens[0])
    assert.equal(new Set(viewPrimaries).size, viewPrimaries.length, "primary cc view token pairs must be unique")

    // The app reads views first, so a pair naming both a view and a write would hide the write
    const viewTokens = new Set(views.flatMap((view) => view.tokens))
    const shared = commands.flatMap((command) => command.tokens).filter((token) => viewTokens.has(token))
    assert.deepEqual(shared, [], "a token pair must not name both a view and a mutating command")

    // The only known exec collision is skills-update / skills-update-all (disambiguated by needsTarget)
    const execPrimaries = commands.map((c) => c.tokens[0])
    const dupes = execPrimaries.filter((t, i) => execPrimaries.indexOf(t) !== i)
    assert.deepEqual(dupes.sort(), ["skills update"], "only the skills-update collision is allowed among exec primaries")
  })
})

test("api cc self-update and the extra views answer like Telegram", async () => {
  await withApi(async () => "ok", async (h) => {
    const execCatalog = async () => {
      const res = await fetch(`${h.base}/api/v1/cc/exec`, { headers: authHeaders() })
      return (await res.json()) as {
        commands: Array<{ name: string; label: string; group: string; confirm: boolean; tokens: string[] }>
      }
    }
    const postExec = (body: Record<string, unknown>) =>
      fetch(`${h.base}/api/v1/cc/exec`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })

    // Telegram's `/cc update` replaces cc-switch's own binary behind a confirm button; the
    // App must reach the same thing, not only the ops center's install script
    const commands = (await execCatalog()).commands
    const upgrade = commands.find((entry) => entry.name === "cc-update")
    assert.ok(upgrade, "the danger zone must offer cc-switch's native update")
    assert.equal(upgrade.confirm, true, "a binary swap needs the same confirm gate as Telegram")
    assert.equal(upgrade.group, "cc-switch 自更新")
    assert.deepEqual(upgrade.tokens, ["update binary"])
    const check = commands.find((entry) => entry.name === "cc-update-check")
    assert.equal(check?.confirm, false, "checking for an update is read-only")
    assert.deepEqual(check?.tokens, ["update check"])

    const beforeReject = h.ccCalls.length
    const unconfirmed = await postExec({ name: "cc-update" })
    assert.equal(unconfirmed.status, 400)
    assert.match(((await unconfirmed.json()) as { error: string }).error, /需要确认/)
    assert.equal(h.ccCalls.length, beforeReject, "a rejected update must never reach the CLI")

    const ranCheck = await postExec({ name: "cc-update-check" })
    assert.equal(ranCheck.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:update --check")

    const ranUpdate = await postExec({ name: "cc-update", confirm: true })
    assert.equal(ranUpdate.status, 200)
    // pty, because cc-switch asks for confirmation on a TTY before overwriting itself
    assert.equal(h.ccCalls.at(-1), "confirm:update")

    // The read-only views Telegram can print
    const view = async (name: string, target?: string) => {
      const suffix = target ? `&target=${encodeURIComponent(target)}` : ""
      const res = await fetch(`${h.base}/api/v1/cc/view?name=${name}${suffix}`, { headers: authHeaders() })
      return { status: res.status, body: (await res.json()) as { text?: string; error?: string } }
    }
    assert.equal((await view("skills-repos")).status, 200)
    assert.equal(h.ccCalls.at(-1), "run:skills repos list")

    assert.equal((await view("mcp-validate", "npx")).status, 200)
    assert.equal(h.ccCalls.at(-1), "run:mcp validate npx")

    // Not a view: `provider export` writes {cwd}/.claude/settings.local.json without -o,
    // so the read-only table must not offer it
    const exported = await view("provider-export", "p1")
    assert.equal(exported.status, 400)
    assert.match(exported.body.error ?? "", /未知的视图/)

    // A view must not claim the words of a mutating command, or the App resolves to the read
    const views = (await (await fetch(`${h.base}/api/v1/cc/views`, { headers: authHeaders() })).json()) as {
      views: Array<{ name: string; tokens: string[] }>
    }
    assert.deepEqual(
      views.views.find((entry) => entry.name === "skills-repos")?.tokens,
      ["skills repos list"],
      "the repos view may only name itself with all three words",
    )
  })
})

test("api reads and writes the Hermes memory blobs the way Telegram does", async () => {
  await withApi(async () => "ok", async (h) => {
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`${h.base}/api/v1/cc/hermes`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const errorOf = (body: Record<string, unknown>) => String(body.error ?? "")

    const read = await fetch(`${h.base}/api/v1/cc/hermes`, { headers: authHeaders() })
    assert.equal(read.status, 200)
    const state = (await read.json()) as {
      limits: string
      memory: string
      user: string
      memoryEnabled: boolean | null
      userEnabled: boolean | null
    }
    assert.match(state.limits, /2200 chars/)
    // cc-switch answers a missing file with a sentence, which must not reach the editor as
    // if it were the blob's own content
    assert.equal(state.user, "")
    assert.equal(state.memory, "旧记忆\n第二行")
    assert.equal(state.memoryEnabled, true)
    assert.equal(state.userEnabled, false)

    const beforeReject = h.ccCalls.length
    for (const body of [
      { kind: "memory", action: "set", content: "新记忆" },
      { kind: "memory", action: "clear", content: undefined },
      { kind: "memory", action: "set", content: "  \n ", confirm: true },
      { kind: "memory", action: "set", content: "a\u0000b", confirm: true },
      { kind: "notes", action: "enable" },
      { kind: "memory", action: "append" },
    ]) {
      const rejected = await post(body)
      assert.equal(rejected.status, 400, `${JSON.stringify(body)} must not be accepted`)
    }
    assert.equal(h.ccCalls.length, beforeReject, "a rejected memory write must never reach the CLI")
    const wrongKind = await post({ kind: "notes", action: "enable" })
    assert.match(errorOf(wrongKind.body), /memory 或 user/)
    const wrongAction = await post({ kind: "memory", action: "append" })
    assert.match(errorOf(wrongAction.body), /set、clear、enable、disable/)
    const noConfirm = await post({ kind: "memory", action: "set", content: "新记忆" })
    assert.match(errorOf(noConfirm.body), /需要确认/)
    const blank = await post({ kind: "memory", action: "set", content: "  \n ", confirm: true })
    assert.match(errorOf(blank.body), /内容为空/)
    const control = await post({ kind: "memory", action: "set", content: "a\u0000b", confirm: true })
    assert.match(errorOf(control.body), /控制字符/)

    // One argv word, so the blob keeps its line breaks and its spaces
    const wrote = await post({ kind: "memory", action: "set", content: "第一行\n第二行 with spaces", confirm: true })
    assert.equal(wrote.status, 200)
    assert.ok(
      h.ccCalls.includes("run:hermes memory set memory --content 第一行\n第二行 with spaces"),
      `the content must go to cc-switch as one word, got ${h.ccCalls.at(-1)}`,
    )
    assert.match(String(wrote.body.message), /已写入 MEMORY\.md（\d+ 字）。$/)

    // cc-switch writes past Hermes' budget and Hermes truncates on load, so going over is
    // reported instead of refused
    const long = await post({ kind: "memory", action: "set", content: "x".repeat(2300), confirm: true })
    assert.equal(long.status, 200)
    assert.match(String(long.body.message), /超出 Hermes 的 2200 字预算/)

    const cleared = await post({ kind: "user", action: "clear", confirm: true })
    assert.equal(cleared.status, 200)
    // Without --yes cc-switch prints a refusal and still exits 0, so the flag is the
    // server's to add once the user has confirmed
    assert.ok(h.ccCalls.includes("run:hermes memory clear user --yes"))
    assert.match(String(cleared.body.message), /已清空 USER\.md/)

    const enabled = await post({ kind: "user", action: "enable" })
    assert.equal(enabled.status, 200)
    assert.ok(h.ccCalls.includes("run:hermes memory enable user"))
    assert.match(String(enabled.body.message), /已启用 USER\.md/)
    // Every reply carries the stored text, so the editor shows the server, not a local draft
    assert.equal(String(enabled.body.user), "")
    assert.equal(String(enabled.body.limits).includes("2200 chars"), true)

    // The write has landed by the time the screen is refreshed, so a refresh that then
    // glitches must not come back as a failure — the App would repeat a write that worked
    h.ccFailNextRead()
    const stale = await post({ kind: "memory", action: "set", content: "写入成功", confirm: true })
    assert.equal(stale.status, 200)
    assert.equal(stale.body.ok, true)
    assert.equal(stale.body.refreshed, false)
    assert.match(String(stale.body.message), /已写入 MEMORY\.md/)
    assert.match(String(stale.body.message), /状态刷新失败/)
    // Half a state is worse than none: empty limits/memory/user would paint over the editor
    assert.equal(stale.body.limits, undefined)
    assert.equal(stale.body.memory, undefined)

    const afterGlitch = await post({ kind: "memory", action: "enable" })
    assert.equal(afterGlitch.status, 200)
    assert.equal(afterGlitch.body.refreshed, true)
    assert.match(String(afterGlitch.body.limits), /2200 chars/)
  })
})

test("api cc commands take the second half Telegram types in the same arg", async () => {
  await withApi(async () => "ok", async (h) => {
    const postExec = (body: Record<string, unknown>) =>
      fetch(`${h.base}/api/v1/cc/exec`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

    // The App prompts once per command, so `failover move p1 up` arrives as one string
    const moved = await postExec({ name: "failover-move", arg: "p1 up" })
    assert.equal(moved.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:failover move p1 up")

    const wrongDirection = await postExec({ name: "failover-move", arg: "p1 sideways" })
    assert.equal(wrongDirection.status, 400)
    assert.match(await errorOf(wrongDirection), /up 或 down/)

    const halfCommand = await postExec({ name: "failover-move", arg: "p1" })
    assert.equal(halfCommand.status, 400, "a move without its direction must not run")

    // cc-switch spells the flag before the id; an unknown app would blank the matrix
    const apps = await postExec({ name: "mcp-set-apps", arg: "fs open-code,codex" })
    assert.equal(apps.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:mcp set-apps --apps open-code,codex fs")

    const badApps = await postExec({ name: "mcp-set-apps", arg: "fs open-code,bogus" })
    assert.equal(badApps.status, 400)
    assert.match(await errorOf(badApps), /应用列表/)

    // A prompt name is free text: spaces survive because it travels as one argv word
    const renamed = await postExec({ name: "prompt-rename", arg: "review 每日 复盘" })
    assert.equal(renamed.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:prompts rename review --name 每日 复盘")

    const flagName = await postExec({ name: "prompt-rename", arg: "review --help" })
    assert.equal(flagName.status, 400, "the new name must never read as a flag")

    // Proxy settings take one value and no id, yet the App still has to prompt for it
    const commands = (await (await fetch(`${h.base}/api/v1/cc/exec`, { headers: authHeaders() })).json()) as {
      commands: Array<{ name: string; needsTarget: boolean; tokens: string[] }>
    }
    const port = commands.commands.find((entry) => entry.name === "proxy-listen-port")
    assert.equal(port?.needsTarget, true, "a command whose only value is its arg must ask for it")
    assert.deepEqual(port?.tokens, ["proxy config port"])

    const setPort = await postExec({ name: "proxy-listen-port", arg: "8787" })
    assert.equal(setPort.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:proxy config --listen-port 8787")

    const badPort = await postExec({ name: "proxy-listen-port", arg: "http://x" })
    assert.equal(badPort.status, 400)

    // Five digits is not a port: 99999 would reach cc-switch as a listen port and the
    // proxy would just stop working instead of the App getting a fixable error
    for (const outOfRange of ["0", "99999"]) {
      const wide = await postExec({ name: "proxy-listen-port", arg: outOfRange })
      assert.equal(wide.status, 400, `${outOfRange} is not a usable port`)
      assert.match(await errorOf(wide), /1-65535/)
    }
    assert.equal(h.ccCalls.at(-1), "run:proxy config --listen-port 8787", "a rejected port must not run")

    const setAddress = await postExec({ name: "proxy-listen-address", arg: "127.0.0.1" })
    assert.equal(setAddress.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:proxy config --listen-address 127.0.0.1")

    // Single-target commands keep refusing a stray second word
    const tooMany = await postExec({ name: "mcp-disable", arg: "fs extra" })
    assert.equal(tooMany.status, 400)
    assert.match(await errorOf(tooMany), /只能是一个/)
  })
})

test("api runs the raw cc-switch argv Telegram answers as /cc run", async () => {
  await withApi(async () => "ok", async (h) => {
    const postRun = (body: Record<string, unknown>) =>
      fetch(`${h.base}/api/v1/cc/run`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

    // Whatever Telegram can type, the App can send: the argv reaches cc-switch unchanged
    const plain = await postRun({ args: ["env", "list", "--json"] })
    assert.equal(plain.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:env list --json")
    assert.equal(((await plain.json()) as { text: string }).text, "view env list --json")

    // One guard for both surfaces: a command that would sit waiting for a keyboard
    // is refused instead of pretending to have run, confirm: true included
    for (const args of [["proxy", "serve"], ["sessions", "resume"], ["mcp", "add", "x"], ["daemon", "start"]]) {
      const res = await postRun({ args, confirm: true })
      assert.equal(res.status, 400, `${args.join(" ")} cannot run in a chat`)
    }
    assert.equal(h.ccCalls.at(-1), "run:env list --json", "a blocked command must not reach the CLI")

    // The spelling the guard accepts still runs
    const detached = await postRun({ args: ["daemon", "start", "--detach"] })
    assert.equal(detached.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:daemon start --detach")

    // -a/--app would retarget another app's config, in every spelling cc-switch reads
    for (const token of ["-a", "-a=codex", "-acodex", "--app", "--app=codex"]) {
      const res = await postRun({ args: ["provider", "list", token], confirm: true })
      assert.equal(res.status, 400, `${token} must not select the app`)
      assert.match(await errorOf(res), /CC_SWITCH_APP/)
    }

    // Destructive shapes wait for a confirmation, then run with cc-switch's own flag
    const unconfirmed = await postRun({ args: ["sessions", "delete", "s1"] })
    assert.equal(unconfirmed.status, 400)
    assert.match(await errorOf(unconfirmed), /需要确认/)
    const deleted = await postRun({ args: ["sessions", "delete", "s1"], confirm: true })
    assert.equal(deleted.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:sessions delete s1 --yes")

    // `provider use` takes the same path as the App's button, so the switch does the
    // bookkeeping the raw CLI would skip
    const used = await postRun({ args: ["provider", "use", "p1"], confirm: true })
    assert.equal(used.status, 200)
    assert.equal(h.ccCalls.at(-1), "use:p1")

    // A binary upgrade is confirmed and gets its long timeout
    const upgraded = await postRun({ args: ["update"], confirm: true })
    assert.equal(upgraded.status, 200)
    assert.equal(h.ccCalls.at(-1), "confirm:update")

    // Deep links carry provider keys inside the URL, so they stay on their own endpoint
    const link = await postRun({ args: ["deeplink", "ccswitch://v1/import?a=1"], confirm: true })
    assert.equal(link.status, 400)
    assert.match(await errorOf(link), /deeplink/i)

    // A key typed into the argv is masked in everything sent back
    const keyed = await postRun({ args: ["provider", "add", "sk-abcdefghijklmnopqrstuvwxyz"] })
    assert.equal(keyed.status, 200)
    const keyedBody = (await keyed.json()) as { text: string; command: string }
    assert.ok(
      !keyedBody.text.includes("sk-abcdefghijklmnopqrstuvwxyz"),
      `the echoed output leaked the typed key: ${keyedBody.text}`,
    )
    assert.match(keyedBody.text, /sk-\*\*\*/)

    // Junk argv never reaches the CLI
    for (const args of [[], [""], ["mcp", "list\nall"], Array(17).fill("x"), ["a".repeat(300)]]) {
      const res = await postRun({ args, confirm: true })
      assert.equal(res.status, 400)
    }
    const noArgs = await postRun({ confirm: true })
    assert.equal(noArgs.status, 400)
    assert.match(await errorOf(noArgs), /args/)
  })
})

test("api magpie exec runs only catalog commands with validated targets and confirmation", async () => {
  await withApi(async () => "ok", async (h) => {
    const overview = await fetch(`${h.base}/api/v1/magpie`, { headers: authHeaders() })
    assert.equal(overview.status, 200)
    const catalog = (await overview.json()) as {
      available: boolean
      views: Array<{ name: string; needsTarget: boolean }>
      commands: Array<{ name: string; label: string; needsTarget: boolean; confirm: boolean }>
    }
    assert.equal(catalog.available, true)
    assert.ok(catalog.views.some((view) => view.name === "providers"))
    assert.ok(catalog.commands.some((command) => command.name === "provider-test" && command.needsTarget))
    assert.ok(catalog.commands.some((command) => command.name === "provider-rm" && command.confirm))

    const postExec = (body: Record<string, unknown>) =>
      fetch(`${h.base}/api/v1/magpie/exec`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error ?? ""

    // A safe catalog command reaches the CLI with exactly the argv the server built.
    const checked = await postExec({ name: "update-check" })
    assert.equal(checked.status, 200)
    assert.equal(h.magpieCalls.at(-1), "update check")
    const checkedBody = (await checked.json()) as { ok: boolean; name: string; label: string; text: string }
    assert.equal(checkedBody.ok, true)
    assert.equal(checkedBody.name, "update-check")
    assert.equal(checkedBody.label, "检查 magpie 更新")
    assert.equal(checkedBody.text, "magpie: update check")

    // A target-taking command rejects a missing or injection-shaped target before running.
    const missingTarget = await postExec({ name: "provider-test" })
    assert.equal(missingTarget.status, 400)
    assert.match(await errorOf(missingTarget), /Provider ID/)
    const traversal = await postExec({ name: "provider-test", target: "../etc" })
    assert.equal(traversal.status, 400)
    assert.match(await errorOf(traversal), /路径段/)
    assert.equal(h.magpieCalls.at(-1), "update check", "a rejected target must never reach magpie")

    // A destructive command keeps the server's confirmation gate, then receives the target.
    const unconfirmed = await postExec({ name: "provider-rm", target: "p1" })
    assert.equal(unconfirmed.status, 400)
    assert.match(await errorOf(unconfirmed), /需要确认/)
    assert.equal(h.magpieCalls.at(-1), "update check", "an unconfirmed removal must never reach magpie")
    const removed = await postExec({ name: "provider-rm", target: "p1", confirm: true })
    assert.equal(removed.status, 200)
    assert.equal(h.magpieCalls.at(-1), "provider rm p1")

    // Only names from the server catalog are accepted; an arbitrary argv belongs on /magpie/run.
    const unknown = await postExec({ name: "shell", target: "rm -rf" })
    assert.equal(unknown.status, 400)
    assert.match(await errorOf(unknown), /未知的命令/)
    assert.equal(h.magpieCalls.at(-1), "provider rm p1")
  })
})

/**
 * cc-switch reads `-a`/`--app` on every subcommand, and `--apps` is a different flag that
 * has to stay usable — the guard has to tell those apart in every compact spelling.
 */
test("cc passthrough names the app flag in every spelling cc-switch reads", async () => {
  const { ccAppFlagToken } = await import("../src/ccGuards.js")
  for (const token of ["-a", "-a=codex", "-acodex", "--app", "--app=codex"]) {
    assert.equal(ccAppFlagToken(["provider", "list", token]), token, `${token} selects another app`)
  }
  for (const args of [["mcp", "set-apps", "--apps", "codex", "fs"], ["provider", "list", "--all"], ["env", "get", "-p"]]) {
    assert.equal(ccAppFlagToken(args), undefined, `${args.join(" ")} is app-neutral`)
  }
})

/**
 * Hermes memory needs three words to name what it overwrites, and its `clear` exits 0
 * printing a refusal unless cc-switch also sees `--yes`. Both surfaces share this guard.
 */
test("cc guards gate the Hermes memory commands on every word that matters", () => {
  assert.match(ccBlockedReason(["hermes", "memory", "open-dir"], "App") ?? "", /文件管理器/)
  for (const args of [
    ["hermes", "memory", "limits"],
    ["hermes", "memory", "show", "memory"],
    ["hermes", "memory", "enable", "user"],
    ["hermes", "memory", "disable", "user"],
  ]) {
    assert.equal(ccBlockedReason(args), undefined, `${args.join(" ")} is a usable cc-switch command`)
    assert.equal(ccConfirmPlan(args), undefined, `${args.join(" ")} is not an overwrite`)
  }
  const cleared = ccConfirmPlan(["hermes", "memory", "clear", "user"])
  assert.deepEqual(cleared?.appendArgs, ["--yes"], "a clear without cc-switch's flag no-ops silently")
  assert.match(cleared?.label ?? "", /USER\.md/)
  assert.match(ccConfirmPlan(["hermes", "memory", "set", "memory", "--content", "x"])?.label ?? "", /MEMORY\.md/)
})

/**
 * The App's fixed buttons and the raw passthrough share one guard, so a whitelisted entry
 * the guard would refuse is a dead button the moment it is added. This runs every argv the
 * catalogs can build through the same rules `/cc run` applies.
 */
test("every whitelisted cc-switch entry survives the shared passthrough guards", () => {
  for (const [name, spec] of Object.entries(CC_VIEWS)) {
    const argv = spec.args("t1")
    assert.equal(ccBlockedReason(argv), undefined, `view ${name} is blocked as interactive`)
    assert.equal(ccConfirmPlan(argv), undefined, `view ${name} would ask the user to confirm a read`)
  }

  for (const [name, spec] of Object.entries(CC_EXEC_COMMANDS)) {
    const argv = spec.args(spec.needsTarget ? "t1" : "", "x")
    assert.equal(ccBlockedReason(argv), undefined, `exec ${name} is blocked as interactive`)
    const plan = ccConfirmPlan(argv)
    assert.equal(
      Boolean(plan),
      spec.confirm === true,
      `exec ${name} disagrees with the guard${plan ? `: it wants confirming (${plan.label})` : ""}`,
    )
    assert.equal(
      spec.pty === true,
      plan?.pty === true,
      `exec ${name} would run under a pty while Telegram would not`,
    )
  }
})

test("api surfaces every Telegram /cc alias the app can stand for", async () => {
  await withApi(async () => "ok", async (h) => {
    const [viewsRes, execRes] = await Promise.all([
      fetch(`${h.base}/api/v1/cc/views`, { headers: authHeaders() }),
      fetch(`${h.base}/api/v1/cc/exec`, { headers: authHeaders() }),
    ])
    const { views } = (await viewsRes.json()) as { views: Array<{ tokens: string[] }> }
    const { commands } = (await execRes.json()) as { commands: Array<{ tokens: string[] }> }
    const entries = [...views, ...commands]

    for (const [alias, pair] of Object.entries(CC_SUB_ALIASES)) {
      const owner = entries.find((entry) => entry.tokens.includes(`${pair[0]} ${pair[1]}`))
      // An alias with no entry behind it would be a word Telegram answers and the App cannot
      assert.ok(owner, `「${alias}」 resolves to 「${pair.join(" ")}」, which no cc entry runs`)
      assert.ok(owner.tokens.includes(alias), `「${alias}」 must reach the entry running ${pair.join(" ")}`)
    }

    // A three-word shape is addressable by its full run, its pair and its alias alike
    const repoAdd = commands.find((command) => command.name === "skills-repos-add")
    assert.deepEqual(repoAdd?.tokens, ["skills repos add", "skills repos", "skills repo"])
  })
})

test("api runs provider stream check, model fetch, MCP import and prompt creation", async () => {
  await withApi(async () => "ok", async (h) => {
    const stream = await fetch(`${h.base}/api/v1/cc/stream?id=p1`, { headers: authHeaders() })
    assert.equal(stream.status, 200)
    assert.equal(((await stream.json()) as { text: string }).text, "stream ok: first token in 120ms")

    const models = await fetch(`${h.base}/api/v1/cc/models?id=p2`, { headers: authHeaders() })
    assert.equal(((await models.json()) as { id: string }).id, "p2")

    const missingId = await fetch(`${h.base}/api/v1/cc/stream`, { headers: authHeaders() })
    assert.equal(missingId.status, 400)

    const imported = await fetch(`${h.base}/api/v1/cc/mcp/import`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ json: '{"mcpServers":{"demo":{"command":"npx"}}}' }),
    })
    assert.equal(imported.status, 200)

    const emptyImport = await fetch(`${h.base}/api/v1/cc/mcp/import`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ json: "  " }),
    })
    assert.equal(emptyImport.status, 400)

    const spacedName = await fetch(`${h.base}/api/v1/cc/prompts/create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "has space", content: "x" }),
    })
    assert.equal(spacedName.status, 400)

    const created = await fetch(`${h.base}/api/v1/cc/prompts/create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "review", content: "审查这段改动" }),
    })
    assert.equal(created.status, 200)

    assert.deepEqual(h.ccCalls.slice(-4), [
      "stream:p1",
      "models:p2",
      'mcp:import:{"mcpServers',
      "prompt:new:review:6",
    ])
  })
})

test("api exposes provider quota and an allowlisted cc action runner", async () => {
  await withApi(async () => "ok", async (h) => {
    const catalog = await fetch(`${h.base}/api/v1/cc/exec`, { headers: authHeaders() })
    assert.equal(catalog.status, 200)
    const { commands } = (await catalog.json()) as {
      commands: Array<{ name: string; label: string; group: string; needsTarget: boolean; confirm: boolean }>
    }
    // sections come from cc-switch's top-level group, so the app can group its list
    assert.equal(commands.find((entry) => entry.name === "provider-delete")?.group, "Provider")
    assert.equal(commands.find((entry) => entry.name === "proxy-enable")?.group, "代理")
    assert.equal(commands.find((entry) => entry.name === "skill-uninstall")?.group, "技能")
    assert.ok(commands.every((entry) => entry.group.length > 0))
    assert.ok(
      commands.findIndex((entry) => entry.group === "Provider") <
        commands.findIndex((entry) => entry.group === "MCP 服务器"),
    )
    const deleteProvider = commands.find((entry) => entry.name === "provider-delete")
    assert.ok(deleteProvider?.needsTarget)
    assert.ok(deleteProvider?.confirm)
    assert.equal(commands.find((entry) => entry.name === "failover-disable")?.confirm, false)
    // duplicating is additive, changing the default or importing live is not
    const duplicated = commands.find((entry) => entry.name === "provider-duplicate")
    assert.equal(duplicated?.needsTarget, true)
    assert.equal(duplicated?.confirm, false)
    assert.ok(commands.find((entry) => entry.name === "provider-set-default")?.confirm)
    assert.ok(commands.find((entry) => entry.name === "provider-import-live")?.confirm)
    assert.ok(commands.find((entry) => entry.name === "mcp-disable")?.needsTarget)

    const quota = await fetch(`${h.base}/api/v1/cc/quota?id=p1`, { headers: authHeaders() })
    assert.equal(quota.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:provider quota p1")

    // ccTargetId raises its ApiError inside the ccQuery closure, so re-wrapping every
    // thrown error as 502 blamed cc-switch for the caller's typo and ran the CLI anyway
    const callsBeforeBad = h.ccCalls.length
    for (const bad of ["-x", "p 1"]) {
      const rejected = await fetch(`${h.base}/api/v1/cc/quota?id=${encodeURIComponent(bad)}`, {
        headers: authHeaders(),
      })
      assert.equal(rejected.status, 400, `quota must answer 400 for id ${JSON.stringify(bad)}`)
    }
    assert.equal(h.ccCalls.length, callsBeforeBad, "a rejected id must never reach cc-switch")

    const disabled = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "failover-disable" }),
    })
    assert.equal(disabled.status, 200)
    assert.equal(((await disabled.json()) as { ok: boolean }).ok, true)
    assert.equal(h.ccCalls.at(-1), "run:failover disable")

    const mcpOff = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "mcp-disable", arg: "fs" }),
    })
    assert.equal(mcpOff.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:mcp disable fs")

    const proxyOn = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "proxy-enable" }),
    })
    assert.equal(proxyOn.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:proxy enable")

    const queueAdd = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "failover-add", arg: "p2" }),
    })
    assert.equal(queueAdd.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:failover add p2")

    // skills-update-all takes no target but still needs the 90s budget
    const allSkills = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "skills-update-all" }),
    })
    assert.equal(allSkills.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:skills update --all")

    // Destructive entries need confirm:true, the same gate Telegram shows as a button
    const unconfirmed = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "provider-delete", arg: "p9" }),
    })
    assert.equal(unconfirmed.status, 400)
    assert.match(((await unconfirmed.json()) as { error: string }).error, /需要确认/)

    const confirmed = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "provider-delete", arg: "p9", confirm: true }),
    })
    assert.equal(confirmed.status, 200)
    assert.equal(h.ccCalls.at(-1), "confirm:provider delete p9")

    // The CLI only ever sees allowlisted argv: names, flags and targets are fixed
    const unknown = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "provider add", arg: "x", confirm: true }),
    })
    assert.equal(unknown.status, 400)

    const traversal = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "mcp-delete", arg: "../../etc/passwd", confirm: true }),
    })
    assert.equal(traversal.status, 400)

    const strayTarget = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "failover-clear", arg: "--dry-run", confirm: true }),
    })
    assert.equal(strayTarget.status, 400)
    assert.equal(h.ccCalls.at(-1), "confirm:provider delete p9")
  })
})

test("api searches cc-switch sessions, imports deep links and installs skills", async () => {
  await withApi(async () => "ok", async (h) => {
    const search = await fetch(`${h.base}/api/v1/cc/sessions?q=fix%20login`, { headers: authHeaders() })
    assert.equal(search.status, 200)
    assert.equal(((await search.json()) as { query: string }).query, "fix login")
    assert.equal(h.ccCalls.at(-1), "run:sessions search fix login")

    const blank = await fetch(`${h.base}/api/v1/cc/sessions?q=%20`, { headers: authHeaders() })
    assert.equal(blank.status, 400)
    const option = await fetch(`${h.base}/api/v1/cc/sessions?q=--help`, { headers: authHeaders() })
    assert.equal(option.status, 400)
    // Session titles are mostly Chinese and both clients invite a Chinese keyword, so the
    // guard rejects control characters rather than everything outside ASCII.
    const chinese = await fetch(`${h.base}/api/v1/cc/sessions?q=${encodeURIComponent("修复登录")}`, { headers: authHeaders() })
    assert.equal(chinese.status, 200)
    assert.equal(((await chinese.json()) as { query: string }).query, "修复登录")
    const newline = await fetch(`${h.base}/api/v1/cc/sessions?q=a%0Ab`, { headers: authHeaders() })
    assert.equal(newline.status, 400)

    const https = await fetch(`${h.base}/api/v1/cc/deeplink`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url: "https://example.com/v1/import", confirm: true }),
    })
    assert.equal(https.status, 400)

    const link = "ccswitch://v1/import?resource=mcp&json=%7B%7D"
    const unconfirmed = await fetch(`${h.base}/api/v1/cc/deeplink`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url: link }),
    })
    assert.equal(unconfirmed.status, 400)

    const imported = await fetch(`${h.base}/api/v1/cc/deeplink`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url: link, confirm: true }),
    })
    assert.equal(imported.status, 200)
    // Deep links can embed provider keys, so the response must not echo the URL back
    const importedBody = (await imported.json()) as { ok: boolean; url?: string }
    assert.equal(importedBody.ok, true)
    assert.equal(importedBody.url, undefined)
    assert.equal(h.ccCalls.at(-1), "bare:deeplink:ccswitch://v1/import")

    const skill = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "skill-install", arg: "openai/skills" }),
    })
    assert.equal(skill.status, 200)
    assert.equal(h.ccCalls.at(-1), "run:skills install openai/skills")

    const traversal = await fetch(`${h.base}/api/v1/cc/exec`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "skill-install", arg: "openai/.." }),
    })
    assert.equal(traversal.status, 400)
  })
})

test("api creates a cc-switch provider without leaking the submitted key", async () => {
  await withApi(async () => "ok", async (h) => {
    const catalog = await fetch(`${h.base}/api/v1/cc/providers`, { headers: authHeaders() })
    assert.equal(catalog.status, 200)
    const meta = (await catalog.json()) as {
      app: string
      fieldMode: boolean
      templates: string[]
      apiFormats: string[]
      configMaxLength: number
    }
    assert.ok(meta.templates.includes("claudeapi"))
    assert.ok(meta.apiFormats.includes("anthropic"))
    assert.equal(meta.configMaxLength, 20_000)
    // the form switches to "raw JSON required" for apps cc-switch can't take fields for
    assert.equal(meta.app, "opencode")
    assert.equal(meta.fieldMode, false)

    const created = await fetch(`${h.base}/api/v1/cc/providers`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name: "团队代理",
        id: "team-1",
        template: "claudeapi",
        baseUrl: "https://apiproxy.example.com",
        apiKey: "sk-abcdef0123456789",
      }),
    })
    assert.equal(created.status, 200)
    const body = (await created.json()) as { ok: boolean; message: string; text: string }
    assert.equal(body.ok, true)
    assert.ok(!JSON.stringify(body).includes("sk-abcdef0123456789"), "the key must never come back")

    const missingName = await fetch(`${h.base}/api/v1/cc/providers`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ baseUrl: "https://x.example.com" }),
    })
    assert.equal(missingName.status, 400)

    // Service-side field validation is the form's mistake, not an upstream failure
    const badTemplate = await fetch(`${h.base}/api/v1/cc/providers`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "x", template: "nope" }),
    })
    assert.equal(badTemplate.status, 400)
    assert.match(((await badTemplate.json()) as { error: string }).error, /未知的 Provider 模板/)

    // cc-switch refusing the command is an upstream failure, not the form's mistake: the
    // service throws for any non-zero exit, so the old `result.code !== 0` branch below
    // was unreachable and this answered 400 while claiming the provider was created
    const refused = await fetch(`${h.base}/api/v1/cc/providers`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "dup" }),
    })
    assert.equal(refused.status, 502)
    assert.match(((await refused.json()) as { error: string }).error, /该 Provider 名称已存在/)
  })
})

test("api serves the shared help copy as plain text", async () => {
  await withApi(async () => "ok", async (h) => {
    const res = await fetch(`${h.base}/api/v1/help`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      sections: Array<{ id: string; title: string; text: string }>
      commands: Array<{ command: string; description: string }>
      aliases: Record<string, string>
    }
    assert.deepEqual(body.sections.map((s) => s.id), ["basic", "full", "cc"])
    for (const section of body.sections) {
      assert.ok(section.title.length > 0)
      assert.ok(section.text.length > 0)
      assert.ok(!section.text.includes("`"), `${section.id} still carries Telegram code markers`)
      assert.ok(!section.text.includes("*"), `${section.id} still carries Telegram bold markers`)
    }
    assert.match(body.sections[0]!.text, /\/new/)
    assert.match(body.sections[1]!.text, /\/schedule add/)
    assert.match(body.sections[2]!.text, /\/cc provider list/)

    // The app builds its "/" palette from this list, so it must be the bot's real surface
    const names = body.commands.map((item) => item.command)
    assert.ok(names.length > 20, `expected the full command list, got ${names.length}`)
    assert.equal(new Set(names).size, names.length, "the command list must not repeat a name")
    for (const name of ["agent", "model", "dir", "timezone", "remind", "cancel", "queue", "cc", "env"]) {
      assert.ok(names.includes(name), `/${name} is missing from the command list`)
    }
    for (const item of body.commands) {
      assert.match(item.command, /^[a-z][a-z0-9_]*$/, `${item.command} is not a plain command word`)
      assert.ok(item.description.trim().length > 0, item.command)
    }
    // Aliases resolve to a listed command, so the app can never route to an unknown one
    for (const [alias, target] of Object.entries(body.aliases)) {
      assert.ok(names.includes(target), `/${alias} points at the unlisted /${target}`)
    }
    assert.equal(body.aliases.tz, "timezone")
    assert.equal(body.aliases.reset, "new")
  })
})

test("api exposes session and pairing info without leaking the token", async () => {
  await withApi(async () => "ok", async (h) => {
    const res = await fetch(`${h.base}/api/v1/info`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const raw = await res.text()
    assert.ok(!raw.includes(TOKEN), "API token must never be echoed back")
    const info = JSON.parse(raw) as {
      engine: string
      engineLabel: string
      workDir: string
      chatId: number | null
      sessionId: string | null
      cliSessionId: string | null
      api: { enabled: boolean; bind: string; port: number; tokenConfigured: boolean }
    }
    assert.equal(info.engine, "claude")
    assert.ok(info.engineLabel.length > 0)
    assert.equal(info.workDir, h.dataDir)
    assert.equal(info.chatId, 42)
    assert.equal(info.sessionId, null)
    assert.equal(info.cliSessionId, null)
    assert.equal(info.api.enabled, true)
    assert.equal(info.api.bind, "127.0.0.1")
    assert.equal(info.api.port, 0)
    assert.equal(info.api.tokenConfigured, true)
  })
})

test("api follows an owner learned after startup for info, reminders and attachments", async () => {
  await withApi(async () => "ok", async (h) => {
    const readInfo = async (): Promise<{ chatId: number | null; userId: number | null }> => {
      const res = await fetch(`${h.base}/api/v1/info`, { headers: authHeaders() })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { chatId: number | null; userId: number | null }
      return { chatId: body.chatId, userId: body.userId }
    }

    assert.deepEqual(await readInfo(), { chatId: 42, userId: 42 })

    // A Feishu chat and its owner use separate negative numeric namespaces.
    const feishuChat = -2_000_000_001
    const feishuUser = -2_000_000_002
    h.setOwner(feishuChat, feishuUser)
    assert.deepEqual(await readInfo(), { chatId: feishuChat, userId: feishuUser })

    const created = await fetch(`${h.base}/api/v1/reminders`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "30m 飞书喝水" }),
    })
    assert.equal(created.status, 201)
    const reminder = h.reminders.list(feishuChat)[0]
    assert.equal(reminder?.userId, feishuUser, "reminder access must use the owner user id")
    assert.equal(h.reminders.list(42).length, 0, "the old Telegram owner must not receive it")

    const task = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        text: "检查附件目录",
        attachments: [{ name: "dynamic-owner.txt", mime: "text/plain", data: Buffer.from("ok").toString("base64") }],
      }),
    })
    assert.equal(task.status, 202)
    const files = readdirSync(join(h.dataDir, "inbox"))
    assert.ok(
      files.some((name) => name.startsWith(`${feishuChat}-`) && name.endsWith("-dynamic-owner.txt")),
      `attachment should use the live chat id, got ${files.join(", ")}`,
    )
  })
})


test("api streams task events over SSE until the terminal state", async () => {
  // Deferred engine: keeps the task running until the test pulls the finish trigger
  let finish: (() => void) | undefined
  await withApi(
    (_key, _engine, text, onProgress) =>
      new Promise((resolve) => {
        let step = 0
        const timer = setInterval(() => {
          step += 1
          onProgress?.(`思考步骤 ${step}`)
          if (step === 3) {
            clearInterval(timer)
            finish = () => resolve(`回复：${text}`)
          }
        }, 30)
        finish = () => {
          clearInterval(timer)
          resolve(`回复：${text}`)
        }
      }),
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "流式任务" }),
      })
      const { task } = (await created.json()) as { task: { id: string } }

      const stream = await fetch(`${h.base}/api/v1/task/${task.id}/events`, { headers: authHeaders() })
      assert.equal(stream.status, 200)
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/)

      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const events: Array<{ task: { status: string; progress?: string; reply?: string } }> = []
      const done = (async () => {
        for (;;) {
          const { value, done: closed } = await reader.read()
          if (closed) break
          buffer += decoder.decode(value, { stream: true })
          let sep: number
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("")
            if (data) events.push(JSON.parse(data))
          }
        }
      })()

      // Wait for progress events, then finish the engine
      await new Promise((resolve) => setTimeout(resolve, 250))
      finish?.()
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("SSE 流未关闭")), 5_000))])

      assert.ok(events.length >= 2, `expected progress + terminal events, got ${events.length}`)
      const final = events[events.length - 1]!.task
      assert.equal(final.status, "done")
      assert.equal(final.reply, "回复：流式任务")
      const withProgress = events.filter((event) => event.task.progress !== undefined)
      assert.ok(withProgress.length >= 1, "expected at least one progress event")
    },
  )
})

/**
 * Only the task's own state may end an event stream. Progress frames carry the CLI's output, so a
 * run that prints {"status":"done"} travels through the same path as a real settlement; the server
 * reads `task.status` rather than the serialized frame, and this pins the behaviour that holds
 * either way: the fake frame reaches the client, the stream stays open, and the task settles only
 * when the engine actually returns.
 */
test("api keeps streaming a task whose output looks like a terminal state", async () => {
  let finish: (() => void) | undefined
  await withApi(
    (_key, _engine, text, onProgress) =>
      new Promise<string>((resolve) => {
        setTimeout(() => onProgress?.('解析结果 {"status":"done"}'), 120)
        setTimeout(() => onProgress?.("第二步还在跑"), 500)
        finish = () => resolve(`回复：${text}`)
      }),
    async (h) => {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "会打印状态的 Agent" }),
      })
      const { task } = (await created.json()) as { task: { id: string } }

      const stream = await fetch(`${h.base}/api/v1/task/${task.id}/events`, { headers: authHeaders() })
      assert.equal(stream.status, 200)
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const events: Array<{ task: { status: string; progress?: string; reply?: string } }> = []
      const pump = (async () => {
        for (;;) {
          const { value, done: closed } = await reader.read()
          if (closed) break
          buffer += decoder.decode(value, { stream: true })
          let sep: number
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("")
            if (data) events.push(JSON.parse(data))
          }
        }
      })()

      await new Promise((resolve) => setTimeout(resolve, 800))
      assert.ok(
        events.some((event) => event.task.progress === '解析结果 {"status":"done"}'),
        "the fake frame should still reach the client",
      )
      assert.ok(
        events.some((event) => event.task.progress === "第二步还在跑"),
        "a frame after the fake terminal payload must still arrive",
      )
      assert.ok(
        events.every((event) => event.task.status === "running"),
        `nothing may settle a live task: ${JSON.stringify(events.map((event) => event.task.status))}`,
      )

      finish?.()
      await Promise.race([pump, new Promise((_, reject) => setTimeout(() => reject(new Error("SSE 流未关闭")), 5_000))])
      const final = events[events.length - 1]!.task
      assert.equal(final.status, "done")
      assert.equal(final.reply, "回复：会打印状态的 Agent")
    },
  )
})

test("api returns a snapshot instead of a stream for settled tasks", async () => {
  await withApi(async () => "ok", async (h) => {
    const created = await fetch(`${h.base}/api/v1/task`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "快速任务" }),
    })
    const { task } = (await created.json()) as { task: { id: string } }
    let status = ""
    for (let i = 0; i < 50 && status !== "done"; i++) {
      const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
      status = ((await res.json()) as { task: { status: string } }).task.status
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const res = await fetch(`${h.base}/api/v1/task/${task.id}/events`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /application\/json/)
    const body = (await res.json()) as { task: { status: string } }
    assert.equal(body.task.status, "done")
  })
})

test("api exports history as markdown and json", async () => {
  await withApi(async () => "ok", async (h) => {
    // two finished tasks with distinct prompts
    for (const text of ["第一件事", "第二件事"]) {
      const created = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text }),
      })
      const { task } = (await created.json()) as { task: { id: string } }
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`${h.base}/api/v1/task/${task.id}`, { headers: authHeaders() })
        if (((await res.json()) as { task: { status: string } }).task.status === "done") break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const md = await fetch(`${h.base}/api/v1/export?format=markdown`, { headers: authHeaders() })
    assert.equal(md.status, 200)
    assert.match(md.headers.get("content-type") ?? "", /text\/markdown/)
    assert.match(md.headers.get("content-disposition") ?? "", /\.md"$/)
    const markdown = await md.text()
    assert.match(markdown, /# Agent Bot 任务历史/)
    assert.match(markdown, /第一件事/)
    assert.match(markdown, /第二件事/)
    assert.match(markdown, /^> /m)

    const json = await fetch(`${h.base}/api/v1/export?format=json`, { headers: authHeaders() })
    assert.equal(json.status, 200)
    assert.match(json.headers.get("content-type") ?? "", /application\/json/)
    const body = JSON.parse(await json.text()) as { entries: Array<{ prompt: string }>; key: string }
    assert.equal(body.entries.length, 2)
    assert.equal(body.key, "api:app")

    const bad = await fetch(`${h.base}/api/v1/export?format=xml`, { headers: authHeaders() })
    assert.equal(bad.status, 400)
  })
})

/**
 * The App decodes each of these payloads with `ignoreUnknownKeys`, so drift on either side
 * never raises: a renamed field simply keeps its Kotlin default, and a `0` or `false` default
 * is indistinguishable from a measurement. This walks the live responses against the field
 * names the App's models actually declare — the closest a sandbox without an Android SDK comes
 * to compiling both halves together.
 */
interface WireCase {
  url: string
  /** Dotted path into the response, e.g. "tasks" or "diagnostics.git". Empty for the body. */
  pick: string
  model: string
  /** `pick` is a list: every element is compared, not just the first row. */
  list?: boolean
  /** Compared by POSTing this body, for endpoints the App only reaches with a request body. */
  postBody?: Record<string, unknown>
}

/**
 * Objects the App reaches through a parent model. This is read off the Kotlin field types rather
 * than a hand-kept list, because a list is exactly the thing that goes stale: the diagnostics
 * panel's `git`/`log`/`disk`/`memory` rows were declared in `ApiModels.kt` and named in the
 * registry for none of them, so a rename on either side read back as a dash with every gate green.
 */
const KNOWN_MODELS = new Set(appModelNames())

/** The model behind a Kotlin field type, and how the payload wraps it. */
function elementModel(type: string): { model: string; kind: "list" | "map" | "one" } | null {
  const bare = type.replace(/\?$/, "").replace(/\s+/g, "")
  const list = /^(?:Array)?List<(.+)>$/.exec(bare)
  if (list) return KNOWN_MODELS.has(list[1]!) ? { model: list[1]!, kind: "list" } : null
  const map = /^Map<\w+,(.+)>$/.exec(bare)
  if (map) return KNOWN_MODELS.has(map[1]!) ? { model: map[1]!, kind: "map" } : null
  return KNOWN_MODELS.has(bare) ? { model: bare, kind: "one" } : null
}

function pickPath(payload: unknown, pick: string): unknown {
  if (!pick) return payload
  let value: unknown = payload
  for (const segment of pick.split(".")) {
    if (value === null || typeof value !== "object") return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

test("api responses fill every field the App's models decode", async () => {
  // One task stays running while the sweep reads /status, so `activeTask` is a real object
  // instead of a key the JSON encoder quietly drops.
  let release: (() => void) | undefined
  await withApi(
    async (_key, _engine, text) => {
      if (!text.includes("挂起")) return "ok"
      return new Promise<string>((resolve) => {
        release = () => resolve("回复：挂起")
      })
    },
    async (h) => {
      const get = async (url: string): Promise<unknown> => {
        const res = await fetch(`${h.base}/api/v1/${url}`, { headers: authHeaders() })
        assert.equal(res.status, 200, `GET /${url} is not answering, so its fields cannot be compared`)
        return res.json()
      }
      const post = async (url: string, body: unknown): Promise<unknown> => {
        const res = await fetch(`${h.base}/api/v1/${url}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
        assert.ok(res.status >= 200 && res.status < 300, `POST /${url} must accept the same body the App sends (${res.status})`)
        return res.json()
      }

      try {
        // Every case below needs a row, so seed one of each list the App renders
        await post("task", { text: "契约检查" })
        // History and usage are written when a task settles, not when it is accepted
        for (let i = 0; i < 100; i++) {
          const body = (await get("history")) as { history: unknown[] }
          if (body.history?.length) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const submitted = (await post("task", { text: "挂起的契约检查" })) as { task: unknown }
        await post("reminders", { text: "30m 喝水" })
        await post("schedules", { text: "30m 检查服务器" })
        await post("aliases", { name: "review", expansion: "审查当前改动" })
        await post("proxy", { url: "socks5://127.0.0.1:1080", name: "测试代理" })
        // The directory picker has to compare a real row, not an empty listing
        mkdirSync(join(h.dataDir, "contract-sub"), { recursive: true })

        const cases: WireCase[] = [
          { url: "health", pick: "", model: "Health" },
          { url: "session", pick: "", model: "Session" },
          { url: "status", pick: "", model: "Status" },
          { url: "info", pick: "", model: "ServerInfo" },
          // GET /dir answers with the view itself; POST answers with { ok, message, dir }
          { url: "dir", pick: "", model: "DirInfo" },
          { url: "dir/browse", pick: "", model: "DirListing" },
          { url: "usage", pick: "usage", model: "Usage" },
          { url: "usage", pick: "trend", model: "UsageTrendDay", list: true },
          { url: "usage/report", pick: "", model: "DailyReport" },
          { url: "task", pick: "task", model: "Task" },
          { url: "tasks", pick: "tasks", model: "Task", list: true },
          { url: "history", pick: "history", model: "HistoryEntry", list: true },
          { url: "reminders", pick: "reminders", model: "Reminder", list: true },
          { url: "schedules", pick: "schedules", model: "Schedule", list: true },
          { url: "aliases", pick: "aliases", model: "AliasEntry", list: true },
          { url: "proxy", pick: "", model: "ProxyList" },
          { url: "proxy", pick: "proxies", model: "ProxyInfo", list: true },
          { url: "access", pick: "", model: "AccessInfo" },
          { url: "config", pick: "", model: "ConfigView" },
          { url: "help", pick: "", model: "HelpView" },
          { url: "help", pick: "sections", model: "HelpSection", list: true },
          { url: "help", pick: "commands", model: "BotCommand", list: true },
          { url: "agents", pick: "agents", model: "AgentInfo", list: true },
          // POST /agent answers with the new session plus Telegram's note, both decoded here
          { url: "agent", pick: "", model: "EngineSwitch", postBody: { engine: "opencode" } },
          // Both engine kinds answer /models, and their entry shapes differ
          { url: "models", pick: "models", model: "ModelChoices" },
          { url: "models?engine=opencode", pick: "models", model: "ModelChoices" },
          { url: "peers", pick: "peers", model: "Peer", list: true },
          { url: "ops/diag", pick: "diagnostics", model: "Diagnostics" },
          { url: "ops/service", pick: "service", model: "ServiceStatus" },
          { url: "ops/logs?source=bot&lines=20", pick: "", model: "LogTail" },
          { url: "cc", pick: "", model: "CcStatus" },
          { url: "cc/views", pick: "views", model: "CcViewSpec", list: true },
          { url: "cc/exec", pick: "commands", model: "CcExecCommand", list: true },
          { url: "cc/hermes", pick: "", model: "HermesMemory" },
          { url: "cc/hermes", pick: "", model: "HermesResult", postBody: { kind: "memory", action: "enable" } },
          // The raw passthrough answers with the redacted words it ran, which the App shows
          { url: "cc/run", pick: "", model: "CcRunResult", postBody: { args: ["config", "show"] } },
        ]

        const problems: string[] = []
        const compared = new Set<string>()

        const compare = (value: unknown, model: string, label: string, depth = 0): void => {
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            problems.push(`${label}: no object to compare (got ${JSON.stringify(value)})`)
            return
          }
          compared.add(model)
          const fields = appModelShape(model)
          const declared = new Set(fields.map((field) => field.name))
          const sent = Object.keys(value as Record<string, unknown>)
          const dropped = sent.filter((key) => !declared.has(key))
          const silent = fields.filter((field) => field.required && !sent.includes(field.name)).map((field) => field.name)
          if (dropped.length) problems.push(`${model} (${label}): server sends ${dropped.join(", ")} the App never decodes`)
          if (silent.length) problems.push(`${model} (${label}): App requires ${silent.join(", ")} but the server omits it (reads back as zero)`)
          if (depth >= 4) return
          for (const field of fields) {
            const child = (value as Record<string, unknown>)[field.name]
            if (child === undefined || child === null) continue
            const nested = elementModel(field.type)
            if (!nested) continue
            if (nested.kind === "list") {
              if (Array.isArray(child)) {
                child.forEach((row, index) => compare(row, nested.model, `${label}.${field.name}.${index}`, depth + 1))
              }
            } else if (nested.kind === "map") {
              for (const [key, row] of Object.entries(child as Record<string, unknown>)) {
                if (row && typeof row === "object" && !Array.isArray(row)) compare(row, nested.model, `${label}.${field.name}.${key}`, depth + 1)
              }
            } else {
              compare(child, nested.model, `${label}.${field.name}`, depth + 1)
            }
          }
        }

        for (const wire of cases) {
          const payload =
            wire.url === "task" ? submitted : wire.postBody ? await post(wire.url, wire.postBody) : await get(wire.url)
          const value = pickPath(payload, wire.pick)
          if (wire.list) {
            if (!Array.isArray(value) || value.length === 0) {
              problems.push(`${wire.url}#${wire.pick}: expected rows to compare, got ${JSON.stringify(value)}`)
              continue
            }
            value.forEach((row, index) => compare(row, wire.model, `${wire.url}#${wire.pick}.${index}`))
          } else {
            compare(value, wire.model, `${wire.url}#${wire.pick || "(body)"}`)
          }
        }
        assert.ok(compared.size >= 25, `the sweep must compare real models, got ${compared.size}`)
        assert.deepEqual(problems, [], `App models and API payloads disagree:\n${problems.join("\n")}`)
      } finally {
        release?.()
      }
    },
  )
})

test("api daily report aggregates every chat and renders the push text", async () => {
  await withApi(
    async () => "回复",
    async (h) => {
      // Two surfaces the report must merge: a Telegram chat and the App session
      h.usage.record("tg:123", { engine: "opencode", ms: 60_000, outcome: "ok" })
      h.usage.record("tg:123", { engine: "opencode", ms: 30_000, outcome: "failed" })
      h.usage.record("api:app", { engine: "claude", ms: 90_000, outcome: "ok" })

      const res = await fetch(`${h.base}/api/v1/usage/report`, { headers: authHeaders() })
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        day: string
        totals: { tasks: number; ok: number; failed: number }
        byChat: Array<{ key: string; source: string; usage: { tasks: number } }>
        trend: Array<{ tasks: number }>
        text: string
      }
      assert.match(body.day, /^\d{4}-\d{2}-\d{2}$/)
      assert.deepEqual(
        { tasks: body.totals.tasks, ok: body.totals.ok, failed: body.totals.failed },
        { tasks: 3, ok: 2, failed: 1 },
      )
      // Sources are labelled for display; api:app must not leak as a raw key
      const sources = body.byChat.map((row) => `${row.source}:${row.usage.tasks}`).sort()
      assert.deepEqual(sources, ["App:1", "Telegram 123:2"])
      assert.equal(body.trend.length, 7)
      assert.equal(body.trend[6].tasks, 3)
      assert.match(body.text, /每日用量报告/)
      assert.match(body.text, /今日任务：3/)
    },
  )
})

test("api snoozes a pending one-shot reminder by id", async () => {
  await withApi(
    async () => "回复",
    async (h) => {
      const post = async (url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
        const res = await fetch(`${h.base}/api/v1/${url}`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        })
        return { status: res.status, body: (await res.json()) as Record<string, unknown> }
      }

      const created = await post("reminders", { text: "30m 喝水" })
      const reminder = created.body.reminder as { id: number }
      assert.ok(reminder?.id, "the created reminder carries an id")

      const snoozed = await post(`reminders/${reminder.id}/snooze`, { minutes: 45 })
      assert.equal(snoozed.status, 200)
      const updated = snoozed.body.reminder as { id: number; dueAt: number }
      assert.equal(updated.id, reminder.id)
      assert.ok(updated.dueAt > Date.now() + 40 * 60_000, "dueAt moved about 45 minutes out")

      // The list reflects the new time right away
      const list = (await (await fetch(`${h.base}/api/v1/reminders`, { headers: authHeaders() })).json()) as {
        reminders: Array<{ id: number; dueAt: number }>
      }
      assert.equal(list.reminders.find((item) => item.id === reminder.id)?.dueAt, updated.dueAt)

      const unknown = await post("reminders/9999/snooze", { minutes: 10 })
      assert.equal(unknown.status, 400)
      const badMinutes = await post(`reminders/${reminder.id}/snooze`, { minutes: 0 })
      assert.equal(badMinutes.status, 400)
      const repeat = await post("reminders", { text: "every 30m 起身" })
      const repeatReminder = repeat.body.reminder as { id: number }
      const repeatSnooze = await post(`reminders/${repeatReminder.id}/snooze`, { minutes: 10 })
      assert.equal(repeatSnooze.status, 400)
    },
  )
})

test("identity and config endpoints never leak the token or secret values", async () => {
  await withApi(
    async () => "回复",
    async (h) => {
      // 这些端点是最容易被顺手加字段的;一旦有人把凭据塞进载荷,这里立刻红
      for (const url of ["health", "info", "session", "peers", "status", "config", "usage", "usage/report"]) {
        const res = await fetch(`${h.base}/api/v1/${url}`, { headers: authHeaders() })
        assert.equal(res.status, 200, `GET /${url} should answer`)
        const text = await res.text()
        assert.ok(!text.includes(TOKEN), `GET /${url} leaked the API token`)
        // 密钥形态的值（32 字节 base64）也不应出现
        assert.doesNotMatch(text, /["':][A-Za-z0-9+/]{43}=/, `GET /${url} looks like it leaked a base64 secret`)
      }
      // /config 的密钥条目只带 secret 标记,值字段必须缺席
      const config = (await (await fetch(`${h.base}/api/v1/config`, { headers: authHeaders() })).json()) as {
        config?: { entries?: Array<{ key: string; secret?: boolean; value?: string }> }
      }
      for (const entry of config.config?.entries ?? []) {
        if (entry.secret) assert.equal(entry.value, undefined, `secret entry ${entry.key} must not carry a value`)
      }
    },
  )
})

test("the phone-side deployment script passes against this exact wire", async () => {
  // scripts/app-smoke.mjs is what the README tells a user to run before installing the APK,
  // and it reimplements ApiClient.kt's request sequence by hand. Nothing else executes it, so
  // without this test a drifted path, body key or encryption rule would only surface on the
  // phone. Running it against the harness server proves the whole App-visible surface answers
  // over a real socket, pairing token included.
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "app-smoke.mjs")
  await withApi(
    async (_key, _engine, text, onProgress) => {
      if (!text.includes("慢慢想")) return "smoke 回答"
      // The two steps that need a live task: SSE wants frames to arrive, stop wants to catch
      // the task before it settles.
      onProgress?.("第 1 步：读取上下文")
      await new Promise((resolve) => setTimeout(resolve, 500))
      onProgress?.("第 2 步：组织回答")
      await new Promise((resolve) => setTimeout(resolve, 500))
      return "smoke 慢任务回答"
    },
    async (h) => {
      const output = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        // Async on purpose: the server under test runs on this thread, so a synchronous spawn
        // would block it and every step would time out.
        const child = spawn(process.execPath, [script, "--base", h.base, "--token", TOKEN], {
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => (stdout += chunk))
        child.stderr.on("data", (chunk: string) => (stderr += chunk))
        child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }))
      })
      assert.equal(output.status, 0, `app-smoke.mjs failed:\n${output.stdout}\n${output.stderr}`)
      assert.match(output.stdout, /步通过/)
      // The steps that would silently degrade into a warning still have to have run
      assert.match(output.stdout, /收到终态/)
      assert.doesNotMatch(output.stdout, /停止步骤跳过/)
    },
  )
})

test("a bot behind a path-prefixing proxy answers the address the App stores", async () => {
  await withApi(
    async () => "proxy 回答",
    async (h) => {
      // nginx `location /agent-bot/ { proxy_pass http://127.0.0.1:<port>/; }`: the prefix is gone
      // by the time the bot sees the path, which is what makes API_PUBLIC_URL carry a subpath and
      // what /api then prints back as `<public>/api/v1` for the user to paste into the App.
      const proxy: Server = createServer((req, res) => {
        const path = req.url ?? "/"
        if (!path.startsWith("/agent-bot/")) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "代理根路径" }))
          return
        }
        void fetch(h.base + (path.slice("/agent-bot".length) || "/"), {
          headers: { authorization: req.headers.authorization ?? "" },
        })
          .then(async (up) => {
            res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" })
            res.end(Buffer.from(await up.arrayBuffer()))
          })
          .catch(() => {
            res.writeHead(502)
            res.end()
          })
      })
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()))
      const address = proxy.address()
      if (address === null || typeof address === "string") throw new Error("proxy did not bind a TCP port")
      try {
        const pairing = `http://127.0.0.1:${address.port}/agent-bot`
        const stored = normalizeAppBaseUrl(`${pairing}/api/v1`)
        assert.equal(stored, pairing, "the printed endpoint must normalize back to the pairing URL")
        const answered = await fetch(appRequestUrl(stored, "/health"), { headers: authHeaders() })
        assert.equal(answered.status, 200, await answered.text())
        // The two ways this deployment used to break: stripping to the origin lands on the
        // proxy's root, and keeping the printed suffix doubles the API prefix.
        const origin = await fetch(appRequestUrl(`http://127.0.0.1:${address.port}`, "/health"), {
          headers: authHeaders(),
        })
        assert.equal(origin.status, 404, "dropping the subpath must not reach the bot")
        const doubled = await fetch(appRequestUrl(`${pairing}/api/v1`, "/health"), { headers: authHeaders() })
        assert.equal(doubled.status, 404, "the pasted suffix has to be stripped")
      } finally {
        await new Promise<void>((resolve) => {
          proxy.close(() => resolve())
        })
      }
    },
  )
})

test("api aliases rejects an invalid name with the store's guidance", async () => {
  await withApi(
    async () => "回复",
    async (h) => {
      const res = await fetch(`${h.base}/api/v1/aliases`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "含 空格", expansion: "审查代码" }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error?: string }
      assert.match(body.error ?? "", /快捷指令名/)
    },
  )
})

test("POST /new and /model refuse to run while a task is active", async () => {
  let release: (() => void) | undefined
  await withApi(
    async (_key, _engine, text) => {
      if (!text.includes("挂起")) return "ok"
      return new Promise<string>((resolve) => {
        release = () => resolve("回复：挂起")
      })
    },
    async (h) => {
      const submitted = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "挂起的任务" }),
      })
      assert.equal(submitted.status, 202)
      try {
        for (const [method, url, body] of [
          ["POST", "new", undefined],
          ["POST", "model", JSON.stringify({ model: "custom/base" })],
        ] as const) {
          const res = await fetch(`${h.base}/api/v1/${url}`, {
            method,
            headers: authHeaders(),
            body: body ?? undefined,
          })
          assert.equal(res.status, 409, `${method} ${url} must refuse while a task is active`)
          const payload = (await res.json()) as { error?: string }
          assert.match(payload.error ?? "", /任务执行中/)
        }
      } finally {
        release?.()
      }
    },
  )
})

test("ops update, restart, rollback and cancel-pending refuse to run while a task is active", async () => {
  let release: (() => void) | undefined
  await withApi(
    async (_key, _engine, text) => {
      if (!text.includes("挂起运维")) return "ok"
      return new Promise<string>((resolve) => {
        release = () => resolve("回复：挂起运维")
      })
    },
    async (h) => {
      const submitted = await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "挂起运维任务" }),
      })
      assert.equal(submitted.status, 202)
      try {
        for (const action of ["update", "restart", "rollback", "cancel-pending"]) {
          const res = await fetch(`${h.base}/api/v1/ops/${action}`, { method: "POST", headers: authHeaders() })
          assert.equal(res.status, 409, `POST /ops/${action} must refuse while a task is active`)
          const payload = (await res.json()) as { error?: string }
          assert.match(payload.error ?? "", /任务正在执行/)
        }
        assert.deepEqual(h.releaseActions, [], "a refused ops action must not mutate release state")
      } finally {
        release?.()
      }
    },
  )
})

test("api export returns json and markdown history documents", async () => {
  await withApi(
    async () => "回复",
    async (h) => {
      await fetch(`${h.base}/api/v1/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: "导出源任务" }),
      })
      for (let i = 0; i < 100; i++) {
        const body = (await (await fetch(`${h.base}/api/v1/history?limit=5`, { headers: authHeaders() })).json()) as {
          history: unknown[]
        }
        if (body.history?.length) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      const jsonRes = await fetch(`${h.base}/api/v1/export?format=json`, { headers: authHeaders() })
      assert.equal(jsonRes.status, 200)
      assert.equal(jsonRes.headers.get("content-type"), "application/json; charset=utf-8")
      assert.match(jsonRes.headers.get("content-disposition") ?? "", /\.json/)
      const payload = JSON.parse(await jsonRes.text()) as { key: string; entries: Array<{ prompt: string }> }
      assert.ok(payload.entries.length >= 1)
      assert.ok(!payload.key.includes("secret"))

      const mdRes = await fetch(`${h.base}/api/v1/export`, { headers: authHeaders() })
      assert.equal(mdRes.status, 200)
      assert.match(mdRes.headers.get("content-type") ?? "", /markdown/)
      const md = await mdRes.text()
      assert.match(md, /# Agent Bot 任务历史/)
      assert.match(md, /导出源任务/)

      const bad = await fetch(`${h.base}/api/v1/export?format=xml`, { headers: authHeaders() })
      assert.equal(bad.status, 400)
    },
  )
})
