import { readFileSync, unlinkSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import type { ApiRequestContext } from "./apiCore.js"
import { ApiError } from "./apiCore.js"
import type { AgentCliService } from "./agentCli.js"
import type { AgentModelCatalog } from "./agentModelCatalog.js"
import { buildAttachmentSections } from "./attachmentInput.js"
import { multipartParts, readMultipartPart } from "./multipart.js"
import {
  attachmentKind,
  isTextAttachment,
  pruneInbox,
  readTextAttachment,
  saveAttachment,
  saveAttachmentStream,
  type SavedAttachment,
} from "./attachments.js"
import type { BotConfig } from "./config.js"
import { callEngine, resolveOpencodeModel, type EngineCallDeps, type ResolvedModel } from "./engineCall.js"
import type { TaskHistoryStore } from "./history.js"
import type { Logger } from "./logger.js"
import { mediaLabel, parseReply, resolveMedia } from "./media.js"
import type { ModelAdmin } from "./modelAdmin.js"
import type { Opencode, PromptFile } from "./opencode.js"
import { applyStt } from "./stt.js"
import type { SessionStore } from "./store.js"
import type { UsageOutcome, UsageStore } from "./usage.js"
import { redactSecrets } from "./ccswitch.js"
import { mimeForName } from "./apiHttp.js"
import type { ApiAttachment, ApiTask, ApiTaskMedia, ApiTaskView } from "./apiTaskTypes.js"
import { classifyTaskError } from "./taskErrors.js"
import { logApiTaskTerminal } from "./taskTerminalLog.js"

const MAX_API_ATTACHMENTS = 4
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
export const MAX_TASK_RECORDS = 200
const MAX_API_QUEUE = 4
const OPENCODE_HEALTH_CACHE_MS = 10_000

export interface TaskManagerDeps {
  cfg: BotConfig
  oc: Opencode
  agents: AgentCliService
  store: SessionStore
  log: Logger
  usage: UsageStore
  history: TaskHistoryStore
  models: ModelAdmin
  agentModels?: AgentModelCatalog
  /** Live owner chat; the API server may learn it after startup (e.g. first Feishu message). */
  ownerChatId?: number | (() => number | undefined)
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
  #opencodeHealthAt = 0
  #opencodeHealthy = false

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

  /** Accepts the client's attachment list: base64-decodable, sane names/mimes, at most 4 files. */
  parseAttachments(raw: unknown): ApiAttachment[] | undefined {
    if (raw === undefined || raw === null) return undefined
    if (!Array.isArray(raw)) throw new ApiError(400, "attachments 必须是数组")
    if (raw.length > MAX_API_ATTACHMENTS) {
      throw new ApiError(400, `附件最多 ${MAX_API_ATTACHMENTS} 个`)
    }
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
      return { name, mime: mime.toLowerCase(), data: stripped }
    })
    return parsed.length > 0 ? parsed : undefined
  }

  /** Persists API attachments into the same inbox the Telegram flow uses. */
  #saveAttachments(attachments: ApiAttachment[]): { saved: SavedAttachment[]; failed: string[] } {
    const owner = this.#deps.ownerChatId
    const chatId = (typeof owner === "function" ? owner() : owner) ?? 0
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
        const kind = attachmentKind(att.mime, stored.name)
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

  /**
   * Streams a multipart task request. Text fields stay small; every file part is
   * written to the inbox as it arrives, so neither the request nor a video is ever
   * held in memory as one Buffer.
   */
  async parseMultipartTask(req: IncomingMessage, boundary: string): Promise<{
    text: string
    engine?: string
    model?: string
    attachments?: SavedAttachment[]
    failed: string[]
  }> {
    const fields = new Map<string, string>()
    const owner = this.#deps.ownerChatId
    const chatId = (typeof owner === "function" ? owner() : owner) ?? 0
    const attachments: SavedAttachment[] = []
    const failed: string[] = []
    let fileCount = 0
    try {
      for await (const part of multipartParts(req, boundary)) {
        if (part.filename === undefined) {
          fields.set(part.name, (await readMultipartPart(part.data)).toString("utf8").trim())
          continue
        }
        const index = /^file(\d+)$/.exec(part.name)?.[1]
        if (index === undefined) {
          await readMultipartPart(part.data)
          continue
        }
        fileCount += 1
        if (fileCount > MAX_API_ATTACHMENTS) {
          // Drain this part so the parser reaches the boundary, then reject the
          // request. The first four files are removed by the catch below.
          await readMultipartPart(part.data)
          throw new ApiError(400, `附件最多 ${MAX_API_ATTACHMENTS} 个`)
        }

        const name = part.filename || `file${index}.bin`
        const mime = part.contentType?.trim() || "application/octet-stream"
        if (!MIME_RE.test(mime)) {
          failed.push(`${name}: mime 无效`)
          await readMultipartPart(part.data)
          continue
        }
        try {
          const stored = await saveAttachmentStream(this.#deps.cfg.inboxDir, chatId, name, part.data)
          const kind = attachmentKind(mime, stored.name)
          const record: SavedAttachment = {
            fileId: "",
            kind,
            name: stored.name,
            mime: mime.toLowerCase(),
            path: stored.path,
            bytes: stored.bytes,
          }
          if (isTextAttachment(mime, stored.name)) {
            try {
              const { text: inline, truncated } = readTextAttachment(stored.path)
              record.text = inline
              record.truncated = truncated
            } catch {
              // binary fallback
            }
          }
          attachments.push(record)
        } catch (err) {
          failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const text = fields.get("text") ?? ""
      const engine = fields.get("engine") || undefined
      const model = fields.get("model") || undefined
      if (text.length > 12_000) {
        throw new ApiError(400, "消息太长（上限 12000 字），请分段发送")
      }
      // A bad engine/model pin must not leave this request's uploads behind.
      await this.#select(engine, model)
      pruneInbox(this.#deps.cfg.inboxDir)
      return {
        text,
        engine,
        model,
        attachments: attachments.length > 0 ? attachments : undefined,
        failed,
      }
    } catch (err) {
      this.#discardSaved(attachments)
      throw err
    }
  }

  /** Deletes only this submit's newly-written inbox files after a later rejection. */
  #discardSaved(attachments: SavedAttachment[] | undefined): void {
    for (const item of attachments ?? []) {
      try {
        unlinkSync(item.path)
      } catch {
        // already pruned or never created
      }
    }
  }

  /** Submits already-persisted attachments, used by the multipart path. */
  async submitSaved(text: string, engineOverride?: string, modelOverride?: string, saved?: SavedAttachment[], failed: string[] = []): Promise<ApiTask> {
    try {
      if (this.waitingCount() >= MAX_API_QUEUE) {
        throw new ApiError(409, `待处理消息过多（最多排队 ${MAX_API_QUEUE} 条），请等待当前任务完成或发送 /stop 取消。`)
      }
      const selection = await this.#select(engineOverride, modelOverride)
      const promptText = failed.length > 0 ? [text, `[附件处理失败]\n${failed.join("\n")}`].filter(Boolean).join("\n\n") : text
      return this.#submit(text, modelOverride, saved ?? [], promptText, selection)
    } catch (err) {
      this.#discardSaved(saved)
      throw err
    }
  }

  async submit(text: string, engineOverride?: string, modelOverride?: string, attachments?: ApiAttachment[]): Promise<ApiTask> {
    if (this.waitingCount() >= MAX_API_QUEUE) {
      throw new ApiError(409, `待处理消息过多（最多排队 ${MAX_API_QUEUE} 条），请等待当前任务完成或发送 /stop 取消。`)
    }
    const selection = await this.#select(engineOverride, modelOverride)
    const { saved: savedAttachments, failed: saveFailed } = attachments
      ? this.#saveAttachments(attachments)
      : { saved: [], failed: [] }
    const promptText =
      saveFailed.length > 0 ? [text, `[附件处理失败]\n${saveFailed.join("\n")}`].filter(Boolean).join("\n\n") : text
    return this.#submit(text, modelOverride, savedAttachments, promptText, selection)
  }

  /** Validates the engine and model pin before any upload is persisted. */
  async #select(engineOverride: string | undefined, modelOverride: string | undefined): Promise<{
    engine: string
    autoEngine: boolean
    cliModel?: string
    modelRef?: ResolvedModel
  }> {
    const explicitEngine = engineOverride?.trim() || this.#deps.store.getExplicitEngine(this.#appKey)
    const engine = explicitEngine ?? "opencode"
    const autoEngine = explicitEngine === undefined
    const profile = engine === "opencode" ? undefined : this.#deps.agents.registry.get(engine)
    if (!profile && engine !== "opencode") throw new ApiError(400, `未知的 Agent 引擎：${engine}`)
    let modelRef: ResolvedModel | undefined
    let cliModel: string | undefined
    if (modelOverride) {
      if (engine === "opencode") {
        try {
          const info = this.#deps.models.resolveModel(modelOverride)
          modelRef = { providerID: info.providerID, modelID: info.modelID, label: info.label }
        } catch (err) {
          throw new ApiError(400, err instanceof Error ? err.message : `未识别的模型：${modelOverride}`)
        }
      } else {
        const catalog = this.#deps.agentModels
        const resolved = catalog ? await catalog.list(engine) : undefined
        const chosen = catalog
          ? catalog.resolve(engine, modelOverride)
          : this.#deps.agents.registry.resolveModel(engine, modelOverride)
        if (!chosen) {
          const detail = resolved?.hint ? `（${resolved.hint}）` : ""
          throw new ApiError(400, `未知的模型：${modelOverride}${detail}。可直接传模型 ID。`)
        }
        // Persist the catalog's canonical id (including case), not the user's alias. The
        // CLI receives this value verbatim on every retry and scheduled task.
        cliModel = chosen
      }
    }
    return { engine, autoEngine, cliModel, modelRef }
  }

  #submit(
    text: string,
    modelOverride: string | undefined,
    savedAttachments: SavedAttachment[],
    promptText: string,
    selection: { engine: string; autoEngine: boolean; cliModel?: string; modelRef?: ResolvedModel },
  ): ApiTask {
    const id = `t${Date.now().toString(36)}${++this.#sequence}`
    const task: ApiTask = {
      id,
      key: this.#appKey,
      status: "queued",
      text: promptText,
      engine: selection.engine,
      autoEngine: selection.autoEngine,
      model: selection.cliModel ?? modelOverride,
      modelRef: selection.modelRef,
      createdAt: Date.now(),
      savedAttachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    }
    this.#tasks.set(id, task)
    this.#pruneTasks()
    const previous = this.#queues.get(task.key) ?? Promise.resolve()
    const run = previous.then(() => this.#runTask(task), () => this.#runTask(task))
    this.#queues.set(task.key, run)
    const cleanup = (): void => {
      if (this.#queues.get(task.key) === run) this.#queues.delete(task.key)
    }
    run.then(cleanup, cleanup)
    return task
  }

  async #runTask(task: ApiTask): Promise<void> {
    if (task.status === "cancelled") return

    // A brand-new session has no explicit engine and therefore starts on OpenCode. If
    // that server is not running, every task would fail in milliseconds before any model
    // is reached. Only this implicit default may fall back; a user who chose OpenCode
    // explicitly keeps it, even when the health probe is down, so the error is truthful.
    if (task.autoEngine && task.engine === "opencode" && !task.model) {
      const healthy = await this.#opencodeIsHealthy()
      if (!healthy) {
        const fallback = this.#fallbackEngine()
        if (fallback) {
          task.engine = fallback
          task.engineNote = `OpenCode 未运行，本次自动使用 ${this.#deps.agents.registry.label(fallback)}`
        }
      }
    }
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
    let failureDetail: string | undefined

    try {
      let opencodeModel: ResolvedModel | undefined
      if (!isOpencode) {
        const profile = this.#deps.agents.registry.get(engine)
        if (!profile) throw new Error(`未知的 Agent 引擎：${engine}`)
        const resolvedModel = task.model ?? this.#deps.store.getCliModel(task.key, engine)
        modelLabel = resolvedModel ? this.#deps.agents.registry.modelLabel(engine, resolvedModel) : undefined
        task.model = task.model ?? resolvedModel
      } else {
        opencodeModel = task.modelRef ?? resolveOpencodeModel(this.#deps.store, task.key)
        modelLabel = opencodeModel?.label
      }

      let input: { text: string; files: PromptFile[] } = { text: task.text, files: [] }
      if (task.savedAttachments?.length) {
        const caps = isOpencode ? await this.#deps.oc.inputCapabilities(opencodeModel) : undefined
        const stt = await applyStt(task.savedAttachments, {
          stt: this.#deps.cfg.stt,
          modelCapabilities: caps,
        })
        input = buildAttachmentSections(task.text, { saved: stt.saved, failed: stt.errors, modelCapabilities: caps })
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
        task.errorCode = "TASK_CANCELLED"
        failureDetail = redactSecrets(detail).replace(/\s+/g, " ").slice(0, 300)
        outcome = "cancelled"
      } else {
        task.status = "failed"
        task.error = redactSecrets(detail).slice(0, 2000)
        task.errorCode = classifyTaskError(detail)
        failureDetail = task.error
      }
    } finally {
      task.finishedAt = Date.now()
      task.controller = undefined
      this.#deps.usage.record(task.key, { engine, model: modelLabel, ms: Date.now() - started, outcome })
      this.#deps.history.record(task.key, {
        prompt: task.text || this.#attachmentSummary(task.savedAttachments),
        engine,
        model: modelLabel,
        ms: Date.now() - started,
        outcome,
        errorCode: outcome === "ok" ? undefined : (task.errorCode ?? classifyTaskError(failureDetail ?? "")),
        detail: failureDetail,
        scheduled: false,
      })
      logApiTaskTerminal(
        {
          log: this.#deps.log,
          session: (engine) => this.#deps.store.getCliSession(task.key, engine) ?? this.#deps.store.get(task.key),
        },
        task,
        outcome,
        failureDetail,
        started,
      )
      // One terminal snapshot (reply/error + status + finishedAt) for SSE subscribers
      this.#emitTask(task, true)
    }
  }

  async #opencodeIsHealthy(): Promise<boolean> {
    if (Date.now() - this.#opencodeHealthAt < OPENCODE_HEALTH_CACHE_MS) return this.#opencodeHealthy
    this.#opencodeHealthAt = Date.now()
    this.#opencodeHealthy = await this.#deps.oc.health().catch(() => false)
    return this.#opencodeHealthy
  }

  /** Codex first because it is the most common replacement, then any installed CLI profile. */
  #fallbackEngine(): string | undefined {
    const registry = this.#deps.agents.registry
    const profiles = registry.list()
    const codex = profiles.find((profile) => profile.id === "codex" && registry.binPath(profile))
    if (codex) return codex.id
    return profiles.find((profile) => registry.binPath(profile))?.id
  }

  /** History label for an attachment-only task, which has no prompt text of its own. */
  #attachmentSummary(attachments?: SavedAttachment[]): string {
    const kinds: string[] = []
    for (const item of attachments ?? []) {
      const kind = item.kind === "image"
        ? "图片"
        : item.kind === "audio"
          ? "语音"
          : item.kind === "video"
            ? "视频"
            : item.mime === "application/pdf"
              ? "PDF"
              : "文件"
      if (!kinds.includes(kind)) kinds.push(kind)
    }
    return kinds.length > 0 ? `（${kinds.join("、")}）` : ""
  }

  /**
   * A queued task never entered #runTask, so it has no terminal log and no error code yet.
   * Record both here: otherwise the App shows a bare "已停止" with no diagnosis and an
   * operator grepping bot.log sees nothing at all for the message the user just cancelled.
   */
  #cancelQueued(task: ApiTask): void {
    task.status = "cancelled"
    task.errorCode = "TASK_CANCELLED"
    task.finishedAt = Date.now()
    logApiTaskTerminal(
      {
        log: this.#deps.log,
        session: (engine) => this.#deps.store.getCliSession(task.key, engine) ?? this.#deps.store.get(task.key),
      },
      task,
      "cancelled",
      undefined,
      task.createdAt,
    )
    this.#emitTask(task, true)
  }

  /** Telegram's 「清空排队」: drops queued tasks only, leaving the running one alone. */
  clearQueue(): { cleared: string[] } {
    const cleared: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.key !== this.#appKey || task.status !== "queued") continue
      this.#cancelQueued(task)
      cleared.push(task.id)
    }
    return { cleared }
  }

  stopAll(): { stopped: string[] } {
    const stopped: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.key !== this.#appKey) continue
      if (task.status === "queued") {
        this.#cancelQueued(task)
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
      // The emitter drops the listener set on terminal states; end the response so the client
      // sees a clean stream close instead of waiting for a heartbeat. This reads the task's own
      // state rather than pattern-matching the serialized frame: today the frame's escaping keeps
      // a CLI that prints {"status":"done"} from matching, but any change to how the frame is
      // built would turn that coincidence into a live stream cut at its first frame.
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
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
    const { controller: _controller, key: _key, autoEngine: _autoEngine, savedAttachments, media, ...view } = task
    return {
      ...view,
      ...(savedAttachments?.length ? { attachmentCount: savedAttachments.length } : {}),
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
    const { parts, dropped } = parseReply(reply)
    let text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    const media: ApiTaskMedia[] = []
    const warnings: string[] = []
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
        const detail = redactSecrets(err instanceof Error ? err.message : String(err))
        this.#deps.log.warn(`api media skipped (${part.kind}): ${detail}`)
        // Telegram sends "⚠️ 图片发送失败：…" as its own message. Silence here would leave the
        // App with an answer that just stops short of the attachment the user asked for.
        warnings.push(`⚠️ ${mediaLabel(part.kind)}发送失败：${detail}`)
      }
    }
    if (dropped > 0) warnings.push(`⚠️ 有 ${dropped} 个附件标记无法识别或超出 5 个上限，已忽略`)
    if (warnings.length > 0) text = [text, ...warnings].filter(Boolean).join("\n")
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
      // The path was safe when the reply settled, not necessarily now: outbox files
      // are writable during the task's lifetime. Re-run the same containment, file
      // type and size checks against the current path before reading anything.
      let resolved: ReturnType<typeof resolveMedia>
      try {
        resolved = resolveMedia(item.kind, item.target, this.#deps.cfg.outboxDir, this.#deps.cfg.maxMediaBytes)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        if (detail.includes("不存在")) throw new ApiError(410, "媒体文件已从 outbox 清理")
        if (detail.includes("超过")) throw new ApiError(413, detail)
        throw new ApiError(410, `媒体文件已不可用：${detail}`)
      }
      try {
        data = readFileSync(resolved.hostPath ?? resolved.target)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") throw new ApiError(410, "媒体文件已从 outbox 清理")
        throw err
      }
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
      this.#cancelQueued(task)
    } else if (task.status === "running") {
      task.controller?.abort()
    } else {
      throw new ApiError(409, "任务已经结束")
    }
    return task
  }
}
