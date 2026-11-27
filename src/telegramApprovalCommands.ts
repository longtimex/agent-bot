import { InlineKeyboard } from "grammy"
import type { Context } from "grammy"
import { parseApprovalMode, type ApprovalDecision, type ApprovalManager, type PendingApprovalView } from "./approvals.js"
import { escapeMarkdown, type Panel } from "./messages.js"

export interface ApprovalCommandDeps {
  approvals: ApprovalManager
  ownerChatId?: () => number | undefined
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  editPanel: (ctx: Context, panel: Panel) => Promise<void>
}

const MODE_LABELS: Record<string, string> = {
  auto: "🛡 自动高危防护（默认）",
  strict: "🔒 严格审批模式",
  off: "⚪ 已关闭审批",
}

/** Handles `/approvals [auto|strict|off]`, approval cards, and `appr:*` button callbacks. */
export class TelegramApprovalCommands {
  readonly #deps: ApprovalCommandDeps

  constructor(deps: ApprovalCommandDeps) {
    this.#deps = deps
  }

  async handleCommand(chatId: number, command: string, arg: string): Promise<boolean> {
    if (command !== "/approvals") return false
    const requested = parseApprovalMode(arg)
    if (arg.trim() && !requested) {
      await this.#deps.sendText(chatId, "用法：`/approvals` 查看状态，或 `/approvals auto|strict|off` 切换防护级别。")
      return true
    }
    if (requested) {
      this.#deps.approvals.setMode(requested)
      await this.#deps.sendPanel(chatId, this.panel(`✅ 已切换为：${MODE_LABELS[requested]}`))
      return true
    }
    await this.#deps.sendPanel(chatId, this.panel())
    return true
  }

  panel(note?: string): Panel {
    const mode = this.#deps.approvals.mode
    const pending = this.#deps.approvals.listPending()
    const lines = [
      "🛡 *高危操作审批中心*",
      note ? `\n${escapeMarkdown(note)}` : "",
      `\n• 当前模式：${MODE_LABELS[mode] ?? mode}`,
      `• 待处理请求：${pending.length} 条`,
    ].filter(Boolean)

    const keyboard = new InlineKeyboard()
      .text(mode === "auto" ? "• 自动高危" : "自动高危", "appr:mode:auto")
      .text(mode === "strict" ? "• 严格模式" : "严格模式", "appr:mode:strict")
      .text(mode === "off" ? "• 关闭" : "关闭", "appr:mode:off")

    if (pending.length === 0) {
      lines.push("\n当前没有待审批的高危请求。")
    } else {
      lines.push("")
      for (const item of pending.slice(0, 5)) {
        lines.push(`• \`${item.id}\` *${escapeMarkdown(item.title)}*\n  ${escapeMarkdown(item.detail.slice(0, 140))}`)
        keyboard
          .row()
          .text(`✅ 允许 ${item.id.slice(0, 4)}`, `appr:once:${item.id}`)
          .text("🔓 本会话放行", `appr:always:${item.id}`)
          .text("❌ 拒绝", `appr:reject:${item.id}`)
      }
    }

    keyboard.row().text("🔄 刷新", "appr:refresh").text("⬅️ 主菜单", "show:menu")
    return { text: lines.join("\n"), keyboard }
  }

  /** Pushes an interactive approval card for one live high-risk request. */
  async sendRequestCard(chatId: number, item: PendingApprovalView): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("✅ 允许一次", `appr:once:${item.id}`)
      .text("🔓 本会话放行", `appr:always:${item.id}`)
      .row()
      .text("❌ 拒绝执行", `appr:reject:${item.id}`)
    const sourceTag = item.source === "opencode" ? "OpenCode 权限请求" : "高危指令防护"
    const text =
      `🚨 *需要人工审批*（${sourceTag}）\n\n` +
      `• 风险项：*${escapeMarkdown(item.title)}*\n` +
      `• 详情：\n${escapeMarkdown(item.detail)}\n\n` +
      `_请在 5 分钟内确认，超时将自动拒绝。也可在 App「高危审批」页处理。_`
    await this.#deps.sendText(chatId, text, keyboard)
  }

  async handleCallback(
    ctx: Context,
    data: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<boolean> {
    if (!data.startsWith("appr:")) return false

    if (data === "appr:refresh") {
      await answer("已刷新")
      await this.#deps.editPanel(ctx, this.panel())
      return true
    }

    if (data.startsWith("appr:mode:")) {
      const mode = parseApprovalMode(data.slice("appr:mode:".length))
      if (!mode) {
        await answer("未知模式")
        return true
      }
      this.#deps.approvals.setMode(mode)
      await answer(`已切换至 ${mode}`)
      await this.#deps.editPanel(ctx, this.panel(`已切换为：${MODE_LABELS[mode]}`))
      return true
    }

    const parts = data.split(":")
    const decision = parts[1] as ApprovalDecision | undefined
    const id = parts[2]
    if ((decision === "once" || decision === "always" || decision === "reject") && id) {
      const pending = this.#deps.approvals.listPending().find((item) => item.id === id)
      const chatId = ctx.chat?.id
      if (pending && chatId !== undefined) {
        const scoped = /^(?:tg|fs):(-?\d+)$/.exec(pending.key)
        if (scoped) {
          if (Number(scoped[1]) !== chatId) {
            await answer("该审批请求不属于当前会话")
            return true
          }
        } else {
          const owner = this.#deps.ownerChatId?.()
          if (owner !== undefined && chatId !== owner) {
            await answer("该审批请求仅限管理员会话处理")
            return true
          }
        }
      }
      const result = this.#deps.approvals.decide(id, decision)
      await answer(result.message)
      await this.#deps.editPanel(ctx, this.panel(result.message))
      return true
    }

    await answer("未知审批操作")
    return true
  }
}
