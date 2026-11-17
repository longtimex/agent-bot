import { escapeMarkdown } from "./messages.js"
import type { AccountUpdate } from "./accounts.js"

const DEFAULT_CATEGORY_LABEL = "未分类"

export interface AccountCommandDeps {
  accounts: AccountStoreLike
  sendText: (chatId: number, text: string) => Promise<void>
  /** Sends a message and removes it a minute later; falls back to sendText when absent. */
  sendSecret?: (chatId: number, text: string) => Promise<void>
}

interface AccountView {
  id: string
  name: string
  category: string
  username: string
  secret?: string
  url?: string
  notes?: string
  tags?: string[]
  extras?: Record<string, string>
}

/** The slice of AccountStore the commands need, so tests can pass a fake. */
interface AccountStoreLike {
  list(category?: string): AccountView[]
  categories(): Array<{ name: string; count: number }>
  find(ref: string): AccountView | undefined
  reveal(ref: string): { entry: { name: string; category: string }; password: string } | undefined
  remove(ref: string): { name: string } | undefined
  sharedPasswords(): Array<{ names: string[] }>
  update(ref: string, patch: AccountUpdate): { id: string; name: string; category: string; extras?: Record<string, string> }
  add(input: {
    name: string
    username: string
    password?: string
    category?: string
    url?: string
    notes?: string
  }): { id: string; name: string; category: string }
}

const USAGE = [
  "*账号库*",
  "",
  "• `/account` 查看分类概览",
  "• `/account add 名称 | 账号 | 密码 | 分类 | 网址 | 备注` 保存一条（后 4 项可省略，用 `|` 分隔）",
  "• `/account ls [分类]` 列出条目",
  "• `/account show 名称` 查看详情（密码打码）",
  "• `/account pass 名称` 显示明文密码",
  "• `/account edit 名称 | 账号 | 密码 | 分类 | 网址 | 备注 | 标签` 修改（留空段表示不改，写 `-` 表示清空）",
  "• `/account rename 旧名 新名` 改名称",
  "• `/account tag 名称 标签1,标签2` 覆盖标签",
  "• `/account field 名称 键=值 键=值` 增改自定义字段",
  "• `/account unfield 名称 键` 删除一个字段",
  "• `/account dup` 检查是否有多个账号共用同一密码",
  "• `/account rm 名称 yes` 删除一条",
  "",
  "密码用 AES-256-GCM 加密保存，密钥在 `data/accounts.key`，不会进入备份包。",
].join("\n")

export class TelegramAccountCommands {
  readonly #deps: AccountCommandDeps

  constructor(deps: AccountCommandDeps) {
    this.#deps = deps
  }

  async handle(chatId: number, arg: string): Promise<void> {
    const trimmed = arg.trim()
    if (!trimmed) return this.#overview(chatId)
    const [head = "", ...rest] = trimmed.split(/\s+/)
    const tail = rest.join(" ").trim()
    switch (head.toLowerCase()) {
      case "add":
        return this.#add(chatId, tail)
      case "ls":
      case "list":
        return this.#list(chatId, tail)
      case "show":
        return this.#show(chatId, tail)
      case "edit":
        return this.#edit(chatId, tail)
      case "rename":
        return this.#rename(chatId, tail)
      case "tag":
      case "tags":
        return this.#tag(chatId, tail)
      case "field":
        return this.#field(chatId, tail)
      case "unfield":
        return this.#unfield(chatId, tail)
      case "dup":
      case "duplicates":
        return this.#duplicates(chatId)
      case "pass":
      case "password":
        return this.#pass(chatId, tail)
      case "rm":
      case "remove":
      case "del":
      case "delete":
        return this.#remove(chatId, tail)
      default:
        return this.#deps.sendText(chatId, USAGE)
    }
  }

  async #overview(chatId: number): Promise<void> {
    const categories = this.#deps.accounts.categories()
    if (categories.length === 0) {
      await this.#deps.sendText(chatId, `📇 *账号库*\n\n还没有条目。\n\n${USAGE}`)
      return
    }
    const lines = categories.map(
      (item) => `• ${escapeMarkdown(item.name)}（${item.count}）`,
    )
    await this.#deps.sendText(
      chatId,
      `📇 *账号库* 共 ${categories.reduce((sum, item) => sum + item.count, 0)} 条\n\n` +
        `${lines.join("\n")}\n\n` +
        "用 `/account ls <分类>` 查看，`/account add` 新增。",
    )
  }

  async #add(chatId: number, tail: string): Promise<void> {
    if (!tail) {
      await this.#deps.sendText(chatId, USAGE)
      return
    }
    const parts = tail.split("|").map((part) => part.trim())
    const [name = "", username = "", password, category, url, notes] = parts
    if (!name) {
      await this.#deps.sendText(chatId, "❌ 请提供名称，例如：`/account add GitHub | me@example.com | 密码 | 开发`")
      return
    }
    try {
      const entry = this.#deps.accounts.add({
        name,
        username,
        password: password || undefined,
        category: category || undefined,
        url: url || undefined,
        notes: notes || undefined,
      })
      await this.#deps.sendText(
        chatId,
        `✅ 已保存 *${escapeMarkdown(entry.name)}*（分类：${escapeMarkdown(entry.category)}）` +
          `${password ? "\n密码已加密保存，用 `/account pass " + escapeMarkdown(entry.name) + "` 查看。" : ""}`,
      )
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  async #list(chatId: number, category: string): Promise<void> {
    const entries = this.#deps.accounts.list(category || undefined)
    if (entries.length === 0) {
      await this.#deps.sendText(
        chatId,
        category ? `分类「${escapeMarkdown(category)}」下没有条目。` : "账号库还是空的，用 `/account add` 新增。",
      )
      return
    }
    const lines = entries.map((entry) => {
      const user = entry.username ? ` · ${escapeMarkdown(entry.username)}` : ""
      return `• *${escapeMarkdown(entry.name)}*${user}（${escapeMarkdown(entry.category)}）`
    })
    await this.#deps.sendText(
      chatId,
      `${category ? `📂 ${escapeMarkdown(category)}` : "📇 全部账号"}（${entries.length}）\n\n${lines.join("\n")}`,
    )
  }

  async #show(chatId: number, name: string): Promise<void> {
    if (!name) {
      await this.#deps.sendText(chatId, "用法：`/account show <名称>`")
      return
    }
    const entry = this.#deps.accounts.find(name)
    if (!entry) {
      await this.#deps.sendText(chatId, `❌ 没有找到「${escapeMarkdown(name)}」。`)
      return
    }
    const lines = [
      `📇 *${escapeMarkdown(entry.name)}*`,
      "",
      `• 分类：${escapeMarkdown(entry.category || DEFAULT_CATEGORY_LABEL)}`,
      `• 账号：${entry.username ? escapeMarkdown(entry.username) : "（空）"}`,
      `• 密码：${entry.secret ? "********（用 /account pass 查看）" : "（未保存）"}`,
    ]
    if (entry.url) lines.push(`• 网址：${escapeMarkdown(entry.url)}`)
    if (entry.notes) lines.push(`• 备注：${escapeMarkdown(entry.notes)}`)
    await this.#deps.sendText(chatId, lines.join("\n"))
  }

  async #pass(chatId: number, name: string): Promise<void> {
    if (!name) {
      await this.#deps.sendText(chatId, "用法：`/account pass <名称>`")
      return
    }
    const revealed = this.#deps.accounts.reveal(name)
    if (!revealed) {
      await this.#deps.sendText(chatId, `❌ 没有找到「${escapeMarkdown(name)}」。`)
      return
    }
    if (!revealed.password) {
      await this.#deps.sendText(chatId, `ℹ️ ${escapeMarkdown(revealed.entry.name)} 没有保存密码。`)
      return
    }
    const body = `🔑 *${escapeMarkdown(revealed.entry.name)}*\n\n\`${revealed.password.replace(/`/g, "'")}\`\n\n_60 秒后自动删除这条消息_`
    if (this.#deps.sendSecret) await this.#deps.sendSecret(chatId, body)
    else await this.#deps.sendText(chatId, body)
  }


  /** Pipe-separated like `add`, but an empty segment keeps the current value and `-` clears it. */
  async #edit(chatId: number, tail: string): Promise<void> {
    if (!tail.includes("|")) {
      await this.#deps.sendText(
        chatId,
        "用法：`/account edit 名称 | 账号 | 密码 | 分类 | 网址 | 备注 | 标签`\n留空表示不修改，写 `-` 表示清空该字段。",
      )
      return
    }
    const parts = tail.split("|").map((part) => part.trim())
    const ref = parts[0] ?? ""
    if (!ref) {
      await this.#deps.sendText(chatId, "请在第一段写上要修改的账号名称。")
      return
    }
    const [, username, password, category, url, notes, tags] = parts
    const patch: AccountUpdate = {}
    const assign = (value: string | undefined, apply: (next: string | null) => void) => {
      if (value === undefined || value === "") return
      apply(value === "-" ? null : value)
    }
    assign(username, (value) => { patch.username = value ?? "" })
    assign(password, (value) => { patch.password = value })
    assign(category, (value) => { patch.category = value })
    assign(url, (value) => { patch.url = value })
    assign(notes, (value) => { patch.notes = value })
    assign(tags, (value) => { patch.tags = value === null ? [] : value.split(/[,，\s]+/).filter(Boolean) })

    if (Object.keys(patch).length === 0) {
      await this.#deps.sendText(chatId, "没有任何字段需要修改：请至少填写一段，或用 `-` 清空某段。")
      return
    }
    try {
      const entry = this.#deps.accounts.update(ref, patch)
      await this.#deps.sendText(chatId, `✅ 已更新 *${escapeMarkdown(entry.name)}*。`)
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  async #rename(chatId: number, tail: string): Promise<void> {
    const [from = "", to = ""] = tail.split(/\s+/)
    if (!from || !to) {
      await this.#deps.sendText(chatId, "用法：`/account rename 旧名 新名`")
      return
    }
    try {
      const entry = this.#deps.accounts.update(from, { name: to })
      await this.#deps.sendText(chatId, `✅ 已改名为 *${escapeMarkdown(entry.name)}*。`)
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  async #tag(chatId: number, tail: string): Promise<void> {
    const at = tail.search(/\s/)
    const ref = at < 0 ? tail : tail.slice(0, at)
    const raw = at < 0 ? "" : tail.slice(at + 1)
    if (!ref) {
      await this.#deps.sendText(chatId, "用法：`/account tag 名称 标签1,标签2`（留空则清除全部标签）")
      return
    }
    const tags = raw.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean)
    try {
      const entry = this.#deps.accounts.update(ref, { tags })
      await this.#deps.sendText(
        chatId,
        tags.length
          ? `✅ *${escapeMarkdown(entry.name)}* 的标签：${tags.map((tag) => `#${escapeMarkdown(tag)}`).join(" ")}`
          : `✅ 已清除 *${escapeMarkdown(entry.name)}* 的标签。`,
      )
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** `键=值` pairs, merged into the existing extras rather than replacing them. */
  async #field(chatId: number, tail: string): Promise<void> {
    const at = tail.search(/\s/)
    const ref = at < 0 ? tail : tail.slice(0, at)
    const raw = at < 0 ? "" : tail.slice(at + 1).trim()
    if (!ref || !raw) {
      await this.#deps.sendText(chatId, "用法：`/account field 名称 绑定邮箱=op@example.com 负责人=小王`")
      return
    }
    const entry = this.#deps.accounts.find(ref)
    if (!entry) {
      await this.#deps.sendText(chatId, `❌ 没有找到「${escapeMarkdown(ref)}」。`)
      return
    }
    const additions: Record<string, string> = {}
    for (const pair of raw.split(/\s+/)) {
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      additions[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
    if (Object.keys(additions).length === 0) {
      await this.#deps.sendText(chatId, "没有识别到 `键=值`，请用等号连接。")
      return
    }
    try {
      const merged = { ...entry.extras, ...additions }
      const updated = this.#deps.accounts.update(ref, { extras: merged })
      const fields = Object.entries(updated.extras ?? {}).map(([key, value]) => `• ${escapeMarkdown(key)}：${escapeMarkdown(value)}`)
      await this.#deps.sendText(
        chatId,
        `✅ *${escapeMarkdown(updated.name)}* 的自定义字段（${fields.length}）\n\n${fields.join("\n")}`,
      )
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  async #unfield(chatId: number, tail: string): Promise<void> {
    const [ref = "", key = ""] = tail.split(/\s+/)
    if (!ref || !key) {
      await this.#deps.sendText(chatId, "用法：`/account unfield 名称 字段名`")
      return
    }
    const entry = this.#deps.accounts.find(ref)
    if (!entry) {
      await this.#deps.sendText(chatId, `❌ 没有找到「${escapeMarkdown(ref)}」。`)
      return
    }
    const extras = { ...entry.extras }
    if (!(key in extras)) {
      await this.#deps.sendText(chatId, `ℹ️ *${escapeMarkdown(entry.name)}* 没有字段「${escapeMarkdown(key)}」。`)
      return
    }
    delete extras[key]
    try {
      this.#deps.accounts.update(ref, { extras })
      await this.#deps.sendText(chatId, `🗑 已删除字段「${escapeMarkdown(key)}」。`)
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** Warns about shared passwords without ever printing one. */
  async #duplicates(chatId: number): Promise<void> {
    const groups = this.#deps.accounts.sharedPasswords()
    if (groups.length === 0) {
      await this.#deps.sendText(chatId, "✅ 没有发现重复密码。")
      return
    }
    const lines = groups.map(
      (group, index) => `${index + 1}. ${group.names.map((name) => escapeMarkdown(name)).join(" / ")}`,
    )
    await this.#deps.sendText(
      chatId,
      `⚠️ *这些账号使用了同一密码*（共 ${groups.length} 组）\n\n${lines.join("\n")}\n\n` +
        "建议至少让重要平台各用一个密码。",
    )
  }

  async #remove(chatId: number, tail: string): Promise<void> {
    const parts = tail.split(/\s+/)
    const confirm = parts.length > 1 && ["yes", "confirm", "y"].includes(parts[parts.length - 1]!.toLowerCase())
    const name = (confirm ? parts.slice(0, -1).join(" ") : tail).trim()
    if (!name) {
      await this.#deps.sendText(chatId, "用法：`/account rm <名称> yes`")
      return
    }
    const entry = this.#deps.accounts.find(name)
    if (!entry) {
      await this.#deps.sendText(chatId, `❌ 没有找到「${escapeMarkdown(name)}」。`)
      return
    }
    if (!confirm) {
      await this.#deps.sendText(
        chatId,
        `⚠️ 确认删除 *${escapeMarkdown(entry.name)}*？此操作不可撤销。\n发送 \`/account rm ${escapeMarkdown(entry.name)} yes\` 确认。`,
      )
      return
    }
    this.#deps.accounts.remove(entry.id)
    await this.#deps.sendText(chatId, `🗑 已删除 *${escapeMarkdown(entry.name)}*。`)
  }
}
