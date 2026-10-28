import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Bot } from "grammy"
import type { Update } from "grammy/types"
import type { BotConfig } from "../src/config.js"
import type { Logger } from "../src/logger.js"
import { Opencode } from "../src/opencode.js"
import { ProxyService } from "../src/proxy.js"
import { QoderService } from "../src/qoder.js"
import { SessionStore } from "../src/store.js"
import { TelegramBridge } from "../src/telegram.js"

interface ApiCall {
  method: string
  payload: Record<string, unknown>
}

interface Harness {
  send(text: string, userId?: number): Promise<void>
  texts(): string[]
  lastText(): string
  errors: string[]
  close(): Promise<void>
}

async function createHarness(allowUsers = ["7"]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bot-telegram-"))
  const errors: string[] = []
  const log: Logger = {
    debug() {},
    info() {},
    warn() {},
    error: (...args) => errors.push(args.map(String).join(" ")),
  }
  const cfg: BotConfig = {
    telegram: { token: "123456:TEST", allowUsers: new Set(allowUsers), allowAll: false },
    opencode: { url: "http://127.0.0.1:1", username: "opencode" },
    taskTimeoutMs: 600_000,
    taskMaxTimeoutMs: 600_000,
    maxReplyLength: 1500,
    maxMediaBytes: 20 * 1024 * 1024,
    mediaAllowPrivateUrls: false,
    maxInputBytes: 20 * 1024 * 1024,
    reminderTimezone: "Asia/Shanghai",
    dataDir: dir,
    outboxDir: join(dir, "outbox"),
    inboxDir: join(dir, "inbox"),
    logLevel: "error",
  }

  const bot = new Bot(cfg.telegram.token as string, {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  })
  const calls: ApiCall[] = []
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return {
      ok: true,
      result: {
        message_id: calls.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number((payload as { chat_id?: number }).chat_id ?? 0), type: "private" },
        text: (payload as { text?: string }).text ?? "",
      },
    }
  })

  const store = new SessionStore(join(dir, "sessions.json"), log)
  const oc = new Opencode(cfg.opencode.url, cfg.opencode.username)
  const qoder = new QoderService(dir, store, log)
  const proxies = new ProxyService(join(dir, "proxies.json"), log, { tester: async () => {} })
  const bridge = new TelegramBridge(cfg, oc, qoder, store, log, proxies, bot)
  await bridge.start({ polling: false })

  let updateId = 0
  return {
    async send(text: string, userId = 7): Promise<void> {
      updateId += 1
      const update = {
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: userId, type: "private", first_name: "Tester" },
          from: { id: userId, is_bot: false, first_name: "Tester" },
          text,
        },
      } as Update
      await bot.handleUpdate(update)
    },
    texts(): string[] {
      return calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text ?? ""))
    },
    lastText(): string {
      return this.texts().at(-1) ?? ""
    },
    errors,
    async close(): Promise<void> {
      await bridge.stop()
      proxies.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("telegram bridge rejects users outside the whitelist", async () => {
  const h = await createHarness()
  try {
    await h.send("/status", 99)
    assert.match(h.lastText(), /未在白名单/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram bridge answers /status, /id, /stop, /queue and /retry", async () => {
  const h = await createHarness()
  try {
    await h.send("/status")
    assert.match(h.lastText(), /运行状态/)

    await h.send("/id")
    assert.match(h.lastText(), /暂未创建/)

    await h.send("/stop")
    assert.match(h.lastText(), /当前没有正在执行的任务/)

    await h.send("/queue")
    assert.match(h.lastText(), /队列为空/)

    await h.send("/retry")
    assert.match(h.lastText(), /还没有可重试的任务/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram bridge creates and lists reminders", async () => {
  const h = await createHarness()
  try {
    await h.send("/remind 10m 喝水")
    assert.match(h.lastText(), /提醒已设置/)
    assert.match(h.lastText(), /喝水/)

    await h.send("/reminders")
    assert.match(h.lastText(), /喝水/)

    await h.send("/cancel 1")
    assert.match(h.lastText(), /已取消提醒 #1/)

    await h.send("/remind every 10m 喝水")
    assert.match(h.lastText(), /重复：每 10 分钟/)

    await h.send("/reminders")
    assert.match(h.lastText(), /每 10 分钟/)

    await h.send("/cancel 2")
    assert.match(h.lastText(), /已取消提醒 #2/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram bridge creates and manages scheduled AI tasks", async () => {
  const h = await createHarness()
  try {
    await h.send("/schedule")
    assert.match(h.lastText(), /定时任务/)
    assert.match(h.lastText(), /暂无定时任务/)

    await h.send("/schedule add 10m 检查服务器")
    assert.match(h.lastText(), /定时任务已创建.*#1/)
    assert.match(h.lastText(), /OpenCode \/ Gemini 3\.8 Flash/)
    assert.match(h.lastText(), /检查服务器/)

    await h.send("/schedule add --engine qoder --model deepseek every 2h 汇总日志")
    assert.match(h.lastText(), /定时任务已创建.*#2/)
    assert.match(h.lastText(), /Qoder \/ DeepSeek-Flash/)
    assert.match(h.lastText(), /每 2 小时/)

    await h.send("/schedule")
    assert.match(h.lastText(), /定时任务（2）/)
    assert.match(h.lastText(), /检查服务器/)
    assert.match(h.lastText(), /汇总日志/)

    await h.send("/schedule pause 1")
    assert.match(h.lastText(), /已暂停定时任务 #1/)
    await h.send("/schedule")
    assert.match(h.lastText(), /⏸ #1/)

    await h.send("/schedule resume 1")
    assert.match(h.lastText(), /已恢复定时任务 #1/)
    await h.send("/schedule del 2")
    assert.match(h.lastText(), /已删除定时任务 #2/)
    await h.send("/schedule")
    assert.match(h.lastText(), /定时任务（1）/)

    await h.send("/status")
    assert.match(h.lastText(), /定时任务: 1 个/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram bridge records and shows usage stats", async () => {
  const h = await createHarness()
  try {
    await h.send("/usage")
    assert.match(h.lastText(), /使用统计/)
    assert.match(h.lastText(), /暂无任务记录/)

    // opencode is unreachable in the harness, so this task fails and is still counted
    await h.send("hello")
    assert.match(h.lastText(), /处理这条消息时出错了/)

    await h.send("/usage")
    assert.match(h.lastText(), /总任务：1/)
    assert.match(h.lastText(), /失败 1/)
  } finally {
    await h.close()
  }
})

test("telegram bridge manages network proxies", async () => {
  const h = await createHarness()
  try {
    await h.send("/proxy")
    assert.match(h.lastText(), /网络代理/)
    assert.match(h.lastText(), /尚未添加/)

    await h.send("/proxy add http://127.0.0.1:7890 本地代理")
    assert.ok(h.texts().some((text) => /测试通过并已添加/.test(text)))

    await h.send("/proxy use 1")
    assert.match(h.lastText(), /已启用代理 #1/)

    await h.send("/proxy")
    assert.match(h.lastText(), /当前：#1 本地代理/)

    await h.send("/proxy off")
    assert.match(h.lastText(), /已停用网络代理/)

    await h.send("/proxy del 1")
    assert.match(h.lastText(), /已删除代理 #1/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})
