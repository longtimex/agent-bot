import assert from "node:assert/strict"
import test from "node:test"
import type { ProxyService } from "../src/proxy.js"
import { TelegramProxyCommands } from "../src/telegramProxyCommands.js"

function harness() {
  const sent: string[] = []
  const panels = 0
  const calls: string[] = []
  const proxies = {
    add: async (url: string, name: string) => {
      calls.push(`add:${url}:${name}`)
      return { id: 1, name: name || "proxy", url }
    },
    use: (id: number) => {
      calls.push(`use:${id}`)
      return { id, name: "proxy", url: "http://127.0.0.1:7890" }
    },
    remove: (id: number) => {
      calls.push(`remove:${id}`)
      return true
    },
    test: async (id: number) => {
      calls.push(`test:${id}`)
      return { ok: true, latencyMs: 12, message: "" }
    },
    disable: () => { calls.push("disable") },
  } as unknown as ProxyService
  const commands = new TelegramProxyCommands({
    proxies,
    sendText: async (_chatId, text) => { sent.push(text); return true },
    sendPanel: async () => {},
    proxyPanel: () => ({ text: "proxy", keyboard: undefined }),
  })
  return { commands, sent, calls, panels }
}

test("proxy commands open the panel and operate on proxies", async () => {
  const h = harness()
  await h.commands.handleProxyCommand(1, "")
  await h.commands.handleProxyCommand(1, "add http://127.0.0.1:7890 local")
  await h.commands.handleProxyCommand(1, "use 1")
  await h.commands.handleProxyCommand(1, "test 1")
  await h.commands.handleProxyCommand(1, "del 1")
  await h.commands.handleProxyCommand(1, "off")
  assert.deepEqual(h.calls, ["add:http://127.0.0.1:7890:local", "use:1", "test:1", "remove:1", "disable"])
  assert.ok(h.sent.some((text) => text.includes("已启用代理")))
  assert.ok(h.sent.some((text) => text.includes("连接正常")))
})

test("proxy commands reject malformed ids without touching the store", async () => {
  const h = harness()
  await h.commands.handleProxyCommand(1, "use nope")
  assert.deepEqual(h.calls, [])
  assert.ok(h.sent.some((text) => text.includes("用法")))
})
