import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Bot } from "grammy"
import type { Update } from "grammy/types"
import { AgentCliRegistry, AgentCliService } from "../src/agentCli.js"
import { AgentCliInstaller } from "../src/agentInstaller.js"
import { CcSwitchService } from "../src/ccswitch.js"
import type { BotConfig } from "../src/config.js"
import type { Logger } from "../src/logger.js"
import { ModelAdmin } from "../src/modelAdmin.js"
import { Opencode, OpencodeError } from "../src/opencode.js"
import { OpsService } from "../src/ops.js"
import { ProxyService } from "../src/proxy.js"
import { SessionStore } from "../src/store.js"
import { BOT_MENU_COMMANDS, HELP_FULL, pruneChatState, TelegramBridge } from "../src/telegram.js"

interface ApiCall {
  method: string
  payload: Record<string, unknown>
}

interface Harness {
  send(text: string, userId?: number): Promise<void>
  press(data: string, userId?: number): Promise<void>
  texts(): string[]
  panelTexts(): string[]
  buttons(): Array<{ text: string; data: string }>
  lastKeyboard(): Array<{ text: string; data: string }>
  lastText(): string
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>
  errors: string[]
  close(): Promise<void>
}

interface HarnessOptions {
  oc?: Opencode
  cc?: CcSwitchService
  models?: ModelAdmin
  agents?: Record<string, unknown>
  installer?: (registry: AgentCliRegistry, dir: string, log: Logger) => AgentCliInstaller
  ops?: (dir: string, log: Logger) => OpsService
}

async function createHarness(allowUsers = ["7"], options: HarnessOptions = {}): Promise<Harness> {
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
    ccswitch: { app: "opencode" },
    agentCli: { configPath: join(dir, "agents.json") },
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

  if (options.agents) writeFileSync(cfg.agentCli.configPath, JSON.stringify({ agents: options.agents }))
  const store = new SessionStore(join(dir, "sessions.json"), log)
  const oc = options.oc ?? new Opencode(cfg.opencode.url, cfg.opencode.username)
  const registry = new AgentCliRegistry({ path: cfg.agentCli.configPath, log })
  const agents = new AgentCliService(dir, store, log, 600_000, 600_000, undefined, registry)
  const installer = options.installer?.(registry, dir, log)
  const ops = options.ops?.(dir, log)
  const proxies = new ProxyService(join(dir, "proxies.json"), log, { tester: async () => {} })
  const bridge = new TelegramBridge(
    cfg,
    oc,
    agents,
    store,
    log,
    proxies,
    bot,
    options.cc,
    options.models,
    installer,
    ops,
  )
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
      // Handlers enqueue AI work instead of awaiting it; let queued microtasks run
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    async press(data: string, userId = 7): Promise<void> {
      updateId += 1
      const update = {
        update_id: updateId,
        callback_query: {
          id: String(updateId),
          from: { id: userId, is_bot: false, first_name: "Tester" },
          chat_instance: String(userId),
          data,
          message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: userId, type: "private", first_name: "Tester" },
            text: "panel",
          },
        },
      } as Update
      await bot.handleUpdate(update)
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    texts(): string[] {
      return calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text ?? ""))
    },
    panelTexts(): string[] {
      return calls.filter((call) => call.method === "editMessageText").map((call) => String(call.payload.text ?? ""))
    },
    buttons(): Array<{ text: string; data: string }> {
      const items: Array<{ text: string; data: string }> = []
      for (const call of calls) {
        const markup = call.payload.reply_markup as
          | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
          | undefined
        for (const row of markup?.inline_keyboard ?? []) {
          for (const button of row) {
            if (button.callback_data) items.push({ text: button.text, data: button.callback_data })
          }
        }
      }
      return items
    },
    lastText(): string {
      return this.texts().at(-1) ?? ""
    },
    lastKeyboard(): Array<{ text: string; data: string }> {
      const call = [...calls]
        .reverse()
        .find((item) => (item.payload.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard)
      const markup = call?.payload.reply_markup as
        | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
        | undefined
      return (markup?.inline_keyboard ?? [])
        .flat()
        .filter((button) => button.callback_data !== undefined)
        .map((button) => ({ text: button.text, data: button.callback_data! }))
    },
    /** Toast text sent back through answerCallbackQuery, i.e. feedback with no new message. */
    answers(): string[] {
      return calls
        .filter((call) => call.method === "answerCallbackQuery")
        .map((call) => String(call.payload.text ?? ""))
    },
    async waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("waitFor timed out")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
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

test("telegram menu exposes categorized navigation and edits panels in place", async () => {
  const h = await createHarness()
  try {
    await h.send("/menu")
    assert.match(h.lastText(), /功能菜单/)
    const data = h.buttons().map((button) => button.data)
    for (const action of [
      "show:agent",
      "show:model",
      "show:schedule",
      "show:reminders",
      "show:status",
      "show:usage",
      "show:queue",
      "show:agents",
      "show:cc",
      "show:proxy",
      "show:ops",
      "show:help",
    ]) {
      assert.ok(data.includes(action), `menu is missing ${action}`)
    }

    const sentBefore = h.texts().length
    await h.press("show:usage")
    assert.match(h.panelTexts().at(-1) ?? "", /使用统计/)
    assert.equal(h.texts().length, sentBefore)

    await h.press("show:menu")
    assert.match(h.panelTexts().at(-1) ?? "", /功能菜单/)

    await h.send("/help")
    assert.match(h.lastText(), /功能菜单/)
    assert.match(h.lastText(), /help full/)

    await h.send("/help full")
    assert.match(h.lastText(), /常用核心命令/)

    await h.send("/help cc")
    assert.match(h.lastText(), /cc-switch 控制台/)
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
    assert.match(h.lastText(), /Qoder CLI \/ DeepSeek-Flash/)
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

test("telegram keeps long schedule prompts under the message limit", async () => {
  const h = await createHarness()
  try {
    // Markdown-heavy text roughly doubles when escaped, so echoing it in full would
    // push the confirmation past Telegram's 4096-char limit and silently fail
    const prompt = "*".repeat(1_990)
    await h.send(`/schedule add 10m ${prompt}`)
    assert.match(h.lastText(), /定时任务已创建.*#1/)
    assert.ok(h.texts().every((text) => text.length <= 4_096), "a confirmation exceeded the message limit")

    await h.send("/schedule")
    const panel = h.lastText()
    assert.ok(panel.length <= 4_096)
    assert.match(panel, /定时任务（1）/)
    assert.match(panel, /…/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /schedule run executes immediately and keeps the schedule", async () => {
  const h = await createHarness()
  try {
    await h.send("/schedule add 1h 检查服务器")
    assert.match(h.lastText(), /定时任务已创建.*#1/)

    await h.send("/schedule")
    assert.ok(h.buttons().some((button) => button.data === "sched:run:1"))
    assert.match(h.lastText(), /立即执行一次/)

    await h.send("/schedule run 1")
    assert.ok(h.texts().some((text) => /已立即执行定时任务 #1/.test(text)))
    await h.waitFor(() => h.texts().some((text) => /定时任务 #1 已触发/.test(text)))
    await h.waitFor(() => h.texts().some((text) => /处理这条消息时出错了/.test(text)))

    const triggered = h.texts().filter((text) => /定时任务 #1 已触发/.test(text)).length
    await h.press("sched:run:1")
    await h.waitFor(() => h.texts().filter((text) => /定时任务 #1 已触发/.test(text)).length > triggered)

    await h.send("/schedule")
    assert.match(h.lastText(), /定时任务（1）/)
  } finally {
    await h.close()
  }
})

test("telegram /retry replays the last user prompt but never a scheduled one", async () => {
  const seen: string[] = []
  const fake = {
    async createSession(): Promise<string> {
      return "ses_test"
    },
    async deleteSession(): Promise<void> {},
    async abortSession(): Promise<void> {},
    async inputCapabilities(): Promise<undefined> {
      return undefined
    },
    subscribeSession(): () => void {
      return () => {}
    },
    async prompt(_sessionID: string, text: string): Promise<string> {
      seen.push(text)
      return `回复：${text}`
    },
  } as unknown as Opencode

  const h = await createHarness(["7"], { oc: fake })
  try {
    await h.send("/retry")
    assert.match(h.lastText(), /还没有可重试的任务/)

    await h.send("第一条")
    await h.waitFor(() => seen.length === 1)
    await h.send("/retry")
    await h.waitFor(() => seen.length === 2)
    assert.deepEqual(seen, ["第一条", "第一条"])

    await h.send("/schedule add 1h 巡检数据库")
    assert.match(h.lastText(), /定时任务已创建/)
    await h.send("/schedule run 1")
    await h.waitFor(() => seen.length === 3)
    assert.equal(seen[2], "巡检数据库")

    await h.send("/retry")
    await h.waitFor(() => seen.length === 4)
    assert.equal(seen[3], "第一条")
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})


test("telegram a queued /retry is discarded by /stop instead of replaying it", async () => {
  const seen: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const fake = {
    async createSession(): Promise<string> {
      return "ses_test"
    },
    async deleteSession(): Promise<void> {},
    async abortSession(): Promise<void> {},
    async inputCapabilities(): Promise<undefined> {
      return undefined
    },
    subscribeSession(): () => void {
      return () => {}
    },
    async prompt(_sessionID: string, text: string): Promise<string> {
      seen.push(text)
      if (text === "任务A") await blocked
      return `回复：${text}`
    },
  } as unknown as Opencode

  const h = await createHarness(["7"], { oc: fake })
  try {
    await h.send("任务A")
    await h.waitFor(() => seen.length === 1)
    await h.send("/retry")
    await h.send("/stop")
    assert.match(h.lastText(), /已请求停止/)
    release()

    // The queue is per-chat and serial, so a second prompt finishing proves the
    // stale /retry job was already processed
    await h.send("任务B")
    await h.waitFor(() => seen.length === 2)
    assert.deepEqual(seen, ["任务A", "任务B"], "/retry must not resurrect stopped work")
    assert.doesNotMatch(h.texts().join("\n"), /已重新提交/)
  } finally {
    await h.close()
  }
})

test("telegram failure cards retry their own prompt, not the newest one", async () => {
  const seen: string[] = []
  const fake = {
    async createSession(): Promise<string> {
      return "ses_test"
    },
    async deleteSession(): Promise<void> {},
    async abortSession(): Promise<void> {},
    async inputCapabilities(): Promise<undefined> {
      return undefined
    },
    subscribeSession(): () => void {
      return () => {}
    },
    async prompt(_sessionID: string, text: string): Promise<string> {
      seen.push(text)
      if (text === "任务X") throw new Error("模拟失败")
      return `回复：${text}`
    },
  } as unknown as Opencode

  const h = await createHarness(["7", "8"], { oc: fake })
  try {
    await h.send("任务X")
    await h.waitFor(() => h.texts().join("\n").includes("模拟失败"))
    const card = h.buttons().filter((button) => button.text.includes("重试"))
    assert.equal(card.length, 1, "the error card offers exactly one retry action")
    assert.match(card[0]!.data, /^retry:q\d+$/)

    await h.send("任务Y")
    await h.waitFor(() => seen.length === 2)

    // another chat must not be able to replay someone else's prompt
    await h.press(card[0]!.data, 8)
    assert.match(h.answers().at(-1) ?? "", /已过期/)
    assert.deepEqual(seen, ["任务X", "任务Y"])

    await h.press(card[0]!.data)
    await h.waitFor(() => seen.length === 3)
    assert.deepEqual(seen, ["任务X", "任务Y", "任务X"], "the card replays its own prompt")
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
    await h.waitFor(() => h.texts().some((text) => /处理这条消息时出错了/.test(text)))

    await h.send("/usage")
    assert.match(h.lastText(), /总任务：1/)
    assert.match(h.lastText(), /失败 1/)
    assert.match(h.lastText(), /近 7 天：1 任务/)
    assert.match(h.lastText(), /[▁▂▃▄▅▆▇█·]{7}/)
  } finally {
    await h.close()
  }
})

test("telegram bridge records task history and clears it", async () => {
  const h = await createHarness()
  try {
    await h.send("/history")
    assert.match(h.lastText(), /任务历史/)
    assert.match(h.lastText(), /暂无任务记录/)

    // opencode is unreachable in the harness, so this task fails but still lands in history
    await h.send("请检查构建状态")
    await h.waitFor(() => h.texts().some((text) => /处理这条消息时出错了/.test(text)))

    await h.send("/history")
    assert.match(h.lastText(), /已显示 1 \/ 共 1 条/)
    assert.match(h.lastText(), /❌ 失败/)
    assert.match(h.lastText(), /请检查构建状态/)

    await h.press("history:clear")
    assert.match(h.panelTexts().at(-1) ?? "", /暂无任务记录/)

    await h.send("/history")
    assert.match(h.lastText(), /暂无任务记录/)
  } finally {
    await h.close()
  }
})

test("telegram masks the bot token when a task fails", async () => {
  const fake = {
    async createSession(): Promise<string> {
      return "ses_test"
    },
    async deleteSession(): Promise<void> {},
    async abortSession(): Promise<void> {},
    async inputCapabilities(): Promise<undefined> {
      return undefined
    },
    subscribeSession(): () => void {
      return () => {}
    },
    async prompt(): Promise<string> {
      // fetch reports the offending URL in its message, token included
      throw new Error('Invalid URL: "https://api.telegram.org/file/bot123456:TEST/file_1.jpg" api_key=SECRET123')
    },
  } as unknown as Opencode

  const h = await createHarness(["7"], { oc: fake })
  try {
    await h.send("下载附件")
    await h.waitFor(() => h.texts().some((text) => /处理这条消息时出错了/.test(text)))
    const failure = h.texts().find((text) => /处理这条消息时出错了/.test(text)) ?? ""
    assert.ok(!failure.includes("123456:TEST"), "bot token leaked")
    assert.ok(!failure.includes("SECRET123"), "api key leaked")
    assert.ok(failure.replace(/\\/g, "").includes("***"), "expected a masked placeholder")
    assert.ok(!h.errors.some((line) => line.includes("123456:TEST")), "token written to log")
  } finally {
    await h.close()
  }
})

test("running tasks do not block /status, /queue or /stop", async () => {
  let promptCalls = 0
  let cancelled = false
  const fake = {
    async createSession(): Promise<string> {
      return "ses_test"
    },
    async deleteSession(): Promise<void> {},
    async abortSession(): Promise<void> {},
    async inputCapabilities(): Promise<undefined> {
      return undefined
    },
    subscribeSession(): () => void {
      return () => {}
    },
    prompt(_sessionID: string, _text: string, options: { signal?: AbortSignal } = {}): Promise<string> {
      promptCalls += 1
      return new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true
            reject(new OpencodeError("已取消当前任务。"))
          },
          { once: true },
        )
      })
    },
  } as unknown as Opencode

  const h = await createHarness(["7"], { oc: fake })
  try {
    await h.send("第一个任务")
    await h.waitFor(() => promptCalls === 1)

    // The update loop must stay responsive while the AI task is still running
    await h.send("/status")
    assert.match(h.lastText(), /运行中/)

    await h.send("第二个任务")
    await h.send("/queue")
    assert.match(h.lastText(), /排队中（1）/)

    await h.send("/stop")
    assert.match(h.lastText(), /排队中的 1 条消息也已丢弃/)
    await h.waitFor(() => cancelled)

    await h.send("/queue")
    assert.match(h.lastText(), /队列为空/)
    assert.equal(promptCalls, 1)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("queue panel cancels one queued message and leaves the rest of the queue intact", async () => {
  const seen: string[] = []
  const waiters: Array<() => void> = []
  const fake = {
    async createSession(): Promise<string> {
      return "ses_test"
    },
    async deleteSession(): Promise<void> {},
    async abortSession(): Promise<void> {},
    async inputCapabilities(): Promise<undefined> {
      return undefined
    },
    subscribeSession(): () => void {
      return () => {}
    },
    prompt(_sessionID: string, text: string): Promise<string> {
      seen.push(text)
      return new Promise<string>((resolve) => {
        waiters.push(() => resolve(`回复：${text}`))
      })
    },
  } as unknown as Opencode

  const h = await createHarness(["7"], { oc: fake })
  try {
    await h.send("任务A")
    await h.waitFor(() => seen.length === 1)
    await h.send("任务B")
    await h.send("任务C")
    await h.send("/queue")
    assert.match(h.lastText(), /排队中（2）/)

    const drops = h.buttons().filter((button) => button.data.startsWith("qdrop:"))
    assert.equal(drops.length, 2)
    await h.press(drops[0]!.data)
    assert.ok(h.answers().some((text) => /已取消第 1 条/.test(text)))
    assert.match(h.panelTexts().at(-1) ?? "", /排队中（1）/)

    await h.send("/status")
    assert.match(h.lastText(), /待处理队列: 1 条/)

    // A is still running; releasing it must move on to C and never start the cancelled B
    waiters.shift()?.()
    await h.waitFor(() => seen.length === 2)
    assert.deepEqual(seen, ["任务A", "任务C"])
    waiters.shift()?.()
    await h.waitFor(() => h.texts().some((text) => text.includes("回复：任务C")))

    // Re-pressing the button of an entry that already ran must not cancel anything
    await h.press(drops[0]!.data)
    assert.ok(h.answers().some((text) => /已开始执行，或已被取消/.test(text)))
    assert.equal(h.errors.length, 0)
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

test("telegram folds the proxy panel before Telegram's button limit", async () => {
  const h = await createHarness()
  try {
    for (let i = 1; i <= 15; i += 1) {
      await h.send(`/proxy add http://127.0.0.1:${7900 + i} proxy-${i}`)
    }
    await h.send("/proxy")
    const text = h.lastText()
    assert.match(text, /另有 3 个未显示/)
    assert.ok(text.length <= 4000, `panel text too long: ${text.length}`)

    const keyboard = h.lastKeyboard()
    const proxyButtons = keyboard.filter((button) => button.data.startsWith("proxy:"))
    assert.equal(proxyButtons.length, 12 * 3)
    assert.ok(keyboard.length <= 100, `too many buttons: ${keyboard.length}`)
    assert.ok(proxyButtons.some((button) => button.data === "proxy:use:1"))
    assert.ok(!proxyButtons.some((button) => button.data === "proxy:use:15"))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

const CC_PROVIDER_TABLE = `
┌────┬────────┬────────────┬──────────────────────────┐
│    │ ID     │ Name       │ API URL                  │
╞════╪════════╪════════════╪══════════════════════════╡
│ ✓  │ main   │ 主线路     │ https://api.example.com  │
├────┼────────┼────────────┼──────────────────────────┤
│    │ backup │ 备用线路   │ https://backup.example   │
└────┴────────┴────────────┴──────────────────────────┘

ℹ Application: opencode
→ Current: main
`

/** Same shape as CC_PROVIDER_TABLE, but `main` is gone: index 1 now names `third`, not `backup`. */
const CC_PROVIDER_TABLE_MOVED = `
┌────┬────────┬────────────┬──────────────────────────┐
│    │ ID     │ Name       │ API URL                  │
╞════╪════════╪════════════╪══════════════════════════╡
│ ✓  │ backup │ 备用线路   │ https://backup.example   │
├────┼────────┼────────────┼──────────────────────────┤
│    │ third  │ 第三线路   │ https://third.example    │
└────┴────────┴────────────┴──────────────────────────┘

ℹ Application: opencode
`

const CC_SPEEDTEST = `
ℹ Testing provider '主线路'...
ℹ Endpoint: https://api.example.com

┌─────────────────────────┬──────────┬────────┐
│ Endpoint                │ Latency  │ Status │
╞═════════════════════════╪══════════╪════════╡
│ https://api.example.com │ 42 ms    │ 200    │
└─────────────────────────┴──────────┴────────┘

✓ Speedtest completed successfully
`

function fakeCc(calls: string[][] = []): CcSwitchService {
  return new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      const joined = args.join(" ")
      if (joined.includes("--version")) return { code: 0, stdout: "cc-switch 1.2.3\n", stderr: "" }
      if (joined.includes("provider list")) return { code: 0, stdout: CC_PROVIDER_TABLE, stderr: "" }
      if (joined.includes("provider speedtest")) return { code: 0, stdout: CC_SPEEDTEST, stderr: "" }
      if (joined.includes("use ")) return { code: 0, stdout: "✓ Switched provider\n", stderr: "" }
      return { code: 0, stdout: "ok\n", stderr: "" }
    },
  })
}

test("telegram /cc lists providers, switches and speedtests", async () => {
  const calls: string[][] = []
  const h = await createHarness(["7"], { cc: fakeCc(calls) })
  try {
    await h.send("/cc")
    await h.waitFor(() => h.texts().some((text) => text.includes("Providers")))
    const panel = h.texts().find((text) => text.includes("Providers")) ?? ""
    assert.match(panel, /main/)
    assert.match(panel, /主线路/)

    await h.press("cc:use:1")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    assert.ok(calls.every((args) => !args.join(" ").includes("use backup")))
    const confirm = h.buttons().find((button) => button.data.startsWith("cc:cfm:"))
    assert.ok(confirm)
    await h.press(confirm.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("切换到 Provider")))
    assert.ok(calls.some((args) => args.join(" ").includes("use backup")))

    await h.press("cc:test:0")
    await h.waitFor(() => h.texts().some((text) => text.includes("测速成功")))
    assert.ok(calls.some((args) => args.join(" ").includes("provider speedtest main")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram refuses a provider button whose index moved after the panel rendered", async () => {
  const calls: string[][] = []
  let table = CC_PROVIDER_TABLE
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      const joined = args.join(" ")
      if (joined.includes("--version")) return { code: 0, stdout: "cc-switch 1.2.3\n", stderr: "" }
      if (joined.includes("provider list")) return { code: 0, stdout: table, stderr: "" }
      if (joined.includes("use ")) return { code: 0, stdout: "✓ Switched provider\n", stderr: "" }
      return { code: 0, stdout: "ok\n", stderr: "" }
    },
  })
  const h = await createHarness(["7"], { cc })
  try {
    await h.send("/cc")
    await h.waitFor(() => h.texts().some((text) => text.includes("Providers")))

    table = CC_PROVIDER_TABLE_MOVED
    await h.press("cc:use:1")
    await h.waitFor(() => h.answers().some((text) => text.includes("列表已过期")))
    assert.ok(!h.texts().some((text) => text.includes("需要确认")), "stale index must not reach the confirm prompt")
    assert.ok(calls.every((args) => !args.join(" ").includes("use backup")))

    // The refusal refreshed the cached list, so the same index now means the current provider
    await h.press("cc:use:1")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    const confirm = h.buttons().find((button) => button.data.startsWith("cc:cfm:"))
    assert.ok(confirm)
    await h.press(confirm.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("切换到 Provider")))
    assert.ok(calls.some((args) => args.join(" ").includes("use third")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc explains how to install cc-switch when missing", async () => {
  const h = await createHarness(["7"], { cc: new CcSwitchService({ bin: "/nonexistent/cc-switch" }) })
  try {
    await h.send("/cc")
    await h.waitFor(() => h.texts().some((text) => text.includes("未检测到")))
    assert.match(h.lastText(), /cc-switch:install/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram confirms a provider switch sent through the canonical subcommand", async () => {
  const calls: string[][] = []
  const h = await createHarness(["7"], { cc: fakeCc(calls) })
  try {
    await h.send("/cc provider switch backup")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    assert.ok(calls.every((args) => !args.join(" ").includes("use backup")))
    const confirm = h.buttons().filter((button) => button.data.startsWith("cc:cfm:")).at(-1)
    assert.ok(confirm)
    await h.press(confirm.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("切换到 Provider")))
    assert.ok(calls.some((args) => args.join(" ").includes("use backup")))

    // /cc run passes raw args straight to cc-switch, so it needs the same gate
    await h.send("/cc run provider switch backup")
    await h.waitFor(() => h.texts().filter((text) => text.includes("需要确认")).length >= 2)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram only confirms a quota reset that actually consumes a credit", async () => {
  const calls: string[][] = []
  const h = await createHarness(["7"], { cc: fakeCc(calls) })
  try {
    await h.send("/cc auth reset-quota")
    await h.waitFor(() => calls.some((args) => args.join(" ").includes("auth reset-quota")))
    assert.ok(!h.texts().some((text) => text.includes("需要确认")), "a dry run must not ask for confirmation")

    await h.send("/cc auth reset-quota --confirm")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    assert.ok(!calls.some((args) => args.join(" ").includes("--confirm")))
    const confirm = h.buttons().filter((button) => button.data.startsWith("cc:cfm:")).at(-1)
    assert.ok(confirm)
    await h.press(confirm.data)
    await h.waitFor(() => calls.some((args) => args.join(" ").includes("auth reset-quota --confirm")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram keeps the cc-switch app pinned even with an inline --app flag", async () => {
  const calls: string[][] = []
  const h = await createHarness(["7"], { cc: fakeCc(calls) })
  try {
    await h.send("/cc run provider list --app=claude")
    await h.waitFor(() => h.texts().some((text) => text.includes("应用类型由")))
    await h.send("/cc provider list --app claude")
    await h.waitFor(() => h.texts().filter((text) => text.includes("应用类型由")).length >= 2)
    assert.ok(calls.every((args) => !args.join(" ").includes("--app=") && !args.join(" ").includes("--app claude")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram redacts secrets echoed in the cc-switch command preview", async () => {
  const h = await createHarness(["7"], { cc: fakeCc() })
  try {
    await h.send("/cc run proxy config --password=sk-abcdefgh123")
    await h.waitFor(() => h.texts().some((text) => text.includes("正在执行")))
    const preview = h.texts().find((text) => text.includes("正在执行"))!
    assert.ok(!preview.includes("sk-abcdefgh123"), preview)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc model adds, assigns and force-deletes models", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-cc-project-"))
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ provider: { custom: { models: { base: { name: "Base" } } } } }, null, 2),
  )
  writeFileSync(
    join(project, ".opencode", "agent", "assistant.md"),
    "---\ndescription: bot\nmode: primary\nmodel: custom/base\n---\n\nbody\n",
  )
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  const h = await createHarness(["7"], { models })
  const confirmButton = (): string => {
    const button = h.buttons().filter((item) => item.data.startsWith("cc:cfm:")).at(-1)
    assert.ok(button, "expected a confirmation button")
    return button.data
  }
  try {
    await h.send("/cc model add zeta custom/zeta-1 Zeta One")
    await h.waitFor(() => h.texts().some((text) => text.includes("已添加模型")))

    await h.send("/cc model assign self zeta")
    await h.waitFor(() => h.texts().some((text) => /已将 Agent \*assistant\*/.test(text)))

    // Deleting a model mutates the registry and opencode.json, so it must confirm first
    await h.send("/cc model del zeta")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    assert.ok(models.listCustomModels()["zeta"], "the model must survive until the button is pressed")
    await h.press(confirmButton())
    await h.waitFor(() => h.texts().some((text) => text.includes("仍在使用中")))

    await h.send("/cc model del zeta force")
    await h.waitFor(() => h.texts().filter((text) => text.includes("需要确认")).length >= 2)
    await h.press(confirmButton())
    await h.waitFor(() => h.texts().some((text) => text.includes("已删除模型")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("telegram /cc model add records capability flags", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-cc-flags-"))
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ provider: { custom: { models: {} } } }, null, 2),
  )
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  const h = await createHarness(["7"], { models })
  try {
    await h.send("/cc model add vision custom/vision-1 Vision One --attachment --context=128000 --output 16000")
    await h.waitFor(() => h.texts().some((text) => text.includes("已添加模型")))
    assert.match(h.lastText(), /支持图片输入/)
    assert.match(h.lastText(), /上下文 128000/)
    assert.match(h.lastText(), /输出上限 16000/)

    const config = JSON.parse(readFileSync(join(project, "opencode.json"), "utf8")) as {
      provider: { custom: { models: Record<string, unknown> } }
    }
    assert.deepEqual(config.provider.custom.models["vision-1"], {
      name: "Vision One",
      attachment: true,
      limit: { context: 128000, output: 16000 },
    })

    await h.send("/cc model add bad custom/bad-1 --bogus")
    assert.match(h.lastText(), /未知参数/)
    await h.send("/cc model add bad2 custom/bad-2 --context zero")
    assert.match(h.lastText(), /正整数/)
    assert.equal(models.listCustomModels()["bad"], undefined)
    assert.equal(models.listCustomModels()["bad2"], undefined)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("telegram keeps a custom model when its deletion prompt is cancelled", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-cc-cancel-"))
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ provider: { custom: { models: {} } } }, null, 2),
  )
  writeFileSync(
    join(project, ".opencode", "agent", "assistant.md"),
    "---\ndescription: bot\nmode: primary\nmodel: custom/base\n---\n\nbody\n",
  )
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  models.add({ key: "zeta", providerID: "custom", modelID: "zeta-1", label: "Zeta One" })
  const h = await createHarness(["7"], { models })
  try {
    await h.send("/cc model del zeta force")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    const cancel = h.buttons().filter((button) => button.data.startsWith("cc:cnl:")).at(-1)
    assert.ok(cancel)
    await h.press(cancel.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("已取消")))
    assert.ok(models.listCustomModels()["zeta"], "cancelling must leave the model registered")
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("telegram rejects unknown cc panel callbacks", async () => {
  const h = await createHarness(["7"], { cc: fakeCc() })
  try {
    // "constructor" resolves to a prototype value in a plain object lookup; it must not reach #executeCc
    await h.press("cc:constructor")
    await h.waitFor(() => h.answers().some((text) => text.includes("未知操作")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram truncates long agent and model listings below the message limit", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-model-long-"))
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ provider: { custom: { models: {} } } }, null, 2),
  )
  const longDesc = "很长的描述文本".repeat(30)
  for (let i = 0; i < 40; i += 1) {
    const name = `agent-${String(i).padStart(2, "0")}`
    writeFileSync(
      join(project, ".opencode", "agent", `${name}.md`),
      `---\ndescription: ${name} ${longDesc}\nmode: subagent\n---\n\nbody\n`,
    )
  }
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  for (let i = 0; i < 35; i += 1) {
    models.add({ key: `m-${String(i).padStart(2, "0")}`, providerID: "custom", modelID: `model-${i}`, label: `Model ${i}` })
  }
  const h = await createHarness(["7"], { models })
  try {
    await h.send("/cc model agents")
    await h.waitFor(() => h.texts().some((text) => text.includes("Agent 模型绑定")))
    const listing = h.texts().find((text) => text.includes("Agent 模型绑定"))!
    assert.ok(listing.length <= 4_000, `agents listing too long: ${listing.length}`)
    assert.ok(listing.includes("另有"), "expected a truncation note")

    await h.press("cc:model")
    await h.waitFor(() => h.panelTexts().some((text) => text.includes("模型管理")))
    const panel = h.panelTexts().find((text) => text.includes("模型管理"))!
    assert.ok(panel.length <= 4_000, `model panel too long: ${panel.length}`)
    assert.ok(panel.includes("另有"), "expected a truncation note in the model panel")
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("telegram folds long installed engine lists in the agent panel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-agent-list-"))
  const binDir = join(dir, "bin")
  mkdirSync(binDir, { recursive: true })
  const profiles: Record<string, unknown> = {}
  for (let i = 0; i < 60; i += 1) {
    const bin = join(binDir, `engine-${i}`)
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    profiles[`engine-${i}`] = { label: `自定义引擎-${i}`, bin, sessionMode: "stateless", parse: "text", args: {} }
  }
  const h = await createHarness(["7"], { agents: profiles })
  try {
    await h.press("show:agent")
    await h.waitFor(() => h.panelTexts().some((text) => text.includes("Agent 引擎")))
    const panel = h.panelTexts().find((text) => text.includes("Agent 引擎"))!
    assert.ok(panel.length <= 4_000, `agent panel too long: ${panel.length}`)
    assert.match(panel, /已检测到：.+等 \d+ 个/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("telegram escapes markdown in custom model labels and descriptions", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-model-md-"))
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  mkdirSync(join(project, "data"), { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ provider: { custom: { models: {} } } }, null, 2),
  )
  writeFileSync(
    join(project, "data", "models.json"),
    JSON.stringify({
      version: 1,
      models: { star: { providerID: "custom", modelID: "star-1", label: "A*B_C", desc: "desc_x_[y]" } },
    }),
  )
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  const h = await createHarness(["7"], { models })
  try {
    await h.send("/model star")
    await h.waitFor(() => h.texts().some((text) => text.includes("已成功切换模型")))
    const switched = h.texts().find((text) => text.includes("已成功切换模型"))!
    assert.ok(switched.includes("A\\*B\\_C"), switched)
    assert.ok(switched.includes("desc\\_x\\_\\[y\\]"), switched)

    await h.send("/model")
    await h.waitFor(() => h.texts().some((text) => text.includes("OpenCode 模型")))
    const panel = h.texts().filter((text) => text.includes("OpenCode 模型")).at(-1)!
    assert.ok(panel.includes("A\\*B\\_C"), panel)
    assert.ok(panel.includes("desc\\_x\\_\\[y\\]"), panel)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("model selection can be dropped with /model default and the panel button", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-model-reset-"))
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  mkdirSync(join(project, "data"), { recursive: true })
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ provider: { custom: { models: {} } } }, null, 2))
  writeFileSync(
    join(project, "data", "models.json"),
    JSON.stringify({
      version: 1,
      models: { star: { providerID: "custom", modelID: "star-1", label: "Star One", desc: "bright" } },
    }),
  )
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  const h = await createHarness(["7"], { models })
  try {
    // OpenCode engine: selection, panel button, then a no-op repeat press
    await h.send("/model star")
    await h.waitFor(() => h.texts().some((text) => text.includes("已成功切换模型")))
    await h.send("/model")
    await h.waitFor(() => h.texts().some((text) => text.includes("OpenCode 模型")))
    assert.ok(h.buttons().some((button) => button.data === "model:reset"), "reset button must appear")
    await h.send("/status")
    assert.match(h.lastText(), /模型: \*Star One\*/)
    assert.doesNotMatch(h.lastText(), /（默认）/)

    await h.press("model:reset")
    assert.ok(h.answers().some((text) => /已恢复默认模型/.test(text)))
    await h.send("/status")
    assert.match(h.lastText(), /模型: \*.*（默认）/)
    await h.press("model:reset")
    assert.ok(h.answers().some((text) => /本会话已经是默认模型/.test(text)))

    // CLI engine: the same reset through the command, then via its own button
    await h.send("/agent qoder")
    await h.waitFor(() => h.texts().some((text) => text.includes("已切换至")))
    await h.send("/model deepseek")
    await h.waitFor(() => h.texts().some((text) => text.includes("模型已切换为")))

    await h.send("/model default")
    assert.match(h.lastText(), /已取消本会话的模型选择/)

    await h.send("/model deepseek")
    await h.waitFor(() => h.texts().some((text) => text.includes("模型已切换为")))
    await h.send("/model")
    await h.waitFor(() => h.texts().some((text) => text.includes("模型*\n\n当前：")))
    const reset = h.buttons().find((button) => button.data.startsWith("cmodelreset:"))
    assert.ok(reset, "CLI panel must offer a reset once a model is stored")
    await h.press(reset.data)
    assert.ok(h.answers().some((text) => /已恢复默认模型/.test(text)))
    await h.press(reset.data)
    assert.ok(h.answers().some((text) => /本会话已经是默认模型/.test(text)))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("a model named after a reset keyword is selected instead of resetting", async () => {
  const project = mkdtempSync(join(tmpdir(), "bot-model-shadow-"))
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  mkdirSync(join(project, "data"), { recursive: true })
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ provider: { custom: { models: {} } } }, null, 2))
  writeFileSync(
    join(project, "data", "models.json"),
    JSON.stringify({
      version: 1,
      models: { auto: { providerID: "custom", modelID: "auto-1", label: "Auto Pick", desc: "router" } },
    }),
  )
  const models = new ModelAdmin(join(project, "data", "models.json"), project, "assistant")
  const h = await createHarness(["7"], {
    models,
    agents: {
      demo: {
        label: "Demo CLI",
        bin: "demo-cli-not-on-path",
        parse: "text",
        sessionMode: "stateless",
        supportsModel: true,
        models: [{ id: "auto", label: "Auto" }],
        args: {},
      },
    },
  })
  try {
    await h.send("/model auto")
    await h.waitFor(() => h.texts().some((text) => text.includes("已成功切换模型")))
    assert.doesNotMatch(h.lastText(), /已取消本会话的模型选择/)

    await h.send("/agent demo")
    await h.waitFor(() => h.texts().some((text) => text.includes("已切换至")))
    await h.send("/model auto")
    await h.waitFor(() => h.texts().some((text) => text.includes("模型已切换为")))
    assert.match(h.lastText(), /Auto/)

    // The same engine still resets for a word no model claims
    await h.send("/model default")
    assert.match(h.lastText(), /已取消本会话的模型选择/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test("telegram /cc provider passthrough redacts secrets in output", async () => {
  const calls: string[][] = []
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "API Key: sk-supersecret123\nprovider current ok\n", stderr: "" }
    },
  })
  const h = await createHarness(["7"], { cc })
  try {
    await h.send("/cc provider current")
    await h.waitFor(() => h.texts().some((text) => text.includes("provider current ok")))
    const output = h.texts().find((text) => text.includes("provider current ok")) ?? ""
    assert.doesNotMatch(output, /sk-supersecret123/)
    assert.match(output, /\*\*\*/)
    assert.ok(calls.some((args) => args.join(" ") === "--app open-code provider current"))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc asks for confirmation before destructive commands", async () => {
  const directCalls: string[][] = []
  const confirmCalls: Array<{ args: string[]; input: string }> = []
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      directCalls.push(args)
      return { code: 0, stdout: "ok\n", stderr: "" }
    },
    confirmRunner: async (args, input) => {
      confirmCalls.push({ args, input })
      return { code: 0, stdout: "✓ Deleted provider\n", stderr: "" }
    },
  })
  const h = await createHarness(["7"], { cc })
  try {
    await h.send("/cc provider delete foo")
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    assert.equal(confirmCalls.length, 0)
    assert.equal(directCalls.length, 0)

    const button = h.buttons().find((item) => item.text.includes("确认执行"))
    assert.ok(button)
    await h.press(button.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("Deleted provider")))
    assert.deepEqual(confirmCalls[0]!.args, ["provider", "delete", "foo"])
    assert.equal(confirmCalls[0]!.input, "y\n")
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc imports prompts and MCP configs via deep links", async () => {
  const calls: string[][] = []
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "✓ Imported\n", stderr: "" }
    },
  })
  const h = await createHarness(["7"], { cc })
  try {
    await h.send("/cc prompts new MyPreset Hello world from telegram")
    await h.waitFor(() => h.texts().some((text) => text.includes("提示词已创建")))
    const promptCall = calls.find((args) => args[0] === "deeplink")
    assert.ok(promptCall)
    assert.ok(!promptCall.includes("--app"))
    const promptParams = new URLSearchParams(promptCall[1]!.split("?")[1] ?? "")
    assert.equal(promptParams.get("resource"), "prompt")
    assert.equal(promptParams.get("app"), "opencode")
    assert.equal(promptParams.get("name"), "MyPreset")
    assert.equal(Buffer.from(promptParams.get("content") ?? "", "base64url").toString(), "Hello world from telegram")

    await h.send('/cc mcp add {"foo":{"command":"npx","args":["-y","pkg"]}}')
    await h.waitFor(() => h.texts().some((text) => text.includes("MCP 导入")))
    const mcpCall = calls.filter((args) => args[0] === "deeplink").at(-1)!
    const mcpParams = new URLSearchParams(mcpCall[1]!.split("?")[1] ?? "")
    assert.equal(mcpParams.get("resource"), "mcp")
    assert.equal(mcpParams.get("apps"), "opencode")
    const config = JSON.parse(Buffer.from(mcpParams.get("config") ?? "", "base64url").toString()) as {
      mcpServers?: Record<string, unknown>
    }
    assert.ok(config.mcpServers?.foo)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc imports a deep link only after confirmation", async () => {
  const calls: string[][] = []
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "✓ Imported\n", stderr: "" }
    },
  })
  const h = await createHarness(["7"], { cc })
  try {
    await h.send("/cc deeplink https://example.com/nope")
    assert.match(h.texts().join("\n"), /只接受 ccswitch/)
    assert.equal(calls.length, 0)

    const url = "ccswitch://v1/import?resource=mcp&config=e30"
    await h.send(`/cc run deeplink ${url}`)
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    assert.equal(calls.length, 0)
    const confirm = h.buttons().filter((button) => button.data.startsWith("cc:cfm:")).at(-1)
    assert.ok(confirm, "expected a one-time cc confirm button")
    await h.press(confirm.data)
    await h.waitFor(() => calls.length === 1)
    assert.deepEqual(calls[0], ["deeplink", url])
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc deeplink confirmation never cuts a surrogate pair", async () => {
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async () => ({ code: 0, stdout: "✓ Imported\n", stderr: "" }),
  })
  const h = await createHarness(["7"], { cc })
  try {
    // The 120th UTF-16 unit is the high half of the emoji: a hard slice would leave
    // a lone surrogate and Telegram would reject the whole confirmation message
    const url = `ccswitch://v1/import?${"x".repeat(98)}😀${"y".repeat(10)}`
    await h.send(`/cc deeplink ${url}`)
    await h.waitFor(() => h.texts().some((text) => text.includes("需要确认")))
    const message = h.texts().find((text) => text.includes("需要确认")) ?? ""
    assert.ok(message.includes("…"))
    for (let i = 0; i < message.length; i += 1) {
      const code = message.charCodeAt(i)
      const lone =
        (code >= 0xd800 && code <= 0xdbff && !(message.charCodeAt(i + 1) >= 0xdc00 && message.charCodeAt(i + 1) <= 0xdfff)) ||
        (code >= 0xdc00 && code <= 0xdfff && !(message.charCodeAt(i - 1) >= 0xd800 && message.charCodeAt(i - 1) <= 0xdbff))
      assert.ok(!lone, `lone surrogate at index ${i}`)
    }
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /agents detects, installs and uninstalls bot-managed CLIs", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const h = await createHarness(["7"], {
    agents: {
      demo: {
        label: "Demo CLI",
        bin: "demo-cli-not-on-path",
        installSpec: { method: "npm", package: "demo-pkg" },
        sessionMode: "stateless",
        parse: "text",
        args: {},
      },
    },
    installer: (registry, dir, log) =>
      new AgentCliInstaller(join(dir, "agent-cli-installs.json"), registry, log, {
        which: (bin) => (bin === "npm" ? "/fake/npm" : undefined),
        run: async (command, args) => {
          calls.push({ command, args })
          return {
            code: 0,
            stdout: args.includes("install") ? "added demo-pkg" : "removed demo-pkg",
            stderr: "",
          }
        },
      }),
  })
  try {
    await h.send("/agents")
    await h.waitFor(() => h.texts().some((text) => text.includes("Agent CLI 管理")))
    assert.match(h.texts().at(-1) ?? "", /推荐使用 OpenCode/)
    assert.ok(h.buttons().some((button) => button.data === "areq:install:demo"))

    const pendingAgentConfirm = () => {
      const tokens = h.buttons().filter((button) => button.data.startsWith("a:cfm:"))
      const last = tokens[tokens.length - 1]
      assert.ok(last, "expected a one-time agent confirm button")
      return last
    }

    await h.press("areq:install:demo")
    await h.waitFor(() => h.texts().some((text) => text.includes("确认安装 Demo CLI")))
    assert.equal(calls.length, 0)
    const installConfirm = pendingAgentConfirm()
    await h.press(installConfirm.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("正在安装 Demo CLI")))
    await h.waitFor(() => calls.length === 1)
    assert.deepEqual(calls[0], { command: "/fake/npm", args: ["install", "-g", "demo-pkg"] })
    await h.waitFor(() => h.texts().some((text) => text.includes("Bot 托管")))
    assert.ok(h.buttons().some((button) => button.data === "areq:uninstall:demo"))
    assert.ok(h.buttons().some((button) => button.data === "areq:update:demo"))

    await h.press(installConfirm.data)
    assert.match(h.texts().join("\n"), /已过期或已被使用/)
    assert.equal(calls.length, 1)

    await h.press("areq:update:demo")
    await h.waitFor(() => h.texts().some((text) => text.includes("确认更新 Demo CLI")))
    assert.equal(calls.length, 1)
    const updateConfirm = pendingAgentConfirm()
    await h.press(updateConfirm.data)
    await h.waitFor(() => calls.length === 2)
    assert.deepEqual(calls[1], { command: "/fake/npm", args: ["install", "-g", "demo-pkg"] })
    await h.waitFor(() => h.texts().some((text) => text.includes("更新命令执行成功")))

    await h.press("areq:uninstall:demo")
    await h.waitFor(() => h.texts().some((text) => text.includes("确认卸载 Demo CLI")))
    assert.equal(calls.length, 2)
    const uninstallConfirm = pendingAgentConfirm()
    await h.press(uninstallConfirm.data)
    await h.waitFor(() => calls.length === 3)
    assert.deepEqual(calls[2], { command: "/fake/npm", args: ["uninstall", "-g", "demo-pkg"] })
    await h.waitFor(() => h.texts().some((text) => text.includes("已卸载")))

    // 取消 revokes the one-time token instead of leaving it live for the whole TTL
    await h.press("areq:install:demo")
    await h.waitFor(() => h.texts().some((text) => text.includes("确认安装 Demo CLI")))
    const cancelled = pendingAgentConfirm()
    const cancelToken = cancelled.data.slice("a:cfm:".length)
    assert.ok(
      h.buttons().some((button) => button.data === `a:cnl:${cancelToken}`),
      "expected a cancel button carrying the same token",
    )
    await h.press(`a:cnl:${cancelToken}`)
    await h.waitFor(() => h.texts().filter((text) => text.includes("Agent CLI 管理")).length > 1)
    assert.equal(calls.length, 3)
    await h.press(cancelled.data)
    assert.match(h.lastText(), /已过期或已被使用/)
    assert.equal(calls.length, 3, "a declined install must never run")
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /cc blocks interactive-only commands and supports /cc run", async () => {
  const calls: string[][] = []
  const cc = new CcSwitchService({
    app: "opencode",
    runner: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "run ok\n", stderr: "" }
    },
  })
  const h = await createHarness(["7"], { cc })
  try {
    await h.send("/cc provider edit foo")
    await h.waitFor(() => h.texts().some((text) => text.includes("交互式")))
    assert.equal(calls.length, 0)

    await h.send("/cc update --check")
    await h.waitFor(() => h.texts().some((text) => text.includes("run ok")))
    assert.ok(calls.some((args) => args.join(" ") === "--app open-code update --check"))

    await h.send("/cc run skills list")
    await h.waitFor(() => h.texts().filter((text) => text.includes("run ok")).length >= 2)
    assert.ok(calls.some((args) => args.join(" ") === "--app open-code skills list"))

    await h.send("/cc help")
    await h.waitFor(() => h.texts().some((text) => text.includes("cc-switch 控制台")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram ops panel exposes diagnostics, logs, env edits and confirmed restart", async () => {
  let restartSpawns = 0
  let projectDir = ""
  const h = await createHarness(["7"], {
    ops: (dir) => {
      projectDir = dir
      mkdirSync(join(dir, "data"), { recursive: true })
      mkdirSync(join(dir, "dist"), { recursive: true })
      mkdirSync(join(dir, "scripts"), { recursive: true })
      writeFileSync(join(dir, "data", "bot.log"), "hello password=hunter2\nsecond line\n")
      writeFileSync(join(dir, "dist", "index.js"), "// bot\n")
      writeFileSync(join(dir, "scripts", "restart.sh"), "#!/usr/bin/env bash\n")
      return new OpsService({
        projectDir: dir,
        dataDir: join(dir, "data"),
        opencodeUrl: "http://127.0.0.1:4096",
        logPath: join(dir, "data", "bot.log"),
        envPath: join(dir, ".env"),
        which: () => undefined,
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        health: async () => false,
        systemd: false,
        spawnDetached: () => {
          restartSpawns += 1
          return 555
        },
      })
    },
  })
  try {
    await h.send("/ops")
    assert.match(h.lastText(), /运维中心/)
    assert.match(h.lastText(), /OpenCode：🔴 不可访问/)

    await h.press("ops:diag")
    assert.match(h.lastText(), /系统诊断/)

    await h.send("/logs 20")
    const logs = h.texts().join("\n")
    assert.match(logs, /hello password=\*\*\*/)
    assert.doesNotMatch(logs, /hunter2/)

    await h.send("/env set LOG_LEVEL debug")
    assert.match(h.texts().join("\n"), /已更新 LOG/)
    assert.match(readFileSync(join(projectDir, ".env"), "utf8"), /LOG_LEVEL=debug/)
    assert.match(h.texts().join("\n"), /LOG_LEVEL.*debug/)

    await h.send("/restart")
    assert.match(h.lastText(), /确认重启 Bot/)
    const restartConfirm = h.buttons().find((button) => button.data.startsWith("ops:cfm:"))
    assert.ok(restartConfirm, "expected a one-time ops confirm button")
    await h.press(restartConfirm.data)
    await h.waitFor(() => h.texts().some((text) => text.includes("已触发重启")))
    assert.match(h.texts().join("\n"), /555/)
    assert.equal(restartSpawns, 1)
    // The consumed token is single-use: replaying it must not restart a second time
    await h.press(restartConfirm.data)
    assert.match(h.texts().join("\n"), /已过期或已被使用/)
    assert.equal(restartSpawns, 1)
    // 取消 revokes the token: a declined restart must never be confirmable afterwards
    await h.send("/restart")
    const second = h.buttons().filter((button) => button.data.startsWith("ops:cfm:")).at(-1)!
    const cancelToken = second.data.slice("ops:cfm:".length)
    assert.ok(h.buttons().some((button) => button.data === `ops:cnl:${cancelToken}`))
    await h.press(`ops:cnl:${cancelToken}`)
    assert.match(h.lastText(), /已取消，未执行任何操作/)
    await h.press(second.data)
    assert.match(h.lastText(), /已过期或已被使用/)
    assert.equal(restartSpawns, 1)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("telegram /timezone applies live, persists to .env and rejects bad zones", async () => {
  let dataDir = ""
  let projectDir = ""
  const h = await createHarness(["7"], {
    ops: (dir) => {
      projectDir = dir
      dataDir = dir
      mkdirSync(join(dir, "data"), { recursive: true })
      return new OpsService({
        projectDir: dir,
        dataDir: join(dir, "data"),
        opencodeUrl: "http://127.0.0.1:4096",
        envPath: join(dir, ".env"),
        which: () => undefined,
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        health: async () => false,
        systemd: false,
      })
    },
  })

  // 08:30 in a zone with a fixed offset lands on a UTC time-of-day, whatever the calendar day is
  const utcMsOfDay = (dueAt: number): number => ((dueAt % 86_400_000) + 86_400_000) % 86_400_000
  const dueOfLastReminder = (): number => {
    const file = JSON.parse(readFileSync(join(dataDir, "reminders.json"), "utf8")) as {
      reminders: Array<{ dueAt: number }>
    }
    return file.reminders.at(-1)!.dueAt
  }

  try {
    await h.send("/timezone")
    assert.match(h.lastText(), /当前时区：`Asia\/Shanghai`/)
    assert.ok(h.buttons().some((button) => button.data === "tz:Asia/Tokyo"), "expected preset buttons")

    await h.send("/remind 每天 08:30 打卡")
    assert.equal(utcMsOfDay(dueOfLastReminder()), 30 * 60_000)

    await h.press("tz:UTC")
    assert.match(h.lastText(), /已切换时区：UTC/)
    assert.match(readFileSync(join(projectDir, ".env"), "utf8"), /REMINDER_TIMEZONE=UTC/)
    await h.send("/remind 每天 08:30 喝水")
    assert.equal(utcMsOfDay(dueOfLastReminder()), 8 * 3_600_000 + 30 * 60_000)

    await h.send("/timezone Mars/Olympus")
    assert.match(h.lastText(), /❌/)
    assert.match(readFileSync(join(projectDir, ".env"), "utf8"), /REMINDER_TIMEZONE=UTC/)

    await h.send("/timezone Asia/Tokyo")
    assert.match(h.lastText(), /已切换时区：Asia\/Tokyo/)
    await h.send("/remind 每天 08:30 晨跑")
    assert.equal(utcMsOfDay(dueOfLastReminder()), 23 * 3_600_000 + 30 * 60_000)

    await h.send("/id")
    assert.match(h.lastText(), /Asia\/Tokyo/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("pruneChatState trims idle chats down to the limit and keeps active ones", () => {
  const state = new Map<string, number>()
  for (let i = 0; i < 12; i++) state.set(`tg:${i}`, i)
  const active = new Set(["tg:0", "tg:5"])

  assert.equal(pruneChatState(state, (key) => active.has(key), 6), 6)
  assert.deepEqual([...state.keys()], ["tg:0", "tg:5", "tg:8", "tg:9", "tg:10", "tg:11"])
  assert.equal(pruneChatState(state, () => false, 6), 0)
  assert.equal(pruneChatState(state, () => false, 20), 0)
})

test("telegram /dir sets, shows and resets the CLI working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-dir-cmd-"))
  const nested = join(root, "repo")
  mkdirSync(nested)
  const h = await createHarness(["7"], {
    agents: {
      demo: {
        label: "Demo CLI",
        bin: "demo-cli-not-on-path",
        parse: "text",
        sessionMode: "stateless",
        args: { prompt: ["{prompt}"] },
      },
    },
  })
  try {
    await h.send("/agent demo")
    await h.send("/dir")
    assert.match(h.lastText(), /CLI 工作目录/)
    assert.doesNotMatch(h.lastText(), /已单独指定/)

    await h.send(`/dir ${nested}`)
    assert.match(h.lastText(), /工作目录已设为/)
    assert.match(h.lastText(), /已重置 CLI 会话上下文/)

    await h.send("/dir")
    assert.match(h.lastText(), /已单独指定/)
    assert.match(h.lastText(), /repo/)

    await h.send("/dir /definitely/not/here")
    assert.match(h.lastText(), /目录不存在/)

    await h.send("/dir reset")
    assert.match(h.lastText(), /已恢复默认工作目录/)
    await h.send("/dir")
    assert.doesNotMatch(h.lastText(), /repo/)

    // the panel button takes the same path as the command
    await h.send(`/dir ${nested}`)
    await h.press("dir:reset")
    assert.ok(h.answers().some((text) => /已恢复默认工作目录/.test(text)))
    await h.press("dir:unknown")
    assert.ok(h.answers().some((text) => /未知的目录操作/.test(text)))
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("telegram /access manages the whitelist live without locking oneself out", async () => {
  let projectDir = ""
  const h = await createHarness(["7"], {
    ops: (dir) => {
      projectDir = dir
      mkdirSync(join(dir, "data"), { recursive: true })
      return new OpsService({
        projectDir: dir,
        dataDir: join(dir, "data"),
        opencodeUrl: "http://127.0.0.1:4096",
        envPath: join(dir, ".env"),
        which: () => undefined,
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        health: async () => false,
        systemd: false,
      })
    },
  })
  const said = (): string => h.texts().join("\n")
  const env = (): string => readFileSync(join(projectDir, ".env"), "utf8")
  const replyAs = async (text: string, userId: number): Promise<string> => {
    const before = h.texts().length
    await h.send(text, userId)
    return h.texts().slice(before).join("\n")
  }

  try {
    await h.send("/access")
    assert.match(said(), /访问白名单/)
    assert.ok(h.buttons().some((button) => button.data === "access:del:7"), "expected a remove button per ID")

    assert.match(await replyAs("/status", 99), /未在白名单/)

    await h.send("/access add 99")
    assert.match(said(), /已加入白名单：99/)
    assert.match(env(), /^TELEGRAM_ALLOW_USERS=7,99$/m)
    const granted = await replyAs("/status", 99)
    assert.doesNotMatch(granted, /未在白名单/)
    assert.ok(granted.length > 0)

    await h.send("/access add 99")
    assert.match(said(), /已经在白名单中/)
    await h.send("/access add abc")
    assert.match(said(), /只能是 20 位以内的数字/)

    // removing yourself is refused, by command and by button
    await h.send("/access del 7")
    assert.match(said(), /不能把自己移出白名单/)
    await h.press("access:del:7")
    assert.match(h.answers().at(-1) ?? "", /不能把自己移出白名单/)
    assert.match(env(), /^TELEGRAM_ALLOW_USERS=7,99$/m)

    await h.send("/access del 99")
    assert.match(said(), /已移出白名单：99/)
    assert.match(env(), /^TELEGRAM_ALLOW_USERS=7$/m)
    assert.match(await replyAs("/status", 99), /未在白名单/)

    // /env must not write the managed key behind /access's back
    await h.send("/env set TELEGRAM_ALLOW_USERS 5")
    assert.match(said(), /请使用 \/access 修改/)
    assert.doesNotMatch(env(), /,5$/)
    await h.send("/env unset TELEGRAM_ALLOW_USERS")
    assert.match(said(), /请使用 \/access/)

    // the button path persists as well
    await h.send("/access add 12345")
    await h.press("access:del:12345")
    assert.match(h.answers().at(-1) ?? "", /已移除 12345/)
    assert.match(env(), /^TELEGRAM_ALLOW_USERS=7$/m)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("the Telegram autocomplete menu stays in sync with /help full", () => {
  const names = BOT_MENU_COMMANDS.map((item) => item.command)
  assert.equal(new Set(names).size, names.length, "the menu must not repeat a command")
  assert.ok(names.length <= 150, "Telegram accepts at most 150 menu commands")
  for (const item of BOT_MENU_COMMANDS) {
    assert.match(item.command, /^[a-z][a-z0-9_]{0,31}$/, `${item.command} is not a valid command name`)
    assert.ok(item.description.trim().length > 0 && item.description.length <= 256, item.command)
  }

  const documented = new Set([...HELP_FULL.matchAll(/`\s*\/([a-z][a-z0-9_]*)/g)].map((match) => match[1]!))
  // /reset shares the menu entry with /new; /start is Telegram's own entry point
  const shortcuts = new Set(["reset", "start"])
  const missing = [...documented].filter((name) => !names.includes(name) && !shortcuts.has(name))
  assert.deepEqual(missing, [], `missing from the Telegram menu: ${missing.join(", ")}`)
  const phantom = names.filter((name) => !documented.has(name) && !shortcuts.has(name))
  assert.deepEqual(phantom, [], `absent from /help full: ${phantom.join(", ")}`)
})
