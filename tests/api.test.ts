import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ApiServer, resolveApiToken } from "../src/api.js"
import { AgentCliRegistry } from "../src/agentCli.js"
import type { AgentCliInstaller } from "../src/agentInstaller.js"
import type { BotConfig } from "../src/config.js"
import { TaskHistoryStore } from "../src/history.js"
import type { Logger } from "../src/logger.js"
import { ModelAdmin } from "../src/modelAdmin.js"
import { ProxyService } from "../src/proxy.js"
import { AliasStore } from "../src/aliases.js"
import { Opencode } from "../src/opencode.js"
import type { OpsService } from "../src/ops.js"
import { CcSwitchError, type CcSwitchService } from "../src/ccswitch.js"
import { ReminderService } from "../src/reminders.js"
import { ScheduleService } from "../src/scheduler.js"
import { SessionStore } from "../src/store.js"
import type { AgentCliService } from "../src/agentCli.js"
import type { UsageOutcome, UsageStore } from "../src/usage.js"

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
}

async function withApi(
  promptImpl: (key: string, engine: string, text: string, onProgress?: (s: string) => void, signal?: AbortSignal) => Promise<string>,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-bot-api-"))
  const store = new SessionStore(join(dir, "sessions.json"), log)
  const usage = {
    record(_key: string, _input: { engine: string; model?: string; ms: number; outcome: UsageOutcome }): void {},
    summary(key: string) {
      return { total: 0, ok: 0, failed: 0, cancelled: 0, avgMs: 0, engines: {}, today: { total: 0, ok: 0, failed: 0, cancelled: 0, avgMs: 0 } } as never
    },
    recentDays: () => [],
  } as unknown as UsageStore
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
    workDir: () => dir,
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
  const ops = {
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
    updateProject: async () => ({
      ok: false,
      message: "工作区有未提交的改动，已中止更新。",
      steps: [{ label: "检查工作区", ok: true, code: 0, output: " M src/api.ts" }],
    }),
    restartBot: async () => ({ ok: true, message: "已触发重启。", steps: [] }),
    startOpencode: async () => ({ ok: true, message: "OpenCode 已启动。", steps: [] }),
    stopOpencode: async () => ({ ok: true, message: "OpenCode 已停止。", steps: [] }),
    restartOpencode: async () => ({ ok: true, message: "OpenCode 已重启。", steps: [] }),
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
      ccCalls.push(`provider:new:${draft.name}:${draft.template ?? ""}`)
      const key = draft.apiKey ?? ""
      const stdout = key ? `created ${draft.name} with ${key}` : `created ${draft.name}`
      return { code: 0, stdout, stderr: "" }
    },
    run: async (args: string[]) => {
      ccCalls.push(`run:${args.join(" ")}`)
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
      ccswitch,
      fetchMedia: async (target: string) => Buffer.from(`remote:${target}`),
      ownerChatId: 42,
    },
    TOKEN,
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
    })
  } finally {
    await api.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

function authHeaders(token = TOKEN): Record<string, string> {
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

test("api switch engine, reset session and list models", async () => {
  await withApi(async () => "ok", async (h) => {
    const switched = await fetch(`${h.base}/api/v1/agent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ engine: "claude" }),
    })
    assert.equal(switched.status, 200)
    const session = (await switched.json()) as { session: { engine: string; engineLabel: string } }
    assert.equal(session.session.engine, "claude")

    // CLI sessions reset through /new
    h.store.setCliSession("api:app", "claude", "sess-1")
    const reset = await fetch(`${h.base}/api/v1/new`, { method: "POST", headers: authHeaders() })
    assert.equal(reset.status, 200)
    assert.equal(h.store.getCliSession("api:app", "claude"), undefined)

    const models = await fetch(`${h.base}/api/v1/models`, { headers: authHeaders() })
    const body = (await models.json()) as { models: { models: Array<{ id?: string; label: string }> } }
    assert.ok(body.models.models.length > 0)

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

    // claude is on PATH in the test environment, so install is refused
    const already = await fetch(`${h.base}/api/v1/agents/claude/install`, { method: "POST", headers: authHeaders() })
    assert.equal(already.status, 409)

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
    // The app renders "已显示 N / 共 M 条" from this, like Telegram's /history.
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
  })
})

test("api serves the shared help copy as plain text", async () => {
  await withApi(async () => "ok", async (h) => {
    const res = await fetch(`${h.base}/api/v1/help`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { sections: Array<{ id: string; title: string; text: string }> }
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

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64")
}

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
