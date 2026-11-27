import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"
import { createScanner, parse, parseTree, SyntaxKind, type Node as JsonNode, type ParseError } from "jsonc-parser"

/**
 * Edits a hand-maintained JSON config without re-serialising it.
 *
 * `opencode.json` is a file the operator edits by hand: it carries comments, its own
 * indentation and its own key order. Parsing and `JSON.stringify`-ing it back rewrote all
 * of that on every model add, so a one-line addition showed up as a whole-file diff.
 *
 * `jsonc-parser`'s own `modify()` is not enough here: with `formattingOptions` it reformats
 * the surrounding object (an inline `{ "name": "Base" }` next to the insertion point gets
 * expanded), and without them it writes compact JSON. These helpers splice text at the
 * offsets the syntax tree reports, so everything outside the edited property is byte-identical.
 */

export type JsonPath = Array<string | number>

/** The indentation the file already uses, so an inserted block lines up with its neighbours. */
function detectFormatting(text: string): { insertSpaces: boolean; tabSize: number } {
  const match = /\n([ \t]+)\S/.exec(text)
  if (!match) return { insertSpaces: true, tabSize: 2 }
  const indent = match[1] as string
  return indent.includes("\t") ? { insertSpaces: false, tabSize: 1 } : { insertSpaces: true, tabSize: indent.length }
}

function indentUnit(text: string): string {
  const { insertSpaces, tabSize } = detectFormatting(text)
  return insertSpaces ? " ".repeat(tabSize) : "\t"
}

/** JSONC in, plain object out: comments and trailing commas are fine, real syntax errors are not. */
export function parseJsoncObject(text: string): Record<string, unknown> | undefined {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return undefined
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function parseRoot(text: string): JsonNode {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (!root || errors.length > 0 || root.type !== "object") {
    throw new Error("opencode.json 无法解析，已放弃修改")
  }
  return root
}

function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? ""
}

function propertiesOf(node: JsonNode): JsonNode[] {
  return (node.children ?? []).filter((child) => child.type === "property")
}

function valueOf(prop: JsonNode): JsonNode | undefined {
  return prop.children?.[1]
}

function findProperty(text: string, node: JsonNode, key: string): JsonNode | undefined {
  for (const prop of propertiesOf(node)) {
    const keyNode = prop.children?.[0]
    if (!keyNode) continue
    if (text.slice(keyNode.offset + 1, keyNode.offset + keyNode.length - 1) === key) return prop
  }
  return undefined
}

/** The line ending the file already uses, so an inserted block does not mix endings. */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

/** Serialises a value and indents every line after the first to sit under its key. */
function stringify(value: unknown, unit: string, indent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(`${eol}${indent}`)
}

function assertParses(text: string): string {
  if (parseJsoncObject(text) === undefined) throw new Error("写入后的 JSON 无法解析，已放弃修改")
  return text
}

/** Finds the first real JSON comma token in `[offset, limit)`, ignoring comments. */
function findCommaAfter(text: string, offset: number, limit: number): number {
  const scanner = createScanner(text, false)
  scanner.setPosition(offset)
  while (scanner.getPosition() < limit) {
    const token = scanner.scan()
    if (token === SyntaxKind.EOF) break
    if (scanner.getTokenOffset() >= limit) break
    if (token === SyntaxKind.CommaToken) return scanner.getTokenOffset()
    if (
      token !== SyntaxKind.Trivia &&
      token !== SyntaxKind.LineBreakTrivia &&
      token !== SyntaxKind.LineCommentTrivia &&
      token !== SyntaxKind.BlockCommentTrivia
    ) {
      break
    }
  }
  return -1
}

function insertProperty(text: string, object: JsonNode, key: string, value: unknown, unit: string): string {
  const close = object.offset + object.length - 1
  const props = propertiesOf(object)
  const keyJson = JSON.stringify(key)
  const eol = eolOf(text)

  // A single-line object with content stays single-line: splitting it would reformat a
  // hand-written line. An empty `{}` has nothing to preserve, so it is expanded to the
  // file's own indentation instead of receiving a compact one-liner.
  if (props.length > 0 && !text.slice(object.offset, close).includes("\n")) {
    // Insert right after the last property value (before any existing trailing comma or
    // spaces before `}`) so `{ "a": 1, }` becomes `{ "a": 1, "b": 2, }` instead of `, ,`.
    const last = props[props.length - 1]!
    const lastEnd = last.offset + last.length
    return `${text.slice(0, lastEnd)}, ${keyJson}: ${JSON.stringify(value)}${text.slice(lastEnd)}`
  }

  const objectIndent = indentAt(text, object.offset)
  const childIndent = props.length > 0 ? indentAt(text, props[0]!.offset) : objectIndent + unit
  const entry = `${keyJson}: ${stringify(value, unit, childIndent, eol)}`
  if (props.length === 0) {
    // An empty object is rebuilt whole: nothing inside it can be lost
    const end = object.offset + object.length
    return `${text.slice(0, object.offset)}{${eol}${childIndent}${entry}${eol}${objectIndent}}${text.slice(end)}`
  }
  // Insert after the last property, not before the closing brace: the whitespace that
  // already separates them belongs to the file, not to us
  const last = props[props.length - 1]!
  const lastEnd = last.offset + last.length
  // Always our own comma: the text after the last property may already carry a trailing
  // comma, and inserting before it keeps that comma trailing instead of swallowing it.
  return `${text.slice(0, lastEnd)},${eol}${childIndent}${entry}${text.slice(lastEnd)}`
}

function replaceNode(text: string, node: JsonNode, value: unknown, unit: string): string {
  const body = stringify(value, unit, indentAt(text, node.offset), eolOf(text))
  return text.slice(0, node.offset) + body + text.slice(node.offset + node.length)
}

/** Wraps `value` in the not-yet-existing tail of `path`, starting at `from`. */
function nest(path: JsonPath, from: number, value: unknown): unknown {
  let nested = value
  for (let index = path.length - 1; index > from; index -= 1) nested = { [String(path[index])]: nested }
  return nested
}

/**
 * Sets one path and leaves every other byte alone. Missing parents are created in a single
 * splice, so a failure cannot leave a half-written provider behind.
 */
export function setJsonPath(text: string, path: JsonPath, value: unknown): string {
  if (path.length === 0) throw new Error("路径不能为空")
  const root = parseRoot(text)
  const unit = indentUnit(text)
  let node = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const prop = findProperty(text, node, String(path[index]))
    const child = prop ? valueOf(prop) : undefined
    if (!child) return assertParses(insertProperty(text, node, String(path[index]), nest(path, index, value), unit))
    // A scalar or array in the way (a hand-broken `models`) is replaced by the chain itself
    if (child.type !== "object") return assertParses(replaceNode(text, child, nest(path, index, value), unit))
    node = child
  }
  const lastKey = String(path[path.length - 1])
  const existing = findProperty(text, node, lastKey)
  const target = existing ? valueOf(existing) : undefined
  const next =
    existing && target ? replaceNode(text, target, value, unit) : insertProperty(text, node, lastKey, value, unit)
  return assertParses(next)
}

/** Removes one path; the comma that joined it to its neighbours goes with it. */
export function removeJsonPath(text: string, path: JsonPath): string {
  if (path.length === 0) throw new Error("路径不能为空")
  const root = parseRoot(text)
  let node = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const prop = findProperty(text, node, String(path[index]))
    const child = prop ? valueOf(prop) : undefined
    if (!child || child.type !== "object") throw new Error("路径不存在")
    node = child
  }
  const prop = findProperty(text, node, String(path[path.length - 1]))
  if (!prop) throw new Error("路径不存在")
  const props = propertiesOf(node)
  const index = props.indexOf(prop)
  // Removing the only property empties the object; collapse it so a fill-then-remove cycle
  // comes back to the `{}` it started from
  if (props.length === 1) {
    return assertParses(text.slice(0, node.offset) + "{}" + text.slice(node.offset + node.length))
  }
  const end = prop.offset + prop.length
  const next = props[index + 1]
  if (index === 0 && next) {
    const nextComma = findCommaAfter(text, end, next.offset)
    const cutEnd = nextComma >= 0 ? nextComma + 1 : end
    return assertParses(text.slice(0, node.offset + 1) + text.slice(cutEnd))
  }
  const prev = props[index - 1]!
  const prevEnd = prev.offset + prev.length
  if (next) {
    // Middle property: preserve the comma after `prev` and delete `prop` along with its own comma.
    const prevComma = findCommaAfter(text, prevEnd, prop.offset)
    const nextComma = findCommaAfter(text, end, next.offset)
    if (prevComma >= 0 && nextComma >= 0) {
      return assertParses(text.slice(0, prevComma + 1) + text.slice(nextComma + 1))
    }
    return assertParses(text.slice(0, prevEnd) + text.slice(end))
  }
  // Last property: remove the separator comma after `prev`, `prop`, and any trailing comma after `prop`.
  const trailingComma = findCommaAfter(text, end, node.offset + node.length - 1)
  const cutEnd = trailingComma >= 0 ? trailingComma + 1 : end
  return assertParses(text.slice(0, prevEnd) + text.slice(cutEnd))
}

/** Temp file plus rename, keeping the mode the target already had. */
export function writeFileAtomic(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  let existing: number | undefined
  try {
    existing = statSync(path).mode & 0o777
  } catch {
    existing = undefined
  }
  const target = existing ?? mode
  try {
    const fd = openSync(tmp, "w", target)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmp, target)
    renameSync(tmp, path)
    chmodSync(path, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // A temp file we cannot remove is not the failure worth reporting
    }
    throw err
  }
}
