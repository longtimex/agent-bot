import { CC_SWITCH_APPS, CC_UPDATE_TIMEOUT_MS } from "./ccswitch.js"
import { CC_SUB_ALIASES } from "./help.js"
import { ApiError } from "./apiCore.js"

export function assertSafeQuery(raw: string, label: string): string {
  const value = raw.trim()
  if (!value) throw new ApiError(400, `${label} 不能为空`)
  if (value.length > 128) throw new ApiError(400, `${label} 过长（上限 128 字）`)
  if (value.startsWith("-")) throw new ApiError(400, `${label} 不能以 - 开头`)
  // One argv token with no control characters reaching the terminal output. \w is ASCII-only,
  // and a Latin-only set would reject the Chinese keywords both clients search session titles with.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new ApiError(400, `${label} 含有不支持的字符`)
  return value
}

/**
 * The word runs a typed `/cc …` can use for one argv shape: the group and subcommand
 * it really runs — a third literal word included, for shapes like `skills repos add` —
 * plus every Telegram alias that resolves to them (`provider rm` for `provider delete`).
 * Derived from the tables below, so the App answers a typed command without hardcoding
 * a single cc-switch word.
 */
export function ccPhrases(argv: string[]): string[] {
  const words = argv.filter((part) => part.length > 0 && !part.startsWith("-")).slice(0, 3)
  const [group, sub, third] = words
  if (!group || !sub) return []
  const pair = `${group} ${sub}`
  const phrases = third ? [`${pair} ${third}`, pair] : [pair]
  for (const [alias, target] of Object.entries(CC_SUB_ALIASES)) {
    if (target[0] === group && target[1] === sub) phrases.push(alias)
  }
  return phrases
}

/**
 * The raw argv of Telegram's `/cc run`, checked before it reaches cc-switch. The App types
 * the same words, so the bounds are the ones a shell would give them: plain printable
 * tokens, a limited count and length, nothing that could smuggle a control character into
 * the argv array.
 */
export function parseCcRunArgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError(400, "缺少 args 字段（字符串数组）")
  if (raw.length === 0) throw new ApiError(400, "args 不能为空")
  if (raw.length > 16) throw new ApiError(400, "args 最多 16 段")
  const args = raw.map((token) => {
    if (typeof token !== "string") throw new ApiError(400, "args 只能包含字符串")
    const value = token.trim()
    if (!value) throw new ApiError(400, "args 中有空参数")
    if (value.length > 240) throw new ApiError(400, "args 单段最长 240 字")
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, "args 含不可见字符")
    return value
  })
  if (args.join(" ").length > 2000) throw new ApiError(400, "args 总长超过 2000 字")
  return args
}

/**
 * One blob's line out of cc-switch's `limits` summary, which reads
 * `  memory:  2200 chars  (enabled: true)`. `undefined` whenever the wording changes:
 * Hermes, not this bot, is what truncates or skips a memory file, so the App only uses
 * this to label its controls and to warn about an over-budget write.
 */
export function hermesLimit(
  limits: string,
  kind: "memory" | "user",
): { chars: number; enabled: boolean } | undefined {
  const match = new RegExp(`^\\s*${kind}:\\s*(\\d+) chars\\s+\\(enabled: (true|false)\\)`, "m").exec(limits)
  const chars = Number(match?.[1])
  if (!match || !Number.isInteger(chars) || chars <= 0) return undefined
  return { chars, enabled: match[2] === "true" }
}

/**
 * Validates the second half of a two-value `arg`. Each shape is checked against what
 * cc-switch itself accepts, so a typo fails here instead of silently rewriting a config.
 */
export function validateCcExtra(kind: NonNullable<CcExecSpec["extra"]>, raw: string, label: string): string {
  const value = raw.trim()
  if (!value) throw new ApiError(400, `${label} 不能为空`)
  if (kind === "port") {
    if (!/^\d{1,5}$/.test(value)) throw new ApiError(400, `${label} 需是数字`)
    // Five digits is not the same as a usable port: cc-switch would take 99999 as its
    // listen port and the failure would surface as a broken proxy, not as a bad request
    if (Number(value) < 1 || Number(value) > 65_535) throw new ApiError(400, `${label} 需在 1-65535 之间`)
    return value
  }
  if (kind === "direction") {
    if (value !== "up" && value !== "down") throw new ApiError(400, `${label} 只能是 up 或 down`)
    return value
  }
  if (kind === "host") {
    // An address is one argv word: no spaces, no flag lead
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) throw new ApiError(400, `${label} 含有不支持的字符`)
    return value
  }
  if (kind === "apps") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    const unknown = items.filter((item) => !(CC_SWITCH_APPS as readonly string[]).includes(item))
    if (!items.length || unknown.length) {
      throw new ApiError(400, `${label} 需是逗号分隔的应用列表，可用：${CC_SWITCH_APPS.join("、")}`)
    }
    return items.join(",")
  }
  // A prompt name is free text but still one argv word, so only a flag lead is dangerous
  if (value.startsWith("-") || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, `${label} 需是 1-80 字、不以 - 开头且不含控制字符`)
  }
  return value
}

interface CcViewSpec {
  label: string
  /** Build the fixed argv; `target` is already validated with assertSafeId. */
  args: (target: string) => string[]
  needsTarget?: boolean
  targetLabel?: string
  /** Network-bound (repos, marketplace), so it needs the long cc-switch timeout. */
  long?: boolean
  /**
   * Word pairs a typed `/cc …` may use, when the argv-derived pair would claim a run that
   * also names a mutating command — the App resolves a view before a write on a tie, so the
   * view must name itself with the full three words instead.
   */
  phrases?: readonly string[]
}

/**
 * Read-only `/cc` views, mirroring what Telegram can print. The app renders this
 * table, so a new view needs no app release; argv stays built here.
 * `provider export` is deliberately absent: without `-o` it writes
 * `{cwd}/.claude/settings.local.json`, so it is a side effect, not a view.
 */
export const CC_VIEWS: Readonly<Record<string, CcViewSpec>> = {
  config: { label: "cc-switch 配置", args: () => ["config", "show"] },
  sessions: { label: "会话列表", args: () => ["sessions", "list"] },
  "session-show": {
    label: "会话详情",
    args: (id) => ["sessions", "show", id],
    needsTarget: true,
    targetLabel: "会话 ID 或 provider/ID",
  },
  "session-messages": {
    label: "会话消息",
    args: (id) => ["sessions", "messages", id],
    needsTarget: true,
    targetLabel: "会话 ID 或 provider/ID",
  },
  "provider-current": { label: "当前 Provider", args: () => ["provider", "current"] },
  auth: { label: "认证状态", args: () => ["auth", "status"] },
  "auth-list": { label: "ChatGPT 账号列表", args: () => ["auth", "list"] },
  skills: { label: "技能列表", args: () => ["skills", "list"] },
  "skill-info": {
    label: "技能详情",
    args: (name) => ["skills", "info", name],
    needsTarget: true,
    targetLabel: "技能目录或 ID",
  },
  "skills-discover": { label: "仓库可用技能", args: () => ["skills", "discover"], long: true },
  "skills-updates": { label: "检查技能更新", args: () => ["skills", "check-updates"], long: true },
  "skills-repos": {
    label: "已添加的技能仓库",
    args: () => ["skills", "repos", "list"],
    phrases: ["skills repos list"],
    long: true,
  },
  "mcp-validate": {
    label: "校验 MCP 命令",
    args: (command) => ["mcp", "validate", command],
    needsTarget: true,
    targetLabel: "可执行命令",
  },
  failover: { label: "故障转移状态", args: () => ["failover", "show"] },
  "failover-list": { label: "故障转移队列", args: () => ["failover", "list"] },
  "failover-available": { label: "可加入队列的 Provider", args: () => ["failover", "available"] },
  "prompt-current": { label: "当前提示词", args: () => ["prompts", "current"] },
  "prompt-live": { label: "生效中的提示词文件", args: () => ["prompts", "live"] },
  "prompt-show": {
    label: "提示词内容",
    args: (id) => ["prompts", "show", id],
    needsTarget: true,
    targetLabel: "提示词 ID",
  },
  "config-path": { label: "配置文件路径", args: () => ["config", "path"] },
  "daemon-logs": { label: "守护进程日志", args: () => ["daemon", "logs"] },
  daemon: { label: "守护进程", args: () => ["daemon", "status"] },
  settings: { label: "cc-switch 设置", args: () => ["settings", "show"] },
}

interface CcExecSpec {
  label: string
  /** Build the fixed argv; `target` and `extra` are both pre-validated. */
  args: (target: string, extra: string) => string[]
  needsTarget?: boolean
  targetLabel?: string
  /**
   * The second half of `arg`. The App prompts once per command, so a command Telegram types
   * as `failover move p1 up` arrives as one string; the server splits it and validates each
   * half, because the CLI only ever receives allowlisted argv.
   */
  extra?: "apps" | "direction" | "host" | "name" | "port"
  extraLabel?: string
  /** cc-switch prompts for confirmation on a TTY for these. */
  pty?: boolean
  /** Network-bound (skill market), so it needs the long cc-switch timeout. */
  long?: boolean
  /** Overrides the cc-switch timeout for one command that runs longer than `long`. */
  timeoutMs?: number
  /**
   * Word pairs a typed `/cc …` may use, for the commands whose argv has no subcommand to
   * name them (`update` alone is one word, and the App matches on pairs). Without this the
   * entry would be reachable from the danger-zone list but not by typing.
   */
  phrases?: readonly string[]
  /** Destructive: the caller must send confirm:true, mirroring Telegram's button. */
  confirm?: boolean
}

/** Section titles for the app's danger zone, keyed by cc-switch's top-level group. */
export const CC_EXEC_GROUPS: Readonly<Record<string, string>> = {
  provider: "Provider",
  mcp: "MCP 服务器",
  prompts: "提示词",
  skills: "技能",
  sessions: "会话",
  failover: "故障转移",
  proxy: "代理",
  config: "配置",
  auth: "ChatGPT 账号",
  daemon: "守护进程",
  settings: "设置",
  update: "cc-switch 自更新",
}

/**
 * The mutating `/cc` commands the app may reach. Keys mirror Telegram's
 * confirmation gate; only these fixed argv shapes ever hit the CLI, so the
 * request body can never smuggle arbitrary arguments.
 */
export const CC_EXEC_COMMANDS: Readonly<Record<string, CcExecSpec>> = {
  "provider-delete": {
    label: "删除 Provider",
    args: (id) => ["provider", "delete", id],
    needsTarget: true,
    targetLabel: "Provider ID",
    pty: true,
    confirm: true,
  },
  "provider-duplicate": {
    label: "复制 Provider",
    args: (id) => ["provider", "duplicate", id],
    needsTarget: true,
    targetLabel: "Provider ID",
  },
  "provider-set-default": {
    label: "设为应用默认 Provider",
    args: (id) => ["provider", "set-default", id],
    needsTarget: true,
    targetLabel: "Provider ID",
    confirm: true,
  },
  "provider-import-live": {
    label: "从当前 live 配置导入 Provider",
    args: () => ["provider", "import-live"],
    confirm: true,
  },
  "provider-remove-from-config": {
    label: "从 live 配置移除 Provider（不删除本体）",
    args: (id) => ["provider", "remove-from-config", id],
    needsTarget: true,
    targetLabel: "Provider ID",
    pty: true,
    confirm: true,
  },
  "mcp-enable": {
    label: "启用 MCP 服务器",
    args: (id) => ["mcp", "enable", id],
    needsTarget: true,
    targetLabel: "MCP 名称",
  },
  "mcp-disable": {
    label: "停用 MCP 服务器",
    args: (id) => ["mcp", "disable", id],
    needsTarget: true,
    targetLabel: "MCP 名称",
  },
  // Telegram types `mcp set-apps <id> --apps a,b`; the App supplies both halves in one
  // prompt, so `arg` reads "fs opencode,codex" and the flag goes back in here
  "mcp-set-apps": {
    label: "设置 MCP 生效的应用",
    args: (id, apps) => ["mcp", "set-apps", "--apps", apps, id],
    needsTarget: true,
    targetLabel: "MCP 名称与应用列表（空格分隔，列表用逗号）",
    extra: "apps",
    extraLabel: "应用列表",
  },
  "failover-add": {
    label: "加入故障转移队列",
    args: (id) => ["failover", "add", id],
    needsTarget: true,
    targetLabel: "Provider ID",
  },
  "failover-remove": {
    label: "移出故障转移队列",
    args: (id) => ["failover", "remove", id],
    needsTarget: true,
    targetLabel: "Provider ID",
  },
  "failover-move": {
    label: "队列内上移/下移 Provider",
    args: (id, direction) => ["failover", "move", id, direction],
    needsTarget: true,
    targetLabel: "Provider ID 与方向（up/down），空格分隔",
    extra: "direction",
    extraLabel: "方向",
  },
  "proxy-enable": {
    label: "启用 cc-switch 代理",
    args: () => ["proxy", "enable"],
  },
  "proxy-disable": {
    label: "停用 cc-switch 代理",
    args: () => ["proxy", "disable"],
  },
  // `proxy config` takes one setting per run, so the two get separate entries rather than
  // a three-value arg; needsTarget stays off and the whole arg is the value
  "proxy-listen-address": {
    label: "设置代理监听地址",
    args: (_unused, address) => ["proxy", "config", "--listen-address", address],
    phrases: ["proxy config address"],
    targetLabel: "监听地址（如 127.0.0.1）",
    extra: "host",
    extraLabel: "监听地址",
  },
  "proxy-listen-port": {
    label: "设置代理监听端口",
    args: (_unused, port) => ["proxy", "config", "--listen-port", port],
    phrases: ["proxy config port"],
    targetLabel: "监听端口（如 8787）",
    extra: "port",
    extraLabel: "监听端口",
  },
  "config-validate": {
    label: "校验配置文件",
    args: () => ["config", "validate"],
  },
  "sessions-sync-usage": {
    label: "同步会话日志到用量统计",
    args: () => ["sessions", "sync-usage"],
    long: true,
  },
  "skills-sync": {
    label: "同步已启用技能到各应用目录",
    args: () => ["skills", "sync"],
    long: true,
  },
  "skills-update": {
    label: "更新单个技能仓库",
    args: (spec) => ["skills", "update", spec],
    needsTarget: true,
    targetLabel: "技能目录或 ID",
    long: true,
  },
  "skills-update-all": {
    label: "更新全部有新版技能",
    args: () => ["skills", "update", "--all"],
    long: true,
  },
  "mcp-delete": {
    label: "删除 MCP 服务器",
    args: (id) => ["mcp", "delete", id],
    needsTarget: true,
    targetLabel: "MCP 名称",
    pty: true,
    confirm: true,
  },
  "prompt-activate": {
    label: "启用提示词预设",
    args: (id) => ["prompts", "activate", id],
    needsTarget: true,
    targetLabel: "提示词 ID",
  },
  "prompt-deactivate": {
    label: "停用当前提示词预设",
    args: () => ["prompts", "deactivate"],
  },
  "prompt-delete": {
    label: "删除提示词预设",
    args: (id) => ["prompts", "delete", id],
    needsTarget: true,
    targetLabel: "提示词 ID",
    pty: true,
    confirm: true,
  },
  "prompt-rename": {
    label: "重命名提示词预设",
    args: (id, name) => ["prompts", "rename", id, "--name", name],
    needsTarget: true,
    targetLabel: "提示词 ID 与新名称，空格分隔",
    extra: "name",
    extraLabel: "新名称",
  },
  "skill-uninstall": {
    label: "卸载技能",
    args: (id) => ["skills", "uninstall", id],
    needsTarget: true,
    targetLabel: "技能名称",
    pty: true,
    confirm: true,
  },
  "session-delete": {
    label: "删除会话",
    args: (id) => ["sessions", "delete", id, "--yes"],
    needsTarget: true,
    targetLabel: "会话 ID",
    confirm: true,
  },
  "skill-install": {
    label: "安装技能",
    args: (repo) => ["skills", "install", repo],
    needsTarget: true,
    targetLabel: "技能仓库 owner/name",
    long: true,
  },
  "failover-enable": {
    label: "启用自动故障转移（可能同时开启代理路由）",
    args: () => ["failover", "enable"],
    pty: true,
    confirm: true,
  },
  "failover-disable": {
    label: "停用自动故障转移",
    args: () => ["failover", "disable"],
  },
  "failover-clear": {
    label: "清空故障转移队列",
    args: () => ["failover", "clear", "--yes"],
    confirm: true,
  },
  // The `/cc` words Telegram also answers, given the same argv shapes here so a typed
  // command in the App resolves instead of stopping at the panel.
  "skills-repos-add": {
    label: "添加技能仓库",
    args: (spec) => ["skills", "repos", "add", spec],
    needsTarget: true,
    targetLabel: "技能仓库 owner/name",
    long: true,
  },
  "settings-language": {
    label: "切换 cc-switch 界面语言",
    args: (lang) => ["settings", "language", lang],
    needsTarget: true,
    targetLabel: "语言代码（en / zh）",
  },
  "daemon-start": {
    label: "后台启动 cc-switch 守护进程",
    args: () => ["daemon", "start", "--detach"],
  },
  "daemon-stop": {
    label: "停止 cc-switch 守护进程",
    args: () => ["daemon", "stop"],
    confirm: true,
  },
  "config-backup": {
    label: "备份当前配置文件",
    args: () => ["config", "backup"],
  },
  "auth-default": {
    label: "设为默认 ChatGPT 账号",
    args: (id) => ["auth", "default", id],
    needsTarget: true,
    targetLabel: "账号 ID",
    confirm: true,
  },
  "auth-remove": {
    label: "移除 ChatGPT 账号",
    args: (id) => ["auth", "remove", id],
    needsTarget: true,
    targetLabel: "账号 ID",
    pty: true,
    confirm: true,
  },
  "auth-logout": {
    label: "登出并清除所有 ChatGPT OAuth 数据",
    args: () => ["auth", "logout"],
    pty: true,
    confirm: true,
  },
  "config-reset": {
    label: "重置 cc-switch 配置为默认值",
    args: () => ["config", "reset"],
    pty: true,
    confirm: true,
  },
  // Telegram's `/cc update`; distinct from the install script the ops center runs,
  // because this one asks cc-switch to replace its own binary
  "cc-update-check": {
    label: "检查 cc-switch 更新",
    args: () => ["update", "--check"],
    phrases: ["update check"],
    long: true,
  },
  "cc-update": {
    label: "升级 cc-switch 二进制",
    args: () => ["update"],
    phrases: ["update binary"],
    pty: true,
    timeoutMs: CC_UPDATE_TIMEOUT_MS,
    confirm: true,
  },
}

