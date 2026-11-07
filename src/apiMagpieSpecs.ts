import { assertMagpieId } from "./magpie.js"

/**
 * One read-only magpie command the console can run. `args` is built only here, from a
 * validated target, so a client never hands an arbitrary argv to the CLI.
 */
export interface MagpieViewSpec {
  label: string
  args: (target: string) => string[]
  needsTarget?: boolean
  targetLabel?: string
  long?: boolean
  /** Extra word runs a typed `/magpie …` line may use for this view. */
  phrases?: string[][]
}

/** A magpie command that changes state; `confirm` ones need an explicit second step. */
export interface MagpieExecSpec {
  label: string
  args: (target: string) => string[]
  needsTarget?: boolean
  targetLabel?: string
  confirm?: boolean
  long?: boolean
  phrases?: string[][]
}

const RANGES = new Set(["today", "7d", "30d", "all"])

/** One target word: ids, agent names and range words all fit, and nothing else does. */
export function assertMagpieTarget(raw: string, label = "目标"): string {
  return assertMagpieId(raw, label)
}

export const MAGPIE_VIEWS: Record<string, MagpieViewSpec> = {
  status: { label: "已检测 Agents", args: () => ["ls"], phrases: [["status"], ["ls"]] },
  providers: { label: "Provider 列表", args: () => ["providers"], phrases: [["providers"], ["provider", "list"]] },
  presets: { label: "内置供应商模板", args: () => ["presets"], phrases: [["presets"]] },
  agents: { label: "全部支持的 Agents", args: () => ["agents"], phrases: [["agents"]] },
  models: {
    label: "模型列表",
    targetLabel: "Agent（可选）",
    args: (target) => (target ? ["models", target] : ["models"]),
    long: true,
    phrases: [["models"]],
  },
  groups: { label: "路由组", args: () => ["groups"], phrases: [["groups"]] },
  quota: {
    label: "配额",
    targetLabel: "Provider（可选）",
    args: (target) => (target ? ["quota", target] : ["quota"]),
    long: true,
    phrases: [["quota"]],
  },
  usage: {
    label: "用量",
    targetLabel: "窗口 today/7d/30d/all（可选）",
    args: (target) => (RANGES.has(target) ? ["usage", target] : ["usage"]),
    long: true,
    phrases: [["usage"]],
  },
  settings: { label: "设置", args: () => ["settings", "list"], phrases: [["settings"], ["settings", "list"]] },
  daemon: { label: "守护进程状态", args: () => ["daemon", "status"], phrases: [["daemon"], ["daemon", "status"]] },
  sessions: { label: "会话", args: () => ["sessions"], long: true, phrases: [["sessions"]] },
  accounts: { label: "订阅账号", args: () => ["accounts"], long: true, phrases: [["accounts"]] },
}

export const MAGPIE_EXEC: Record<string, MagpieExecSpec> = {
  sync: { label: "同步模型目录", args: () => ["sync"], long: true, phrases: [["sync"]] },
  "update-check": {
    label: "检查 magpie 更新",
    args: () => ["update", "check"],
    long: true,
    phrases: [["update", "check"]],
  },
  update: { label: "升级 magpie", args: () => ["update"], confirm: true, long: true, phrases: [["update"]] },
  "daemon-start": {
    label: "启动 magpie 守护进程",
    args: () => ["daemon", "start"],
    confirm: true,
    long: true,
    phrases: [["daemon", "start"]],
  },
  "daemon-stop": {
    label: "停止 magpie 守护进程",
    args: () => ["daemon", "stop"],
    confirm: true,
    phrases: [["daemon", "stop"]],
  },
  "daemon-restart": {
    label: "重启 magpie 守护进程",
    args: () => ["daemon", "restart"],
    confirm: true,
    long: true,
    phrases: [["daemon", "restart"]],
  },
  "provider-test": {
    label: "测试 Provider",
    targetLabel: "Provider ID",
    args: (target) => ["provider", "test", target],
    needsTarget: true,
    long: true,
    phrases: [["provider", "test"]],
  },
  "provider-models": {
    label: "拉取 Provider 模型",
    targetLabel: "Provider ID",
    args: (target) => ["provider", "models", target],
    needsTarget: true,
    long: true,
    phrases: [["provider", "models"]],
  },
  "provider-rm": {
    label: "删除 Provider",
    targetLabel: "Provider ID",
    args: (target) => ["provider", "rm", target],
    needsTarget: true,
    confirm: true,
    long: true,
    phrases: [["provider", "rm"], ["provider", "del"], ["provider", "delete"]],
  },
  "group-rm": {
    label: "删除路由组",
    targetLabel: "路由组 ID",
    args: (target) => ["group", "rm", target],
    needsTarget: true,
    confirm: true,
    phrases: [["group", "rm"], ["group", "del"], ["group", "delete"]],
  },
  "accounts-refresh": {
    label: "刷新订阅登录",
    args: () => ["accounts", "refresh"],
    long: true,
    phrases: [["accounts", "refresh"]],
  },
}

/** Word runs that identify a view, longest first, so `provider list` beats `provider`. */
export function magpieViewPhrases(): Array<[words: string[], name: string]> {
  const rows: Array<[string[], string]> = []
  for (const [name, spec] of Object.entries(MAGPIE_VIEWS)) {
    for (const phrase of spec.phrases ?? [[name]]) rows.push([phrase, name])
  }
  return rows.sort((a, b) => b[0].length - a[0].length)
}

export function magpieExecPhrases(): Array<[words: string[], name: string]> {
  const rows: Array<[string[], string]> = []
  for (const [name, spec] of Object.entries(MAGPIE_EXEC)) {
    for (const phrase of spec.phrases ?? [[name]]) rows.push([phrase, name])
  }
  return rows.sort((a, b) => b[0].length - a[0].length)
}

/** Strip control characters and cap a passthrough word, so it stays one safe argv token. */
export function assertMagpieArg(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("参数不能为空。")
  if (trimmed.length > 500) throw new Error("单个参数过长（上限 500 字）。")
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(trimmed)) throw new Error("参数不能包含控制字符。")
  return trimmed
}
