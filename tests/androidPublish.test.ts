import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

function publish(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["scripts/publish-android-release.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  })
}

test("publish-android-release copies, hashes and atomically writes the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-android-publish-"))
  try {
    const apk = join(dir, "built.apk")
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from("signed-apk")])
    writeFileSync(apk, bytes)
    const result = publish(
      ["--apk", apk, "--version", "1.1.0", "--notes", "正式签名"],
      { PROJECT_DIR: dir, DATA_DIR: "data" },
    )
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, "data", "android-release.json"), "utf8")) as Record<string, unknown>
    assert.deepEqual(
      {
        versionName: manifest.versionName,
        versionCode: manifest.versionCode,
        apk: manifest.apk,
        sha256: manifest.sha256,
        size: manifest.size,
        notes: manifest.notes,
      },
      {
        versionName: "1.1.0",
        versionCode: 1_001_000,
        apk: "android/releases/agent-bot-v1.1.0.apk",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        notes: "正式签名",
      },
    )
    assert.deepEqual(readFileSync(join(dir, "data", "android", "releases", "agent-bot-v1.1.0.apk")), bytes)
    assert.match(String(manifest.publishedAt), /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("publish-android-release refuses an invalid version before touching data", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-android-publish-"))
  try {
    const apk = join(dir, "built.apk")
    writeFileSync(apk, "apk")
    const result = publish(["--apk", apk, "--version", "1.1"], { PROJECT_DIR: dir })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /--version/)
    assert.equal(spawnSafeExists(join(dir, "data", "android-release.json")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function spawnSafeExists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}
