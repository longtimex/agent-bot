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
/** Every `@Serializable data class` the App can decode a response into. */
export function appModelNames(): string[] {
  return [...modelsSource().matchAll(/(?:^|\n) *data class ([A-Za-z_][A-Za-z0-9_]*)\(/g)].map((match) => match[1]!)
}

/**
 * Constructor parameters only: that is all a `@Serializable` data class decodes.
 *
 * The parameter list is read by matching parentheses rather than a regex because defaults
 * call constructors — `Session()`, `emptyList()` — and a single line class such as `GitInfo`
 * closes its paren without the newline some earlier pattern relied on.
 */
export function appModelParams(name: string): string {
  const source = modelsSource()
  const start = source.indexOf(`data class ${name}(`)
  assert.ok(start >= 0, `${name} must be a data class in ${APP_MODELS_SOURCE}`)
  let depth = 0
  for (let i = start + `data class ${name}`.length; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    // A comment inside the parameter list is not code: `/* ( */` would otherwise move the paren
    // that closes the list, and the parse would read half a model.
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i)
      i = end < 0 ? source.length : end
      continue
    }
    if (char === '"') {
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") i++
        else if (source[i] === '"') break
      }
      continue
    }
    if (char === "(") depth++
    else if (char === ")") {
      depth--
      if (depth === 0) return source.slice(start + `data class ${name}(`.length, i)
    }
  }
  throw new Error(`${name}: unbalanced parameter list in ${APP_MODELS_SOURCE}`)
}

export interface ModelField {
  name: string
  /**
   * The Kotlin type as written, without its default (`String?`, `List<TaskMedia>`, `Long`).
   * Enough to say which JSON kind kotlinx will accept; it throws rather than coerce, so a
   * server that answers `"5"` for a `Long` closes the stream with a decode error on the phone.
   */
  type: string
  /**
   * True when the field is absent from the payload at its own risk. A `T?` or an empty
   * default decodes to "nothing to show", which the screens render as a dash or hide. A bare
   * `0` or `false` is indistinguishable from a real measurement, so the server has to send it.
   */
  required: boolean
}

/**
 * Split a constructor's parameter list on its top-level commas.
 *
 * Reading one parameter per line would be enough if every model were written that way, but nine
 * of them are single-line (`data class GitInfo(val branch: String? = null, …)`) and on those the
 * whole rest of the line lands inside the first field's default: the gate then reports one field
 * where the App declares three and never compares the others.
 *
 * Nesting is tracked so a `Map<String, TaskMedia>` or a `Session()` default keeps its commas, and
 * comments are dropped rather than tokenised — the KDoc between parameters says things like
 * "Extra words that select this engine, exactly as Telegram's `/engine` accepts them", whose
 * apostrophe would otherwise open a string that never closes and hide every field below it.
 */
function splitParams(list: string): string[] {
  const params: string[] = []
  let current = ""
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < list.length; i++) {
    const char = list[i]!
    const next = list[i + 1]
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "/" && next === "*") {
      const end = list.indexOf("*/", i + 2)
      i = end < 0 ? list.length : end + 1
      continue
    }
    if (char === "/" && next === "/") {
      const end = list.indexOf("\n", i)
      i = end < 0 ? list.length : end
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if ("([{<".includes(char)) depth++
    else if (")]}>".includes(char)) depth--
    if (char === "," && depth === 0) {
      params.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) params.push(current)
  return params
}

export function appModelShape(name: string): ModelField[] {
  return splitParams(appModelParams(name)).flatMap((param) => {
    const match = /^\s*val\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/s.exec(param)
    if (!match) return []
    // A default is whatever follows the first top-level `=`; it never nests one of its own here.
    const [type = "", rawDefault = ""] = match[2]!.split(/\s*=\s*(.*)/s)
    const defaultValue = rawDefault.trim().replace(/,$/, "")
    const emptyDefault = ["null", "emptyList()", "emptyMap()", '""'].includes(defaultValue)
    return [{
      name: match[1]!,
      type: type.trim().replace(/,$/, ""),
      required: !(type.trim().endsWith("?") || emptyDefault),
    }]
  })
}

export function appModelFields(name: string): Set<string> {
  return new Set(appModelShape(name).map((field) => field.name))
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

/** Top-level `{ … }` spans of a snippet, braces balanced. */
function objectLiterals(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let current = ""
  for (const char of text) {
    if (char === "{") {
      depth++
      if (depth === 1) current = ""
    }
    if (depth > 0) current += char
    if (char === "}" && depth > 0) {
      depth--
      if (depth === 0) spans.push(current)
    }
  }
  return spans
}

function keysOf(text: string): Set<string> {
  return new Set([...text.matchAll(/(?:^|[;{\s])([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((match) => match[1]!))
}

/**
 * Fields of an object-valued member of an exported interface — `git?: { branch: string; dirty: boolean }`.
 *
 * `tsInterfaceFields` stops at the first closing brace, so a nested row's shape has to be read
 * with the braces counted. These are the models a test sandbox may never see on the wire (no
 * `git` binary, a filesystem that refuses `statfs`), which is exactly why they are compared
 * against the declaration rather than against a response.
 */
export function tsInterfaceMemberFields(sources: Record<string, string>, name: string, member: string): Set<string> {
  for (const source of Object.values(sources)) {
    const start = source.indexOf(`export interface ${name}`)
    if (start < 0) continue
    const body = objectLiterals(source.slice(start))[0]
    assert.ok(body, `${name} has no readable body here`)
    const declaration = new RegExp(`(^|\\n)\\s*${member}\\??\\s*:`).exec(body)
    assert.ok(declaration, `${name}.${member} is not a member of the interface here`)
    const literal = objectLiterals(body.slice(declaration.index))[0]
    assert.ok(literal, `${name}.${member} is not an inline object type here`)
    return keysOf(literal)
  }
  throw new Error(`${name} is not an exported interface here`)
}

/** Every key across the members of `export type X = { … } | { … }` — the App decodes one model for the union. */
export function tsUnionFields(sources: Record<string, string>, name: string): Set<string> {
  for (const [file, source] of Object.entries(sources)) {
    const start = source.indexOf(`export type ${name} =`)
    if (start < 0) continue
    const rest = source.slice(start, source.indexOf("\nexport ", start) < 0 ? undefined : source.indexOf("\nexport ", start))
    const fields = new Set<string>()
    for (const literal of objectLiterals(rest)) {
      for (const key of keysOf(literal)) fields.add(key)
    }
    assert.ok(fields.size >= 2, `${name} in ${file} declares no object members`)
    return fields
  }
  throw new Error(`${name} is not an exported union type here`)
}
