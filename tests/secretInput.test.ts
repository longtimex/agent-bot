import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { provideTaskSecret } from "../src/apiSecrets.js"
import type { ApiTask } from "../src/apiTaskTypes.js"
import { extractSecretRequests, secretContinuationPrompt } from "../src/secretRequests.js"
import { configureSecretVault, maskSecretValues, SECRET_TTL_MS, secretEnvFor, SecretVault } from "../src/secretVault.js"
import { carriesInlineSecret, commandSecretSlot, TelegramSecretInput } from "../src/telegramSecretInput.js"

const log = { debug() {}, info() {}, warn() {}, error() {} }
const tmp = (): string => mkdtempSync(join(tmpdir(), "secret-input-"))
const TOKEN = "ghp_SuperSecretValue1234567890"

test("secret directives become requests; code examples, bad names and repeats do not", () => {
  const { text, requests } = extractSecretRequests(
    [
      "需要你的 Token 才能推送。",
      "[[secret: github_token | 用于推送代码]]",
      "[[secret: GITHUB_TOKEN]]",
      "[[secret: PATH | 想改 PATH]]",
      "例子：`[[secret: EXAMPLE]]`",
      "[[secret: A_KEY]] [[secret: B_KEY]] [[secret: C_KEY]]",
    ].join("\n"),
  )
  assert.deepEqual(requests, [{ name: "GITHUB_TOKEN", purpose: "用于推送代码" }, { name: "A_KEY" }, { name: "B_KEY" }])
  assert.doesNotMatch(text, /\[\[secret: (github_token|GITHUB_TOKEN|PATH|A_KEY)/)
  assert.match(text, /`\[\[secret: EXAMPLE\]\]`/, "an example inside code stays")
  assert.match(text, /忽略了无效的密钥请求：PATH/)
  assert.equal(extractSecretRequests("普通回复").text, "普通回复")
})

test("the continuation prompt names the secrets and where to read them, never their values", () => {
  const prompt = secretContinuationPrompt(["GITHUB_TOKEN"], "/data/secrets/abc")
  assert.match(prompt, /^\[安全输入\]/)
  assert.match(prompt, /\/data\/secrets\/abc\/GITHUB_TOKEN/)
  assert.match(prompt, /\$GITHUB_TOKEN/)
  assert.match(prompt, /不要在回复、日志、提交记录/)
})

test("the vault encrypts at rest, scopes by chat, expires, scrubs and materializes files only on demand", () => {
  const dir = tmp()
  const vault = new SecretVault(dir, log)
  vault.set("tg:1", "github_token", TOKEN, "推送")
  assert.equal(vault.has("tg:1", "GITHUB_TOKEN"), true)
  assert.equal(vault.has("tg:2", "GITHUB_TOKEN"), false, "another chat cannot see it")
  assert.deepEqual(vault.env("tg:1"), { GITHUB_TOKEN: TOKEN })
  const stored = readFileSync(join(dir, "task-secrets.json"), "utf8")
  assert.doesNotMatch(stored, new RegExp(TOKEN), "the value is encrypted on disk")
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "task-secrets.json")).mode & 0o777, 0o600)
  assert.equal(vault.mask(`echo ${TOKEN} done`), "echo *** done")

  // A new process decrypts with the same accounts.key
  const reloaded = new SecretVault(dir, log)
  assert.deepEqual(reloaded.env("tg:1"), { GITHUB_TOKEN: TOKEN })

  const remove = reloaded.materialize("tg:1")
  const file = join(reloaded.dirFor("tg:1"), "GITHUB_TOKEN")
  assert.equal(readFileSync(file, "utf8"), TOKEN)
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600)
  remove()
  assert.equal(existsSync(file), false, "files exist only while a task runs")

  assert.equal(reloaded.list("tg:1", Date.now() + SECRET_TTL_MS + 1).length, 0, "gone after 24 hours")
  assert.throws(() => vault.set("tg:1", "LD_PRELOAD", "x"), /影响程序的启动方式/)
  assert.throws(() => vault.set("tg:1", "OK_NAME", ""), /不能为空/)
})

test("the process-wide vault feeds CLI environments and scrubs every outgoing text", () => {
  const vault = new SecretVault(tmp(), log)
  vault.set("api:app", "OPENAI_API_KEY", "sk-proj-abcdefghijkl")
  configureSecretVault(vault)
  try {
    assert.deepEqual(secretEnvFor("api:app"), { OPENAI_API_KEY: "sk-proj-abcdefghijkl" })
    assert.deepEqual(secretEnvFor("tg:9"), {})
    assert.equal(maskSecretValues("key=sk-proj-abcdefghijkl"), "key=***")
  } finally {
    configureSecretVault(undefined)
  }
  assert.equal(maskSecretValues("sk-proj-abcdefghijkl"), "sk-proj-abcdefghijkl", "no vault, nothing to scrub")
})

test("commands that need a key get a card; keys typed inline are recognised", () => {
  const magpie = commandSecretSlot("/magpie provider add openai")
  assert.equal(magpie?.fill("sk-1"), "/magpie provider add openai sk-1")
  assert.ok(commandSecretSlot("/magpie provider add openai ?"))
  assert.equal(commandSecretSlot("/magpie provider add openai sk-1"), undefined)

  const cc = commandSecretSlot("/cc provider add 中转 base=https://x key=? model=m")
  // A $ in the key must not be read as a replacement pattern
  assert.equal(cc?.fill("a$&b"), "/cc provider add 中转 base=https://x key=a$&b model=m")
  assert.equal(cc?.check?.("has space"), "这个命令的密钥里不能有空格或换行")

  const account = commandSecretSlot("/account add 邮箱 | me@example.com | ? | 工作")
  assert.equal(account?.fill("p@ss"), "/account add 邮箱 | me@example.com | p@ss | 工作")
  assert.match(account?.check?.("a|b") ?? "", /不能有 \|/)

  assert.equal(commandSecretSlot("/env set GROK_API_KEY")?.fill("v"), "/env set GROK_API_KEY v")
  assert.equal(commandSecretSlot("/env set LOG_LEVEL"), undefined, "a plain setting keeps its usage hint")
  assert.ok(commandSecretSlot("/env set LOG_LEVEL ?"))

  assert.equal(carriesInlineSecret("/magpie provider add openai sk-1"), true)
  assert.equal(carriesInlineSecret("/cc provider add x key=sk-1"), true)
  assert.equal(carriesInlineSecret("/cc provider add x key=?"), false)
  assert.equal(carriesInlineSecret("/account add a | b | secret"), true)
  assert.equal(carriesInlineSecret("/account edit a | b |  | c"), false, "an empty password field changes nothing")
  assert.equal(carriesInlineSecret("/env set GROK_API_KEY v"), true)
  assert.equal(carriesInlineSecret("/env set LOG_LEVEL debug"), false)
  assert.equal(carriesInlineSecret("/proxy add http://user:pw@127.0.0.1:7890"), true)
  assert.equal(carriesInlineSecret("你好"), false)
})

function fakeBot() {
  const calls: string[] = []
  let nextId = 100
  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string, extra?: { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }) => {
        const button = extra?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data
        calls.push(`send ${chatId} ${text.split("\n")[1] ?? text}${button ? ` [${button}]` : ""}`)
        return { message_id: nextId++ }
      },
      editMessageText: async (chatId: number, id: number, text: string) => {
        calls.push(`edit ${chatId}#${id} ${text.split("\n")[1] ?? text}`)
        return true
      },
      deleteMessage: async (chatId: number, id: number) => {
        calls.push(`delete ${chatId}#${id}`)
        return true
      },
    },
  }
  return { bot, calls }
}

function harness() {
  const { bot, calls } = fakeBot()
  const enqueued: Array<{ key: string; text: string }> = []
  const ran: string[] = []
  const input = new TelegramSecretInput({
    bot: bot as never,
    log,
    sessionKey: (chatId) => `tg:${chatId}`,
    isFeishu: () => false,
    enqueue: (job) => enqueued.push({ key: job.key, text: job.text }),
  })
  input.setRunner(async (_chatId, _userId, text) => void ran.push(text))
  return { input, calls, enqueued, ran }
}

test("a command card takes the next message as the key, deletes it and runs the completed command", async () => {
  const { input, calls, ran } = harness()
  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 1, text: "/magpie provider add openai" }), true)
  assert.match(calls.at(-1) ?? "", /magpie 预设 openai 的 API Key \[seccancel:s\d+\]/)

  // Someone else in the chat does not fill it
  assert.equal(await input.intercept({ chatId: 7, userId: 2, messageId: 2, text: "sk-other" }), false)
  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 3, text: "sk-has space" }), true)
  assert.match(calls.at(-1) ?? "", /不能有空格/)
  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 4, text: "sk-abcdef123456" }), true)
  assert.ok(calls.includes("delete 7#3") && calls.includes("delete 7#4"), "every message holding a key is deleted")
  assert.deepEqual(ran, ["/magpie provider add openai sk-abcdef123456"])
  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 5, text: "普通消息" }), false, "the card is done")
})

test("an inline key still runs but its message is deleted; cancel and /secrets work", async () => {
  const { input, calls } = harness()
  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 9, text: "/env set GROK_API_KEY xai-123456" }), false)
  assert.ok(calls.includes("delete 7#9"))
  assert.match(calls.at(-1) ?? "", /原消息已自动删除/)

  await input.intercept({ chatId: 7, userId: 1, messageId: 10, text: "/account add 邮箱 | me | ? | 工作" })
  const card = /\[(seccancel:s\d+)\]/.exec(calls.at(-1) ?? "")?.[1]
  assert.ok(card)
  assert.equal(await input.handleCallback(card, 7), "已取消")
  assert.equal(await input.handleCallback(card, 7), "这张卡片已经失效")
  assert.equal(await input.handleCallback("other", 7), undefined)
  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 11, text: "/cancel 3" }), false, "reminder /cancel N is untouched")

  assert.equal(await input.intercept({ chatId: 7, userId: 1, messageId: 12, text: "/secrets" }), true)
  assert.match(calls.at(-1) ?? "", /安全输入未启用/)
})

test("an Agent request collects every secret into the vault and resumes the task without the values", async () => {
  const vault = new SecretVault(tmp(), log)
  configureSecretVault(vault)
  try {
    const { input, calls, enqueued } = harness()
    const job = { key: "tg:7", chatId: 7, userId: 1 }
    const asked = input.fromReply(job, "需要两个密钥。\n[[secret: GITHUB_TOKEN | 推送]]\n[[secret: SERVICE_TOKEN]]")
    assert.equal(asked.text, "需要两个密钥。")
    await asked.ask()
    assert.match(calls.at(-1) ?? "", /AI 请求提供 GITHUB_TOKEN（1\/2）/)
    await input.intercept({ chatId: 7, userId: 1, messageId: 20, text: TOKEN })
    assert.match(calls.at(-1) ?? "", /AI 请求提供 SERVICE_TOKEN（2\/2）/)
    assert.equal(enqueued.length, 0, "not resumed while one is missing")
    await input.intercept({ chatId: 7, userId: 1, messageId: 21, text: "npm-secret-value" })
    assert.ok(calls.includes("delete 7#20") && calls.includes("delete 7#21"))
    assert.deepEqual(vault.env("tg:7"), { GITHUB_TOKEN: TOKEN, SERVICE_TOKEN: "npm-secret-value" })
    assert.equal(enqueued.length, 1)
    assert.match(enqueued[0]!.text, /GITHUB_TOKEN、SERVICE_TOKEN/)
    assert.doesNotMatch(enqueued[0]!.text, new RegExp(`${TOKEN}|npm-secret-value`))

    // Asking again for what is already there does not loop back into the Agent
    const again = input.fromReply(job, `再来 [[secret: GITHUB_TOKEN]] 回显 ${TOKEN}`)
    assert.match(again.text, /之前已通过安全输入提供/)
    assert.doesNotMatch(again.text, new RegExp(TOKEN), "an echoed value is scrubbed")

    await input.intercept({ chatId: 7, userId: 1, messageId: 22, text: "/secrets" })
    assert.match(calls.at(-1) ?? "", /GITHUB_TOKEN（推送）/)
    await input.intercept({ chatId: 7, userId: 1, messageId: 23, text: "/secrets clear" })
    assert.match(calls.at(-1) ?? "", /已清除本会话保存的 2 个密钥/)

    const scheduled = input.fromReply({ ...job, scheduled: true }, "[[secret: OTHER_KEY]]")
    assert.match(scheduled.text, /定时任务里无法填写/)
  } finally {
    configureSecretVault(undefined)
  }
})

test("the App endpoint stores a requested secret and queues the continuation once all are in", async () => {
  const vault = new SecretVault(tmp(), log)
  configureSecretVault(vault)
  try {
    const submitted: Array<{ text: string; engine?: string }> = []
    const host = {
      submit: async (text: string, engine?: string) => {
        submitted.push({ text, engine })
        return { id: "t2", key: "api:app", status: "queued", text, engine: engine ?? "opencode", createdAt: 1 } as ApiTask
      },
      view: (task: ApiTask) => ({ id: task.id, status: task.status, text: task.text, engine: task.engine, createdAt: task.createdAt }),
    }
    const task = {
      id: "t1",
      key: "api:app",
      status: "done",
      text: "推送代码",
      engine: "codex",
      autoEngine: false,
      createdAt: 1,
      secretRequests: [{ name: "GITHUB_TOKEN", provided: false }, { name: "OTHER_KEY", provided: false }],
    } as ApiTask
    await assert.rejects(provideTaskSecret(host, task, "NOT_ASKED", "x"), /没有请求这个密钥/)
    await assert.rejects(provideTaskSecret(host, task, "GITHUB_TOKEN", ""), /不能为空/)
    assert.deepEqual(await provideTaskSecret(host, task, "github_token", TOKEN), { remaining: ["OTHER_KEY"] })
    await assert.rejects(provideTaskSecret(host, task, "GITHUB_TOKEN", TOKEN), /已经提供过了/)
    const done = await provideTaskSecret(host, task, "OTHER_KEY", "other-value-123")
    assert.equal(done.task?.id, "t2")
    assert.equal(submitted[0]?.engine, "codex", "the continuation stays on the task's engine")
    assert.doesNotMatch(submitted[0]!.text, new RegExp(TOKEN))
    assert.deepEqual(Object.keys(vault.env("api:app")).sort(), ["GITHUB_TOKEN", "OTHER_KEY"])
  } finally {
    configureSecretVault(undefined)
  }
})
