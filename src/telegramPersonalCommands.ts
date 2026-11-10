import { InlineKeyboard } from "grammy"
import type { AgentCliService } from "./agentCli.js"
import type { AliasStore } from "./aliases.js"
import { clip, escapeMarkdown, type Panel } from "./messages.js"
import { describeRepeat, formatRemaining, formatReminderTime, MAX_PER_CHAT, type ReminderService } from "./reminders.js"
import { type ScheduleDefaults, type ScheduleService, scheduleTargetLabel } from "./scheduler.js"
import type { SessionStore } from "./store.js"

const SCHEDULE_USAGE = `🗓 *定时 AI 任务*

• \`/schedule\` - 打开任务面板
• \`/schedule add 30m 检查服务器\` - 到点自动执行
• \`/schedule add --engine claude --model sonnet 2h 汇总日志\` - 指定引擎与模型
• \`/schedule add every 2h 汇总日志\` / \`/schedule add 每天 09:00 生成日报\` - 重复执行（也支持 \`每2小时\`、\`下午6点\`）
• \`/schedule pause 编号\` / \`/schedule resume 编号\` / \`/schedule del 编号\` - 管理任务
• \`/schedule run 编号\` - 立即执行一次（不影响原定时间）

时间格式与 \`/remind\` 相同；提示词上限 2000 字，每个会话最多 20 个任务。`

export interface PersonalCommandDeps {
  reminders: ReminderService
  aliases: AliasStore
  schedules: ScheduleService
  store: SessionStore
  agents: AgentCliService
  timezone: () => string
  currentModel: (key: string) => { providerID: string; modelID: string; label: string } | undefined
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  aliasPanel: (chatId: number) => Panel
  schedulePanel: (chatId: number, page?: number) => Panel
  remindersPanel: (chatId: number, page?: number) => Panel
}

export class TelegramPersonalCommands {
  readonly #deps: PersonalCommandDeps

  constructor(deps: PersonalCommandDeps) {
    this.#deps = deps
  }

  async handleRemind(chatId: number, userId: number, arg: string): Promise<void> {
    if (!arg) {
      await this.#deps.sendText(
        chatId,
        "⏰ *设置提醒*\n\n用法：`/remind 30m 喝水`\n\n支持的时间格式：\n" +
        "• `30s` / `10m` / `2h` / `1d` / `1h30m`，也可写 `5分钟后` / `半小时后` / `1小时30分钟后`\n" +
        "• `18:30` / `8点半` / `下午3点`（当天或次日）\n" +
        "• `今天 18:30` / `明天 08:30` / `后天 09:00` / `今晚8点半`\n" +
        "• `every 30m` / `每30m` / `每5分钟`（重复提醒）\n" +
        "• `每天 08:30` / `每天8点半`（每天固定时间）\n\n" +
          `当前时区：\`${this.#deps.timezone()}\`（\`/timezone\` 可修改），最多同时保留 ${MAX_PER_CHAT} 条。`,
      )
      return
    }

    try {
      const reminder = this.#deps.reminders.add(chatId, userId, arg)
      const when = formatReminderTime(reminder.dueAt, this.#deps.timezone())
      const remaining = formatRemaining(reminder.dueAt - Date.now())
      const repeat = reminder.repeat ? `\n• 重复：${describeRepeat(reminder.repeat)}` : ""
      await this.#deps.sendText(
        chatId,
        `⏰ *提醒已设置* #${reminder.id}\n• 时间：${when}（${this.#deps.timezone()}，约 ${remaining}后）${repeat}\n• 内容：${escapeMarkdown(reminder.text)}\n\n发送 \`/cancel ${reminder.id}\` 可取消。`,
        new InlineKeyboard().text(`❌ 取消提醒 #${reminder.id}`, `rcancel:${reminder.id}`),
      )
    } catch (err) {
      await this.#deps.sendText(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async handleReminders(chatId: number): Promise<void> {
    await this.#deps.sendPanel(chatId, this.#deps.remindersPanel(chatId))
  }

  async handleCancelReminder(chatId: number, arg: string): Promise<void> {
    const id = Number(arg.trim())
    if (!arg || !Number.isInteger(id) || id <= 0) {
      await this.#deps.sendText(chatId, "用法：`/cancel 编号`（编号见 `/reminders` 列表）。")
      return
    }

    const removed = this.#deps.reminders.cancel(chatId, id)
    if (!removed) {
      await this.#deps.sendText(chatId, `⚠️ 未找到编号为 #${id} 的提醒，发送 \`/reminders\` 查看当前列表。`)
      return
    }
    // The reminder text is whatever the user typed, and the panel escapes it the same
    // way; a stray * or _ here would fail the Markdown parse instead of the reply
    await this.#deps.sendText(chatId, `✅ 已取消提醒 #${removed.id}：${escapeMarkdown(removed.text)}`)
  }

  async handleAliasCommand(chatId: number, arg: string): Promise<void> {
    const [action = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    const norm = action.toLowerCase()

    if (!norm || norm === "list" || norm === "面板") {
      await this.#deps.sendPanel(chatId, this.#deps.aliasPanel(chatId))
      return
    }

    if (norm === "add" || norm === "新增") {
      const [name = "", ...words] = rest
      if (!name || words.length === 0) {
        await this.#deps.sendText(
          chatId,
          "用法：`/alias add 名称 指令内容`\n例如：`/alias add code 审查当前目录的代码并给出改进清单`\n名称限小写字母/数字/下划线。",
        )
        return
      }
      try {
        const entry = this.#deps.aliases.add(chatId, name, words.join(" "))
        await this.#deps.sendText(
          chatId,
          `✅ 已保存快捷指令 \`/${entry.name}\`\n以后发送 \`/${entry.name}\` 即会执行：${escapeMarkdown(clip(entry.expansion, 300) ?? "")}`,
        )
      } catch (err) {
        await this.#deps.sendText(chatId, `⚠️ ${escapeMarkdown((err as Error).message)}`)
      }
      return
    }

    if (norm === "del" || norm === "rm" || norm === "delete" || norm === "删除") {
      const name = rest[0] ?? ""
      const removed = this.#deps.aliases.remove(chatId, name)
      if (!removed) {
        await this.#deps.sendText(chatId, `⚠️ 未找到快捷指令 \`/${escapeMarkdown(name)}\`，发送 \`/alias\` 查看当前列表。`)
        return
      }
      await this.#deps.sendText(chatId, `✅ 已删除快捷指令 \`/${removed.name}\``)
      return
    }

    await this.#deps.sendText(
      chatId,
      "用法：\n• `/alias` 查看快捷指令面板\n• `/alias add 名称 指令内容` 新增\n• `/alias del 名称` 删除",
    )
  }

  async handleScheduleCommand(chatId: number, userId: number, key: string, arg: string): Promise<void> {
    const [action = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    const norm = action.toLowerCase()

    if (!norm || norm === "list") {
      await this.#deps.sendPanel(chatId, this.#deps.schedulePanel(chatId))
      return
    }

    if (norm === "add") {
      const input = rest.join(" ")
      if (!input) {
        await this.#deps.sendText(chatId, SCHEDULE_USAGE)
        return
      }
      try {
        const engine = this.#deps.store.getEngine(key)
        const defaults: ScheduleDefaults =
          engine === "opencode"
            ? { engine, model: this.#deps.currentModel(key) }
            : { engine, cliModel: this.#deps.store.getCliModel(key, engine) }
        const task = this.#deps.schedules.add(chatId, userId, input, defaults)
        const when = formatReminderTime(task.dueAt, this.#deps.timezone())
        const remaining = formatRemaining(task.dueAt - Date.now())
        const repeat = task.repeat
          ? `\n• 重复：${describeRepeat(task.repeat)}`
          : "\n• 重复：不重复（执行后自动删除）"
        // Escaping Markdown can double the length; echoing a 2000-char prompt in full
        // would push this confirmation past Telegram's 4096-char limit
        const promptPreview = `${clip(task.prompt, 300) ?? ""}${task.prompt.length > 300 ? "…" : ""}`
        await this.#deps.sendText(
          chatId,
          `🗓 *定时任务已创建* #${task.id}\n• 时间：${when}（${this.#deps.timezone()}，约 ${remaining}后）${repeat}\n` +
            `• 引擎：${escapeMarkdown(scheduleTargetLabel(task, this.#deps.agents.registry))}\n• 提示词：${escapeMarkdown(promptPreview)}\n\n` +
            "到点后会自动调用 AI 执行，并把结果发送到这里。",
          new InlineKeyboard()
            .text(`⏸ 暂停 #${task.id}`, `sched:pause:${task.id}`)
            .text(`🗑 删除 #${task.id}`, `sched:del:${task.id}`),
        )
      } catch (err) {
        await this.#deps.sendText(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (norm === "run" || norm === "now") {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        await this.#deps.sendText(chatId, "用法：`/schedule run 编号`（编号见 `/schedule` 面板）。")
        return
      }
      try {
        const task = this.#deps.schedules.runNow(chatId, id)
        if (!task) {
          await this.#deps.sendText(chatId, `⚠️ 定时任务 #${id} 不存在。`)
          return
        }
        await this.#deps.sendText(
          chatId,
          `▶️ 已立即执行定时任务 #${id}，结果会发送到这里（不影响原定的下一次执行时间）。`,
        )
      } catch (err) {
        await this.#deps.sendText(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (norm === "pause" || norm === "resume" || norm === "del" || norm === "delete" || norm === "rm") {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) {
        await this.#deps.sendText(chatId, `用法：\`/schedule ${norm} 编号\`（编号见 \`/schedule\` 面板）。`)
        return
      }
      if (norm === "pause") {
        const task = this.#deps.schedules.pause(chatId, id)
        await this.#deps.sendText(chatId, task ? `⏸ 已暂停定时任务 #${id}。` : `⚠️ 定时任务 #${id} 不存在。`)
        return
      }
      if (norm === "resume") {
        const task = this.#deps.schedules.resume(chatId, id)
        await this.#deps.sendText(chatId, task ? `▶️ 已恢复定时任务 #${id}。` : `⚠️ 定时任务 #${id} 不存在。`)
        return
      }
      const removed = this.#deps.schedules.remove(chatId, id)
      await this.#deps.sendText(chatId, removed ? `🗑 已删除定时任务 #${id}。` : `⚠️ 定时任务 #${id} 不存在。`)
      return
    }

    await this.#deps.sendText(chatId, SCHEDULE_USAGE)
  }

}
