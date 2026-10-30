import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import test, { mock } from "node:test"
import { describeFetchError, oneLine, Opencode, OpencodeError } from "../src/opencode.js"

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (oc: Opencode) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(new Opencode(`http://127.0.0.1:${port}`, "user", "pass"))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("describeFetchError surfaces the cause code", () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), { code: "ECONNREFUSED" })
  const err = new TypeError("fetch failed", { cause })
  assert.equal(describeFetchError(err), "ECONNREFUSED")
})

test("describeFetchError walks nested aggregate errors", () => {
  const inner = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
  const cause = new AggregateError([inner], "connect failed")
  assert.equal(describeFetchError(new TypeError("fetch failed", { cause })), "UND_ERR_SOCKET")
})

test("describeFetchError returns undefined without a cause", () => {
  assert.equal(describeFetchError(new Error("boom")), undefined)
})

test("prompt rejects when the external signal aborts and aborts the server session", async () => {
  const controller = new AbortController()
  let abortCalls = 0

  await withServer(
    (req, res) => {
      const url = req.url ?? ""
      if (url.endsWith("/abort")) {
        abortCalls += 1
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
        return
      }
      if (url.endsWith("/message")) {
        controller.abort()
        return
      }
      res.writeHead(404)
      res.end()
    },
    async (oc) => {
      await assert.rejects(
        oc.prompt("ses_test", "hello", { signal: controller.signal }),
        (err: unknown) => err instanceof OpencodeError && /已取消当前任务/.test(err.message),
      )
      await delay(100)
      assert.equal(abortCalls, 1)
    },
  )
})

test("prompt attaches files as data URLs", async () => {
  let received: { parts?: Array<Record<string, unknown>> } | undefined

  await withServer(
    (req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString()) as typeof received
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ parts: [{ type: "text", text: "ok" }] }))
      })
    },
    async (oc) => {
      const reply = await oc.prompt("ses_test", "hi", {
        files: [{ mime: "image/png", filename: "a.png", data: Buffer.from([1, 2, 3]) }],
      })
      assert.equal(reply, "ok")
    },
  )

  const file = received?.parts?.find((part) => part.type === "file")
  assert.ok(file)
  assert.equal(file.mime, "image/png")
  assert.equal(file.filename, "a.png")
  assert.equal(file.url, `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`)
})

test("prompt tolerates an empty 200 response", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end()
    },
    async (oc) => {
      assert.equal(
        await oc.prompt("ses_test", "hi", { idleTimeoutMs: 1_000, maxTimeoutMs: 5_000 }),
        "",
      )
    },
  )
})

test("subscribeSession reads part events whose session id is on the part", async () => {
  const updates: string[] = []

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `data: ${JSON.stringify({
          type: "message.part.updated",
          properties: { part: { type: "text", sessionID: "ses_test", text: "hi" } },
        })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({
          type: "message.part.updated",
          properties: { part: { type: "text", sessionID: "ses_other", text: "no" } },
        })}\n\n`,
      )
    },
    async (oc) => {
      const stop = oc.subscribeSession("ses_test", (summary) => updates.push(summary))
      await delay(150)
      stop()
      assert.deepEqual(updates, ["正在组织输出回答..."])
    },
  )
})

test("subscribeSession also accepts data lines without a space and CRLF framing", async () => {
  const updates: string[] = []

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      // `data:{...}` and \r\n are both legal SSE and must not be dropped
      res.write(`data:${JSON.stringify({ properties: { part: { type: "tool", sessionID: "ses_test", tool: "bash", state: { status: "running", input: { command: "ls -la" } } } } })}\r\n\r\n`)
      res.write(
        `data: ${JSON.stringify({
          properties: { part: { type: "reasoning", sessionID: "ses_test" } },
        })}\r\n\r\n`,
      )
    },
    async (oc) => {
      const stop = oc.subscribeSession("ses_test", (summary) => updates.push(summary))
      await delay(150)
      stop()
      assert.deepEqual(updates, ["执行 [bash]: ls -la", "正在思考与逻辑分析..."])
    },
  )
})

test("inputCapabilities reads /provider once and caches", async () => {
  let calls = 0

  await withServer(
    (req, res) => {
      if (req.url === "/provider") {
        calls += 1
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            all: [
              {
                id: "custom",
                models: {
                  "vision-model": { capabilities: { input: { image: true, audio: false, pdf: true } } },
                },
              },
            ],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    },
    async (oc) => {
      const model = { providerID: "custom", modelID: "vision-model" }
      assert.deepEqual(await oc.inputCapabilities(model), { image: true, audio: false, pdf: true })
      assert.deepEqual(await oc.inputCapabilities(model), { image: true, audio: false, pdf: true })
      assert.equal(await oc.inputCapabilities({ providerID: "custom", modelID: "missing" }), undefined)
    },
  )

  assert.equal(calls, 1)
})

test("prompt reports an idle timeout and aborts the server session", async () => {
  let abortCalls = 0

  await withServer(
    (req, res) => {
      const url = req.url ?? ""
      if (url.endsWith("/abort")) {
        abortCalls += 1
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
        return
      }
      if (url.endsWith("/message")) return
      res.writeHead(404)
      res.end()
    },
    async (oc) => {
      await assert.rejects(
        oc.prompt("ses_test", "hello", { idleTimeoutMs: 100, maxTimeoutMs: 5_000 }),
        (err: unknown) => err instanceof OpencodeError && /无活动超时/.test(err.message),
      )
      await delay(100)
      assert.equal(abortCalls, 1)
    },
  )
})

test("activity after the prompt settles does not arm a stale idle timer", async () => {
  let abortCalls = 0

  await withServer(
    (req, res) => {
      const url = req.url ?? ""
      if (url.endsWith("/abort")) {
        abortCalls += 1
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
        return
      }
      if (url.endsWith("/message")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ parts: [{ type: "text", text: "ok" }] }))
        return
      }
      res.writeHead(404)
      res.end()
    },
    async (oc) => {
      let touch: (() => void) | undefined
      const reply = await oc.prompt("ses_test", "hello", {
        idleTimeoutMs: 50,
        maxTimeoutMs: 5_000,
        onActivityHook: (fn) => {
          touch = fn
        },
      })
      assert.equal(reply, "ok")

      // A late SSE update must not restart the watchdog after settlement
      touch?.()
      await delay(150)
      assert.equal(abortCalls, 0)
    },
  )
})

test("createSession reports a missing session id instead of crashing", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end("")
    },
    async (oc) => {
      await assert.rejects(oc.createSession("t"), (err: unknown) => {
        assert.ok(err instanceof OpencodeError)
        assert.match(err.message, /没有返回会话 ID/)
        return true
      })
    },
  )
})

test("requests reject malformed JSON bodies with an OpencodeError", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end("<html>gateway error</html>")
    },
    async (oc) => {
      await assert.rejects(oc.abortSession("s1"), (err: unknown) => {
        assert.ok(err instanceof OpencodeError)
        assert.match(err.message, /无法解析的内容/)
        return true
      })
      // capability lookup is best-effort and must not throw
      assert.equal(await oc.inputCapabilities({ providerID: "p", modelID: "m" }), undefined)
    },
  )
})

test("subscribeSession joins an event split over several data: lines", async () => {
  const updates: string[] = []
  const payload = JSON.stringify({
    properties: { part: { type: "tool", sessionID: "ses_test", tool: "bash", state: { status: "running", input: { command: "uptime" } } } },
  })
  const at = payload.indexOf(',"state"')
  const first = payload.slice(0, at)
  const second = payload.slice(at)
  assert.ok(first.length > 20 && second.length > 20)

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      // SSE dispatches on the blank line: the payload of one event may span data: lines
      res.write(`data: ${first}\ndata: ${second}\n\n`)
    },
    async (oc) => {
      const stop = oc.subscribeSession("ses_test", (summary) => updates.push(summary))
      await delay(150)
      stop()
      assert.deepEqual(updates, ["执行 [bash]: uptime"])
    },
  )
})

test("subscribeSession parses the final event when the stream has no trailing newline", async () => {
  const updates: string[] = []

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ properties: { part: { type: "tool", sessionID: "ses_test", tool: "read", state: { status: "completed", input: { filePath: "a.ts" } } } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ properties: { part: { type: "reasoning", sessionID: "ses_test" } } })}`)
      res.end()
    },
    async (oc) => {
      const stop = oc.subscribeSession("ses_test", (summary) => updates.push(summary))
      await delay(200)
      stop()
      assert.deepEqual(updates, ["完成 [read]: a.ts", "正在思考与逻辑分析..."])
    },
  )
})

test("subscribeSession reconnects instead of buffering a stream that never frames an event", async () => {
  let hits = 0

  await withServer(
    (_req, res) => {
      hits += 1
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.on("error", () => {})
      // 1MB+ of data without a single newline: an unbounded buffer would keep growing
      res.write("x".repeat(1024 * 1024 + 64))
    },
    async (oc) => {
      const stop = oc.subscribeSession("ses_test", () => {})
      await delay(1_400)
      stop()
      assert.ok(hits >= 2, `expected a reconnect, saw ${hits} connection(s)`)
    },
  )
})

test("subscribeSession backs off when a 200 stream closes without sending bytes", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let stop: (() => void) | undefined

  mock.timers.enable({ apis: ["setTimeout"] })
  globalThis.fetch = (async () => {
    calls += 1
    // A peer that answers 200 and immediately ends the event stream
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof fetch

  const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  try {
    const oc = new Opencode("http://127.0.0.1:9", "user", "pass")
    stop = oc.subscribeSession("ses_test", () => {})

    await flush()
    assert.equal(calls, 1)
    mock.timers.tick(1_000)
    await flush()
    assert.equal(calls, 2)
    // A dead stream that sent no data is a failure: the second retry must wait 2s.
    // Resetting the backoff on the bare 200 would retry again after just 1s.
    mock.timers.tick(1_000)
    await flush()
    assert.equal(calls, 2, "backoff must grow while the stream keeps coming back empty")
    mock.timers.tick(1_000)
    await flush()
    assert.equal(calls, 3, "subscription must still retry after the longer wait")
  } finally {
    stop?.()
    globalThis.fetch = originalFetch
    mock.timers.reset()
  }
})

test("OpencodeError carries the HTTP status so callers stop matching on message text", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404)
      res.end("session not found")
    },
    async (oc) => {
      await assert.rejects(
        oc.abortSession("ses_gone"),
        (err: unknown) => err instanceof OpencodeError && err.status === 404,
      )
    },
  )
})

test("oneLine flattens control characters an upstream body could use to forge log lines", () => {
  const evil = "boom\n[2026-10-30 00:00:00] INFO forged\u001b[31mred\u001b[0m"
  const flat = oneLine(evil, 200)

  assert.ok(!flat.includes("\n") && !flat.includes("\u001b"), flat)
  assert.ok(flat.startsWith("boom"))
  assert.equal(oneLine("a\u{1F600}bc", 3), "a\u{1F600}", "a truncation must not split a surrogate pair")
})

test("inputCapabilities reports an unknown model as undefined, not as unsupported", async () => {
  await withServer(
    (req, res) => {
      if ((req.url ?? "").endsWith("/provider")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ all: [{ id: "openai", models: { gpt: { capabilities: { input: { image: true } } } } }] }))
        return
      }
      res.writeHead(500)
      res.end()
    },
    async (oc) => {
      const known = await oc.inputCapabilities({ providerID: "openai", modelID: "gpt" })
      assert.deepEqual(known, { image: true, audio: false, pdf: false })
      const custom = await oc.inputCapabilities({ providerID: "custom", modelID: "claude" })
      assert.equal(custom, undefined, "a model missing from /provider is unknown, not incapable")
    },
  )
})
