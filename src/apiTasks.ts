import { readFileSync } from "node:fs"
import type { ApiRequestContext } from "./apiCore.js"
import { ApiError } from "./apiCore.js"
import type { AgentCliService } from "./agentCli.js"
import { buildAttachmentSections, MAX_ATTACH_TOTAL_BYTES } from "./attachmentInput.js"
import { isTextAttachment, pruneInbox, readTextAttachment, saveAttachment, type AttachmentKind, type SavedAttachment } from "./attachments.js"
import type { BotConfig } from "./config.js"
import { callEngine, resolveOpencodeModel, type EngineCallDeps, type ResolvedModel } from "./engineCall.js"
import type { TaskHistoryStore } from "./history.js"
import type { Logger } from "./logger.js"
import { mediaLabel, parseReply, resolveMedia } from "./media.js"
import type { ModelAdmin } from "./modelAdmin.js"
import type { ModelInfo } from "./models.js"
import type { Opencode, PromptFile } from "./opencode.js"
import { applyStt } from "./stt.js"
import type { SessionStore } from "./store.js"
import type { UsageOutcome, UsageStore } from "./usage.js"
import { redactSecrets } from "./ccswitch.js"
import { mimeForName } from "./apiHttp.js"
import type { ApiAttachment, ApiTask, ApiTaskMedia, ApiTaskView } from "./apiTaskTypes.js"

const MAX_API_ATTACHMENTS = 4
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
export const MAX_TASK_RECORDS = 200
const MAX_API_QUEUE = 4

export interface TaskManagerDeps {
  cfg: BotConfig
  oc: Opencode
  agents: AgentCliService
  store: SessionStore
  log: Logger
  usage: UsageStore
  history: TaskHistoryStore
  models: ModelAdmin
  ownerChatId?: number
  fetchMedia?: (target: string) => Promise<Buffer>
  appKey: string
}

export class ApiTaskManager {
  readonly #deps: TaskManagerDeps
  readonly #appKey: string
  #sequence = 0
  readonly #tasks = new Map<string, ApiTask>()
  readonly #queues = new Map<string, Promise<void>>()
  /** SSE subscribers per task id; each gets the serialized task view on every update. */
  readonly #taskListeners = new Map<string, Set<(payload: string) => void>>()
  readonly #lastEmit = new Map<string, number>()

  constructor(deps: TaskManagerDeps) {
    this.#deps = deps
    this.#appKey = deps.appKey
  }

  hasActiveTask(): boolean {
    return [...this.#tasks.values()].some(
      (task) => task.key === this.#appKey && (task.status === "queued" || task.status === "running"),
    )
  }

  /** Telegram answers "任务执行中，请先停止" instead of rewriting session state under a job. */
  requireIdle(what: string): void {
    if (this.hasActiveTask()) throw new ApiError(409, `任务执行中，请先停止当前任务再${what}`)
  }

  /** Queued-but-not-started tasks for this session, the same measure Telegram's cap uses. */
  waitingCount(): number {
    let waiting = 0
    for (const task of this.#tasks.values()) {
      if (task.key === this.#appKey && task.status === "queued") waiting += 1
    }
    return waiting
  }

  /**
   * Accepts the client's attachment list: base64-decodable, sane names/mimes,
   * at most 4 files and 15MB decoded in total (same caps as Telegram).
   */
  parseAttachments(raw: unknown): ApiAttachment[] | undefined {
    if (raw === undefined || raw === null) return undefined
    if (!Array.isArray(raw)) throw new ApiError(400, "attachments 必须是数组")
    if (raw.length > MAX_API_ATTACHMENTS) {
      throw new ApiError(400, `附件最多 ${MAX_API_ATTACHMENTS} 个`)
    }
    let total = 0
    const parsed = raw.map((item) => {
      if (!item || typeof item !== "object") throw new ApiError(400, "附件项必须是 {name, mime, data} 对象")
      const record = item as Record<string, unknown>
      const name = typeof record.name === "string" ? record.name.trim().slice(0, 200) : ""
      const mime = typeof record.mime === "string" ? record.mime.trim().slice(0, 100) : ""
      const data = typeof record.data === "string" ? record.data : ""
      if (!name || !data) throw new ApiError(400, "附件缺少 name 或 data")
      if (!MIME_RE.test(mime)) throw new ApiError(400, `附件 ${name} 的 mime 无效`)
      const stripped = data.replace(/\s+/g, "")
      if (!BASE64_RE.test(stripped)) throw new ApiError(400, `附件 ${name} 不是合法的 base64`)
      const bytes = Math.floor((stripped.length * 3) / 4)
      total += bytes
      if (total > MAX_ATTACH_TOTAL_BYTES) {
        throw new ApiError(400, `附件总大小超过 ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
      }
      return { name, mime: mime.toLowerCase(), data: stripped }
    })
    return parsed.length > 0 ? parsed : undefined
  }

  /** Persists API attachments into the same inbox the Telegram flow uses. */
  #saveAttachments(attachments: ApiAttachment[]): { saved: SavedAttachment[]; failed: string[] } {
    const chatId = this.#deps.ownerChatId ?? 0
    const saved: SavedAttachment[] = []
    const failed: string[] = []
    for (const att of attachments) {
      try {
        const buffer = Buffer.from(att.data, "base64")
        if (buffer.byteLength === 0) {
          failed.push(`${att.name}: 附件为空`)
          continue
        }
        const stored = saveAttachment(this.#deps.cfg.inboxDir, chatId, att.name, buffer)
        const kind: AttachmentKind = att.mime.startsWith("image/")
          ? "image"
          : att.mime.startsWith("audio/")
            ? "audio"
            : "document"
        const record: SavedAttachment = {
          fileId: "",
          kind,
          name: stored.name,
          mime: att.mime,
          path: stored.path,
          bytes: buffer.byteLength,
        }
        if (isTextAttachment(att.mime, stored.name)) {
          try {
            const { text, truncated } = readTextAttachment(stored.path)
            record.text = text
            record.truncated = truncated
          } catch {
            // treat as binary if decoding fails
          }
        }
        saved.push(record)
      } catch (err) {
        failed.push(`${att.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    pruneInbox(this.#deps.cfg.inboxDir)
    return { saved, failed }
  }

  submit(text: string, engineOverride?: string, modelOverride?: string, attachments?: ApiAttachment[]): ApiTask {
    // Telegram drops a prompt past MAX_PENDING waiting jobs; the App gets the same cap as a 409
    if (this.waitingCount() >= MAX_API_QUEUE) {
      throw new ApiError(409, `待处理消息过多（最多排队 ${MAX_API_QUEUE} 条），请等待当前任务完成或发送 /stop 取消。`)
    }
    const id = `t${Date.now().toString(36)}${++this.#sequence}`
    const engine = engineOverride ?? this.#deps.store.getEngine(this.#appKey)
    const profile = engine === "opencode" ? undefined : this.#deps.agents.registry.get(engine)
    if (!profile && engine !== "opencode") {
      throw new ApiError(400, `未知的 Agent 引擎：${engine}`)
    }
    const task: ApiTask = {
      id,
      key: this.#appKey,
      status: "queued",
      text,
      engine,
      model: modelOverride,
      createdAt: Date.now(),
      attachments,
    }
    // Validate the pin now so a bad name answers 400 like POST /model does, instead of
    // queueing a task that can only fail later. OpenCode needs the full reference.
    if (modelOverride) {
      if (engine === "opencode") {
        let info: ModelInfo
        try {
          info = this.#deps.models.resolveModel(modelOverride)
        } catch (err) {
          throw new ApiError(400, err instanceof Error ? err.message : `未识别的模型：${modelOverride}`)
        }
        task.modelRef = { providerID: info.providerID, modelID: info.modelID, label: info.label }
      } else if (!this.#deps.agents.registry.resolveModel(engine, modelOverride)) {
        const options = (profile?.models ?? []).map((model) => model.id).join(", ")
        throw new ApiError(400, options ? `未知的模型，可用：${options}` : "该引擎不支持指定模型")
      }
    }
    this.#tasks.set(id, task)
    this.#pruneTasks()

    const previous = this.#queues.get(task.key) ?? Promise.resolve()
    const run = previous.then(
      () => this.#runTask(task),
      () => this.#runTask(task),
    )
    this.#queues.set(task.key, run)
    const cleanup = (): void => {
      if (this.#queues.get(task.key) === run) this.#queues.delete(task.key)
    }
    run.then(cleanup, cleanup)
    return task
  }

  async #runTask(task: ApiTask): Promise<void> {
    if (task.status === "cancelled") return
    task.status = "running"
    task.startedAt = Date.now()
    this.#emitTask(task, true)
    const controller = new AbortController()
    task.controller = controller
    const engine = task.engine
    const isOpencode = engine === "opencode"
    const started = Date.now()
    let outcome: UsageOutcome = "failed"
    let modelLabel: string | undefined

    try {
      let opencodeModel: ResolvedModel | undefined
      if (!isOpencode) {
        const profile = this.#deps.agents.registry.get(engine)
        if (!profile) throw new Error(`未知的 Agent 引擎：${engine}`)
        const resolvedModel =
          task.model ?? this.#deps.store.getCliModel(task.key, engine) ?? this.#deps.agents.registry.defaultModel(engine)
        modelLabel = this.#deps.agents.registry.modelLabel(engine, resolvedModel ?? "")
        task.model = task.model ?? resolvedModel
      } else {
        opencodeModel =
          task.modelRef ?? resolveOpencodeModel(this.#deps.store, this.#deps.cfg.opencode.model, task.key)
        modelLabel = opencodeModel.label
      }

      let input: { text: string; files: PromptFile[] } = { text: task.text, files: [] }
      if (task.attachments?.length) {
        const caps = isOpencode ? await this.#deps.oc.inputCapabilities(opencodeModel) : undefined
        const { saved, failed } = this.#saveAttachments(task.attachments)
        const stt = await applyStt(saved, { stt: this.#deps.cfg.stt, modelCapabilities: caps })
        input = buildAttachmentSections(task.text, { saved: stt.saved, failed: [...failed, ...stt.errors], modelCapabilities: caps })
      }

      const reply = await callEngine(this.#engineDeps, {
        key: task.key,
        engine,
        text: input.text,
        files: input.files,
        model: opencodeModel,
        cliModel: isOpencode ? undefined : (task.model ?? undefined),
        signal: controller.signal,
        onProgress: (summary) => {
          task.progress = summary
          this.#emitTask(task)
        },
      })
      const settled = this.#settleReply(reply)
      task.reply = settled.text
      task.media = settled.media
      task.status = "done"
      outcome = "ok"
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (/已取消当前任务/.test(detail)) {
        task.status = "cancelled"
        outcome = "cancelled"
      } else {
        task.status = "failed"
        task.error = redactSecrets(detail).slice(0, 2000)
      }
    } finally {
      task.finishedAt = Date.now()
      task.controller = undefined
      this.#deps.usage.record(task.key, { engine, model: modelLabel, ms: Date.now() - started, outcome })
      this.#deps.history.record(task.key, {
        prompt: task.text || this.#attachmentSummary(task.attachments),
        engine,
        model: modelLabel,
        ms: Date.now() - started,
        outcome,
        scheduled: false,
      })
      // One terminal snapshot (reply/error + status + finishedAt) for SSE subscribers
      this.#emitTask(task, true)
    }
  }

  /** History label for an attachment-only task, which has no prompt text of its own. */
  #attachmentSummary(attachments?: ApiAttachment[]): string {
    const kinds: string[] = []
    for (const item of attachments ?? []) {
      const kind = item.mime.startsWith("image/")
        ? "图片"
        : item.mime.startsWith("audio/")
          ? "语音"
          : item.mime === "application/pdf"
            ? "PDF"
            : "文件"
      if (!kinds.includes(kind)) kinds.push(kind)
    }
    return kinds.length > 0 ? `（${kinds.join("、")}）` : ""
  }

  /** Telegram's 「清空排队」: drops queued tasks only, leaving the running one alone. */
  clearQueue(): { cleared: string[] } {
    const cleared: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.key !== this.#appKey || task.status !== "queued") continue
      task.status = "cancelled"
      task.finishedAt = Date.now()
      this.#emitTask(task, true)
      cleared.push(task.id)
    }
    return { cleared }
  }

  stopAll(): { stopped: string[] } {
    const stopped: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.key !== this.#appKey) continue
      if (task.status === "queued") {
        task.status = "cancelled"
        task.finishedAt = Date.now()
        this.#emitTask(task, true)
        stopped.push(task.id)
      } else if (task.status === "running") {
        task.controller?.abort()
        stopped.push(task.id)
      }
    }
    return { stopped }
  }

  get #engineDeps(): EngineCallDeps {
    return {
      oc: this.#deps.oc,
      agents: this.#deps.agents,
      store: this.#deps.store,
      log: this.#deps.log,
      opencodeAgent: this.#deps.cfg.opencode.agent ?? "assistant",
      opencodeModel: this.#deps.cfg.opencode.model,
      taskTimeoutMs: this.#deps.cfg.taskTimeoutMs,
      taskMaxTimeoutMs: this.#deps.cfg.taskMaxTimeoutMs,
    }
  }

  /**
   * Pushes a task snapshot to its SSE subscribers. Progress lines can arrive
   * hundreds of times a second for verbose CLI output, so non-terminal updates
   * are throttled; status transitions always go out immediately.
   */
  #emitTask(task: ApiTask, immediate = false): void {
    const listeners = this.#taskListeners.get(task.id)
    if (!listeners || listeners.size === 0) return
    const now = Date.now()
    if (!immediate) {
      const last = this.#lastEmit.get(task.id) ?? 0
      if (now - last < 250) return
    }
    this.#lastEmit.set(task.id, now)
    const payload = JSON.stringify({ task: this.view(task) })
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch {
        // A broken subscriber is dropped by its own close handler
      }
    }
    const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled"
    if (terminal) {
      this.#taskListeners.delete(task.id)
      this.#lastEmit.delete(task.id)
    }
  }

  /** Renders the task as a server-sent-events response; ends on the terminal state. */
  streamEvents(ctx: ApiRequestContext, task: ApiTask): void {
    const { req, res } = ctx
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-content-type-options": "nosniff",
      connection: "keep-alive",
      // nginx and friends must not buffer the stream
      "x-accel-buffering": "no",
    })
    let closed = false
    const listener = (payload: string): void => {
      if (closed) return
      res.write(`data: ${payload}\n\n`)
      // The emitter drops the listener set on terminal states; end the response so
      // the client sees a clean stream close instead of waiting for a heartbeat
      if (payload.includes('"status":"done"') || payload.includes('"status":"failed"') || payload.includes('"status":"cancelled"')) {
        cleanup()
      }
    }
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n")
    }, 15_000)
    const cleanup = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      const listeners = this.#taskListeners.get(task.id)
      if (listeners) {
        listeners.delete(listener)
        if (listeners.size === 0) this.#taskListeners.delete(task.id)
      }
      res.end()
    }
    req.on("close", cleanup)
    req.on("error", cleanup)

    const listeners = this.#taskListeners.get(task.id) ?? new Set()
    listeners.add(listener)
    this.#taskListeners.set(task.id, listeners)
    // Replay the current state first so late subscribers skip the polling round-trip
    res.write(`data: ${JSON.stringify({ task: this.view(task) })}\n\n`)
  }

  view(task: ApiTask): ApiTaskView {
    const { controller: _controller, key: _key, attachments, media, ...view } = task
    return {
      ...view,
      ...(attachments?.length ? { attachmentCount: attachments.length } : {}),
      ...(media?.length
        ? {
            media: media.map((item, index) => ({
              index,
              kind: item.kind,
              label: mediaLabel(item.kind),
              name: item.name,
              size: item.size,
              remote: item.remote,
            })),
          }
        : {}),
    }
  }

  /** Strips media directives from the reply and resolves what Telegram would send. */
  #settleReply(reply: string): { text: string; media: ApiTaskMedia[] } {
    const { parts } = parseReply(reply)
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    const media: ApiTaskMedia[] = []
    for (const part of parts) {
      if (part.type !== "media") continue
      try {
        const resolved = resolveMedia(part.kind, part.target, this.#deps.cfg.outboxDir, this.#deps.cfg.maxMediaBytes)
        media.push({
          kind: part.kind,
          name: resolved.name,
          size: resolved.size,
          remote: resolved.isUrl,
          target: resolved.target,
        })
      } catch (err) {
        this.#deps.log.warn(
          `api media skipped (${part.kind}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return { text, media }
  }

  /** Streams one media item produced by a finished task; same auth as every other endpoint. */
  async sendMedia(ctx: ApiRequestContext, id: string, index: number): Promise<void> {
    const task = this.#tasks.get(id)
    if (!task || task.key !== this.#appKey) throw new ApiError(404, "任务不存在或已被清理")
    const item = Number.isInteger(index) ? task.media?.[index] : undefined
    if (!item) throw new ApiError(404, "媒体不存在")

    let data: Buffer
    if (item.remote) {
      const fetchMedia = this.#deps.fetchMedia
      if (!fetchMedia) throw new ApiError(503, "服务端未启用远程媒体下载")
      try {
        data = await fetchMedia(item.target)
      } catch (err) {
        throw new ApiError(
          502,
          `获取远程媒体失败：${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        )
      }
    } else {
      data = readFileSync(item.target)
    }

    ctx.res.writeHead(200, {
      "Content-Type": mimeForName(item.name),
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    })
    ctx.res.end(data)
  }

  #pruneTasks(): void {
    if (this.#tasks.size <= MAX_TASK_RECORDS) return
    const finished = [...this.#tasks.values()]
      .filter((task) => task.status !== "queued" && task.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
    for (const task of finished) {
      if (this.#tasks.size <= MAX_TASK_RECORDS) break
      this.#tasks.delete(task.id)
      // Pending SSE subscribers and throttle timestamps are keyed by task id too.
      this.#taskListeners.delete(task.id)
      this.#lastEmit.delete(task.id)
    }
  }


  get(id: string): ApiTask | undefined {
    return this.#tasks.get(id)
  }

  list(limit: number): ApiTask[] {
    return [...this.#tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  queue(): ApiTask[] {
    return [...this.#tasks.values()]
      .filter((task) => task.key === this.#appKey && (task.status === "queued" || task.status === "running"))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  activeTasks(): ApiTask[] {
    return [...this.#tasks.values()].filter((task) => task.status === "queued" || task.status === "running")
  }

  get total(): number {
    return this.#tasks.size
  }

  stopTask(id: string): ApiTask {
    const task = this.#tasks.get(id)
    if (!task || task.key !== this.#appKey) throw new ApiError(404, "任务不存在或已被清理")
    if (task.status === "queued") {
      task.status = "cancelled"
      task.finishedAt = Date.now()
      this.#emitTask(task, true)
    } else if (task.status === "running") {
      task.controller?.abort()
    } else {
      throw new ApiError(409, "任务已经结束")
    }
    return task
  }
}
