import { InlineKeyboard } from "grammy"
import type { AgentCliService } from "./agentCli.js"
import type { AliasStore } from "./aliases.js"
import type { BotConfig } from "./config.js"
import { clip, escapeMarkdown, type Panel } from "./messages.js"
import { maskProxyUrl, type ProxyService } from "./proxy.js"
import { describeRepeat, formatRemaining, formatReminderTime, type ReminderService } from "./reminders.js"
import { scheduleTargetLabel, type ScheduleService } from "./scheduler.js"
import { formatDateTime, parseAllowUsers } from "./telegramSupport.js"

export interface QueuedJobView {
  id?: string
  text: string
}

export interface PersonalPanelDeps {
  cfg: BotConfig
  agents: AgentCliService
  proxies: ProxyService
  aliases: AliasStore
  schedules: ScheduleService
  reminders: ReminderService
  timezone: () => string
  pendingJobs: (key: string) => QueuedJobView[]
  isRunning: (key: string) => boolean
}

export class TelegramPersonalPanels {
  readonly #deps: PersonalPanelDeps

  constructor(deps: PersonalPanelDeps) {
    this.#deps = deps
  }

  proxyPanel(note?: string): Panel {
    const active = this.#deps.proxies.active()
    const items = this.#deps.proxies.list()
    const keyboard = new InlineKeyboard()

    if (items.length === 0) {
      const text =
        (note ? `${note}\n\n` : "") +
        "🌐 *网络代理*\n\n当前：未启用\n\n尚未添加代理。\n" +
        "发送 `/proxy add http://127.0.0.1:7890 本地代理` 添加，添加时会自动测试连通性。\n\n" +
        "支持 `http://`、`https://`、`socks4://`、`socks5://`。"
      return {
        text,
        keyboard: new InlineKeyboard().text("🔄 刷新", "show:proxy").text("⬅️ 主菜单", "show:menu"),
      }
    }

    // Telegram caps inline keyboards at 100 buttons; three rows per proxy would break
    // the whole panel once enough proxies pile up, so only the first few get buttons
    const panelProxies = items.slice(0, 12)
    const lines = panelProxies.map((proxy) => {
      const current = active?.id === proxy.id ? " ✅" : ""
      return `• #${proxy.id} *${escapeMarkdown(proxy.name)}*${current}\n  ${escapeMarkdown(maskProxyUrl(proxy.url))}`
    })
    const more =
      items.length > panelProxies.length
        ? `\n\n_…另有 ${items.length - panelProxies.length} 个未显示。可用 \`/proxy use <编号>\`、\`/proxy test <编号>\` 或 \`/proxy del <编号>\` 直接操作。_`
        : ""
    const status = active
      ? `#${active.id} ${escapeMarkdown(active.name)}`
      : "未启用"
    const text =
      (note ? `${note}\n\n` : "") +
      `🌐 *网络代理*\n\n当前：${status}\n\n${lines.join("\n")}${more}\n\n` +
      "启用后，远程媒体下载、Agent CLI 子进程以及 Agent 的网络命令会走该代理；Telegram 与本地 opencode 连接保持直连。"

    panelProxies.forEach((proxy, index) => {
      keyboard
        .text(`${active?.id === proxy.id ? "✅" : "▶️"} 使用 #${proxy.id}`, `proxy:use:${proxy.id}`)
        .text(`🧪 测试 #${proxy.id}`, `proxy:test:${proxy.id}`)
        .row()
        .text(`🗑 删除 #${proxy.id}`, `proxy:del:${proxy.id}`)
      if (index < panelProxies.length - 1) keyboard.row()
    })
    if (active) keyboard.row().text("⏹ 停用代理", "proxy:off")
    keyboard.row().text("🔄 刷新", "show:proxy").text("⬅️ 主菜单", "show:menu")
    return { text, keyboard }
  }

  queuePanel(key: string): Panel {
    const items = this.#deps.pendingJobs(key)
    const running = this.#deps.isRunning(key)
    if (items.length === 0 && !running) {
      return {
        text: "📭 *队列为空*\n\n直接发送消息即可开始新的任务。",
        keyboard: new InlineKeyboard().text("🔄 刷新", "show:queue").text("⬅️ 主菜单", "show:menu"),
      }
    }

    const lines = items.map((job, index) => {
      const preview = escapeMarkdown(clip(job.text.replace(/\s+/g, " ").trim(), 60) || "（无文字，仅附件）")
      return `${index + 1}. ${preview}`
    })
    const head = running ? "⏳ 当前任务执行中。" : "✅ 当前没有运行中的任务。"
    const body = lines.length > 0 ? `\n\n*排队中（${items.length}）*\n${lines.join("\n")}` : ""
    const keyboard = new InlineKeyboard()
    items.forEach((job, index) => {
      if (!job.id) return
      keyboard.text(`❌ 取消第 ${index + 1} 条`, `qdrop:${job.id}`).row()
    })
    if (items.length > 0) {
      keyboard.text(`🧹 清空排队（${items.length}）`, "qclear")
      keyboard.row()
    }
    keyboard.text("🔄 刷新队列", "show:queue").text("⬅️ 主菜单", "show:menu")
    return { text: `📋 *任务队列*\n${head}${body}`, keyboard }
  }

  aliasPanel(chatId: number): Panel {
    const aliases = this.#deps.aliases.list(chatId)
    const keyboard = new InlineKeyboard().text("➕ 用法见 /alias add", "noop:alias").row().text("⬅️ 主菜单", "show:menu")
    if (aliases.length === 0) {
      return {
        text:
          "⚡ *快捷指令*\n\n还没有自定义指令。用 `/alias add 名称 指令内容` 创建，例如：\n`/alias add code 审查当前目录的代码`\n之后发送 `/code` 即可触发。",
        keyboard,
      }
    }
    const lines = aliases.map((entry) => `• \`/${entry.name}\` → ${escapeMarkdown(clip(entry.expansion, 120) ?? "")}`)
    for (const entry of aliases) {
      keyboard.text(`🗑 /${entry.name}`, `aliasdel:${entry.name}`)
    }
    keyboard.row().text("⬅️ 主菜单", "show:menu")
    return { text: `⚡ *快捷指令*（${aliases.length}）\n\n${lines.join("\n")}\n\n点按钮删除，或发送 /alias add 新增。`, keyboard }
  }

  schedulePanel(chatId: number, page = 1): Panel {
    const all = this.#deps.schedules.list(chatId)
    const keyboard = new InlineKeyboard()
    if (all.length === 0) {
      return {
        text:
          "🗓 *定时任务*\n\n暂无定时任务。\n\n" +
          "发送 `/schedule add 30m 检查服务器` 创建；支持 `every 2h`、`每天 09:00`、`每2小时`、`下午6点`，" +
          "可加 `--engine claude --model sonnet` 指定执行引擎。",
        keyboard: keyboard.text("🔄 刷新", "show:schedule").text("⬅️ 主菜单", "show:menu"),
      }
    }

    // 与 /reminders 面板同款分页：一页 4 个任务（每个占一整行按钮）
    const PAGE_SIZE = 4
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
    const current = Math.min(Math.max(1, page), pages)
    const items = all.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

    const now = Date.now()
    const lines: string[] = []
    for (const item of items) {
      const state = item.paused ? "⏸" : "✅"
      const when = formatReminderTime(item.dueAt, this.#deps.timezone())
      const whenText = item.paused ? when : `${when}（约 ${formatRemaining(item.dueAt - now)}后）`
      const repeat = item.repeat ? ` 🔁 ${describeRepeat(item.repeat)}` : ""
      const last = item.lastStatus
        ? `\n  上次：${
            item.lastStatus === "ok"
              ? "成功"
              : item.lastStatus === "cancelled"
                ? "已取消"
                : item.attempts
                  ? `失败（第 ${item.attempts} 次重试中）`
                  : "失败"
          }`
        : ""
      const promptText = `${clip(item.prompt, 200) ?? ""}${item.prompt.length > 200 ? "…" : ""}`
      lines.push(`${state} #${item.id} ${whenText}${repeat}\n  ${scheduleTargetLabel(item, this.#deps.agents.registry)}\n  ${escapeMarkdown(promptText)}${last}`)
    }

    items.forEach((item) => {
      keyboard
        .text(`▶️ 运行 #${item.id}`, `sched:run:${item.id}`)
        .text(
          item.paused ? `▶️ 恢复 #${item.id}` : `⏸ 暂停 #${item.id}`,
          item.paused ? `sched:resume:${item.id}` : `sched:pause:${item.id}`,
        )
        .text(`🗑 删除 #${item.id}`, `sched:del:${item.id}`)
      keyboard.row()
    })
    if (current > 1) keyboard.text("⬅️ 上一页", `show:schedule:${current - 1}`)
    if (pages > 1) keyboard.text(`📄 ${current}/${pages}`, "noop:page")
    if (current < pages) keyboard.text("➡️ 下一页", `show:schedule:${current + 1}`)
    if (pages > 1) keyboard.row()
    keyboard.text("🔄 刷新", "show:schedule").text("⬅️ 主菜单", "show:menu")

    const heading = pages > 1 ? `🗓 *定时任务（${all.length}）· 第 ${current}/${pages} 页*` : `🗓 *定时任务（${all.length}）*`
    return {
      text:
        `${heading}\n\n${lines.join("\n\n")}\n\n` +
        "到点后自动执行并把结果发到这里。发送 `/schedule add ...` 新建；「▶️ 运行」立即执行一次，不影响原定时间。",
      keyboard,
    }
  }

  accessPanel(headline?: string): Panel {
    const ids = parseAllowUsers([...this.#deps.cfg.telegram.allowUsers].join(","))
    const keyboard = new InlineKeyboard()
    for (const id of ids.slice(0, 12)) {
      keyboard.text(`❌ ${id}`, `access:del:${id}`).row()
    }
    keyboard.text("🔄 刷新", "show:access").row()
    keyboard.text("🛠 运维中心", "show:ops").text("⬅️ 主菜单", "show:menu")

    const listCap = 60
    const list = ids.length > 0 ? ids.slice(0, listCap).map((id) => `• \`${escapeMarkdown(id)}\``).join("\n") : "_（空白名单）_"
    const listMore = ids.length > listCap ? `\n_…另有 ${ids.length - listCap} 个未显示。_` : ""
    const overflow = ids.length > 12 ? `\n_…另有 ${ids.length - 12} 个未显示按钮，可用 \`/access del <ID>\` 移除。_` : ""
    const gate = this.#deps.cfg.telegram.allowAll
      ? "⚠️ `TELEGRAM_ALLOW_ALL_USERS` 已开启：任何 Telegram 用户都能驱动 Bot 与运维操作，建议尽快关闭。"
      : "✅ 仅白名单用户可用，且只响应私聊。"

    return {
      text:
        `${headline ? `${headline}\n\n` : ""}🔐 *访问白名单*（${ids.length}）\n\n${list}${listMore}${overflow}\n\n${gate}\n\n` +
        "添加：`/access add <用户 ID>`\n移除：`/access del <用户 ID>` 或点击上方按钮\n\n" +
        "_让对方发送 `/start` 给 Bot：被拒回复里会显示他的数字 ID。改动写入 `.env` 并立即生效，无需重启。_",
      keyboard,
    }
  }

  timezonePanel(headline?: string): string {
    const now = Date.now()
    return [
      headline,
      `🕐 当前时区：\`${escapeMarkdown(this.#deps.timezone())}\``,
      `• 本地时间：${formatDateTime(now, this.#deps.timezone())}`,
      `• 世界标准时间：${formatDateTime(now, "UTC")}`,
      "",
      "提醒、定时任务和每日统计都按这个时区计算。切换后立即生效，无需重启，并会写入 `.env`。",
      "点击下方按钮，或发送 `/timezone America/New_York`（IANA 时区名）。",
    ]
      .filter(Boolean)
      .join("\n")
  }

  remindersPanel(chatId: number, page = 1): Panel {
    const all = this.#deps.reminders.list(chatId)
    if (all.length === 0) {
      return {
        text: "📭 *暂无待触发的提醒*\n\n发送 `/remind 30m 喝水` 即可创建。",
        keyboard: new InlineKeyboard().text("🔄 刷新", "show:reminders").text("⬅️ 主菜单", "show:menu"),
      }
    }

    // 一页 8 条（2 列 × 4 行按钮刚好放下）；超出部分用翻页按钮浏览
    const PAGE_SIZE = 8
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
    const current = Math.min(Math.max(1, page), pages)
    const items = all.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

    const now = Date.now()
    const lines: string[] = []
    for (const item of items) {
      const when = formatReminderTime(item.dueAt, this.#deps.timezone())
      const remaining = formatRemaining(item.dueAt - now)
      const repeat = item.repeat ? ` 🔁 ${describeRepeat(item.repeat)}` : ""
      lines.push(`• #${item.id} ${when}（${remaining}后）${repeat}\n  ${escapeMarkdown(item.text)}`)
    }

    const keyboard = new InlineKeyboard()
    items.forEach((item, index) => {
      // Only one-shots can be postponed; repeating reminders keep their schedule
      if (!item.repeat) keyboard.text(`⏰+1h #${item.id}`, `rpostpone:${item.id}`)
      keyboard.text(`❌ 取消 #${item.id}`, `rcancel:${item.id}`)
      if (index % 2 === 1 && index < items.length - 1) keyboard.row()
    })
    keyboard.row()
    if (current > 1) keyboard.text("⬅️ 上一页", `show:reminders:${current - 1}`)
    if (pages > 1) keyboard.text(`📄 ${current}/${pages}`, "noop:page")
    if (current < pages) keyboard.text("➡️ 下一页", `show:reminders:${current + 1}`)
    if (current > 1 || current < pages) keyboard.row()
    keyboard.text("🔄 刷新", "show:reminders").text("⬅️ 主菜单", "show:menu")

    const heading = pages > 1 ? `⏰ *待触发的提醒（${all.length}）· 第 ${current}/${pages} 页*` : `⏰ *待触发的提醒（${items.length}）*`
    return {
      text: `${heading}\n\n${lines.join("\n\n")}\n\n一次性提醒可「⏰+1h」一键延后；点击按钮取消，或发送 \`/cancel 编号\`。`,
      keyboard,
    }
  }

}
