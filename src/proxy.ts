import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici"
import { readJsonObject } from "./jsonStore.js"
import { SocksClient } from "socks"
import tls from "node:tls"
import type { Logger } from "./logger.js"
import { clip } from "./messages.js"
import { describeFetchError } from "./opencode.js"

export type ProxyProtocol = "http" | "https" | "socks4" | "socks5"

export interface ProxyRecord {
  id: number
  name: string
  url: string
  protocol: ProxyProtocol
  createdAt: number
}

export interface ProxyTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export type ProxyTester = (url: string, protocol: ProxyProtocol) => Promise<void>

interface ProxyFile {
  nextId: number
  activeId: number | null
  proxies: ProxyRecord[]
}

const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204"
const TEST_TIMEOUT_MS = 10_000
const NO_PROXY = "localhost,127.0.0.1,::1"

const PROTOCOL_MAP: Record<string, ProxyProtocol> = {
  "http:": "http",
  "https:": "https",
  "socks4:": "socks4",
  "socks4a:": "socks4",
  "socks5:": "socks5",
  "socks5h:": "socks5",
}

const DEFAULT_PORTS: Record<ProxyProtocol, number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
}

export function parseProxyUrl(input: string): { url: string; protocol: ProxyProtocol } {
  const raw = input.trim()
  if (!raw) throw new Error("代理地址不能为空。")
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("代理地址格式无效，示例：http://127.0.0.1:7890 或 socks5://user:pass@host:1080")
  }

  const protocol = PROTOCOL_MAP[parsed.protocol.toLowerCase()]
  if (!protocol) throw new Error("仅支持 http://、https://、socks4://、socks5:// 代理。")
  if (!parsed.hostname) throw new Error("代理地址缺少主机名。")
  if (parsed.pathname && parsed.pathname !== "/") throw new Error("代理地址不能包含路径。")
  if (parsed.search || parsed.hash) throw new Error("代理地址不能包含查询参数或片段。")

  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[protocol]
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("代理端口无效。")

  // URL.username/password stay percent-encoded (the getters do not decode), so the
  // userinfo round-trips as typed; rebuilding it also keeps a password-only URL
  // such as `socks5://:pass@host` from silently losing its credentials
  const auth =
    parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
      : ""
  return {
    url: `${parsed.protocol}//${auth}${parsed.hostname}:${port}`,
    protocol,
  }
}

export function maskProxyUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (!url.username && !url.password) return `${url.protocol}//${url.host}`
    return `${url.protocol}//${url.username ? `${url.username}:***` : ":***"}@${url.host}`
  } catch {
    return raw
  }
}

/**
 * Credentials for a hand-built SOCKS handshake. The URL getters keep userinfo
 * percent-encoded, so it is decoded here once — but a lone `%` (an invalid escape
 * the parser leaves verbatim) would make decodeURIComponent throw a URIError and
 * abort the connection, so it falls back to the raw text.
 */
export function socksCredentials(url: URL): { userId?: string; password?: string } {
  const decode = (value: string): string | undefined => {
    if (!value) return undefined
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return { userId: decode(url.username), password: decode(url.password) }
}

function socksDispatcher(url: URL): Agent {
  const type = url.protocol.startsWith("socks4") ? 4 : 5
  const { userId, password } = socksCredentials(url)
  return new Agent({
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
    connect: (options, callback) => {
      // A custom connect bypasses undici's buildConnector, so connectTimeout above
      // would be ignored: the SOCKS handshake carries its own timeout instead
      const port = Number(options.port) || (options.protocol === "https:" ? 443 : 80)
      SocksClient.createConnection({
        proxy: {
          host: url.hostname,
          port: Number(url.port) || 1080,
          type,
          userId,
          password,
        },
        command: "connect",
        destination: { host: options.hostname, port },
        timeout: TEST_TIMEOUT_MS,
      })
        .then(({ socket }) => {
          if (options.protocol !== "https:") {
            callback(null, socket)
            return
          }
          const secure = tls.connect({ socket, servername: options.servername ?? options.hostname })
          // undici connectors must invoke the callback exactly once: a late TLS
          // error after secureConnect would otherwise fire it a second time
          let done = false
          const finish = (err: Error | null, value: tls.TLSSocket | null): void => {
            if (done) return
            done = true
            if (err) callback(err, null)
            else if (value) callback(null, value)
          }
          secure.once("secureConnect", () => finish(null, secure))
          secure.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err)), null))
        })
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null))
    },
  })
}

export function createProxyDispatcher(url: string, protocol: ProxyProtocol): Dispatcher {
  if (protocol === "socks4" || protocol === "socks5") return socksDispatcher(new URL(url))
  return new ProxyAgent({
    uri: url,
    requestTls: { timeout: TEST_TIMEOUT_MS },
    proxyTls: { timeout: TEST_TIMEOUT_MS },
  })
}

async function defaultTester(url: string, protocol: ProxyProtocol): Promise<void> {
  const dispatcher = createProxyDispatcher(url, protocol)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(process.env.PROXY_TEST_URL ?? DEFAULT_TEST_URL, {
      dispatcher,
      signal: controller.signal,
    })
    await res.body?.cancel().catch(() => {})
    if (res.status < 200 || res.status >= 400) throw new Error(`代理返回 HTTP ${res.status}`)
  } catch (err) {
    const detail = describeFetchError(err) ?? (err instanceof Error ? err.message : String(err))
    throw new Error(/abort/i.test(detail) ? "连接超时（10 秒）" : detail)
  } finally {
    clearTimeout(timer)
    await dispatcher.close().catch(() => {})
  }
}

function cleanName(input: string | undefined, fallback: string): string {
  const value = (input ?? "").replace(/\s+/g, " ").trim()
  // A display name is echoed in panel buttons; cutting a surrogate pair in half
  // makes Telegram reject the whole keyboard
  return clip(value || fallback, 40) ?? ""
}

export class ProxyService {
  readonly #path: string
  readonly #envPath: string
  readonly #log: Logger
  readonly #tester: ProxyTester
  #nextId = 1
  #activeId: number | null = null
  #proxies: ProxyRecord[] = []
  #dispatcher?: Dispatcher
  #dispatcherUrl?: string

  constructor(path: string, log: Logger, options: { envPath?: string; tester?: ProxyTester } = {}) {
    this.#path = path
    this.#envPath = options.envPath ?? `${dirname(path)}/proxy.env`
    this.#log = log
    this.#tester = options.tester ?? defaultTester
    this.#load()
    this.#writeEnv()
  }

  list(): ProxyRecord[] {
    return this.#proxies.map((proxy) => ({ ...proxy }))
  }

  active(): ProxyRecord | undefined {
    if (this.#activeId === null) return undefined
    const found = this.#proxies.find((proxy) => proxy.id === this.#activeId)
    return found ? { ...found } : undefined
  }

  async add(input: string, name?: string): Promise<ProxyRecord> {
    const parsed = parseProxyUrl(input)
    if (this.#proxies.some((proxy) => proxy.url === parsed.url)) {
      throw new Error("这个代理已经添加过了。")
    }

    await this.#tester(parsed.url, parsed.protocol)

    // The duplicate check ran before the tester await: a concurrent add of the
    // same URL would have slipped past it, so recheck before committing
    if (this.#proxies.some((proxy) => proxy.url === parsed.url)) {
      throw new Error("这个代理已经添加过了。")
    }

    const host = new URL(parsed.url).host
    const proxy: ProxyRecord = {
      id: this.#nextId++,
      name: cleanName(name, `${parsed.protocol.toUpperCase()} ${host}`),
      url: parsed.url,
      protocol: parsed.protocol,
      createdAt: Date.now(),
    }
    this.#proxies.push(proxy)
    this.#save()
    this.#log.info(`proxy added #${proxy.id} (${parsed.protocol} ${host})`)
    return { ...proxy }
  }

  use(id: number): ProxyRecord {
    const proxy = this.#proxies.find((item) => item.id === id)
    if (!proxy) throw new Error(`代理 #${id} 不存在。`)
    this.#activeId = id
    this.#save()
    this.#writeEnv()
    this.#log.info(`proxy enabled #${id} (${maskProxyUrl(proxy.url)})`)
    return { ...proxy }
  }

  disable(): void {
    if (this.#activeId === null) return
    this.#log.info(`proxy disabled #${this.#activeId}`)
    this.#activeId = null
    // Closing is otherwise lazy: without this the tunnel to a proxy the user
    // just turned off stays open with pooled sockets until the next download
    this.#closeDispatcher()
    this.#save()
    this.#writeEnv()
  }

  remove(id: number): ProxyRecord | undefined {
    const index = this.#proxies.findIndex((item) => item.id === id)
    if (index < 0) return undefined
    const [removed] = this.#proxies.splice(index, 1)
    if (this.#activeId === id) {
      this.#activeId = null
      this.#closeDispatcher()
      this.#writeEnv()
    }
    this.#save()
    if (removed) this.#log.info(`proxy removed #${id}`)
    return removed ? { ...removed } : undefined
  }

  async test(id: number): Promise<ProxyTestResult> {
    const proxy = this.#proxies.find((item) => item.id === id)
    if (!proxy) return { ok: false, message: `代理 #${id} 不存在。` }
    const started = Date.now()
    try {
      await this.#tester(proxy.url, proxy.protocol)
      return { ok: true, message: "连接正常", latencyMs: Date.now() - started }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, message: detail, latencyMs: Date.now() - started }
    }
  }

  // Used by the bot's own outbound media downloads only; Telegram and localhost OpenCode traffic stay direct.
  dispatcher(): Dispatcher | undefined {
    const active = this.active()
    if (!active) {
      this.#closeDispatcher()
      return undefined
    }
    if (this.#dispatcherUrl !== active.url) {
      this.#closeDispatcher()
      this.#dispatcher = createProxyDispatcher(active.url, active.protocol)
      this.#dispatcherUrl = active.url
    }
    return this.#dispatcher
  }

  env(): Record<string, string> {
    const active = this.active()
    if (!active) return {}
    return {
      HTTP_PROXY: active.url,
      HTTPS_PROXY: active.url,
      ALL_PROXY: active.url,
      http_proxy: active.url,
      https_proxy: active.url,
      all_proxy: active.url,
      NO_PROXY,
      no_proxy: NO_PROXY,
    }
  }

  dispose(): void {
    this.#closeDispatcher()
  }

  #closeDispatcher(): void {
    const dispatcher = this.#dispatcher
    this.#dispatcher = undefined
    this.#dispatcherUrl = undefined
    if (dispatcher) void dispatcher.close().catch(() => {})
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (message) => this.#log.warn(message)) as Partial<ProxyFile> | undefined
    if (!parsed) return
    try {
      this.#nextId = Number.isInteger(parsed.nextId) && (parsed.nextId ?? 0) > 0 ? parsed.nextId! : 1
      const items = Array.isArray(parsed.proxies) ? parsed.proxies : []
      for (const item of items) {
        if (!item || !Number.isInteger(item.id) || typeof item.name !== "string" || typeof item.url !== "string") continue
        let normalized: { url: string; protocol: ProxyProtocol }
        try {
          normalized = parseProxyUrl(item.url)
        } catch {
          this.#log.warn(`ignoring invalid proxy #${item.id} in ${this.#path}`)
          continue
        }
        if (this.#proxies.some((proxy) => proxy.id === item.id || proxy.url === normalized.url)) continue
        this.#proxies.push({
          id: item.id,
          name: cleanName(item.name, `${normalized.protocol.toUpperCase()} ${new URL(normalized.url).host}`),
          url: normalized.url,
          protocol: normalized.protocol,
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        })
        if (item.id >= this.#nextId) this.#nextId = item.id + 1
      }
      const activeId =
        typeof parsed.activeId === "number" && Number.isInteger(parsed.activeId) ? parsed.activeId : null
      this.#activeId = activeId !== null && this.#proxies.some((proxy) => proxy.id === activeId) ? activeId : null
      this.#log.debug(`loaded ${this.#proxies.length} proxy record(s) from ${this.#path}`)
    } catch (err) {
      this.#log.warn(`failed to read proxy store ${this.#path}:`, (err as Error).message)
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      writeFileSync(tmp, JSON.stringify({ nextId: this.#nextId, activeId: this.#activeId, proxies: this.#proxies }, null, 2), {
        mode: 0o600,
      })
      renameSync(tmp, this.#path)
      chmodSync(this.#path, 0o600)
    } catch (err) {
      this.#log.warn("failed to persist proxy store:", (err as Error).message)
    }
  }

  #writeEnv(): void {
    try {
      const active = this.active()
      if (!active) {
        if (existsSync(this.#envPath)) unlinkSync(this.#envPath)
        return
      }
      const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
      const lines = [
        `# Generated by the Telegram bot; active proxy #${active.id}`,
        `export HTTP_PROXY=${quote(active.url)}`,
        `export HTTPS_PROXY=${quote(active.url)}`,
        `export ALL_PROXY=${quote(active.url)}`,
        `export http_proxy=${quote(active.url)}`,
        `export https_proxy=${quote(active.url)}`,
        `export all_proxy=${quote(active.url)}`,
        `export NO_PROXY=${quote(NO_PROXY)}`,
        `export no_proxy=${quote(NO_PROXY)}`,
      ]
      mkdirSync(dirname(this.#envPath), { recursive: true })
      const tmp = `${this.#envPath}.tmp`
      writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 })
      renameSync(tmp, this.#envPath)
      chmodSync(this.#envPath, 0o600)
    } catch (err) {
      this.#log.warn("failed to write proxy env file:", (err as Error).message)
    }
  }
}
