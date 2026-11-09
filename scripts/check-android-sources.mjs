#!/usr/bin/env node
/**
 * Static gate for the Android app, which this repository cannot compile (no Android SDK,
 * and CI has none either). These are worth checking without a toolchain:
 *
 *  1. the source files the app cannot build without are actually present. `.gitignore` once
 *     matched `data/` anywhere in the tree and silently dropped the whole
 *     com.agentbot.app.data package from version control;
 *  2. every Kotlin file is balanced, i.e. no half-finished edit left an unterminated string,
 *     comment or brace block behind;
 *  3. a broad coroutine catch cannot swallow cancellation into the saved chat history
 *     (cancellationHygiene), because that write is not repairable on the next launch;
 *  4. a rejected access token is reported as a pairing problem, not as the server's
 *     `Authorization` header lesson (serverErrorMapping);
 *  5. the pairing key survives a paste artifact and rejects a wrong length with a message
 *     that names the field (pairingKeyGuard);
 *  6. the saved chat is encoded off the main thread and stays bounded
 *     (historyWriteHygiene), because a progress frame reaches that write several times a second;
 *  7. one gesture cannot pay for two Agent runs, and the chat's error banner only retries the
 *     thing that actually broke (taskControlHygiene);
 *  8. a duration is measured on the clock that stamped its start (serverClockHygiene), because
 *     the phone's clock and the bot's are never synced.
 *
 * Exits non-zero and prints file:line for the first problem in each file.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
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

/** Whole-stream reads on a stream receiver; a File receiver is fine, its size is already known. */
const UNBOUNDED_STREAM_READ = /\b(?:it|input|ins|stream)\s*\.\s*read(?:Bytes|AllBytes)\s*\(\s*\)/

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

/**
 * Two imports with the same simple name make the compiler reject every use of that name.
 * In practice this is not hypothetical: a UI file importing both `material3.Surface` and
 * the theme's `Surface` colour compiles as an ambiguity, and the theme import is easy to
 * miss while moving components around. Kotlin aliases (`... as DrawerSurface`) are the
 * intended escape hatch and are reported by their alias, so they stay unique.
 */
export function importCollision(path, source) {
  const seen = new Map()
  const problems = []
  for (const [index, line] of source.split("\n").entries()) {
    const match = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(line)
    if (!match) continue
    const name = match[2] ?? match[1].split(".").pop()
    const previous = seen.get(name)
    if (previous) {
      problems.push(`${path}:${index + 1}: import name '${name}' is already imported on line ${previous.line}`)
    } else {
      seen.set(name, { line: index + 1 })
    }
  }
  return problems
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
    for (const problem of signingMaterialIgnored(root)) problems.push(problem)
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    const error = balanceError(file, source)
    if (error) problems.push(error)
    for (const problem of importCollision(file, source)) problems.push(problem)
    for (const problem of cancellationHygiene(file, source)) problems.push(problem)
    for (const problem of serverErrorMapping(file, source)) problems.push(problem)
    for (const problem of pairingKeyGuard(file, source)) problems.push(problem)
    for (const problem of historyWriteHygiene(file, source)) problems.push(problem)
    for (const problem of taskControlHygiene(file, source)) problems.push(problem)
    for (const problem of serverClockHygiene(file, source)) problems.push(problem)
    // 应用源码不允许占位实现与裸打印：日志走 Log/Timber 类设施，未完成的功能不落地
    for (const [index, line] of source.split("\n").entries()) {
      if (/\bTODO\s*\(/.test(line)) problems.push(`${file}:${index + 1}: TODO() placeholder is not allowed`)
      if (/[^.\w]println\s*\(/.test(line)) problems.push(`${file}:${index + 1}: println() is not allowed (use a logger)`)
      // A content-URI stream is as large as whatever the user picked: readBytes() on one puts the
      // file and its Base64 on the heap before any limit can be reported, i.e. an OOM crash.
      if (UNBOUNDED_STREAM_READ.test(line)) {
        problems.push(`${file}:${index + 1}: reading a stream without a cap (see LocalStore.readCapped)`)
      }
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
 * A rejected access token must never surface the server's own 401 wording. That body explains
 * the `Authorization` header, which is true but useless in the App: every request carries one,
 * so a rejection can only mean the stored token went stale (rotated, or the bot was reinstalled
 * and regenerated it). About forty UI catch sites render `err.message` verbatim, so the rewrite
 * happens once, where the ApiException is built. This rule fails if a server status is thrown
 * without that mapping, or if the mapping itself loses the 401 case.
 */
export function serverErrorMapping(path, source) {
  const normalized = path.replace(/\\/g, "/")
  if (!normalized.endsWith("/data/ApiClient.kt")) return []
  const problems = []
  let maps401 = false
  for (const [index, line] of source.split("\n").entries()) {
    if (/ApiException\s*\(\s*res\.code\s*,/.test(line) && !/serverFailure\s*\(/.test(line)) {
      problems.push(`${path}:${index + 1}: build this message with serverFailure(), not the raw 401 body`)
    }
    if (/code == 401/.test(line) && /UNAUTHORIZED_HINT/.test(line)) maps401 = true
  }
  if (!maps401) problems.push(`${path}: HTTP 401 has to be mapped to UNAUTHORIZED_HINT`)
  return problems
}

/**
 * The pairing key is copied out of a Telegram code block, which tends to bring a line break
 * with it, so decoding has to drop whitespace first and then enforce the 32-byte length the
 * server stores. Without either, every request dies on the phone with 「Illegal base64
 * character a」 and nothing in the UI names the field that is broken.
 */
export function pairingKeyGuard(path, source) {
  const normalized = path.replace(/\\/g, "/")
  if (!normalized.endsWith("/data/ApiClient.kt")) return []
  const problems = []
  if (!/\.filterNot\s*\{\s*it\.isWhitespace\(\)\s*\}/.test(source)) {
    problems.push(`${path}: decode the pairing key after dropping whitespace, so a pasted line break cannot break every request`)
  }
  if (!/\.size\s*!=\s*32\b/.test(source)) {
    problems.push(`${path}: the pairing key has to be checked against the server's 32-byte length`)
  }
  return problems
}

/**
 * Everything the App stores lives in one SharedPreferences file, and every write re-serializes the
 * whole thing. The chat is rewritten on each SSE progress frame and the draft on each keystroke, so
 * neither may be encoded or committed on the caller's thread — and the writer has to stay alive, or
 * a value that arrives while it exits is lost before the next launch.
 */
export function historyWriteHygiene(path, source) {
  const normalized = path.replace(/\\/g, "/")
  // Comments mention the helpers the code must not call, so they are dropped before the scan.
  const code = source.replace(/\/\/.*$/gm, "")
  if (normalized.endsWith("/ui/AppViewModel.kt")) {
    const problems = []
    for (const [index, line] of code.split("\n").entries()) {
      if (/LocalStore\.(?:saveMessages|clearMessages)\s*\(/.test(line)) {
        problems.push(`${path}:${index + 1}: write the stored chat through persistMessages(), which is off Main`)
      }
    }
    // Each stored value has exactly one consumer, running on IO and fed by a conflated channel.
    for (const [helper, stream] of [["writeHistory", "historyWrites"], ["saveDraft", "draftWrites"]]) {
      const insideIo = new RegExp(`launch\\(Dispatchers\\.IO\\)[\\s\\S]{0,120}?for \\([\\w: ]+ in ${stream}\\)[\\s\\S]{0,200}?LocalStore\\.${helper}\\s*\\(`)
      if (!insideIo.test(source)) {
        problems.push(`${path}: LocalStore.${helper} has to run in the ${stream} consumer, on Dispatchers.IO`)
      }
      const calls = (code.match(new RegExp(`LocalStore\\.${helper}\\s*\\(`, "g")) ?? []).length
      if (calls !== 1) {
        problems.push(`${path}: LocalStore.${helper} is called ${calls} times; only the writer may store it`)
      }
    }
    if (!/Channel<List<ChatMessage>>\(Channel\.CONFLATED\)/.test(source)) {
      problems.push(`${path}: the chat writer has to consume a conflated channel, so a burst keeps the newest snapshot`)
    }
    if (!/historyWrites\.trySend\(/.test(source) || !/draftWrites\.trySend\(/.test(source)) {
      problems.push(`${path}: the Main-thread callers have to hand their value to the writers with trySend`)
    }
    return problems
  }
  if (normalized.endsWith("/data/LocalStore.kt")) {
    if (!/const val MAX_HISTORY_BYTES\b/.test(source)) {
      return [`${path}: cap the stored chat — SharedPreferences reads the whole value back on launch`]
    }
    return /\bbytes\s*>\s*MAX_HISTORY_BYTES\b/.test(source)
      ? []
      : [`${path}: drop the oldest rows once the stored chat passes MAX_HISTORY_BYTES`]
  }
  return []
}

/**
 * Actions that cost the user something — an Agent run, an upload — must not fire twice from one
 * gesture, and the chat's error banner has to retry the operation that actually broke. Both failures
 * were real: a second tap on 重试 posted a second non-idempotent /task/:id/retry (two complete cloud
 * runs for one press), and the banner's button replayed the newest task even for a local error such
 * as an attachment that could not be read.
 */
export function taskControlHygiene(path, source) {
  const normalized = path.replace(/\\/g, "/")
  const problems = []
  if (normalized.endsWith("/ui/AppViewModel.kt")) {
    const code = source.replace(/\/\/.*$/gm, "")
    for (const entry of ["retryTask", "retryRecord"]) {
      const body = new RegExp(`fun ${entry}\\(taskId: String\\) \\{([\\s\\S]*?)\\n    \\}`).exec(code)?.[1]
      if (!body) {
        problems.push(`${path}: ${entry} has to stay one function so its in-flight guard can be checked`)
        continue
      }
      if (!/retrying\.add\(taskId\)/.test(body)) {
        problems.push(`${path}: ${entry} may run twice for one tap — the server starts a new task per retry`)
      }
      if (!/finally \{\s*retrying\.remove\(taskId\)/.test(body)) {
        problems.push(`${path}: ${entry} must release its in-flight guard when the request ends`)
      }
    }
    if (/pendingAttachments = emptyList\(\)/.test(code)) {
      problems.push(`${path}: clear only the attachments a request actually carried, not the whole strip`)
    }
    if (!/if \(err\.code == 0 && networkFailures < MAX_LOCAL_POLL_RETRIES\)/.test(code)) {
      problems.push(`${path}: a reply this phone cannot read must not settle a task that is still running`)
    }
    if (!/toast = if \(stopped\.isEmpty\(\)\)/.test(code)) {
      problems.push(`${path}: /stop has to report what it stopped instead of always claiming it did`)
    }
    if (!/fun retryFromBanner\(\)/.test(code)) {
      problems.push(`${path}: the error banner needs a retry that knows which failure it is showing`)
    }
  }
  if (normalized.endsWith("/ui/ChatScreen.kt")) {
    if (!/onRetry = \{ vm\.retryFromBanner\(\) \}/.test(source)) {
      problems.push(`${path}: the banner's 重试 may not replay a task that did not fail`)
    }
    if (/LocalStore\.read\(/.test(source)) {
      problems.push(`${path}: read attachments through the ViewModel, which does it off the main thread`)
    }
    if (!/cameraPermission\.launch\(Manifest\.permission\.CAMERA\)/.test(source)) {
      problems.push(`${path}: ACTION_IMAGE_CAPTURE needs the CAMERA permission this app declares`)
    }
  }
  return problems
}

/**
 * Elapsed labels are built from timestamps the server wrote (task `startedAt`, `usage.lastAt`,
 * a history row's time) but were previously measured against the phone's own clock, which is
 * never synced with it. A device an hour behind rendered a task that started minutes ago as
 * 「已运行 0 秒」 and a peer session as active now: the App looked hung rather than skewed.
 * ApiClient therefore keeps an offset from the `Date` header of every answered request, and each
 * screen reads the server's clock through `vm.serverNow()`.
 */
export function serverClockHygiene(path, source) {
  const problems = []
  const normalized = path.replace(/\\/g, "/")
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  if (normalized.endsWith("/data/ApiClient.kt")) {
    if (!/var clockOffsetMs: Long = 0L/.test(code)) {
      problems.push(`${path}: the server clock offset has to be kept, or elapsed labels trust the phone's clock`)
    }
    if (!/fun serverNow\(\): Long = System\.currentTimeMillis\(\) \+ clockOffsetMs/.test(code)) {
      problems.push(`${path}: serverNow() is the only reading of the server's clock the screens may use`)
    }
    if (!/DateTimeFormatter\.RFC_1123_DATE_TIME/.test(code)) {
      problems.push(`${path}: read the offset from the HTTP Date header, the one header every answer carries`)
    }
    if (!/observeServerClock\(res\)/.test(code)) {
      problems.push(`${path}: every JSON response has to refresh the clock offset, not just the first`)
    }
    if (!/if \(kotlin\.math\.abs\(delta\) < DAY_MS\) clockOffsetMs = delta/.test(code)) {
      problems.push(`${path}: a proxy with a broken clock must not move the labels it is meant to fix`)
    }
  }
  const ticking = {
    // ChatScreen keeps a local stopwatch for the recorder, which is the phone's own business and
    // measured the right way; its server-clock rule is the positive one below.
    "/ui/ChatScreen.kt": { pattern: /private fun RunningLine\([\s\S]{0,80}?\{\s*var now by remember \{ mutableStateOf\(vm\.serverNow\(\)\) \}/, banDeviceClock: false },
    "/ui/ListScreens.kt": { pattern: /private fun rememberClock\(vm: AppViewModel\)[\s\S]{0,200}?vm\.serverNow\(\)/, banDeviceClock: true },
    "/ui/SessionScreen.kt": { pattern: /vm\.serverNow\(\)/, banDeviceClock: true },
    "/ui/StatusScreen.kt": { pattern: /vm\.serverNow\(\)/, banDeviceClock: true },
  }
  for (const [suffix, rule] of Object.entries(ticking)) {
    if (!normalized.endsWith(suffix)) continue
    if (!rule.pattern.test(code)) {
      problems.push(`${path}: elapsed labels have to tick on the server's clock (vm.serverNow())`)
    }
    if (rule.banDeviceClock && /System\.currentTimeMillis\(\)/.test(code)) {
      problems.push(`${path}: nothing in this screen may read the phone's clock; label durations come from vm.serverNow()`)
    }
  }
  return problems
}

/**
 * A cancelled coroutine must not read as a failed request. AppViewModel writes the saved chat
 * from its catch blocks, and swallowing CancellationException there stamps
 * 「任务查询中断：The job has been cancelled」 onto a bubble that is still running server-side.
 * The launch-time resume only re-attaches to queued/running rows, so that write loses the real
 * answer for good. Every broad catch that touches persisted chat state therefore has to be
 * preceded, in the same try chain, by a CancellationException clause that rethrows.
 */
export function cancellationHygiene(path, source) {
  const lines = source.split("\n")
  const problems = []
  const broadCatch = /^(\s*)\} catch \((?:\w+|_): (?:Exception|Throwable)\b/
  const anyCatch = /^(\s*)\} catch \((?:\w+|_): ([\w<>?]+)\b/
  const writesChat = /\b(?:updateMessage|persistMessages)\s*\(/
  for (const [index, line] of lines.entries()) {
    const caught = broadCatch.exec(line)
    if (!caught) continue
    const indent = caught[1]
    let writes = false
    for (let j = index + 1; j < lines.length; j++) {
      if (lines[j].startsWith(`${indent}}`)) break
      if (writesChat.test(lines[j])) {
        writes = true
        break
      }
    }
    if (!writes) continue
    let rethrown = false
    for (let j = index - 1; j >= 0; j--) {
      if (lines[j].startsWith(`${indent}try {`)) break
      const sibling = anyCatch.exec(lines[j])
      if (sibling?.[1] === indent && sibling[2] === "CancellationException") {
        rethrown = true
        break
      }
    }
    if (!rethrown) {
      problems.push(`${path}:${index + 1}: this catch writes the saved chat but does not rethrow CancellationException`)
    }
  }
  return problems
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

/**
 * Signing material must never be committed. The docs tell operators to create
 * android/keystore.properties and may place a .jks next to it; a missing ignore rule would
 * put the release private key and its password in the repository.
 */
export function signingMaterialIgnored(root, cwd = process.cwd()) {
  const candidates = ["keystore.properties", "release.jks", "release.keystore"]
  // `root` is the Kotlin source root (.../android/app/src/main/java). Walk up until the
  // directory holding build.gradle.kts, instead of guessing a fixed number of levels.
  let androidDir = root
  while (!existsSync(join(androidDir, "app", "build.gradle.kts")) && androidDir !== dirname(androidDir)) {
    androidDir = dirname(androidDir)
  }
  if (!existsSync(join(androidDir, "app", "build.gradle.kts"))) return []
  const probes = candidates.map((name) => join(androidDir, name))
  const relativeProbes = probes.map((probe) => relative(cwd, probe))
  // --no-index asks the ignore rules even for paths that do not exist yet, which is
  // exactly the state before a developer creates the keystore.
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd, input: relativeProbes.join("\n"), encoding: "utf8" })
  if (result.error || result.status === 128) return []
  const ignored = new Set((result.stdout ?? "").split("\n").filter(Boolean))
  return probes.flatMap((probe, index) =>
    ignored.has(relativeProbes[index]) ? [] : [`${probe} is not ignored by .gitignore; release signing material must never be committed`],
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)))
