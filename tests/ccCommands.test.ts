import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { CcCommands, type CcHost } from "../src/ccCommands.js"
import { CcSwitchService } from "../src/ccswitch.js"
import { loadConfig } from "../src/config.js"
import { ModelAdmin } from "../src/modelAdmin.js"
import { SessionStore } from "../src/store.js"

const PROVIDER_TABLE = `
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

const log = { debug() {}, info() {}, warn() {}, error() {} }

interface Harness {
  dir: string
  host: CcHost
  applyError: boolean
  calls: string[][]
  commands: CcCommands
  sent: Array<{ chatId: number; text: string; keyboard?: unknown }>
  /** Resolves the pending speedtest runner, if one is hanging. */
  finishSpeedtest: () => void
  /** Extracts the cc:cfm:<token> from the last confirmation keyboard. */
  lastConfirmToken(): string | undefined
}

function makeHarness(applyError = false): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bot-cc-commands-"))
  // assign Agent 需要一个真实存在的 agent 文件(frontmatter 齐全)
  mkdirSync(join(dir, ".opencode", "agent"), { recursive: true })
  writeFileSync(
    join(dir, ".opencode", "agent", "assistant.md"),
    "---\ndescription: Telegram bot\nmode: primary\n---\n\nYou are helpful.\n",
  )
  const sent: Array<{ chatId: number; text: string; keyboard?: unknown }> = []
  const calls: string[][] = []
  let releaseSpeedtest: (() => void) | undefined

  const host: CcHost = {
    sendTextMessage: async (chatId, text, keyboard) => {
      sent.push({ chatId, text, keyboard })
      return true
    },
    sendPanel: async () => {},
    editPanel: async () => {},
    applyOpenCodeModel: async () => {
      if (applyError) throw new Error("模拟切换失败")
    },
    store: new SessionStore(join(dir, "sessions.json"), log),
    cfg: loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7" }),
  }

  const cc = new CcSwitchService({
    app: "opencode",
    projectDir: dir,
    runner: async (args) => {
      calls.push([...args])
      // run() 会前置 --app <app>:剥离后再匹配子命令
      const rest = args[0] === "--app" ? args.slice(2) : args
      if (rest[1] === "speedtest") {
        return await new Promise((resolve) => {
          releaseSpeedtest = () =>
            resolve({
              code: 0,
              stdout: "Speedtest completed successfully\nEndpoint: https://api.example.com\nLatency: 42 ms",
              stderr: "",
            })
        })
      }
      if (rest[0] === "use") {
        return { code: 0, stdout: `Switched to ${rest[1] ?? "?"}`, stderr: "" }
      }
      if (rest[0] === "provider" && rest[1] === "list") {
        return { code: 0, stdout: PROVIDER_TABLE, stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  })
  const models = new ModelAdmin(join(dir, "data", "models.json"), dir, "assistant")
  const commands = new CcCommands(host, cc as unknown as CcSwitchService, models, log)

  return {
    dir,
    host,
    applyError,
    calls,
    commands,
    sent,
    finishSpeedtest: () => releaseSpeedtest?.(),
    lastConfirmToken: () => {
      const last = [...sent].reverse().find((item) => item.keyboard)
      if (!last) return undefined
      const match = /cc:cfm:([0-9a-f]+)/.exec(JSON.stringify(last.keyboard))
      return match?.[1]
    },
  }
}

function answerStub(): (text?: string) => Promise<void> {
  return async () => {}
}

test("cc confirm flow switches the provider after the token is confirmed", async () => {
  const h = makeHarness()
  try {
    await h.commands.panel(42)
    await h.commands.handleCommand(42, "tg:42", "use backup")
    const token = h.lastConfirmToken()
    assert.ok(token, "a confirmation keyboard was sent")

    await h.commands.handleCallback({} as never, 42, `cfm:${token}`, answerStub())
    const switched = h.sent.find((item) => item.text.includes("已将 cc-switch 全局配置切换"))
    if (!switched) console.error("SENTS:", JSON.stringify(h.sent.map((s) => s.text.slice(0, 120))))
    assert.ok(switched, "the provider switch runs after confirmation")
    assert.match(switched!.text, /backup/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("cc confirm tokens are chat-bound, one-shot and expire as unknown", async () => {
  const h = makeHarness()
  try {
    await h.commands.panel(42)
    await h.commands.handleCommand(42, "tg:42", "use 1")
    const token = h.lastConfirmToken()
    assert.ok(token)

    // 另一个会话不能消费该令牌
    await h.commands.handleCallback({} as never, 43, `cfm:${token}`, answerStub())
    assert.ok(
      h.sent.at(-1)!.text.includes("不属于当前会话"),
      `expected chat binding message, got: ${h.sent.at(-1)!.text}`,
    )

    // 原会话确认一次成功
    await h.commands.handleCallback({} as never, 42, `cfm:${token}`, answerStub())
    assert.ok(h.sent.some((item) => item.text.includes("已将 cc-switch 全局配置切换")))

    // 一次性:同一令牌再按已失效
    await h.commands.handleCallback({} as never, 42, `cfm:${token}`, answerStub())
    assert.ok(h.sent.at(-1)!.text.includes("已过期") || h.sent.at(-1)!.text.includes("不存在"))

    // 未知 token 同样优雅应答
    await h.commands.handleCallback({} as never, 42, "cfm:deadbeef", answerStub())
    assert.ok(h.sent.at(-1)!.text.includes("已过期"))
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("speed tests run one at a time per provider via the panel button", async () => {
  const h = makeHarness()
  const answers: Array<string | undefined> = []
  const answer = async (text?: string) => {
    answers.push(text)
  }
  try {
    await h.commands.panel(42)
    // 面板按钮 test:1 → 缓存索引 1 = backup
    await h.commands.handleCallback({} as never, 42, "test:1", answer)
    assert.ok(answers.at(-1)!.includes("正在测速"), answers.at(-1))

    // 同一 Provider 测速期间,第二次请求被单飞拒绝
    await h.commands.handleCallback({} as never, 42, "test:1", answer)
    assert.ok(answers.at(-1)!.includes("正在测速中"), answers.at(-1))

    h.finishSpeedtest()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(
      h.sent.some((item) => item.text.includes("测速成功")),
      "the result reaches the chat after the runner settles",
    )

    // 释放后可以再次发起
    await h.commands.handleCallback({} as never, 42, "test:1", answer)
    assert.ok(answers.at(-1)!.includes("正在测速"), answers.at(-1))
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})


test("cc model assign still reports success when the live session switch fails", async () => {
  // applyOpenCodeModel 抛错时:Agent 绑定文件已写入,用户必须看到成功消息而非 ❌
  const h = makeHarness(true)
  try {
    h.commands.panel(42) // warm the runner
    h.host.store.setEngine("tg:42", "opencode")
    await h.commands.handleCommand(42, "tg:42", "model assign assistant custom/repaired")
    const okMessage = h.sent.find((item) => item.text.includes("已将 Agent"))
    if (!okMessage) console.error("SENTS2:", JSON.stringify(h.sent.map((s) => s.text.slice(0, 100))))
    assert.ok(okMessage, "the success message survives the session-switch failure")
    assert.match(okMessage!.text, /⚠️ Agent 绑定已写入/)
    assert.ok(!h.sent.some((item) => item.text.startsWith("❌") && item.text.includes("模拟切换失败")), "the raw error must not be the only feedback")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})


test("cc mcp add encodes the config into a deeplink instead of shell arguments", async () => {
  const h = makeHarness()
  try {
    await h.commands.handleCommand(42, "tg:42", 'mcp add {"mcpServers":{"id":{"command":"npx"}}}')
    const deeplinkCall = h.calls.find((args) => args.includes("deeplink"))
    assert.ok(deeplinkCall, "the import goes through runBare deeplink")
    const url = deeplinkCall!.find((token) => token.startsWith("ccswitch://"))
    const params = new URLSearchParams(url!.split("?")[1] ?? "")
    assert.equal(params.get("apps"), "opencode")
    assert.equal(
      Buffer.from(params.get("config") ?? "", "base64url").toString(),
      JSON.stringify({ mcpServers: { id: { command: "npx" } } }),
      "the config round-trips through the base64url payload",
    )
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})
