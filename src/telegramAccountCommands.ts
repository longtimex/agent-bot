import { escapeMarkdown } from "./messages.js"

const DEFAULT_CATEGORY_LABEL = "未分类"

export interface AccountCommandDeps {
  accounts: AccountStoreLike
  sendText: (chatId: number, text: string) => Promise<void>
}

interface AccountView {
  id: string
  name: string
  category: string
  username: string
  secret?: string
  url?: string
  notes?: string
}

/** The slice of AccountStore the commands need, so tests can pass a fake. */
interface AccountStoreLike {
  list(category?: string): AccountView[]
  categories(): Array<{ name: string; count: number }>
  find(ref: string): AccountView | undefined
  reveal(ref: string): { entry: { name: string; category: string }; password: string } | undefined
  remove(ref: string): { name: string } | undefined
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
    await this.#deps.sendText(
      chatId,
      `🔑 *${escapeMarkdown(revealed.entry.name)}*\n\n\`${revealed.password.replace(/`/g, "'")}\``,
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
