import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { AgentCliRegistry } from "../src/agentCli.js"
import { AgentCliInstaller, type AgentCommandResult } from "../src/agentInstaller.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeExecutable(path: string, body = "#!/bin/sh\nexit 0\n"): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

interface Fixture {
  dir: string
  manifest: string
  registry: AgentCliRegistry
  bin: string
  pyBin: string
  calls: Array<{ command: string; args: string[] }>
  installer: (options?: { which?: (bin: string) => string | undefined; run?: (command: string, args: string[]) => Promise<AgentCommandResult> }) => AgentCliInstaller
}

function fixture(): Fixture {
  const dir = tempDir("agent-installer-")
  const bin = join(dir, "bin", "demo")
  const pyBin = join(dir, "bin", "pydemo")
  const configPath = join(dir, "agents.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        demo: {
          label: "Demo CLI",
          bin,
          installSpec: { method: "npm", package: "@scope/demo" },
          sessionMode: "stateless",
          parse: "text",
          args: {},
        },
        pydemo: {
          label: "Py Demo",
          bin: pyBin,
          installSpec: { method: "pip", package: "demo-py" },
          sessionMode: "stateless",
          parse: "text",
          args: {},
        },
        manual: {
          label: "Manual CLI",
          bin: join(dir, "bin", "manual"),
          install: "see https://example.com/install",
          sessionMode: "stateless",
          parse: "text",
          args: {},
        },
      },
    }),
  )
  const registry = new AgentCliRegistry({ path: configPath, log })
  const manifest = join(dir, "agent-cli-installs.json")
  const calls: Array<{ command: string; args: string[] }> = []

  const defaultRun = async (command: string, args: string[]): Promise<AgentCommandResult> => {
    calls.push({ command, args })
    if (args.includes("uninstall")) {
      rmSync(args.at(-1) === "@scope/demo" ? bin : pyBin, { force: true })
      return { code: 0, stdout: "removed", stderr: "" }
    }
    if (args.includes("install")) {
      writeExecutable(args.at(-1) === "@scope/demo" ? bin : pyBin)
      return { code: 0, stdout: "added 1 package", stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }

  const which = (value: string): string | undefined => {
    if (value === "npm") return "/fake/npm"
    if (value === "python3") return "/fake/python3"
    return undefined
  }

  return {
    dir,
    manifest,
    registry,
    bin,
    pyBin,
    calls,
    installer: (options = {}) =>
      new AgentCliInstaller(manifest, registry, log, {
        which: options.which ?? which,
        run: options.run ?? defaultRun,
        timeoutMs: 5_000,
      }),
  }
}

test("installer catalog exposes npm/pip specs and manual profiles", () => {
  const f = fixture()
  try {
    const installer = f.installer()
    const ids = installer.installable().map((profile) => profile.id)
    assert.ok(ids.includes("demo"))
    assert.ok(ids.includes("pydemo"))
    assert.ok(ids.includes("claude"))
    assert.ok(ids.includes("aider"))
    assert.ok(!ids.includes("manual"))
    assert.equal(installer.installCommand(f.registry.get("demo")!), "npm install -g @scope/demo")
    assert.equal(installer.installCommand(f.registry.get("pydemo")!), "python3 -m pip install --user demo-py")
    assert.equal(installer.installCommand(f.registry.get("manual")!), undefined)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer installs npm CLIs, records the manifest and reports the bin", async () => {
  const f = fixture()
  try {
    const installer = f.installer()
    const result = await installer.install("demo")
    assert.equal(result.ok, true)
    assert.match(result.message, /已安装 Demo CLI/)
    assert.deepEqual(f.calls[0], { command: "/fake/npm", args: ["install", "-g", "@scope/demo"] })
    assert.ok(f.registry.binPath(f.registry.get("demo")!))
    assert.equal(installer.isManaged("demo"), true)
    assert.equal(installer.managed()[0]?.package, "@scope/demo")

    const saved = JSON.parse(readFileSync(f.manifest, "utf8")) as Record<string, { package: string }>
    assert.equal(saved.demo?.package, "@scope/demo")

    const again = await installer.install("demo")
    assert.equal(again.ok, false)
    assert.match(again.message, /已检测到/)
    assert.equal(f.calls.length, 1)

    const reloaded = f.installer()
    assert.equal(reloaded.isManaged("demo"), true)
    assert.equal(reloaded.uninstallCommand("demo"), "npm uninstall -g @scope/demo")
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer installs pip CLIs through python3", async () => {
  const f = fixture()
  try {
    const installer = f.installer()
    const result = await installer.install("pydemo")
    assert.equal(result.ok, true)
    assert.deepEqual(f.calls[0], { command: "/fake/python3", args: ["-m", "pip", "install", "--user", "demo-py"] })
    assert.ok(f.registry.binPath(f.registry.get("pydemo")!))
    assert.equal(installer.uninstallCommand("pydemo"), "python3 -m pip uninstall -y demo-py")
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer only uninstalls bot-managed CLIs", async () => {
  const f = fixture()
  try {
    const installer = f.installer()
    const unmanaged = await installer.uninstall("claude")
    assert.equal(unmanaged.ok, false)
    assert.match(unmanaged.message, /只能卸载由 Bot/)

    await installer.install("demo")
    const removed = await installer.uninstall("demo")
    assert.equal(removed.ok, true)
    assert.deepEqual(f.calls.at(-1), { command: "/fake/npm", args: ["uninstall", "-g", "@scope/demo"] })
    assert.equal(installer.isManaged("demo"), false)
    assert.equal(f.registry.binPath(f.registry.get("demo")!), undefined)
    assert.deepEqual(JSON.parse(readFileSync(f.manifest, "utf8")), {})
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer updates only bot-managed CLIs in place", async () => {
  const f = fixture()
  try {
    const installer = f.installer()
    const unmanaged = await installer.update("demo")
    assert.equal(unmanaged.ok, false)
    assert.match(unmanaged.message, /只能更新由 Bot/)
    assert.equal(installer.updateCommand("demo"), undefined)
    assert.equal(f.calls.length, 0)

    await installer.install("demo")
    assert.equal(installer.updateCommand("demo"), "npm install -g @scope/demo")
    const updated = await installer.update("demo")
    assert.equal(updated.ok, true)
    assert.match(updated.message, /已更新 Demo CLI/)
    assert.deepEqual(f.calls.at(-1), { command: "/fake/npm", args: ["install", "-g", "@scope/demo"] })
    assert.equal(installer.isManaged("demo"), true)
    assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).demo.package, "@scope/demo")
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer keeps the managed record when an update fails", async () => {
  const f = fixture()
  try {
    const okInstaller = f.installer()
    await okInstaller.install("demo")
    const failing = f.installer({
      run: async () => ({ code: 1, stdout: "", stderr: "network down" }),
    })
    const result = await failing.update("demo")
    assert.equal(result.ok, false)
    assert.match(result.message, /更新命令退出码 1/)
    assert.equal(failing.isManaged("demo"), true)

    const reloaded = f.installer()
    assert.equal(reloaded.isManaged("demo"), true)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer reports unsupported profiles and missing package managers", async () => {
  const f = fixture()
  try {
    const manual = await f.installer().install("manual")
    assert.equal(manual.ok, false)
    assert.match(manual.message, /暂不支持/)
    assert.match(manual.message, /example\.com/)

    const noNpm = await f.installer({ which: () => undefined }).install("demo")
    assert.equal(noNpm.ok, false)
    assert.match(noNpm.message, /未找到 npm/)
    assert.equal(f.calls.length, 0)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer surfaces failures and does not record a managed install", async () => {
  const f = fixture()
  try {
    const failing = f.installer({
      run: async () => ({ code: 1, stdout: "", stderr: "npm ERR! EACCES: permission denied" }),
    })
    const result = await failing.install("demo")
    assert.equal(result.ok, false)
    assert.match(result.message, /退出码 1/)
    assert.match(result.output ?? "", /EACCES/)
    assert.equal(failing.isManaged("demo"), false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer rejects concurrent operations", async () => {
  const f = fixture()
  try {
    let release!: (result: AgentCommandResult) => void
    const gate = new Promise<AgentCommandResult>((resolve) => {
      release = resolve
    })
    const installer = f.installer({ run: async () => gate })
    const first = installer.install("demo")
    await new Promise<void>((resolve) => setImmediate(resolve))
    const second = await installer.install("demo")
    assert.equal(second.ok, false)
    assert.match(second.message, /正在进行/)
    release({ code: 0, stdout: "", stderr: "" })
    await first
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer ignores inherited prototype keys", async () => {
  const f = fixture()
  try {
    const installer = f.installer()
    assert.equal(installer.isManaged("constructor"), false)
    assert.equal(installer.updateCommand("toString"), undefined)
    assert.equal(installer.uninstallCommand("__proto__"), undefined)

    const updated = await installer.update("constructor")
    assert.equal(updated.ok, false)
    assert.match(updated.message, /只能更新由 Bot/)

    const removed = await installer.uninstall("toString")
    assert.equal(removed.ok, false)
    assert.match(removed.message, /只能卸载由 Bot/)
    assert.equal(f.calls.length, 0)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer retries with user-level flags and reuses them for update and uninstall", async () => {
  const f = fixture()
  const home = tempDir("agent-installer-home-")
  const previousHome = process.env.HOME
  process.env.HOME = home
  const prefix = join(home, ".npm-global")
  const run = async (command: string, args: string[]): Promise<AgentCommandResult> => {
    f.calls.push({ command, args })
    if (args.includes(`--prefix=${prefix}`)) {
      writeExecutable(f.bin)
      return { code: 0, stdout: "added 1 package", stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "npm ERR! code EACCES\nnpm ERR! permission denied, mkdir '/usr/lib/node_modules'" }
  }
  try {
    const installer = f.installer({ run })
    const installed = await installer.install("demo")
    assert.equal(installed.ok, true)
    assert.equal(f.calls.length, 2)
    assert.ok(installed.message.includes(prefix))

    const saved = JSON.parse(readFileSync(f.manifest, "utf8")) as Record<string, { extraArgs?: string[] }>
    assert.deepEqual(saved.demo?.extraArgs, [`--prefix=${prefix}`])

    for (const action of [() => installer.update("demo"), () => installer.uninstall("demo")]) {
      const before = f.calls.length
      const result = await action()
      assert.equal(result.ok, true)
      assert.ok(f.calls.at(-1)!.args.includes(`--prefix=${prefix}`), "recorded flags must be reused")
      assert.equal(f.calls.length, before + 1, "no retry once the flags are known")
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("installer retries pip installs blocked by an externally managed environment", async () => {
  const f = fixture()
  const run = async (command: string, args: string[]): Promise<AgentCommandResult> => {
    f.calls.push({ command, args })
    if (args.includes("uninstall")) {
      // PEP 668 blocks uninstall too, so the recorded flag must be repeated
      if (!args.includes("--break-system-packages")) {
        return { code: 1, stdout: "", stderr: "error: externally-managed-environment" }
      }
      rmSync(f.pyBin, { force: true })
      return { code: 0, stdout: "Successfully uninstalled demo-py", stderr: "" }
    }
    if (args.includes("--break-system-packages")) {
      writeExecutable(f.pyBin)
      return { code: 0, stdout: "Successfully installed demo-py", stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "error: externally-managed-environment" }
  }
  try {
    const installer = f.installer({ run })
    const result = await installer.install("pydemo")
    assert.equal(result.ok, true)
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1]!.args, ["-m", "pip", "install", "--user", "--break-system-packages", "demo-py"])
    assert.equal(
      installer.uninstallCommand("pydemo"),
      "python3 -m pip uninstall -y --break-system-packages demo-py",
    )

    const removed = await installer.uninstall("pydemo")
    assert.equal(removed.ok, true, "uninstall must reuse the recorded flag")
    assert.deepEqual(f.calls.at(-1)!.args, ["-m", "pip", "uninstall", "-y", "--break-system-packages", "demo-py"])
    assert.equal(installer.isManaged("pydemo"), false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("update retries when the install location became unwritable after install", async () => {
  const f = fixture()
  const home = tempDir("agent-installer-home-")
  const previousHome = process.env.HOME
  process.env.HOME = home
  const prefix = join(home, ".npm-global")
  let blockPlainInstall = false
  const run = async (command: string, args: string[]): Promise<AgentCommandResult> => {
    f.calls.push({ command, args })
    if (args.includes("install") && blockPlainInstall && !args.includes(`--prefix=${prefix}`)) {
      return { code: 1, stdout: "", stderr: "npm ERR! code EACCES\nnpm ERR! permission denied, mkdir '/usr/lib/node_modules'" }
    }
    writeExecutable(f.bin)
    return { code: 0, stdout: "changed 1 package", stderr: "" }
  }
  try {
    const installer = f.installer({ run })
    const installed = await installer.install("demo")
    assert.equal(installed.ok, true)
    assert.equal(installer.updateCommand("demo"), "npm install -g @scope/demo")

    // The global prefix turned unwritable after the fact, e.g. the service was re-imaged
    blockPlainInstall = true
    const first = await installer.update("demo")
    assert.equal(first.ok, true, "an EACCES on update must not be terminal")
    assert.equal(f.calls.length, 3, "one failed attempt plus one retry")
    assert.deepEqual(f.calls.at(-1)!.args, ["install", "-g", `--prefix=${prefix}`, "@scope/demo"])
    assert.ok(first.message.includes(prefix))
    assert.equal(installer.updateCommand("demo"), `npm install -g --prefix=${prefix} @scope/demo`)

    const saved = JSON.parse(readFileSync(f.manifest, "utf8")) as Record<string, { extraArgs?: string[] }>
    assert.deepEqual(saved.demo?.extraArgs, [`--prefix=${prefix}`])

    const second = await installer.update("demo")
    assert.equal(second.ok, true)
    assert.equal(f.calls.length, 4, "the recorded fallback flags are reused without retrying")
    assert.equal(second.message.includes(prefix), false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("a corrupt install record is quarantined instead of silently replaced", async () => {
  const f = fixture()
  try {
    writeFileSync(f.manifest, '{"demo": {"engine": "demo", "method": "npm"')
    const installer = f.installer()
    assert.equal(installer.managed().length, 0)
    assert.equal(installer.isManaged("demo"), false)

    const result = await installer.install("demo")
    assert.equal(result.ok, true, result.message)
    assert.equal(installer.isManaged("demo"), true)

    const dir = dirname(f.manifest)
    const aside = readdirSync(dir).filter((name) => name.startsWith("agent-cli-installs.json.corrupt-"))
    assert.equal(aside.length, 1, readdirSync(dir).join(", "))
    assert.match(readFileSync(join(dir, aside[0]!), "utf8"), /"engine": "demo"/)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
