import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

/**
 * The App decodes JSON with `ignoreUnknownKeys`, so a field the two sides name differently
 * never throws — the Kotlin default wins and the screen quietly shows a zero. Nothing in this
 * sandbox's toolchain looks across the Kotlin/TypeScript boundary, so every gate that does
 * reads the App's models through here.
 */
export const APP_MODELS_SOURCE = "android/app/src/main/java/com/agentbot/app/data/ApiModels.kt"

let cached: string | undefined

function modelsSource(): string {
  if (cached === undefined) {
    assert.ok(existsSync(APP_MODELS_SOURCE), `${APP_MODELS_SOURCE} is missing, so the App's models cannot be checked`)
    cached = readFileSync(APP_MODELS_SOURCE, "utf8")
  }
  return cached
}

/** Constructor parameters only: that is all a `@Serializable` data class decodes. */
export function appModelFields(name: string): Set<string> {
  return new Set(appModelShape(name).map((field) => field.name))
}

export interface ModelField {
  name: string
  /**
   * True when the field is absent from the payload at its own risk. A `T?` or an empty
   * default decodes to "nothing to show", which the screens render as a dash or hide. A bare
   * `0` or `false` is indistinguishable from a real measurement, so the server has to send it.
   */
  required: boolean
}

export function appModelShape(name: string): ModelField[] {
  const block = new RegExp(`data class ${name}\\(([\\s\\S]*?)\\n\\)`).exec(modelsSource())
  assert.ok(block, `${name} must stay a multi-line data class in ${APP_MODELS_SOURCE}`)
  // One parameter per line, as every model in the App is written
  return [...block[1]!.matchAll(/val ([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^\n]+)/g)].map((match) => {
    const [type = "", rawDefault = ""] = match[2]!.split(/\s*=\s*(.*)/s)
    // `split` hands back the text after the last separator too, so the parameter's trailing
    // comma lands inside the default; without trimming it every `= emptyList()` reads as required
    const defaultValue = rawDefault.trim().replace(/,$/, "")
    const emptyDefault = ["null", "emptyList()", "emptyMap()", '""'].includes(defaultValue)
    return { name: match[1]!, required: !(type.trim().endsWith("?") || emptyDefault) }
  })
}

/** `export interface X { a: T; b?: T }`, plus the fields of every interface it extends. */
export function tsInterfaceFields(sources: Record<string, string>, name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return new Set()
  seen.add(name)
  for (const source of Object.values(sources)) {
    const block = new RegExp(`export interface ${name}(\\s+extends[^{]*)?\\s*\\{([^}]*)\\}`).exec(source)
    if (!block) continue
    const fields = new Set([...block[2]!.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]!))
    const parents = (block[1] ?? "").replace(/^\s*extends/, "").split(",").map((word) => word.trim()).filter(Boolean)
    for (const parent of parents) {
      for (const field of tsInterfaceFields(sources, parent, seen)) fields.add(field)
    }
    return fields
  }
  throw new Error(`${name} is not an exported interface here`)
}
