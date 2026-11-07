import type { InlineKeyboard } from "grammy"
import { escapeMarkdown, type Panel } from "./messages.js"
import { maskProxyUrl, type ProxyService } from "./proxy.js"

export interface ProxyCommandDeps {
  proxies: ProxyService
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  proxyPanel: (note?: string) => Panel
}

export class TelegramProxyCommands {
  readonly #deps: ProxyCommandDeps

  constructor(deps: ProxyCommandDeps) {
    this.#deps = deps
  }

  async handleProxyCommand(chatId: number, arg: string): Promise<void> {
    const [action = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    if (!action) {
      await this.#deps.sendPanel(chatId, this.#deps.proxyPanel())
      return
    }

    if (action === "add") {
      const url = rest[0]
      if (!url) {
        await this.#deps.sendText(
          chatId,
          "用法：`/proxy add http://127.0.0.1:7890 本地代理`\n支持 `http://`、`https://`、`socks4://`、`socks5://`，可带用户名密码。",
        )
        return
      }
      await this.#deps.sendText(chatId, "🧪 正在测试代理，请稍候…")
      try {
        const proxy = await this.#deps.proxies.add(url, rest.slice(1).join(" "))
        await this.#deps.sendText(
          chatId,
          `✅ 代理 #${proxy.id} 测试通过并已添加：${escapeMarkdown(proxy.name)}`,
        )
        await this.#deps.sendPanel(chatId, this.#deps.proxyPanel())
      } catch (err) {
        await this.#deps.sendText(chatId, `❌ 添加失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (action === "use" || action === "del" || action === "test") {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        await this.#deps.sendText(chatId, `用法：\`/proxy ${action} 编号\`（编号见 \`/proxy\` 列表）。`)
        return
      }
      if (action === "use") {
        try {
          const proxy = this.#deps.proxies.use(id)
          await this.#deps.sendText(chatId, `✅ 已启用代理 #${proxy.id}：${escapeMarkdown(maskProxyUrl(proxy.url))}`)
        } catch (err) {
          await this.#deps.sendText(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      if (action === "del") {
        const removed = this.#deps.proxies.remove(id)
        await this.#deps.sendText(chatId, removed ? `🗑 已删除代理 #${id}。` : `⚠️ 代理 #${id} 不存在。`)
        return
      }
      const result = await this.#deps.proxies.test(id)
      await this.#deps.sendText(
        chatId,
        result.ok
          ? `✅ 代理 #${id} 连接正常（${result.latencyMs ?? 0}ms）。`
          : `❌ 代理 #${id} 测试失败：${result.message}`,
      )
      return
    }

    if (action === "off") {
      this.#deps.proxies.disable()
      await this.#deps.sendText(chatId, "⏹ 已停用网络代理。")
      return
    }

    await this.#deps.sendText(
      chatId,
      "用法：\n• `/proxy` 打开管理面板\n• `/proxy add <地址> [名称]`\n• `/proxy use <编号>`\n• `/proxy test <编号>`\n• `/proxy del <编号>`\n• `/proxy off`",
    )
  }

}
