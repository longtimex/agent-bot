import { InlineKeyboard } from "grammy"
import { FEISHU_OPEN_ID_RE, type BotConfig } from "./config.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import type { OpsService } from "./ops.js"
import { parseAllowUsers, sortUserIds, TIMEZONE_PRESETS, USER_ID_RE } from "./telegramSupport.js"
import { channelOfChatId, type Channel, type ChannelIdResolver } from "./channelRegistry.js"

export interface AdminCommandDeps {
  cfg: BotConfig
  ops: OpsService
  ownerChatId?: number
  timezone: () => string
  applyLiveEnv: (key: string, value: string) => void
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  accessPanel: (channel?: Channel) => Panel
  timezonePanel: (headline?: string) => string
  /** Resolves a Feishu user's synthetic id back to the open_id stored in the whitelist. */
  openIdForUser?: (userId: number) => string | undefined
  /** Lets the command use the same identity namespace as inbound updates. */
  channel?: ChannelIdResolver
}

export class TelegramAdminCommands {
  readonly #deps: AdminCommandDeps

  constructor(deps: AdminCommandDeps) {
    this.#deps = deps
  }

  async handleAccessCommand(chatId: number, userId: number, arg: string): Promise<void> {
    const channel = this.#channelFor(chatId)
    const [rawAction = "list", ...rest] = arg.split(/\s+/).filter(Boolean)
    const action = rawAction.toLowerCase()

    if (action === "list" || action === "show") {
      await this.#deps.sendPanel(chatId, this.#deps.accessPanel(channel))
      return
    }
    if (action !== "add" && action !== "del" && action !== "delete" && action !== "remove") {
      await this.#deps.sendText(
        chatId,
        channel === "feishu"
          ? "用法：`/access` 查看飞书白名单；`/access add <open_id>` 添加；`/access del <open_id>` 移除。"
          : "用法：`/access` 查看白名单；`/access add <用户 ID>` 添加；`/access del <用户 ID>` 移除。",
      )
      return
    }

    const wanted = rest.map((token) => token.replace(/^@/, ""))
    if (wanted.length === 0) {
      await this.#deps.sendText(
        chatId,
        channel === "feishu"
          ? "用法：`/access add <open_id>` 或 `/access del <open_id>`。"
          : "用法：`/access add <用户 ID>` 或 `/access del <用户 ID>`。",
      )
      return
    }
    const invalid = wanted.filter((token) => !this.#validAccessId(token, channel))
    if (invalid.length > 0) {
      await this.#deps.sendText(
        chatId,
        channel === "feishu"
          ? `❌ 飞书 open_id 应形如 ou_xxx（收到：${escapeMarkdown(invalid.join("、"))}）。`
          : `❌ 用户 ID 只能是 20 位以内的数字（收到：${escapeMarkdown(invalid.join("、"))}）。`,
      )
      return
    }

    const result = this.mutateAccess(action === "add", wanted, userId, channel)
    if (!result.ok) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(result.message)}`)
      return
    }
    await this.#deps.sendText(chatId, result.message)
    await this.#deps.sendPanel(chatId, this.#deps.accessPanel(channel))
  }

  /** Shared by /access, its remove buttons and the HTTP API so the guards cannot drift. */
  mutateAccess(
    adding: boolean,
    wanted: string[],
    self: number | string | undefined,
    channel: Channel = "telegram",
  ): { ok: boolean; message: string } {
    const tokens = wanted.map((token) => token.replace(/^@/, ""))
    if (tokens.length === 0) return { ok: false, message: "请提供用户 ID。" }
    const invalid = tokens.filter((token) => !this.#validAccessId(token, channel))
    if (invalid.length > 0) {
      return {
        ok: false,
        message:
          channel === "feishu"
            ? `飞书 open_id 应形如 ou_xxx（收到：${invalid.join("、")}）。`
            : `用户 ID 只能是 20 位以内的数字（收到：${invalid.join("、")}）。`,
      }
    }
    const current = new Set(this.#allowList(channel))
    const touched = tokens.filter((id) => (adding ? !current.has(id) : current.has(id)))
    if (touched.length === 0) {
      return { ok: false, message: adding ? "这些用户已经在白名单中。" : "这些用户不在白名单中。" }
    }
    const next = new Set(current)
    for (const id of touched) {
      if (adding) next.add(id)
      else next.delete(id)
    }
    if (!adding) {
      const rejection = this.allowListRejection(next, this.#selfAccessId(self, channel), channel)
      if (rejection) return { ok: false, message: rejection }
    }
    // Telegram ids are numeric and sorted by length; open_ids are opaque strings
    // and must not pass through the numeric sorter, which would silently drop them.
    const value = channel === "feishu" ? [...next].sort().join(",") : sortUserIds(next).join(",")
    const key = channel === "feishu" ? "FEISHU_ALLOW_OPEN_IDS" : "TELEGRAM_ALLOW_USERS"
    const result = this.#deps.ops.envSet(key, value, true)
    if (!result.ok) return { ok: false, message: result.message }
    this.#deps.applyLiveEnv(key, value)
    const names = touched.join("、")
    return {
      ok: true,
      message: `${adding ? `✅ 已加入白名单：${names}` : `🗑 已移出白名单：${names}`}（当前 ${next.size} 个用户，立即生效）。`,
    }
  }

  /** Snapshot for the app's /access panel (the app owns the Telegram whitelist). */
  get accessState(): { users: string[]; allowAll: boolean } {
    return {
      users: parseAllowUsers([...this.#deps.cfg.telegram.allowUsers].join(",")),
      allowAll: this.#deps.cfg.telegram.allowAll,
    }
  }

  /** HTTP API counterpart of `/access add`; the owner can never remove themselves. */
  addAccess(ids: string[]): { ok: boolean; message: string } {
    return this.mutateAccess(true, ids, this.#deps.ownerChatId)
  }

  removeAccess(ids: string[]): { ok: boolean; message: string } {
    return this.mutateAccess(false, ids, this.#deps.ownerChatId)
  }

  /** Lockout guards shared by the `/access` command and its remove buttons. */
  allowListRejection(next: Set<string>, self: string, channel: Channel = "telegram"): string | undefined {
    const current = new Set(this.#allowList(channel))
    const allowAll = channel === "feishu" ? this.#deps.cfg.feishu?.allowAll : this.#deps.cfg.telegram.allowAll
    if (allowAll) return undefined
    if (!next.has(self) && current.has(self)) {
      return "不能把自己移出白名单，否则你将无法再控制 Bot。"
    }
    if (next.size === 0) {
      return channel === "feishu"
        ? "飞书白名单不能为空：至少保留 1 个 open_id，或设置 FEISHU_ALLOW_ALL_USERS=1。"
        : "白名单不能为空：至少保留 1 个用户 ID，或设置 TELEGRAM_ALLOW_ALL_USERS=1。"
    }
    return undefined
  }

  #allowList(channel: Channel): Set<string> {
    return channel === "feishu" ? (this.#deps.cfg.feishu?.allowOpenIds ?? new Set<string>()) : this.#deps.cfg.telegram.allowUsers
  }

  #validAccessId(id: string, channel: Channel): boolean {
    return channel === "feishu" ? FEISHU_OPEN_ID_RE.test(id) : USER_ID_RE.test(id)
  }

  #selfAccessId(self: number | string | undefined, channel: Channel): string {
    if (typeof self === "string") return self
    if (self === undefined) return ""
    return channel === "feishu" ? (this.#deps.openIdForUser?.(self) ?? "") : String(self)
  }

  #channelFor(chatId: number): Channel {
    return channelOfChatId(chatId, this.#deps.channel)
  }

  async handleTimeZone(chatId: number, arg: string): Promise<void> {
    const zone = arg.trim()
    if (!zone) {
      const keyboard = new InlineKeyboard()
      for (let offset = 0; offset < TIMEZONE_PRESETS.length; offset += 3) {
        for (const preset of TIMEZONE_PRESETS.slice(offset, offset + 3)) {
          keyboard.text(preset === this.#deps.timezone() ? `✅ ${preset}` : preset, `tz:${preset}`)
        }
        keyboard.row()
      }
      await this.#deps.sendText(chatId, this.#deps.timezonePanel(), keyboard)
      return
    }

    const result = this.#deps.ops.envSet("REMINDER_TIMEZONE", zone)
    if (!result.ok) {
      await this.#deps.sendText(
        chatId,
        `❌ ${escapeMarkdown(result.message)}\n\n发送 \`/timezone\` 可查看全部常用时区。`,
      )
      return
    }
    this.#deps.applyLiveEnv("REMINDER_TIMEZONE", zone)
    await this.#deps.sendText(chatId, this.#deps.timezonePanel(`✅ 已切换时区：${zone}`))
  }

  /** `/dir` — the working directory CLI engines start in for this chat. */
}
