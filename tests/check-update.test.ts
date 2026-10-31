import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { OpsService, type OpsCommandResult } from "../src/ops.js"

interface Call {
  command: string
  args: string[]
}

function makeService(
  responses: (command: string, args: string[]) => OpsCommandResult | undefined,
  overrides: Partial<ConstructorParameters<typeof OpsService>[0]> = {},
): { ops: OpsService; calls: Call[] } {
  const calls: Call[] = []
  const ops = new OpsService({
    projectDir: mkdtempSync(join(tmpdir(), "bot-check-update-")),
    dataDir: ".",
    opencodeUrl: "http://127.0.0.1:4096",
    which: (bin) => `/usr/bin/${bin}`,
    run: async (command, args) => {
      calls.push({ command, args })
      return responses(command, args) ?? { code: 0, stdout: "", stderr: "" }
    },
    health: async () => false,
    ...overrides,
  })
  return { ops, calls }
}

function cleanup(ops: OpsService): void {
  // projectDir is a fresh temp dir per service; nothing is written during a dry run
  void ops
}

test("checkUpdate reports up to date when the branch matches upstream", async () => {
  const { ops } = makeService((command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "origin/main\n", stderr: "" }
    if (command === "git" && args[0] === "rev-list") return { code: 0, stdout: "0\n", stderr: "" }
    return undefined
  })
  try {
    const result = await ops.checkUpdate()
    assert.equal(result.ok, true)
    assert.match(result.message, /已是最新/)
    assert.match(result.message, /origin\/main/)
  } finally {
    cleanup(ops)
  }
})

test("checkUpdate lists pending commits when behind upstream", async () => {
  const { ops } = makeService((command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "origin/main\n", stderr: "" }
    if (command === "git" && args[0] === "rev-list") return { code: 0, stdout: "3\n", stderr: "" }
    if (command === "git" && args[0] === "log") {
      return { code: 0, stdout: "a1b2c3d 新功能\nb2c3d4e 修 bug\n", stderr: "" }
    }
    return undefined
  })
  try {
    const result = await ops.checkUpdate()
    assert.equal(result.ok, true)
    assert.match(result.message, /落后 3 个提交/)
    assert.match(result.message, /a1b2c3d 新功能/)
    assert.match(result.message, /\/update/)
  } finally {
    cleanup(ops)
  }
})

test("checkUpdate fails gracefully without an upstream branch or network", async () => {
  const noUpstream = makeService((command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { code: 128, stdout: "", stderr: "no upstream" }
    return undefined
  })
  try {
    const result = await noUpstream.ops.checkUpdate()
    assert.equal(result.ok, false)
    assert.match(result.message, /上游分支/)
  } finally {
    cleanup(noUpstream.ops)
  }

  const offline = makeService((command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "origin/main\n", stderr: "" }
    if (command === "git" && args[0] === "fetch") return { code: 128, stdout: "", stderr: "Could not resolve host" }
    return undefined
  })
  try {
    const result = await offline.ops.checkUpdate()
    assert.equal(result.ok, false)
    assert.match(result.message, /无法连接远端仓库/)
  } finally {
    cleanup(offline.ops)
  }
})

test("checkUpdate reports a missing git binary", async () => {
  const { ops } = makeService(() => undefined, { which: () => undefined })
  try {
    const result = await ops.checkUpdate()
    assert.equal(result.ok, false)
    assert.match(result.message, /未找到 git/)
  } finally {
    cleanup(ops)
  }
})

test("checkUpdate fetches before comparing and never pulls", async () => {
  const { ops, calls } = makeService((command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "origin/main\n", stderr: "" }
    if (command === "git" && args[0] === "rev-list") return { code: 0, stdout: "2\n", stderr: "" }
    return undefined
  })
  try {
    await ops.checkUpdate()
    const commands = calls.map((call) => `${call.command} ${call.args.join(" ")}`)
    assert.ok(commands.some((entry) => entry.startsWith("git fetch")))
    assert.ok(commands.some((entry) => entry.startsWith("git rev-list --count HEAD..origin/main")))
    assert.ok(!commands.some((entry) => entry.startsWith("git pull")))
    // The dry run never mutates the working tree
    assert.ok(!commands.some((entry) => entry.includes("merge") || entry.includes("rebase")))
  } finally {
    cleanup(ops)
  }
})
