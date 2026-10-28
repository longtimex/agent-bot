import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { describeFetchError, Opencode, OpencodeError } from "../src/opencode.js"

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
