/** Help copy shared by Telegram and the HTTP API so both surfaces stay in sync. */
export const HELP = `🤖 *AI 私人助手 · 功能菜单*

*对话*
• 直接发送消息即可对话，支持图片、文件与语音
• \`/new\` 新会话 · \`/stop\` 停止 · \`/retry\` 重试 · \`/queue\` 队列

*引擎与模型*
• \`/agent\` 切换 Agent 引擎（推荐 OpenCode）
• \`/model\` 切换模型（\`/model default\` 清除本会话选择） · \`/agents\` 安装/卸载 CLI
• \`/dir\` 设置本会话 CLI 工作目录 · \`/status\` 运行状态
• \`/usage\` 使用统计 · \`/report\` 每日报告 · \`/history\` 任务历史 · \`/export\` 导出历史

*任务与提醒*
• \`/schedule\` 定时 AI 任务 · \`/reminders\` 待触发提醒
• \`/remind 30m 喝水\` 设定提醒

*效率*
• \`/alias\` 自定义快捷指令：\`/alias add code 审查当前目录代码\` 后发送 \`/code\` 触发

*集成*
• \`/cc\` cc-switch 控制台（Provider / MCP / 提示词等）
• \`/magpie\` magpie 模型网关控制台（Provider / 模型 / 路由组 / 配额），\`/magpie help\` 查看指令
• \`/proxy\` 网络代理
• \`/api\` 安卓 App 配对信息（API 地址与令牌）

*运维*
• \`/ops\` 运维中心 · \`/logs\` 日志 · \`/diag\` 诊断
• \`/update\` 更新项目 · \`/restart\` 重启 Bot
• \`/service\` OpenCode 服务 · \`/env\` 配置项 · \`/access\` 白名单 · \`/timezone\` 时区

_更多：\`/help full\` 查看完整说明 · \`/help cc\` 查看 cc-switch 指令_`

export const HELP_FULL = `🤖 *AI 私人助手*

*常用核心命令：*
• \`/agent\` - 查看并切换 Agent 引擎（OpenCode / Claude Code / Codex / Gemini / Qoder 等）
• \`/agent claude\` - 切换至 Claude Code 等本地 Agent CLI
• \`/agent opencode\` - 切换回 OpenCode 引擎（推荐）
• \`/agents\` - 检测本机 Agent CLI，安装/更新/卸载 Bot 托管的 CLI
• \`/agents install <id>\` - 通过 npm/pip 安装内置 Agent CLI
• \`/agents update <id>\` - 更新由 Bot 安装的 CLI（需确认）
• \`/agents uninstall <id>\` - 卸载由 Bot 安装的 CLI（需确认）
• \`/model\` - 查看或切换当前引擎的底层模型；\`/model default\` 取消本会话选择，之后由引擎自身配置决定
• \`/dir\` - 查看本会话 CLI 工作目录；\`/dir <路径>\` 切换（支持 \`~\` 与相对路径），\`/dir reset\` 恢复默认
• \`/new\` 或 \`/reset\` - 重置会话上下文
• \`/stop\` - 立即停止当前正在执行的任务
• \`/retry\` - 重新发送上一条任务
• \`/queue\` - 查看或清空排队中的消息
• \`/status\` - 查看引擎、模型、运行时长与排队数
• \`/usage\` - 查看任务量、成功率与耗时统计
• \`/report\` - 生成跨聊天的每日用量报告
• \`/history [条数]\` - 查看最近的任务执行历史（引擎、模型、耗时与结果）
• \`/export\` / \`/export json\` - 把任务历史导出为 Markdown / JSON 文件
• \`/schedule\` - 查看/管理定时 AI 任务
• \`/schedule add 每天 09:00 检查服务器\` - 到点自动执行 AI 任务
• \`/schedule add --engine claude --model sonnet 2h 汇总日志\` - 指定引擎与模型
• \`/remind 30m 喝水\` - 设定定时提醒（支持 30s/10m/2h/1d、18:30、明天 08:30）
• \`/remind every 30m 喝水\` - 重复提醒（也支持 \`每5分钟\`、\`每天 08:30\`、\`下午3点\`）
• \`/reminders\` - 查看待触发的提醒
• \`/cancel 编号\` - 取消指定提醒
• \`/alias\` - 自定义快捷指令面板；\`/alias add 名称 指令内容\` 创建后，发送 \`/名称\` 即触发（名称不能与内置命令重名）
• \`/timezone\` - 查看/切换时区（提醒、定时任务、每日统计立即生效）
• \`/timezone Asia/Shanghai\` - 直接指定 IANA 时区
• \`/proxy\` - 管理网络代理（HTTP/HTTPS/SOCKS），支持测试、启用与删除
• \`/cc\` - cc-switch 控制台：Provider/MCP/提示词/配置/代理/会话/认证等全部命令
• \`/cc help\` - 查看 cc-switch 全部指令（含通用 \`/cc run\` 入口）
• \`/cc model\` - 模型管理：为 Bot 或其他 agent 添加/删除模型、指定 agent 模型
• \`/magpie\` - magpie 模型网关控制台（Provider、各 Agent 模型、路由组、配额、用量、守护进程）
• \`/magpie help\` - 查看 magpie 全部指令（含 \`/magpie run\` 通用入口）
• \`/ops\` - 运维中心：诊断、日志、更新、重启、OpenCode 服务与配置
• \`/diag\` / \`/logs [行数]\` - 系统诊断 / 查看 Bot 日志
• \`/update\` - 拉取代码、安装依赖并构建（需确认）
• \`/restart\` - 重启 Bot（需确认，systemd 部署会拒绝）
• \`/service opencode start|stop|restart\` - 管理 OpenCode 服务
• \`/env\` / \`/env set KEY VALUE\` / \`/env unset KEY\` - 安全查看与修改非密钥配置
• \`/access\` / \`/access add <ID>\` / \`/access del <ID>\` - 管理当前渠道访问白名单，立即生效
• \`/api\` - 查看安卓 App 配对信息（HTTP API 地址、令牌与连接提示）
• \`/id\` - 查看你的会话与当前配置信息
• \`/help\` - 分类帮助；\`/help full\` 查看本文，\`/help cc\` 查看 cc-switch 指令

*功能支持：*
• 编程代码生成、分析与调试
• 发送图片、文件、语音（文本文件会直接读取内容）
• 图片、视频、语音与文件发送传输
• Markdown 代码块语法高亮排版

💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务能力最完整。
💡 发送 \`/menu\` 打开功能菜单；各面板底部可一键返回主菜单。`

export const CC_HELP = `🔌 *cc-switch 控制台*

*Provider*
• \`/cc provider list|current\`
• \`/cc use <id>\` · \`/cc test [id]\` · \`/cc stream <id>\`
• \`/cc models <id>\` · \`/cc quota <id> [--json]\`
• \`/cc provider add <名称> [id=] [template=] [base=] [key=] [model=] [fmt=] [config=]\`
• 原生 \`--name/--config\` 亦可；密钥会留在聊天里，建议改用 App 表单。OpenCode 等非 Claude/Codex/Gemini 应用必须用 \`config=\` 传 settings JSON
• \`/cc provider del <id>\`（需确认） · \`/cc provider dup <id>\`
• \`/cc provider set-default <id> [--model X]\`
• \`/cc provider remove-from-config <id>\` · \`/cc provider import-live\`
• \`/cc provider export <id> [-o 路径]\`

*MCP*
• \`/cc mcp [list|sync|import]\`
• \`/cc mcp add <JSON>\`（自动补 mcpServers 外层）
• \`/cc mcp del <id>\`（需确认）
• \`/cc mcp enable|disable <id> [--apps a,b]\`
• \`/cc mcp set-apps <id> --apps a,b\` · \`/cc mcp validate <命令>\`

*提示词*
• \`/cc prompts [list|current|live]\`
• \`/cc prompts show <id>\` · \`/cc prompts use <id>\` · \`/cc prompts off\`
• \`/cc prompts new <名称> <内容>\`
• \`/cc prompts rename <id> --name 新名 [--id 新ID]\`
• \`/cc prompts del <id>\`（需确认） · \`/cc prompts import\`

*配置 / 代理 / 环境*
• \`/cc config path|validate|show|backup\`
• \`/cc config export <文件>\` · \`/cc config import <文件>\`（需确认）
• \`/cc proxy show|enable|disable\`
• \`/cc proxy config --listen-address 127.0.0.1 --listen-port 8787\`
• \`/cc env list|check|tools\`

*会话 / 认证 / 守护进程*
• \`/cc sessions list|show <id>|messages <id>|search <关键词>\`
• \`/cc sessions delete <id>\`（需确认） · \`/cc sessions sync-usage\`
• \`/cc auth status|list|default <账号>\`
• \`/cc auth remove <账号>\` / \`/cc auth logout\`（需确认）
• \`/cc daemon status|logs|stop|start --detach\`

*技能 / 故障转移 / 设置*
• \`/cc skills list|info <名称>|install <名称>|update [名称]|sync\`
• \`/cc skills uninstall <名称>\`（需确认） · \`/cc skills repos add owner/name\`
• \`/cc failover show|list|available|add|remove|move|clear\`（clear 需确认）
• \`/cc settings show|language [en|zh]\`

*Hermes 记忆*
• \`/cc hermes memory limits\` · \`/cc hermes memory show [memory|user]\`
• \`/cc hermes memory set <memory|user> --content <内容>\`（覆盖整份文件，需确认）
• \`/cc hermes memory clear <memory|user>\`（需确认）
• \`/cc hermes memory enable|disable <memory|user>\`（停用后 Hermes 加载时跳过它）

*其他*
• \`/cc deeplink <ccswitch://网址>\`（导入会覆盖配置，需确认）
• \`/cc update --check\` · \`/cc update\`（升级二进制，需确认）
• \`/cc run <任意非交互参数>\`（通用入口）
• \`/cc model ...\`（模型与 Agent 管理）

⚠️ 只能由 TUI/编辑器/OAuth 完成的交互命令无法在聊天中执行：
\`provider edit\`、\`mcp edit\`、\`prompts edit\`、\`auth login\`、\`sessions resume\`、
\`config restore\`、\`start\`、\`proxy serve\`、前台 \`daemon start\`、\`completions\`、\`interactive\`、
\`hermes memory open-dir\`。
输出中的 API Key / Token 会自动打码。`

export const MAGPIE_HELP = `🧩 *magpie 模型网关*

把每个 Agent 的模型统一到一处：Claude Code 用 Kimi、Codex 用 DeepSeek、OpenCode 用任意 Provider。

*查看*
• \`/magpie\` · \`/magpie status\` - 面板（版本、网关、快捷入口）
• \`/magpie providers\` - 已添加的 Provider
• \`/magpie presets\` - 内置供应商模板
• \`/magpie agents\` - 全部支持的 Agent；\`/magpie status\` 列出本机已检测的
• \`/magpie models [agent]\` - 模型列表
• \`/magpie groups\` - 路由组
• \`/magpie quota [provider]\` · \`/magpie usage [today|7d|30d|all]\`
• \`/magpie settings\` · \`/magpie accounts\` · \`/magpie daemon status\`

*切换与新建*
• \`/magpie agent <agent> [provider/model]\` - 查看或设置某 Agent 的模型
• \`/magpie claude deepseek/deepseek-chat\` - 等价简写
• \`/magpie provider add <预设> <API Key>\` - 新建 Provider（密钥不回显）
• \`/magpie group add <名称> models=a/b,c/d [routing=smart]\`

*维护*
• \`/magpie sync\` - 刷新模型目录
• \`/magpie update check\` · \`/magpie update\`（升级需确认）
• \`/magpie daemon start|stop|restart\`（需确认）
• \`/magpie provider test|models|rm <id>\`（rm 需确认）
• \`/magpie run <任意非交互参数>\` - 通用入口

⚠️ 需要桌面/终端/交互登录的命令（\`tui\`、\`web\`、\`serve\`、\`plugin\`、\`accounts add\`、
\`gateway-key\`、\`backup\`、\`restore\` 等）无法在聊天中执行。输出中的 Key/Token 会自动打码。`

export interface HelpSection {
  id: "basic" | "full" | "cc"
  title: string
  text: string
}

/** Extra words the bot answers for a menu command, mapped to the command they run. */
export const BOT_COMMAND_ALIASES: Record<string, string> = {
  reset: "new",
  maintenance: "ops",
  svc: "service",
  tz: "timezone",
}

/**
 * Two-word `/cc` shorthands and the cc-switch argv they stand for, so the chat
 * accepts English synonyms (`provider rm`) the CLI itself does not. Telegram's `/cc`
 * routing and the HTTP API's word list for the App both read this one table.
 */
export const CC_SUB_ALIASES: Readonly<Record<string, readonly [string, string]>> = {
  "provider del": ["provider", "delete"],
  "provider rm": ["provider", "delete"],
  "mcp del": ["mcp", "delete"],
  "mcp rm": ["mcp", "delete"],
  "prompts use": ["prompts", "activate"],
  "prompts off": ["prompts", "deactivate"],
  "prompts stop": ["prompts", "deactivate"],
  "prompts del": ["prompts", "delete"],
  "prompts rm": ["prompts", "delete"],
  "skills del": ["skills", "uninstall"],
  "skills repo": ["skills", "repos"],
  "sessions del": ["sessions", "delete"],
  "auth del": ["auth", "remove"],
}

/** True when [word] — with or without its leading 「/」 — runs the [name] command or one of its aliases. */
export function isBotCommand(word: string | undefined, name: string): boolean {
  if (!word) return false
  const bare = word.startsWith("/") ? word.slice(1) : word
  return bare === name || BOT_COMMAND_ALIASES[bare] === name
}

/**
 * The command words the bot accepts, in Telegram's autocomplete-menu order.
 * Lives here rather than in telegram.ts so the HTTP API can hand the same list
 * to the Android app; the menu test keeps it aligned with the help text.
 */
export const BOT_MENU_COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "欢迎页与功能菜单入口" },
  { command: "menu", description: "打开功能菜单" },
  { command: "help", description: "分类帮助（/help full 查看全部）" },
  { command: "status", description: "查看运行状态" },
  { command: "new", description: "开启新会话（清空上下文）" },
  { command: "agent", description: "查看或切换 Agent 引擎（推荐 OpenCode）" },
  { command: "model", description: "查看或切换大模型" },
  { command: "dir", description: "查看或切换本会话 CLI 工作目录" },
  { command: "agents", description: "检测、安装或卸载 Agent CLI" },
  { command: "schedule", description: "定时执行 AI 任务（查看/添加/暂停）" },
  { command: "reminders", description: "查看待触发的提醒" },
  { command: "remind", description: "设定定时提醒，如 /remind 30m 喝水" },
  { command: "cancel", description: "取消指定编号的提醒" },
  { command: "queue", description: "查看或清空排队消息" },
  { command: "stop", description: "停止当前任务" },
  { command: "retry", description: "重新发送上一条任务" },
  { command: "usage", description: "查看任务量、成功率与耗时统计" },
  { command: "report", description: "生成跨聊天的每日用量报告" },
  { command: "history", description: "查看最近的任务执行历史" },
  { command: "export", description: "导出任务历史为 Markdown/JSON 文件" },
  { command: "proxy", description: "管理网络代理（添加/测试/启用/删除）" },
  { command: "cc", description: "cc-switch：Provider、MCP、提示词与环境诊断" },
  { command: "magpie", description: "magpie 模型网关：Provider、模型、路由组与配额" },
  { command: "ops", description: "运维中心：诊断、日志、更新与服务管理" },
  { command: "logs", description: "查看 Bot 或 OpenCode 日志" },
  { command: "diag", description: "查看系统诊断信息" },
  { command: "update", description: "更新项目代码并构建（需确认）" },
  { command: "restart", description: "重启 Bot（需确认）" },
  { command: "service", description: "管理 OpenCode 服务" },
  { command: "env", description: "查看或修改非密钥配置" },
  { command: "access", description: "管理当前渠道访问白名单（立即生效）" },
  { command: "api", description: "安卓 App 配对信息（HTTP API 地址与令牌）" },
  { command: "alias", description: "自定义快捷指令（/alias add 名称 指令内容）" },
  { command: "timezone", description: "查看或切换时区（立即生效）" },
  { command: "id", description: "查看会话与配置信息" },
]

/**
 * Words that a handler answers before user shortcuts are expanded. Saving one as an
 * alias would report success while making the shortcut impossible to trigger, so the
 * store refuses these names. `engine` is App-only, but aliases are shared with the App.
 */
const RESERVED_ALIAS_NAMES = new Set([
  ...BOT_MENU_COMMANDS.map((item) => item.command),
  ...Object.keys(BOT_COMMAND_ALIASES),
  "engine",
])

export function isReservedAliasName(name: string): boolean {
  const bare = name.trim().toLowerCase().replace(/^\/+/, "")
  return RESERVED_ALIAS_NAMES.has(bare)
}

/** Telegram's Markdown markers would render literally in the app, so strip them for plain display. */
export function plainHelp(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*/g, "")
    .replace(/(^|\s)_([^_]+)_/g, "$1$2")
}

export function helpSections(): HelpSection[] {
  return [
    { id: "basic", title: "功能菜单", text: plainHelp(HELP) },
    { id: "full", title: "完整说明", text: plainHelp(HELP_FULL) },
    { id: "cc", title: "cc-switch 指令", text: plainHelp(CC_HELP) },
  ]
}
