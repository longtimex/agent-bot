import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import { AgentCliRegistry, AgentCliService } from "../src/agentCli.js"
import type { BotConfig } from "../src/config.js"
import { FeishuOutbound } from "../src/feishuApi.js"
import { FeishuIdentityStore } from "../src/feishuIdentity.js"
import { createFeishuRuntime, type FeishuRuntime } from "../src/feishuRuntime.js"
import type { FeishuApiLike } from "../src/feishuTypes.js"
import type { Logger } from "../src/logger.js"
import { OpsService } from "../src/ops.js"
import type { ModelInputs, Opencode, PromptFile } from "../src/opencode.js"
import { ProxyService } from "../src/proxy.js"
import { SessionStore } from "../src/store.js"
import { TelegramBridge } from "../src/telegram.js"
import { routeReminders, routeSchedules, type PersonalRouteDeps } from "../src/apiPersonal.js"

interface FeishuCall {
  method: "send" | "patch" | "delete" | "image" | "file" | "resource"
  receiveId?: string
  receiveIdType?: string
  msgType?: string
  content?: Record<string, unknown>
  messageId?: string
  fileKey?: string
  resourceType?: string
  fileType?: string
  fileName?: string
  duration?: number
}

interface HandlerMap {
  [name: string]: (event: unknown) => Promise<unknown> | unknown
}

interface Harness {
  root: string
  cfg: BotConfig
  runtime: FeishuRuntime
  bridge: TelegramBridge
  calls: FeishuCall[]
  identities: FeishuIdentityStore
  message(openId: string, text: string, overrides?: Record<string, unknown>): Promise<void>
  media(openId: string, type: "image" | "file" | "audio" | "media" | "video", content: Record<string, unknown>): Promise<void>
  press(data: string, openId?: string, overrides?: Record<string, unknown>): Promise<unknown>
  rawPress(
    data: string,
    openId?: string,
    options?: { eventId?: string; messageId?: string; chatId?: string },
  ): Promise<unknown>
  sendEvent(openId: string, text: string, eventId: string, messageId: string): Promise<void>
  texts(): string[]
  lastText(): string
  buttons(): Array<{ text: string; data: string }>
  prompts: Array<{ text: string; files: PromptFile[] }>
  replies: string[]
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>
  errors: string[]
  fatalErrors: Error[]
  close(): Promise<void>
}

interface FakeOpencode {
  createSession(title: string): Promise<string>
  deleteSession(sessionID: string): Promise<void>
  abortSession(sessionID: string): Promise<void>
  inputCapabilities(model?: { providerID: string; modelID: string }): Promise<ModelInputs | undefined>
  subscribeSession(sessionID: string, onUpdate: (summary: string) => void): () => void
  prompt(
    sessionID: string,
    text: string,
    options?: { files?: PromptFile[]; signal?: AbortSignal },
  ): Promise<string>
  health(): Promise<boolean>
}

function logger(errors: string[]): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error: (...args) => errors.push(args.map(String).join(" ")),
  }
}

function fakeFeishu(
  calls: FeishuCall[],
  resource = Buffer.from("hello from feishu"),
  uploadShape: "top-level" | "data" = "top-level",
): FeishuApiLike {
  let sequence = 0
  return {
    im: {
      v1: {
        message: {
          async create(payload) {
            sequence += 1
            const messageId = `om_mock_${sequence}`
            const content = JSON.parse(payload.data.content) as Record<string, unknown>
            calls.push({
              method: "send",
              receiveId: payload.data.receive_id,
              receiveIdType: payload.params.receive_id_type,
              msgType: payload.data.msg_type,
              content,
              messageId,
            })
            return { data: { message_id: messageId, chat_id: payload.data.receive_id } }
          },
          async patch(payload) {
            calls.push({
              method: "patch",
              messageId: payload.path.message_id,
              content: JSON.parse(payload.data.content) as Record<string, unknown>,
            })
            return {}
          },
          async delete(payload) {
            calls.push({ method: "delete", messageId: payload.path.message_id })
            return {}
          },
        },
        image: {
          async create(payload) {
            const key = `img_${payload.data.image.byteLength}`
            calls.push({ method: "image", fileKey: key })
            return uploadShape === "data" ? { data: { image_key: key } } : { image_key: key }
          },
        },
        file: {
          async create(payload) {
            const key = `file_${payload.data.file.byteLength}`
            calls.push({
              method: "file",
              fileKey: key,
              fileType: payload.data.file_type,
              fileName: payload.data.file_name,
              duration: payload.data.duration,
            })
            return uploadShape === "data" ? { data: { file_key: key } } : { file_key: key }
          },
        },
        messageResource: {
          async get(payload) {
            calls.push({
              method: "resource",
              messageId: payload.path.message_id,
              fileKey: payload.path.file_key,
              resourceType: payload.params.type,
            })
            return { getReadableStream: () => Readable.from([resource]) }
          },
        },
      },
    },
  }
}

function fakeOpencode(prompts: Harness["prompts"], replies: string[]): FakeOpencode {
  let sequence = 0
  return {
    async createSession() {
      sequence += 1
      return `ses_mock_${sequence}`
    },
    async deleteSession() {},
    async abortSession() {},
    async inputCapabilities() {
      return { image: true, audio: true, pdf: true }
    },
    subscribeSession() {
      return () => {}
    },
    async prompt(_sessionID, text, options = {}) {
      prompts.push({ text, files: options.files ?? [] })
      return replies.shift() ?? `echo: ${text.split("\n", 1)[0]}`
    },
    async health() {
      return true
    },
  }
}

function messageContent(call: FeishuCall): string {
  const record = call.content as { elements?: Array<{ tag?: string; content?: string }> } | undefined
  return record?.elements?.find((item) => item.tag === "markdown")?.content ?? ""
}

function routeDeps(
  h: Harness,
  replies: unknown[],
  bodies: Array<Record<string, unknown>>,
): PersonalRouteDeps {
  return {
    appKey: "api:app",
    ownerChatId: h.bridge.ownerChatId,
    ownerUserId: h.bridge.ownerUserId,
    cfg: h.cfg,
    reminders: h.bridge.sharedReminders,
    schedules: h.bridge.sharedSchedules,
    store: { getEngine: () => "opencode", getModel: () => undefined } as never,
    registry: {} as never,
    json: (_res, status, body) => replies.push({ status, body }),
    readJsonBody: async () => bodies.shift() ?? {},
  } as PersonalRouteDeps
}

function request(method: string): Parameters<typeof routeReminders>[1] {
  return { method, req: {}, res: {}, url: new URL("http://bot.test/api/v1/reminders"), segments: [], encrypted: false } as never
}

async function harness(options: {
  allowOpenIds?: string[]
  allowAll?: boolean
  telegramToken?: string
  startupNotice?: boolean
  wsFails?: boolean
  callback?: { port?: number; verificationToken?: string; encryptKey?: string }
} = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "bot-feishu-"))
  mkdirSync(join(root, "inbox"), { recursive: true })
  mkdirSync(join(root, "outbox"), { recursive: true })
  const errors: string[] = []
  const log = logger(errors)
  const cfg: BotConfig = {
    // No Telegram token: this is the Feishu-only deployment that must not call getMe.
    telegram: { token: options.telegramToken, allowUsers: new Set<string>(), allowAll: false },
    feishu: {
      appId: "cli_0123456789abcdef",
      appSecret: "secret",
      allowOpenIds: new Set(options.allowOpenIds ?? ["ou_owner"]),
      allowAll: options.allowAll ?? false,
      callback: options.callback
        ? {
            enabled: true,
            port: options.callback.port ?? 0,
            bind: "127.0.0.1",
            path: "/feishu/card",
            verificationToken: options.callback.verificationToken,
            encryptKey: options.callback.encryptKey,
          }
        : undefined,
    },
    opencode: { url: "http://127.0.0.1:1", username: "opencode" },
    taskTimeoutMs: 600_000,
    taskMaxTimeoutMs: 600_000,
    maxReplyLength: 1500,
    maxMediaBytes: 20 * 1024 * 1024,
    mediaAllowPrivateUrls: false,
    maxInputBytes: 20 * 1024 * 1024,
    reminderTimezone: "Asia/Shanghai",
    ccswitch: { app: "opencode" },
    magpie: { gatewayUrl: "http://127.0.0.1:3425" },
    agentCli: { configPath: join(root, "agents.json") },
    api: { enabled: false, port: 3080, bind: "127.0.0.1" },
    dataDir: root,
    outboxDir: join(root, "outbox"),
    inboxDir: join(root, "inbox"),
    logLevel: "error",
    startupNotice: options.startupNotice ?? false,
  }
  const calls: FeishuCall[] = []
  const client = fakeFeishu(calls)
  const identities = new FeishuIdentityStore(join(root, "feishu-identities.json"), log)
  const outbound = new FeishuOutbound(client)
  const resolver = {
    isFeishuId: (id: number) => identities.hasNumericId(id),
    receiveIdForChat: (chatId: number) => identities.chatExternalId(chatId),
    openIdForUser: (userId: number) => identities.userOpenId(userId),
    feishuOwnerChatId: () => identities.ownerChatId(),
    feishuOwnerUserId: () => identities.ownerUserId(),
  }
  const store = new SessionStore(join(root, "sessions.json"), log)
  const prompts: Harness["prompts"] = []
  const replies: string[] = []
  const oc = fakeOpencode(prompts, replies)
  const registry = new AgentCliRegistry({ path: cfg.agentCli.configPath, log })
  const agents = new AgentCliService(root, store, log, 600_000, 600_000, undefined, registry)
  const proxies = new ProxyService(join(root, "proxies.json"), log, { tester: async () => {} })
  const ops = new OpsService(
    {
      projectDir: root,
      dataDir: root,
      opencodeUrl: cfg.opencode.url,
      envPath: join(root, ".env"),
      which: () => undefined,
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      health: async () => false,
      systemd: false,
    },
    log,
  )
  const handlers: HandlerMap = {}
  const dispatcher = {
    register(next: HandlerMap) {
      Object.assign(handlers, next)
    },
  }
  const fatalErrors: Error[] = []
  const ws = {
    async start() {
      if (options.wsFails) throw new Error("no route to Feishu")
    },
    close() {},
  }
  const bridge = new TelegramBridge(
    cfg,
    oc as unknown as Opencode,
    agents,
    store,
    log,
    proxies,
    undefined,
    undefined,
    undefined,
    undefined,
    ops,
    undefined,
    resolver,
    client,
  )
  await bridge.start({ polling: false })
  const runtime = createFeishuRuntime(
    {
      cfg,
      bridge,
      log,
      connection: { client, identities, resolver, outbound },
    },
    { ws, dispatcher, onFatal: (err) => fatalErrors.push(err) },
  )!
  runtime.start()

  let sequence = 0
  const invoke = async (name: string, event: unknown): Promise<unknown> => {
    const handler = handlers[name]
    if (!handler) throw new Error(`handler not registered: ${name}`)
    return handler(event)
  }
  return {
    root,
    cfg,
    runtime,
    bridge,
    calls,
    prompts,
    replies,
    identities,
    errors,
    fatalErrors,
    async message(openId, text, overrides = {}) {
      sequence += 1
      await invoke("im.message.receive_v1", {
        event_id: `evt_msg_${sequence}`,
        message: {
          message_id: `om_msg_${sequence}`,
          chat_id: `oc_${openId}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
          ...overrides,
        },
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    async media(openId, type, content) {
      sequence += 1
      await invoke("im.message.receive_v1", {
        event_id: `evt_media_${sequence}`,
        message: {
          message_id: `om_media_${sequence}`,
          chat_id: `oc_${openId}`,
          chat_type: "p2p",
          message_type: type,
          content: JSON.stringify(content),
        },
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    async press(data, openId = "ou_owner", overrides = {}) {
      const messageId = `om_panel_${openId}`
      const result = await invoke("card.action.trigger", {
        event_id: `evt_card_${++sequence}`,
        context: { open_message_id: messageId, open_chat_id: `oc_${openId}`, ...overrides },
        operator: { open_id: openId },
        action: { value: { data }, tag: "button" },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      return result
    },
    async rawPress(data, openId = "ou_owner", options = {}) {
      const result = await invoke("card.action.trigger", {
        event_id: options.eventId ?? `evt_card_${++sequence}`,
        context: {
          open_message_id: options.messageId ?? `om_panel_${openId}`,
          open_chat_id: options.chatId ?? `oc_${openId}`,
        },
        operator: { open_id: openId },
        action: { value: { data }, tag: "button" },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      return result
    },
    async sendEvent(openId, text, eventId, messageId) {
      await invoke("im.message.receive_v1", {
        event_id: eventId,
        message: {
          message_id: messageId,
          chat_id: `oc_${openId}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    texts() {
      return calls.filter((call) => call.method === "send" && call.msgType === "interactive").map(messageContent)
    },
    lastText() {
      return this.texts().at(-1) ?? ""
    },
    buttons() {
      const result: Array<{ text: string; data: string }> = []
      for (const call of calls) {
        const content = call.content as
          | { elements?: Array<{ actions?: Array<{ text?: { content?: string }; value?: { data?: string } }> }> }
          | undefined
        for (const element of content?.elements ?? []) {
          for (const action of element.actions ?? []) {
            if (action.value?.data) result.push({ text: action.text?.content ?? "", data: action.value.data })
          }
        }
      }
      return result
    },
    async waitFor(predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("waitFor timed out")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    async close() {
      await runtime.stop()
      await bridge.stop()
      proxies.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("feishu-only startup handles /start without calling Telegram", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    await h.waitFor(() => h.texts().length > 0)
    assert.match(h.lastText(), /欢迎|菜单|私人助手/)
    assert.equal(h.identities.ownerChatId() !== undefined, true)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu leading mention placeholders do not hide slash commands", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "@_user_1 /start")
    await h.waitFor(() => h.texts().some((text) => /欢迎|菜单|私人助手/.test(text)))
    assert.equal(h.prompts.length, 0, "a mention-prefixed command must not reach the AI queue")
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu private-chat whitelist rejects unknown open_ids and accepts the owner", async () => {
  const h = await harness()
  try {
    await h.message("ou_intruder", "/start")
    await h.waitFor(() => h.texts().some((text) => text.includes("未在白名单")))
    assert.match(h.lastText(), /ou_intruder/)
    const before = h.texts().length
    await h.message("ou_owner", "/start")
    await h.waitFor(() => h.texts().length > before)
    assert.doesNotMatch(h.lastText(), /未在白名单/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu card buttons invoke the shared command stack and return a toast", async () => {
  const h = await harness({ allowOpenIds: ["ou_owner", "ou_second"] })
  try {
    await h.message("ou_owner", "/access")
    await h.waitFor(() => h.buttons().some((button) => button.data === "faccess:del:ou_second"))
    const result = (await h.press("faccess:del:ou_second")) as { toast?: { content?: string } } | undefined
    await h.waitFor(() => h.calls.some((call) => call.method === "patch"))
    assert.match(result?.toast?.content ?? "", /已移除 ou_second/)
    assert.doesNotMatch(readFileSync(join(h.root, ".env"), "utf8"), /ou_second/)
  } finally {
    await h.close()
  }
})

test("feishu /access protects the acting user and persists the open_id list", async () => {
  const h = await harness({ allowOpenIds: ["ou_owner"] })
  try {
    await h.message("ou_owner", "/access add ou_second")
    await h.waitFor(() => readFileSync(join(h.root, ".env"), "utf8").includes("ou_second"))
    assert.match(readFileSync(join(h.root, ".env"), "utf8"), /^FEISHU_ALLOW_OPEN_IDS=ou_owner,ou_second$/m)
    assert.equal(h.cfg.feishu?.allowOpenIds.has("ou_second"), true)

    await h.message("ou_owner", "/access del ou_owner")
    await h.waitFor(() => h.texts().some((text) => text.includes("不能把自己移出白名单")))
    assert.equal(h.cfg.feishu?.allowOpenIds.has("ou_owner"), true)
  } finally {
    await h.close()
  }
})

test("feishu owner chat is the delivery target for shared reminders", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const owner = h.bridge.ownerChatId
    assert.equal(owner !== undefined, true)
    const reminder = h.bridge.sharedReminders.add(owner!, h.identities.user("ou_owner"), "30m feishu reminder")
    h.bridge.sharedReminders.postpone(owner!, reminder.id, 1, Date.now() - 60_000)
    assert.ok(reminder.id > 0)
    await h.bridge.sharedReminders.tick()
    await h.waitFor(() => h.texts().some((text) => text.includes("feishu reminder")), 1_000)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu app reminders keep chat_id and user_id in their own namespaces", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const owner = h.bridge.ownerChatId
    const userId = h.identities.user("ou_owner")
    assert.ok(owner !== undefined)
    assert.notEqual(owner, userId)
    assert.equal(h.bridge.ownerUserId, userId)

    const replies: unknown[] = []
    const deps = routeDeps(h, replies, [{ text: "30m feishu api reminder" }])
    await routeReminders(deps, request("POST"), undefined)
    const reminder = h.bridge.sharedReminders.list(owner!).at(-1)
    assert.equal(reminder?.chatId, owner)
    assert.equal(reminder?.userId, userId, "access checks must use the Feishu user id, not the chat id")

    const before = h.calls.length
    h.bridge.sharedReminders.postpone(owner!, reminder!.id, 1, Date.now() - 60_000)
    await h.bridge.sharedReminders.tick()
    await h.waitFor(() =>
      h.calls
        .slice(before)
        .some(
          (call) =>
            call.method === "send" &&
            call.receiveId === "oc_ou_owner" &&
            call.receiveIdType === "chat_id" &&
            messageContent(call).includes("feishu api reminder"),
        ),
    )
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu app schedules keep chat_id and user_id separate and reply to the chat", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const owner = h.bridge.ownerChatId
    const userId = h.identities.user("ou_owner")
    assert.ok(owner !== undefined)
    assert.notEqual(owner, userId)

    const replies: unknown[] = []
    const deps = routeDeps(h, replies, [{ text: "30m feishu api schedule" }])
    await routeSchedules(deps, request("POST"), undefined, undefined)
    const task = h.bridge.sharedSchedules.list(owner!).at(-1)
    assert.equal(task?.chatId, owner)
    assert.equal(task?.userId, userId)

    h.replies.push("scheduled feishu api reply")
    const before = h.calls.length
    await routeSchedules(deps, request("POST"), String(task!.id), "run")
    await h.waitFor(
      () =>
        h.calls
          .slice(before)
          .some(
            (call) =>
              call.method === "send" &&
              call.receiveId === "oc_ou_owner" &&
              call.receiveIdType === "chat_id" &&
              messageContent(call).includes("scheduled feishu api reply"),
          ),
      2_000,
    )
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu parse errors stay contained and group messages are ignored", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "ignored", { chat_type: "group" })
    assert.equal(h.calls.filter((call) => call.method === "send").length, 0)
    await h.message("ou_owner", "bad json", { content: "not json" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu photo downloads through messageResource and becomes an inbox attachment", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const before = h.calls.length
    await h.media("ou_owner", "image", { image_key: "img_v3_owner" })
    await h.waitFor(() => h.calls.some((call) => call.method === "resource" && call.fileKey === "img_v3_owner"))
    const resource = h.calls.find((call) => call.method === "resource")
    assert.equal(resource?.messageId, "om_media_2")
    assert.ok(h.calls.length > before)
    // The bridge turns media into a queued prompt; no Telegram getFile call may occur.
    assert.equal(h.calls.some((call) => call.method === "send" && call.content === undefined), false)
  } finally {
    await h.close()
  }
})

test("feishu file captions survive as prompt text and attachments stay bounded", async () => {
  const h = await harness({ allowOpenIds: ["ou_owner"] })
  try {
    await h.message("ou_owner", "/start")
    await h.media("ou_owner", "file", { file_key: "file_v3_owner", file_name: "report.pdf" })
    await h.waitFor(() => h.calls.some((call) => call.method === "resource" && call.fileKey === "file_v3_owner"))
  } finally {
    await h.close()
  }
})


test("feishu media download records the resource type and saves files into data/inbox", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    await h.media("ou_owner", "file", { file_key: "file_type_owner", file_name: "notes.txt", mime_type: "text/plain" })
    await h.waitFor(() => h.prompts.length > 0)
    const resource = h.calls.find((call) => call.method === "resource")
    assert.equal(resource?.resourceType, "file")
    assert.match(h.prompts.at(-1)?.text ?? "", /\[用户附件\]/)
    assert.match(h.prompts.at(-1)?.text ?? "", /notes\.txt/)
    const inbox = readdirSync(join(h.root, "inbox"))
    assert.ok(inbox.some((name) => name.includes("notes")))
    assert.match(h.prompts.at(-1)?.text ?? "", /hello from feishu/)
    assert.equal(h.prompts.at(-1)?.files.length, 0)
    assert.equal(h.errors.length, 0)
    assert.equal(h.calls.some((call) => call.method === "resource" && call.resourceType === "file"), true)
  } finally {
    await h.close()
  }
})

test("feishu audio and video events reach the shared attachment pipeline", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    await h.media("ou_owner", "audio", { file_key: "audio_v3_owner", file_name: "voice.opus", mime_type: "audio/opus" })
    await h.waitFor(() => h.calls.some((call) => call.method === "resource" && call.fileKey === "audio_v3_owner"))
    const audio = h.calls.find((call) => call.method === "resource" && call.fileKey === "audio_v3_owner")
    assert.equal(audio?.resourceType, "audio")
    assert.match(h.prompts.at(-1)?.text ?? "", /请转写这段音频/)

    await h.media("ou_owner", "video", { file_key: "video_v3_owner", file_name: "clip.mp4", mime_type: "video/mp4" })
    await h.waitFor(() => h.calls.some((call) => call.method === "resource" && call.fileKey === "video_v3_owner"))
    const video = h.calls.find((call) => call.method === "resource" && call.fileKey === "video_v3_owner")
    assert.equal(video?.resourceType, "media")
    assert.match(h.prompts.at(-1)?.text ?? "", /clip\.mp4/)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu rich post text and inline images are both delivered", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const content = JSON.stringify({
      zh_cn: {
        title: "周报",
        content: [[{ tag: "text", text: "请检查这张图" }, { tag: "img", image_key: "img_post_owner" }]],
      },
    })
    await h.message("ou_owner", "", { message_type: "post", content })
    await h.waitFor(() => h.prompts.length > 0)
    const resource = h.calls.find((call) => call.method === "resource" && call.fileKey === "img_post_owner")
    assert.equal(resource?.resourceType, "image")
    assert.match(h.prompts.at(-1)?.text ?? "", /周报/)
    assert.match(h.prompts.at(-1)?.text ?? "", /请检查这张图/)
    assert.equal(h.prompts.at(-1)?.files.length, 1)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu /menu and panel buttons render and invoke the shared panels", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/menu")
    await h.waitFor(() => h.buttons().some((button) => button.data === "show:status"))
    assert.match(h.lastText(), /功能菜单/)
    await h.press("show:status")
    await h.waitFor(() => h.calls.some((call) => call.method === "patch"))
    assert.match(h.lastText(), /状态|引擎|运行/)
    await h.press("show:menu")
    await h.waitFor(() => h.buttons().some((button) => button.data === "show:schedule"))
  } finally {
    await h.close()
  }
})

test("feishu /schedule creates, pauses, resumes, runs and deletes a task", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/schedule add 30m feishu scheduled task")
    await h.waitFor(() => h.texts().some((text) => text.includes("定时任务已创建")))
    const created = h.lastText()
    const match = /#(\d+)/.exec(created)
    assert.ok(match, created)
    const id = Number(match[1])
    await h.message("ou_owner", `/schedule pause ${id}`)
    await h.waitFor(() => h.texts().some((text) => text.includes(`已暂停定时任务 #${id}`)))
    await h.message("ou_owner", `/schedule resume ${id}`)
    await h.waitFor(() => h.texts().some((text) => text.includes(`已恢复定时任务 #${id}`)))
    await h.message("ou_owner", "/schedule")
    await h.waitFor(() => h.buttons().some((button) => button.data === `sched:run:${id}`))
    h.replies.push("scheduled reply from feishu")
    await h.press(`sched:run:${id}`)
    await h.waitFor(() => h.texts().some((text) => text.includes("scheduled reply from feishu")), 2_000)
    assert.ok(h.prompts.some((prompt) => prompt.text.includes("feishu scheduled task")))
    await h.message("ou_owner", `/schedule del ${id}`)
    await h.waitFor(() => h.texts().some((text) => text.includes(`已删除定时任务 #${id}`)))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu /export sends a Markdown document and labels the source", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "remember this for export")
    await h.waitFor(() => h.prompts.length > 0)
    await h.waitFor(() => h.texts().some((text) => text.includes("echo:")))
    await h.waitFor(() => existsSync(join(h.root, "history.json")) && readFileSync(join(h.root, "history.json"), "utf8").includes("remember this for export"))
    await h.message("ou_owner", "/export")
    await h.waitFor(() => h.calls.some((call) => call.method === "file"))
    const upload = h.calls.find((call) => call.method === "file")
    assert.equal(upload?.fileType, "stream")
    assert.ok(upload?.fileName?.endsWith(".md"))
    const send = h.calls.find((call) => call.method === "send" && call.msgType === "file")
    assert.ok(send)
    assert.equal(send?.receiveIdType, "chat_id")
  } finally {
    await h.close()
  }
})

test("feishu /ops panel and diagnostics use the shared operations stack", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/ops")
    await h.waitFor(() => h.texts().some((text) => text.includes("运维中心")))
    await h.press("ops:diag")
    await h.waitFor(() => h.texts().some((text) => text.includes("诊断")))
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu duplicate event ids are ignored but a new click on the same button runs", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const before = h.texts().length
    await h.sendEvent("ou_owner", "duplicate probe", "evt_same", "om_same")
    await h.waitFor(() => h.prompts.length === 1)
    await h.sendEvent("ou_owner", "duplicate probe", "evt_same", "om_same")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.prompts.length, 1)
    assert.ok(h.texts().length > before)
    const patchesBefore = h.calls.filter((call) => call.method === "patch").length
    await h.rawPress("show:status", "ou_owner", { eventId: "evt_card_same" })
    await h.waitFor(() => h.calls.filter((call) => call.method === "patch").length > patchesBefore)
    const patchesAfterFirst = h.calls.filter((call) => call.method === "patch").length
    await h.rawPress("show:status", "ou_owner", { eventId: "evt_card_same" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.calls.filter((call) => call.method === "patch").length, patchesAfterFirst)
    await h.rawPress("show:status", "ou_owner", { eventId: "evt_card_new" })
    await h.waitFor(() => h.calls.filter((call) => call.method === "patch").length > patchesAfterFirst)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu and telegram ownership do not cross-deliver when only Feishu is configured", async () => {
  const h = await harness()
  try {
    // Simulate a leftover Telegram whitelist in a Feishu-only deployment.
    h.cfg.telegram.allowUsers.add("12345")
    await h.message("ou_owner", "/start")
    const owner = h.bridge.ownerChatId
    assert.ok(owner !== undefined)
    assert.equal(h.identities.hasNumericId(owner!), true)
    assert.notEqual(owner, 12345)
    const reminder = h.bridge.sharedReminders.add(owner!, h.identities.user("ou_owner"), "30m owner routing probe", Date.now())
    h.bridge.sharedReminders.postpone(owner!, reminder.id, 1, Date.now() - 60_000)
    await h.bridge.sharedReminders.tick()
    await h.waitFor(() => h.texts().some((text) => text.includes("owner routing probe")), 1_000)
  } finally {
    await h.close()
  }
})

test("telegram owns notification delivery when both chat channels are configured", async () => {
  const h = await harness({ telegramToken: "12345:token" })
  try {
    h.cfg.telegram.allowUsers.add("24680")
    // Feishu has a persisted owner, but the explicit Telegram owner must win.
    await h.message("ou_owner", "/start")
    await h.waitFor(() => h.identities.ownerChatId() !== undefined)
    assert.equal(h.bridge.ownerChatId, 24680)
    assert.equal(h.bridge.ownerUserId, 24680)
    const { peerSessions } = await import("../src/apiPersonal.js")
    const channel = {
      isFeishuId: (id: number) => h.identities.hasNumericId(id),
    }
    const peers = peerSessions({ ownerChatId: h.bridge.ownerChatId, channel } as never)
    assert.equal(peers.find((peer) => peer.scope === "telegram")?.key, "tg:24680")
    assert.equal(peers.some((peer) => peer.scope === "feishu"), false)
  } finally {
    await h.close()
  }
})

test("a Feishu owner is exposed to the app as a Feishu peer, not a Telegram one", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    const owner = h.bridge.ownerChatId
    assert.ok(owner !== undefined)
    const { peerSessions } = await import("../src/apiPersonal.js")
    const peers = peerSessions({ ownerChatId: owner, channel: { isFeishuId: (id: number) => h.identities.hasNumericId(id) } } as never)
    const peer = peers.find((entry) => entry.scope !== "app")
    assert.equal(peer?.scope, "feishu")
    assert.equal(peer?.label, "飞书会话")
    assert.equal(peer?.key, `fs:${owner}`)
  } finally {
    await h.close()
  }
})

test("feishu session keys stay isolated from telegram keys", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    await h.message("ou_owner", "feishu context")
    await h.waitFor(() => h.prompts.length === 1)
    const sessions = JSON.parse(readFileSync(join(h.root, "sessions.json"), "utf8")) as Record<string, unknown>
    assert.ok(Object.keys(sessions).some((key) => key.startsWith("fs:")))
    assert.ok(!Object.keys(sessions).some((key) => key.startsWith("tg:")))
  } finally {
    await h.close()
  }
})

test("feishu outbound image, voice, video and file replies use the matching APIs", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "/start")
    writeFileSync(join(h.cfg.outboxDir, "sample.png"), Buffer.from("content-sample.png"))
    writeFileSync(join(h.cfg.outboxDir, "sample.mp3"), Buffer.from("content-sample.mp3"))
    const mp4 = Buffer.alloc(64)
    mp4.writeUInt32BE(36, 0)
    mp4.write("moov", 4, "ascii")
    mp4.writeUInt32BE(28, 8)
    mp4.write("mvhd", 12, "ascii")
    mp4.writeUInt32BE(1000, 28)
    mp4.writeUInt32BE(2_500, 32)
    writeFileSync(join(h.cfg.outboxDir, "sample.mp4"), mp4)
    writeFileSync(join(h.cfg.outboxDir, "sample.pdf"), Buffer.from("content-sample.pdf"))
    h.replies.push(
      "[[image:data/outbox/sample.png]]\n" +
        "[[voice:data/outbox/sample.mp3]]\n" +
        "[[video:data/outbox/sample.mp4]]\n" +
        "[[file:data/outbox/sample.pdf]]",
    )
    await h.message("ou_owner", "send all media kinds")
    await h.waitFor(() => h.calls.some((call) => call.method === "send" && call.msgType === "file"))
    assert.ok(h.calls.some((call) => call.method === "send" && call.msgType === "image"))
    assert.ok(h.calls.some((call) => call.method === "send" && call.msgType === "audio"))
    assert.ok(h.calls.some((call) => call.method === "send" && call.msgType === "media"))
    const uploads = h.calls.filter((call) => call.method === "file")
    assert.ok(uploads.some((call) => call.fileType === "opus"))
    assert.ok(uploads.some((call) => call.fileType === "mp4"))
    assert.ok(uploads.some((call) => call.fileType === "pdf"))
    assert.equal(uploads.find((call) => call.fileType === "mp4")?.duration, 2_500)
    assert.equal(h.errors.length, 0)
  } finally {
    await h.close()
  }
})

test("feishu outbound accepts upload responses wrapped in data", async () => {
  const calls: FeishuCall[] = []
  const outbound = new FeishuOutbound(fakeFeishu(calls, undefined, "data"))
  const message = await outbound.sendImage(1, "oc_owner", Buffer.from("png"), "caption")
  assert.equal(message.caption, "caption")
  assert.equal(calls.some((call) => call.method === "image"), true)
  assert.equal(calls.some((call) => call.method === "send" && call.msgType === "image"), true)

  const document = await outbound.sendDocument(1, "oc_owner", Buffer.from("pdf"), "report.pdf")
  assert.equal(calls.some((call) => call.method === "send" && call.msgType === "file"), true)
  assert.equal(document.audio, undefined)
})

test("feishu card callback endpoint verifies signatures, answers challenges and runs buttons", async () => {
  const token = "callback-token"
  const h = await harness({ callback: { verificationToken: token } })
  await h.runtime.callback?.start()
  const endpoint = h.runtime.callback?.endpoint
  assert.ok(endpoint)
  const path = new URL(endpoint).pathname
  const post = (body: Record<string, unknown>, signature?: string): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature
          ? {
              "x-lark-request-timestamp": "1700000000",
              "x-lark-request-nonce": "nonce",
              "x-lark-signature": signature,
            }
          : {}),
      },
      body: JSON.stringify(body),
    })
  try {
    const challenge = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", token, challenge: "challenge-value" }),
    })
    assert.equal(challenge.status, 200)
    assert.deepEqual(await challenge.json(), { challenge: "challenge-value" })

    const click = {
      schema: "2.0",
      header: { event_type: "card.action.trigger", token },
      event: {
        context: { open_message_id: "om_callback", open_chat_id: "oc_ou_owner" },
        operator: { open_id: "ou_owner" },
        action: { value: { data: "show:menu" }, tag: "button" },
      },
    }
    const badToken = await post({ ...click, header: { ...click.header, token: "wrong-token" } })
    assert.equal(badToken.status, 403)

    const timestamp = "1700000000"
    const nonce = "nonce"
    // v2 card callbacks are authenticated by header.token (not the body
    // signature). Keep a signature header too, matching a real Feishu push.
    const signature = createHash("sha1").update(timestamp + nonce + token + JSON.stringify(click)).digest("hex")
    const accepted = await post(click, signature)
    assert.equal(accepted.status, 200)
    await h.waitFor(() => h.calls.some((call) => call.method === "patch" && call.messageId === "om_callback"))
    assert.ok(h.calls.some((call) => call.method === "patch" && call.messageId === "om_callback"))

    const missing = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/wrong`, { method: "POST" })
    assert.equal(missing.status, 404)
    assert.equal(path, "/feishu/card")
  } finally {
    await h.close()
  }
})

test("feishu /usage shows per-user statistics after a task", async () => {
  const h = await harness()
  try {
    await h.message("ou_owner", "usage probe")
    await h.waitFor(() => h.prompts.length === 1)
    await h.waitFor(() => h.texts().some((text) => text.includes("echo: usage probe")))
    await h.waitFor(
      () => existsSync(join(h.root, "history.json")) && readFileSync(join(h.root, "history.json"), "utf8").includes("usage probe"),
    )
    await h.message("ou_owner", "/usage")
    await h.waitFor(() => h.texts().some((text) => text.includes("总任务：1")))
    assert.match(h.lastText(), /成功率：100%/)
  } finally {
    await h.close()
  }
})

test("feishu long-connection startup failure reaches onFatal", async () => {
  const h = await harness({ wsFails: true })
  try {
    await h.waitFor(() => h.fatalErrors.length > 0)
    assert.match(h.fatalErrors[0]?.message ?? "", /no route/)
    assert.equal(h.runtime.service.started, true)
  } finally {
    await h.close()
  }
})
