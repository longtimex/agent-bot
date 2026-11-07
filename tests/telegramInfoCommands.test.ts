import assert from "node:assert/strict"
import test from "node:test"
import { InlineKeyboard, type Bot } from "grammy"
import type { BotConfig } from "../src/config.js"
import type { TaskHistoryStore } from "../src/history.js"
import type { Logger } from "../src/logger.js"
import { TelegramInfoCommands } from "../src/telegramInfoCommands.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function harness(apiEnabled = false, entries: unknown[] = []) {
  const sent: Array<{ text: string; keyboard?: InlineKeyboard }> = []
  const panels: string[] = []
  const cfg = { api: { enabled: apiEnabled, port: 3080, bind: "127.0.0.1" } } as unknown as BotConfig
  const history = { list: () => entries } as unknown as TaskHistoryStore
  const commands = new TelegramInfoCommands({
    cfg,
    log,
    bot: {} as Bot,
    history,
    timezone: () => "Asia/Shanghai",
    sendText: async (_chatId, text, keyboard) => { sent.push({ text, keyboard }); return true },
    sendPanel: async (_chatId, panel) => { panels.push(panel.text) },
    queuePanel: () => ({ text: "queue", keyboard: undefined }),
    statusText: () => "status",
    statusKeyboard: () => new InlineKeyboard(),
    usagePanel: () => ({ text: "usage", keyboard: undefined }),
  })
  return { commands, sent, panels }
}

test("info commands route queue, status and usage panels", async () => {
  const h = harness()
  await h.commands.handleQueue(1, "tg:1")
  await h.commands.handleStatus(1, "tg:1")
  await h.commands.handleUsage(1, "tg:1")
  assert.deepEqual(h.panels, ["queue", "usage"])
  assert.equal(h.sent[0]?.text, "status")
})

test("info commands report an empty history export", async () => {
  const h = harness()
  await h.commands.handleExport(1, "tg:1", "md")
  assert.ok(h.sent.some((item) => item.text.includes("还没有任务记录")))
})

test("info commands explain a disabled HTTP API", async () => {
  const h = harness(false)
  await h.commands.handleApiInfo(1)
  assert.ok(h.sent.some((item) => item.text.includes("HTTP API 当前未启用")))
})
