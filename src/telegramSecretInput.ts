import { InlineKeyboard, type Bot } from "grammy"
import { APP_CHAT_ID } from "./appNotices.js"
import type { Logger } from "./logger.js"
import { extractSecretRequests, secretContinuationPrompt, type SecretRequest } from "./secretRequests.js"
import { activeSecretVault, maskSecretValues, secretValueProblem } from "./secretVault.js"

/**
 * 安全输入 cards on Telegram and Feishu.
 *
 * 1. A command that needs a key but was sent without one (`/magpie provider add openai`, or `?`
 *    in the key's place) gets a card; the user's next message is taken as the key, deleted at
 *    once and spliced into the command, which then runs as if it had been typed whole.
 * 2. A command that carries a key inline still runs, but the message holding it is deleted.
 * 3. An Agent reply with `[[secret: NAME | 用途]]` gets one card per name. The values go to the
 *    secret vault, never to the model, and the task resumes on its own once all are given.
 *
 * A value never enters the queue, the task history, the journal or the logs. Feishu cannot
 * delete a user's message, so there the card asks for a manual recall instead.
 */
export const PROMPT_TTL_MS = 10 * 60_000
/** After a card expired, a key-like message is still kept from the model for this long. */
const EXPIRED_GRACE_MS = 30 * 60_000

export interface CommandSlot {
  label: string
  fill: (value: string) => string
  /** Why this value cannot go into the command, if it cannot. */
  check?: (value: string) => string | undefined
}

const SECRET_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/i
const noSpaces = (value: string): string | undefined => (/\s/.test(value) ? "这个命令的密钥里不能有空格或换行" : undefined)

function words(text: string): { command: string; parts: string[] } {
  const parts = text.trim().split(/\s+/)
  return { command: (parts[0] ?? "").toLowerCase().split("@")[0] ?? "", parts }
}

/** A sensitive command whose key was left out (or written as `?`): ask for it with a card. */
export function commandSecretSlot(text: string): CommandSlot | undefined {
  const { command, parts } = words(text)
  const [, sub, verb] = parts.map((part) => part.toLowerCase())
  if (command === "/magpie" && sub === "provider" && verb === "add" && parts[3]) {
    const preset = parts[3]
    if (parts.length === 4 || (parts.length === 5 && parts[4] === "?")) {
      return { label: `magpie 预设 ${preset} 的 API Key`, fill: (value) => `/magpie provider add ${preset} ${value}`, check: noSpaces }
    }
  }
  if (command === "/cc" && sub === "provider" && verb === "add" && /(^|\s)key=\?(?=\s|$)/.test(text)) {
    return {
      label: "cc-switch 供应商的 API Key",
      fill: (value) => text.replace(/(^|\s)key=\?(?=\s|$)/, (_match, lead: string) => `${lead}key=${value}`),
      check: noSpaces,
    }
  }
  if (command === "/account" && (sub === "add" || sub === "edit")) {
    const head = /^\s*\S+\s+\S+/.exec(text)?.[0] ?? ""
    const fields = text.slice(head.length).split("|")
    if (fields[2]?.trim() === "?") {
      return {
        label: `账号「${fields[0]?.trim() ?? ""}」的密码`,
        fill: (value) => `${head}${fields.map((field, index) => (index === 2 ? ` ${value} ` : field)).join("|")}`,
        check: (value) => (value.includes("|") || /[\r\n]/.test(value) ? "密码里不能有 | 或换行" : undefined),
      }
    }
  }
  if (command === "/env" && sub === "set" && parts[2]) {
    const key = parts[2]
    if ((parts.length === 3 && SECRET_ENV_KEY.test(key)) || (parts.length === 4 && parts[3] === "?")) {
      return { label: `配置项 ${key} 的值`, fill: (value) => `/env set ${key} ${value}`, check: (value) => (/[\r\n]/.test(value) ? "值里不能有换行" : undefined) }
    }
  }
  return undefined
}

/** A command that already carries a key in its text: it runs, but the message is deleted. */
export function carriesInlineSecret(text: string): boolean {
  const { command, parts } = words(text)
  const [, sub, verb] = parts.map((part) => part.toLowerCase())
  if (command === "/magpie" && sub === "provider" && verb === "add") return parts.length >= 5 && parts[4] !== "?"
  if (command === "/cc") return /(^|\s)key=(?!\?(\s|$))\S+/.test(text)
  if (command === "/account" && (sub === "add" || sub === "edit")) {
    const password = text.split("|")[2]?.trim()
    return Boolean(password && password !== "?" && password !== "-")
  }
  if (command === "/env" && sub === "set") return parts.length >= 4 && parts[3] !== "?" && SECRET_ENV_KEY.test(parts[2] ?? "")
  if (command === "/proxy" && sub === "add") return /:\/\/[^\s/@:]+:[^\s/@]+@/.test(text)
  return false
}

export interface SecretInputHost {
  bot: Bot
  log: Logger
  sessionKey: (chatId: number) => string
  isFeishu: (chatId: number) => boolean
  /** Queues the Agent's continuation once every requested secret is in. */
  enqueue: (job: { key: string; chatId: number; userId: number; text: string }) => void
}

interface PromptBase {
  id: string
  chatId: number
  userId: number
  messageId?: number
  timer?: NodeJS.Timeout
}
type Prompt =
  | (PromptBase & { kind: "command"; slot: CommandSlot })
  | (PromptBase & { kind: "agent"; key: string; requests: SecretRequest[]; index: number })

let promptSequence = 0

export class TelegramSecretInput {
  readonly #host: SecretInputHost
  readonly #prompts = new Map<number, Prompt>()
  readonly #expired = new Map<number, number>()
  #runner?: (chatId: number, userId: number, text: string) => Promise<void>

  constructor(host: SecretInputHost) {
    this.#host = host
  }

  /** The bridge's own text handler; a command completed by a card goes back through it. */
  setRunner(runner: (chatId: number, userId: number, text: string) => Promise<void>): void {
    this.#runner = runner
  }

  /** Runs before every text message. True when the message was a secret (or /secrets) and is done. */
  async intercept(message: { chatId: number; userId: number; messageId: number; text: string }): Promise<boolean> {
    const { chatId, userId, messageId, text } = message
    const { command, parts } = words(text)
    if (command === "/secrets") {
      await this.#secretsCommand(chatId, (parts[1] ?? "").toLowerCase())
      return true
    }
    const prompt = this.#prompts.get(chatId)
    // Bare /cancel only: `/cancel 3` still cancels reminder 3
    if (prompt && command === "/cancel" && parts.length === 1) {
      await this.#close(prompt, "已取消，没有保存任何内容。")
      return true
    }
    if (prompt && prompt.userId === userId && !text.startsWith("/")) {
      await this.#removeUserMessage(chatId, messageId)
      await this.#receive(prompt, text)
      return true
    }
    if (text.startsWith("/")) {
      const slot = commandSecretSlot(text)
      if (slot) {
        await this.#open({ id: `s${++promptSequence}`, chatId, userId, kind: "command", slot }, slot.label, "命令补全后立即执行。")
        return true
      }
      if (carriesInlineSecret(text)) {
        const removed = await this.#removeUserMessage(chatId, messageId)
        await this.#say(chatId, removed ? "🔐 这条命令包含密钥，原消息已自动删除。下次可以把密钥写成 ? ，我会弹出安全输入卡片。" : "⚠️ 这条命令包含密钥，请手动撤回原消息。")
      }
      return false
    }
    // A key pasted just after its card expired must still not reach the model
    const expiredAt = this.#expired.get(chatId)
    if (expiredAt && Date.now() - expiredAt < EXPIRED_GRACE_MS && !/\s/.test(text) && text.length >= 16) {
      this.#expired.delete(chatId)
      await this.#removeUserMessage(chatId, messageId)
      await this.#say(chatId, "⚠️ 安全输入卡片已过期。这条消息看起来像密钥，没有发给 AI，也没有保存（已尝试删除）。需要的话请重新发起。")
      return true
    }
    return false
  }

  /** The 取消 button on a card. Returns the toast text, or undefined when it is not ours. */
  async handleCallback(data: string, chatId: number): Promise<string | undefined> {
    const match = /^seccancel:(s\d+)$/.exec(data)
    if (!match) return undefined
    const prompt = this.#prompts.get(chatId)
    if (!prompt || prompt.id !== match[1]) return "这张卡片已经失效"
    await this.#close(prompt, "已取消，没有保存任何内容。")
    return "已取消"
  }

  /** Takes the secret requests out of an Agent reply; `ask` shows their cards after the reply. */
  fromReply(job: { key: string; chatId: number; userId: number; scheduled?: boolean }, reply: string): { text: string; ask: () => Promise<void> } {
    const extracted = extractSecretRequests(reply)
    const { requests } = extracted
    const text = maskSecretValues(extracted.text)
    if (requests.length === 0) return { text, ask: async () => {} }
    const vault = activeSecretVault()
    if (!vault || job.scheduled || job.chatId === APP_CHAT_ID) {
      const why = vault ? "定时任务里无法填写" : "安全输入未启用"
      return { text: `${text}\n\n⚠️ AI 请求提供 ${requests.map((request) => request.name).join("、")}，但${why}。`, ask: async () => {} }
    }
    const missing = requests.filter((request) => !vault.has(job.key, request.name))
    if (missing.length === 0) {
      const names = requests.map((request) => request.name).join("、")
      return { text: `${text}\n\nℹ️ ${names} 之前已通过安全输入提供，AI 可以继续读取；要换新值先发送 /secrets clear。`, ask: async () => {} }
    }
    return {
      text,
      ask: () =>
        this.#open(
          { id: `s${++promptSequence}`, chatId: job.chatId, userId: job.userId, kind: "agent", key: job.key, requests: missing, index: 0 },
          ...this.#agentCardText(missing, 0),
        ),
    }
  }

  #agentCardText(requests: SecretRequest[], index: number): [string, string] {
    const request = requests[index]!
    const step = requests.length > 1 ? `（${index + 1}/${requests.length}）` : ""
    return [`AI 请求提供 ${request.name}${step}${request.purpose ? `\n用途：${request.purpose}` : ""}`, "值不会发给 AI，24 小时后自动清除；全部提供后任务自动继续。"]
  }

  async #open(prompt: Prompt, title: string, footer: string): Promise<void> {
    const previous = this.#prompts.get(prompt.chatId)
    if (previous) await this.#close(previous, "已被新的安全输入替代。")
    const manual = this.#host.isFeishu(prompt.chatId)
      ? "飞书无法自动删除你的消息：发送后请手动撤回；更安全的方式是在 App 里填写。"
      : "你的消息收到后会立即删除。"
    const text = `🔐 安全输入\n${title}\n\n请直接发送值。${manual}\n${footer}\n${Math.round(PROMPT_TTL_MS / 60_000)} 分钟内有效，发送 /cancel 取消。`
    try {
      const sent = await this.#host.bot.api.sendMessage(prompt.chatId, text, {
        reply_markup: new InlineKeyboard().text("取消", `seccancel:${prompt.id}`),
      })
      prompt.messageId = sent.message_id
    } catch (err) {
      this.#host.log.warn("failed to send a secret input card:", (err as Error).message)
      return
    }
    this.#arm(prompt)
    this.#prompts.set(prompt.chatId, prompt)
  }

  #arm(prompt: Prompt): void {
    if (prompt.timer) clearTimeout(prompt.timer)
    prompt.timer = setTimeout(() => {
      if (this.#prompts.get(prompt.chatId) !== prompt) return
      this.#expired.set(prompt.chatId, Date.now())
      void this.#close(prompt, "⌛ 已过期，没有保存任何内容。")
    }, PROMPT_TTL_MS)
    prompt.timer.unref()
  }

  async #receive(prompt: Prompt, raw: string): Promise<void> {
    const value = raw.trim()
    if (prompt.kind === "command") {
      const problem = secretValueProblem(value) ?? prompt.slot.check?.(value)
      if (problem) {
        await this.#say(prompt.chatId, `⚠️ ${problem}，请重新发送（原消息已删除）。`)
        return
      }
      await this.#close(prompt, `✅ 已收到${prompt.slot.label}，正在执行命令…`)
      await this.#runner?.(prompt.chatId, prompt.userId, prompt.slot.fill(value))
      return
    }
    const request = prompt.requests[prompt.index]!
    const vault = activeSecretVault()
    try {
      if (!vault) throw new Error("安全输入未启用")
      vault.set(prompt.key, request.name, value, request.purpose)
    } catch (err) {
      await this.#say(prompt.chatId, `⚠️ 没有保存：${(err as Error).message}。请重新发送（原消息已删除）。`)
      return
    }
    await this.#edit(prompt, `✅ 已安全保存 ${request.name}，你的消息已删除。`)
    if (prompt.index + 1 < prompt.requests.length) {
      prompt.index += 1
      this.#prompts.delete(prompt.chatId)
      if (prompt.timer) clearTimeout(prompt.timer)
      await this.#open({ ...prompt, timer: undefined, messageId: undefined }, ...this.#agentCardText(prompt.requests, prompt.index))
      return
    }
    this.#forget(prompt)
    const names = prompt.requests.map((item) => item.name)
    this.#host.enqueue({
      key: prompt.key,
      chatId: prompt.chatId,
      userId: prompt.userId,
      text: secretContinuationPrompt(names, vault!.dirFor(prompt.key)),
    })
  }

  async #secretsCommand(chatId: number, action: string): Promise<void> {
    const vault = activeSecretVault()
    const key = this.#host.sessionKey(chatId)
    if (!vault) {
      await this.#say(chatId, "安全输入未启用。")
      return
    }
    if (action === "clear") {
      const count = vault.clear(key)
      await this.#say(chatId, count > 0 ? `🧹 已清除本会话保存的 ${count} 个密钥。` : "本会话没有保存密钥。")
      return
    }
    const items = vault.list(key)
    if (items.length === 0) {
      await this.#say(chatId, "本会话没有通过安全输入保存的密钥。AI 需要时会弹出卡片。")
      return
    }
    const lines = items.map((item) => {
      const hours = Math.max(1, Math.round((item.expiresAt - Date.now()) / 3_600_000))
      return `• ${item.name}${item.purpose ? `（${item.purpose}）` : ""}，约 ${hours} 小时后清除`
    })
    await this.#say(chatId, `🔐 本会话保存的密钥（值不显示）：\n${lines.join("\n")}\n\n发送 /secrets clear 立即清除。`)
  }

  async #close(prompt: Prompt, status: string): Promise<void> {
    this.#forget(prompt)
    await this.#edit(prompt, status)
  }

  #forget(prompt: Prompt): void {
    if (prompt.timer) clearTimeout(prompt.timer)
    if (this.#prompts.get(prompt.chatId) === prompt) this.#prompts.delete(prompt.chatId)
  }

  async #edit(prompt: Prompt, status: string): Promise<void> {
    if (prompt.messageId === undefined) return
    await this.#host.bot.api.editMessageText(prompt.chatId, prompt.messageId, `🔐 安全输入\n${status}`).catch(() => undefined)
  }

  async #removeUserMessage(chatId: number, messageId: number): Promise<boolean> {
    if (this.#host.isFeishu(chatId)) return false
    return this.#host.bot.api.deleteMessage(chatId, messageId).then(
      () => true,
      () => false,
    )
  }

  async #say(chatId: number, text: string): Promise<void> {
    await this.#host.bot.api.sendMessage(chatId, text).catch((err: unknown) => {
      this.#host.log.warn("failed to send a secret input notice:", (err as Error).message)
    })
  }
}
