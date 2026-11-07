import { MAGPIE_UPDATE_TIMEOUT_MS } from "./magpie.js"

/**
 * A magpie run the caller must confirm before it happens. `args` is the exact argv,
 * `label` is what the chat shows in the confirmation.
 */
export interface MagpieActionPlan {
  label: string
  timeoutMs?: number
}

/**
 * magpie shapes that cannot do anything useful from a chat: they open a window/TUI,
 * run a foreground server, or wait for a keyboard. Shared by Telegram and the HTTP
 * API so the App is never told a command ran when the CLI was actually waiting.
 */
type BlockedReason = string | ((surface: string) => string)

const MAGPIE_BLOCKED: Array<[string, BlockedReason]> = [
  ["tui", (surface) => `\`tui\` 是全屏交互界面，无法在 ${surface} 中使用。`],
  ["web", "`web` 会打开常驻 Web 服务，请改用 `daemon web on` 或 `/magpie daemon`。"],
  ["serve", (surface) => `\`serve\` 是前台常驻网关进程，无法在 ${surface} 中运行；请用 \`daemon start\`。`],
  ["tray", (surface) => `\`tray\` 需要桌面托盘，无法在 ${surface} 中使用。`],
  ["app", (surface) => `\`app\` 会打开图形界面，无法在 ${surface} 中使用。`],
  ["gui", (surface) => `\`gui\` 会打开图形界面，无法在 ${surface} 中使用。`],
  ["panel", (surface) => `\`panel\` 需要菜单栏，无法在 ${surface} 中使用。`],
  ["statusline", "`statusline` 是给 Claude Code 状态栏调用的，不适合在 Telegram 或 App 中运行。"],
  ["mcp", (surface) => `\`mcp\` 是 stdio MCP 子进程，无法在 ${surface} 中运行。`],
  ["claude-mcp-helper", "`claude-mcp-helper` 是内部 MCP 辅助进程，无法在聊天中运行。"],
  ["autostart", (surface) => `\`autostart\` 需要桌面登录项，无法在 ${surface} 中配置。`],
  ["uninstall", "`uninstall` 会移除 magpie 并断开所有 agent，请在服务器终端执行。"],
  ["restore", "`restore` 需要服务器上的备份文件，请在终端执行。"],
  ["backup", "`backup` 会写本地文件并可能包含密钥，请在终端执行。"],
  ["webdav", "`webdav` 需要 WebDAV 凭据，请在终端配置。"],
  ["dav", "`webdav` 需要 WebDAV 凭据，请在终端配置。"],
  ["s3", "`s3` 需要对象存储凭据，请在终端配置。"],
  ["github", "`github` 需要仓库凭据，请在终端配置。"],
  ["search", "`search` 会接收并保存搜索 API 密钥，请在终端配置。"],
  ["gateway-key", "`gateway-key` 管理可访问网关的密钥，请在终端或 magpie Web 中操作。"],
  ["plugin", "`plugin` 的登录/安装在终端完成，无法在聊天中运行。"],
  ["plugins", "`plugins` 的登录/安装在终端完成，无法在聊天中运行。"],
  ["claude-code", "`claude-code` 安装的是交互式 CLI，请在终端执行。"],
  ["heap", "`heap` 生成性能分析文件，请在终端执行。"],
  ["cpu", "`cpu` 生成性能分析文件，请在终端执行。"],
  ["goroutines", "`goroutines` 生成性能分析文件，请在终端执行。"],
]

const MAGPIE_CONFIRM: Record<string, string> = {
  "provider rm": "删除 Provider",
  "provider delete": "删除 Provider",
  "group rm": "删除路由组",
  "group delete": "删除路由组",
  rm: "删除配置档案（profile）",
  use: "套用配置档案（会改写各 agent 的模型设置）",
  "daemon stop": "停止 magpie 守护进程（网关与故障转移同时停止）",
  "daemon restart": "重启 magpie 守护进程（网关短暂中断）",
  "daemon start": "启动 magpie 守护进程",
  "accounts switch": "把 agent 切换到另一个订阅账号",
  "accounts switch-only": "只切换 agent 自身登录，不改变网关路由",
}

/**
 * Why this argv must not run in a chat, or `undefined` when it is safe. An empty argv
 * is the panel itself, so it is allowed.
 */
export function magpieBlockedReason(args: string[], surface = "Telegram"): string | undefined {
  const group = (args[0] ?? "").toLowerCase()
  if (!group) return undefined
  for (const [name, reason] of MAGPIE_BLOCKED) {
    if (group !== name) continue
    return typeof reason === "function" ? reason(surface) : reason
  }
  // `accounts add|import` waits for a browser/keyboard; the listing and switching are not.
  if (group === "accounts" || group === "account") {
    const sub = (args[1] ?? "").toLowerCase()
    if (sub === "add" || sub === "import") {
      return `\`accounts ${sub}\` 需要交互登录或服务器文件，无法在 ${surface} 中完成。`
    }
  }
  return undefined
}

/** The confirmation copy for a destructive argv, or undefined when it runs as-is. */
export function magpieConfirmPlan(args: string[]): MagpieActionPlan | undefined {
  const group = (args[0] ?? "").toLowerCase()
  const sub = (args[1] ?? "").toLowerCase()
  const key = sub ? `${group} ${sub}` : group
  // Two-word keys (`provider rm`) win; a bare verb that takes an argument (`use work`,
  // `rm work`) falls back to its own entry, otherwise the argument would hide it.
  const label =
    (Object.hasOwn(MAGPIE_CONFIRM, key) ? MAGPIE_CONFIRM[key] : undefined) ??
    (sub && Object.hasOwn(MAGPIE_CONFIRM, group) ? MAGPIE_CONFIRM[group] : undefined)
  if (label) {
    return { label: `${label}（${key}）` }
  }
  if (group === "update" && sub !== "check" && !args.includes("--check")) {
    return { label: "升级 magpie 到最新版本", timeoutMs: MAGPIE_UPDATE_TIMEOUT_MS }
  }
  if (group === "settings" && (sub === "set" || sub === "reset")) {
    return { label: `修改 magpie 设置（${args.slice(1, 3).join(" ")}）` }
  }
  if (group === "model" && ["name", "efforts", "api"].includes(sub)) {
    return { label: `修改模型元数据（${sub}）` }
  }
  if (group === "visible" || group === "model") {
    return undefined
  }
  return undefined
}

/** Network-bound and provider-touching subcommands need more than the default timeout. */
export function isLongMagpieCommand(args: string[]): boolean {
  const [group = "", sub = ""] = args
  if (!group) return false
  if (["sync", "update"].includes(group)) return true
  if (["quota", "sessions", "accounts", "usage"].includes(group)) return true
  if (group === "provider" && ["test", "models", "add", "rm", "delete"].includes(sub)) return true
  if (group === "group" && sub === "add") return true
  if (group === "daemon" && sub === "start") return true
  if (group === "models") return true
  return false
}
