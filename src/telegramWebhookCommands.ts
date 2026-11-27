import { InlineKeyboard } from "grammy"
import type { Context } from "grammy"
import { escapeMarkdown, type Panel } from "./messages.js"
import type { WebhookConfig, WebhookStore } from "./webhooks.js"

export interface WebhookCommandDeps {
  webhooks: WebhookStore
  triggerBaseUrl: () => string | undefined
  runTest: (hook: WebhookConfig) => Promise<{ status: "ok" | "silent" | "failed"; text: string }>
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  editPanel: (ctx: Context, panel: Panel) => Promise<void>
}

/** Handles `/hooks` panel, `/hooks add <名称> | <模板>`, `/hooks del <id>`, and `hook:*` callbacks. */
export class TelegramWebhookCommands {
  readonly #deps: WebhookCommandDeps

  constructor(deps: WebhookCommandDeps) {
    this.#deps = deps
  }

  async handleCommand(chatId: number, command: string, arg: string): Promise<boolean> {
    if (command !== "/hooks") return false
    const trimmed = arg.trim()
    if (!trimmed) {
      await this.#deps.sendPanel(chatId, this.panel())
      return true
    }

    if (trimmed.toLowerCase().startsWith("add ")) {
      const rest = trimmed.slice(4).trim()
      const [rawName, ...tplParts] = rest.split("|")
      const name = rawName?.trim() ?? ""
      const promptTemplate = tplParts.join("|").trim()
      if (!name || !promptTemplate) {
        await this.#deps.sendText(
          chatId,
          "用法：`/hooks add <名称> | <提示词模板>`\n例如：`/hooks add CI告警 | 分析本次构建失败原因并给出修复建议：{{payload}}`",
        )
        return true
      }
      try {
        const hook = this.#deps.webhooks.create({ name, promptTemplate })
        const base = this.#deps.triggerBaseUrl()
        const url = base ? `${base}/api/v1/hooks/${hook.id}/trigger` : `/api/v1/hooks/${hook.id}/trigger`
        await this.#deps.sendText(
          chatId,
          `✅ 已创建 Webhook「*${escapeMarkdown(hook.name)}*」\n\n` +
            `• 触发地址：\`${url}\`\n` +
            `• 请求头鉴权：\`X-Webhook-Secret: ${hook.secret}\`\n` +
            `• 也支持 GitHub HMAC：\`X-Hub-Signature-256: sha256=...\`\n\n` +
            `_提示：请妥善保存该 Secret，也可在 App「Webhook 触发器」页查看与测试。_`,
        )
      } catch (err) {
        await this.#deps.sendText(chatId, `⚠️ ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
      }
      return true
    }

    if (trimmed.toLowerCase().startsWith("del ") || trimmed.toLowerCase().startsWith("rm ")) {
      const id = trimmed.split(/\s+/)[1] ?? ""
      const removed = this.#deps.webhooks.remove(id)
      await this.#deps.sendPanel(chatId, this.panel(removed ? `🗑 已删除「${removed.name}」` : `未找到编号 ${id}`))
      return true
    }

    await this.#deps.sendPanel(chatId, this.panel())
    return true
  }

  panel(note?: string): Panel {
    const hooks = this.#deps.webhooks.list()
    const base = this.#deps.triggerBaseUrl()
    const lines = ["🪝 *Webhook 事件触发器*"]
    if (note) lines.push(`\n${escapeMarkdown(note)}`)
    if (hooks.length === 0) {
      lines.push(
        "\n暂无 Webhook。外部系统（GitHub / Sentry / 监控告警）可通过 HTTP POST 触发 AI 自动分析并推送给你。",
        "\n快速创建：`/hooks add 告警名称 | 分析事件并总结原因：{{payload}}`",
      )
    } else {
      lines.push("")
      for (const hook of hooks.slice(0, 8)) {
        const state = hook.enabled ? "🟢 启用" : "⏸ 暂停"
        const url = base ? `${base}/api/v1/hooks/${hook.id}/trigger` : `/api/v1/hooks/${hook.id}/trigger`
        lines.push(
          `• \`${hook.id}\` *${escapeMarkdown(hook.name)}* · ${state} · 触发 ${hook.triggerCount} 次\n` +
            `  \`${url}\``,
        )
      }
    }

    const keyboard = new InlineKeyboard()
    for (const hook of hooks.slice(0, 5)) {
      keyboard
        .row()
        .text(`${hook.enabled ? "⏸" : "▶️"} ${hook.name.slice(0, 10)}`, `hook:toggle:${hook.id}`)
        .text("🧪 测试", `hook:test:${hook.id}`)
        .text("🗑", `hook:del:${hook.id}`)
    }
    keyboard.row().text("🔄 刷新", "hook:refresh").text("⬅️ 主菜单", "show:menu")
    return { text: lines.join("\n"), keyboard }
  }

  async handleCallback(
    ctx: Context,
    data: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<boolean> {
    if (!data.startsWith("hook:")) return false

    if (data === "hook:refresh") {
      await answer("已刷新")
      await this.#deps.editPanel(ctx, this.panel())
      return true
    }

    const [, action, id] = data.split(":")
    if (!id) {
      await answer("无效的 Webhook 编号")
      return true
    }

    if (action === "toggle") {
      const hook = this.#deps.webhooks.toggle(id)
      await answer(hook ? (hook.enabled ? "已启用" : "已暂停") : "未找到 Webhook")
      await this.#deps.editPanel(ctx, this.panel(hook ? `${hook.enabled ? "▶️ 已启用" : "⏸ 已暂停"}「${hook.name}」` : undefined))
      return true
    }

    if (action === "del") {
      const removed = this.#deps.webhooks.remove(id)
      await answer(removed ? `已删除 ${removed.name}` : "未找到 Webhook")
      await this.#deps.editPanel(ctx, this.panel(removed ? `🗑 已删除「${removed.name}」` : undefined))
      return true
    }

    if (action === "test") {
      const hook = this.#deps.webhooks.get(id)
      if (!hook) {
        await answer("未找到 Webhook")
        return true
      }
      await answer("已发起测试触发…")
      void this.#deps.runTest(hook).then(() => this.#deps.editPanel(ctx, this.panel(`🧪 已触发测试「${hook.name}」`))).catch(() => {})
      return true
    }

    await answer("未知 Webhook 操作")
    return true
  }
}
