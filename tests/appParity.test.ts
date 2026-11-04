import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

import { BOT_COMMAND_ALIASES, BOT_MENU_COMMANDS } from "../src/help.js"
import { appModelFields, tsInterfaceFields } from "./support/appModels.js"

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

/**
 * Routes kept for other API consumers, not the App: `tasks` lists the bot's whole in-memory
 * task log, which the App shows per-session through `queue` and `history` instead.
 */
const NOT_IN_APP = ["tasks"]

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
 * These pairs are the payloads both sides type by hand. `tests/support/appModels.ts` reads
 * the App's Kotlin models, which is also where the live API tests check their responses.
 */
test("the App's models decode exactly the fields the server sends", () => {
  const sources = {
    "src/usage.ts": readFileSync("src/usage.ts", "utf8"),
    "src/history.ts": readFileSync("src/history.ts", "utf8"),
  }
  const day = tsInterfaceFields(sources, "UsageDay")
  const cases: Array<[kotlin: string, server: Set<string>]> = [
    ["UsageDay", day],
    // /usage sends UsageSummary (UsageDay + lastAt/lastEngine/lastModel + today + engines)
    ["Usage", new Set([...tsInterfaceFields(sources, "UsageSummary"), ...day])],
    // /usage's trend rows are `UsageDay & { day }`
    ["UsageTrendDay", new Set([...day, "day"])],
    ["HistoryEntry", tsInterfaceFields(sources, "HistoryEntry")],
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
