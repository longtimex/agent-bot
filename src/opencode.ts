import type { ModelRef } from "./config.js"
import { clip } from "./messages.js"
import { pathToFileURL } from "node:url"
import { Agent, fetch, type Dispatcher } from "undici"

export class OpencodeError extends Error {
  /** HTTP status when the failure came from a responded request, otherwise undefined. */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "OpencodeError"
    this.status = status
  }
}

interface Part {
  type: string
  text?: string
}

interface MessageInfo {
  error?: {
    name?: string
    data?: { message?: string }
  } | null
}

interface PromptResponse {
  info?: MessageInfo
  parts?: Part[]
}

interface SessionStatus {
  type?: string
}

export interface PromptFile {
  mime: string
  filename: string
  /** Absolute local path. OpenCode materializes it itself via a file:// attachment. */
  path: string
  /** Known size, used only to respect OpenCode's own attachment ceiling. */
  size?: number
}

/** OpenCode refuses a single direct attachment above this; it is an upstream bound, not ours. */
export const OPENCODE_ATTACHMENT_LIMIT = 20 * 1024 * 1024

export interface ModelInputs {
  image: boolean
  audio: boolean
  video: boolean
  pdf: boolean
}

interface OpencodeFeedSubscriber {
  sessionID: string
  onUpdate: (summary: string) => void
}

interface OpencodeFeed {
  controller: AbortController
  closed: boolean
}

/** Turn one broadcast event into a progress line for one session, or nothing. */
function eventStatus(
  ev: { properties?: Record<string, unknown> },
  sessionID: string,
): string | undefined {
  const properties = ev.properties ?? {}
  const part = properties.part as Record<string, unknown> | undefined
  if (!part) return undefined
  // Part events carry the session id on the part itself
  if ((properties.sessionID ?? part.sessionID) !== sessionID) return undefined

  if (part.type === "tool") {
    const tool = String(part.tool || "")
    const state = (part.state as Record<string, unknown>) || {}
    const input = (state.input as Record<string, unknown>) || {}
    const status = String(state.status || "running")
    const detail = String(input.command || input.filePath || input.pattern || input.query || "")
    const shortDetail = detail ? `: ${clip(detail.replace(/\s+/g, " "), 40)}` : ""
    const action = status === "completed" ? "完成" : "执行"
    return `${action} [${tool}]${shortDetail}`
  }
  if (part.type === "reasoning") return "正在思考与逻辑分析..."
  if (part.type === "text") return "正在组织输出回答..."
  return undefined
}

export interface PromptOptions {
  agent?: string
  model?: ModelRef
  idleTimeoutMs?: number
  /** `0` disables the wall-clock ceiling; the idle watchdog still applies. */
  maxTimeoutMs?: number
  onActivityHook?: (touch: () => void) => void
  signal?: AbortSignal
  files?: PromptFile[]
}

interface ProviderList {
  all?: Array<{
    id: string
    models?: Record<string, { capabilities?: { input?: Record<string, boolean> } }>
  }>
}

const DEFAULT_TASK_TIMEOUT_MS = 600_000
const CONTROL_TIMEOUT_MS = 15_000
/** A status probe must finish well inside the idle window, not hold the task open. */
const STATUS_PROBE_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/**
 * OpenCode holds the `/message` response until the whole turn finishes. undici's
 * default five-minute headers timeout therefore kills a healthy long task before
 * the bot's own idle/wall-clock watchdogs can decide. Those watchdogs are the
 * product-level timeout; the HTTP layer only needs to bound ordinary control
 * requests (which still pass AbortSignal.timeout explicitly).
 */
export const OPENCODE_HTTP_TIMEOUT_MS = 0

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * Upstream bodies are flattened before they reach a log line or the chat: an error
 * message that carries newlines lets a broken server forge log entries, and escape
 * sequences would be echoed back to the user.
 */
export function oneLine(value: string, max: number): string {
  return clip(value.replace(CONTROL_CHARS, " "), max) ?? ""
}

function describeDuration(ms: number): string {
  if (ms >= 3_600_000) {
    const hours = ms / 3_600_000
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
  }
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${Math.max(1, Math.round(ms / 1_000))} 秒`
}

export function describeFetchError(err: unknown): string | undefined {
  const codes: string[] = []
  const messages: string[] = []

  const collect = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || depth > 4) return
    const node = value as { code?: string; message?: string; cause?: unknown; errors?: unknown }
    if (node.code) codes.push(node.code)
    else if (node.message) messages.push(node.message)
    if (Array.isArray(node.errors)) {
      for (const sub of node.errors) collect(sub, depth + 1)
    } else if (node.cause) {
      collect(node.cause, depth + 1)
    }
  }

  collect((err as { cause?: unknown } | undefined)?.cause)
  const parts = [...new Set(codes.length > 0 ? codes : messages)]
  return parts.length > 0 ? parts.join(" / ") : undefined
}

export class Opencode {
  readonly #baseUrl: string
  readonly #authorization?: string
  readonly #dispatcher: Dispatcher
  readonly #ownsDispatcher: boolean
  readonly #fetch: typeof fetch
  #capabilities = new Map<string, ModelInputs>()
  #capabilitiesAt = 0

  constructor(
    baseUrl: string,
    username: string,
    password: string | undefined,
    options: {
      dispatcher?: Dispatcher
      headersTimeoutMs?: number
      bodyTimeoutMs?: number
      fetch?: typeof fetch
    } = {},
  ) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "")
    this.#authorization = password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      : undefined
    this.#ownsDispatcher = options.dispatcher === undefined
    this.#fetch = options.fetch ?? fetch
    this.#dispatcher =
      options.dispatcher ??
      new Agent({
        headersTimeout: options.headersTimeoutMs ?? OPENCODE_HTTP_TIMEOUT_MS,
        bodyTimeout: options.bodyTimeoutMs ?? OPENCODE_HTTP_TIMEOUT_MS,
      })
  }

  /** Release keep-alive sockets; the process normally lives as long as the bot. */
  async close(): Promise<void> {
    if (this.#ownsDispatcher) await this.#dispatcher.close().catch(() => {})
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/global/health`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
        dispatcher: this.#dispatcher,
      })
      if (!res.ok) {
        // An unread body holds the pooled connection open
        await res.body?.cancel().catch(() => {})
        return false
      }
      const body = (await res.json()) as { healthy?: boolean }
      return body.healthy === true
    } catch {
      return false
    }
  }

  async createSession(title: string): Promise<string> {
    const session = await this.#request<{ id?: string }>("POST", "/session", { title }, CONTROL_TIMEOUT_MS)
    if (!session?.id) throw new OpencodeError("创建会话失败：OpenCode 没有返回会话 ID")
    return session.id
  }

  async deleteSession(sessionID: string): Promise<void> {
    try {
      await this.#request("DELETE", `/session/${encodeURIComponent(sessionID)}`, undefined, CONTROL_TIMEOUT_MS)
    } catch {
      // a missing session is fine to ignore
    }
  }

  async abortSession(sessionID: string): Promise<void> {
    await this.#request("POST", `/session/${encodeURIComponent(sessionID)}/abort`, undefined, 10_000)
  }

  // Best-effort lookup of the modalities a model accepts; used to avoid sending
  // attachments that the current model would silently drop.
  async inputCapabilities(model?: ModelRef): Promise<ModelInputs | undefined> {
    if (!model) return undefined
    if (Date.now() - this.#capabilitiesAt > 60_000) {
      // Stamp the attempt even when /provider fails, so a backend that is down or
      // slow is not re-polled with a fresh 10s timeout on every attachment
      this.#capabilitiesAt = Date.now()
      try {
        const body = await this.#request<ProviderList>("GET", "/provider", undefined, 10_000)
        const next = new Map<string, ModelInputs>()
        for (const provider of body?.all ?? []) {
          for (const [id, info] of Object.entries(provider.models ?? {})) {
            const input = info.capabilities?.input
            next.set(`${provider.id}/${id}`, {
              image: input?.image === true,
              audio: input?.audio === true,
              video: input?.video === true,
              pdf: input?.pdf === true,
            })
          }
        }
        this.#capabilities = next
      } catch {
        // keep the previous cache; capability detection is best-effort
      }
    }
    return this.#capabilities.get(`${model.providerID}/${model.modelID}`)
  }

  /**
   * One `/event` connection per bot process, fanned out to the sessions that asked for it.
   * OpenCode broadcasts every session's events to every connection, so a stream per chat
   * multiplied connections *and* the JSON parsing of unrelated traffic.
   */
  #feed?: OpencodeFeed
  readonly #feedSubs = new Map<number, OpencodeFeedSubscriber>()
  #feedSeq = 0

  subscribeSession(sessionID: string, onUpdate: (summary: string) => void): () => void {
    const id = ++this.#feedSeq
    this.#feedSubs.set(id, { sessionID, onUpdate })
    this.#startFeed()
    return () => {
      this.#feedSubs.delete(id)
      if (this.#feedSubs.size === 0) this.#stopFeed()
    }
  }

  #startFeed(): void {
    if (this.#feed) return
    const feed: OpencodeFeed = { controller: new AbortController(), closed: false }
    this.#feed = feed
    const { controller } = feed

    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (controller.signal.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(done, ms)
        function done(): void {
          clearTimeout(timer)
          controller.signal.removeEventListener("abort", done)
          resolve()
        }
        controller.signal.addEventListener("abort", done, { once: true })
      })

    const dispatch = (ev: { properties?: Record<string, unknown> }): void => {
      // Snapshot: an onUpdate that unsubscribes would otherwise shrink the Map mid-iteration
      // and silently skip the subscribers behind the one that left.
      const subs = Array.from(this.#feedSubs.values())
      for (const sub of subs) {
        const status = eventStatus(ev, sub.sessionID)
        if (!status) continue
        try {
          sub.onUpdate(status)
        } catch {
          // One subscriber's progress card must not break the stream for the others
        }
      }
    }

    // One SSE event can never legitimately be this large; the cap is what stops a
    // peer that sends no newline (or a truncated JSON blob) from growing the buffer
    // until the process is killed.
    const MAX_EVENT_BYTES = 1_000_000

    const connect = async (): Promise<void> => {
      let failures = 0
      while (!feed.closed) {
        try {
          const res = await this.#fetch(`${this.#baseUrl}/event`, {
            headers: this.#headers(),
            signal: controller.signal,
            dispatcher: this.#dispatcher,
          })
          if (!res.ok || !res.body) {
            // A rejected stream answers with a body (401 on a wrong password); leaving it
            // unread pins a connection per reconnect in this never-ending loop
            await res.body?.cancel().catch(() => {})
            throw new Error(`event stream HTTP ${res.status}`)
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          let pending = ""
          // A 200 that closes before sending a byte (captive portal, broken proxy) is
          // as dead as a refused connection; only delivered data proves the stream
          // works, so the backoff is not reset by the bare response
          let delivered = false

          const emit = (line: string): void => {
            // SSE allows `data:{...}` with no space, and \r\n framing survives as a
            // trailing \r that trim() removes
            if (line.startsWith("data:")) {
              const raw = line.slice(5).trim()
              if (!raw) return
              // An event's payload may be split over several data: lines, which the spec
              // joins with newlines before dispatching; parsing each line alone drops them
              const candidate = pending ? `${pending}\n${raw}` : raw
              if (candidate.length > MAX_EVENT_BYTES) {
                pending = ""
                return
              }
              let ev: { properties?: Record<string, unknown> }
              try {
                ev = JSON.parse(candidate) as { properties?: Record<string, unknown> }
              } catch {
                pending = candidate
                return
              }
              pending = ""
              dispatch(ev)
              return
            }
            if (pending) pending = ""
          }

          try {
            while (!feed.closed) {
              const { done, value } = await reader.read()
              if (done) break
              if (!delivered) {
                delivered = true
                failures = 0
              }
              buffer += decoder.decode(value, { stream: true })
              if (buffer.length > MAX_EVENT_BYTES) break
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""
              for (const line of lines) emit(line)
            }
            buffer += decoder.decode()
            if (!feed.closed && buffer && buffer.length <= MAX_EVENT_BYTES) emit(buffer)
          } finally {
            // Cancel so the connection goes back to the pool instead of draining into a
            // reader nobody is waiting on
            await reader.cancel().catch(() => {})
            try {
              reader.releaseLock()
            } catch {
              // stream already torn down
            }
          }
        } catch {
          // aborted or network error; reconnect below unless closed
        }

        if (feed.closed) return
        // A dead event stream must not look like an idle task, otherwise the
        // watchdog aborts work that is still running on the server
        failures += 1
        await wait(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)))
      }
    }

    void connect()
  }

  #stopFeed(): void {
    const feed = this.#feed
    if (!feed) return
    this.#feed = undefined
    feed.closed = true
    feed.controller.abort()
  }

  async prompt(sessionID: string, text: string, options: PromptOptions = {}): Promise<string> {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text }]
    for (const file of options.files ?? []) {
      // OpenCode rejects direct attachments above its own 20MB ceiling. For a
      // larger file the manifest still carries its absolute path, and the agent
      // can read it with its normal file tools instead of the whole task failing.
      if (file.size !== undefined && file.size > OPENCODE_ATTACHMENT_LIMIT) continue
      parts.push({
        // mime 受上游白名单约束;兜底 octet-stream 防 data URL 被空值截断
        type: "file",
        mime: file.mime || "application/octet-stream",
        filename: file.filename,
        // OpenCode reads the local file itself. Keeping the bytes out of this JSON
        // avoids a second full-size Base64 string (and its JSON copy) on the bot.
        url: pathToFileURL(file.path).href,
      })
    }

    const body: Record<string, unknown> = { parts }
    if (options.agent) body.agent = options.agent
    if (options.model) body.model = options.model

    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    const configuredMax = options.maxTimeoutMs ?? idleTimeoutMs
    const maxTimeoutMs = configuredMax > 0 ? Math.max(configuredMax, idleTimeoutMs) : 0

    const controller = new AbortController()
    let idleTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let statusTimer: NodeJS.Timeout | null = null
    let statusProbeInFlight = false
    let timeoutMessage: string | undefined
    let cancelled = false
    let settled = false

    const failWithTimeout = (message: string): void => {
      if (settled) return
      timeoutMessage = message
      // Stop server-side generation too, otherwise it keeps running after the client aborts
      void this.abortSession(sessionID).catch(() => {})
      controller.abort()
    }

    const externalSignal = options.signal
    const onExternalAbort = (): void => {
      cancelled = true
      void this.abortSession(sessionID).catch(() => {})
      controller.abort()
    }
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort()
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true })
    }

    const touchActivity = (): void => {
      // SSE updates can arrive after the request settles; arming a timer then
      // would abort an unrelated task running later in the same session
      if (settled) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        failWithTimeout(
          `执行超时：已超过 ${describeDuration(idleTimeoutMs)}未收到任何后端响应（无活动超时）。`,
        )
      }, idleTimeoutMs)
    }

    touchActivity()

    if (maxTimeoutMs > 0) {
      hardTimer = setTimeout(() => {
        failWithTimeout(
          `执行超时：任务总耗时已达到 ${describeDuration(maxTimeoutMs)}上限。`,
        )
      }, maxTimeoutMs)
    }

    /**
     * OpenCode can spend a long time inside one tool call without emitting an SSE part.
     * Treat a still-busy/retrying source session as activity, but never `idle`: an idle
     * server is precisely the stuck state the inactivity watchdog exists to catch.
     * `/session/status` is available on every supported OpenCode version; the SDK's
     * `session.status` event is only an optimisation for newer servers.
     */
    const probeStatus = async (): Promise<void> => {
      if (settled || statusProbeInFlight || cancelled) return
      statusProbeInFlight = true
      try {
        const statuses = await this.#requestWithSignal<Record<string, SessionStatus> | undefined>(
          "GET",
          "/session/status",
          undefined,
          AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
        )
        if (settled || cancelled) return
        const status = statuses?.[sessionID]
        if (status?.type === "busy" || status?.type === "retry") touchActivity()
      } catch {
        // A failed probe proves nothing about liveness; letting it extend the idle
        // window would turn a dead server into an endlessly running task.
      } finally {
        statusProbeInFlight = false
      }
    }

    if (idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs)) {
      // Half the window leaves room for network jitter and still refreshes twice
      // before the watchdog would fire; the floor keeps tiny unit-test windows useful.
      const probeIntervalMs = Math.max(100, Math.min(30_000, Math.floor(idleTimeoutMs / 2)))
      statusTimer = setInterval(() => {
        void probeStatus()
      }, probeIntervalMs)
    }

    if (options.onActivityHook) {
      options.onActivityHook(touchActivity)
    }

    let response: PromptResponse
    try {
      response =
        (await this.#requestWithSignal<PromptResponse | undefined>(
          "POST",
          `/session/${encodeURIComponent(sessionID)}/message`,
          body,
          controller.signal,
        )) ?? { parts: [] }
    } catch (err) {
      if (cancelled) throw new OpencodeError("已取消当前任务。")
      if (timeoutMessage) throw new OpencodeError(timeoutMessage)
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new OpencodeError(
          `执行超时：长任务超过时限未产生响应。已执行步骤请稍后重试或简化任务。`,
        )
      }
      // A mid-flight network failure leaves the server generating: stop it the
      // same way the timeout and cancel paths do, or the next prompt hits a busy
      // session while tokens keep burning
      void this.abortSession(sessionID).catch(() => {})
      throw err
    } finally {
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (statusTimer) clearInterval(statusTimer)
      externalSignal?.removeEventListener("abort", onExternalAbort)
    }

    const error = response.info?.error
    if (error) {
      throw new OpencodeError(`model error: ${error.data?.message ?? error.name ?? "unknown"}`)
    }

    return (response.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim()
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.#authorization) headers.authorization = this.#authorization
    return headers
  }

  async #request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  ): Promise<T> {
    return this.#requestWithSignal<T>(method, path, body, AbortSignal.timeout(timeoutMs))
  }

  async #requestWithSignal<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        dispatcher: this.#dispatcher,
      })
    } catch (err) {
      throw this.#fetchError(method, path, err)
    }

    const raw = await this.#readBody(method, path, res).catch((err: unknown) => {
      if (err instanceof OpencodeError) throw err
      throw this.#fetchError(method, path, err)
    })
    if (!res.ok) {
      throw new OpencodeError(`${method} ${path} -> ${res.status}: ${oneLine(raw, 500)}`, res.status)
    }
    if (!raw) return undefined as T
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new OpencodeError(`${method} ${path} 返回了无法解析的内容：${oneLine(raw, 200)}`)
    }
  }

  /**
   * Reads a response body with a byte cap. A compromised or looping server can stream
   * without end, and res.text() would buffer it all until the process dies.
   */
  async #readBody(method: string, path: string, res: Response): Promise<string> {
    if (!res.body) return res.text()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value?.byteLength ?? 0
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new OpencodeError(
            `${method} ${path} 响应超过 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB 上限，已中止。`,
            res.status,
          )
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // stream already torn down
      }
    }
    return text
  }

  #fetchError(method: string, path: string, err: unknown): Error {
    if (err instanceof OpencodeError) return err
    if (err instanceof DOMException && err.name === "AbortError") return err

    const detail = describeFetchError(err)
    const base = err instanceof Error ? err.message : String(err)
    return new OpencodeError(`${method} ${path} 请求失败: ${detail ?? base}`)
  }
}
