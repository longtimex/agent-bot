import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-apply-release-"))
}

function runScript(cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["scripts/apply-release.sh"], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk) => (output += String(chunk)))
    child.stderr.on("data", (chunk) => (output += String(chunk)))
    child.on("error", reject)
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

test("apply-release uses the current release's control CLI when the checkout has no dist", async () => {
  const dir = tempDir()
  try {
    // A minimal checkout: only scripts and the state file. There is deliberately
    // no dist/release-control.js, which is the state after a cleaned build.
    mkdirSync(join(dir, "scripts"), { recursive: true })
    mkdirSync(join(dir, "data", "releases", "store", "current", "dist"), { recursive: true })
    const release = join(dir, "data", "releases", "store", "current")
    // A runnable stand-in for the built entrypoint, and a minimal control CLI
    // that reads the same state shape as the real release-control.
    writeFileSync(join(release, "dist", "index.js"), "process.exit(0)\n")
    writeFileSync(
      join(release, "dist", "release-control.js"),
      [
        'const fs = require("fs")',
        'const path = require("path")',
        'const state = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR ?? "data", "releases", "state.json"), "utf8"))',
        'const current = state.current',
        'if (process.argv[2] === "entry" && current?.path) process.stdout.write(current.path + "/dist/index.js")',
        'if (process.argv[2] === "current-id" && current?.id) process.stdout.write(current.id)',
        "",
      ].join("\n"),
    )
    writeFileSync(join(release, "package.json"), JSON.stringify({ version: "0.5.0" }))
    writeFileSync(
      join(dir, "data", "releases", "state.json"),
      JSON.stringify({
        current: { id: "current", commit: "abcdef0123456789", version: "0.5.0", createdAt: "", path: release },
      }),
    )
    writeFileSync(
      join(dir, "scripts", "apply-release.sh"),
      readFileSync("scripts/apply-release.sh", "utf8"),
    )
    chmodSync(join(dir, "scripts", "apply-release.sh"), 0o755)
    // Avoid spawning a real bot: the script must fail at the health probe, after
    // selecting the release control CLI, with a log that proves selection occurred.
    const result = await runScript(dir, {
      DATA_DIR: "data",
      RELEASE_SUPERVISOR: "script",
      RELEASE_HEALTH_TIMEOUT: "1",
      RELEASE_HEALTH_INTERVAL: "1",
    })
    assert.notEqual(result.code, 0)
    const log = existsSync(join(dir, "data", "bot.log")) ? readFileSync(join(dir, "data", "bot.log"), "utf8") : ""
    assert.doesNotMatch(log, /release-control\.js is unavailable/)
    assert.match(log, /no pending release|started/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
