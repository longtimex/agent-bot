import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  buildToolDeps,
  runToolWizard,
  type DetectedTools,
  type ToolWizardDeps,
} from "../src/install-tools-cli.js"

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "install-tools-"))
}

function detected(overrides: Partial<DetectedTools> = {}): DetectedTools {
  return {
    agents: [
      { id: "claude", label: "Claude Code", installable: true },
      { id: "codex", label: "Codex CLI", bin: "/usr/bin/codex", installable: true },
      { id: "manual", label: "Manual CLI", installable: false },
    ],
    ...overrides,
  }
}

function harness(answers: string[], detection: DetectedTools = detected()): {
  deps: ToolWizardDeps
  calls: string[]
  output: string[]
} {
  const calls: string[] = []
  const output: string[] = []
  const queue = [...answers]
  const deps: ToolWizardDeps = {
    projectDir: process.cwd(),
    env: {},
    ask: async () => queue.shift() ?? "",
    print: (line = "") => output.push(line),
    installAgent: async (id) => {
      calls.push(`agent:${id}`)
      return { ok: true, message: "ok" }
    },
    installCommand: (id) => ({ ok: true, message: id, command: `install ${id}` }),
    runExternal: async (command, args, options) => {
      calls.push(`external:${command}:${args.join(" ")}:${JSON.stringify(options?.env ?? {})}`)
      return { ok: true, message: "ok" }
    },
    detect: async () => detection,
    isInteractive: true,
    yes: false,
    allowExternal: true,
  }
  return { deps, calls, output }
}

test("tool wizard detects agents and installs only the numbered selection", async () => {
  const h = harness(["1,3"])
  const result = await runToolWizard({ deps: h.deps })
  assert.equal(result.ok, true)
  assert.deepEqual(result.installed, ["claude", "cc-switch"])
  assert.equal(h.calls[0], "agent:claude")
  assert.match(h.calls[1] ?? "", /^external:bash:/)
  assert.doesNotMatch(h.calls.join("\n"), /agent:codex/, "an already installed agent must not be installed again")
  assert.ok(h.output.some((line) => line.includes("Codex CLI：/usr/bin/codex")))
})

test("tool wizard can install every missing managed tool with --yes", async () => {
  const h = harness([])
  const result = await runToolWizard({ deps: { ...h.deps, yes: true } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.installed, ["claude", "magpie", "cc-switch"])
  const magpieCall = h.calls.find((call) => call.startsWith("external:sh:")) ?? ""
  assert.match(magpieCall, /MAGPIE_BIN_DIR/)
  assert.match(magpieCall, /--tui/, "the installer must not pull GUI libraries onto a headless server")
  assert.match(h.calls.find((call) => call.startsWith("external:bash:")) ?? "", /CC_SWITCH_INSTALL_DIR/)
})

test("tool wizard reports no-op when all detected tools are present", async () => {
  const h = harness([])
  const result = await runToolWizard({
    deps: {
      ...h.deps,
      detect: async () => ({
        agents: [{ id: "codex", label: "Codex CLI", bin: "/usr/bin/codex", installable: true }],
        magpie: "/opt/magpie",
        ccSwitch: "/opt/cc-switch",
      }),
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.installed, [])
  assert.deepEqual(h.calls, [])
  assert.ok(h.output.some((line) => line.includes("所有可管理的工具均已安装")))
})

test("tool wizard detects only when external installation is disabled", async () => {
  const h = harness(["a"])
  const result = await runToolWizard({ deps: { ...h.deps, allowExternal: false } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.installed, [])
  assert.deepEqual(h.calls, [])
})

test("tool wizard accepts comma-separated choices and ignores out-of-range numbers", async () => {
  const h = harness(["1, 99, 2, 2"])
  const result = await runToolWizard({ deps: h.deps })
  assert.deepEqual(result.installed, ["claude", "magpie"])
  assert.deepEqual(h.calls.filter((call) => call.startsWith("agent:")), ["agent:claude"])
})

test("project .env drives a repo-local magpie and cc-switch detection", async () => {
  const dir = tempProject()
  try {
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "bin", "magpie"), "#!/bin/sh\n")
    writeFileSync(join(dir, "bin", "cc-switch"), "#!/bin/sh\n")
    chmodSync(join(dir, "bin", "magpie"), 0o755)
    chmodSync(join(dir, "bin", "cc-switch"), 0o755)
    writeFileSync(join(dir, ".env"), "PATH=\nDATA_DIR=./custom-data\n")
    const deps = buildToolDeps({ projectDir: dir, env: { PATH: "", DATA_DIR: "" } as NodeJS.ProcessEnv })
    const found = await deps.detect()
    assert.equal(found.magpie, join(dir, "bin", "magpie"))
    assert.equal(found.ccSwitch, join(dir, "bin", "cc-switch"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
