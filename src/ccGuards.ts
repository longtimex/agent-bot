import { CC_UPDATE_TIMEOUT_MS } from "./ccswitch.js"

/**
 * A cc-switch run that the caller must confirm before it happens: the argv, a
 * human-readable label for the confirmation, and how to execute it.
 */
export interface CcActionPlan {
  args: string[]
  label: string
  /** Import cc-switch's own argv form, without the `-a <app>` prefix the service adds. */
  bare?: boolean
  /** Run under a pseudo-terminal, which is how cc-switch wants its interactive deletes. */
  pty?: boolean
  /** Extra flags appended once the user confirms (a dry run's `--yes`, a quota burn's `--confirm`). */
  appendArgs?: string[]
  timeoutMs?: number
  kind?: "provider-use" | "model-delete"
  providerId?: string
  modelKey?: string
  modelForce?: boolean
}

/**
 * cc-switch shapes that cannot do anything useful in a chat: they open a TUI, an editor,
 * or a foreground server. Shared by Telegram and the HTTP API so the App is never told a
 * command ran when the CLI was actually waiting for a keyboard.
 */
const CC_BLOCKED = new Map<string, (surface: string) => string>([
  [
    "interactive",
    (surface) => `交互式 TUI 无法在 ${surface} 中使用；请改用可用的 cc-switch 子命令或查看 \`/cc help\`。`,
  ],
  ["completions", () => "shell 补全命令与聊天无关，已跳过。"],
  ["start", (surface) => `\`start\` 会启动交互式 CLI，无法在 ${surface} 中运行。`],
  [
    "proxy serve",
    (surface) => `\`proxy serve\` 是前台常驻进程，无法在 ${surface} 中运行；请用 \`proxy enable\`。`,
  ],
  ["auth login", (surface) => `OAuth 登录需要在终端完成设备授权，无法在 ${surface} 中运行。`],
  ["sessions resume", (surface) => `恢复会话会启动交互式 CLI，无法在 ${surface} 中运行。`],
  [
    "provider edit",
    () => "`provider edit` 依赖交互式 TUI；可先用 `provider add` 新建，或在服务器上编辑。",
  ],
  ["mcp edit", () => "`mcp edit` 依赖交互式 TUI；可删除后用 `/cc mcp add <JSON>` 重建。"],
  ["mcp add", () => "原生 `mcp add` 是交互式的；请用 `/cc mcp add <JSON>` 导入。"],
  ["prompts edit", () => "`prompts edit` 依赖外部编辑器；可用 `/cc prompts new` 新建预设。"],
  [
    "prompts create",
    () => "原生 `prompts create` 依赖外部编辑器；请用 `/cc prompts new <名称> <内容>`。",
  ],
  [
    "config restore",
    (surface) => `\`config restore\` 需要在备份列表中交互选择，无法在 ${surface} 中运行。`,
  ],
])

/**
 * cc-switch reads `-a`/`--app` on every subcommand, so a passthrough that let it through
 * would retarget another app's config. Both spellings of a compact value count: `-a codex`,
 * `-a=codex`, `-acodex`. `--apps` is a different flag and must stay usable.
 */
const CC_APP_FLAG = /^(?:-a(?:\S|=|$)|--app(?:=|$))/

/** The token that would retarget another app, or `undefined` when the argv is app-neutral. */
export function ccAppFlagToken(args: string[]): string | undefined {
  return args.find((token) => CC_APP_FLAG.test(token))
}

/** Why this argv must not run in a chat, or `undefined` when it is safe to hand to cc-switch. */
export function ccBlockedReason(args: string[], surface = "Telegram"): string | undefined {
  const [group = "", sub = ""] = args
  const key = `${group} ${sub}`.trim().toLowerCase()
  const reason = CC_BLOCKED.get(key)
  if (reason) return reason(surface)
  if (group === "daemon" && sub === "start" && !args.includes("--detach")) {
    return "前台 `daemon start` 会阻塞；请使用 `/cc daemon start --detach`。"
  }
  // The third word is the only one that says what a memory blob operation does, and
  // `open-dir` spawns the desktop file manager — nothing to show a phone or a chat
  if (group === "hermes" && sub === "memory" && args[2] === "open-dir") {
    return `\`hermes memory open-dir\` 会打开服务器上的文件管理器，无法在 ${surface} 中使用；读写请用 \`hermes memory show|set\`。`
  }
  return undefined
}

/**
 * Commands whose effect is destructive, global, or spends a limited credit: they run only
 * after the user confirms. `appendArgs` carries the flags cc-switch itself demands for the
 * real run, so a confirmation never turns a dry run into nothing.
 */
export function ccConfirmPlan(args: string[]): Omit<CcActionPlan, "args"> | undefined {
  const [group = "", sub = ""] = args
  // Hermes memory needs three words to say what it overwrites, so the two-word key below
  // cannot name it. `clear` also exits 0 printing a refusal unless cc-switch sees `--yes`,
  // which is why the plan carries the flag instead of letting a confirmed clear no-op.
  if (group === "hermes" && sub === "memory") {
    const file = args[3] === "user" ? "USER.md" : args[3] === "memory" ? "MEMORY.md" : "记忆文件"
    if (args[2] === "clear") {
      return { label: `清空 Hermes ${file}（写入空内容）`, appendArgs: ["--yes"] }
    }
    if (args[2] === "set") {
      return { label: `覆盖 Hermes ${file}` }
    }
    return undefined
  }
  const key = `${group} ${sub}`.trim().toLowerCase()
  switch (key) {
    case "provider use":
      return {
        label: `切换 Provider 到 \`${args[2] ?? "?"}\``,
        kind: "provider-use",
        providerId: args[2] ?? "",
      }
    // Canonical spelling of `use`; /cc provider switch and /cc run bypass the
    // /cc use shortcut, so the same confirmation has to cover it here
    case "provider switch":
      return {
        label: `切换 Provider 到 \`${args[2] ?? "?"}\`（修改 cc-switch 全局配置）`,
        kind: "provider-use",
        providerId: args[2] ?? "",
      }
    case "use":
      return {
        label: `切换 Provider 到 \`${args[1] ?? "?"}\``,
        kind: "provider-use",
        providerId: args[1] ?? "",
      }
    // The default decides which Provider every later new session starts on, which is a
    // global write of the same order as `use` even though nothing is switched right now
    case "provider set-default":
      return { label: `设置默认 Provider 为 \`${args[2] ?? "?"}\`（影响之后的新会话）` }
    case "provider delete":
      return { label: `删除 Provider \`${args[2] ?? "?"}\``, pty: true }
    // Removing an entry from the live config is the write that actually changes what the
    // next session talks to, and `import-live` overwrites whatever it matches; neither is
    // obvious from the command's name, so both ask
    case "provider remove-from-config":
      return { label: `从 live 配置移除 Provider \`${args[2] ?? "?"}\`（本体保留）`, pty: true }
    case "provider import-live":
      return { label: "从 live 配置导入 Provider（会覆盖同名条目）" }
    case "auth default":
      return { label: `设为默认 ChatGPT 账号 \`${args[2] ?? "?"}\`` }
    case "daemon stop":
      return { label: "停止 cc-switch 守护进程（代理转发与故障转移同时停止）" }
    case "mcp delete":
      return { label: `删除 MCP 服务器 \`${args[2] ?? "?"}\``, pty: true }
    case "prompts delete":
      return { label: `删除提示词预设 \`${args[2] ?? "?"}\``, pty: true }
    case "skills uninstall":
      return { label: `卸载技能 \`${args[2] ?? "?"}\``, pty: true }
    case "auth remove":
      return { label: `移除 ChatGPT 账号 \`${args[2] ?? "?"}\``, pty: true }
    case "auth logout":
      return { label: "登出并清除所有 ChatGPT OAuth 数据", pty: true }
    // Without --confirm cc-switch only runs a dry run; with it a banked reset
    // credit is burned, which deserves the same gate as `provider quota --reset`
    case "auth reset-quota":
      return args.includes("--confirm") ? { label: "消耗一次 Codex 配额重置额度" } : undefined
    case "config import":
      return { label: `导入配置 \`${args[2] ?? "?"}\`（会覆盖当前数据库）`, pty: true }
    case "config reset":
      return { label: "重置 cc-switch 配置为默认值", pty: true }
    case "sessions delete":
      return { label: `删除会话 \`${args[2] ?? "?"}\``, appendArgs: ["--yes"] }
    case "failover clear":
      return { label: "清空故障转移队列", appendArgs: ["--yes"] }
    case "failover enable":
      return { label: "启用自动故障转移（可能同时开启代理路由）", pty: true }
    case "provider quota":
      if (args.includes("--reset")) {
        return { label: "消耗一次配额重置额度", appendArgs: ["--confirm"] }
      }
      return undefined
    default:
      if (group === "update" && !args.includes("--check")) {
        return { label: "升级 cc-switch 二进制到最新版本", pty: true, timeoutMs: CC_UPDATE_TIMEOUT_MS }
      }
      return undefined
  }
}

/** Network-bound and provider-touching subcommands need more than cc-switch's default timeout. */
export function isLongCcCommand(args: string[]): boolean {
  const [group = "", sub = ""] = args
  if (group === "update" || group === "deeplink") return true
  if (group === "provider" && ["speedtest", "stream-check", "fetch-models", "quota"].includes(sub)) return true
  if (group === "sessions" && sub === "search") return true
  if (group === "config" && ["import", "export", "backup"].includes(sub)) return true
  if (group === "skills" && ["install", "market", "update", "check-updates", "discover", "sync"].includes(sub)) return true
  if (group === "daemon" && sub === "start") return true
  return false
}
