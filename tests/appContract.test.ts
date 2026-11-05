import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { decryptPayload, encryptPayload } from "../src/apiCrypto.js"
import { appModelNames, appModelShape } from "./support/appModels.js"
import { authHeaders, withApi } from "./api.test.js"

/**
 * `npm run check` compiles the App but never speaks to the bot, and appParity only pairs four
 * models against the server. Every other response was unchecked: `ignoreUnknownKeys` turns a
 * renamed field into a silent default value, and a field the Kotlin model cannot fall back on
 * throws inside `decodeFromJsonElement` — a crash on the phone no compiler here can see.
 * This boots the real ApiServer, sends the bodies ApiClient.kt sends, and decodes the answers
 * the way the App's models declare them.
 */

type Kind = "string" | "number" | "boolean" | "array" | "object"

const PRIMITIVES: Record<string, Kind> = {
  String: "string",
  Int: "number",
  Long: "number",
  Short: "number",
  Double: "number",
  Float: "number",
  Boolean: "boolean",
}

const MODEL_NAMES = new Set(appModelNames())

/** The JSON kind kotlinx demands for a Kotlin type, or null when it accepts anything. */
function expectedKind(type: string): Kind | null {
  const bare = type.replace(/\?$/, "").replace(/\s+/g, "")
  if (PRIMITIVES[bare]) return PRIMITIVES[bare]
  if (/^(?:Array)?List</.test(bare)) return "array"
  if (bare.startsWith("Map<")) return "object"
  if (MODEL_NAMES.has(bare)) return "object"
  return null
}

/** The element type of a `List<T>`, or the value type of a `Map<K, T>`. */
function innerType(type: string): string | null {
  const bare = type.replace(/\?$/, "").replace(/\s+/g, "")
  const list = /^(?:Array)?List<(.+)>$/.exec(bare)
  if (list) return list[1]!
  const map = /^Map<\w+,(.+)>$/.exec(bare)
  return map ? map[1]! : null
}

function modelName(type: string): string | null {
  const bare = type.replace(/\?$/, "").replace(/\s+/g, "")
  return MODEL_NAMES.has(bare) ? bare : null
}

function kindOf(value: unknown): Kind | "null" {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "object") return "object"
  if (typeof value === "string") return "string"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "null"
}

/** A `T?` field tolerates a null or an absent key; a field without a default tolerates neither. */
function walk(model: string, value: unknown, where: string, problems: string[], depth = 0): void {
  if (depth > 5) return
  if (kindOf(value) !== "object") {
    problems.push(`${where}: ${model} expects a JSON object, got ${kindOf(value)}`)
    return
  }
  const record = value as Record<string, unknown>
  for (const field of appModelShape(model)) {
    const site = `${where}.${field.name}`
    const got = record[field.name]
    if (got === undefined || got === null) {
      if (!field.required || field.type.endsWith("?")) continue
      problems.push(`${site}: missing (${field.type} has no default in ${model}, the App throws on it)`)
      continue
    }
    const want = expectedKind(field.type)
    if (want && kindOf(got) !== want) {
      problems.push(`${site}: wrong type (${field.type} needs ${want}, the server sent ${kindOf(got)})`)
      continue
    }
    const nested = modelName(field.type)
    if (nested) {
      walk(nested, got, site, problems, depth + 1)
      continue
    }
    const inner = innerType(field.type)
    if (!inner || !want) continue
    const innerModel = modelName(inner)
    if (innerModel) {
      if (want === "array") {
        ;(got as unknown[]).forEach((item, index) => walk(innerModel, item, `${site}[${index}]`, problems, depth + 1))
      } else {
        for (const [key, item] of Object.entries(got as Record<string, unknown>)) {
          walk(innerModel, item, `${site}[${key}]`, problems, depth + 1)
        }
      }
      continue
    }
    const innerKind = expectedKind(inner)
    if (!innerKind) continue
    if (want === "array") {
      ;(got as unknown[]).forEach((item, index) => {
        if (kindOf(item) !== innerKind) problems.push(`${site}[${index}]: needs ${inner}, got ${kindOf(item)}`)
      })
    } else {
      for (const [key, item] of Object.entries(got as Record<string, unknown>)) {
        if (kindOf(item) !== innerKind) problems.push(`${site}.${key}: needs ${inner}, got ${kindOf(item)}`)
      }
    }
  }
}

interface Probe {
  /** ApiClient method + server path, so a failure names both sides. */
  name: string
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: string
  body?: Record<string, unknown>
  /** Kotlin model the App decodes; omit for endpoints whose payload the App reads as text. */
  model?: string
  /** Where the model sits: omitted for the whole body, "task", "tasks[]", … */
  at?: string
  /** The App reads the raw bytes/text, so only the status and a non-empty body are checked. */
  raw?: boolean
}

function pick(body: Record<string, unknown>, at: string | undefined): { value: unknown; list: boolean } {
  const key = at ?? ""
  if (!key) return { value: body, list: false }
  if (key.endsWith("[]")) {
    const raw = body[key.slice(0, -2)]
    return { value: Array.isArray(raw) ? raw : undefined, list: true }
  }
  return { value: body[key], list: false }
}

/** ApiClient.encryptionSkipped: SSE, media bytes, export and backup never carry the x-enc header. */
function skipEncryption(path: string): boolean {
  const segments = path.split("?")[0]!.split("/")
  return (
    segments.includes("events") ||
    segments.includes("media") ||
    segments.includes("export") ||
    segments[segments.length - 1] === "backup"
  )
}

const ENC_KEY = Buffer.alloc(32, 9)

/**
 * The App pairs with `x-enc: v1` on every JSON call once the QR carried a key. Running the whole
 * contract twice — plaintext and encrypted — catches an endpoint that reads the ciphertext as JSON
 * and answers 400, and one that replies to a paired App in the clear.
 */
async function runContract(encKey?: Buffer): Promise<string[]> {
  const problems: string[] = []
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await withApi(
    async (_key, _engine, text) => {
      // A task the driver can watch run: /queue, the SSE stream and /stop all need one.
      if (text.includes("慢任务")) {
        await held
        return "慢任务完成"
      }
      if (text.includes("媒体")) return `带附件的回复 [[image: https://example.com/probe.png]]`
      return `桩回复：${text.slice(0, 30)}`
    },
    async (h) => {
      const call = async (probe: Probe): Promise<Record<string, unknown> | undefined> => {
        const paired = encKey !== undefined && !skipEncryption(probe.path)
        const init: RequestInit = {
          method: probe.method,
          headers: paired ? { ...authHeaders(), "x-enc": "v1" } : authHeaders(),
        }
        if (probe.body) {
          const json = JSON.stringify(probe.body)
          init.body = paired ? encryptPayload(encKey!, json) : json
        } else if (probe.method !== "GET") init.body = ""
        const res = await fetch(`${h.base}/api/v1${probe.path}`, init)
        let text = await res.text()
        if (paired) {
          if (res.headers.get("x-enc") === "v1") text = decryptPayload(encKey!, text)
          else if (!probe.raw) problems.push(`${probe.name}: a paired App asked for encryption, the answer came back in plaintext`)
        }
        if (probe.raw) {
          if (res.status >= 300) problems.push(`${probe.name}: status ${res.status} (${text.slice(0, 160)})`)
          else if (!text) problems.push(`${probe.name}: empty response body`)
          return undefined
        }
        let body: Record<string, unknown>
        try {
          body = JSON.parse(text) as Record<string, unknown>
        } catch {
          problems.push(`${probe.name}: answered ${res.status} with non-JSON (${text.slice(0, 160)})`)
          return undefined
        }
        if (res.status >= 300) {
          problems.push(`${probe.name}: status ${res.status} (${String(body.error ?? text.slice(0, 160))})`)
          return body
        }
        if (!probe.model) return body
        const { value, list } = pick(body, probe.at)
        if (value === undefined) {
          problems.push(`${probe.name}: no "${probe.at ?? "<body>"}" in the response, which ${probe.model} decodes`)
        } else if (list) {
          if (!Array.isArray(value)) problems.push(`${probe.name}: "${probe.at}" is not an array`)
          else if (value.length === 0) problems.push(`${probe.name}: "${probe.at}" is empty, so ${probe.model} went unchecked`)
          else value.forEach((item, index) => walk(probe.model!, item, `${probe.name} → ${probe.at}${index}`, problems))
        } else {
          walk(probe.model!, value, `${probe.name} → ${probe.model}`, problems)
        }
        return body
      }

      const view = (body: Record<string, unknown> | undefined, what: string): Record<string, unknown> => {
        const found = body?.[what]
        assert.ok(found && typeof found === "object", `${what} missing from ${JSON.stringify(body)?.slice(0, 200)}`)
        return found as Record<string, unknown>
      }

      /** Waits for a submitted task to settle so its reply, media and history rows exist. */
      const settle = async (id: string): Promise<Record<string, unknown>> => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const body = await call({ name: `task ${id} → GET /task/:id`, method: "GET", path: `/task/${id}`, model: "Task", at: "task" })
          const task = view(body ?? {}, "task")
          if (task.status !== "queued" && task.status !== "running") return task
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error(`task ${id} never settled`)
      }

      // An agent file the server's own agent directory can find, for /models/assign.
      const agentDir = join(h.dataDir, ".opencode", "agent")
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(join(agentDir, "probe.md"), "---\nmodel: probe/model\n---\n探针 agent\n")

      // ---- chat: the path the App's own bubbles take ----
      const submitted = await call({
        name: "submitTask → POST /task",
        method: "POST",
        path: "/task",
        body: { text: "探针任务", engine: "claude" },
        model: "Task",
        at: "task",
      })
      const firstId = String(view(submitted ?? {}, "task").id)
      const mediaBody = await call({
        name: "submitTask(media) → POST /task",
        method: "POST",
        path: "/task",
        body: { text: "带媒体的任务" },
        model: "Task",
        at: "task",
      })
      const mediaId = String(view(mediaBody ?? {}, "task").id)
      const heldBody = await call({
        name: "submitTask(running) → POST /task",
        method: "POST",
        path: "/task",
        body: { text: "慢任务" },
        model: "Task",
        at: "task",
      })
      const heldId = String(view(heldBody ?? {}, "task").id)

      // GET /task/:id/events really streams while the task runs: the App reads `data:` frames.
      const sse = await fetch(`${h.base}/api/v1/task/${heldId}/events`, { headers: authHeaders() })
      if (sse.status !== 200) problems.push(`streamTask → GET /task/:id/events: status ${sse.status}`)
      const firstFrame = await (async (): Promise<string | null> => {
        if (!sse.body) return null
        const reader = sse.body.getReader()
        const decoder = new TextDecoder()
        let buffered = ""
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const { value, done } = await reader.read()
          if (done) break
          buffered += decoder.decode(value, { stream: true })
          const frame = buffered.split("\n").find((line) => line.startsWith("data: "))
          if (frame) {
            await reader.cancel()
            return frame
          }
        }
        return null
      })()
      if (!firstFrame) problems.push("streamTask → GET /task/:id/events: no `data:` frame within 5s")
      else {
        try {
          walk("Task", view(JSON.parse(firstFrame.slice(6)) as Record<string, unknown>, "task"), "streamTask → events task", problems)
        } catch (error) {
          problems.push(`streamTask → GET /task/:id/events: bad frame (${String(error).slice(0, 160)})`)
        }
      }

      await call({ name: "queue → GET /queue", method: "GET", path: "/queue", model: "Task", at: "tasks[]" })
      await call({ name: "status(running) → GET /status", method: "GET", path: "/status", model: "Status" })
      await call({ name: "stopTask → POST /task/:id/stop", method: "POST", path: `/task/${heldId}/stop`, model: "Task", at: "task" })
      release()
      await settle(firstId)
      const settledMedia = await settle(mediaId)
      if (!Array.isArray(settledMedia.media) || settledMedia.media.length === 0) {
        problems.push("taskMedia → GET /task/:id: a reply with a media directive produced no media[] to decode")
      } else {
        await call({ name: "taskMedia → GET /task/:id/media/0", method: "GET", path: `/task/${mediaId}/media/0`, raw: true })
      }
      await call({ name: "retryTask → POST /task/:id/retry", method: "POST", path: `/task/${firstId}/retry`, model: "Task", at: "task" })
      await call({ name: "stopTasks → POST /stop", method: "POST", path: "/stop" })
      await call({ name: "clearQueue → POST /queue/clear", method: "POST", path: "/queue/clear" })

      // ---- rows the list endpoints need before they can be decoded ----
      await call({ name: "addReminder → POST /reminders", method: "POST", path: "/reminders", body: { text: "每天 09:00 喝水" }, model: "Reminder", at: "reminder" })
      const oneOff = await call({
        name: "addReminder(one-off) → POST /reminders",
        method: "POST",
        path: "/reminders",
        body: { text: "5分钟后 休息" },
        model: "Reminder",
        at: "reminder",
      })
      // Only a pending one-shot can be postponed, so this needs the id the server just made.
      const oneOffId = String(view(oneOff ?? {}, "reminder").id)
      await call({
        name: "snoozeReminder → POST /reminders/:id/snooze",
        method: "POST",
        path: `/reminders/${oneOffId}/snooze`,
        body: { minutes: 30 },
        model: "Reminder",
        at: "reminder",
      })
      const scheduleBody = await call({
        name: "addSchedule → POST /schedules",
        method: "POST",
        path: "/schedules",
        body: { text: "每天 08:00 跑一下检查" },
        model: "Schedule",
        at: "schedule",
      })
      const scheduleId = String(view(scheduleBody ?? {}, "schedule").id)
      await call({ name: "addAlias → POST /aliases", method: "POST", path: "/aliases", body: { name: "probe", expansion: "timezone" } })

      // ---- everything the screens read on open ----
      const statics: Probe[] = [
        { name: "health → GET /health", method: "GET", path: "/health", model: "Health" },
        { name: "session → GET /session", method: "GET", path: "/session", model: "Session" },
        { name: "status → GET /status", method: "GET", path: "/status", model: "Status" },
        { name: "info → GET /info", method: "GET", path: "/info", model: "ServerInfo" },
        { name: "help → GET /help", method: "GET", path: "/help", model: "HelpView" },
        { name: "peers → GET /peers", method: "GET", path: "/peers", model: "Peer", at: "peers[]" },
        { name: "dir → GET /dir", method: "GET", path: "/dir", model: "DirInfo" },
        { name: "dirBrowse → GET /dir/browse", method: "GET", path: "/dir/browse", model: "DirListing" },
        { name: "timezone → GET /timezone", method: "GET", path: "/timezone" },
        { name: "agents → GET /agents", method: "GET", path: "/agents", model: "AgentInfo", at: "agents[]" },
        { name: "models → GET /models", method: "GET", path: "/models", model: "ModelChoices", at: "models" },
        { name: "access → GET /access", method: "GET", path: "/access", model: "AccessInfo" },
        { name: "aliases → GET /aliases", method: "GET", path: "/aliases", model: "AliasEntry", at: "aliases[]" },
        { name: "proxies → GET /proxy", method: "GET", path: "/proxy", model: "ProxyList" },
        { name: "diagnostics → GET /ops/diag", method: "GET", path: "/ops/diag", model: "Diagnostics", at: "diagnostics" },
        { name: "opsService → GET /ops/service", method: "GET", path: "/ops/service", model: "ServiceStatus", at: "service" },
        { name: "logs → GET /ops/logs", method: "GET", path: "/ops/logs?source=bot&lines=50", model: "LogTail" },
        { name: "customModels → GET /models/custom", method: "GET", path: "/models/custom", model: "CustomModels" },
        { name: "config → GET /config", method: "GET", path: "/config", model: "ConfigView" },
        { name: "usage → GET /usage", method: "GET", path: "/usage", model: "Usage", at: "usage" },
        { name: "usage trend → GET /usage", method: "GET", path: "/usage", model: "UsageTrendDay", at: "trend[]" },
        { name: "usageReport → GET /usage/report", method: "GET", path: "/usage/report", model: "DailyReport" },
        { name: "reminders → GET /reminders", method: "GET", path: "/reminders", model: "Reminder", at: "reminders[]" },
        { name: "schedules → GET /schedules", method: "GET", path: "/schedules", model: "Schedule", at: "schedules[]" },
        { name: "history → GET /history", method: "GET", path: "/history?limit=20", model: "HistoryEntry", at: "history[]" },
        { name: "tasks → GET /tasks", method: "GET", path: "/tasks?limit=20", model: "Task", at: "tasks[]" },
        { name: "ccStatus → GET /cc", method: "GET", path: "/cc", model: "CcStatus" },
        { name: "ccViews → GET /cc/views", method: "GET", path: "/cc/views", model: "CcViewSpec", at: "views[]" },
        { name: "ccExecCommands → GET /cc/exec", method: "GET", path: "/cc/exec", model: "CcExecCommand", at: "commands[]" },
        { name: "ccProviderMeta → GET /cc/providers", method: "GET", path: "/cc/providers", model: "CcProviderMeta" },
        { name: "ccMcp → GET /cc/mcp", method: "GET", path: "/cc/mcp" },
        { name: "ccPrompts → GET /cc/prompts", method: "GET", path: "/cc/prompts" },
        { name: "ccProxy → GET /cc/proxy", method: "GET", path: "/cc/proxy" },
        { name: "hermes → GET /cc/hermes", method: "GET", path: "/cc/hermes", model: "HermesMemory" },
        { name: "ccSessionsSearch → GET /cc/sessions", method: "GET", path: "/cc/sessions?q=abc", model: "CcText" },
        { name: "ccEnv check → GET /cc/env", method: "GET", path: "/cc/env?mode=check", model: "CcText" },
        { name: "ccEnv tools → GET /cc/env", method: "GET", path: "/cc/env?mode=tools", model: "CcText" },
        { name: "ccStream → GET /cc/stream", method: "GET", path: "/cc/stream?id=p1", model: "CcText" },
        { name: "ccProviderModels → GET /cc/models", method: "GET", path: "/cc/models?id=p1", model: "CcText" },
        { name: "ccQuota → GET /cc/quota", method: "GET", path: "/cc/quota?id=p1", model: "CcText" },
        { name: "checkUpdate → GET /ops/check-update", method: "GET", path: "/ops/check-update", model: "OpsResult", at: "result" },
        { name: "exportHistory → GET /export", method: "GET", path: "/export?format=markdown", raw: true },
        { name: "backupData → GET /ops/backup", method: "GET", path: "/ops/backup", raw: true },
      ]
      for (const probe of statics) await call(probe)

      // ---- the actions the buttons trigger ----
      const mutations: Probe[] = [
        { name: "setTimezone → POST /timezone", method: "POST", path: "/timezone", body: { timezone: "Europe/Berlin" } },
        { name: "setDir → POST /dir", method: "POST", path: "/dir", body: { dir: h.dataDir }, model: "DirInfo", at: "dir" },
        { name: "resetDir → POST /dir", method: "POST", path: "/dir", body: { reset: true }, model: "DirInfo", at: "dir" },
        { name: "switchAgent → POST /agent", method: "POST", path: "/agent", body: { engine: "codex" }, model: "EngineSwitch" },
        { name: "setModel → POST /model", method: "POST", path: "/model", body: { model: "default" } },
        { name: "setModel(pin) → POST /model", method: "POST", path: "/model", body: { model: "claude-sonnet-4-5" } },
        { name: "addAccess → POST /access", method: "POST", path: "/access", body: { id: "7" }, model: "AccessResult" },
        { name: "removeAccess → DELETE /access/7", method: "DELETE", path: "/access/7", model: "AccessResult" },
        { name: "deleteAlias → DELETE /aliases/probe", method: "DELETE", path: "/aliases/probe" },
        {
          name: "addProxy → POST /proxy",
          method: "POST",
          path: "/proxy",
          body: { url: "http://127.0.0.1:7890", name: "探针" },
          model: "ProxyActionResult",
        },
        { name: "useProxy → POST /proxy/1/use", method: "POST", path: "/proxy/1/use", model: "ProxyActionResult" },
        { name: "testProxy → POST /proxy/1/test", method: "POST", path: "/proxy/1/test", model: "ProxyTestResult" },
        { name: "disableProxy → POST /proxy/off", method: "POST", path: "/proxy/off" },
        { name: "removeProxy → DELETE /proxy/1", method: "DELETE", path: "/proxy/1" },
        {
          name: "addCustomModel → POST /models/custom",
          method: "POST",
          path: "/models/custom",
          body: { key: "probek", providerID: "probe", modelID: "probe-model", label: "探针", attachment: true, contextWindow: 200_000 },
          model: "CustomModelResult",
        },
        {
          name: "assignAgent → POST /models/assign",
          method: "POST",
          path: "/models/assign",
          body: { agent: "probe", model: "probek" },
          model: "AgentAssignment",
        },
        { name: "removeCustomModel → DELETE /models/custom/:key", method: "DELETE", path: "/models/custom/probek?force=1" },
        { name: "runOps check → POST /ops/check", method: "POST", path: "/ops/check", model: "OpsResult", at: "result" },
        { name: "runOps restart → POST /ops/restart", method: "POST", path: "/ops/restart", model: "OpsResult", at: "result" },
        { name: "runOps service/start → POST /ops/service/start", method: "POST", path: "/ops/service/start", model: "OpsResult", at: "result" },
        { name: "setConfig → PUT /config/LOG_LEVEL", method: "PUT", path: "/config/LOG_LEVEL", body: { value: "info" }, model: "ConfigResult" },
        { name: "unsetConfig → DELETE /config/LOG_LEVEL", method: "DELETE", path: "/config/LOG_LEVEL", model: "ConfigResult" },
        { name: "pauseSchedule → POST /schedules/:id/pause", method: "POST", path: `/schedules/${scheduleId}/pause`, model: "Schedule", at: "schedule" },
        { name: "resumeSchedule → POST /schedules/:id/resume", method: "POST", path: `/schedules/${scheduleId}/resume`, model: "Schedule", at: "schedule" },
        { name: "runSchedule → POST /schedules/:id/run", method: "POST", path: `/schedules/${scheduleId}/run`, model: "Schedule", at: "schedule" },
        { name: "deleteSchedule → DELETE /schedules/:id", method: "DELETE", path: `/schedules/${scheduleId}` },
        { name: "clearHistory → DELETE /history", method: "DELETE", path: "/history" },
        { name: "newSession → POST /new", method: "POST", path: "/new" },
        { name: "followPeer → POST /peers/follow", method: "POST", path: "/peers/follow", body: { scope: "telegram" } },
        { name: "ccUse → POST /cc/use", method: "POST", path: "/cc/use", body: { id: "p1" }, model: "CcActionResult" },
        { name: "ccTest → POST /cc/test", method: "POST", path: "/cc/test", body: { id: "p1" }, model: "CcTestResult" },
        { name: "ccTest(current) → POST /cc/test", method: "POST", path: "/cc/test", body: {}, model: "CcTestResult" },
        { name: "ccSyncMcp → POST /cc/mcp/sync", method: "POST", path: "/cc/mcp/sync", model: "CcActionResult" },
        {
          name: "ccImportMcp → POST /cc/mcp/import",
          method: "POST",
          path: "/cc/mcp/import",
          body: { json: '{"mcpServers":{"probe":{"command":"npx"}}}' },
          model: "CcActionResult",
        },
        { name: "ccActivatePrompt → POST /cc/prompts/activate", method: "POST", path: "/cc/prompts/activate", body: { id: "probe" }, model: "CcActionResult" },
        { name: "ccDeactivatePrompt → POST /cc/prompts/deactivate", method: "POST", path: "/cc/prompts/deactivate", model: "CcActionResult" },
        {
          name: "ccCreatePrompt → POST /cc/prompts/create",
          method: "POST",
          path: "/cc/prompts/create",
          body: { name: "probe", content: "hello" },
          model: "CcActionResult",
        },
        {
          name: "ccAddProvider → POST /cc/providers",
          method: "POST",
          path: "/cc/providers",
          body: { name: "probe", template: "custom", baseUrl: "https://probe.example", apiKey: "sk-probe" },
          model: "CcActionResult",
        },
        {
          name: "ccDeeplink → POST /cc/deeplink",
          method: "POST",
          path: "/cc/deeplink",
          body: { url: "ccswitch://v1/import?type=provider&name=probe", confirm: true },
          model: "CcActionResult",
        },
        {
          name: "hermesAction set → POST /cc/hermes",
          method: "POST",
          path: "/cc/hermes",
          body: { kind: "memory", action: "set", content: "探针记忆", confirm: true },
          model: "HermesResult",
        },
        {
          name: "hermesAction enable → POST /cc/hermes",
          method: "POST",
          path: "/cc/hermes",
          body: { kind: "user", action: "enable" },
          model: "HermesResult",
        },
        { name: "ccRun → POST /cc/run", method: "POST", path: "/cc/run", body: { args: ["--version"], confirm: true }, model: "CcRunResult" },
      ]
      for (const probe of mutations) await call(probe)

      // The App decides to show its confirmation dialog by matching the server's wording, so
      // that handshake is checked here rather than trusted from a comment.
      const needsConfirm = await fetch(`${h.base}/api/v1/cc/run`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ args: ["provider", "delete", "p9"] }),
      })
      assert.equal(needsConfirm.status, 400)
      assert.match(String(((await needsConfirm.json()) as { error?: string }).error ?? ""), /需要确认/)

      // Names the server owns: /cc/exec and /cc/view only accept what these listings report.
      const listed = await call({ name: "reminders → GET /reminders", method: "GET", path: "/reminders", model: "Reminder", at: "reminders[]" })
      for (const row of (listed?.reminders ?? []) as Array<Record<string, unknown>>) {
        await call({ name: "deleteReminder → DELETE /reminders/:id", method: "DELETE", path: `/reminders/${row.id}` })
      }
      const execList = await call({ name: "ccExecCommands → GET /cc/exec", method: "GET", path: "/cc/exec", model: "CcExecCommand", at: "commands[]" })
      const commands = (execList?.commands ?? []) as Array<Record<string, unknown>>
      const execPick = commands.find((command) => !command.needsTarget && !command.confirm) ?? commands[0]
      if (!execPick) problems.push("ccExecCommands → GET /cc/exec answered no commands at all")
      else {
        await call({
          name: "ccExec → POST /cc/exec",
          method: "POST",
          path: "/cc/exec",
          body: { name: String(execPick.name), ...(execPick.confirm ? { confirm: true } : {}) },
          model: "CcExecResult",
        })
      }
      const views = await call({ name: "ccViews → GET /cc/views", method: "GET", path: "/cc/views", model: "CcViewSpec", at: "views[]" })
      const viewList = (views?.views ?? []) as Array<Record<string, unknown>>
      const viewPick = viewList.find((entry) => !entry.needsTarget) ?? viewList[0]
      if (!viewPick) problems.push("ccViews → GET /cc/views answered no views at all")
      else await call({ name: "ccView → GET /cc/view", method: "GET", path: `/cc/view?name=${encodeURIComponent(String(viewPick.name))}` })

      // Installing a CLI the server does not have yet is the only install this sandbox can do.
      const agentList = await call({ name: "agents → GET /agents", method: "GET", path: "/agents", model: "AgentInfo", at: "agents[]" })
      const agents = (agentList?.agents ?? []) as Array<Record<string, unknown>>
      const installable = agents.find((agent) => agent.installable && !agent.installed)
      if (installable) {
        await call({ name: "agentAction install", method: "POST", path: `/agents/${installable.id}/install`, model: "AgentActionResult" })
        await call({ name: "agentAction uninstall", method: "POST", path: `/agents/${installable.id}/uninstall`, model: "AgentActionResult" })
      } else {
        const updatable = agents.find((agent) => agent.updateable && agent.installed)
        if (updatable) await call({ name: "agentAction update", method: "POST", path: `/agents/${updatable.id}/update`, model: "AgentActionResult" })
        else problems.push("agents → GET /agents offered nothing installable, so /agents/:engine/:action went unchecked")
      }
    },
    encKey,
  )
  release()
  return problems
}

test("every App endpoint answers with the shape the App decodes", async () => {
  const problems = await runContract()
  assert.deepEqual(problems, [], `${problems.length} App/API contract mismatch(es):\n  ${problems.join("\n  ")}`)
})

test("a paired App gets the same contract back encrypted on every JSON call", async () => {
  const problems = await runContract(ENC_KEY)
  assert.deepEqual(problems, [], `${problems.length} mismatch(es) with message encryption:\n  ${problems.join("\n  ")}`)
})

/**
 * `ignoreUnknownKeys` hides a mistyped request field on both sides: the server sees no value,
 * answers 200 with nothing changed, and the App's button reports success. The responses are
 * walked above; this walks the requests — every key ApiClient.kt puts in a body has to be read
 * somewhere under src/, by `body.key`, by a quoted accessor like `text("key")`, or off the
 * parsed item of a nested list.
 */
test("every request field the App sends is read by the server", () => {
  const clientPath = "android/app/src/main/java/com/agentbot/app/data/ApiClient.kt"
  assert.ok(existsSync(clientPath), `${clientPath} is missing, so App requests cannot be checked`)
  const server = readdirSync("src")
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(join("src", file), "utf8"))
    .join("\n")

  const unread: string[] = []
  const keys = new Set<string>()
  let checked = 0
  let fn = ""
  let writes = false
  const flush = (): void => {
    if (writes) {
      for (const key of keys) {
        checked += 1
        const read = new RegExp(
          `\\bbody\\.${key}\\b|\\bbody\\["${key}"\\]|\\(\\s*"${key}"\\s*[,)]|\\b(?:record|item|entry|row)\\.${key}\\b`,
        )
        if (!read.test(server)) unread.push(`${fn} → ${key}`)
      }
    }
    keys.clear()
    writes = false
    fn = ""
  }

  for (const line of readFileSync(clientPath, "utf8").split("\n")) {
    const fun = /suspend fun (\w+)/.exec(line)
    if (fun) {
      flush()
      fn = fun[1]!
      continue
    }
    if (/"(?:POST|PUT|DELETE)"/.test(line)) writes = true
    const put = /put\("([\w]+)"/.exec(line)
    if (put) keys.add(put[1]!)
  }
  flush()

  assert.ok(checked > 25, `only ${checked} App request fields were checked, the walk found too few bodies`)
  assert.deepEqual(unread, [], `the server never reads these fields the App sends:\n  ${unread.join("\n  ")}`)
})
