import { readFileSync, statSync } from "node:fs"

export interface ModelInfo {
  providerID: string
  modelID: string
  label: string
  desc: string
}

export const AVAILABLE_MODELS: Record<string, ModelInfo> = {
  sonnet: {
    providerID: "custom",
    modelID: "claude-sonnet-5-5-high",
    label: "Claude Sonnet 5.5",
    desc: "编程顶尖、推理严谨、综合体验最佳（最推荐）",
  },
  opus: {
    providerID: "custom",
    modelID: "claude-opus-5-5-high",
    label: "Claude Opus 5.5",
    desc: "极致逻辑与长篇复杂任务理解",
  },
  gemini: {
    providerID: "custom",
    modelID: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash",
    desc: "响应极快、上下文大（默认均衡模型）",
  },
  argon: {
    providerID: "custom",
    modelID: "gemini-4-argon-high",
    label: "Gemini 4 Argon",
    desc: "新一代大参数高阶推理模型",
  },
  "gemini-3.5": {
    providerID: "custom",
    modelID: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Lite",
    desc: "超轻量、低延迟",
  },
  "gemini-3.1": {
    providerID: "custom",
    modelID: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Lite",
    desc: "极速轻量模型",
  },
  "gemini-3": {
    providerID: "custom",
    modelID: "gemini-3-flash",
    label: "Gemini 3 Flash",
    desc: "标准低延迟 Flash 模型",
  },
  grok: {
    providerID: "grok",
    modelID: "grok-4.7",
    label: "Grok 4.7",
    desc: "xAI 最新 Grok 4.7 模型",
  },
  gpt: {
    providerID: "custom",
    modelID: "gpt-oss-120b-medium",
    label: "GPT OSS 120B",
    desc: "大参数开源基座模型",
  },
  deepseek: {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash-free",
    label: "DeepSeek V4.1 Flash Free",
    desc: "OpenCode 平台免费版 DeepSeek",
  },
  glm: {
    providerID: "opencode",
    modelID: "glm-5.3-flash-free",
    label: "GLM-5.3 Flash Free",
    desc: "OpenCode 平台免费版智谱 GLM",
  },
  mimo: {
    providerID: "opencode",
    modelID: "mimo-v2.6-flash-free",
    label: "MiMo-V2.6 Flash Free",
    desc: "OpenCode 平台免费版小米 MiMo",
  },
  "nemotron-ultra": {
    providerID: "opencode",
    modelID: "nemotron-3-ultra-free",
    label: "Nemotron 3 Ultra Free",
    desc: "NVIDIA Nemotron 3 超强推理（免费版）",
  },
  "nemotron-vl": {
    providerID: "opencode",
    modelID: "nemotron-3.5-super-vl-free",
    label: "Nemotron 3.5 Super VL Free",
    desc: "NVIDIA Nemotron 视觉多模态（免费版）",
  },
  "nemotron-light": {
    providerID: "opencode",
    modelID: "nemotron-3.5-lightning-free",
    label: "Nemotron 3.5 Lightning Free",
    desc: "NVIDIA Nemotron 闪电推理（免费版）",
  },
  flint: {
    providerID: "opencode",
    modelID: "flint-40b-free",
    label: "Flint 40B Free",
    desc: "Flint 40B 开源模型（免费版）",
  },
  beam: {
    providerID: "opencode",
    modelID: "beam-free",
    label: "Beam Free",
    desc: "Beam 平台免费模型",
  },
}

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "sonnet",
  claude: "sonnet",
  "claude-sonnet": "sonnet",
  "claude sonnet": "sonnet",
  "claude-sonnet-5-5-high": "sonnet",
  "claude sonnet 5.5": "sonnet",
  "sonnet 5.5": "sonnet",
  opus: "opus",
  "claude-opus": "opus",
  "claude opus": "opus",
  "claude-opus-5-5-high": "opus",
  "claude opus 5.5": "opus",
  "opus 5.5": "opus",
  gemini: "gemini",
  flash: "gemini",
  "gemini-3.8": "gemini",
  "gemini 3.8": "gemini",
  "gemini-3.8-flash-high": "gemini",
  "gemini 3.8 flash": "gemini",
  argon: "argon",
  "gemini-4": "argon",
  "gemini 4": "argon",
  "gemini-4-argon-high": "argon",
  "gemini 4 argon": "argon",
  lite: "gemini-3.5",
  "gemini-3.5": "gemini-3.5",
  "gemini 3.5": "gemini-3.5",
  "gemini-3.5-flash-lite": "gemini-3.5",
  "gemini-3.1": "gemini-3.1",
  "gemini 3.1": "gemini-3.1",
  "gemini-3.1-flash-lite": "gemini-3.1",
  "gemini-3": "gemini-3",
  "gemini 3": "gemini-3",
  "gemini-3-flash": "gemini-3",
  grok: "grok",
  "grok4.7": "grok",
  "grok-4.7": "grok",
  "grok 4.7": "grok",
  "grok4": "grok",
  "grok-4": "grok",
  "grok 4": "grok",
  "grok/grok-4.7": "grok",
  "xai/grok-4.7": "grok",
  "xai grok 4.7": "grok",
  gpt: "gpt",
  "gpt-oss": "gpt",
  "gpt oss": "gpt",
  "gpt-oss-120b-medium": "gpt",
  deepseek: "deepseek",
  "deepseek-free": "deepseek",
  "deepseek-v4.1-flash-free": "deepseek",
  "deepseek v4.1": "deepseek",
  "deepseek v4": "deepseek",
  glm: "glm",
  "glm-free": "glm",
  "glm-5.3-flash-free": "glm",
  "glm 5.3": "glm",
  mimo: "mimo",
  "mimo-free": "mimo",
  "mimo-v2.6-flash-free": "mimo",
  "mimo 2.6": "mimo",
  nemotron: "nemotron-ultra",
  "nemotron-ultra": "nemotron-ultra",
  "nemotron-3-ultra-free": "nemotron-ultra",
  "nemotron-vl": "nemotron-vl",
  "nemotron-3.5-super-vl-free": "nemotron-vl",
  "nemotron-light": "nemotron-light",
  "nemotron-3.5-lightning-free": "nemotron-light",
  flint: "flint",
  "flint-40b-free": "flint",
  beam: "beam",
  "beam-free": "beam",
}

export function resolveQoderModel(raw: string): string | undefined {
  const norm = raw.trim().toLowerCase()
  if (!norm) return undefined
  if (norm.includes("deepseek") || norm === "ds") return "DeepSeek-Flash"
  if (norm.includes("qwen")) return "Qwen3.8-Flash"
  return undefined
}

const BUILTIN_MODEL_KEYS = new Set(Object.keys(AVAILABLE_MODELS))
const BUILTIN_ALIASES: Record<string, string> = { ...MODEL_ALIASES }
const CUSTOM_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/

let customModelsPath: string | undefined
let customModelsStamp = ""
let customModelKeys = new Set<string>()

export function isBuiltinModelKey(key: string): boolean {
  return BUILTIN_MODEL_KEYS.has(key)
}

export function setCustomModelsPath(path: string): void {
  customModelsPath = path
  customModelsStamp = ""
  reloadCustomModels(true)
}

export function getCustomModelsPath(): string | undefined {
  return customModelsPath
}

// Re-reads data/models.json when it changes on disk, so models added through
// `npm run models` take effect without restarting the bot.
export function reloadCustomModels(force = false): void {
  if (!customModelsPath) return

  let stamp = "missing"
  try {
    const info = statSync(customModelsPath)
    stamp = `${info.mtimeMs}:${info.size}`
  } catch {
    // registry is optional
  }
  if (!force && stamp === customModelsStamp) return

  if (stamp === "missing") {
    customModelsStamp = stamp
    clearCustomModels()
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(customModelsPath, "utf8"))
  } catch {
    // A half-written or hand-misspelled registry must not erase the custom models that
    // are already loaded: keep serving them and retry as soon as the file changes again.
    return
  }
  const models =
    parsed && typeof parsed === "object" && typeof (parsed as { models?: unknown }).models === "object"
      ? ((parsed as { models: Record<string, unknown> }).models ?? {})
      : {}

  const nextModels: Record<string, ModelInfo> = Object.create(null) as Record<string, ModelInfo>
  const nextAliases: Record<string, string> = Object.create(null) as Record<string, string>

  for (const [rawKey, rawInfo] of Object.entries(models)) {
    const key = rawKey.trim().toLowerCase()
    if (!CUSTOM_KEY_RE.test(key) || BUILTIN_MODEL_KEYS.has(key)) continue
    if (!rawInfo || typeof rawInfo !== "object") continue
    if (Object.hasOwn(nextModels, key)) continue
    const info = rawInfo as Record<string, unknown>
    const providerID = typeof info.providerID === "string" ? info.providerID.trim() : ""
    const modelID = typeof info.modelID === "string" ? info.modelID.trim() : ""
    if (!providerID || !modelID) continue
    const label = typeof info.label === "string" && info.label.trim() ? info.label.trim() : modelID
    const desc = typeof info.desc === "string" && info.desc.trim() ? info.desc.trim() : "自定义模型"

    nextModels[key] = { providerID, modelID, label, desc }
  }

  // Keys first: a model's own short name must never lose to another model whose
  // modelID or label happens to spell it, which would make /model beta pick alpha
  for (const key of Object.keys(nextModels)) {
    if (!Object.hasOwn(BUILTIN_ALIASES, key)) nextAliases[key] = key
  }
  for (const [key, info] of Object.entries(nextModels)) {
    for (const alias of [info.modelID.toLowerCase(), info.label.toLowerCase()]) {
      if (!alias) continue
      // MODEL_ALIASES entries that are not builtins belong to the previous custom
      // generation and are dropped right after, so only builtin names really clash
      if (Object.hasOwn(BUILTIN_ALIASES, alias) || Object.hasOwn(nextAliases, alias)) continue
      nextAliases[alias] = key
    }
  }

  customModelsStamp = stamp
  clearCustomModels()
  for (const [key, info] of Object.entries(nextModels)) {
    AVAILABLE_MODELS[key] = info
    customModelKeys.add(key)
  }
  for (const [alias, key] of Object.entries(nextAliases)) MODEL_ALIASES[alias] = key
}

function clearCustomModels(): void {
  for (const key of customModelKeys) delete AVAILABLE_MODELS[key]
  for (const alias of Object.keys(MODEL_ALIASES)) {
    if (!Object.hasOwn(BUILTIN_ALIASES, alias)) delete MODEL_ALIASES[alias]
  }
  customModelKeys = new Set()
}

export function resolveModelKey(rawArg: string): string | undefined {
  reloadCustomModels()
  const norm = rawArg.trim().toLowerCase()
  if (!norm) return undefined
  // Own-property lookups only: inherited names such as "constructor" would
  // otherwise resolve to a prototype value instead of a model key
  if (Object.hasOwn(MODEL_ALIASES, norm)) return MODEL_ALIASES[norm]
  if (Object.hasOwn(AVAILABLE_MODELS, norm)) return norm

  const stripped = norm.replace(/[\s_\-\.\/]+/g, "")
  for (const [alias, key] of Object.entries(MODEL_ALIASES)) {
    if (alias.replace(/[\s_\-\.\/]+/g, "") === stripped) return key
  }
  for (const key of Object.keys(AVAILABLE_MODELS)) {
    if (key.replace(/[\s_\-\.\/]+/g, "") === stripped) return key
  }
  for (const [key, info] of Object.entries(AVAILABLE_MODELS)) {
    if (info.modelID.toLowerCase().replace(/[\s_\-\.\/]+/g, "") === stripped) return key
  }
  return undefined
}
