import type { IncomingMessage, ServerResponse } from "node:http"
import { statSync, readdirSync, type Dirent } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { AgentCliProfile, AgentCliRegistry } from "./agentCli.js"
import { normalizeWorkDirInput } from "./agentCli.js"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import type { AliasEntry, AliasStore } from "./aliases.js"
import { clampLimit, res_attachment, stamp } from "./apiHttp.js"
import type { BotConfig } from "./config.js"
import { resolveOpencodeModel } from "./engineCall.js"
import { formatHistoryMarkdown, type TaskHistoryStore } from "./history.js"
import { OPS_COMMAND_MANAGED_KEYS, OPS_ENV_KEYS, type OpsService } from "./ops.js"
import { maskProxyUrl, type ProxyRecord, type ProxyService } from "./proxy.js"
import type { Reminder, ReminderService } from "./reminders.js"
import { scheduleTargetLabel, type ScheduledTask, type ScheduleService } from "./scheduler.js"
import type { SessionStore } from "./store.js"
import type { UsageStore } from "./usage.js"
import { buildDailyReportData, formatDailyReport, sourceLabel } from "./usageReport.js"
import { sessionKeyForChat, type ChannelIdResolver } from "./channelRegistry.js"
import { AVAILABLE_MODELS, type ModelInfo } from "./models.js"
import type { AgentCliInstaller } from "./agentInstaller.js"
import type { ModelAdmin } from "./modelAdmin.js"

/**
 * The personal-data route domains (reminders, schedules, peers) split out of
 * api.ts. Everything class-specific travels in this deps object, so the routes
 * stay plain functions the ApiServer delegates to.
 */
export interface PersonalRouteDeps {
  appKey: string
  ownerChatId?: number
  /** Owner user id; Feishu chats and users use separate numeric namespaces. */
  ownerUserId?: number
  store: SessionStore
  cfg: BotConfig
  registry: AgentCliRegistry
  reminders: ReminderService
  schedules: ScheduleService
  usage: UsageStore
  models: ModelAdmin
  installer?: AgentCliInstaller
  json(res: ServerResponse, status: number, body: unknown): void
  readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>>
  sessionView(key?: string): Record<string, unknown>
  adoptSession(from: string): string[]
  /** Working-directory context (the /dir route) */
  workDir(key: string): string
  defaultWorkDir: string
  resetCliSessions(): void
  hasActiveTask(): boolean
  /** Live timezone and its online switcher (the /timezone route) */
  timezone(): string
  setTimezone?: (zone: string) => { ok: boolean; message: string }
  aliases?: AliasStore
  ops?: OpsService
  proxies?: ProxyService
  history: TaskHistoryStore
  /** Resolves whether the app-facing owner chat belongs to Telegram or Feishu. */
  channel?: ChannelIdResolver
  access?: {
    list(): { users: string[]; allowAll: boolean }
    add(ids: string[]): { ok: boolean; message: string }
    remove(ids: string[]): { ok: boolean; message: string }
  }
}

export function requireOwnerChat(deps: PersonalRouteDeps, feature: string): number {
  const owner = deps.ownerChatId
  if (!owner) {
    throw new ApiError(
      409,
      `${feature}需要一个推送目标：请先在 Telegram 或飞书私聊 Bot 发送 /start，或配置对应渠道的白名单。`,
    )
  }
  return owner
}

/** Access checks use the user id while notifications use the chat id. */
function ownerUserId(deps: PersonalRouteDeps): number {
  return deps.ownerUserId ?? requireOwnerChat(deps, "提醒")
}

export function publicReminder(reminder: Reminder): Record<string, unknown> {
  return { id: reminder.id, text: reminder.text, dueAt: reminder.dueAt, repeat: reminder.repeat }
}

export function publicSchedule(task: ScheduledTask, registry: AgentCliRegistry): Record<string, unknown> {
  return {
    id: task.id,
    prompt: task.prompt,
    dueAt: task.dueAt,
    engine: task.engine,
    // Same "引擎 / 模型" line Telegram shows, including `--engine/--model` pins.
    target: scheduleTargetLabel(task, registry),
    repeat: task.repeat,
    paused: Boolean(task.paused),
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
  }
}

export async function routeReminders(
  deps: PersonalRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action?: string,
): Promise<void> {
  const chatId = requireOwnerChat(deps, "提醒")
  if (ctx.method === "GET" && !id) {
    deps.json(ctx.res, 200, { reminders: deps.reminders.list(chatId).map((r) => publicReminder(r)) })
    return
  }
  if (ctx.method === "POST" && !id) {
    const body = await deps.readJsonBody(ctx.req)
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (!text) throw new ApiError(400, "缺少 text 字段，例如：{\"text\":\"30m 喝水\"}")
    let reminder
    try {
      reminder = deps.reminders.add(chatId, ownerUserId(deps), text)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法解析提醒时间")
    }
    deps.json(ctx.res, 201, { reminder: publicReminder(reminder) })
    return
  }
  const reminderId = Number(id)
  if (ctx.method === "DELETE" && Number.isInteger(reminderId)) {
    const removed = deps.reminders.cancel(chatId, reminderId)
    if (!removed) throw new ApiError(404, "提醒不存在")
    deps.json(ctx.res, 200, { ok: true })
    return
  }
  // App-side snooze: postpones a pending one-shot and echoes the updated row
  if (ctx.method === "POST" && Number.isInteger(reminderId) && action === "snooze") {
    const body = await deps.readJsonBody(ctx.req)
    const minutes = typeof body.minutes === "number" ? body.minutes : Number(body.minutes)
    try {
      const postponed = deps.reminders.postpone(chatId, reminderId, minutes)
      deps.json(ctx.res, 200, { ok: true, reminder: publicReminder(postponed) })
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法延后该提醒")
    }
    return
  }
  throw new ApiError(404, "未知的提醒 API 路径")
}

export async function routeSchedules(
  deps: PersonalRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const chatId = requireOwnerChat(deps, "定时任务")
  if (ctx.method === "GET" && !id) {
    deps.json(ctx.res, 200, { schedules: deps.schedules.list(chatId).map((task) => publicSchedule(task, deps.registry)) })
    return
  }
  if (ctx.method === "POST" && !id) {
    const body = await deps.readJsonBody(ctx.req)
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (!text) throw new ApiError(400, "缺少 text 字段，例如：{\"text\":\"每天 09:00 检查服务器\"}")
    const engine = deps.store.getEngine(deps.appKey)
    const defaults =
      engine === "opencode"
        ? { engine, model: resolveOpencodeModel(deps.store, deps.appKey) }
        : { engine, cliModel: deps.store.getCliModel(deps.appKey, engine) }
    let task
    try {
      task = deps.schedules.add(chatId, ownerUserId(deps), text, defaults)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法解析定时任务")
    }
    deps.json(ctx.res, 201, { schedule: publicSchedule(task, deps.registry) })
    return
  }
  const taskId = Number(id)
  if (!Number.isInteger(taskId)) throw new ApiError(404, "未知的定时任务 API 路径")
  if (ctx.method === "DELETE" && !action) {
    const removed = deps.schedules.remove(chatId, taskId)
    if (!removed) throw new ApiError(404, "定时任务不存在")
    deps.json(ctx.res, 200, { ok: true })
    return
  }
  if (ctx.method === "POST" && (action === "pause" || action === "resume")) {
    const updated =
      action === "pause" ? deps.schedules.pause(chatId, taskId) : deps.schedules.resume(chatId, taskId)
    if (!updated) throw new ApiError(404, "定时任务不存在")
    deps.json(ctx.res, 200, { schedule: publicSchedule(updated, deps.registry) })
    return
  }
  if (ctx.method === "POST" && action === "run") {
    let task
    try {
      task = deps.schedules.runNow(chatId, taskId)
    } catch (err) {
      throw new ApiError(409, err instanceof Error ? err.message : "定时任务正在执行中")
    }
    if (!task) throw new ApiError(404, "定时任务不存在")
    deps.json(ctx.res, 200, {
      ok: true,
      message: `已立即执行定时任务 #${taskId}，结果会发送到当前聊天（不影响原定时间）。`,
      schedule: publicSchedule(task, deps.registry),
    })
    return
  }
  throw new ApiError(404, "未知的定时任务 API 路径")
}

/** The live sessions this token can see: the App's own, plus the chat the bot pushes to.
 * They stay separate on purpose — each client keeps its own engine, model and
 * directory — which is why the App shows what the other end runs instead of guessing. */
export function peerSessions(deps: PersonalRouteDeps): Array<{ scope: string; label: string; key: string }> {
  const peers = [{ scope: "app", label: "本机 App", key: deps.appKey }]
  const owner = deps.ownerChatId
  if (owner) {
    const key = sessionKeyForChat(owner, deps.channel)
    const feishu = key.startsWith("fs:")
    peers.push({ scope: feishu ? "feishu" : "telegram", label: feishu ? "飞书会话" : "Telegram 会话", key })
  }
  return peers
}

/**
 * One live session as the other end sees it. Activity comes from the usage store, which
 * The chat channel and the App both write under the same key, so those numbers are real; this
 * server's task map only ever holds App tasks, so queue depth is deliberately not claimed.
 * Counts and timestamps travel only — never the session key (`tg:` / `fs:` plus chat id)
 * and never the chat's message text.
 */
export function peerView(deps: PersonalRouteDeps, peer: { scope: string; label: string; key: string }): Record<string, unknown> {
  const usage = deps.usage.summary(peer.key)
  const { key: _sessionKey, ...session } = deps.sessionView(peer.key)
  return {
    scope: peer.scope,
    label: peer.label,
    current: peer.key === deps.appKey,
    session,
    activity: {
      lastAt: usage.lastAt ?? 0,
      lastEngine: usage.lastEngine ?? null,
      lastModel: usage.lastModel ?? null,
      todayTasks: usage.today.tasks,
      todayOk: usage.today.ok,
      totalTasks: usage.tasks,
    },
  }
}

export async function routePeers(deps: PersonalRouteDeps, ctx: ApiRequestContext, id: string | undefined): Promise<void> {
  const peers = peerSessions(deps)

  if (ctx.method === "GET" && !id) {
    deps.json(ctx.res, 200, { peers: peers.map((peer) => peerView(deps, peer)) })
    return
  }

  if (ctx.method === "POST" && id === "follow") {
    const body = await deps.readJsonBody(ctx.req)
    const defaultScope = peers.find((entry) => entry.scope !== "app")?.scope ?? "telegram"
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : defaultScope
    const peer = peers.find((entry) => entry.scope === scope && entry.key !== deps.appKey)
    if (!peer) throw new ApiError(409, "没有可跟随的对端会话：请先在 Telegram 或飞书里与 Bot 对话一次")
    // Following swaps engine/model/directory at once, which a running task must not be replayed under
    if (deps.hasActiveTask()) throw new ApiError(409, "任务执行中，请先停止当前任务再跟随对端会话")
    const changed = deps.adoptSession(peer.key)
    deps.json(ctx.res, 200, {
      ok: true,
      message: changed.length ? `已跟随${peer.label}：${changed.join("、")}` : "两端设置已经一致，无需跟随",
      session: deps.sessionView(),
    })
    return
  }

  throw new ApiError(404, "未知的对端会话接口")
}

/** `/dir` equivalent: the working directory CLI engines start in for the app session. */
export function dirView(deps: PersonalRouteDeps): Record<string, unknown> {
  const engine = deps.store.getEngine(deps.appKey)
  const view: Record<string, unknown> = {
    engine,
    workDir: deps.workDir(deps.appKey),
    defaultWorkDir: deps.defaultWorkDir,
    custom: deps.store.getDir(deps.appKey) ?? null,
  }
  if (engine === "opencode") view.note = "OpenCode 的目录由其服务端决定，该设置只影响 CLI 引擎"
  return view
}

/** Subdirectories one browse listing shows; a huge repo root is not worth paging. */
const DIR_BROWSE_LIMIT = 200

/** Symlinked directories are selectable too, but only once the target really is one. */
function isBrowseableDir(path: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    // dangling link, or a link into a tree this account cannot stat
    return false
  }
}

/**
 * One level of the server's directory tree, for a client that cannot type an absolute path
 * comfortably. `POST /dir` already accepts any path this account reaches, so the listing only
 * shows what could be selected and never changes the session. Hidden entries are skipped:
 * `~/.cache` and friends are not where a task should run.
 */
function dirListing(deps: PersonalRouteDeps, raw: string): Record<string, unknown> {
  const target = normalizeWorkDirInput(raw.trim() || deps.defaultWorkDir, deps.defaultWorkDir, homedir())
  if (!target) throw new ApiError(400, "路径无效：不能为空、含控制字符、超过 512 字符，或指向文件系统根目录")
  try {
    if (!statSync(target).isDirectory()) throw new ApiError(400, `不是目录：${target}`)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(400, `目录不存在或不可访问：${target}`)
  }
  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch {
    throw new ApiError(409, `没有权限读取该目录：${target}`)
  }
  const all: { name: string; path: string }[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const path = join(target, entry.name)
    if (isBrowseableDir(path, entry)) all.push({ name: entry.name, path })
  }
  all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  const parent = dirname(target) === target ? null : dirname(target)
  return {
    path: target,
    parent,
    home: homedir(),
    cwd: process.cwd(),
    defaultWorkDir: deps.defaultWorkDir,
    sessionDir: deps.workDir(deps.appKey),
    dirs: all.slice(0, DIR_BROWSE_LIMIT),
    truncated: all.length > DIR_BROWSE_LIMIT,
  }
}

export async function routeDir(
  deps: PersonalRouteDeps,
  ctx: ApiRequestContext,
  sub?: string,
): Promise<void> {
  if (sub === "browse") {
    if (ctx.method !== "GET") throw new ApiError(405, "浏览目录只支持 GET")
    deps.json(ctx.res, 200, dirListing(deps, ctx.url.searchParams.get("path") ?? ""))
    return
  }
  if (sub) throw new ApiError(404, `未知的目录接口：/dir/${sub}`)
  if (ctx.method === "GET") {
    deps.json(ctx.res, 200, dirView(deps))
    return
  }
  if (ctx.method !== "POST") throw new ApiError(405, "只支持 GET 或 POST")
  const body = await deps.readJsonBody(ctx.req)
  // Either change resets the CLI session, which would split a running task across two projects
  if (deps.hasActiveTask()) throw new ApiError(409, "任务执行中，请先停止当前任务再切换工作目录")

  if (body.reset === true) {
    const cleared = deps.store.clearDir(deps.appKey)
    if (cleared) deps.resetCliSessions()
    deps.json(ctx.res, 200, {
      ok: true,
      message: cleared ? "已恢复默认工作目录（CLI 会话上下文已重置）" : "已经是默认工作目录",
      dir: dirView(deps),
    })
    return
  }

  const raw = typeof body.dir === "string" ? body.dir.trim() : ""
  if (!raw) throw new ApiError(400, "缺少 dir 字段（或传 reset: true 恢复默认目录）")
  const dir = normalizeWorkDirInput(raw, deps.defaultWorkDir, homedir())
  if (!dir) {
    throw new ApiError(400, "路径无效：不能为空、含控制字符、超过 512 字符，或指向文件系统根目录")
  }
  let isDirectory = false
  try {
    isDirectory = statSync(dir).isDirectory()
  } catch {
    // reported below
  }
  if (!isDirectory) throw new ApiError(400, `目录不存在或不是目录：${dir}`)

  deps.store.setDir(deps.appKey, dir)
  deps.resetCliSessions()
  deps.json(ctx.res, 200, {
    ok: true,
    message: "工作目录已更新（CLI 会话上下文已重置）",
    dir: dirView(deps),
  })
}

export async function routeTimezone(deps: PersonalRouteDeps, ctx: ApiRequestContext): Promise<void> {
  if (ctx.method === "GET") {
    deps.json(ctx.res, 200, { timezone: deps.timezone() })
    return
  }
  if (ctx.method !== "POST") throw new ApiError(405, "只支持 GET 或 POST")
  const body = await deps.readJsonBody(ctx.req)
  const zone = typeof body.timezone === "string" ? body.timezone.trim() : ""
  if (!zone) throw new ApiError(400, "缺少 timezone 字段，例如：Asia/Shanghai")
  const setter = deps.setTimezone
  if (!setter) throw new ApiError(409, "当前运行环境不支持在线切换时区")
  const result = setter(zone)
  if (!result.ok) throw new ApiError(400, result.message)
  deps.json(ctx.res, 200, { ok: true, message: result.message, timezone: deps.timezone() })
}

function aliasView(entry: AliasEntry): Record<string, unknown> {
  return { name: entry.name, expansion: entry.expansion, createdAt: entry.createdAt }
}

export async function routeAliases(deps: PersonalRouteDeps, ctx: ApiRequestContext, id: string | undefined): Promise<void> {
  const aliases = deps.aliases
  if (!aliases) throw new ApiError(409, "当前运行环境不支持快捷指令")
  // An Android-only deployment has no Telegram/Feishu owner to share with; its
  // shortcuts still belong to the app session and must work without a push target.
  const chatId = deps.ownerChatId ?? deps.appKey
  if (ctx.method === "GET" && !id) {
    deps.json(ctx.res, 200, { aliases: aliases.list(chatId).map((entry) => aliasView(entry)) })
    return
  }
  if (ctx.method === "POST" && !id) {
    const body = await deps.readJsonBody(ctx.req)
    const name = typeof body.name === "string" ? body.name.trim().replace(/^\//, "") : ""
    const expansion = typeof body.expansion === "string" ? body.expansion.trim() : ""
    if (!name) throw new ApiError(400, "缺少 name 字段，例如：{\"name\":\"code\",\"expansion\":\"审查代码\"}")
    if (!expansion) throw new ApiError(400, "缺少 expansion 字段（指令触发后要发送的内容）")
    let entry: AliasEntry
    try {
      entry = aliases.add(chatId, name, expansion)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法创建快捷指令")
    }
    deps.json(ctx.res, 201, { ok: true, message: `已创建 /${entry.name}。`, alias: aliasView(entry) })
    return
  }
  if (ctx.method === "DELETE" && id) {
    const removed = aliases.remove(chatId, id)
    if (!removed) throw new ApiError(404, "快捷指令不存在")
    deps.json(ctx.res, 200, { ok: true, message: `已删除 /${removed.name}。` })
    return
  }
  throw new ApiError(404, "未知的快捷指令 API 路径")
}

function configView(deps: PersonalRouteDeps, ops: OpsService): Record<string, unknown> {
  const list = ops.envList()
  return {
    exists: list.exists,
    entries: list.entries,
    editableKeys: OPS_ENV_KEYS.filter((name) => !OPS_COMMAND_MANAGED_KEYS.has(name)),
  }
}

export async function routeConfig(deps: PersonalRouteDeps, ctx: ApiRequestContext, key: string | undefined): Promise<void> {
  const ops = deps.ops
  if (!ops) throw new ApiError(409, "当前运行环境不支持配置管理")

  if (ctx.method === "GET" && !key) {
    deps.json(ctx.res, 200, configView(deps, ops))
    return
  }

  if (ctx.method === "PUT" && key) {
    const body = await deps.readJsonBody(ctx.req)
    if (typeof body.value !== "string") throw new ApiError(400, "缺少 value 字段")
    const upper = key.trim().toUpperCase()
    // Timezone has a live-apply path shared with /timezone; going through it keeps
    // reminders/schedules in sync instead of only rewriting .env
    const result =
      upper === "REMINDER_TIMEZONE" && deps.setTimezone
        ? deps.setTimezone(body.value.trim())
        : ops.envSet(upper, body.value)
    if (!result.ok) throw new ApiError(400, result.message)
    deps.json(ctx.res, 200, { ok: true, message: result.message, config: configView(deps, ops) })
    return
  }

  if (ctx.method === "DELETE" && key) {
    const result = ops.envUnset(key)
    if (!result.ok) throw new ApiError(400, result.message)
    deps.json(ctx.res, 200, { ok: true, message: result.message, config: configView(deps, ops) })
    return
  }

  throw new ApiError(404, "未知的配置 API 路径")
}

export async function routeAccess(deps: PersonalRouteDeps, ctx: ApiRequestContext, id: string | undefined): Promise<void> {
  const access = deps.access
  if (!access) throw new ApiError(409, "当前运行环境不支持白名单管理")
  if (ctx.method === "GET" && !id) {
    deps.json(ctx.res, 200, access.list())
    return
  }
  if (ctx.method === "POST" && !id) {
    const body = await deps.readJsonBody(ctx.req)
    const raw = Array.isArray(body.ids) ? body.ids : typeof body.id === "string" ? [body.id] : []
    const ids = raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    if (ids.length === 0) throw new ApiError(400, "缺少 id 字段，例如：{\"id\":\"12345678\"}")
    const result = access.add(ids)
    if (!result.ok) throw new ApiError(400, result.message)
    deps.json(ctx.res, 200, { ok: true, message: result.message, ...access.list() })
    return
  }
  if (ctx.method === "DELETE" && id) {
    const result = access.remove([id])
    if (!result.ok) throw new ApiError(400, result.message)
    deps.json(ctx.res, 200, { ok: true, message: result.message, ...access.list() })
    return
  }
  throw new ApiError(404, "未知的白名单 API 路径")
}

function proxyView(proxy: ProxyRecord, activeId?: number): Record<string, unknown> {
  return {
    id: proxy.id,
    name: proxy.name,
    // The URL can embed SOCKS/HTTP credentials; the app only ever sees the masked form.
    url: maskProxyUrl(proxy.url),
    protocol: proxy.protocol,
    createdAt: proxy.createdAt,
    active: proxy.id === activeId,
  }
}

export async function routeProxy(
  deps: PersonalRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const proxies = deps.proxies
  if (!proxies) throw new ApiError(409, "当前运行环境不支持代理管理")
  if (ctx.method === "GET" && !id) {
    const active = proxies.active()
    deps.json(ctx.res, 200, {
      active: active?.id ?? null,
      proxies: proxies.list().map((proxy) => proxyView(proxy, active?.id)),
    })
    return
  }
  if (ctx.method === "POST" && id === "off") {
    proxies.disable()
    deps.json(ctx.res, 200, { ok: true, message: "已停用代理。", active: null })
    return
  }
  if (ctx.method === "POST" && !id) {
    const body = await deps.readJsonBody(ctx.req)
    const url = typeof body.url === "string" ? body.url.trim() : ""
    const name = typeof body.name === "string" ? body.name.trim() : undefined
    if (!url) throw new ApiError(400, "缺少 url 字段，例如：{\"url\":\"http://127.0.0.1:7890\"}")
    let proxy: ProxyRecord
    try {
      proxy = await proxies.add(url, name)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法添加代理")
    }
    deps.json(ctx.res, 201, {
      ok: true,
      message: `代理 #${proxy.id} 测试通过并已添加。`,
      proxy: proxyView(proxy, proxies.active()?.id),
    })
    return
  }
  const proxyId = Number(id)
  if (!Number.isInteger(proxyId)) throw new ApiError(404, "未知的代理 API 路径")
  if (ctx.method === "POST" && action === "use") {
    let proxy: ProxyRecord
    try {
      proxy = proxies.use(proxyId)
    } catch {
      throw new ApiError(404, "代理不存在")
    }
    deps.json(ctx.res, 200, {
      ok: true,
      message: `已启用代理 #${proxy.id}。`,
      proxy: proxyView(proxy, proxy.id),
    })
    return
  }
  if (ctx.method === "POST" && action === "test") {
    if (!proxies.list().some((proxy) => proxy.id === proxyId)) throw new ApiError(404, "代理不存在")
    const result = await proxies.test(proxyId)
    deps.json(ctx.res, 200, result)
    return
  }
  if (ctx.method === "DELETE" && !action) {
    const removed = proxies.remove(proxyId)
    if (!removed) throw new ApiError(404, "代理不存在")
    deps.json(ctx.res, 200, { ok: true, message: `已删除代理 #${removed.id}。` })
    return
  }
  throw new ApiError(404, "未知的代理 API 路径")
}

/** The usage/history/export block that used to sit inline in the request handler. */
export async function routeUsageHistory(
  deps: PersonalRouteDeps,
  ctx: ApiRequestContext,
  resource: string,
  id: string | undefined,
): Promise<void> {
  const { method } = ctx
  // The id-less view must not swallow deeper paths like /usage/report
  if (resource === "usage" && !id && method === "GET") {
    const summary = deps.usage.summary(deps.appKey)
    deps.json(ctx.res, 200, { usage: summary, trend: deps.usage.recentDays(deps.appKey, 7) })
    return
  }

  // Cross-chat aggregate (chat channels + App together) for status dashboards;
  // the rendered text matches what the scheduled daily report pushes to chat.
  if (resource === "usage" && id === "report" && method === "GET") {
    const data = buildDailyReportData(deps.usage, deps.timezone())
    deps.json(ctx.res, 200, {
      day: data.day,
      totals: data.totals,
      byChat: data.byChat.map((row) => ({ source: sourceLabel(row.key), key: row.key, usage: row.usage })),
      trend: data.trend,
      text: formatDailyReport(data),
    })
    return
  }

  if (resource === "history" && method === "GET") {
    const limit = clampLimit(ctx.url.searchParams.get("limit"), 20, 50)
    // total lets the app show how much of the stored history its window covers
    deps.json(ctx.res, 200, {
      history: deps.history.list(deps.appKey, limit),
      total: deps.history.count(deps.appKey),
    })
    return
  }

  if (resource === "export" && method === "GET") {
    const format = (ctx.url.searchParams.get("format") ?? "markdown").toLowerCase()
    if (format !== "markdown" && format !== "json") throw new ApiError(400, "format 仅支持 markdown 或 json")
    const entries = deps.history.list(deps.appKey, 50)
    if (format === "json") {
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), key: deps.appKey, entries }, null, 2)
      res_attachment(ctx.res, `agentbot-history-${stamp()}.json`, "application/json; charset=utf-8", payload)
      return
    }
    const markdown = formatHistoryMarkdown(entries, {
      source: `App (${deps.appKey})`,
      timeZone: deps.timezone(),
    })
    res_attachment(ctx.res, `agentbot-history-${stamp()}.md`, "text/markdown; charset=utf-8", markdown)
    return
  }

  if (resource === "history" && method === "DELETE") {
    deps.json(ctx.res, 200, { cleared: deps.history.clear(deps.appKey) })
    return
  }

  throw new ApiError(404, "未知的 API 路径")
}

/** Formats one custom-model entry; pure, so both the API and views reuse it. */
export function customModelView(key: string, entry: ModelInfo): Record<string, unknown> {
  return { key, providerID: entry.providerID, modelID: entry.modelID, label: entry.label, desc: entry.desc }
}

export function builtinAgentView(): Record<string, unknown> {
  return {
    id: "opencode",
    label: "OpenCode",
    desc: "多模型、工具调用、附件收发",
    installed: true,
    install: undefined,
    sessionMode: "session",
    supportsModel: true,
    models: undefined,
    experimental: undefined,
    managed: false,
    installable: false,
    updateable: false,
    uninstallable: false,
    installCommand: undefined,
    updateCommand: undefined,
    uninstallCommand: undefined,
  }
}

export function agentView(deps: PersonalRouteDeps, profile: AgentCliProfile): Record<string, unknown> {
  const installer = deps.installer
  const installed = Boolean(deps.registry.binPath(profile))
  return {
    id: profile.id,
    label: profile.label,
    desc: profile.desc,
    // Telegram resolves `/engine <word>` through these, and the App's own matcher needs
    // them to land on the same row from the same word.
    aliases: profile.aliases,
    bin: profile.bin,
    installed,
    install: profile.install,
    sessionMode: profile.sessionMode,
    supportsModel: Boolean(profile.supportsModel),
    models: profile.models,
    experimental: profile.experimental,
    managed: installer?.isManaged(profile.id) ?? false,
    installable: Boolean(!installed && installer?.installCommand(profile)),
    updateable: Boolean(installer?.updateCommand(profile.id)),
    uninstallable: Boolean(installer?.uninstallCommand(profile.id)),
    installCommand: installer?.installCommand(profile),
    updateCommand: installer?.updateCommand(profile.id),
    uninstallCommand: installer?.uninstallCommand(profile.id),
  }
}

export function agentsView(deps: PersonalRouteDeps): Array<Record<string, unknown>> {
  // The registry only lists CLI profiles, but "opencode" is a selectable engine for
  // POST /agent (registry ids may never reuse that word). Listing the built-in here
  // too is what lets a client switch back to it once a CLI engine is in use, exactly
  // as Telegram's /agent panel does.
  const entries: Array<Record<string, unknown>> = [builtinAgentView(), ...deps.registry.list().map((profile) => agentView(deps, profile))]
  return entries.sort((a, b) => Number(b.installed) - Number(a.installed))
}

export function modelsView(deps: PersonalRouteDeps, requestedEngine?: string): Record<string, unknown> {
  // A one-off pin can target another engine than the session, so callers may ask
  // explicitly instead of only getting the current engine's list.
  const engine = requestedEngine?.trim() || deps.store.getEngine(deps.appKey)
  if (engine !== "opencode" && !deps.registry.get(engine)) {
    throw new ApiError(400, `未知的 Agent 引擎：${engine}`)
  }
  if (engine === "opencode") {
    const custom = deps.models.listCustomModels()
    const builtin = Object.entries(AVAILABLE_MODELS).map(([key, info]) => ({ key, ...info }))
    const customEntries = Object.entries(custom).map(([key, info]) => ({ key, ...info }))
    return { engine, models: [...customEntries, ...builtin] }
  }
  const profile = deps.registry.get(engine)
  return {
    engine,
    models: profile?.supportsModel ? (profile.models ?? []) : [],
    modelHint: profile?.modelHint,
  }
}
