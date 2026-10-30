import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "./logger.js"
import { clip } from "./messages.js"
import { AVAILABLE_MODELS, resolveModelKey, resolveQoderModel } from "./models.js"
import {
  DEFAULT_TIMEZONE,
  nextReminderDue,
  parseReminder,
  sanitizeRepeat,
  type ReminderRepeat,
} from "./reminders.js"
import type { BackendEngine } from "./store.js"
import type { UsageOutcome } from "./usage.js"

export const MAX_SCHEDULES_PER_CHAT = 20
export const MAX_SCHEDULE_PROMPT = 2_000

const TICK_MS = 15_000
const MAX_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000
const OUTCOMES: UsageOutcome[] = ["ok", "failed", "cancelled"]
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
/** One-shot tasks hit transient backend/network errors, so retry before discarding them. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000]
const MAX_FAILURE_ATTEMPTS = RETRY_DELAYS_MS.length

export interface ScheduledModel {
  providerID: string
  modelID: string
  label: string
}

export interface ScheduledTask {
  id: number
  chatId: number
  userId: number
  prompt: string
  dueAt: number
  createdAt: number
  engine: BackendEngine
  model?: ScheduledModel
  cliModel?: string
  repeat?: ReminderRepeat
  paused?: boolean
  runningAt?: number
  lastRunAt?: number
  lastStatus?: UsageOutcome
  /** Number of failed runs that are being retried; only used by one-shot tasks. */
  attempts?: number
}

export interface ScheduleDefaults {
  engine: BackendEngine
  model?: ScheduledModel
  cliModel?: string
}

export interface ScheduleDraft {
  prompt: string
  dueAt: number
  repeat?: ReminderRepeat
  engine: BackendEngine
  model?: ScheduledModel
  cliModel?: string
}

/**
 * Lets the scheduler resolve arbitrary CLI engine ids and their models.
 * `AgentCliRegistry` implements this interface.
 */
export interface ScheduleEngineResolver {
  resolveEngine(raw: string): string | undefined
  label(engine: string): string
  resolveModel(engine: string, raw: string): string | undefined
  defaultModel(engine: string): string | undefined
}

interface ScheduleFile {
  nextId: number
  tasks: ScheduledTask[]
}

interface StoredTask extends Partial<ScheduledTask> {
  qoderModel?: string
}

function modelFromInfo(key: string): ScheduledModel {
  const info = AVAILABLE_MODELS[key]!
  return { providerID: info.providerID, modelID: info.modelID, label: info.label }
}

function legacyResolveEngine(raw: string): string | undefined {
  const norm = raw.toLowerCase()
  if (norm === "qoder" || norm === "q") return "qoder"
  if (norm === "opencode" || norm === "oc" || norm === "open") return "opencode"
  return undefined
}

export function parseScheduleAdd(
  input: string,
  defaults: ScheduleDefaults,
  now = Date.now(),
  timeZone = DEFAULT_TIMEZONE,
  resolver?: ScheduleEngineResolver,
): ScheduleDraft {
  let rest = input.trim()
  const flags: { engine?: string; model?: string } = {}

  // Leading flags configure the run target; the remaining text is time + prompt
  for (;;) {
    const match = /^(?:--engine|-e|--model|-m)\s+(\S+)\s*/.exec(rest)
    if (!match) break
    const flag = match[0].split(/\s+/, 1)[0]!.toLowerCase()
    if (flag === "--engine" || flag === "-e") flags.engine = match[1]!
    else flags.model = match[1]!
    rest = rest.slice(match[0].length)
  }

  let engine = defaults.engine
  if (flags.engine) {
    const resolved = resolver?.resolveEngine(flags.engine) ?? legacyResolveEngine(flags.engine)
    if (!resolved) {
      throw new Error(
        resolver
          ? `未识别的引擎：${flags.engine}。发送 /agent 查看可用引擎。`
          : "引擎仅支持 opencode 或 qoder。",
      )
    }
    engine = resolved
  }

  // Defaults belong to the chat's current engine; do not carry them across --engine switches
  const sameEngine = engine === defaults.engine
  let model = engine === "opencode" && sameEngine ? defaults.model : undefined
  let cliModel = engine !== "opencode" && sameEngine ? defaults.cliModel : undefined

  if (flags.model) {
    if (engine === "opencode") {
      const key = resolveModelKey(flags.model)
      if (!key) throw new Error(`未识别的模型：${flags.model}。发送 /model 查看可用列表。`)
      model = modelFromInfo(key)
    } else {
      const resolved = resolver
        ? resolver.resolveModel(engine, flags.model)
        : engine === "qoder"
          ? resolveQoderModel(flags.model)
          : flags.model.trim()
      if (!resolved) {
        throw new Error(engine === "qoder" ? "Qoder 仅支持 deepseek 或 qwen 模型。" : `未识别的模型：${flags.model}。`)
      }
      cliModel = resolved
    }
  }

  if (engine === "opencode") {
    model ??= modelFromInfo("gemini")
    cliModel = undefined
  } else {
    cliModel ??= resolver?.defaultModel(engine) ?? (engine === "qoder" ? "Qwen3.8-Flash" : undefined)
    model = undefined
  }

  if (!rest) {
    throw new Error("用法：`/schedule add 30m 检查服务器`，可加 `--engine qoder` 或 `--model deepseek`。")
  }
  const parsed = parseReminder(rest, now, timeZone, {
    maxTextLength: MAX_SCHEDULE_PROMPT,
    command: "/schedule add",
    label: "定时任务",
  })

  return {
    prompt: parsed.text,
    dueAt: parsed.dueAt,
    repeat: parsed.repeat,
    engine,
    model,
    cliModel,
  }
}

export function scheduleTargetLabel(
  task: Pick<ScheduledTask, "engine" | "model" | "cliModel">,
  resolver?: ScheduleEngineResolver,
): string {
  if (task.engine === "opencode") return `OpenCode / ${task.model?.label ?? "默认模型"}`
  const label = resolver?.label(task.engine) ?? (task.engine === "qoder" ? "Qoder" : task.engine)
  const model =
    task.cliModel ?? resolver?.defaultModel(task.engine) ?? (task.engine === "qoder" ? "Qwen3.8-Flash" : undefined)
  return `${label} / ${model ?? "CLI 默认"}`
}

function sanitizeModel(value: unknown): ScheduledModel | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.providerID !== "string" || typeof record.modelID !== "string") return undefined
  if (!record.providerID || !record.modelID) return undefined
  return {
    providerID: record.providerID,
    modelID: record.modelID,
    label: typeof record.label === "string" && record.label ? record.label : record.modelID,
  }
}

function sanitizeOutcome(value: unknown): UsageOutcome | undefined {
  return OUTCOMES.includes(value as UsageOutcome) ? (value as UsageOutcome) : undefined
}

export class ScheduleStore {
  readonly #path: string
  readonly #log: Logger
  #nextId = 1
  #tasks: ScheduledTask[] = []
  #unreadable = false

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  add(task: Omit<ScheduledTask, "id">): ScheduledTask {
    this.#assertWritable()
    const stored: ScheduledTask = { ...task, id: this.#nextId++ }
    this.#tasks.push(stored)
    this.#save()
    return { ...stored }
  }

  list(chatId: number): ScheduledTask[] {
    return this.#tasks
      .filter((task) => task.chatId === chatId)
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((task) => ({ ...task }))
  }

  count(chatId: number): number {
    return this.#tasks.filter((task) => task.chatId === chatId).length
  }

  find(chatId: number, id: number): ScheduledTask | undefined {
    const task = this.#tasks.find((item) => item.id === id && item.chatId === chatId)
    return task ? { ...task } : undefined
  }

  updateById(
    id: number,
    patch: Partial<
      Pick<ScheduledTask, "dueAt" | "paused" | "runningAt" | "lastRunAt" | "lastStatus" | "attempts">
    >,
  ): ScheduledTask | undefined {
    const task = this.#tasks.find((item) => item.id === id)
    if (!task) return undefined
    Object.assign(task, patch)
    this.#save()
    return { ...task }
  }

  remove(chatId: number, id: number): ScheduledTask | undefined {
    const index = this.#tasks.findIndex((item) => item.id === id && item.chatId === chatId)
    if (index < 0) return undefined
    this.#assertWritable()
    const [removed] = this.#tasks.splice(index, 1)
    this.#save()
    return removed ? { ...removed } : undefined
  }

  removeById(id: number): ScheduledTask | undefined {
    const index = this.#tasks.findIndex((item) => item.id === id)
    if (index < 0) return undefined
    const [removed] = this.#tasks.splice(index, 1)
    this.#save()
    return removed ? { ...removed } : undefined
  }

  takeDue(now: number): ScheduledTask[] {
    const due = this.#tasks.filter((task) => !task.paused && !task.runningAt && task.dueAt <= now)
    if (due.length === 0) return []
    for (const task of due) task.runningAt = now
    this.#save()
    return due.map((task) => ({ ...task }))
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<ScheduleFile> | null
      if (typeof parsed !== "object" || parsed === null || (parsed.tasks !== undefined && !Array.isArray(parsed.tasks))) {
        throw new Error("定时任务文件结构无效")
      }
      this.#nextId = Number.isInteger(parsed.nextId) && (parsed.nextId ?? 0) > 0 ? parsed.nextId! : 1
      const items = Array.isArray(parsed.tasks) ? (parsed.tasks as StoredTask[]) : []
      const seen = new Set<number>()
      for (const item of items) {
        const id = item?.id
        if (!Number.isInteger(id) || seen.has(id!)) continue
        const chatId = item.chatId
        const dueAt = item.dueAt
        if (
          !Number.isFinite(chatId) ||
          !Number.isFinite(dueAt) ||
          typeof item.prompt !== "string" ||
          !item.prompt.trim()
        ) {
          continue
        }
        const rawEngine = typeof item.engine === "string" ? item.engine.trim().toLowerCase() : ""
        const engine: BackendEngine = ENGINE_ID_RE.test(rawEngine) ? rawEngine : "opencode"
        const model = sanitizeModel(item.model)
        const cliModel =
          typeof item.cliModel === "string" && item.cliModel
            ? item.cliModel
            : engine === "qoder" && typeof item.qoderModel === "string" && item.qoderModel
              ? item.qoderModel
              : undefined
        this.#tasks.push({
          id: id!,
          chatId: chatId!,
          userId: Number.isFinite(item.userId) ? item.userId! : 0,
          prompt: clip(item.prompt, MAX_SCHEDULE_PROMPT) ?? item.prompt,
          dueAt: dueAt!,
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt! : dueAt!,
          engine,
          model: engine === "opencode" ? (model ?? modelFromInfo("gemini")) : undefined,
          cliModel: engine !== "opencode" ? (cliModel ?? (engine === "qoder" ? "Qwen3.8-Flash" : undefined)) : undefined,
          repeat: sanitizeRepeat(item.repeat),
          paused: item.paused === true,
          // A persisted runningAt means the bot died mid-run; clear it so the task runs again
          runningAt: undefined,
          lastRunAt: Number.isFinite(item.lastRunAt) ? item.lastRunAt! : undefined,
          lastStatus: sanitizeOutcome(item.lastStatus),
          attempts:
            Number.isInteger(item.attempts) && (item.attempts ?? 0) > 0
              ? Math.min(item.attempts!, MAX_FAILURE_ATTEMPTS)
              : undefined,
        })
        seen.add(id!)
        if (id! >= this.#nextId) this.#nextId = id! + 1
      }
      this.#log.debug(`loaded ${this.#tasks.length} scheduled task(s) from ${this.#path}`)
    } catch (err) {
      this.#unreadable = true
      this.#log.warn(`failed to read schedule store ${this.#path}:`, (err as Error).message)
    }
  }

  #assertWritable(): void {
    if (!this.#unreadable) return
    throw new Error(
      `定时任务文件 ${this.#path} 无法解析，为避免丢失已有任务已拒绝写入。请先修复该文件（或备份后删除）再重试。`,
    )
  }

  #save(): void {
    // Writing the recovered subset over a file we could not parse would delete every
    // task the damaged section held
    if (this.#unreadable) {
      this.#log.warn(`schedule store ${this.#path} is unreadable; skipped writing it`)
      return
    }
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      writeFileSync(tmp, JSON.stringify({ nextId: this.#nextId, tasks: this.#tasks }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn("failed to persist schedule store:", (err as Error).message)
    }
  }
}

export type ScheduleExecutor = (task: ScheduledTask) => Promise<UsageOutcome>

export class ScheduleService {
  readonly #store: ScheduleStore
  readonly #executor: ScheduleExecutor
  readonly #log: Logger
  #timeZone: string
  readonly #resolver?: ScheduleEngineResolver
  readonly #access: (userId: number) => boolean
  readonly #notice?: (chatId: number, text: string) => Promise<void> | void
  readonly #inflight = new Set<Promise<void>>()
  #timer?: NodeJS.Timeout
  #ticking = false
  #stopping = false

  constructor(
    path: string,
    executor: ScheduleExecutor,
    log: Logger,
    timeZone = DEFAULT_TIMEZONE,
    resolver?: ScheduleEngineResolver,
    access?: (userId: number) => boolean,
    notice?: (chatId: number, text: string) => Promise<void> | void,
  ) {
    this.#store = new ScheduleStore(path, log)
    this.#executor = executor
    this.#log = log
    this.#timeZone = timeZone
    this.#resolver = resolver
    this.#access = access ?? (() => true)
    this.#notice = notice
  }

  /** A failed notice must never abort the tick loop that is delivering other tasks. */
  async #notify(task: ScheduledTask, text: string): Promise<void> {
    if (!this.#notice) return
    try {
      await this.#notice(task.chatId, text)
    } catch (err) {
      this.#log.warn(`failed to deliver schedule notice #${task.id}:`, (err as Error).message)
    }
  }

  /** /timezone applies without a restart; already-computed due times are kept. */
  setTimeZone(timeZone: string): void {
    this.#timeZone = timeZone
  }

  add(chatId: number, userId: number, input: string, defaults: ScheduleDefaults, now = Date.now()): ScheduledTask {
    if (this.#store.count(chatId) >= MAX_SCHEDULES_PER_CHAT) {
      throw new Error(`每个会话最多创建 ${MAX_SCHEDULES_PER_CHAT} 个定时任务，请先删除部分任务。`)
    }
    const draft = parseScheduleAdd(input, defaults, now, this.#timeZone, this.#resolver)
    return this.#store.add({
      chatId,
      userId,
      prompt: draft.prompt,
      dueAt: draft.dueAt,
      createdAt: now,
      engine: draft.engine,
      model: draft.model,
      cliModel: draft.cliModel,
      repeat: draft.repeat,
    })
  }

  list(chatId: number): ScheduledTask[] {
    return this.#store.list(chatId)
  }

  count(chatId: number): number {
    return this.#store.count(chatId)
  }

  pause(chatId: number, id: number): ScheduledTask | undefined {
    return this.#store.find(chatId, id) ? this.#store.updateById(id, { paused: true }) : undefined
  }

  resume(chatId: number, id: number): ScheduledTask | undefined {
    return this.#store.find(chatId, id) ? this.#store.updateById(id, { paused: false }) : undefined
  }

  remove(chatId: number, id: number): ScheduledTask | undefined {
    return this.#store.remove(chatId, id)
  }

  /**
   * Runs a task immediately on demand. dueAt/repeat stay untouched, so the
   * upcoming automatic run is not moved or consumed; only runningAt and the
   * last-run bookkeeping change.
   */
  runNow(chatId: number, id: number): ScheduledTask | undefined {
    const task = this.#store.find(chatId, id)
    if (!task) return undefined
    if (task.runningAt) throw new Error(`定时任务 #${id} 正在执行中，请等待当前运行结束后再试。`)
    this.#store.updateById(id, { runningAt: Date.now() })
    const run = this.#runManual(task).finally(() => this.#inflight.delete(run))
    this.#inflight.add(run)
    return task
  }

  async #runManual(task: ScheduledTask): Promise<void> {
    this.#log.info(`scheduled task #${task.id} run manually (${scheduleTargetLabel(task, this.#resolver)})`)
    let outcome: UsageOutcome = "failed"
    try {
      outcome = await this.#executor(task)
    } catch (err) {
      this.#log.error(`scheduled task #${task.id} manual run failed:`, (err as Error).message)
    }
    this.#store.updateById(task.id, { runningAt: undefined, lastRunAt: Date.now(), lastStatus: outcome })
  }

  start(): void {
    if (this.#timer) return
    this.#stopping = false
    void this.tick()
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
  }

  dispose(): void {
    this.#stopping = true
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  async idle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight])
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      for (const task of this.#store.takeDue(now)) {
        if (now - task.dueAt > MAX_OVERDUE_MS) {
          if (task.repeat) {
            const next = nextReminderDue(task, now, this.#timeZone) ?? now + TICK_MS
            this.#store.updateById(task.id, { dueAt: next, runningAt: undefined })
            this.#log.warn(
              `skipped stale occurrence of scheduled task #${task.id}; next at ${new Date(next).toISOString()}`,
            )
          } else {
            this.#store.removeById(task.id)
            this.#log.warn(`dropped scheduled task #${task.id}; it was overdue by over 7 days`)
            // Removing it in silence looks exactly like the bot lost the task
            await this.#notify(task, `🗓 定时任务 #${task.id} 已过期未执行：Bot 停机期间它超过 7 天没有触发，已自动删除。`)
          }
          continue
        }
        if (!this.#access(task.userId)) {
          // The owner is off the access list, so no reply could ever be delivered:
          // pause the task instead of spending an AI run on it at every due time
          this.#store.updateById(task.id, {
            runningAt: undefined,
            paused: true,
            lastRunAt: Date.now(),
            lastStatus: "cancelled",
          })
          this.#log.warn(`scheduled task #${task.id} paused: user ${task.userId} is no longer allowed`)
          continue
        }
        const run = this.#execute(task).finally(() => this.#inflight.delete(run))
        this.#inflight.add(run)
      }
    } finally {
      this.#ticking = false
    }
  }

  async #execute(task: ScheduledTask): Promise<void> {
    this.#log.info(`scheduled task #${task.id} triggered (${scheduleTargetLabel(task, this.#resolver)})`)
    let outcome: UsageOutcome = "failed"
    try {
      outcome = await this.#executor(task)
    } catch (err) {
      this.#log.error(`scheduled task #${task.id} failed:`, (err as Error).message)
    }

    const finishedAt = Date.now()
    if (outcome === "cancelled" && this.#stopping) {
      // Keep the task for the next startup instead of losing it to shutdown
      if (task.repeat) {
        const next = nextReminderDue(task, finishedAt, this.#timeZone)
        this.#store.updateById(task.id, {
          dueAt: next ?? task.dueAt,
          runningAt: undefined,
          lastRunAt: finishedAt,
          lastStatus: outcome,
        })
      } else {
        this.#store.updateById(task.id, { runningAt: undefined })
      }
      return
    }

    if (task.repeat) {
      const next = nextReminderDue(task, finishedAt, this.#timeZone)
      this.#store.updateById(task.id, {
        dueAt: next ?? finishedAt + TICK_MS,
        runningAt: undefined,
        lastRunAt: finishedAt,
        lastStatus: outcome,
        attempts: undefined,
      })
      return
    }

    if (outcome === "cancelled") {
      // The user stopped this queued run, so the task never executed; keep it paused
      // instead of deleting it, and let /schedule resume or run decide what happens
      this.#store.updateById(task.id, {
        runningAt: undefined,
        paused: true,
        lastRunAt: finishedAt,
        lastStatus: outcome,
      })
      this.#log.warn(`scheduled task #${task.id} was cancelled before running; paused it`)
      return
    }

    const attempts = (task.attempts ?? 0) + 1
    if (outcome === "failed" && attempts <= MAX_FAILURE_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[attempts - 1]!
      this.#store.updateById(task.id, {
        dueAt: finishedAt + delay,
        runningAt: undefined,
        lastRunAt: finishedAt,
        lastStatus: outcome,
        attempts,
      })
      this.#log.warn(
        `scheduled task #${task.id} failed (retry ${attempts}/${MAX_FAILURE_ATTEMPTS} in ${Math.round(delay / 1000)}s)`,
      )
      return
    }
    this.#store.removeById(task.id)
    if (outcome === "failed") {
      this.#log.warn(`dropped scheduled task #${task.id} after ${attempts} failed run(s)`)
      await this.#notify(task, `🗓 定时任务 #${task.id} 连续失败 ${attempts} 次，已自动删除。可发送 /history 查看执行记录。`)
    }
  }
}
