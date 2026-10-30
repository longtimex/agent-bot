import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { clip } from "./messages.js"
import {
  AVAILABLE_MODELS,
  isBuiltinModelKey,
  reloadCustomModels,
  resolveModelKey,
  setCustomModelsPath,
  type ModelInfo,
} from "./models.js"

export interface ModelRegistryFile {
  version: 1
  models: Record<string, ModelInfo>
}

export interface AddModelInput {
  key: string
  providerID: string
  modelID: string
  label?: string
  desc?: string
  attachment?: boolean
  contextWindow?: number
  outputLimit?: number
}

export interface AddModelResult {
  entry: ModelInfo
  key: string
  providerUpdated: boolean
}

export interface RemoveModelResult {
  entry: ModelInfo
  key: string
  providerUpdated: boolean
  /** Bindings still naming the model after deletion (agent files that could not be rewritten). */
  references: string[]
  /** Chats that were pointing at the deleted model and had their selection reset. */
  resetChats: string[]
  /** Agents whose frontmatter `model:` was cleared so they fall back to the engine default. */
  resetAgents: string[]
}

export interface AgentBinding {
  name: string
  file: string
  model?: string
  description?: string
  mode?: string
}

export interface AssignAgentResult {
  agent: string
  model: string
  label: string
  file: string
}

/**
 * Chat-level model selections, satisfied structurally by `SessionStore`. Without it a
 * deleted model would stay referenced by a chat and every later reply from that chat
 * would fail against a provider/model that no longer exists.
 */
export interface LiveSessionModels {
  listModelRefs(): Array<{ key: string; providerID: string; modelID: string }>
  clearModel(key: string): boolean
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/
const PROVIDER_RE = /^[A-Za-z0-9][\w.:-]*$/
const MODEL_ID_RE = /^[A-Za-z0-9][\w.:@+/-]*$/
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function cleanText(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim()
  return cleaned ? clip(cleaned, max) : undefined
}

function unquote(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/^["'](.*)["']$/s, "$1").trim() || undefined
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  // Unique temp name so the bot and `npm run models` CLI never share a staging file
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  // A hand-restricted file (a 600 project config) must not be widened by the rename,
  // which otherwise inherits the temp file's mode
  let existing: number | undefined
  try {
    existing = statSync(path).mode & 0o777
  } catch {
    existing = undefined
  }
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: existing ?? mode })
  renameSync(tmp, path)
  try {
    chmodSync(path, existing ?? mode)
  } catch {
    // best effort on platforms where chmod is limited
  }
}

function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  // A tightened mode on the original (a hand-restricted agent file) must not be
  // widened by the rename, which otherwise inherits the temp file's default mode
  let mode: number | undefined
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    mode = undefined
  }
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  renameSync(tmp, path)
  if (mode !== undefined) {
    try {
      chmodSync(path, mode)
    } catch {
      // best effort on platforms where chmod is limited
    }
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sanitizeEntry(key: string, raw: unknown): ModelInfo | undefined {
  if (!KEY_RE.test(key) || !isRecord(raw)) return undefined
  const providerID = typeof raw.providerID === "string" ? raw.providerID.trim() : ""
  const modelID = typeof raw.modelID === "string" ? raw.modelID.trim() : ""
  if (!providerID || !modelID) return undefined
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : modelID
  const desc = typeof raw.desc === "string" && raw.desc.trim() ? raw.desc.trim() : "自定义模型"
  return { providerID, modelID, label, desc }
}

export class ModelAdmin {
  readonly #registryPath: string
  readonly #projectDir: string
  readonly #selfAgent: string
  readonly #liveSessions: LiveSessionModels | undefined
  #damagedRegistry = false

  constructor(
    registryPath: string,
    projectDir: string,
    selfAgent = "assistant",
    liveSessions?: LiveSessionModels,
  ) {
    this.#registryPath = registryPath
    this.#projectDir = projectDir
    this.#selfAgent = selfAgent
    this.#liveSessions = liveSessions
    setCustomModelsPath(registryPath)
  }

  get registryPath(): string {
    return this.#registryPath
  }

  get selfAgent(): string {
    return this.#selfAgent
  }

  #readRegistry(): ModelRegistryFile {
    const parsed = readJson(this.#registryPath)
    // A registry file that exists but cannot be read back is remembered, so the next
    // write cannot silently replace every model we failed to parse
    const present = existsSync(this.#registryPath)
    this.#damagedRegistry =
      present && !(isRecord(parsed) && (parsed.models === undefined || isRecord(parsed.models)))
    // Null prototype: model keys come from users, so an inherited name such as
    // "constructor" must not read back as an existing entry
    const models: Record<string, ModelInfo> = Object.create(null) as Record<string, ModelInfo>
    if (isRecord(parsed) && isRecord(parsed.models)) {
      for (const [rawKey, rawEntry] of Object.entries(parsed.models)) {
        const key = rawKey.trim().toLowerCase()
        if (isBuiltinModelKey(key) || models[key]) continue
        const entry = sanitizeEntry(key, rawEntry)
        if (entry) models[key] = entry
      }
    }
    return { version: 1, models }
  }

  #writeRegistry(registry: ModelRegistryFile): void {
    this.#assertRegistryWritable()
    writeJson(this.#registryPath, registry, 0o600)
  }

  /**
   * Refused before any file is touched, so an unreadable registry cannot leave a
   * half-applied change behind in the project config.
   */
  #assertRegistryWritable(): void {
    if (!this.#damagedRegistry) return
    throw new Error(
      `模型注册表 ${this.#registryPath} 无法解析，为避免丢失已注册的模型已拒绝写入。请修复该文件（或备份后删除）再重试。`,
    )
  }

  #projectConfigPath(): string {
    return resolve(this.#projectDir, "opencode.json")
  }

  #readProjectConfig(): Record<string, unknown> | undefined {
    const parsed = readJson(this.#projectConfigPath())
    return isRecord(parsed) ? parsed : undefined
  }

  #writeProjectConfig(config: Record<string, unknown>): void {
    writeJson(this.#projectConfigPath(), config)
  }

  listCustomModels(): Record<string, ModelInfo> {
    return this.#readRegistry().models
  }

  resolveModel(selection: string): ModelInfo {
    const key = resolveModelKey(selection)
    if (key) {
      const info = AVAILABLE_MODELS[key]
      // A stale alias must not silently produce "undefined/undefined"
      if (!info) throw new Error(`未识别的模型：${selection}。请使用模型简称，或 providerID/modelID。`)
      return { ...info }
    }

    const trimmed = selection.trim()
    const slash = trimmed.indexOf("/")
    if (slash > 0) {
      const providerID = trimmed.slice(0, slash).trim()
      const modelID = trimmed.slice(slash + 1).trim()
      if (!PROVIDER_RE.test(providerID)) throw new Error(`Provider ID 无效：${providerID}`)
      if (!MODEL_ID_RE.test(modelID)) throw new Error(`模型 ID 无效：${modelID}`)
      return { providerID, modelID, label: modelID, desc: "自定义模型" }
    }

    throw new Error(`未识别的模型：${selection}。请使用模型简称，或 providerID/modelID。`)
  }

  add(input: AddModelInput): AddModelResult {
    const key = input.key.trim().toLowerCase()
    if (!KEY_RE.test(key)) {
      throw new Error("模型简称只能包含小写字母、数字、点、下划线和连字符，且以字母或数字开头。")
    }
    if (isBuiltinModelKey(key)) throw new Error(`模型简称 ${key} 与内置模型冲突，请换一个。`)
    const aliasTarget = resolveModelKey(key)
    if (aliasTarget && aliasTarget !== key) {
      throw new Error(`模型简称 ${key} 与内置别名冲突（已对应 ${aliasTarget}），请换一个。`)
    }

    const providerID = input.providerID.trim()
    const modelID = input.modelID.trim()
    if (!PROVIDER_RE.test(providerID)) throw new Error(`Provider ID 无效：${providerID}`)
    if (!MODEL_ID_RE.test(modelID)) throw new Error(`模型 ID 无效：${modelID}`)

    const registry = this.#readRegistry()
    this.#assertRegistryWritable()
    if (registry.models[key]) throw new Error(`模型 ${key} 已存在，请先删除后再添加。`)
    const clash = Object.entries(AVAILABLE_MODELS).find(
      ([existingKey, info]) => existingKey === key || (existingKey !== key && info.modelID === modelID && info.providerID === providerID),
    )
    if (clash) throw new Error(`模型 ${providerID}/${modelID} 已作为 ${clash[0]} 存在。`)

    const projectConfig = this.#readProjectConfig()
    const projectProvider =
      projectConfig && isRecord(projectConfig.provider) ? projectConfig.provider[providerID] : undefined
    if (isRecord(projectProvider) && isRecord(projectProvider.models) && Object.hasOwn(projectProvider.models, modelID)) {
      throw new Error(`模型 ${providerID}/${modelID} 已存在于项目 opencode.json 中。`)
    }

    const label = cleanText(input.label, 60) ?? modelID
    const desc = cleanText(input.desc, 200) ?? "自定义模型"
    const entry: ModelInfo = { providerID, modelID, label, desc }

    const providerUpdated = this.#upsertProviderModel(entry, input)
    registry.models[key] = entry
    this.#writeRegistry(registry)
    reloadCustomModels(true)
    return { entry, key, providerUpdated }
  }

  remove(key: string, force = false): RemoveModelResult | undefined {
    const norm = key.trim().toLowerCase()
    const registry = this.#readRegistry()
    this.#assertRegistryWritable()
    const entry = registry.models[norm]
    if (!entry) return undefined

    const bindings = this.#agentBindings(entry)
    const projectRefs = this.#projectRefs(entry)
    const chatRefs = this.#chatRefs(entry)
    const usedBy = [...bindings.map((agent) => `agent ${agent.name}`), ...projectRefs]
    if ((usedBy.length > 0 || chatRefs.length > 0) && !force) {
      const inUse = [...usedBy, ...(chatRefs.length > 0 ? [`会话 ${chatRefs.join("、")}`] : [])]
      throw new Error(`模型 ${norm} 仍在使用中：${inUse.join("、")}。确认删除请加 --force。`)
    }

    const providerUpdated = this.#removeProviderModel(entry)
    delete registry.models[norm]
    this.#writeRegistry(registry)
    reloadCustomModels(true)

    // A forced delete must not leave anything bound to a provider/model that no longer
    // exists: chats are reset to the engine default, and so are agent frontmatters.
    const resetChats: string[] = []
    if (this.#liveSessions) {
      for (const key of chatRefs) {
        if (this.#liveSessions.clearModel(key)) resetChats.push(key)
      }
    }
    const resetAgents: string[] = []
    const stale: string[] = []
    for (const agent of bindings) {
      if (this.#clearAgentModel(agent, entry)) resetAgents.push(agent.name)
      else stale.push(`agent ${agent.name}`)
    }
    return { entry, key: norm, providerUpdated, references: [...stale, ...projectRefs], resetChats, resetAgents }
  }

  #upsertProviderModel(entry: ModelInfo, input: AddModelInput): boolean {
    const config = this.#readProjectConfig()
    if (!config) return false
    if (!isRecord(config.provider)) return false
    const provider = config.provider[entry.providerID]
    if (!isRecord(provider)) return false
    if (!isRecord(provider.models)) provider.models = {}
    const models = provider.models as Record<string, unknown>

    const spec: Record<string, unknown> = { name: cleanText(input.label, 60) ?? entry.modelID }
    if (input.attachment) spec.attachment = true
    const limit: Record<string, number> = {}
    if (input.contextWindow && input.contextWindow > 0) limit.context = Math.floor(input.contextWindow)
    if (input.outputLimit && input.outputLimit > 0) limit.output = Math.floor(input.outputLimit)
    if (Object.keys(limit).length > 0) spec.limit = limit

    models[entry.modelID] = spec
    this.#writeProjectConfig(config)
    return true
  }

  #removeProviderModel(entry: ModelInfo): boolean {
    const config = this.#readProjectConfig()
    if (!config || !isRecord(config.provider)) return false
    const provider = config.provider[entry.providerID]
    if (!isRecord(provider) || !isRecord(provider.models)) return false
    const models = provider.models as Record<string, unknown>
    if (!Object.hasOwn(models, entry.modelID)) return false
    delete models[entry.modelID]
    this.#writeProjectConfig(config)
    return true
  }

  #projectRefs(entry: ModelInfo): string[] {
    const ref = `${entry.providerID}/${entry.modelID}`
    const refs: string[] = []
    const config = this.#readProjectConfig()
    if (config) {
      for (const field of ["model", "small_model"]) {
        if (config[field] === ref) refs.push(`opencode.json ${field}`)
      }
    }
    return refs
  }

  /** Agent bindings whose frontmatter `model:` names this exact provider/model. */
  #agentBindings(entry: ModelInfo): AgentBinding[] {
    const ref = `${entry.providerID}/${entry.modelID}`
    return this.listAgents().filter((agent) => agent.model === ref)
  }

  /**
   * Drops the `model:` line so the agent inherits the engine default instead of failing
   * on a provider that is gone. Returns false when the file moved or could not be
   * rewritten, which the caller reports as a remaining reference.
   */
  #clearAgentModel(binding: AgentBinding, entry: ModelInfo): boolean {
    const ref = `${entry.providerID}/${entry.modelID}`
    let content: string
    try {
      content = readFileSync(binding.file, "utf8")
    } catch {
      return false
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
    if (!match) return false
    const frontmatter = match[1]!
    const line = new RegExp(`^[ \\t]*model:[ \\t]*["']?${escapeRe(ref)}["']?[ \\t]*\\r?\\n?`, "m")
    if (!line.test(frontmatter)) return false
    const cleared = frontmatter.replace(line, "").replace(/[\s\r\n]+$/, "")
    try {
      writeTextAtomic(binding.file, content.replace(match[0], () => `---\n${cleared}\n---`))
    } catch {
      return false
    }
    return true
  }

  /** Chat keys whose stored selection still names this model. */
  #chatRefs(entry: ModelInfo): string[] {
    const keys: string[] = []
    for (const live of this.#liveSessions?.listModelRefs() ?? []) {
      if (live.providerID === entry.providerID && live.modelID === entry.modelID) keys.push(live.key)
    }
    return keys
  }

  #agentDir(): string {
    return resolve(this.#projectDir, ".opencode", "agent")
  }

  #agentFile(agent: string): string {
    const name = agent === "self" ? this.#selfAgent : agent.trim()
    if (!AGENT_RE.test(name)) throw new Error(`Agent 名称无效：${agent}`)
    const dir = this.#agentDir()
    const file = resolve(dir, `${name}.md`)
    if (dirname(file) !== dir) throw new Error(`Agent 名称无效：${agent}`)
    if (!existsSync(file)) {
      const available = this.listAgents().map((item) => item.name)
      throw new Error(`Agent 不存在：${name}${available.length ? `（可用：${available.join("、")}）` : ""}`)
    }
    return file
  }

  listAgents(): AgentBinding[] {
    const dir = this.#agentDir()
    if (!existsSync(dir)) return []
    const agents: AgentBinding[] = []
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith(".md")) continue
      const name = fileName.slice(0, -3)
      if (!AGENT_RE.test(name)) continue
      const file = resolve(dir, fileName)
      let content = ""
      try {
        content = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? ""
      agents.push({
        name,
        file,
        // YAML values may be quoted; references and assignment compare bare provider/model ids
        model: unquote(/^model:\s*(.+?)\s*$/m.exec(frontmatter)?.[1]),
        description: unquote(/^description:\s*(.+?)\s*$/m.exec(frontmatter)?.[1]),
        mode: unquote(/^mode:\s*(.+?)\s*$/m.exec(frontmatter)?.[1]),
      })
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name))
  }

  assignAgent(agent: string, selection: string): AssignAgentResult {
    const name = agent === "self" ? this.#selfAgent : agent.trim()
    const file = this.#agentFile(agent)
    const model = this.resolveModel(selection)
    const ref = `${model.providerID}/${model.modelID}`
    const content = readFileSync(file, "utf8")
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
    if (!match) throw new Error(`Agent 文件缺少 frontmatter：${file}`)

    const frontmatter = match[1]!
    let updated: string
    if (/^model:\s*.*$/m.test(frontmatter)) {
      // Function replacements keep `$` sequences in model ids literal
      updated = frontmatter.replace(/^model:\s*.*$/m, () => `model: ${ref}`)
    } else {
      updated = `model: ${ref}\n${frontmatter}`
    }
    const next = content.replace(match[0], () => `---\n${updated}\n---`)
    writeTextAtomic(file, next)
    return { agent: name, model: ref, label: model.label, file }
  }
}
