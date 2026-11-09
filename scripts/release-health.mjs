#!/usr/bin/env node
// Probe the locally configured bot API. The token never leaves the process
// environment; this script prints only pass/fail and a short reason.
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

// apply-release.sh is commonly launched from a shell that has not sourced
// `.env`. Load it first; explicit environment values still win.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env")
  } catch {
    // The bot reports a malformed/optional .env. Keep the process environment
    // so a manual probe can still explain the failure.
  }
}

const dataDir = process.env.DATA_DIR ?? "data"
const port = process.env.API_PORT ?? "3080"
const host = process.env.API_HEALTH_HOST ?? "127.0.0.1"
const startupPath = resolve(dataDir, "startup-check.json")

function fail(message) {
  console.error(`health: ${message}`)
  process.exit(1)
}

function enabled(value, fallback = true) {
  if (value === undefined || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function readCurrentReleaseId() {
  try {
    const state = JSON.parse(readFileSync(resolve(dataDir, "releases", "state.json"), "utf8"))
    return typeof state?.current?.id === "string" && state.current.id ? state.current.id : "checkout"
  } catch {
    return "checkout"
  }
}

function readStartupCheck() {
  if (!existsSync(startupPath)) fail("startup-check.json is missing")
  try {
    return JSON.parse(readFileSync(startupPath, "utf8"))
  } catch {
    fail("startup-check.json is unreadable")
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user. In the
    // normal deployment this probe runs as the bot user, but treat EPERM as
    // live so a stale check is still rejected rather than accepted.
    return Boolean(err && typeof err === "object" && err.code === "EPERM")
  }
}

function expectedReleaseId() {
  return process.env.RELEASE_EXPECTED_ID?.trim() || readCurrentReleaseId()
}

function expectedPid() {
  const raw = process.env.RELEASE_EXPECTED_PID?.trim()
  if (!raw) return undefined
  if (!/^[1-9][0-9]*$/.test(raw)) fail("RELEASE_EXPECTED_PID is invalid")
  return Number(raw)
}

function startAtMs() {
  const raw = process.env.RELEASE_START_AT?.trim()
  if (!raw) return undefined
  const value = Date.parse(raw)
  if (!Number.isFinite(value)) fail("RELEASE_START_AT is invalid")
  return value
}

function validateStartup(startup, { requireStartedAt = false } = {}) {
  if (!startup || typeof startup !== "object" || Array.isArray(startup)) {
    fail("startup-check.json has an invalid shape")
  }
  if (startup.failure) fail(`startup marked failed: ${startup.failure}`)

  const expected = expectedReleaseId()
  const actualRelease = typeof startup.release === "string" && startup.release ? startup.release : "checkout"
  if (actualRelease !== expected) {
    fail(`startup belongs to ${actualRelease}, expected ${expected}`)
  }

  const startedAt = startAtMs()
  if (startedAt === undefined) {
    if (requireStartedAt) fail("RELEASE_START_AT is missing")
  } else {
    const at = typeof startup.at === "string" ? Date.parse(startup.at) : Number.NaN
    if (!Number.isFinite(at)) fail("startup-check.json has no valid timestamp")
    // The file is written after the timestamp captured immediately before
    // starting the process. Reject anything older so a previous successful
    // start cannot make a failed restart look healthy.
    if (at < startedAt) fail(`startup check is stale (${startup.at ?? "no timestamp"})`)
  }

  const pid = expectedPid()
  if (pid !== undefined) {
    if (startup.pid !== pid) fail(`startup pid ${startup.pid ?? "missing"} differs from expected pid ${pid}`)
    if (!processAlive(pid)) fail(`expected pid ${pid} is not running`)
  }
  return startup
}

function readToken() {
  if (process.env.API_TOKEN) return process.env.API_TOKEN
  const file = resolve(dataDir, "api-token.json")
  if (!existsSync(file)) return undefined
  try {
    const token = JSON.parse(readFileSync(file, "utf8"))?.token
    return typeof token === "string" && token ? token : undefined
  } catch {
    return undefined
  }
}

const apiEnabled = enabled(process.env.API_ENABLED, true)
const token = readToken()

if (apiEnabled && token) {
  try {
    const res = await fetch(`http://${host}:${port}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) fail(`HTTP ${res.status}`)
    const body = await res.json()
    if (body?.ok !== true) fail("body did not report ok")

    // /health can answer before Telegram/Feishu have finished initialising.
    // Check the post-start self-check too when the supervisor supplied a start
    // timestamp. Manual probes without one retain the old lightweight behavior.
    if (process.env.RELEASE_START_AT) validateStartup(readStartupCheck())
    const startup = readStartupCheck()
    if (startup.pid && body.pid !== undefined && startup.pid !== body.pid) {
      fail(`health pid ${body.pid} differs from startup pid ${startup.pid}`)
    }
    console.log(`health: ok ${body.version ?? ""} ${body.engine ?? ""}`.trim())
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
} else {
  // API is intentionally off, or no token is available to authenticate a
  // probe. A Telegram/Feishu-only deployment is healthy only once the
  // post-start self-check records this fresh process. Never accept a stale
  // successful file.
  const startup = validateStartup(readStartupCheck(), { requireStartedAt: true })
  console.log(`health: local startup ok ${startup.version ?? ""} pid ${startup.pid ?? "?"}`.trim())
}
