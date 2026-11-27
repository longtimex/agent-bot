import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MAGPIE_UPDATE_TIMEOUT_MS,
  MagpieBusyError,
  MagpieError,
  MagpieRunError,
  MagpieService,
  assertAgent,
  assertModelRef,
  resolveMagpieBin,
  type MagpieRunner,
  type MagpieRunResult,
} from "../src/magpie.js"
import { routeMagpie } from "../src/apiMagpie.js"
import { ApiError } from "../src/apiCore.js"
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

test("addProvider masks an unlabelled key on success and on failure", async () => {
  // No sk- prefix and no key= label, so the generic redaction cannot recognise it
  const key = "relay7f3a9c2be1d04"
  const ok = service(() => ({ code: 0, stdout: `saved provider using ${key}` }))
  assert.doesNotMatch(await ok.svc.addProvider("deepseek", key), new RegExp(key))

  const failing = service(() => ({ code: 1, stderr: `rejected credential ${key} for deepseek` }))
  await assert.rejects(() => failing.svc.addProvider("deepseek", key), (err: unknown) => {
    assert.ok(err instanceof MagpieRunError)
    assert.doesNotMatch((err as Error).message, new RegExp(key), "the failure text must not carry the key")
    assert.match((err as Error).message, /\*\*\*/)
    return true
  })

  // A value that magpie would parse as its own flag never reaches argv
  const { svc, calls } = service(() => ({ code: 0, stdout: "" }))
  await assert.rejects(() => svc.addProvider("deepseek", "--force"), MagpieError)
  assert.equal(calls.length, 0)
})

test("magpie guards reject leading global flags and preserve hidden command detection", () => {
  assert.ok(magpieBlockedReason(["-v", "tui"], "Telegram"))
  assert.ok(magpieBlockedReason(["--config", "/tmp/x", "daemon", "stop"], "App"))
  assert.ok(magpieBlockedReason(["--json", "provider", "rm", "deepseek"], "App"))
  assert.equal(magpieBlockedReason(["--version"], "App"), undefined)
  assert.equal(magpieBlockedReason(["--help"], "App"), undefined)
  assert.ok(magpieConfirmPlan(["--verbose", "daemon", "stop"]))
  assert.equal(isLongMagpieCommand(["--verbose", "update"]), true)
})

test("MagpieService overview reports version errors and healthy() uses custom gateway probe", async () => {
  const probedUrls: string[] = []
  const broken = new MagpieService({
    bin: "magpie",
    gatewayUrl: "http://127.0.0.1:4555",
    runner: async () => ({ code: 1, stdout: "", stderr: "permission denied" }),
    healthProbe: async (url) => {
      probedUrls.push(url)
      return true
    },
  })
  const overview = await broken.overview()
  assert.equal(overview.available, true)
  assert.equal(overview.version, undefined)
  assert.match(overview.error ?? "", /permission denied/)
  assert.equal(overview.healthy, true)
  assert.deepEqual(probedUrls, ["http://127.0.0.1:4555"])
})

test("MagpieService.runWriteLocked serializes writes, allows re-entrancy and fails fast on conflict", async () => {
  const { svc } = service(() => ({ code: 0, stdout: "ok" }))
  let releaseFirst!: () => void
  let started!: () => void
  const firstReady = new Promise<void>((resolve) => {
    started = resolve
  })
  const p1 = svc.runWriteLocked(async () => {
    // Re-entrant nested write inside the same scope must not deadlock
    await svc.sync()
    await new Promise<void>((resolve) => {
      releaseFirst = resolve
      started()
    })
    return "first"
  })
  await firstReady
  await assert.rejects(() => svc.runWriteLocked(async () => "conflict", { failFast: true }), MagpieBusyError)
  const p2 = svc.runWriteLocked(async () => "second")
  releaseFirst()
  assert.equal(await p1, "first")
  assert.equal(await p2, "second")
})

test("MAGPIE_VIEWS.usage normalizes range case and runRaw masks unlabelled provider add keys", async () => {
  assert.deepEqual(MAGPIE_VIEWS.usage!.args("TODAY"), ["usage", "today"])
  assert.deepEqual(MAGPIE_VIEWS.usage!.args("7D"), ["usage", "7d"])

  const secret = "relayRawKey887766"
  const timeouts: number[] = []
  const svc = new MagpieService({
    bin: "magpie",
    runner: async (_args, opts) => {
      timeouts.push(opts.timeoutMs)
      return { code: 0, stdout: `saved ${secret}`, stderr: "" }
    },
  })
  const out = await svc.runRaw(["provider", "add", "deepseek", secret], MAGPIE_UPDATE_TIMEOUT_MS)
  assert.ok(!out.includes(secret))
  assert.equal(timeouts[0], MAGPIE_UPDATE_TIMEOUT_MS)
})

test("Telegram magpie confirmation protects token from other chats, redacts args and forwards update timeout", async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = []
  const sent: Array<{ text: string; keyboard?: unknown }> = []
  const fake = {
    available: true,
    overview: async () => ({
      available: true,
      bin: "/usr/local/bin/magpie",
      version: "1.2.3",
      gatewayUrl: "http://127.0.0.1:3425",
      healthy: true,
    }),
    runRaw: async (args: string[], timeoutMs?: number) => {
      calls.push({ args, timeoutMs })
      return "updated"
    },
  } as unknown as MagpieService
  const host = {
    sendText: async (_chatId: number, text: string, keyboard?: unknown) => {
      sent.push({ text, keyboard })
      return true
    },
    sendPanel: async () => {},
    editPanel: async () => {},
  }
  const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger
  const cmd = new MagpieCommands(host, fake, log)

  // Confirming an update must carry the 180s MAGPIE_UPDATE_TIMEOUT_MS timeout
  await cmd.handleCommand(10, "k", "update")
  const tokenMatch = /magpie:cfm:([0-9a-f]+)/.exec(JSON.stringify(sent.at(-1)!.keyboard))
  assert.ok(tokenMatch, "update must ask for confirmation")
  const token = tokenMatch![1]!

  // A different chat clicking the button must NOT delete chat 10's pending token
  await cmd.handleCallback({} as never, 99, `cfm:${token}`, async () => {})
  assert.match(sent.at(-1)!.text, /不属于当前会话/)
  assert.equal(calls.length, 0)

  // Original chat can still confirm after the rejected foreign click
  await cmd.handleCallback({} as never, 10, `cfm:${token}`, async () => {})
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, ["update"])
  assert.equal(calls[0]!.timeoutMs, MAGPIE_UPDATE_TIMEOUT_MS)

  // Confirmation card redacts secrets from echoed args and clearPending() invalidates tokens
  await cmd.handleCommand(10, "k", "settings set api_key sk-secret123456789")
  assert.ok(!sent.at(-1)!.text.includes("sk-secret123456789"))
  const token2 = /magpie:cfm:([0-9a-f]+)/.exec(JSON.stringify(sent.at(-1)!.keyboard))![1]!
  cmd.clearPending()
  await cmd.handleCallback({} as never, 10, `cfm:${token2}`, async () => {})
  assert.match(sent.at(-1)!.text, /已过期/)
})

test("routeMagpie preserves 409 lock conflicts, maps MagpieRunError to 502 and forwards update timeout", async () => {
  const timeouts: number[] = []
  let failCli = false
  const svc = new MagpieService({
    bin: "magpie",
    runner: async (args, opts) => {
      timeouts.push(opts.timeoutMs)
      if (failCli) return { code: 1, stdout: "", stderr: "upstream down" }
      return { code: 0, stdout: `ok ${args.join(" ")}`, stderr: "" }
    },
  })

  const responses: Array<{ status: number; body: unknown }> = []
  const callRoute = async (
    method: "GET" | "POST",
    id: string,
    body: Record<string, unknown> = {},
    query = "",
    busy = false,
  ) => {
    const deps = {
      magpie: svc,
      json: (_res: unknown, status: number, payload: unknown) => {
        responses.push({ status, body: payload })
      },
      readJsonBody: async () => body,
      magpieQuery: async <T>(run: () => Promise<T>) => {
        if (busy) throw new ApiError(409, "已有 magpie 操作在执行，请稍后再试")
        return run()
      },
      magpieRead: async <T>(run: () => Promise<T>) => run(),
    }
    await routeMagpie(
      deps as never,
      {
        method,
        req: {} as never,
        res: {} as never,
        url: new URL(`http://localhost/api/v1/magpie/${id}${query}`),
        segments: ["magpie", id],
        encrypted: false,
      },
      id,
      undefined,
    )
  }

  // 409 conflict must not be swallowed into 502 or 400
  await assert.rejects(
    () => callRoute("POST", "exec", { name: "sync" }, "", true),
    (err: unknown) => err instanceof ApiError && err.status === 409,
  )
  await assert.rejects(
    () => callRoute("POST", "provider", { preset: "deepseek", key: "k1" }, "", true),
    (err: unknown) => err instanceof ApiError && err.status === 409,
  )

  // Validation error on /provider stays 400; CLI failure (MagpieRunError) becomes 502
  await assert.rejects(
    () => callRoute("POST", "provider", { preset: "bad preset!", key: "k1" }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  )
  failCli = true
  await assert.rejects(
    () => callRoute("POST", "provider", { preset: "deepseek", key: "k1" }),
    (err: unknown) => err instanceof ApiError && err.status === 502,
  )
  failCli = false

  // Read-only /view bypasses the write lock
  await callRoute("GET", "view", {}, "?name=providers", true)
  assert.equal(responses.at(-1)!.status, 200)

  // `update` forwards MAGPIE_UPDATE_TIMEOUT_MS (180s)
  timeouts.length = 0
  await callRoute("POST", "exec", { name: "update", confirm: true })
  assert.equal(timeouts.at(-1), MAGPIE_UPDATE_TIMEOUT_MS)

  // Leading flag on /run is blocked with 400
  await assert.rejects(
    () => callRoute("POST", "run", { args: ["-v", "tui"], confirm: true }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  )
})
