import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

import { BOT_COMMAND_ALIASES, BOT_MENU_COMMANDS } from "../src/help.js"
import { loadConfig } from "../src/config.js"
import { pairingQrPayload, resolvePairingUrl } from "../src/api.js"
import { appModelFields, tsInterfaceMemberFields, tsInterfaceFields, tsUnionFields } from "./support/appModels.js"
import { appRequestUrl, normalizeAppBaseUrl } from "./support/appBaseUrl.js"
import { appClockOffsetFrom, appServerNow } from "./support/appClock.js"
import { capHistory } from "./support/appHistory.js"

/**
 * The Android App answers a typed "/" line from a table it keeps in Kotlin. These checks
 * keep that table aligned with the bot's own command list, so a new Telegram command can
 * never be silently missing from the App (and the App cannot invent one the bot lacks).
 */
const SLASH_SOURCE = "android/app/src/main/java/com/agentbot/app/ui/SlashCommands.kt"

function slashSource(): string {
  assert.ok(existsSync(SLASH_SOURCE), `${SLASH_SOURCE} is missing, so the App's command table cannot be checked`)
  return readFileSync(SLASH_SOURCE, "utf8")
}

function appCommandTable(source: string): string[] {
  const block = /internal val SLASH_COMMANDS = setOf\(([\s\S]*?)\)/.exec(source)?.[1]
  assert.ok(block, "SLASH_COMMANDS must stay one setOf(...) literal in SlashCommands.kt")
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
}

function appCommandBody(source: string): string {
  const body = /internal fun applySlashCommand[\s\S]*?\n}\n/.exec(source)?.[0]
  assert.ok(body, "applySlashCommand must stay a top-level function in SlashCommands.kt")
  return body
}

test("the App answers exactly the commands the bot lists", () => {
  const handled = appCommandTable(slashSource())
  const names = BOT_MENU_COMMANDS.map((item) => item.command)

  assert.deepEqual(
    names.filter((name) => !handled.includes(name)),
    [],
    `the App has no entry for: ${names.filter((name) => !handled.includes(name)).join(", ")}`,
  )
  assert.deepEqual(
    handled.filter((name) => !names.includes(name)),
    [],
    `the App table lists words the bot does not answer: ${handled.filter((name) => !names.includes(name)).join(", ")}`,
  )
  assert.equal(new Set(handled).size, handled.length, "the App table must not repeat a command")

  // Aliases resolve to their target before the App's table is consulted
  for (const target of Object.values(BOT_COMMAND_ALIASES)) {
    assert.ok(handled.includes(target), `/${target} (an alias target) needs an App entry`)
  }
})

test("every command in the App table has a branch, not just a name", () => {
  const body = appCommandBody(slashSource())
  const unhandled = appCommandTable(slashSource()).filter((name) => !body.includes(`"${name}"`))
  assert.deepEqual(unhandled, [], `no branch runs for: ${unhandled.join(", ")}`)
})

/**
 * The sandbox has no Android SDK, so nothing compiles the App's Kotlin. Every screen drives
 * one ViewModel, so checking that each `vm.x` the sources name is really declared there
 * catches what a compiler would have: renamed, mis-typed or invented members.
 */
const UI_DIR = "android/app/src/main/java/com/agentbot/app/ui"
const VIEWMODEL_SOURCE = `${UI_DIR}/AppViewModel.kt`

function viewModelMembers(): Set<string> {
  const source = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const members = new Set<string>()
  for (const match of source.matchAll(/^\s*(?:@\w+\s+)?(?:\s*(?:suspend|private|internal|open|override))*\s*(?:fun|val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    members.add(match[1]!)
  }
  return members
}

/** Strips line comments, so prose that mentions `vm.something` cannot fail the scan. */
function referencedMembers(source: string): string[] {
  const found: string[] = []
  for (const line of source.split("\n")) {
    const code = line.replace(/\/\/.*$/, "")
    for (const match of code.matchAll(/\bvm\.([A-Za-z_][A-Za-z0-9_]*)/g)) found.push(match[1]!)
  }
  return [...new Set(found)]
}

test("the App only calls ViewModel members that exist", () => {
  const members = viewModelMembers()
  assert.ok(members.size > 100, "the ViewModel scan must find its declarations")
  const screens = readdirSync(UI_DIR).filter((name) => name.endsWith(".kt")).sort()
  assert.ok(screens.length > 10, "the scan must cover the screen files, not an empty directory")
  const missing = screens
    .map((name) => [name, referencedMembers(readFileSync(`${UI_DIR}/${name}`, "utf8")).filter((ref) => !members.has(ref))] as const)
    .filter(([, refs]) => refs.length > 0)
    .map(([name, refs]) => `${name}: ${refs.join(", ")}`)
  assert.deepEqual(missing, [], `AppViewModel has no such members:\n${missing.join("\n")}`)
})

/**
 * The App can only reach what ApiClient.kt names, and the bot only answers what api.ts
 * routes. No compiler looks across that boundary, so these scans keep the two lists aligned:
 * a path the App calls that the server no longer routes fails here, and a server capability
 * with no App caller has to be listed as deliberate below.
 */
const API_SOURCE = "src/api.ts"
const CLIENT_SOURCE = "android/app/src/main/java/com/agentbot/app/data/ApiClient.kt"
const LOCALSTORE_SOURCE = "android/app/src/main/java/com/agentbot/app/data/LocalStore.kt"

/**
 * Routes kept for other API consumers, not the App. `tasks` used to be one of them: the phone
 * had `queue` and `history`, but only `tasks` hands back a settled run with its real prompt and
 * an id, which is what the queue screen's 重试 needs to replay attachments like Telegram's /retry.
 */
const NOT_IN_APP: string[] = []

function serverResources(): string[] {
  const source = readFileSync(API_SOURCE, "utf8")
  return [...source.matchAll(/\bresource === "([a-z][a-z0-9-]*)"/g)].map((match) => match[1]!)
}

function clientResources(): string[] {
  const source = readFileSync(CLIENT_SOURCE, "utf8")
  // "/task", "/cc/exec", "/history?limit=$limit", "/task/$id/stop": the first segment is the resource
  return [...source.matchAll(/"(\/[a-z][a-z0-9-]*)/g)].map((match) => match[1]!.slice(1))
}

test("the App calls exactly the endpoint groups the server routes", () => {
  const server = new Set(serverResources())
  const client = new Set(clientResources().filter((name) => name !== "api"))
  assert.ok(server.size > 20, "the server scan must find the router's resources")
  assert.ok(client.size > 20, "the client scan must find ApiClient's paths, not an empty set")

  const unknown = [...client].filter((name) => !server.has(name)).sort()
  assert.deepEqual(unknown, [], `ApiClient calls paths the bot does not route: ${unknown.join(", ")}`)

  const unconsumed = [...server].filter((name) => !client.has(name)).sort()
  assert.deepEqual(
    unconsumed,
    [...NOT_IN_APP].sort(),
    `unrouted-or-unused server resources changed; update NOT_IN_APP with a reason:\n${unconsumed.join(", ")}`,
  )
})

/**
 * The live driver is what proves the App decodes what the server answers, so an endpoint the
 * driver never calls must not look covered. Both sides reduce to the static head of each path,
 * because `$id` segments and query strings carry nothing comparable.
 */
const DRIVER_SOURCE = "tests/appContract.test.ts"

function pathHeads(source: string): string[] {
  // Comments mention endpoints the code does not call (`/id`, `/retry`), so they are dropped
  // before the scan — otherwise the gate complains about prose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  return [...code.matchAll(/["`](\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)/g)]
    .map((match) => match[1]!)
    // `/api` and `/api/v1` are the prefix every path is built on (and what normalizeBaseUrl
    // strips from a pasted address), never endpoints of their own.
    .filter((path) => !/^\/api(\/|$)/.test(path))
}

test("the live driver probes every endpoint ApiClient calls", () => {
  const client = [...new Set(pathHeads(readFileSync(CLIENT_SOURCE, "utf8")))]
  const driven = pathHeads(readFileSync(DRIVER_SOURCE, "utf8"))
  assert.ok(client.length > 40, `the ApiClient scan must find its endpoint paths, found ${client.length}`)
  const uncovered = client.filter((path) => !driven.some((probe) => probe.startsWith(path) || path.startsWith(probe))).sort()
  assert.deepEqual(uncovered, [], `appContract.test.ts never calls: ${uncovered.join(", ")}`)
})

/**
 * These pairs are the payloads both sides type by hand. `tests/support/appModels.ts` reads
 * the App's Kotlin models, which is also where the live API tests check their responses.
 */
test("the App's models decode exactly the fields the server sends", () => {
  const sources = {
    "src/usage.ts": readFileSync("src/usage.ts", "utf8"),
    "src/history.ts": readFileSync("src/history.ts", "utf8"),
    "src/apiTaskTypes.ts": readFileSync("src/apiTaskTypes.ts", "utf8"),
  }
  const day = tsInterfaceFields(sources, "UsageDay")
  const cases: Array<[kotlin: string, server: Set<string>]> = [
    ["UsageDay", day],
    // /usage sends UsageSummary (UsageDay + lastAt/lastEngine/lastModel + today + engines)
    ["Usage", new Set([...tsInterfaceFields(sources, "UsageSummary"), ...day])],
    // /usage's trend rows are `UsageDay & { day }`
    ["UsageTrendDay", new Set([...day, "day"])],
    ["HistoryEntry", tsInterfaceFields(sources, "HistoryEntry")],
    // TaskManager.view() is typed against these, so they are the wire contract for the
    // App's whole task lifecycle: polling, progress, the reply and its media cards.
    ["Task", tsInterfaceFields(sources, "ApiTaskView")],
    ["TaskMedia", tsInterfaceFields(sources, "ApiTaskMediaView")],
  ]
  for (const [kotlin, server] of cases) {
    const app = appModelFields(kotlin)
    assert.ok(server.size >= 2 && app.size >= 2, `${kotlin} must be scanned on both sides, not skipped`)
    assert.deepEqual(
      [...app].filter((field) => !server.has(field)).sort(),
      [],
      `${kotlin} decodes fields the server never sends`,
    )
    assert.deepEqual(
      [...server].filter((field) => !app.has(field)).sort(),
      [],
      `the server sends ${kotlin} fields the App silently drops`,
    )
  }
})

/**
 * The nested rows of `/ops/diag` and of a repeating schedule. A live test can only compare what
 * the machine it runs on produced: without a `git` binary the diagnostics answer has no `git`
 * key, and a filesystem that refuses `statfs` answers without `disk`, so the App's half of those
 * models goes over the wire never checked. Their field names come from the server's own type
 * declarations here, which is the same contract and never absent.
 */
test("the App's diagnostics and repeat models match the server's declarations", () => {
  const ops = { "src/ops.ts": readFileSync("src/ops.ts", "utf8") }
  const reminders = { "src/reminders.ts": readFileSync("src/reminders.ts", "utf8") }
  const cases: Array<[kotlin: string, server: Set<string>]> = [
    ["GitInfo", tsInterfaceMemberFields(ops, "OpsDiagnostics", "git")],
    ["DiskInfo", tsInterfaceMemberFields(ops, "OpsDiagnostics", "disk")],
    ["MemoryInfo", tsInterfaceMemberFields(ops, "OpsDiagnostics", "memory")],
    ["FileInfo", tsInterfaceMemberFields(ops, "OpsDiagnostics", "log")],
    ["CcSwitchInfo", tsInterfaceMemberFields(ops, "OpsDiagnostics", "ccSwitch")],
    // One Kotlin model for both arms of the union: `interval` fills ms, `daily` fills hour/minute.
    ["Repeat", tsUnionFields(reminders, "ReminderRepeat")],
  ]
  for (const [kotlin, server] of cases) {
    const app = appModelFields(kotlin)
    assert.ok(server.size >= 2, `${kotlin} must be scanned against real fields, got ${[...server].join(", ")}`)
    assert.deepEqual([...server].filter((f) => !app.has(f)).sort(), [], `the server sends ${kotlin} fields the App never decodes`)
    assert.deepEqual([...app].filter((f) => !server.has(f)).sort(), [], `${kotlin} decodes fields the server never declares`)
  }
})

/**
 * `npm run check` also runs the Android source gate, which stands in for a compiler the
 * sandbox does not have. A gate nobody can prove works is worse than none, so these checks
 * aim it at a throwaway tree and require it to pass clean Kotlin and reject broken Kotlin.
 */
const ANDROID_CHECKER = "scripts/check-android-sources.mjs"

function runChecker(root: string): { status: number | null; output: string } {
  const res = spawnSync(process.execPath, [ANDROID_CHECKER, "--root", root, "--skip-manifest"], { encoding: "utf8" })
  return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

test("the Android source gate accepts clean Kotlin and rejects broken Kotlin", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-android-"))
  try {
    const pkg = join(dir, "com/agentbot/app/ui")
    mkdirSync(pkg, { recursive: true })
    const clean = [
      "package com.agentbot.app.ui",
      "",
      "// an apostrophe in a comment: don't break the scanner",
      "/* a block comment with } and ] inside */",
      "fun panel(): String = \"\"\"",
      "   unmatched { [ ( inside a raw string",
      "\"\"\"",
      "val pairs = listOf('(', ')')",
      "fun screen(title: String) = Text(title)",
      "",
    ].join("\n")
    writeFileSync(join(pkg, "Good.kt"), clean)
    assert.equal(runChecker(dir).status, 0, `clean Kotlin must pass:\n${runChecker(dir).output}`)

    writeFileSync(join(pkg, "Broken.kt"), "package com.agentbot.app.ui\n\nfun oops() {\n  val xs = listOf(1, 2\n}\n")
    const broken = runChecker(dir)
    assert.equal(broken.status, 1, "a missing closing bracket must fail the gate")
    assert.match(broken.output, /Broken\.kt:\d+: \} closes \(/)

    writeFileSync(join(pkg, "Broken.kt"), 'package com.agentbot.app.ui\n\nval s = "unterminated\n')
    const unterminated = runChecker(dir)
    assert.equal(unterminated.status, 1, "an unterminated string must fail the gate")
    assert.match(unterminated.output, /unterminated string literal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the Android source gate passes against the real tree", () => {
  const res = spawnSync(process.execPath, [ANDROID_CHECKER], { encoding: "utf8" })
  assert.equal(res.status, 0, `${res.stdout ?? ""}${res.stderr ?? ""}`)
  assert.match(`${res.stdout}`, /android sources ok/)
})

/**
 * Pairing is the App's first network moment and both sides type it by hand: the bot writes
 * `{url, token, enc}` into a QR, the settings screen reads those names back. A rename on either
 * side still scans "fine" and leaves the App with a blank address, so the two key lists are tied.
 */
const SETTINGS_SOURCE = "android/app/src/main/java/com/agentbot/app/ui/SettingsScreen.kt"

test("the pairing QR carries exactly the keys the App's scanner reads", () => {
  const scanner = readFileSync(SETTINGS_SOURCE, "utf8")
  const read = [...scanner.matchAll(/\bobj\["([a-z]+)"\]/g)].map((match) => match[1]!).sort()
  assert.deepEqual(read, ["enc", "token", "url"], "the App's QR scanner reads these keys")

  const key = Buffer.alloc(32, 3).toString("base64")
  assert.deepEqual(Object.keys(pairingQrPayload("http://192.168.1.10:3080", "tok")).sort(), ["token", "url"])
  assert.deepEqual(Object.keys(pairingQrPayload("http://192.168.1.10:3080", "tok", key)).sort(), ["enc", "token", "url"])
})

/**
 * The App appends `/api/v1` to whatever it is given, so an address without a host — the shape the
 * old `/api` QR carried whenever API_BIND stayed a placeholder — cannot ever connect. `resolvePairingUrl`
 * is the single answer to "what should the phone dial", and it must stay silent rather than guess.
 */
test("the address handed to the App can actually be dialed", () => {
  const cfg = (env: Record<string, string> = {}) =>
    loadConfig({ TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_ALLOW_USERS: "1", ...env })

  assert.equal(resolvePairingUrl(cfg()), undefined, "a loopback bind tells the phone nothing")
  assert.equal(resolvePairingUrl(cfg({ API_BIND: "0.0.0.0" })), undefined, "a wildcard bind is not an address")
  assert.equal(resolvePairingUrl(cfg({ API_BIND: "192.168.1.10" })), "http://192.168.1.10:3080")
  assert.equal(resolvePairingUrl(cfg({ API_BIND: "fd00::1" })), "http://[fd00::1]:3080", "IPv6 needs brackets")
  assert.equal(
    resolvePairingUrl(cfg({ API_BIND: "0.0.0.0", API_PUBLIC_URL: "https://bot.example.com" })),
    "https://bot.example.com",
    "behind a proxy the bind is useless, which is what API_PUBLIC_URL is for",
  )

  // What the QR carries must be a URL the App accepts unchanged: no path, and no empty host
  for (const url of [
    resolvePairingUrl(cfg({ API_BIND: "192.168.1.10" }))!,
    resolvePairingUrl(cfg({ API_PUBLIC_URL: "https://bot.example.com" }))!,
  ]) {
    const parsed = new URL(url)
    assert.notEqual(parsed.hostname, "")
    assert.equal(parsed.pathname, "/")
  }
})

/**
 * The App's quietest data loss: leaving the Activity cancels an in-flight poll, and if that
 * cancellation is caught as a request error the bubble is written to the saved chat as
 * 「任务查询中断」. The resume on next launch only re-attaches to queued/running rows, so the real
 * answer never comes back. The source gate has to keep that shape out of AppViewModel.
 */
test("the Android source gate rejects a chat-writing catch that swallows cancellation", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-cancel-"))
  const head = ["package com.agentbot.app.ui", ""]
  const violation = [
    ...head,
    "private fun pollTask(id: String) = viewModelScope.launch {",
    "    try {",
    "        pollTaskLoop(id)",
    "    } catch (err: Exception) {",
    '        updateMessage(id) { it.copy(status = "failed") }',
    "    }",
    "}",
    "",
  ].join("\n")
  try {
    const pkg = join(dir, "com/agentbot/app/ui")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "Bad.kt"), violation)
    const bad = runChecker(dir)
    assert.equal(bad.status, 1, "cancellation written into the saved chat must fail the gate")
    assert.match(bad.output, /Bad\.kt:\d+:.*CancellationException/)

    const fixed = violation.replace(
      "    } catch (err: Exception) {",
      "    } catch (err: CancellationException) {\n        throw err\n    } catch (err: Exception) {",
    )
    writeFileSync(join(pkg, "Bad.kt"), fixed)
    const passed = runChecker(dir)
    assert.equal(passed.status, 0, `a rethrowing chain must pass:\n${passed.output}`)

    // a broad catch that only paints a transient banner does not corrupt stored state
    writeFileSync(
      join(pkg, "Bad.kt"),
      [
        ...head,
        "private fun guarded(label: String) = viewModelScope.launch {",
        "    try {",
        "        block()",
        "    } catch (err: Exception) {",
        "        connectionError = label",
        "    }",
        "}",
        "",
      ].join("\n"),
    )
    const banner = runChecker(dir)
    assert.equal(banner.status, 0, `a banner-only catch must not be flagged:\n${banner.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Picking a video or a disk image used to hand readBytes() a stream of unknown length: the file
 * and its Base64 both land on the heap, so the 15MB limit was reported only after the process had
 * been killed. The gate keeps that idiom out of the App.
 */
test("the Android source gate rejects an uncapped stream read", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-stream-"))
  try {
    const pkg = join(dir, "com/agentbot/app/data")
    mkdirSync(pkg, { recursive: true })
    const violation = [
      "package com.agentbot.app.data",
      "",
      "fun load(resolver: android.content.ContentResolver, uri: android.net.Uri): ByteArray =",
      "    resolver.openInputStream(uri)!!.use { it.readBytes() }",
      "",
    ].join("\n")
    writeFileSync(join(pkg, "Bad.kt"), violation)
    const bad = runChecker(dir)
    assert.equal(bad.status, 1, "an uncapped stream read must fail the gate")
    assert.match(bad.output, /Bad\.kt:\d+:.*without a cap/)

    const capped = [
      "package com.agentbot.app.data",
      "",
      "fun load(resolver: android.content.ContentResolver, uri: android.net.Uri, limit: Int): ByteArray =",
      "    resolver.openInputStream(uri)!!.use { readCapped(it, limit) }",
      "",
    ].join("\n")
    writeFileSync(join(pkg, "Bad.kt"), capped)
    const passed = runChecker(dir)
    assert.equal(passed.status, 0, `a capped read must pass:\n${passed.output}`)

    // a File receiver already knows its size; sharing cached bytes out of it is not the bug
    writeFileSync(
      join(pkg, "Bad.kt"),
      [
        "package com.agentbot.app.data",
        "",
        "fun cached(name: java.io.File): ByteArray? = name.takeIf { it.isFile }?.readBytes()",
        "",
      ].join("\n"),
    )
    const fileRead = runChecker(dir)
    assert.equal(fileRead.status, 0, `a File read must not be flagged:\n${fileRead.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The steps `ApiFormat.normalizeBaseUrl` runs, pinned as literal source. The rule decides whether
 * the address a user pastes works at all, and it cannot be executed here (it lives in Kotlin), so
 * the mirror in tests/support/appBaseUrl.ts is what the table below runs — and it is only evidence
 * as long as these steps still describe the shipped function.
 */
const BASE_URL_STEPS = [
  'if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://$value"',
  "value = value.trimEnd('/')",
  'val stripped = value.removeSuffix("/api/v1").removeSuffix("/api")',
  'private val HOST_WITH_PATH: Regex = Regex("https?://[^/]+(/[^/]+)*$")',
  "return if (HOST_WITH_PATH.matches(stripped)) stripped else value",
]

test("the App's pasted-address rule keeps a reverse-proxy subpath", () => {
  const client = readFileSync(CLIENT_SOURCE, "utf8")
  for (const step of BASE_URL_STEPS) {
    assert.ok(client.includes(step), `normalizeBaseUrl no longer matches its mirror:\n${step}`)
  }
  const health = (pasted: string): string => appRequestUrl(normalizeAppBaseUrl(pasted), "/health")
  // Every form the README promises to recognize
  assert.equal(health("1.2.3.4:3080"), "http://1.2.3.4:3080/api/v1/health")
  assert.equal(health("agent-bot.example.com"), "http://agent-bot.example.com/api/v1/health")
  for (const pasted of ["http://IP:3080/api/v1", "http://IP:3080/api", "http://IP:3080/api/v1/", "  http://IP:3080/api/  "]) {
    assert.equal(health(pasted), "http://IP:3080/api/v1/health", pasted)
  }
  // `/api` prints `${API_PUBLIC_URL}/api/v1`. A bot mounted behind a proxy at a subpath keeps
  // that prefix, so pasting the printed line has to land on the subpath's endpoint — dropping it
  // to the origin (or doubling it) meant 404 on every screen of the App.
  for (const pasted of ["https://example.com/agent-bot/api/v1", "https://example.com/agent-bot"]) {
    assert.equal(health(pasted), "https://example.com/agent-bot/api/v1/health", pasted)
  }
  assert.equal(
    appRequestUrl(normalizeAppBaseUrl("https://host:8443/bot/api/v1"), "/task"),
    "https://host:8443/bot/api/v1/task",
  )
  // The QR carries resolvePairingUrl's output (API_PUBLIC_URL verbatim), so scanning must
  // leave it untouched
  const qr = pairingQrPayload("https://example.com/agent-bot", "t0", "a2V5")
  assert.equal(qr.url, "https://example.com/agent-bot")
  assert.equal(normalizeAppBaseUrl(qr.url), qr.url)
  // The whole documented chain, end to end: the operator's API_PUBLIC_URL has to survive
  // loadConfig (it used to refuse any path, so this deployment could not start and the subpath
  // support above was unreachable), reach the phone as the line /api prints, and land back on the
  // subpath's endpoint when pasted into the App.
  const mounted = resolvePairingUrl(
    loadConfig({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_ALLOW_USERS: "7",
      API_PUBLIC_URL: "https://example.com/agent-bot",
    }),
  )
  assert.equal(mounted, "https://example.com/agent-bot")
  assert.equal(health(`${mounted}/api/v1`), "https://example.com/agent-bot/api/v1/health")
  assert.equal(appRequestUrl(normalizeAppBaseUrl(mounted), "/health"), "https://example.com/agent-bot/api/v1/health")
  // A fragment that would strip down to nothing but a scheme is kept as typed
  assert.equal(normalizeAppBaseUrl("http://api"), "http://api")
  assert.equal(normalizeAppBaseUrl(""), "")
})

/**
 * The steps `ApiClient.observeServerClock` runs, pinned as literal source: durations and "…前"
 * labels are measured against the clock that stamped `startedAt`, not the phone's, and that rule
 * only exists in Kotlin. The mirror in tests/support/appClock.ts is what the cases below run.
 */
const SERVER_CLOCK_STEPS = [
  'val header = res.header("Date") ?: return',
  "java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME",
  "val delta = millis - System.currentTimeMillis()",
  "private const val DAY_MS = 24L * 3600_000",
  "if (kotlin.math.abs(delta) < DAY_MS) clockOffsetMs = delta",
  "fun serverNow(): Long = System.currentTimeMillis() + clockOffsetMs",
  "observeServerClock(res)",
]

test("the App measures durations on the server's clock", () => {
  const client = readFileSync(CLIENT_SOURCE, "utf8")
  for (const step of SERVER_CLOCK_STEPS) {
    assert.ok(client.includes(step), `observeServerClock no longer matches its mirror:\n${step}`)
  }
  const device = Date.parse("2026-11-05T12:00:00Z")
  const twoHoursAhead = Date.parse("2026-11-05T14:00:00Z")
  // A phone two hours behind the bot: a task started a minute ago must read as a minute, not as
  // a negative number clamped to 「已运行 0 秒」, which is what made the App look hung.
  const offset = appClockOffsetFrom("Thu, 05 Nov 2026 14:00:00 GMT", twoHoursAhead, device)
  assert.equal(offset, 7_200_000)
  assert.equal(appServerNow(device, offset ?? 0), twoHoursAhead)
  assert.equal(appClockOffsetFrom(undefined, null, device), null, "no header must not move the clock")
  assert.equal(appClockOffsetFrom("not a date", null, device), null, "an unparsable header is no evidence")
  const aYearOff = Date.parse("2027-11-05T12:00:00Z")
  assert.equal(appClockOffsetFrom("Mon, 05 Nov 2027 12:00:00 GMT", aYearOff, device), null, "a broken proxy clock is worse than none")
  // Within a day the answer wins, which is the case that actually helps: NTP-drifted phones.
  assert.equal(appClockOffsetFrom("Thu, 05 Nov 2026 12:10:00 GMT", device + 600_000, device), 600_000)
})

/**
 * The steps `LocalStore.saveMessages` runs when it caps the stored chat, pinned as literal source.
 * That budget decides which of the user's older bubbles survive a restart, and the mirror in
 * tests/support/appHistory.ts is the only way to execute the rule here.
 */
const HISTORY_CAP_STEPS = [
  "private const val MAX_HISTORY_BYTES = 2 * 1024 * 1024",
  "val encoded = stored.map { json.encodeToString(StoredMessage.serializer(), it) }",
  "var from = 0",
  "for (index in stored.indices.reversed()) {",
  "bytes += encoded[index].length + 1",
  "if (index < stored.lastIndex && bytes > MAX_HISTORY_BYTES) {",
  "json.encodeToString(stored.subList(from, stored.size))",
  "if (messages.isEmpty()) clearMessages(context) else saveMessages(context, messages)",
]

test("the App caps its stored chat without losing the newest bubbles", () => {
  const store = readFileSync(LOCALSTORE_SOURCE, "utf8")
  for (const step of HISTORY_CAP_STEPS) {
    assert.ok(store.includes(step), `saveMessages no longer matches its mirror:\n${step}`)
  }
  // Rows are their own encoded length here; +1 per row is the JSON comma.
  const encoded = (row: string): string => row
  const oldestFirst = ["x".repeat(10), "y", "z"]
  // Under budget, and exactly at it: nothing is dropped, order is kept.
  assert.deepEqual(capHistory(oldestFirst, encoded, 100), oldestFirst)
  assert.deepEqual(capHistory(["ab", "cd"], encoded, 6), ["ab", "cd"])
  // Over budget: the oldest rows go, the newest suffix stays contiguous and in order.
  assert.deepEqual(capHistory(oldestFirst, encoded, 5), ["y", "z"])
  assert.deepEqual(capHistory(["a", "b", "c", "d"], encoded, 4), ["c", "d"])
  assert.deepEqual(capHistory(["a", "b", "c", "d"], encoded, 2), ["d"])
  // A reply bigger than the whole budget must not take itself down with the older rows.
  const huge = "r".repeat(50)
  assert.deepEqual(capHistory(["old", huge], encoded, 5), [huge])
  assert.deepEqual(capHistory([huge], encoded, 5), [huge])
  // The shipped budget on a heavy chat: months of bubbles trim to a few thousand rows, which is
  // far more scrollback than the screen ever shows, and stays under the value's byte cap.
  const longChat = Array.from({ length: 6000 }, () => "x".repeat(400))
  const kept = capHistory(longChat, encoded)
  assert.ok(kept.length > 5000 && kept.length < 5300, `shipped budget kept ${kept.length} rows`)
  assert.deepEqual(kept, longChat.slice(longChat.length - kept.length))
})

/**
 * The App's plaintext fallback for a server that stopped accepting its pairing key. It cannot be
 * executed here, so these literal steps plus the server's own replies are the evidence: reword a 400
 * in src/api.ts and the trigger below stops matching, which is exactly the drift that would leave
 * every screen of the App failing on a header or a key the user cannot remove.
 */
const ENC_FALLBACK_STEPS = [
  'it.isNotBlank() && it != refusedEncKey && !encryptionSkipped(path)',
  'if (res.code == 400 && encKey != null && encKeyRejected(plain)) {',
  '(body.contains("x-enc") && body.contains("API_ENCRYPTION")) || body.contains("解密请求体失败")',
  "private class EncryptionRefused(val encKey: String) : Exception()",
  "if (it is javax.crypto.AEADBadTagException || it is javax.crypto.BadPaddingException) {",
]

test("the App retries in plaintext whenever the server stops accepting its key", () => {
  const client = readFileSync(CLIENT_SOURCE, "utf8")
  for (const step of ENC_FALLBACK_STEPS) {
    assert.ok(client.includes(step), `the encrypted-request path no longer matches its pin:\n${step}`)
  }
  // One retry, and it is the same call with the header dropped: the refusal happens before routing,
  // so repeating it cannot start a second task.
  assert.match(
    client,
    /catch \(err: EncryptionRefused\) \{\n\s*refusedEncKey = err\.encKey\n\s*execute\(request\(connection, method, path, body\), client\)/,
  )
  assert.doesNotMatch(client, /while \(.*EncryptionRefused/, "the fallback must not loop behind a proxy that keeps refusing")
  // Every endpoint goes through that helper. The long-running ones (cc-switch, ops, agent installs)
  // used to call execute() directly, so a server with encryption off failed exactly those screens
  // and no amount of refreshing recovered them.
  const bypassing = client.match(/execute\(request\(connection, [^)]*\)/g) ?? []
  assert.equal(bypassing.length, 2, `only executeEncryptedFallback may call execute(request(...)): ${bypassing.join(" | ")}`)

  const server = readFileSync(API_SOURCE, "utf8")
  const reply = /"服务器未启用消息加密[^"]*"/.exec(server)?.[0]
  assert.ok(reply, "the server has to keep telling the client that it does not encrypt")
  for (const trigger of ["x-enc", "API_ENCRYPTION"]) {
    assert.ok(reply.includes(trigger), `${trigger} is what ApiClient.encKeyRejected() keys on`)
  }
  // A regenerated pairing key: the App holds the old one, so a POST body cannot be decrypted. A GET
  // never reaches this reply, which is why the response-side tag mismatch carries the same fallback.
  assert.match(server, /`解密请求体失败[^`]*`/, "the server has to keep naming the decrypt failure the App falls back past")
})

/**
 * The App is the only place a user learns their pick was too big. The server does not reject an
 * oversized attachment — it answers with a note that the file was left out — so a cap the App does
 * not share means paying for the upload and then wondering where the image went.
 */
test("the App refuses attachments exactly where the server would drop them", () => {
  const store = readFileSync(LOCALSTORE_SOURCE, "utf8")
  const input = readFileSync("src/attachmentInput.ts", "utf8")
  const kotlinMb = (name: string): number => Number(new RegExp(`const val ${name} = (\\d+) \\* 1024 \\* 1024`).exec(store)?.[1])
  const serverMb = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+) \\* 1024 \\* 1024`).exec(input)?.[1])
  assert.ok(kotlinMb("MAX_TOTAL_BYTES") > 0 && serverMb("MAX_ATTACH_TOTAL_BYTES") > 0, "the caps must stay MB literals")
  assert.equal(kotlinMb("MAX_TOTAL_BYTES"), serverMb("MAX_ATTACH_TOTAL_BYTES"), "the queued-total cap drifted from the server")
  assert.equal(kotlinMb("MAX_FILE_BYTES"), serverMb("MAX_ATTACH_FILE_BYTES"), "the per-file cap drifted from the server")
  // The picker reads behind this cap, so no file the server would not attach is ever uploaded.
  assert.match(store, /val limit = AttachmentLimits\.MAX_FILE_BYTES/)
  // An empty pick encodes to an empty data field, and the server answers that with a 400 for the
  // whole request — a failed send keeps its attachments staged, so one placeholder file in the
  // strip then broke every message the user tried to send afterwards.
  assert.match(store, /if \(bytes\.isEmpty\(\)\)/)
  assert.match(
    readFileSync("src/apiTasks.ts", "utf8"),
    /附件缺少 name 或 data/,
    "the server has to keep rejecting the empty attachment the App now refuses",
  )
})
