import { randomBytes } from "node:crypto"
import { InlineKeyboard } from "grammy"
import { escapeMarkdown, type Panel } from "./messages.js"
import { formatDiffForChat, workspaceChanges } from "./workspaceChanges.js"

export interface WorkspaceCommandDeps {
  workDir: (key: string) => string | undefined
  busy: (key: string) => boolean
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
}

interface PendingCommit {
  chatId: number
  key: string
  message: string
  expiresAt: number
}

const CONFIRM_TTL_MS = 5 * 60_000

/** Handles /diff, /undo, /commit and their inline buttons for both Telegram and Feishu. */
export class TelegramWorkspaceCommands {
  readonly #deps: WorkspaceCommandDeps
  readonly #pendingCommits = new Map<string, PendingCommit>()

  constructor(deps: WorkspaceCommandDeps) {
    this.#deps = deps
  }

  clearPending(): void {
    this.#pendingCommits.clear()
  }

  diffPanel(key: string): Panel {
    const view = workspaceChanges.diff(key, this.#deps.workDir(key))
    const keyboard = new InlineKeyboard().text("🔄 刷新 Diff", "ws:diff")
    if (view.undoable) keyboard.text("↩️ 撤销改动", "ws:undo")
    return { text: formatDiffForChat(view), keyboard }
  }

  /** Returns true when `command` was handled (/diff, /undo, /commit). */
  async handleCommand(chatId: number, key: string, command: string, arg: string): Promise<boolean> {
    if (command === "/diff") {
      await this.#deps.sendPanel(chatId, this.diffPanel(key))
      return true
    }
    if (command === "/undo") {
      await this.#deps.sendText(
        chatId,
        this.#deps.busy(key) ? "任务执行中，请先 /stop 再撤销。" : escapeMarkdown(workspaceChanges.undo(key).message),
      )
      return true
    }
    if (command === "/commit") {
      if (this.#deps.busy(key)) {
        await this.#deps.sendText(chatId, "任务执行中，请先 /stop 再提交。")
        return true
      }
      const message = arg.trim()
      if (!message) {
        await this.#deps.sendText(chatId, "用法：`/commit <提交说明>`\n先用 `/diff` 检查改动，再发送 `/commit 修复某某问题`（会弹出确认按钮）。")
        return true
      }
      const view = workspaceChanges.diff(key, this.#deps.workDir(key))
      if (view.count === 0) {
        await this.#deps.sendText(chatId, escapeMarkdown(view.message ?? "当前工作目录干净，没有可提交的改动。"))
        return true
      }
      this.#pruneExpired()
      const token = randomBytes(4).toString("hex")
      this.#pendingCommits.set(token, { chatId, key, message, expiresAt: Date.now() + CONFIRM_TTL_MS })
      const kb = new InlineKeyboard()
        .text("✅ 确认提交", `ws:commit:${token}`)
        .text("取消", `ws:cancel:${token}`)
      await this.#deps.sendText(
        chatId,
        `📦 *确认提交改动？*\n\n• 变动：${view.count} 个文件（+${view.added} −${view.removed}）\n• 提交说明：\`${escapeMarkdown(message)}\`\n\n_将执行 \`git add -A && git commit\`，5 分钟内有效。_`,
        kb,
      )
      return true
    }
    return false
  }

  /** Handles `ws:*` inline button callbacks; returns true when consumed. */
  async handleCallback(
    data: string,
    chatId: number,
    key: string,
    answer: (text?: string) => Promise<void>,
    refresh: (panel: Panel) => Promise<void>,
  ): Promise<boolean> {
    if (!data.startsWith("ws:")) return false
    const rest = data.slice("ws:".length)
    if (rest === "diff") {
      await answer("已刷新")
      await refresh(this.diffPanel(key))
      return true
    }
    if (rest === "undo") {
      if (this.#deps.busy(key)) {
        await answer("任务执行中，请先 /stop")
        return true
      }
      const res = workspaceChanges.undo(key)
      await answer(res.ok ? "已撤销" : "无法撤销")
      await this.#deps.sendText(chatId, escapeMarkdown(res.message))
      await refresh(this.diffPanel(key))
      return true
    }
    const cancel = /^cancel:([0-9a-f]+)$/.exec(rest)
    if (cancel) {
      const pending = this.#pendingCommits.get(cancel[1]!)
      if (pending && (pending.chatId !== chatId || pending.key !== key)) {
        await answer("该按钮不属于当前会话")
        return true
      }
      this.#pendingCommits.delete(cancel[1]!)
      await answer("已取消提交")
      await this.#deps.sendText(chatId, "已取消本次提交。")
      return true
    }
    const confirm = /^commit:([0-9a-f]+)$/.exec(rest)
    if (confirm) {
      this.#pruneExpired()
      const pending = this.#pendingCommits.get(confirm[1]!)
      if (!pending || pending.chatId !== chatId || pending.key !== key) {
        await answer("确认已过期，请重新发送 /commit")
        return true
      }
      this.#pendingCommits.delete(confirm[1]!)
      if (this.#deps.busy(key)) {
        await answer("任务执行中，请先 /stop")
        return true
      }
      const res = workspaceChanges.commit(key, pending.message, this.#deps.workDir(key))
      await answer(res.ok ? "已提交" : "提交失败")
      await this.#deps.sendText(chatId, escapeMarkdown(res.message))
      return true
    }
    return false
  }

  #pruneExpired(): void {
    const now = Date.now()
    for (const [token, entry] of this.#pendingCommits) {
      if (entry.expiresAt <= now) this.#pendingCommits.delete(token)
    }
  }
}
