import { resolve } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { loadDotEnvFile } from "./config.js"
import { AVAILABLE_MODELS, resolveModelKey } from "./models.js"
import { ModelAdmin, type LiveSessionModels } from "./modelAdmin.js"
import { SessionStore } from "./store.js"
import type { Logger } from "./logger.js"

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * The CLI runs in a separate process from the Bot. Holding one SessionStore open for
 * the whole run would rewrite the file from the snapshot taken at startup and lose
 * every chat the Bot saved meanwhile, so each operation re-reads the file and writes
 * back only its own change.
 */
export function liveSessions(path: string): LiveSessionModels {
  return {
    listModelRefs: () => new SessionStore(path, quietLog).listModelRefs(),
    clearModel: (key) => new SessionStore(path, quietLog).clearModel(key),
  }
}

const USAGE = `模型管理 CLI（供 Bot 与 AI Agent 使用）

用法：
  npm run models -- list
  npm run models -- add <简称> <providerID/modelID> [--label 名称] [--desc 说明]
                                [--attach] [--context 200000] [--output 8192]
  npm run models -- del <简称> [--force]
  npm run models -- show <简称|providerID/modelID>
  npm run models -- assign <agent|self> <简称|providerID/modelID>
  npm run models -- agents

说明：
  • add 会把模型写入 data/models.json，并同步到项目 opencode.json 对应 provider 的 models 列表。
  • assign 修改 .opencode/agent/<name>.md 的 frontmatter model 字段；self 表示当前 Bot 的 agent。
  • del 默认拒绝删除仍被 agent、opencode.json 或某个聊天选用的模型；确认时加 --force（此时相关聊天的模型选择会被重置为引擎默认）。
  • 修改立即生效，Bot 会在下次读取模型列表时自动重新加载。`

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  const valueFlags = new Set(["--label", "--desc", "--context", "--output"])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    if (eq > 0) {
      flags.set(arg.slice(0, eq), arg.slice(eq + 1))
    } else if (valueFlags.has(arg)) {
      const value = argv[i + 1]
      // `--label --desc x` means the label is missing, not that it is "--desc"
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少参数值。`)
      flags.set(arg, value)
      i += 1
    } else {
      flags.set(arg, true)
    }
  }
  return { positionals, flags }
}

/** `--attach` and `--attach=false` are both accepted for boolean flags. */
function flagEnabled(value: string | true | undefined): boolean {
  if (value === undefined) return false
  if (value === true) return true
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase())
}

function positiveInt(value: string | true | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (value === true) throw new Error(`${label} 需要数字参数。`)
  const trimmed = value.trim()
  const parsed = Number(trimmed)
  // Reject hex/exponent/fraction forms ("0x10", "1e3", "3.5") that Number() would accept
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数。`)
  }
  return parsed
}

function splitRef(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`模型请使用 providerID/modelID 形式，例如 custom/gemini-4-argon-high（收到：${ref}）`)
  }
  return { providerID: ref.slice(0, slash).trim(), modelID: ref.slice(slash + 1).trim() }
}

function printList(admin: ModelAdmin): void {
  const custom = admin.listCustomModels()
  const keys = Object.keys(custom).sort()
  if (keys.length === 0) {
    console.log("暂无自定义模型。用 `npm run models -- add <简称> <providerID/modelID>` 添加。")
  } else {
    console.log(`自定义模型（${keys.length}）：`)
    for (const key of keys) {
      const model = custom[key]!
      console.log(`  ${key.padEnd(16)} ${model.providerID}/${model.modelID}  — ${model.label}${model.desc ? `（${model.desc}）` : ""}`)
    }
  }
  const agents = admin.listAgents()
  if (agents.length > 0) {
    console.log("\nAgent 绑定：")
    for (const agent of agents) {
      console.log(`  ${agent.name.padEnd(16)} ${agent.model ?? "（未设置）"}`)
    }
  }
}

function printAgents(admin: ModelAdmin): void {
  const agents = admin.listAgents()
  if (agents.length === 0) {
    console.log(`未找到 agent 文件（${resolve(process.cwd(), ".opencode", "agent")}）。`)
    return
  }
  for (const agent of agents) {
    const suffix = agent.mode ? ` [${agent.mode}]` : ""
    const desc = agent.description ? `  ${agent.description}` : ""
    console.log(`${agent.name}${suffix}\n  model: ${agent.model ?? "（未设置）"}${desc}\n  file:  ${agent.file}`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)
  const [command = "help", ...rest] = parsed.positionals

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE)
    return
  }

  // The Bot reads DATA_DIR / OPENCODE_AGENT from .env; the CLI must target the same files.
  loadDotEnvFile()
  const dataDir = resolve(process.env.DATA_DIR ?? "./data")
  const admin = new ModelAdmin(
    resolve(dataDir, "models.json"),
    process.cwd(),
    process.env.OPENCODE_AGENT ?? "assistant",
    liveSessions(resolve(dataDir, "sessions.json")),
  )

  if (command === "list" || command === "ls") {
    printList(admin)
    return
  }

  if (command === "agents") {
    printAgents(admin)
    return
  }

  if (command === "add") {
    const [key, ref] = rest
    if (!key || !ref) throw new Error("用法：npm run models -- add <简称> <providerID/modelID> [--label 名称]")
    const target = splitRef(ref)
    const result = admin.add({
      key,
      providerID: target.providerID,
      modelID: target.modelID,
      label: parsed.flags.get("--label") as string | undefined,
      desc: parsed.flags.get("--desc") as string | undefined,
      attachment: flagEnabled(parsed.flags.get("--attach")),
      contextWindow: positiveInt(parsed.flags.get("--context"), "--context"),
      outputLimit: positiveInt(parsed.flags.get("--output"), "--output"),
    })
    console.log(`✅ 已添加模型 ${result.key} -> ${result.entry.providerID}/${result.entry.modelID}（${result.entry.label}）`)
    console.log(
      result.providerUpdated
        ? `   已同步到 opencode.json 的 provider「${result.entry.providerID}」models 列表。`
        : `   provider「${result.entry.providerID}」不在项目 opencode.json 中，仅登记到 data/models.json。`,
    )
    console.log("   Bot 下次读取模型列表时会自动加载，无需重启。")
    return
  }

  if (command === "del" || command === "delete" || command === "rm") {
    const key = rest[0]
    if (!key) throw new Error("用法：npm run models -- del <简称> [--force]")
    const removed = admin.remove(key, flagEnabled(parsed.flags.get("--force")))
    if (!removed) throw new Error(`模型不存在或不是自定义模型：${key}`)
    console.log(`🗑 已删除模型 ${removed.key}（${removed.entry.providerID}/${removed.entry.modelID}）`)
    if (removed.providerUpdated) console.log(`   已从 opencode.json provider「${removed.entry.providerID}」移除。`)
    if (removed.references.length > 0) {
      console.log(`   ⚠️ 强制删除，以下引用仍然存在：${removed.references.join("、")}`)
    }
    if (removed.resetAgents.length > 0) {
      console.log(`   已清除 ${removed.resetAgents.length} 个 agent 的模型绑定：${removed.resetAgents.join("、")}（改用引擎默认）`)
    }
    if (removed.resetChats.length > 0) {
      console.log(`   已重置 ${removed.resetChats.length} 个聊天的模型选择：${removed.resetChats.join("、")}（改用引擎默认）`)
    }
    return
  }

  if (command === "assign") {
    const [agent, selection] = rest
    if (!agent || !selection) throw new Error("用法：npm run models -- assign <agent|self> <简称|providerID/modelID>")
    const result = admin.assignAgent(agent, selection)
    console.log(`✅ 已将 agent ${result.agent} 的模型设置为 ${result.model}（${result.label}）`)
    console.log(`   写入：${result.file}`)
    console.log("   新会话生效；若该 agent 正在运行，请重启对应会话。")
    return
  }

  if (command === "show") {
    const selection = rest[0]
    if (!selection) throw new Error("用法：npm run models -- show <简称|providerID/modelID>")
    const key = resolveModelKey(selection)
    const model = key ? AVAILABLE_MODELS[key]! : admin.resolveModel(selection)
    console.log(`${key ?? "（未登记）"} -> ${model.providerID}/${model.modelID}（${model.label}）\n${model.desc}`)
    return
  }

  throw new Error(`未知命令：${command}\n\n${USAGE}`)
}

// Only run when invoked as a program: importing this module (tests) must not parse argv.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
