import { InlineKeyboard } from "grammy"
import type { AgentCliService } from "./agentCli.js"
import type { BotConfig } from "./config.js"
import type { TaskHistoryStore } from "./history.js"
import { clip, escapeMarkdown, type Panel } from "./messages.js"
import type { ProxyService } from "./proxy.js"
import type { ReminderService } from "./reminders.js"
import type { ScheduleService } from "./scheduler.js"
import type { SessionStore } from "./store.js"
import { formatDateTime, formatDuration } from "./telegramSupport.js"
import type { UsageStore } from "./usage.js"

export interface StatsPanelDeps {
  cfg: BotConfig
  store: SessionStore
  agents: AgentCliService
  usage: UsageStore
  history: TaskHistoryStore
  reminders: ReminderService
  schedules: ScheduleService
  proxies: ProxyService
  timezone: () => string
  startedAt: () => number
  pendingCount: (key: string) => number
  currentModel: (key: string) => { providerID: string; modelID: string; label: string }
  cliModelLabel: (engine: string, model: string | undefined) => string
  encryptionEnabled: () => boolean
  runningSince: Map<string, number>
}

export class TelegramStatsPanels {
  readonly #deps: StatsPanelDeps

  constructor(deps: StatsPanelDeps) {
    this.#deps = deps
  }

  reportKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("📈 使用统计", "show:usage").row().text("⬅️ 主菜单", "show:menu")
  }

  usagePanel(key: string): Panel {
    const usage = this.#deps.usage.summary(key)
    const keyboard = new InlineKeyboard().text("🔄 刷新统计", "show:usage").text("📊 运行状态", "show:status")
    keyboard.row().text("📩 每日报告", "usage:report")
    keyboard.row().text("⬅️ 主菜单", "show:menu")

    if (usage.tasks === 0) {
      return {
        text: "📈 *使用统计*\n\n暂无任务记录。直接发送消息即可开始对话。",
        keyboard,
      }
    }

    const rate = Math.round((usage.ok / usage.tasks) * 100)
    const avg = Math.round(usage.totalMs / usage.tasks)
    const engine = usage.lastEngine ? this.#deps.agents.registry.label(usage.lastEngine) : undefined
    const last = usage.lastAt
      ? `\n• 最近任务：${formatDateTime(usage.lastAt, this.#deps.timezone())}` +
        `（${engine ?? "未知"}${usage.lastModel ? ` / ${escapeMarkdown(usage.lastModel)}` : ""}）`
      : ""
    const engineUsage =
      Object.entries(usage.engines)
        .filter(([, count]) => count > 0)
        .map(([id, count]) => `${this.#deps.agents.registry.label(id)} ${count}`)
        .join(" / ") || "无"
    const trend = this.#deps.usage.recentDays(key, 7)
    const week = trend.reduce(
      (acc, day) => ({
        tasks: acc.tasks + day.tasks,
        ok: acc.ok + day.ok,
        failed: acc.failed + day.failed,
        cancelled: acc.cancelled + day.cancelled,
      }),
      { tasks: 0, ok: 0, failed: 0, cancelled: 0 },
    )
    const blocks = "▁▂▃▄▅▆▇█"
    const peak = Math.max(1, ...trend.map((day) => day.tasks))
    const spark = trend
      .map((day) =>
        day.tasks === 0
          ? "·"
          : blocks[Math.min(blocks.length - 1, Math.max(0, Math.ceil((day.tasks / peak) * blocks.length) - 1))]!,
      )
      .join("")
    const range =
      trend.length > 1
        ? `${trend[0]!.day.slice(5)} → ${trend[trend.length - 1]!.day.slice(5)}`
        : trend[0]!.day.slice(5)
    // Cross-chat view: Telegram numbers gain meaning once the App (or another chat) also runs tasks
    const globalToday = this.#deps.usage.dayTotalsByChat(0)
    const otherSources = globalToday.filter((row) => row.key !== key)
    const globalLine =
      otherSources.length > 0
        ? `\n• 全局今日：${globalToday.reduce((sum, row) => sum + row.usage.tasks, 0)} 次（含 ${otherSources.length} 个其他来源，点「📩 每日报告」看明细）`
        : ""
    return {
      text:
        `📈 *使用统计*\n\n` +
        `• 总任务：${usage.tasks}（成功 ${usage.ok} / 失败 ${usage.failed} / 取消 ${usage.cancelled}）\n` +
        `• 成功率：${rate}%\n` +
        `• 平均耗时：${formatDuration(avg)}\n` +
        `• 今日任务：${usage.today.tasks}（成功 ${usage.today.ok} / 失败 ${usage.today.failed} / 取消 ${usage.today.cancelled}）${globalLine}\n` +
        `• 近 7 天：${week.tasks} 任务（成功 ${week.ok} / 失败 ${week.failed} / 取消 ${week.cancelled}）\n` +
        `  \`${spark}\` ${range}\n` +
        `• 引擎使用：${engineUsage}` +
        last,
      keyboard,
    }
  }

  historyPanel(key: string, count = 10): Panel {
    const total = this.#deps.history.count(key)
    const keyboard = new InlineKeyboard().text("🔄 刷新", "show:history").text("⬅️ 主菜单", "show:menu")
    if (total === 0) {
      return {
        text: "🕘 *任务历史*\n\n暂无任务记录。发送消息或触发定时任务后，这里会保留最近 50 条执行记录。",
        keyboard,
      }
    }
    keyboard.row().text("🧹 清空历史", "history:clear")
    // 渐进加载：「更早」每次多看 10 条，最多到存储上限 50（到顶就不再显示按钮）
    const wanted = Math.min(Math.max(10, count), 50)
    if (wanted < total && wanted < 50) keyboard.row().text("⬇️ 更早 10 条", `show:history:${wanted + 10}`)
    if (wanted > 10) keyboard.text("⬆️ 回到最新", "show:history:10")

    const lines: string[] = []
    let length = 0
    let shown = 0
    for (const entry of this.#deps.history.list(key, wanted)) {
      const status =
        entry.outcome === "ok" ? "✅ 成功" : entry.outcome === "cancelled" ? "🛑 已取消" : "❌ 失败"
      const engine = this.#deps.agents.registry.label(entry.engine)
      const target = entry.model ? `${engine} / ${entry.model}` : engine
      const tag = entry.scheduled ? " · 🗓 定时" : ""
      const prompt = entry.prompt ? `\n   _${escapeMarkdown(clip(entry.prompt, 100) ?? "")}_` : ""
      const line =
        `• ${formatDateTime(entry.at, this.#deps.timezone())} · ${status} · ${formatDuration(entry.ms)}\n` +
        `   ${escapeMarkdown(target)}${tag}${prompt}`
      if (length + line.length > 3200) break
      lines.push(line)
      length += line.length + 2
      shown += 1
    }
    const capped = shown < wanted ? `\n\n_消息过长，只渲染了前 ${shown} 条；可用 \`/export\` 导出完整历史。_` : ""

    return {
      text: `🕘 *任务历史*（已显示 ${shown} / 共 ${total} 条）\n\n${lines.join("\n\n")}${capped}`,
      keyboard,
    }
  }

  statusText(chatId: number, key: string): string {
    const engine = this.#deps.store.getEngine(key)
    const model =
      engine === "opencode"
        ? this.#deps.currentModel(key).label
        : this.#deps.cliModelLabel(engine, this.#deps.store.getCliModel(key, engine))
    // Tells the user whether the model came from this chat or from the config default
    const ownSelection = engine === "opencode" ? this.#deps.store.getModel(key) : this.#deps.store.getCliModel(key, engine)
    const since = this.#deps.runningSince.get(key)
    // #pending is what the queue panel shows, so status must not count cancelled-ahead slots
    const pending = this.#deps.pendingCount(key)
    const running = since ? `运行中（已 ${formatDuration(Date.now() - since)}）` : "空闲"
    const reminders = this.#deps.reminders.list(chatId).length
    const schedules = this.#deps.schedules.count(chatId)
    const today = this.#deps.usage.summary(key).today.tasks
    const proxy = this.#deps.proxies.active()
    const detected = this.#deps.agents.registry.list().filter((profile) => this.#deps.agents.registry.binPath(profile)).length

    return (
      `📊 *运行状态*\n• 引擎: *${this.#deps.agents.registry.label(engine)}*\n• 模型: *${model}*${ownSelection ? "" : "（默认）"}\n` +
      `• 当前任务: ${running}\n• 待处理队列: ${pending} 条\n• 今日任务: ${today} 条\n` +
      `• Agent CLI: ${detected} 个已安装\n` +
      `• 待触发提醒: ${reminders} 条\n• 定时任务: ${schedules} 个\n` +
      `• 网络代理: ${proxy ? `#${proxy.id} ${escapeMarkdown(proxy.name)}` : "未启用"}\n` +
      `• 消息级加密: ${this.#deps.encryptionEnabled() ? "已启用" : "未启用（API_ENCRYPTION=1）"}\n` +
      `• 语音转写: ${this.#deps.cfg.stt ? `已启用（${escapeMarkdown(this.#deps.cfg.stt.model)}，模型不支持音频时自动转写）` : "未配置（STT_BASE_URL）"}\n` +
      `• 每日报告: ${this.#deps.cfg.usageReport?.enabled ? `每天 ${this.#deps.cfg.usageReport.time} 推送` : "未开启（USAGE_DAILY_REPORT）"}\n` +
      `• Bot 运行时长: ${formatDuration(Date.now() - this.#deps.startedAt())}`
    )
  }

  statusKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🔄 刷新状态", "show:status")
      .text("📈 使用统计", "show:usage")
      .row()
      .text("🕘 任务历史", "show:history")
      .text("📋 查看队列", "show:queue")
      .text("🌐 网络代理", "show:proxy")
      .row()
      .text("🗓 定时任务", "show:schedule")
      .text("⏰ 我的提醒", "show:reminders")
      .row()
      .text("📦 Agent 管理", "show:agents")
      .text("🛠 运维中心", "show:ops")
      .row()
      .text("⬅️ 主菜单", "show:menu")
  }

}
