import { InputFile, type Bot, type InlineKeyboard } from "grammy"
import QRCode from "qrcode"
import { pairingQrPayload, resolveApiToken, resolveEncKey, resolvePairingUrl } from "./api.js"
import { redactSecrets } from "./ccswitch.js"
import type { BotConfig } from "./config.js"
import { channelOfChatId, type ChannelIdResolver } from "./channelRegistry.js"
import { formatHistoryMarkdown, type TaskHistoryStore } from "./history.js"
import type { Logger } from "./logger.js"
import { clip, escapeMarkdown, type Panel } from "./messages.js"

export interface InfoCommandDeps {
  cfg: BotConfig
  log: Logger
  bot: Bot
  history: TaskHistoryStore
  timezone: () => string
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  queuePanel: (key: string) => Panel
  statusText: (chatId: number, key: string) => string
  statusKeyboard: () => InlineKeyboard
  usagePanel: (key: string) => Panel
  /** Distinguishes a synthetic Feishu chat from a Telegram chat in exports. */
  channel?: ChannelIdResolver
}

export class TelegramInfoCommands {
  readonly #deps: InfoCommandDeps

  constructor(deps: InfoCommandDeps) {
    this.#deps = deps
  }

  async handleQueue(chatId: number, key: string): Promise<void> {
    await this.#deps.sendPanel(chatId, this.#deps.queuePanel(key))
  }

  /** Pairing info for the companion Android app: endpoint, token and exposure hints. */
  async handleApiInfo(chatId: number): Promise<void> {
    if (!this.#deps.cfg.api.enabled) {
      await this.#deps.sendText(
        chatId,
        "⚠️ HTTP API 当前未启用。在 .env 中设置 `API_ENABLED=1` 并重启 Bot 后可用。",
      )
      return
    }
    let token: string
    try {
      token = resolveApiToken(this.#deps.cfg)
    } catch (err) {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err))
      await this.#deps.sendText(
        chatId,
        `⚠️ 无法生成或读取 API 令牌（${escapeMarkdown(detail)}）。请检查 data 目录权限，或在 .env 中直接设置 API_TOKEN。`,
      )
      return
    }
    const { port, bind } = this.#deps.cfg.api
    const wildcard = bind === "0.0.0.0" || bind === "::"
    // The App can only use an address it can actually dial, so a QR needs API_PUBLIC_URL or a
    // concrete API_BIND; without either the text keeps the placeholder and says how to fix it.
    const pairingUrl = resolvePairingUrl(this.#deps.cfg)
    const address = pairingUrl ? `${pairingUrl}/api/v1` : `http://<你的服务器地址>:${port}/api/v1`
    let qrBuffer: Buffer | undefined
    // 启用了消息级加密时,把配对密钥一起放进二维码(App 侧自动开启加密)
    const encKey = resolveEncKey(this.#deps.cfg)?.toString("base64")
    if (pairingUrl) {
      try {
        qrBuffer = await QRCode.toBuffer(
          JSON.stringify(pairingQrPayload(pairingUrl, token, encKey)),
          {
            margin: 2,
            width: 640,
            color: { dark: "#0b0c0e", light: "#ffffff" },
          },
        )
      } catch (err) {
        this.#deps.log.warn(`pairing QR generation failed: ${(err as Error).message}`)
      }
    }

    const text =
      `📱 *安卓 App 配对信息*\n` +
      `• API 地址: \`${address}\`\n` +
      `• 访问令牌: \`${token}\`\n\n` +
      (encKey
        ? "🔐 消息级加密已启用：二维码含配对密钥，扫码后请求与响应将自动加密。\n\n"
        : "🔒 消息级加密：未启用。在 .env 设置 `API_ENCRYPTION=1` 并重启后，二维码会带上配对密钥，App 通信将自动加密。\n\n") +
      (pairingUrl
        ? ""
        : "📷 没有附上二维码：服务器还不确定手机该连哪个地址。在 .env 设置 `API_PUBLIC_URL`（局域网如 `http://192.168.1.10:3080`，反向代理如 `https://bot.example.com`，挂在子路径上则连前缀一起写如 `https://bot.example.com/agent-bot`）并重启后，再发一次 /api 就能扫码配对；App 的「设置」页也可以手动填地址。\n\n") +
      (wildcard
        ? "⚠️ 当前监听所有网卡。请配合反向代理 / SSH 隧道 / VPN 暴露给手机，并保持令牌鉴权。\n\n"
        : "") +
      (!pairingUrl && !wildcard
        ? "⚠️ 当前仅监听本机回环地址，手机无法直连。可在 .env 设置 `API_BIND=0.0.0.0` 后配合反向代理 / SSH 隧道 / VPN 暴露给手机；令牌鉴权会一直保留。\n\n"
        : "") +
      "在 App 的「设置」页也可直接「扫码配对」;令牌持久化在 `data/api-token.json`，设置 `API_TOKEN` 可固定。"
    if (qrBuffer) {
      try {
        await this.#deps.bot.api.sendPhoto(chatId, new InputFile(qrBuffer, "agentbot-pairing.png"), {
          caption: clip(text, 1000),
          parse_mode: "Markdown",
        })
        return
      } catch (err) {
        this.#deps.log.warn(`pairing QR send failed: ${(err as Error).message}`)
      }
    }
    await this.#deps.sendText(chatId, text)
  }

  /** Sends the chat's task history as a downloadable Markdown or JSON document. */
  async handleExport(chatId: number, key: string, arg: string): Promise<void> {
    const format = (arg.trim().toLowerCase() || "md").replace(/^\./, "")
    if (!["md", "markdown", "json"].includes(format)) {
      await this.#deps.sendText(chatId, "用法：`/export`（Markdown，默认）或 `/export json`")
      return
    }
    const entries = this.#deps.history.list(key, 50)
    const stamp = new Date()
    const pad = (value: number): string => String(value).padStart(2, "0")
    const name = `agentbot-history-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
    if (format === "json") {
      const payload = JSON.stringify({ exportedAt: stamp.toISOString(), key, entries }, null, 2)
      await this.#deps.bot.api.sendDocument(chatId, new InputFile(Buffer.from(payload, "utf8"), `${name}.json`), {
        caption: `🗂 任务历史（JSON，${entries.length} 条）`,
      })
      return
    }
    if (entries.length === 0) {
      await this.#deps.sendText(chatId, "📭 还没有任务记录，先聊点别的吧。")
      return
    }
    const channel = channelOfChatId(chatId, this.#deps.channel)
    const markdown = formatHistoryMarkdown(entries, {
      source: `${channel === "feishu" ? "Feishu" : "Telegram"} ${chatId}`,
      timeZone: this.#deps.timezone(),
    })
    await this.#deps.bot.api.sendDocument(chatId, new InputFile(Buffer.from(markdown, "utf8"), `${name}.md`), {
      caption: `🗂 任务历史（Markdown，${entries.length} 条）`,
    })
  }

  async handleStatus(chatId: number, key: string): Promise<void> {
    await this.#deps.sendText(chatId, this.#deps.statusText(chatId, key), this.#deps.statusKeyboard())
  }

  async handleUsage(chatId: number, key: string): Promise<void> {
    await this.#deps.sendPanel(chatId, this.#deps.usagePanel(key))
  }

}
