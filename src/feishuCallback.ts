import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { FeishuCallbackConfig } from "./config.js"
import type { Logger } from "./logger.js"

const MAX_BODY_BYTES = 1024 * 1024

export interface FeishuCallbackDeps {
  config: FeishuCallbackConfig
  log: Logger
  /** Performs Feishu signature verification and returns the card action, if valid. */
  handle(raw: Record<string, unknown>): Promise<unknown>
}

function rawHeaders(req: IncomingMessage): Record<string, unknown> {
  const headers: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[key] = value
  }
  return headers
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer | Uint8Array) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.byteLength
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(data)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("请求体不是有效 JSON"))
      }
    })
    req.on("error", reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.statusCode = status
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

/**
 * Feishu's long-connection transport receives events but not card callbacks.
 * This optional server is the public endpoint the open platform calls for
 * `card.action.trigger`; message traffic continues over the long connection.
 */
export class FeishuCallbackServer {
  readonly #deps: FeishuCallbackDeps
  #server?: Server
  #starting?: Promise<void>

  constructor(deps: FeishuCallbackDeps) {
    this.#deps = deps
  }

  get endpoint(): string | undefined {
    const address = this.#server?.address()
    if (!address || typeof address === "string") return undefined
    return `http://${address.address}:${address.port}${this.#deps.config.path}`
  }

  async start(): Promise<void> {
    if (this.#server?.listening) return
    if (this.#starting) return this.#starting
    this.#starting = this.#listen().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.#deps.log.error("飞书卡片回调处理失败：", err instanceof Error ? err.message : String(err))
        send(res, 500, { error: "internal error" })
      })
    })
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.on("clientError", (err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      void err
    })
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        server.once("error", onError)
        server.listen(this.#deps.config.port, this.#deps.config.bind, () => {
          server.removeListener("error", onError)
          resolve()
        })
      })
    } catch (err) {
      this.#server = undefined
      server.close()
      throw err
    }
    server.on("error", (err: Error) => this.#deps.log.error("飞书卡片回调服务错误：", err.message))
    this.#deps.log.info(
      `飞书卡片回调监听 http://${this.#deps.config.bind}:${this.#deps.config.port}${this.#deps.config.path}`,
    )
  }

  async stop(): Promise<void> {
    const server = this.#server
    if (!server) return
    this.#server = undefined
    const closing = new Promise<void>((resolve) => server.close(() => resolve()))
    const grace = setTimeout(() => server.closeAllConnections(), 500)
    grace.unref()
    await closing
    clearTimeout(grace)
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?", 1)[0]
    if (path !== this.#deps.config.path) {
      send(res, 404, { error: "not found" })
      return
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST")
      send(res, 405, { error: "method not allowed" })
      return
    }
    if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      send(res, 415, { error: "content-type must be application/json" })
      return
    }
    let data: unknown
    try {
      data = await readBody(req)
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : "invalid request" })
      return
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      send(res, 400, { error: "invalid request" })
      return
    }
    try {
      // Keep the parsed body itself intact: the SDK distinguishes v1 from v2
      // with `'schema' in data`, and JSON.stringify must not include headers in
      // the legacy signature calculation. A non-enumerable own property meets
      // both constraints while remaining readable as `data.headers`.
      const body = data as Record<string, unknown>
      Object.defineProperty(body, "headers", {
        value: rawHeaders(req),
        enumerable: false,
        configurable: true,
      })
      const result = await this.#deps.handle(body)
      // The SDK returns undefined when the signature or verification token is
      // wrong. Answering 200 there would make Feishu record a successful push
      // for a request this bot never accepted.
      if (result === undefined) {
        send(res, 403, { error: "verification failed" })
        return
      }
      send(res, 200, result ?? {})
    } catch (err) {
      this.#deps.log.warn("飞书卡片回调验签失败：", err instanceof Error ? err.message : String(err))
      send(res, 403, { error: "verification failed" })
    }
  }
}
