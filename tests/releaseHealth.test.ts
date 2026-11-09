import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

interface ProbeResult {
  code: number | null
  stdout: string
  stderr: string
}

function runProbe(cwd: string, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "scripts", "release-health.mjs")], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function writeStartup(dir: string, overrides: Record<string, unknown> = {}): void {
  const data = join(dir, "data")
  mkdirSync(data, { recursive: true })
  writeFileSync(
    join(data, "startup-check.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      version: "0.4.0",
      pid: process.pid,
      release: "release-new",
      migration: { ok: true, toVersion: 1, message: "数据 schema 已是最新（v1）。" },
      api: { requested: false, reachable: false },
      notes: ["Telegram 已连接"],
      ...overrides,
    }),
  )
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bot-release-health-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("release health accepts a fresh Telegram-only startup check without an API", async () => {
  await withDir(async (dir) => {
    writeStartup(dir)
    const result = await runProbe(dir, {
      API_ENABLED: "0",
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_EXPECTED_PID: String(process.pid),
      RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /local startup ok 0\.4\.0/)
    assert.match(result.stdout, new RegExp(`pid ${process.pid}`))
  })
})

test("release health falls back to the startup check when the API has no token", async () => {
  await withDir(async (dir) => {
    writeStartup(dir)
    const result = await runProbe(dir, {
      API_ENABLED: "1",
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /local startup ok/)
  })
})

test("release health rejects stale, failed or mismatched startup checks", async () => {
  await withDir(async (dir) => {
    const startedAt = new Date()
    writeStartup(dir, { at: new Date(startedAt.getTime() - 1_000).toISOString() })
    const stale = await runProbe(dir, {
      API_ENABLED: "0",
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_START_AT: startedAt.toISOString(),
    })
    assert.equal(stale.code, 1)
    assert.match(stale.stderr, /stale/)

    writeStartup(dir, { failure: "Telegram token rejected" })
    const failed = await runProbe(dir, {
      API_ENABLED: "0",
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
    })
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /Telegram token rejected/)

    writeStartup(dir, { release: "release-old" })
    const mismatch = await runProbe(dir, {
      API_ENABLED: "0",
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
    })
    assert.equal(mismatch.code, 1)
    assert.match(mismatch.stderr, /release-old.*release-new/)

    writeStartup(dir, { pid: process.pid + 1 })
    const pid = await runProbe(dir, {
      API_ENABLED: "0",
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_EXPECTED_PID: String(process.pid),
      RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
    })
    assert.equal(pid.code, 1)
    assert.match(pid.stderr, /differs from expected pid/)
  })
})

test("release health uses the authenticated API and still requires this launch's self-check", async () => {
  await withDir(async (dir) => {
    writeStartup(dir)
    const requests: Array<string | undefined> = []
    const server = createServer((req, res) => {
      requests.push(req.headers.authorization)
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true, version: "0.4.0", engine: "opencode", pid: process.pid }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    try {
      const result = await runProbe(dir, {
        API_ENABLED: "1",
        API_TOKEN: "test-token",
        API_PORT: String(address.port),
        DATA_DIR: "data",
        RELEASE_EXPECTED_ID: "release-new",
        RELEASE_EXPECTED_PID: String(process.pid),
        RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
      })
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /health: ok 0\.4\.0 opencode/)
      assert.deepEqual(requests, ["Bearer test-token"])

      rmSync(join(dir, "data", "startup-check.json"))
      const missing = await runProbe(dir, {
        API_ENABLED: "1",
        API_TOKEN: "test-token",
        API_PORT: String(address.port),
        DATA_DIR: "data",
        RELEASE_EXPECTED_ID: "release-new",
        RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
      })
      assert.equal(missing.code, 1)
      assert.match(missing.stderr, /startup-check\.json is missing/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

test("release health loads API settings from .env when the caller did not source it", async () => {
  await withDir(async (dir) => {
    writeStartup(dir)
    writeFileSync(join(dir, ".env"), "API_ENABLED=0\nDATA_DIR=data\n")
    const result = await runProbe(dir, {
      DATA_DIR: "data",
      RELEASE_EXPECTED_ID: "release-new",
      RELEASE_START_AT: new Date(Date.now() - 5_000).toISOString(),
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /local startup ok/)
  })
})
