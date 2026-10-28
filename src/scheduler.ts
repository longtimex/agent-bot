import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "./logger.js"
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
  qoderModel?: string
  repeat?: ReminderRepeat
  paused?: boolean
  runningAt?: number
  lastRunAt?: number
  lastStatus?: UsageOutcome
}

export interface ScheduleDefaults {
  engine: BackendEngine
  model?: ScheduledModel
  qoderModel?: string
}

export interface ScheduleDraft {
  prompt: string
  dueAt: number
  repeat?: ReminderRepeat
  engine: BackendEngine
  model?: ScheduledModel
  qoderModel?: string
}

interface ScheduleFile {
  nextId: number
  tasks: ScheduledTask[]
}

function modelFromInfo(key: string): ScheduledModel {
  const info = AVAILABLE_MODELS[key]!
  return { providerID: info.providerID, modelID: info.modelID, label: info.label }
}

export function parseScheduleAdd(
  input: string,
  defaults: ScheduleDefaults,
  now = Date.now(),
  timeZone = DEFAULT_TIMEZONE,
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
    const norm = flags.engine.toLowerCase()
    if (norm === "qoder" || norm === "q") engine = "qoder"
    else if (norm === "opencode" || norm === "oc" || norm === "open") engine = "opencode"
    else throw new Error("引擎仅支持 opencode 或 qoder。")
  }

  let model = engine === "opencode" ? defaults.model : undefined
  let qoderModel = engine === "qoder" ? defaults.qoderModel : undefined

  if (flags.model) {
    if (engine === "qoder") {
      const resolved = resolveQoderModel(flags.model)
      if (!resolved) throw new Error("Qoder 仅支持 deepseek 或 qwen 模型。")
      qoderModel = resolved
    } else {
      const key = resolveModelKey(flags.model)
      if (!key) throw new Error(`未识别的模型：${flags.model}。发送 /model 查看可用列表。`)
      model = modelFromInfo(key)
    }
  }

  if (engine === "qoder") {
    qoderModel ||= "Qwen3.8-Flash"
  } else {
    model ??= modelFromInfo("gemini")
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
    qoderModel,
  }
}

export function scheduleTargetLabel(task: Pick<ScheduledTask, "engine" | "model" | "qoderModel">): string {
  if (task.engine === "qoder") return `Qoder / ${task.qoderModel ?? "Qwen3.8-Flash"}`
  return `OpenCode / ${task.model?.label ?? "默认模型"}`
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

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  add(task: Omit<ScheduledTask, "id">): ScheduledTask {
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
    patch: Partial<Pick<ScheduledTask, "dueAt" | "paused" | "runningAt" | "lastRunAt" | "lastStatus">>,
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
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<ScheduleFile>
      this.#nextId = Number.isInteger(parsed.nextId) && (parsed.nextId ?? 0) > 0 ? parsed.nextId! : 1
      const items = Array.isArray(parsed.tasks) ? parsed.tasks : []
      const seen = new Set<number>()
      for (const item of items) {
        if (!item || !Number.isInteger(item.id) || seen.has(item.id)) continue
        if (
          !Number.isFinite(item.chatId) ||
          !Number.isFinite(item.dueAt) ||
          typeof item.prompt !== "string" ||
          !item.prompt.trim()
        ) {
          continue
        }
        const engine: BackendEngine = item.engine === "qoder" ? "qoder" : "opencode"
        const model = sanitizeModel(item.model)
        const qoderModel = typeof item.qoderModel === "string" && item.qoderModel ? item.qoderModel : undefined
        this.#tasks.push({
          id: item.id,
          chatId: item.chatId,
          userId: Number.isFinite(item.userId) ? item.userId : 0,
          prompt: item.prompt.slice(0, MAX_SCHEDULE_PROMPT),
          dueAt: item.dueAt,
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : item.dueAt,
          engine,
          model: engine === "opencode" ? (model ?? modelFromInfo("gemini")) : undefined,
          qoderModel: engine === "qoder" ? (qoderModel ?? "Qwen3.8-Flash") : undefined,
          repeat: sanitizeRepeat(item.repeat),
          paused: item.paused === true,
          // A persisted runningAt means the bot died mid-run; clear it so the task runs again
          runningAt: undefined,
          lastRunAt: Number.isFinite(item.lastRunAt) ? item.lastRunAt : undefined,
          lastStatus: sanitizeOutcome(item.lastStatus),
        })
        seen.add(item.id)
        if (item.id >= this.#nextId) this.#nextId = item.id + 1
      }
      this.#log.debug(`loaded ${this.#tasks.length} scheduled task(s) from ${this.#path}`)
    } catch (err) {
      this.#log.warn(`failed to read schedule store ${this.#path}:`, (err as Error).message)
    }
  }

  #save(): void {
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
  readonly #timeZone: string
  readonly #inflight = new Set<Promise<void>>()
  #timer?: NodeJS.Timeout
  #ticking = false
  #stopping = false

  constructor(path: string, executor: ScheduleExecutor, log: Logger, timeZone = DEFAULT_TIMEZONE) {
    this.#store = new ScheduleStore(path, log)
    this.#executor = executor
    this.#log = log
    this.#timeZone = timeZone
  }

  add(chatId: number, userId: number, input: string, defaults: ScheduleDefaults, now = Date.now()): ScheduledTask {
    if (this.#store.count(chatId) >= MAX_SCHEDULES_PER_CHAT) {
      throw new Error(`每个会话最多创建 ${MAX_SCHEDULES_PER_CHAT} 个定时任务，请先删除部分任务。`)
    }
    const draft = parseScheduleAdd(input, defaults, now, this.#timeZone)
    return this.#store.add({
      chatId,
      userId,
      prompt: draft.prompt,
      dueAt: draft.dueAt,
      createdAt: now,
      engine: draft.engine,
      model: draft.model,
      qoderModel: draft.qoderModel,
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
          }
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
    this.#log.info(`scheduled task #${task.id} triggered (${scheduleTargetLabel(task)})`)
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
      })
    } else {
      this.#store.removeById(task.id)
    }
  }
}
