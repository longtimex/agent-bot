import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ReleaseManager, type ReleaseManagerOptions } from "../src/releaseManager.js"
import type { OpsCommandResult } from "../src/ops.js"

interface Call {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-release-"))
}

function service(
  dir: string,
  responses: (command: string, args: string[], cwd: string) => OpsCommandResult | undefined = () => undefined,
  overrides: Partial<ReleaseManagerOptions> = {},
): { release: ReleaseManager; calls: Call[] } {
  const calls: Call[] = []
  const release = new ReleaseManager({
    projectDir: dir,
    dataDir: join(dir, "data"),
    which: (bin) => `/usr/bin/${bin}`,
    run: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env })
      return responses(command, args, options.cwd) ?? { code: 0, stdout: "", stderr: "" }
    },
    ...overrides,
  })
  return { release, calls }
}

test("release build runs in a staging clone and leaves the checkout untouched", async () => {
  const dir = tempDir()
  const oldNodeOptions = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = "--require /tmp/hosted-browser-preload.cjs"
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }))
    const { release, calls } = service(dir, (command, args, cwd) => {
      if (command.endsWith("git") && args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "https://github.com/longtimex/agent-bot.git\n", stderr: "" }
      }
      if (command.endsWith("git") && args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" }
      }
      if (command.endsWith("git") && args[0] === "status") return { code: 0, stdout: "", stderr: "" }
      if (command.endsWith("git") && args[0] === "clone") {
        mkdirSync(args.at(-1)!, { recursive: true })
        writeFileSync(join(args.at(-1)!, "package-lock.json"), "{}")
        writeFileSync(join(args.at(-1)!, "package.json"), JSON.stringify({ version: "0.4.0" }))
        return { code: 0, stdout: "", stderr: "" }
      }
      if (command.endsWith("git") && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" }
      }
      if (command.endsWith("npm") && args[0] === "ci") {
        mkdirSync(join(cwd, "node_modules"), { recursive: true })
        return { code: 0, stdout: "installed\n", stderr: "" }
      }
      if (command.endsWith("npm") && args[0] === "run" && args[1] === "check:release") {
        return { code: 0, stdout: "gate ok\n", stderr: "" }
      }
      if (command.endsWith("npm") && args[0] === "run" && args[1] === "build") {
        mkdirSync(join(cwd, "dist"), { recursive: true })
        writeFileSync(join(cwd, "dist", "index.js"), "// built\n")
        return { code: 0, stdout: "build ok\n", stderr: "" }
      }
      return undefined
    })

    const result = await release.buildStaging()
    assert.equal(result.ok, true, result.message)
    assert.equal(result.release?.version, "0.4.0")
    assert.ok(result.release?.path.startsWith(join(dir, "data", "releases", "store")))
    const clone = calls.find((call) => call.args[0] === "clone")
    assert.ok(clone)
    assert.equal(clone.args[1], "--no-hardlinks", "clone must not bake a hardlink to the running checkout")
    assert.equal(clone.args[3], "https://github.com/longtimex/agent-bot.git")
    assert.notEqual(clone.args[3], dir, "staging must come from origin, not the local checkout's stale refs")
    assert.ok(calls.some((call) => call.args[0] === "ci"))
    assert.ok(calls.some((call) => call.args[0] === "run" && call.args[1] === "check:release"))
    const npmCalls = calls.filter((call) => call.command.endsWith("npm"))
    assert.ok(npmCalls.length > 0)
    assert.ok(npmCalls.every((call) => !("NODE_OPTIONS" in call.env)), "npm must not inherit the host's Node preload")
    assert.ok(npmCalls.every((call) => !("DATA_DIR" in call.env)), "npm must not point the gate at the live data directory")
    assert.equal(release.readState().current, undefined, "building must not activate a release")
    assert.equal(release.readState().pending?.commit, "0123456789abcdef0123456789abcdef01234567")
  } finally {
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = oldNodeOptions
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failed release gate never records a usable pending release", async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }))
    const { release } = service(dir, (command, args, cwd) => {
      if (command.endsWith("git") && args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "https://github.com/longtimex/agent-bot.git\n", stderr: "" }
      }
      if (command.endsWith("git") && args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" }
      }
      if (command.endsWith("git") && args[0] === "status") return { code: 0, stdout: "", stderr: "" }
      if (command.endsWith("git") && args[0] === "clone") {
        mkdirSync(args.at(-1)!, { recursive: true })
        return { code: 0, stdout: "", stderr: "" }
      }
      if (command.endsWith("git") && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "deadbeef\n", stderr: "" }
      }
      if (command.endsWith("npm") && args[0] === "run" && args[1] === "check:release") {
        return { code: 1, stdout: "", stderr: "test failed\n" }
      }
      if (command.endsWith("npm") && args[0] === "ci") {
        mkdirSync(join(cwd, "node_modules"), { recursive: true })
        writeFileSync(join(cwd, "package-lock.json"), "{}")
        writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.4.0" }))
        return { code: 0, stdout: "installed\n", stderr: "" }
      }
      return undefined
    })
    const result = await release.buildStaging()
    assert.equal(result.ok, false)
    assert.match(result.message, /门禁/)
    assert.equal(release.readState().pending, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("activate and rollback move only state references", () => {
  const dir = tempDir()
  try {
    const { release } = service(dir)
    const make = (id: string, _commit: string): string => {
      const path = join(dir, "data", "releases", "store", id)
      mkdirSync(join(path, "dist"), { recursive: true })
      writeFileSync(join(path, "dist", "index.js"), `// ${id}\n`)
      writeFileSync(join(path, "package.json"), JSON.stringify({ version: "1.0.0" }))
      return path
    }
    const oldPath = make("old", "aaaa")
    const newPath = make("new", "bbbb")
    release.writeState({
      current: { id: "old", commit: "aaaa", version: "1.0.0", createdAt: "", path: oldPath },
      pending: { id: "new", commit: "bbbb", version: "1.0.0", createdAt: "", path: newPath },
    })
    assert.equal(release.activatePending().ok, true)
    assert.equal(release.readState().current?.id, "new")
    assert.equal(release.readState().previous?.id, "old")
    assert.equal(release.rollback().ok, true)
    assert.equal(release.readState().current?.id, "old")
    assert.equal(release.readState().previous?.id, "new")
    assert.equal(JSON.parse(readFileSync(join(dir, "data", "releases", "state.json"), "utf8")).current.id, "old")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the first managed activation keeps the checkout as its rollback target", () => {
  const dir = tempDir()
  try {
    const { release } = service(dir)
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "index.js"), "// checkout\n")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }))
    const releasePath = join(dir, "data", "releases", "store", "new")
    mkdirSync(join(releasePath, "dist"), { recursive: true })
    writeFileSync(join(releasePath, "dist", "index.js"), "// new\n")
    writeFileSync(join(releasePath, "package.json"), JSON.stringify({ version: "0.4.0" }))
    release.writeState({
      pending: {
        id: "new",
        commit: "bbbb",
        version: "0.4.0",
        createdAt: "",
        path: releasePath,
        previousCommit: "aaaa",
      },
    })

    assert.equal(release.activatePending().ok, true)
    const state = release.readState()
    assert.equal(state.current?.id, "new")
    assert.equal(state.previous?.id, "checkout")
    assert.equal(state.previous?.path, dir)
    assert.equal(state.previous?.commit, "aaaa")
    assert.equal(release.rollback().ok, true)
    assert.equal(release.readState().current?.id, "checkout")
    assert.equal(release.readState().current?.path, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("release build refuses to guess when origin has no URL", async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }))
    const { release, calls } = service(dir, (command, args) => {
      if (command.endsWith("git") && args[0] === "status") return { code: 0, stdout: "", stderr: "" }
      if (command.endsWith("git") && args[0] === "remote" && args[1] === "get-url") {
        return { code: 128, stdout: "", stderr: "No such remote 'origin'\n" }
      }
      return undefined
    })
    const result = await release.buildStaging()
    assert.equal(result.ok, false)
    assert.match(result.message, /origin/)
    assert.equal(calls.some((call) => call.args[0] === "clone"), false)
    assert.equal(release.readState().pending, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
