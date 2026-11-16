import { readFileSync, statSync } from "node:fs"

export interface ModelInfo {
  providerID: string
  modelID: string
  label: string
  desc: string
}

/**
 * Words that mean "drop this session's own model pick". Both surfaces read this one set, so
 * `/model reset` typed in the App behaves as it does in Telegram.
 */
export const MODEL_DEFAULT_WORDS = new Set(["default", "reset", "clear", "auto", "默认", "恢复默认"])

export function isModelResetWord(raw: string): boolean {
  return MODEL_DEFAULT_WORDS.has(raw.trim().toLowerCase())
}

const CUSTOM_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/

let customModelsPath: string | undefined
let customModelsStamp = ""

// The only model catalogue left: what the user registered in data/models.json. A built-in
// list lived here before and made the App offer models whose provider was never configured
// — an entry the engine cannot resolve is worse than an empty list that says so.
const registryModels: Record<string, ModelInfo> = Object.create(null) as Record<string, ModelInfo>
const registryAliases: Record<string, string> = Object.create(null) as Record<string, string>

export function setCustomModelsPath(path: string): void {
  customModelsPath = path
  customModelsStamp = ""
  reloadCustomModels(true)
}

export function getCustomModelsPath(): string | undefined {
  return customModelsPath
}

/** Everything the bot may offer: the registered models, keyed by their short name. */
export function listModels(): Record<string, ModelInfo> {
  reloadCustomModels()
  const snapshot: Record<string, ModelInfo> = Object.create(null) as Record<string, ModelInfo>
  for (const [key, info] of Object.entries(registryModels)) snapshot[key] = { ...info }
  return snapshot
}

/** Resolves a registry key to its entry, or undefined when the model is gone. */
export function findModel(key: string | undefined): ModelInfo | undefined {
  if (!key) return undefined
  reloadCustomModels()
  const info = registryModels[key]
  return info ? { ...info } : undefined
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
    if (!CUSTOM_KEY_RE.test(key)) continue
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
  for (const key of Object.keys(nextModels)) nextAliases[key] = key
  for (const [key, info] of Object.entries(nextModels)) {
    for (const alias of [info.modelID.toLowerCase(), info.label.toLowerCase()]) {
      if (!alias) continue
      if (Object.hasOwn(nextModels, alias) || Object.hasOwn(nextAliases, alias)) continue
      nextAliases[alias] = key
    }
  }

  customModelsStamp = stamp
  for (const key of Object.keys(registryModels)) delete registryModels[key]
  for (const alias of Object.keys(registryAliases)) delete registryAliases[alias]
  for (const [key, info] of Object.entries(nextModels)) registryModels[key] = info
  for (const [alias, key] of Object.entries(nextAliases)) registryAliases[alias] = key
}

function clearCustomModels(): void {
  for (const key of Object.keys(registryModels)) delete registryModels[key]
  for (const alias of Object.keys(registryAliases)) delete registryAliases[alias]
}

export function resolveModelKey(rawArg: string): string | undefined {
  reloadCustomModels()
  const norm = rawArg.trim().toLowerCase()
  if (!norm) return undefined
  // Own-property lookups only: inherited names such as "constructor" would
  // otherwise resolve to a prototype value instead of a model key
  if (Object.hasOwn(registryModels, norm)) return norm
  if (Object.hasOwn(registryAliases, norm)) return registryAliases[norm]

  const stripped = norm.replace(/[\s_./]+/g, "")
  for (const [alias, key] of Object.entries(registryAliases)) {
    if (alias.replace(/[\s_./]+/g, "") === stripped) return key
  }
  for (const key of Object.keys(registryModels)) {
    if (key.replace(/[\s_./]+/g, "") === stripped) return key
  }
  for (const [key, info] of Object.entries(registryModels)) {
    if (info.modelID.toLowerCase().replace(/[\s_./]+/g, "") === stripped) return key
  }
  return undefined
}
