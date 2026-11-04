#!/usr/bin/env node
/**
 * Static gate for the Android app, which this repository cannot compile (no Android SDK,
 * and CI has none either). Two things are worth checking without a toolchain:
 *
 *  1. the source files the app cannot build without are actually present. `.gitignore` once
 *     matched `data/` anywhere in the tree and silently dropped the whole
 *     com.agentbot.app.data package from version control;
 *  2. every Kotlin file is balanced, i.e. no half-finished edit left an unterminated string,
 *     comment or brace block behind.
 *
 * Exits non-zero and prints file:line for the first problem in each file.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const ROOT_FLAG = "--root"
const SKIP_MANIFEST_FLAG = "--skip-manifest"

/** Files the app does not build without; a checkout missing one of these is broken. */
const REQUIRED = [
  "com/agentbot/app/MainActivity.kt",
  "com/agentbot/app/data/ApiClient.kt",
  "com/agentbot/app/data/ApiModels.kt",
  "com/agentbot/app/data/LocalStore.kt",
  "com/agentbot/app/data/SettingsRepository.kt",
  "com/agentbot/app/data/TaskNotifier.kt",
  "com/agentbot/app/ui/AppViewModel.kt",
  "com/agentbot/app/ui/ChatScreen.kt",
  "com/agentbot/app/ui/SlashCommands.kt",
]

const PAIRS = { ")": "(", "]": "[", "}": "{" }

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else if (entry.endsWith(".kt")) found.push(path)
  }
  return found.sort()
}

/**
 * Balances brackets while skipping comments, character and string literals (raw strings
 * included) and backtick identifiers. Anything inside a literal is data, not syntax.
 */
export function balanceError(path, src) {
  const n = src.length
  const stack = []
  let line = 1
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === "\n") {
      line += 1
      i += 1
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i)
      i = nl < 0 ? n : nl
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (src.startsWith("/*", i)) {
          depth += 1
          i += 2
        } else if (src.startsWith("*/", i)) {
          depth -= 1
          i += 2
        } else {
          if (src[i] === "\n") line += 1
          i += 1
        }
      }
      if (depth > 0) return `${path}:${line}: unterminated block comment`
      continue
    }
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3)
      if (end < 0) return `${path}:${line}: unterminated raw string`
      for (let k = i + 3; k < end; k += 1) if (src[k] === "\n") line += 1
      i = end + 3
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const kind = c === '"' ? "string literal" : c === "'" ? "character literal" : "backtick identifier"
      const startLine = line
      i += 1
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          if (src[i + 1] === "\n") line += 1
          i += 2
          continue
        }
        if (src[i] === "\n") line += 1
        i += 1
      }
      if (i >= n) return `${path}:${startLine}: unterminated ${kind}`
      i += 1
      continue
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push([c, line])
    } else if (c in PAIRS) {
      const opener = stack.pop()
      if (!opener) return `${path}:${line}: unmatched ${c}`
      if (opener[0] !== PAIRS[c]) return `${path}:${line}: ${c} closes ${opener[0]} opened on line ${opener[1]}`
    }
    i += 1
  }
  if (stack.length > 0) {
    const [opener, openerLine] = stack[stack.length - 1]
    return `${path}:${openerLine}: unclosed ${opener}`
  }
  return null
}

function main(argv) {
  const rootIndex = argv.indexOf(ROOT_FLAG)
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : "android/app/src/main/java"
  const skipManifest = argv.includes(SKIP_MANIFEST_FLAG)
  const problems = []

  if (!existsSync(root)) {
    console.error(`android source root missing: ${root}`)
    return 1
  }
  if (!skipManifest) {
    for (const relative of REQUIRED) {
      if (!existsSync(join(root, relative))) problems.push(`missing required source file: ${root}/${relative}`)
    }
  }

  const files = walk(root)
  if (!skipManifest) {
    for (const problem of swallowedByGitignore(root, files)) problems.push(problem)
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    const error = balanceError(file, source)
    if (error) problems.push(error)
    // 应用源码不允许占位实现与裸打印：日志走 Log/Timber 类设施，未完成的功能不落地
    for (const [index, line] of source.split("\n").entries()) {
      if (/\bTODO\s*\(/.test(line)) problems.push(`${file}:${index + 1}: TODO() placeholder is not allowed`)
      if (/[^.\w]println\s*\(/.test(line)) problems.push(`${file}:${index + 1}: println() is not allowed (use a logger)`)
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`android sources: ${problems.length} problem(s) in ${files.length} Kotlin file(s)`)
    return 1
  }
  console.log(`android sources ok: ${files.length} Kotlin file(s)`)
  return 0
}

/**
 * A `.gitignore` rule that matches a source directory keeps those files out of every
 * checkout while they stay on the developer's disk — that is how the whole
 * com.agentbot.app.data package once vanished from this repository. Ignored sources fail the
 * check; sources that are merely not staged yet are only reported.
 */
function swallowedByGitignore(root, files) {
  const ignored = spawnSync("git", ["check-ignore", "--stdin"], { input: files.join("\n"), encoding: "utf8" })
  if (ignored.error || ignored.status === 128) return []
  const matched = new Set((ignored.stdout ?? "").split("\n").filter(Boolean))
  const problems = files.filter((file) => matched.has(file)).map((file) => `${file} is ignored by .gitignore, so it is not in the repository`)
  const others = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "--", root], { encoding: "utf8" })
  for (const file of (others.stdout ?? "").split("\n").filter((line) => line.endsWith(".kt"))) {
    console.warn(`note: ${file} is not committed yet`)
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)))
