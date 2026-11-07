import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MagpieError,
  MagpieRunError,
  MagpieService,
  assertAgent,
  assertModelRef,
  resolveMagpieBin,
  type MagpieRunner,
  type MagpieRunResult,
} from "../src/magpie.js"
import { magpieBlockedReason, magpieConfirmPlan, isLongMagpieCommand } from "../src/magpieGuards.js"
import { MagpieCommands } from "../src/telegramMagpieCommands.js"
import type { Logger } from "../src/logger.js"
import { MAGPIE_EXEC, MAGPIE_VIEWS, assertMagpieArg, assertMagpieTarget, magpieExecPhrases, magpieViewPhrases } from "../src/apiMagpieSpecs.js"

function fakeRunner(handler: (args: string[]) => Partial<MagpieRunResult> | string): { runner: MagpieRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: MagpieRunner = async (args) => {
    calls.push(args)
    const result = handler(args)
    if (typeof result === "string") return { code: 0, stdout: result, stderr: "" }
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  }
  return { runner, calls }
}

function service(handler: (args: string[]) => Partial<MagpieRunResult> | string): { svc: MagpieService; calls: string[][] } {
  const { runner, calls } = fakeRunner(handler)
  const svc = new MagpieService({ runner, bin: "magpie", gatewayUrl: "http://127.0.0.1:3425" })
  return { svc, calls }
}

test("resolveMagpieBin prefers explicit, then ./bin, then PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-bin-"))
  try {
    const local = join(dir, "bin", "magpie")
    // no bin dir yet
    assert.equal(resolveMagpieBin(undefined, dir, { PATH: "" }), undefined)

    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(local, "#!/bin/sh\n")
    chmodSync(local, 0o755)
    assert.equal(resolveMagpieBin(undefined, dir, { PATH: "" }), local)
    assert.equal(resolveMagpieBin("magpie", dir, { PATH: join(dir, "bin") }), local)

    const custom = join(dir, "custom-magpie")
    writeFileSync(custom, "#!/bin/sh\n")
    chmodSync(custom, 0o755)
    assert.equal(resolveMagpieBin(custom, dir, { PATH: "" }), custom)
    assert.equal(resolveMagpieBin(join(dir, "missing"), dir, { PATH: "" }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("MagpieService reports version, gateway health and an overview", async () => {
  const { svc } = service((args) => {
    if (args[0] === "--version") return "magpie 1.2.3\n"
    if (args[0] === "healthcheck") return ""
    return ""
  })
  assert.equal(await svc.version(), "1.2.3")
  assert.equal(await svc.healthy(), true)
  const overview = await svc.overview()
  assert.equal(overview.available, true)
  assert.equal(overview.version, "1.2.3")
  assert.equal(overview.healthy, true)
  assert.equal(overview.gatewayUrl, "http://127.0.0.1:3425")
})

test("healthy() is false when healthcheck exits non-zero and never throws", async () => {
  const { svc } = service(() => ({ code: 1, stderr: "gateway down" }))
  assert.equal(await svc.healthy(), false)
})

test("a non-zero exit surfaces magpie's own error text", async () => {
  const { svc } = service(() => ({ code: 2, stderr: "Error: no such provider" }))
  await assert.rejects(() => svc.listProviders(), (err: unknown) => {
    assert.ok(err instanceof MagpieRunError)
    assert.match((err as Error).message, /no such provider/)
    return true
  })
})

test("setAgentModel validates the agent and model before spawning", async () => {
  const { svc, calls } = service(() => ({ code: 0, stdout: "ok" }))
  await svc.setAgentModel("claude", "deepseek/deepseek-chat")
  assert.deepEqual(calls.at(-1), ["claude", "deepseek/deepseek-chat"])
  await assert.rejects(() => svc.setAgentModel("-bad", "x/y"), MagpieError)
  await assert.rejects(() => svc.setAgentModel("claude", "-bad"), MagpieError)
  await assert.rejects(() => svc.setAgentModel("claude", "a b"), MagpieError)
})

test("addProvider never echoes the key in its result", async () => {
  const key = "sk-very-secret-key-value"
  const { svc, calls } = service((args) => ({ code: 0, stdout: `added with ${args[3]}` }))
  const text = await svc.addProvider("deepseek", key)
  assert.deepEqual(calls.at(-1), ["provider", "add", "deepseek", key])
  assert.doesNotMatch(text, /sk-very-secret-key-value/)
  assert.match(text, /sk-\*\*\*/)
})

test("providerAction only accepts the three whitelisted verbs", async () => {
  const { svc, calls } = service(() => ({ code: 0, stdout: "" }))
  await svc.providerAction("test", "deepseek")
  assert.deepEqual(calls.at(-1), ["provider", "test", "deepseek"])
  await assert.rejects(() => svc.providerAction("rm", "x; reboot"), MagpieError)
})

test("addGroup requires key=value pairs and validates the name", async () => {
  const { svc, calls } = service(() => ({ code: 0, stdout: "" }))
  await svc.addGroup("daily", ["models=a/b,c/d", "routing=smart"])
  assert.deepEqual(calls.at(-1), ["group", "add", "daily", "models=a/b,c/d", "routing=smart"])
  await assert.rejects(() => svc.addGroup("bad name", ["models=a/b"]), MagpieError)
  await assert.rejects(() => svc.addGroup("daily", ["--evil"]), MagpieError)
  await assert.rejects(() => svc.addGroup("daily", []), MagpieError)
})

test("usage only forwards known windows", async () => {
  const { svc, calls } = service(() => ({ code: 0, stdout: "" }))
  await svc.usage("today")
  assert.deepEqual(calls.at(-1), ["usage", "today"])
  await svc.usage("../../etc")
  assert.deepEqual(calls.at(-1), ["usage"])
})

test("guards block window/foreground/interactive commands", () => {
  for (const args of [["tui"], ["web"], ["serve"], ["plugin", "add", "x"], ["accounts", "add"], ["gateway-key", "list"]]) {
    assert.ok(magpieBlockedReason(args, "Telegram"), `expected ${args.join(" ")} to be blocked`)
  }
  assert.equal(magpieBlockedReason(["providers"], "Telegram"), undefined)
  assert.equal(magpieBlockedReason(["accounts"], "Telegram"), undefined)
})

test("guards ask for confirmation on destructive writes", () => {
  for (const args of [
    ["provider", "rm", "deepseek"],
    ["group", "rm", "daily"],
    ["daemon", "stop"],
    ["daemon", "start"],
    ["update"],
    ["use", "work"],
    ["rm", "work"],
    ["settings", "set", "theme", "dark"],
  ]) {
    assert.ok(magpieConfirmPlan(args), `expected ${args.join(" ")} to need confirmation`)
  }
  assert.equal(magpieConfirmPlan(["providers"]), undefined)
  assert.equal(magpieConfirmPlan(["update", "check"]), undefined)
  assert.equal(magpieConfirmPlan(["sync"]), undefined)
})

test("long-running commands are classified", () => {
  assert.equal(isLongMagpieCommand(["quota"]), true)
  assert.equal(isLongMagpieCommand(["provider", "test", "x"]), true)
  assert.equal(isLongMagpieCommand(["sync"]), true)
  assert.equal(isLongMagpieCommand(["providers"]), false)
  assert.equal(isLongMagpieCommand(["daemon", "status"]), false)
})

test("view and exec phrases resolve longest-first without collisions", () => {
  const views = magpieViewPhrases()
  const execs = magpieExecPhrases()
  // `provider list` must win over the bare `provider` view phrase does not exist; check names exist.
  for (const [, name] of views) assert.ok(Object.hasOwn(MAGPIE_VIEWS, name))
  for (const [, name] of execs) assert.ok(Object.hasOwn(MAGPIE_EXEC, name))
  const firstPhrase = execs.find(([, name]) => name === "provider-rm")?.[0]
  assert.deepEqual(firstPhrase, ["provider", "rm"])
})

test("target and argv validation reject injection-shaped words", () => {
  assert.equal(assertMagpieTarget("deepseek/deepseek-chat", "模型"), "deepseek/deepseek-chat")
  assert.throws(() => assertMagpieTarget("--help", "ID"))
  assert.throws(() => assertMagpieTarget("a/../../etc", "ID"))
  assert.throws(() => assertMagpieTarget("a\nb", "ID"))
  assert.equal(assertMagpieArg("--json"), "--json")
  assert.throws(() => assertMagpieArg("a\u0000b"))
  assert.throws(() => assertMagpieArg(""))
})

test("assertAgent / assertModelRef trim and normalise", () => {
  assert.equal(assertAgent("  Claude "), "claude")
  assert.equal(assertModelRef(" deepseek/deepseek-chat "), "deepseek/deepseek-chat")
})

test("Telegram routing keeps a non-target view from swallowing write commands", async () => {
  const calls: string[] = []
  const sent: string[] = []
  const fake = {
    available: true,
    overview: async () => ({
      available: true,
      bin: "/usr/local/bin/magpie",
      version: "1.2.3",
      gatewayUrl: "http://127.0.0.1:3425",
      healthy: false,
    }),
    runRaw: async (args: string[]) => {
      calls.push(args.join(" "))
      return "ok"
    },
    showAgent: async (agent: string) => `agent ${agent}`,
    setAgentModel: async (agent: string, model: string) => `set ${agent} ${model}`,
    addProvider: async (preset: string) => `add ${preset}`,
    addGroup: async (name: string) => `group ${name}`,
  } as unknown as MagpieService
  const host = {
    sendText: async (_chatId: number, text: string) => {
      sent.push(text)
      return true
    },
    sendPanel: async (_chatId: number, panel: { text: string }) => {
      sent.push(panel.text)
    },
    editPanel: async () => {},
  }
  const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger
  const cmd = new MagpieCommands(host, fake, log)

  await cmd.handleCommand(1, "k", "settings list")
  assert.equal(calls.at(-1), "settings list")

  // `settings set …` must not be read as the settings view with a target; it asks first.
  sent.length = 0
  await cmd.handleCommand(1, "k", "settings set theme dark")
  assert.equal(calls.includes("settings set theme dark"), false)
  assert.ok(sent.some((text) => text.includes("需要确认")), "a settings write should ask for confirmation")

  // `accounts claude` is a real magpie command, not the accounts view with a target.
  await cmd.handleCommand(1, "k", "accounts claude")
  assert.equal(calls.at(-1), "accounts claude")

  // Window/foreground words get the guard's explanation, not an "unknown command" reply.
  sent.length = 0
  await cmd.handleCommand(1, "k", "tui")
  assert.ok(sent.some((text) => text.includes("全屏交互界面")))
})
