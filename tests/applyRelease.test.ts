import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

test("apply-release delegates to the lifecycle CLI from a managed release", async () => {
  const dir = tempDir()
  try {
    // A managed install can lose the checkout build while a release is still
    // current. The wrapper must use that release's lifecycle CLI, not insist on
    // a dist/release-control.js from the old shell implementation.
    mkdirSync(join(dir, "scripts"), { recursive: true })
    mkdirSync(join(dir, "data", "releases", "store", "current", "dist"), { recursive: true })
    const release = join(dir, "data", "releases", "store", "current")
    writeFileSync(join(release, "dist", "index.js"), "process.exit(0)\n")
    writeFileSync(
      join(release, "dist", "bot-cli.js"),
      'if (process.argv[2] !== "restart") process.exit(2)\nconsole.log("lifecycle restart selected")\n',
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
    const result = await runScript(dir, {
      DATA_DIR: "data",
    })
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /lifecycle restart selected/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
