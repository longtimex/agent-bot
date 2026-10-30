import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import { maskProxyUrl, parseProxyUrl, ProxyService, socksCredentials } from "../src/proxy.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("parseProxyUrl normalizes supported proxy schemes", () => {
  assert.deepEqual(parseProxyUrl("http://127.0.0.1:7890"), {
    url: "http://127.0.0.1:7890",
    protocol: "http",
  })
  assert.deepEqual(parseProxyUrl("https://user:pass@proxy.example.com"), {
    url: "https://user:pass@proxy.example.com:443",
    protocol: "https",
  })
  assert.deepEqual(parseProxyUrl("socks5://user:pass@10.0.0.1:1080"), {
    url: "socks5://user:pass@10.0.0.1:1080",
    protocol: "socks5",
  })
  assert.deepEqual(parseProxyUrl("socks5h://10.0.0.1"), {
    url: "socks5h://10.0.0.1:1080",
    protocol: "socks5",
  })
  assert.deepEqual(parseProxyUrl("socks4a://10.0.0.1:1081"), {
    url: "socks4a://10.0.0.1:1081",
    protocol: "socks4",
  })
})

test("parseProxyUrl rejects unsupported or malformed proxies", () => {
  assert.throws(() => parseProxyUrl(""), /不能为空/)
  assert.throws(() => parseProxyUrl("ftp://127.0.0.1:21"), /仅支持/)
  assert.throws(() => parseProxyUrl("http://127.0.0.1:7890/path"), /路径/)
  assert.throws(() => parseProxyUrl("http://127.0.0.1:7890?x=1"), /查询参数/)
  assert.throws(() => parseProxyUrl("not a url"), /格式无效/)
})

test("parseProxyUrl keeps encoded userinfo and password-only credentials", () => {
  // The URL getters keep userinfo percent-encoded; normalization must not re-encode or drop it
  assert.deepEqual(parseProxyUrl("socks5://user:p%23ss@10.0.0.1:1080"), {
    url: "socks5://user:p%23ss@10.0.0.1:1080",
    protocol: "socks5",
  })
  assert.deepEqual(parseProxyUrl("http://:pass@proxy.example.com"), {
    url: "http://:pass@proxy.example.com:80",
    protocol: "http",
  })
})

test("socksCredentials decodes userinfo once and survives an invalid escape", () => {
  assert.deepEqual(socksCredentials(new URL("socks5://u%40corp:100%25@10.0.0.1:1080")), {
    userId: "u@corp",
    password: "100%",
  })
  // A lone % is not a valid escape: the parser keeps it verbatim and the old
  // decodeURIComponent call threw before the SOCKS handshake could even start
  assert.deepEqual(socksCredentials(new URL("socks5://user:pa%ss@10.0.0.1:1080")), {
    userId: "user",
    password: "pa%ss",
  })
  assert.deepEqual(socksCredentials(new URL("socks5://10.0.0.1:1080")), {
    userId: undefined,
    password: undefined,
  })
})

test("maskProxyUrl hides credentials", () => {
  assert.equal(maskProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890")
  assert.equal(maskProxyUrl("http://user:secret@proxy.example.com:8080"), "http://user:***@proxy.example.com:8080")
  assert.equal(maskProxyUrl("socks5://proxy.example.com:1080"), "socks5://proxy.example.com:1080")
})

test("ProxyService adds after a successful test and persists state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-proxy-"))
  try {
    const tested: string[] = []
    const path = join(dir, "proxies.json")
    const envPath = join(dir, "proxy.env")
    const service = new ProxyService(path, log, {
      envPath,
      tester: async (url) => {
        tested.push(url)
      },
    })

    const proxy = await service.add("http://user:secret@127.0.0.1:7890", "本地代理")
    assert.deepEqual(tested, ["http://user:secret@127.0.0.1:7890"])
    assert.equal(proxy.name, "本地代理")
    assert.deepEqual(service.list().map((item) => item.id), [proxy.id])
    assert.equal(existsSync(envPath), false)

    service.use(proxy.id)
    assert.equal(service.active()?.id, proxy.id)
    assert.match(readFileSync(envPath, "utf8"), /export HTTPS_PROXY='http:\/\/user:secret@127\.0\.0\.1:7890'/)
    assert.equal(statSync(envPath).mode & 0o777, 0o600)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(service.env().ALL_PROXY, "http://user:secret@127.0.0.1:7890")

    const reloaded = new ProxyService(path, log, { envPath, tester: async () => {} })
    assert.equal(reloaded.active()?.id, proxy.id)

    reloaded.disable()
    assert.equal(reloaded.active(), undefined)
    assert.equal(existsSync(envPath), false)

    const removed = reloaded.remove(proxy.id)
    assert.equal(removed?.id, proxy.id)
    assert.deepEqual(reloaded.list(), [])
    service.dispose()
    reloaded.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ProxyService refuses proxies that fail the connectivity test", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-proxy-"))
  try {
    const path = join(dir, "proxies.json")
    const service = new ProxyService(path, log, {
      tester: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    await assert.rejects(() => service.add("socks5://127.0.0.1:1080"), /ECONNREFUSED/)
    assert.deepEqual(service.list(), [])

    const result = await (async () => {
      const added = new ProxyService(path, log, { tester: async () => {} })
      const proxy = await added.add("http://127.0.0.1:7890")
      return added.test(proxy.id)
    })()
    assert.equal(result.ok, true)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ProxyService closes the proxy tunnel when the proxy is turned off or removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-proxy-"))
  try {
    const service = new ProxyService(join(dir, "proxies.json"), log, {
      envPath: join(dir, "proxy.env"),
      tester: async () => {},
    })
    const proxy = await service.add("http://127.0.0.1:7890")
    // undici keeps the flag on the concrete dispatcher, not on its interface
    const isClosed = (dispatcher: unknown): boolean =>
      Boolean((dispatcher as { closed?: boolean } | undefined)?.closed)
    const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

    service.use(proxy.id)
    const first = service.dispatcher()
    assert.ok(first)
    assert.equal(isClosed(first), false)

    // A disabled service must not keep a live tunnel and pooled sockets behind
    service.disable()
    await settle()
    assert.equal(isClosed(first), true, "disable() has to close the dispatcher")
    assert.equal(service.dispatcher(), undefined)

    service.use(proxy.id)
    const second = service.dispatcher()
    assert.ok(second)
    assert.notEqual(second, first, "a re-enabled proxy needs a fresh connection pool")

    service.remove(proxy.id)
    await settle()
    assert.equal(isClosed(second), true, "removing the active proxy has to close its dispatcher")
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
