import { InlineKeyboard } from "grammy"
import type { BotConfig } from "./config.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import type { OpsService } from "./ops.js"
import { parseAllowUsers, sortUserIds, TIMEZONE_PRESETS, USER_ID_RE } from "./telegramSupport.js"

export interface AdminCommandDeps {
  cfg: BotConfig
  ops: OpsService
  ownerChatId?: number
  timezone: () => string
  applyLiveEnv: (key: string, value: string) => void
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  accessPanel: () => Panel
  timezonePanel: (headline?: string) => string
}

export class TelegramAdminCommands {
  readonly #deps: AdminCommandDeps

  constructor(deps: AdminCommandDeps) {
    this.#deps = deps
  }

  async handleAccessCommand(chatId: number, userId: number, arg: string): Promise<void> {
    const [rawAction = "list", ...rest] = arg.split(/\s+/).filter(Boolean)
    const action = rawAction.toLowerCase()

    if (action === "list" || action === "show") {
      await this.#deps.sendPanel(chatId, this.#deps.accessPanel())
      return
    }
    if (action !== "add" && action !== "del" && action !== "delete" && action !== "remove") {
      await this.#deps.sendText(
        chatId,
        "用法：`/access` 查看白名单；`/access add <用户 ID>` 添加；`/access del <用户 ID>` 移除。",
      )
      return
    }

    const wanted = rest.map((token) => token.replace(/^@/, ""))
    if (wanted.length === 0) {
      await this.#deps.sendText(chatId, "用法：`/access add <用户 ID>` 或 `/access del <用户 ID>`。")
      return
    }
    const invalid = wanted.filter((token) => !USER_ID_RE.test(token))
    if (invalid.length > 0) {
      await this.#deps.sendText(
        chatId,
        `❌ 用户 ID 只能是 20 位以内的数字（收到：${escapeMarkdown(invalid.join("、"))}）。`,
      )
      return
    }

    const result = this.mutateAccess(action === "add", wanted, userId)
    if (!result.ok) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(result.message)}`)
      return
    }
    await this.#deps.sendText(chatId, result.message)
    await this.#deps.sendPanel(chatId, this.#deps.accessPanel())
  }

  /** Shared by /access, its remove buttons and the HTTP API so the guards cannot drift. */
  mutateAccess(adding: boolean, wanted: string[], self: number | undefined): { ok: boolean; message: string } {
    const tokens = wanted.map((token) => token.replace(/^@/, ""))
    if (tokens.length === 0) return { ok: false, message: "请提供用户 ID。" }
    const invalid = tokens.filter((token) => !USER_ID_RE.test(token))
    if (invalid.length > 0) {
      return { ok: false, message: `用户 ID 只能是 20 位以内的数字（收到：${invalid.join("、")}）。` }
    }
    const current = new Set(this.#deps.cfg.telegram.allowUsers)
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
      const rejection = this.allowListRejection(next, String(self ?? ""))
      if (rejection) return { ok: false, message: rejection }
    }
    const value = sortUserIds(next).join(",")
    const result = this.#deps.ops.envSet("TELEGRAM_ALLOW_USERS", value, true)
    if (!result.ok) return { ok: false, message: result.message }
    this.#deps.applyLiveEnv("TELEGRAM_ALLOW_USERS", value)
    const names = touched.join("、")
    return {
      ok: true,
      message: `${adding ? `✅ 已加入白名单：${names}` : `🗑 已移出白名单：${names}`}（当前 ${next.size} 个用户，立即生效）。`,
    }
  }

  /** Snapshot for the app's /access panel. */
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
  allowListRejection(next: Set<string>, self: string): string | undefined {
    if (this.#deps.cfg.telegram.allowAll) return undefined
    if (!next.has(self) && this.#deps.cfg.telegram.allowUsers.has(self)) {
      return "不能把自己移出白名单，否则你将无法再控制 Bot。"
    }
    if (next.size === 0) return "白名单不能为空：至少保留 1 个用户 ID，或设置 TELEGRAM_ALLOW_ALL_USERS=1。"
    return undefined
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
