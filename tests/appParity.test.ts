import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

import { BOT_COMMAND_ALIASES, BOT_MENU_COMMANDS } from "../src/help.js"
import { loadConfig } from "../src/config.js"
import { pairingQrPayload, resolvePairingUrl } from "../src/api.js"
import { signingMaterialIgnored } from "../scripts/check-android-sources.mjs"
import { appModelFields, tsInterfaceFields, tsInterfaceMemberFields, tsUnionFields } from "./support/appModels.js"
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
 * Both consoles are server-driven: the clickable rows and the names they send come from the
 * same catalogs the bot executes. A page that renders only read views leaves every write
 * command invisible (the mislabeled "magpie console" regression), while a fixed name the
 * server does not list is a dead button after any catalog edit.
 */
test("cc-switch and magpie render the server's actionable catalogs", () => {
  const cc = readFileSync(`${UI_DIR}/CcScreen.kt`, "utf8")
  const magpie = readFileSync(`${UI_DIR}/MagpieScreen.kt`, "utf8")
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")

  assert.ok(cc.includes("vm.ccViews.forEach") && cc.includes("vm.ccCommands.isNotEmpty()"), "cc-switch must render both view and exec catalogs")
  assert.ok(magpie.includes("overview?.views") && magpie.includes("overview?.commands"), "magpie must render both view and exec catalogs")
  assert.ok(magpie.includes("vm.runMagpieCommand(command.name"), "a listed magpie command needs an executable row")
  assert.ok(magpie.includes("需要确认"), "destructive magpie commands must be visibly marked and confirmed")
  assert.ok(viewModel.includes("api.magpieExec("), "the App must call POST /magpie/exec, not only the passthrough")
  assert.ok(viewModel.includes("refreshCcAfterMutation()"), "provider writes must refresh their catalog")
  assert.ok(viewModel.includes('val mutating = setOf("sync"'), "a successful magpie write should refresh only state-changing commands")
  assert.ok(cc.includes("vm.ccCatalogReady"), "a typed /cc must wait for the complete server catalog")
  assert.ok(viewModel.includes("ccCatalogReady = true"), "a failed catalog read must release a pending /cc request")
  assert.ok(cc.includes("vm.ccCatalogError"), "a failed catalog read must not resolve against stale rows")
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
  assert.deepEqual(signingMaterialIgnored("android/app/src/main/java"), [])
})

test("the Android source gate refuses release signing material that is not ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-signing-ignore-"))
  try {
    const android = join(dir, "android")
    const sourceRoot = join(android, "app", "src", "main", "java")
    mkdirSync(sourceRoot, { recursive: true })
    writeFileSync(join(android, "app", "build.gradle.kts"), "")
    writeFileSync(join(dir, ".gitignore"), "")
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0)
    assert.equal(signingMaterialIgnored(sourceRoot, dir).length, 3, "all three signing paths must be reported when .gitignore is empty")
    writeFileSync(
      join(dir, ".gitignore"),
      ["android/keystore.properties", "android/*.jks", "android/*.keystore", ""].join("\n"),
    )
    assert.deepEqual(signingMaterialIgnored(sourceRoot, dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The drawer is the App's full map. Grouping is cosmetic, but dropping a route while rearranging
 * it silently removes a page: the screen is still in MainActivity, yet no way to reach it. The
 * chat bar also regressed into a row of six icons, so keep the secondary actions in the overflow.
 */
test("the drawer keeps every screen reachable and the chat bar stays uncluttered", () => {
  const drawer = readFileSync(`${UI_DIR}/AppDrawer.kt`, "utf8")
  const chat = readFileSync(`${UI_DIR}/ChatScreen.kt`, "utf8")
  const routes = [
    "History", "Reminders", "Schedules", "Session", "Queue", "Agents", "Ops", "Proxy",
    "Aliases", "Access", "Models", "Cc", "Magpie", "Hermes", "Config", "Status", "Help", "Settings",
  ]
  assert.deepEqual(
    routes.filter((route) => !drawer.includes(`Screen.${route}`)),
    [],
    "a drawer route disappeared during the regrouping",
  )
  assert.ok(drawer.includes('DrawerSection("对话")'), "the drawer needs named groups, not a flat list")
  const scroller = /Column\(\s*modifier = Modifier\s*\.weight\(1f\)[\s\S]*?DrawerItem\(Icons\.Filled\.Help[^\n]*\n\s*}/.exec(drawer)?.[0]
  assert.ok(scroller, "the grouped routes must share one vertical scroller")
  const topPadding = scroller.indexOf(".padding(top = 10.dp)")
  const routeScroll = scroller.indexOf(".verticalScroll(routeScroll)")
  assert.ok(topPadding >= 0, "the route scroller must keep its top spacing")
  assert.ok(routeScroll >= 0, "the grouped routes must keep their vertical scroller")
  assert.ok(
    topPadding < routeScroll,
    "the top spacing must wrap the scroller, not become scrolling content that can clip the first group",
  )
  assert.ok(
    /verticalScroll\(routeScroll\)[\s\S]*?Spacer\(modifier = Modifier\.padding\(top = 6\.dp\)\)/.test(scroller),
    "the scroll cushion must stay inside the scroller, so a moved route never touches the button above it",
  )
  assert.match(
    drawer,
    /AppDrawer\([\s\S]*?open: Boolean = false/,
    "the drawer must receive its open edge instead of guessing when to reset",
  )
  assert.match(
    drawer,
    /if \(open && !wasOpen\) routeScroll\.scrollTo\(0\)/,
    "reopening the drawer must show the first routes again",
  )
  assert.match(
    readFileSync("android/app/src/main/java/com/agentbot/app/MainActivity.kt", "utf8"),
    /open = drawerState\.isOpen/,
    "MainActivity must feed the drawer's live open state",
  )
  const footer = drawer.slice(drawer.indexOf(scroller) + scroller.length)
  assert.ok(footer.includes('DrawerItem(Icons.Filled.Settings'), "settings must stay outside the route scroller")
  assert.ok(
    footer.indexOf("HorizontalDivider(") < footer.indexOf('DrawerItem(Icons.Filled.Settings'),
    "the fixed settings footer must keep its separator",
  )
  assert.ok(chat.includes("Icons.Filled.MoreVert"), "secondary chat actions belong in an overflow menu")
  const topBar = /private fun ChatTopBar\([\s\S]*?\n}\n/.exec(chat)?.[0]
  assert.ok(topBar, "ChatTopBar must stay one function")
  const iconButtons = (topBar.match(/IconButton\(/g) ?? []).length
  assert.ok(iconButtons <= 4, `ChatTopBar has ${iconButtons} icon buttons; keep the header to menu/model/status/search/overflow`)
  assert.ok(topBar.includes("Screen.Session") && topBar.includes("Screen.Queue"), "overflow must keep session settings and queue")

  // The shared visual system is the base of the newer screens; losing it would not fail the
  // Kotlin bracket gate (the screens would still be valid), but would quietly flatten the UI.
  const shared = readFileSync(`${UI_DIR}/UiComponents.kt`, "utf8")
  for (const component of ["ScreenHeader", "SectionLabel", "AppCard", "StatusPill", "EmptyState"]) {
    assert.ok(shared.includes(`fun ${component}(`), `UiComponents.kt must keep ${component}`)
  }
  for (const screen of ["SettingsScreen.kt", "StatusScreen.kt", "ListScreens.kt", "HelpScreen.kt"]) {
    const source = readFileSync(`${UI_DIR}/${screen}`, "utf8")
    assert.ok(source.includes("ScreenHeader("), `${screen} must use the shared page header`)
  }
  const titled = [
    "SessionScreen.kt", "AgentsScreen.kt", "ModelsScreen.kt", "CcScreen.kt", "MagpieScreen.kt",
    "HermesScreen.kt", "ConfigScreen.kt", "AccessScreen.kt", "ProxyScreen.kt", "OpsScreen.kt",
  ]
  for (const screen of titled) {
    const source = readFileSync(`${UI_DIR}/${screen}`, "utf8")
    assert.ok(source.includes("ScreenHeader("), `${screen} must use the shared page header`)
    // Dialog titles also use titleLarge. Only the page body before the first dialog
    // should be checked: a detached page title there duplicates ScreenHeader.
    const pageBody = source.split("AlertDialog(", 1)[0]!
    assert.ok(
      !/Text\("[^"]+", style = MaterialTheme\.typography\.titleLarge\)/.test(pageBody),
      `${screen} still has a detached page title`,
    )
  }
})

test("the history page confirms before deleting records that cannot be restored", () => {
  const source = readFileSync(`${UI_DIR}/ListScreens.kt`, "utf8")
  const history = /fun HistoryScreen\([\s\S]*?\n}\n/.exec(source)?.[0]
  assert.ok(history, "HistoryScreen must stay one composable")
  assert.match(history, /var confirmClear by remember/, "clearing history needs a pending-confirmation state")
  assert.match(history, /confirmClear = true/, "the menu action must open the confirmation instead of deleting")
  assert.match(history, /Text\("清空任务历史？"\)/, "the dialog must name the destructive action")
  assert.match(history, /vm\.clearHistory\(\)/, "only the confirmed dialog action may call clearHistory")
  assert.match(
    history,
    /enabled = vm\.history\.isNotEmpty\(\)/,
    "an empty history must not offer an action that can only say nothing was deleted",
  )
  assert.doesNotMatch(
    history,
    /onClick = \{\s*actionsOpen = false\s+vm\.clearHistory\(\)/,
    "the overflow menu must not clear history immediately",
  )
})

test("clearing history reports how many records the server actually deleted", () => {
  const client = readFileSync("android/app/src/main/java/com/agentbot/app/data/ApiClient.kt", "utf8")
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const clear = /suspend fun clearHistory\([\s\S]*?\n    \}\n/.exec(client)?.[0]
  assert.ok(clear, "clearHistory must stay one ApiClient function")
  assert.match(clear, /res\["cleared"\]/, "DELETE /history returns the number of records it removed")
  assert.match(clear, /: Int\b/, "the caller needs the count, not just a completed request")
  const view = /fun clearHistory\(\)[\s\S]*?\n    \}\n/.exec(viewModel)?.[0]
  assert.ok(view, "AppViewModel.clearHistory must stay one function")
  assert.match(view, /val cleared = api\.clearHistory/, "the toast must use the server's count")
  assert.match(view, /已清空 \$cleared 条历史/, "a non-empty clear must say how much was removed")
  assert.match(view, /没有可清空的历史/, "an empty clear must not claim a deletion")
})

test("share sheets never offer Agent Bot as their own destination", () => {
  const helper = readFileSync(`${UI_DIR}/../data/ShareIntents.kt`, "utf8")
  assert.match(helper, /Intent\.EXTRA_EXCLUDE_COMPONENTS/, "the chooser must exclude the App's own SEND filter")
  assert.match(helper, /context\.packageName/, "the excluded component must come from this installation")
  assert.match(helper, /queryIntentActivities\(send/, "only a matching self activity belongs in the exclusion list")
  assert.match(
    helper,
    /Intent\.createChooser\(send, title\)\.apply\s*\{\s*if \(own\.isNotEmpty\(\)\) putExtra\(Intent\.EXTRA_EXCLUDE_COMPONENTS/,
    "the resolver only reads EXTRA_EXCLUDE_COMPONENTS from the outer chooser intent",
  )

  const history = readFileSync(`${UI_DIR}/ListScreens.kt`, "utf8")
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  assert.match(history, /ShareIntents\.chooser\(context, send, "分享任务历史"\)/)
  assert.match(viewModel, /ShareIntents\.chooser\(appContext, send, "分享每日报告"\)/)
  assert.match(viewModel, /ShareIntents\.chooser\(appContext, share, "数据备份"\)/)
  assert.match(viewModel, /ShareIntents\.chooser\(appContext, share, media\.name\)/)
  for (const [name, source] of [["history", history], ["the ViewModel", viewModel]] as const) {
    assert.doesNotMatch(source, /Intent\.createChooser\(/, `${name} must use the shared self-excluding chooser`)
  }
})

test("deleting a reminder or schedule asks before discarding the user's setup", () => {
  const source = readFileSync(`${UI_DIR}/ListScreens.kt`, "utf8")
  for (const [screen, title, call] of [
    ["RemindersScreen", "删除这条提醒？", "vm.deleteReminder"],
    ["SchedulesScreen", "删除这个定时任务？", "vm.deleteSchedule"],
  ] as const) {
    const body = new RegExp(`fun ${screen}\\([\\s\\S]*?\\n}\\n`).exec(source)?.[0]
    assert.ok(body, `${screen} must stay one composable`)
    assert.match(body, /var deleteTarget by remember/, `${screen} needs a pending-delete state`)
    assert.ok(body.includes(`Text("${title}")`), `${screen} must name the destructive action`)
    assert.ok(body.includes(call), `${screen} must delete after confirmation`)
    assert.doesNotMatch(
      body,
      new RegExp(`contentDescription = "删除",\\s*onClick = \\{ ${call}\\(`),
      `${screen} must not delete straight from the list icon`,
    )
  }
})

test("automation screens distinguish loading, delivery setup and read failures", () => {
  const source = readFileSync(`${UI_DIR}/ListScreens.kt`, "utf8")
  assert.match(
    source,
    /vm\.remindersBusy && vm\.reminders\.isEmpty\(\)/,
    "the reminder empty state must wait for its first successful read",
  )
  assert.match(
    source,
    /vm\.remindersUnavailable/,
    "a reminder page must explain a deployment without a chat delivery target",
  )
  assert.match(
    source,
    /vm\.schedulesBusy && vm\.schedules\.isEmpty\(\)/,
    "the schedule empty state must wait for its first successful read",
  )
  assert.match(
    source,
    /vm\.schedulesUnavailable/,
    "a schedule page must explain a deployment without a chat delivery target",
  )
  assert.match(
    source,
    /action = \{ QuietButton\(text = "重新检查"/,
    "an unavailable automation page needs a check that can discover a newly paired chat channel",
  )
  assert.match(
    source,
    /vm\.remindersError == null && vm\.remindersUnavailable == null/,
    "a reminder create button must be hidden when reminders cannot be created",
  )
  assert.match(
    source,
    /vm\.schedulesError == null && vm\.schedulesUnavailable == null/,
    "a schedule create button must be hidden when schedules cannot be created",
  )
})

test("retrying an automation page also refreshes the delivery setup", () => {
  const source = readFileSync(VIEWMODEL_SOURCE, "utf8")
  for (const resource of ["reminders", "schedules"]) {
    const body = new RegExp(`fun refresh${resource[0]!.toUpperCase()}${resource.slice(1)}\\(\\)[\\s\\S]*?\\n    \\}`).exec(source)?.[0]
    assert.ok(body, `refresh${resource[0]!.toUpperCase()}${resource.slice(1)} must stay one function`)
    assert.match(
      body,
      new RegExp(`serverInfo = api\\.info\\(conn\\(\\)\\)[\\s\\S]*?api\\.${resource}\\(conn\\(\\)\\)`),
      `retrying ${resource} must re-read /info before its list, not repeat a stale unavailable state`,
    )
  }
})

/**
 * A queue row and its 重试 button are both far below the chat: a rejected retry used to write
 * `connectionError`, whose banner only the chat renders. The page therefore looked unchanged,
 * and a successful retry also gave no sign that a new paid run had started. Keep both outcomes
 * on the queue page, and keep a failed read from turning a valid list into an empty queue.
 */
test("queue actions report success and failure on the queue page", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const queue = readFileSync(`${UI_DIR}/SessionScreen.kt`, "utf8")
  const retryRecord = /fun retryRecord\(taskId: String\) \{[\s\S]*?\n    \}/.exec(viewModel)?.[0]
  assert.ok(retryRecord, "retryRecord must stay one function so its feedback can be checked")
  assert.ok(
    retryRecord.includes('queueActionError = "重试失败：${err.message}"'),
    "a rejected queue retry must stay on the queue page",
  )
  assert.match(retryRecord, /toast = "已重新提交任务/, "a successful retry must say that a new run started")
  for (const field of ["queueError", "queueActionError"]) {
    assert.ok(
      new RegExp(`var ${field} by mutableStateOf<String\\?>\\(null\\)\\n\\n`).test(viewModel),
      `${field} is read by the queue screen, so its getter cannot be private`,
    )
  }
  for (const [name, label] of [["stopTask", "停止任务"], ["clearQueue", "清空队列"]] as const) {
    const action = new RegExp(`fun ${name}\\([^)]*\\)[\\s\\S]*?\\n    \\}`).exec(viewModel)?.[0]
    assert.ok(action, `${name} must stay one function so its failure can be checked`)
    assert.ok(
      action.includes(`onError = { queueActionError = "${label}失败：\${it.message}" }`),
      `${name} failures must stay on the queue page rather than the chat-only banner`,
    )
  }

  const screen = /fun QueueScreen\(vm: AppViewModel\) \{[\s\S]*?\n\}\n\nprivate fun taskStatusLabel/.exec(queue)?.[0]
  assert.ok(screen, "QueueScreen must stay one composable")
  assert.match(screen, /PageErrorNotice\(\s*message = vm\.queueActionError/, "queue action failures need a visible notice")
  assert.ok(screen.indexOf("PageErrorNotice(") < screen.indexOf("val loadError = vm.queueError"), "the notice must sit above both the list and the load-error branch")
  assert.match(
    screen,
    /message = vm\.queueError\.takeIf \{ vm\.queue\.isNotEmpty\(\) \|\| vm\.recentTasks\.isNotEmpty\(\) \}/,
    "a failed refresh must stay visible over the rows it keeps, not only when the list is empty",
  )
  assert.ok(
    !screen.includes("dismissQueueError"),
    "the read failure and the action failure must stay separate states on the queue page",
  )
})

/**
 * The queue screen renders a refresh error only when rows are still present. That layout cannot
 * prove the refresh keeps them: assigning the partial result first, or clearing the list in the
 * catch branch, would still compile and would leave the user looking at a plausible stale page.
 * Pin the write order and the failure branch in the ViewModel, in addition to the UI condition.
 */
test("a failed queue refresh keeps the rows it could not re-read", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const refresh = /fun refreshQueue\(\) \{[\s\S]*?\n    \}/.exec(viewModel)?.[0]
  assert.ok(refresh, "refreshQueue must stay one function so its failure semantics can be checked")
  const nextQueue = refresh.indexOf("val nextQueue = api.queue(conn())")
  const nextRecent = refresh.indexOf("val nextRecent = api.tasks(conn()).filterNot { it.isRunning }")
  const queueWrite = refresh.indexOf("queue = nextQueue")
  const recentWrite = refresh.indexOf("recentTasks = nextRecent")
  const successClear = refresh.indexOf("queueError = null")
  assert.ok(nextQueue >= 0 && nextRecent >= 0, "both reads must finish before either list is replaced")
  assert.ok(
    queueWrite > nextQueue && queueWrite > nextRecent && recentWrite > nextQueue && recentWrite > nextRecent,
    "a rejected second read must not leave a half-updated queue",
  )
  assert.ok(successClear > queueWrite && successClear > recentWrite, "only a complete read may clear the old error")
  const failure = /catch \(err: Exception\) \{[\s\S]*?queueError = [\s\S]*?throw err/.exec(refresh)?.[0]
  assert.ok(failure, "a failed refresh must mark the read and keep propagating to the banner path")
  assert.doesNotMatch(failure, /\b(?:queue|recentTasks)\s*=\s*(?:emptyList\(\)|null)/, "a failed refresh must keep the old rows")
})

test("the status page keeps its connection address readable on a phone", () => {
  const status = readFileSync(`${UI_DIR}/StatusScreen.kt`, "utf8")
  assert.match(
    status,
    /ServerAddressRow\(vm\.serverUrl\b/,
    "the server URL needs a full-width row, not a narrow label/value column",
  )
  const address = /private fun ServerAddressRow\([\s\S]*?\n}\n/.exec(status)?.[0]
  assert.ok(address, "ServerAddressRow must stay one composable")
  assert.match(address, /SelectionContainer\s*\{/, "a connection address should be selectable")
  assert.match(address, /fillMaxWidth\(\)/, "the address must be allowed the full card width")
  assert.doesNotMatch(
    status,
    /subtitle = "服务健康、连接信息与今日用量"/,
    "the long status subtitle wraps the title on a 720px-wide phone",
  )
})

/**
 * A model page owns every action it offers. Invalid input and server failures used to write the
 * chat-only connection banner, then close the add dialog: the model page looked unchanged and the
 * typed line was gone. Validation now keeps the dialog; every other outcome lands on the page.
 */
test("model actions report their outcome on the model page", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const screen = readFileSync(`${UI_DIR}/ModelsScreen.kt`, "utf8")
  assert.ok(
    /var modelActionError by mutableStateOf<String\?>\(null\)\n\n/.test(viewModel),
    "modelActionError is read by ModelsScreen, so its getter cannot be private",
  )
  assert.ok(
    /var modelDraftRejected by mutableStateOf\(false\)\n\s+private set\n\n/.test(viewModel),
    "a form rejection must be distinguishable from a server failure",
  )

  const add = /fun addCustomModel\(input: String\): Boolean \{[\s\S]*?\n    \}/.exec(viewModel)?.[0]
  assert.ok(add, "addCustomModel must keep an explicit validation result")
  assert.ok(!add.includes("connectionError"), "an add failure must not go to the chat-only banner")
  assert.match(add, /modelActionError = "用法：/, "missing fields must explain the accepted format")
  assert.match(add, /modelActionError = "第二项必须是 provider\/modelID/, "a malformed provider/model pair must be rejected on this page")
  assert.match(add, /return false/, "an invalid input must keep its dialog and text available")

  for (const [name, message] of [
    ["assignAgentModel", "绑定 Agent 模型失败"],
    ["removeCustomModel", "删除模型失败"],
  ] as const) {
    const action = new RegExp(`fun ${name}\\([^)]*\\)[\\s\\S]*?\\n    \\}`).exec(viewModel)?.[0]
    assert.ok(action, `${name} must stay one function so its feedback can be checked`)
    assert.ok(action.includes(`modelActionError = "${message}：\${err.message}"`), `${message} must stay on the model page`)
    assert.ok(!action.includes("connectionError"), `${name} must not hide its failure in the chat-only banner`)
  }

  assert.match(screen, /PageErrorNotice\(\s*message = vm\.modelActionError/, "the model page needs a visible action error")
  assert.match(
    screen,
    /error = vm\.modelActionError\.takeIf \{ vm\.modelDraftRejected \}/,
    "the add dialog must show a validation reason where it cannot be covered",
  )
  assert.match(
    screen,
    /onConfirm = \{ input ->\s*if \(vm\.addCustomModel\(input\)\) adding = false/,
    "only a valid add may close the dialog",
  )
  assert.match(screen, /onDismiss = \{ adding = false \}/, "the user can still cancel an invalid draft")
})

test("config and access writes explain failures on their own page", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const config = readFileSync(`${UI_DIR}/ConfigScreen.kt`, "utf8")
  const access = readFileSync(`${UI_DIR}/AccessScreen.kt`, "utf8")

  assert.match(viewModel, /var configActionError by mutableStateOf<String\?>\(null\)/, "config writes need a page-local error")
  assert.match(viewModel, /var configDraftRejected by mutableStateOf\(false\)/, "the prompt needs to know a malformed draft")
  assert.match(viewModel, /configActionError = "用法：KEY 值/, "a malformed add must explain the accepted format")
  assert.match(viewModel, /fun setConfig\(key: String, value: String, onResult/, "the prompt needs an asynchronous result callback")
  assert.match(viewModel, /configActionError = "更新配置失败：\$\{err\.message\}"/, "a failed write must stay on the config page")
  assert.match(viewModel, /configActionError = "更新配置失败：[\s\S]{0,100}configDraftRejected = true/, "a server-rejected write needs its reason inside the prompt")
  assert.match(viewModel, /configActionError = "删除配置失败：\$\{err\.message\}"/, "a failed delete must stay on the config page")
  assert.match(config, /PageErrorNotice\(\s*message = vm\.configActionError/, "the config page needs a visible action error")
  assert.match(config, /error = vm\.configActionError\.takeIf \{ vm\.configDraftRejected \}/, "the prompt must show its own validation reason")
  assert.match(config, /vm\.addConfig\(input\) \{ ok -> if \(ok\) adding = false \}/, "only a successful add may close the prompt")
  assert.match(config, /vm\.setConfig\(entry\.key, value\) \{ ok -> if \(ok\) editing = null \}/, "only a successful edit may close the prompt")
  assert.match(access, /PageErrorNotice\(\s*message = vm\.accessActionError/, "the access page needs a visible action error")
  assert.ok(access.includes("vm.addAccess(input) { ok -> if (ok) adding = false }"), "only a successful whitelist add may close the prompt")
  assert.match(viewModel, /accessActionError = "添加白名单失败：[\s\S]{0,100}accessDraftRejected = true/, "a server-rejected whitelist add needs its reason inside the prompt")
  assert.match(viewModel, /trimmed\.length !in 1\.\.20 \|\| !trimmed\.all\(Char::isDigit\)/, "the App must reject IDs the server's 1-20 digit rule rejects")
  assert.match(access, /error = vm\.accessActionError\.takeIf \{ vm\.accessDraftRejected \}/, "an invalid whitelist draft needs an inline reason")

  const proxy = readFileSync(`${UI_DIR}/ProxyScreen.kt`, "utf8")
  assert.match(viewModel, /var proxyActionError by mutableStateOf<String\?>\(null\)/, "proxy writes need a page-local error")
  assert.match(proxy, /PageErrorNotice\(\s*message = vm\.proxyActionError/, "the proxy page needs a visible action error")
  assert.match(proxy, /vm\.addProxy\(input\) \{ ok -> if \(ok\) adding = false \}/, "only a successful proxy add may close the prompt")
  assert.match(viewModel, /proxyActionError = "添加代理失败：[\s\S]{0,100}proxyDraftRejected = true/, "a server-rejected proxy needs its reason inside the prompt")
  assert.match(proxy, /var pendingRemove by remember/, "proxy removal needs a pending-confirmation state")
  assert.ok(proxy.includes("vm.removeProxy(proxy.id) { ok -> if (ok) pendingRemove = null }"), "a proxy may only disappear after the server confirms")
  assert.match(viewModel, /proxyActionError = "测试代理失败：/, "a failed test must not masquerade as an unsuccessful connection")

  const aliases = readFileSync(`${UI_DIR}/AliasesScreen.kt`, "utf8")
  assert.match(viewModel, /var aliasesActionError by mutableStateOf<String\?>\(null\)/, "shortcut writes need a page-local error")
  assert.match(aliases, /PageErrorNotice\(\s*message = vm\.aliasesActionError/, "the shortcut page needs a visible action error")
  assert.match(aliases, /vm\.addAlias\(input\) \{ ok -> if \(ok\) adding = false \}/, "only a successful shortcut add may close the prompt")
  assert.match(viewModel, /aliasesActionError = "创建快捷指令失败：[\s\S]{0,100}aliasesDraftRejected = true/, "a server-rejected shortcut needs its reason inside the prompt")
  assert.match(aliases, /var pendingRemove by remember/, "shortcut deletion needs a pending-confirmation state")
  assert.match(aliases, /删除快捷指令 \/\$name？/, "shortcut deletion must name what is being deleted")
  assert.ok(aliases.includes("vm.deleteAlias(name) { ok -> if (ok) pendingRemove = null }"), "a shortcut may only disappear after the server confirms")

  const session = readFileSync(`${UI_DIR}/SessionScreen.kt`, "utf8")
  assert.match(viewModel, /var sessionActionError by mutableStateOf<String\?>\(null\)/, "session writes need a page-local error")
  assert.match(session, /PageErrorNotice\(\s*message = vm\.sessionActionError/, "the session page needs a visible action error")
  assert.match(session, /vm\.setWorkDir\(path\) \{ ok -> if \(ok\) editDir = false \}/, "a rejected directory must keep its prompt and draft")
  assert.match(session, /vm\.changeTimezone\(zone\.trim\(\)\) \{ ok -> if \(ok\) editTz = false \}/, "a rejected timezone must keep its prompt and draft")
  assert.match(viewModel, /sessionActionError = "切换时区失败：[\s\S]{0,100}sessionDraftRejected = true/, "a server-rejected timezone needs its reason inside the prompt")
  assert.match(viewModel, /fun followPeer\(scope: String, onResult: \(Boolean\) -> Unit/, "following a peer needs an async result callback")
  assert.ok(session.includes("vm.followPeer(peer.scope) { ok -> if (ok) followTarget = null }"), "the follow confirmation may only close after the server confirms")
})

test("the shared text prompt can show an inline validation error", () => {
  const picker = readFileSync(`${UI_DIR}/PickerDialog.kt`, "utf8")
  const prompt = /fun TextPromptDialog\([\s\S]*?\n\}\n/.exec(picker)?.[0]
  assert.ok(prompt, "TextPromptDialog must stay one composable")
  assert.match(prompt, /error: String\? = null,/, "the prompt needs an optional inline error")
  assert.match(picker, /\.weight\(1f, fill = false\)[\s\S]*verticalScroll\(rememberScrollState\(\)\)/, "the prompt body must take only the height left by the actions")
  assert.match(picker, /HorizontalDivider[\s\S]*TextButton\(onClick = onDismiss\)/, "the prompt actions must stay outside the scrolling body")
  assert.match(
    picker,
    /error\?\.let \{[\s\S]*?clickable \{ reasonExpanded = !reasonExpanded \}[\s\S]*?maxLines = if \(reasonExpanded\) Int\.MAX_VALUE else 2[\s\S]*?\n {8}\}\n {8}\/\/ The field is outside both scrolling bodies/,
    "the reason must stay beside the field, collapsed to two expandable lines so it cannot crowd the title or keyboard",
  )
  assert.match(
    picker,
    /The field is outside both scrolling bodies[\s\S]*?\n {8}AppTextField\(/,
    "the field must sit outside the scrolling bodies, so a long reason cannot push the focused field under the keyboard",
  )
  assert.match(
    picker,
    /Text\(title,[\s\S]*?Text\(hint,[\s\S]*?\n {8}\}\n {8}\/\/ Keep the rejection beside the draft/,
    "the title and help stay in the weighted body while the reason is pinned above the field",
  )
  assert.match(
    picker,
    /Column\(modifier = Modifier\.fillMaxWidth\(\)\) \{[\s\S]*?\.weight\(1f, fill = false\)[\s\S]*?HorizontalDivider[\s\S]*?TextButton\(onClick = onDismiss\)[\s\S]*?\n {4}\}$/m,
    "the actions must be siblings of the weighted body inside one root, or they are measured after it and clipped",
  )
  assert.match(picker, /Dialog\([\s\S]*?usePlatformDefaultWidth = false/, "the prompt needs a dialog it can size above the keyboard")
  assert.match(picker, /decorFitsSystemWindows = false/, "the dialog window must pass its keyboard inset to Compose")
  assert.match(picker, /fillMaxSize\(\)[\s\S]*windowInsetsPadding\(WindowInsets\.safeDrawing\)[\s\S]*imePadding\(\)/, "the dialog must inset its whole surface above the keyboard")
  assert.ok(
    picker.indexOf("error?.let") < picker.indexOf("AppTextField("),
    "the validation reason must be visible above the field, not hidden behind the keyboard",
  )
})

/**
 * Media is the part a static Kotlin gate cannot exercise. Pin the pieces whose absence is
 * invisible in source (they still compile): all reply kinds are routed, failures explain
 * themselves and can retry, and voice/video open in the built-in player instead of depending
 * on whichever external app a phone happens to have.
 */
test("the App renders every reply medium and explains failures", () => {
  const chat = readFileSync(`${UI_DIR}/ChatScreen.kt`, "utf8")
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  for (const route of ['item.kind == "image" -> ImageMedia', 'item.kind == "video" -> VideoMedia', "else -> MediaCard"]) {
    assert.ok(chat.includes(route), `AssistantMedia lost a reply kind: ${route}`)
  }
  assert.ok(chat.includes("MediaPlayerDialog("), "voice/video needs the built-in player")
  assert.ok(chat.includes('media.kind == "audio"'), "the player should accept the audio kind alias")
  assert.ok(chat.includes("图片加载失败，重试"), "a failed image needs an explicit retry action")
  assert.ok(chat.includes("vm.mediaErrorDetails[key]"), "the bubble must show why media failed")
  assert.ok(viewModel.includes("mediaErrorDetails"), "media failure details must survive recomposition")
  assert.ok(viewModel.includes("mediaErrors = mediaErrors - key"), "a retry must clear the previous failure")
  assert.ok(viewModel.includes("if (retry) {"), "loadMediaImage must have a retry path")
})

test("a media decodes error stays visible in the player instead of closing the dialog", () => {
  const player = readFileSync(`${UI_DIR}/MediaPlayerDialog.kt`, "utf8")
  assert.ok(player.includes("playbackError"), "the player needs a visible playback error state")
  assert.ok(player.includes("无法播放此媒体"), "a failed decode must explain itself to the user")
  assert.ok(player.includes("用其他应用打开"), "the player must keep the external-open escape hatch")
  assert.ok(
    !/VideoPane\(file, onDismiss\)|AudioPane\(file, title, onDismiss\)/.test(player),
    "a decoder error must not be treated as a request to close the dialog",
  )
})

test("an APK update resumes after the install-permission page", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  assert.ok(viewModel.includes("pendingInstallApk"), "the verified APK has to survive the Settings trip")
  assert.ok(viewModel.includes("resumePendingInstall()"), "returning to the foreground must continue installation")
  assert.ok(
    /if \(!installSettingsOpened\)/.test(viewModel),
    "a denied permission must not reopen Settings on every foreground return",
  )
  assert.ok(
    viewModel.includes("授权并返回后会自动继续安装"),
    "the permission prompt has to say installation resumes automatically",
  )
})

test("an unconfigured update feed does not claim the installed App is current", () => {
  const settings = readFileSync(SETTINGS_SOURCE, "utf8")
  const button = /PrimaryButton\(\s*text = vm\.appUpdateStage[\s\S]*?onClick = \{ vm\.downloadAndInstallAppUpdate\(\) \}/.exec(settings)?.[0]
  assert.ok(button, "the Settings update action must stay one PrimaryButton block")
  assert.ok(
    /release\?\.configured != true -> "暂不可更新"/.test(button),
    "a missing server manifest is not the same as running the newest release",
  )
  assert.ok(
    button.includes("enabled = vm.appUpdateStage == null && release?.updateAvailable == true"),
    "the install action must only be enabled for an advertised newer release",
  )
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

test("scanning a pairing QR fills the form instead of saving an unreviewed address", () => {
  const scanner = readFileSync(SETTINGS_SOURCE, "utf8")
  const handler = /val scanner = rememberLauncherForActivityResult[\s\S]*?\n    }\n/.exec(scanner)?.[0]
  assert.ok(handler, "the QR result handler must stay a single block in SettingsScreen.kt")
  assert.ok(handler.includes("baseUrl = ApiFormat.normalizeBaseUrl(scannedUrl)"), "the scanned URL must fill the field")
  assert.ok(handler.includes("token = scannedToken"), "the scanned token must fill the field")
  assert.ok(!handler.includes("vm.saveConnection"), "a scan must not save before the user checks the address")
})

test("a failed pairing probe leaves the saved connection untouched", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const settings = readFileSync(SETTINGS_SOURCE, "utf8")
  const save = /suspend fun saveConnection[\s\S]*?\n    }\n/.exec(viewModel)?.[0]
  assert.ok(save, "saveConnection must stay a suspend function in AppViewModel.kt")
  const writes = save.indexOf("settings.baseUrl = candidate.baseUrl")
  const healthProbe = save.indexOf("api.health(candidate)")
  const sessionProbe = save.indexOf("api.session(candidate)")
  assert.ok(writes >= 0 && healthProbe >= 0 && sessionProbe >= 0, "saveConnection must probe before writing settings")
  assert.ok(writes > healthProbe && writes > sessionProbe, "the settings write must come after both health and session succeed")
  const failure = /catch \(err: Exception\) \{[\s\S]*?Result\.failure\(err\)/.exec(save)?.[0]
  assert.ok(failure, "saveConnection must keep an explicit failure path")
  assert.ok(!/\b(?:health|session)\s*=\s*null\b/.test(failure), "a failed probe must not wipe the live state of the saved connection")
  assert.ok(failure.includes("connectionProbeError ="), "the pairing failure must reach the fields that caused it")
  assert.ok(!failure.includes("connectionError ="), "a rejected new address must not mark the saved chat offline")
  assert.ok(!save.includes("screen = Screen.Chat"), "navigation belongs to the screen after a successful probe, not the probe itself")
  assert.match(settings, /vm\.connectionProbeError[\s\S]*removePrefix\("连接失败："\)/, "the settings page must show the real pairing failure once, without a doubled prefix")
  assert.equal(settings.match(/vm\.connectionProbeError\?\.let/g)?.length ?? 0, 0, "the failure must not be rendered twice")
  assert.match(settings, /delay\(1_500\)[\s\S]*vm\.navigate\(Screen\.Chat\)/, "a successful pairing must show its result before leaving the form")
})

test("an unpaired chat leads to setup instead of offering messages it cannot send", () => {
  const chat = readFileSync(`${UI_DIR}/ChatScreen.kt`, "utf8")
  const empty = /private fun EmptyChat\([\s\S]*?\n}\n/.exec(chat)?.[0]
  assert.ok(empty, "EmptyChat must stay one composable")
  const start = empty.indexOf("if (!connected)")
  const end = empty.indexOf("} else {", start)
  assert.ok(start >= 0 && end > start, "the unpaired branch must stay separate from the connected suggestions")
  const unpaired = empty.slice(start, end)
  assert.match(unpaired, /先在「设置」填写服务器地址与访问令牌/, "the unpaired state must name the required fields")
  assert.match(unpaired, /text = "打开设置"/, "the unpaired state needs one action that opens setup")
  assert.match(unpaired, /onClick = onOpenSettings/, "that action must really navigate to settings")
  assert.doesNotMatch(
    unpaired,
    /"总结一下我今天的任务进展"|"查看服务器当前状态并给出建议"|"帮我写一个自动化脚本"/,
    "prompt suggestions imply the unpaired chat can already send",
  )
})

test("the settings screen previews the real API path and warns about phone loopback", () => {
  const scanner = readFileSync(SETTINGS_SOURCE, "utf8")
  const client = readFileSync(CLIENT_SOURCE, "utf8")
  assert.ok(scanner.includes("ApiFormat.apiUrl(normalized)"), "the settings field must preview /api/v1")
  assert.ok(scanner.includes("ApiFormat.connectionWarning(normalized)"), "the settings field must explain unreachable addresses")
  assert.ok(client.includes('host == "localhost" || host == "127.0.0.1"'), "loopback detection must cover localhost and 127.0.0.1")
  const address = /label = "服务器地址"[\s\S]*?\n\s*\)/.exec(scanner)?.[0]
  assert.ok(address, "the server address field must stay on the settings screen")
  assert.doesNotMatch(address, /singleLine = true/, "a long Instabox URL must wrap instead of hiding its host")
  assert.match(address, /maxLines = 3/, "three lines keep the host and suffix readable on a 720px phone")
})

test("the settings screen masks saved credentials until the user reveals them", () => {
  const scanner = readFileSync(SETTINGS_SOURCE, "utf8")
  assert.match(scanner, /var secretsVisible by remember \{ mutableStateOf\(false\) \}/, "credentials must start hidden on every visit")
  assert.match(
    scanner,
    /val secretTransformation = if \(secretsVisible\) VisualTransformation\.None else PasswordVisualTransformation\(\)/,
    "the token and encryption key must share the default-masked transformation",
  )
  for (const field of ["访问令牌", "加密密钥（可选）"]) {
    const start = scanner.indexOf(`label = "${field}"`)
    assert.ok(start >= 0, `${field} must stay on the settings screen`)
    const block = scanner.slice(start, start + 700)
    assert.ok(block.includes("visualTransformation = secretTransformation"), `${field} must use the masked transformation`)
  }
  assert.ok(scanner.includes('if (secretsVisible) "隐藏" else "显示"'), "there must be an explicit reveal/hide control")
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
 * and its Base64 both land on the heap, so large uploads could kill the process before any limit
 * was reported. The gate keeps that idiom out of the App; attachments now stream to disk.
 */
test("the Android source gate rejects reading a content stream into memory", () => {
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
    assert.match(bad.output, /Bad\.kt:\d+:.*stream it to disk instead/)

    const capped = [
      "package com.agentbot.app.data",
      "",
      "fun save(resolver: android.content.ContentResolver, uri: android.net.Uri, out: java.io.OutputStream) =",
      "    resolver.openInputStream(uri)!!.use { it.copyTo(out) }",
      "",
    ].join("\n")
    writeFileSync(join(pkg, "Bad.kt"), capped)
    const passed = runChecker(dir)
    assert.equal(passed.status, 0, `a streamed copy must pass:\n${passed.output}`)

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

test("the App gives large streamed uploads a long write timeout", () => {
  const client = readFileSync(CLIENT_SOURCE, "utf8")
  assert.match(client, /\.writeTimeout\(30, TimeUnit\.MINUTES\)/)
  assert.match(client, /asRequestBody\(att\.mime\.toMediaTypeOrNull\(\)\)/)
})

test("attachment sizes read the same before and after sending", () => {
  const store = readFileSync(LOCALSTORE_SOURCE, "utf8")
  const models = readFileSync("android/app/src/main/java/com/agentbot/app/data/ApiModels.kt", "utf8")
  const chat = readFileSync(`${UI_DIR}/ChatScreen.kt`, "utf8")
  const formatter = /fun formatFileSize\(bytes: Long\): String = when \{[\s\S]*?\n\}/.exec(store)?.[0]
  assert.ok(formatter, "one shared formatter must own attachment units")
  assert.match(formatter, /bytes < 1_024 -> "\$\{bytes\}B"/, "a few hundred bytes must stay exact, not round up to 1KB")
  assert.match(formatter, /bytes < 1_024L \* 1_024 -> "%\.1fKB"/, "kilobytes keep one decimal so 1.5KB is not shown as 2KB")
  assert.match(store, /val sizeLabel: String get\(\) = formatFileSize\(size\)/, "sent attachments must use the shared label")
  assert.match(models, /val sizeLabel: String get\(\) = formatFileSize\(size\)/, "reply media must use the same label")
  assert.match(chat, /formatFileSize\(att\.sizeBytes\)/, "the pre-send chip must use the same label")
  assert.doesNotMatch(chat, /private fun formatSize\(/, "the chip must not keep a second, rounding formatter")
})

/**
 * A phone loses the prompt when the network drops between tapping send and the server accepting
 * the task. The composer clears only after send() reports acceptance; the ViewModel must also put
 * the text back in the draft it could not submit, and keep the one-off engine/model so a retry
 * repeats the same request rather than silently switching engines.
 */
test("a rejected send gives the prompt and one-off model back", () => {
  const viewModel = readFileSync(VIEWMODEL_SOURCE, "utf8")
  const send = /fun send\(text: String\): Boolean \{[\s\S]*?\n    \}/.exec(viewModel)?.[0]
  assert.ok(send, "send must stay one function so its failure semantics can be checked")
  assert.match(send, /if \(draft\.isBlank\(\)\) updateDraft\(raw\)/, "a dropped send must restore the typed prompt")
  assert.match(send, /oneOffEngine = engine[\s\S]*?oneOffModel = model/, "a retry must keep the one-off engine and model")

  const chat = readFileSync(`${UI_DIR}/ChatScreen.kt`, "utf8")
  const submit = /fun submit\(text: String\) \{[\s\S]*?\n    \}/.exec(chat)?.[0]
  assert.ok(submit, "the chat's submit must stay one function")
  assert.match(
    submit,
    /if \(vm\.send\(text\)\) \{[\s\S]*?vm\.updateDraft\(""\)/,
    "the composer must clear only after send() accepted the prompt",
  )
})

test("the App and server keep only the attachment count cap", () => {
  const store = readFileSync(LOCALSTORE_SOURCE, "utf8")
  const input = readFileSync("src/attachmentInput.ts", "utf8")
  assert.match(store, /const val MAX_COUNT = 4/)
  for (const removed of ["MAX_TOTAL_BYTES", "MAX_FILE_BYTES", "MAX_VIDEO_BYTES", "attachmentLimit(", "readCapped("]) {
    assert.doesNotMatch(store, new RegExp(removed.replace("(", "\\(")), `${removed} must stay removed from the App`)
  }
  for (const removed of ["MAX_ATTACH_TOTAL_BYTES", "MAX_ATTACH_FILE_BYTES"]) {
    assert.doesNotMatch(input, new RegExp(removed), `${removed} must stay removed from the server`)
  }
  // An empty pick is still refused before upload; no byte cap is imposed beside it.
  assert.match(store, /target\.length\(\) == 0L/)
  assert.match(store, /resolver\.openInputStream\(uri\)\?\.use/)
})
