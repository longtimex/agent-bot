import type { ModelRef } from "./config.js"

export class OpencodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpencodeError"
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
      if (!res.ok) return false
      const body = (await res.json()) as { healthy?: boolean }
      return body.healthy === true
    } catch {
      return false
    }
  }

  async createSession(title: string): Promise<string> {
    const session = await this.#request<{ id: string }>("POST", "/session", { title }, CONTROL_TIMEOUT_MS)
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
      try {
        const body = await this.#request<ProviderList>("GET", "/provider", undefined, 10_000)
        const next = new Map<string, ModelInputs>()
        for (const provider of body.all ?? []) {
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
        this.#capabilitiesAt = Date.now()
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

    const connect = async (): Promise<void> => {
      let failures = 0
      while (!closed) {
        try {
          const res = await fetch(`${this.#baseUrl}/event`, {
            headers: this.#headers(),
            signal: controller.signal,
          })
          if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`)

          failures = 0
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          try {
            while (!closed) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue
                const raw = line.slice(6).trim()
                if (!raw) continue
                try {
                  const ev = JSON.parse(raw) as { type: string; properties?: Record<string, unknown> }
                  if (ev.properties?.sessionID !== sessionID) continue

                  const part = ev.properties?.part as Record<string, unknown> | undefined
                  if (!part) continue

                  if (part.type === "tool") {
                    const tool = String(part.tool || "")
                    const state = (part.state as Record<string, unknown>) || {}
                    const input = (state.input as Record<string, unknown>) || {}
                    const status = String(state.status || "running")
                    const detail = String(input.command || input.filePath || input.pattern || input.query || "")
                    const shortDetail = detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 40)}` : ""
                    const action = status === "completed" ? "完成" : "执行"
                    onUpdate(`${action} [${tool}]${shortDetail}`)
                  } else if (part.type === "reasoning") {
                    onUpdate("正在思考与逻辑分析...")
                  } else if (part.type === "text") {
                    onUpdate("正在组织输出回答...")
                  }
                } catch {
                  // ignore malformed event
                }
              }
            }
          } finally {
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
      response = await this.#requestWithSignal<PromptResponse>(
        "POST",
        `/session/${encodeURIComponent(sessionID)}/message`,
        body,
        controller.signal,
      )
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
    let res: Response
    try {
      res = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw this.#fetchError(method, path, err)
    }

    const raw = await res.text()
    if (!res.ok) {
      throw new OpencodeError(`${method} ${path} -> ${res.status}: ${raw.slice(0, 500)}`)
    }
    return (raw ? JSON.parse(raw) : undefined) as T
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

    const raw = await res.text()
    if (!res.ok) {
      throw new OpencodeError(`${method} ${path} -> ${res.status}: ${raw.slice(0, 500)}`)
    }
    return (raw ? JSON.parse(raw) : undefined) as T
  }

  #fetchError(method: string, path: string, err: unknown): Error {
    if (err instanceof OpencodeError) return err
    if (err instanceof DOMException && err.name === "AbortError") return err

    const detail = describeFetchError(err)
    const base = err instanceof Error ? err.message : String(err)
    return new OpencodeError(`${method} ${path} 请求失败: ${detail ?? base}`)
  }
}
