import type { ModelRef } from "./config.js"
import { clip } from "./messages.js"

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

export interface PromptFile {
  mime: string
  filename: string
  data: Buffer
}

export interface ModelInputs {
  image: boolean
  audio: boolean
  pdf: boolean
}

export interface PromptOptions {
  agent?: string
  model?: ModelRef
  idleTimeoutMs?: number
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
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

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
  #capabilities = new Map<string, ModelInputs>()
  #capabilitiesAt = 0

  constructor(baseUrl: string, username: string, password: string | undefined) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "")
    this.#authorization = password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      : undefined
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.#baseUrl}/global/health`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
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

  subscribeSession(sessionID: string, onUpdate: (summary: string) => void): () => void {
    const controller = new AbortController()
    let closed = false

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

    // One SSE event can never legitimately be this large; the cap is what stops a
    // peer that sends no newline (or a truncated JSON blob) from growing the buffer
    // until the process is killed.
    const MAX_EVENT_BYTES = 1_000_000

    const eventStatus = (ev: { properties?: Record<string, unknown> }): string | undefined => {
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

    const connect = async (): Promise<void> => {
      let failures = 0
      while (!closed) {
        try {
          const res = await fetch(`${this.#baseUrl}/event`, {
            headers: this.#headers(),
            signal: controller.signal,
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
              const status = eventStatus(ev)
              if (status) onUpdate(status)
              return
            }
            if (pending) pending = ""
          }

          try {
            while (!closed) {
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
            if (!closed && buffer && buffer.length <= MAX_EVENT_BYTES) emit(buffer)
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

        if (closed) return
        // A dead event stream must not look like an idle task, otherwise the
        // watchdog aborts work that is still running on the server
        failures += 1
        await wait(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)))
      }
    }

    void connect()

    return () => {
      closed = true
      controller.abort()
    }
  }

  async prompt(sessionID: string, text: string, options: PromptOptions = {}): Promise<string> {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text }]
    for (const file of options.files ?? []) {
      parts.push({
        type: "file",
        mime: file.mime,
        filename: file.filename,
        url: `data:${file.mime};base64,${file.data.toString("base64")}`,
      })
    }

    const body: Record<string, unknown> = { parts }
    if (options.agent) body.agent = options.agent
    if (options.model) body.model = options.model

    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    const maxTimeoutMs = Math.max(options.maxTimeoutMs ?? idleTimeoutMs, idleTimeoutMs)

    const controller = new AbortController()
    let idleTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
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

    hardTimer = setTimeout(() => {
      failWithTimeout(
        `执行超时：任务总耗时已达到 ${describeDuration(maxTimeoutMs)}上限。`,
      )
    }, maxTimeoutMs)

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
      throw err
    } finally {
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
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
      res = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
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
