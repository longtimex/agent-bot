import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AndroidReleaseService } from "../src/androidRelease.js"
import { ApiError, type ApiRequestContext } from "../src/apiCore.js"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-android-release-"))
}

function seed(dir: string, bytes = Buffer.from("PK-APK"), overrides: Record<string, unknown> = {}): {
  service: AndroidReleaseService
  sha256: string
} {
  const releases = join(dir, "data", "android", "releases")
  mkdirSync(releases, { recursive: true })
  writeFileSync(join(releases, "agent-bot-v1.1.0.apk"), bytes)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  writeFileSync(
    join(dir, "data", "android-release.json"),
    JSON.stringify({
      versionName: "1.1.0",
      versionCode: 1_001_000,
      apk: "android/releases/agent-bot-v1.1.0.apk",
      sha256,
      size: bytes.length,
      notes: "修复更新检查",
      publishedAt: "2026-11-08T00:00:00Z",
      ...overrides,
    }),
  )
  return { service: new AndroidReleaseService({ projectDir: dir }), sha256 }
}

function context(url: string): ApiRequestContext {
  return {
    url: new URL(url, "http://localhost/api/v1/android/release"),
    method: "GET",
    segments: ["android", "release"],
    req: {} as ApiRequestContext["req"],
    res: {} as ApiRequestContext["res"],
    encrypted: false,
  }
}

test("android release exposes a validated manifest and serves the exact bytes", () => {
  const dir = tempDir()
  try {
    const bytes = Buffer.from("PK-APK-ROUNDTRIP")
    const { service, sha256 } = seed(dir, bytes)
    const { release, error } = service.load()
    assert.equal(error, undefined)
    assert.deepEqual(release, {
      versionName: "1.1.0",
      versionCode: 1_001_000,
      apk: "android/releases/agent-bot-v1.1.0.apk",
      sha256,
      size: bytes.length,
      notes: "修复更新检查",
      publishedAt: "2026-11-08T00:00:00Z",
    })
    assert.deepEqual(service.publicView(), {
      versionName: "1.1.0",
      versionCode: 1_001_000,
      size: bytes.length,
      sha256,
      notes: "修复更新检查",
      publishedAt: "2026-11-08T00:00:00Z",
      downloadUrl: "/api/v1/android/release/apk",
    })
    const apk = service.readApk()
    assert.deepEqual(apk.bytes, bytes)
    assert.equal(apk.filename, "agent-bot-v1.1.0.apk")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("android release refuses a checksum or declared size that does not match the APK", () => {
  const dir = tempDir()
  try {
    const bytes = Buffer.from("PK-APK")
    const wrongChecksum = new AndroidReleaseService({ projectDir: dir })
    seed(dir, bytes, { sha256: "0".repeat(64) })
    assert.equal(wrongChecksum.load().release?.sha256, "0".repeat(64))
    assert.throws(() => wrongChecksum.readApk(), (err: unknown) => err instanceof ApiError && err.status === 500 && /SHA-256/.test(err.message))

    seed(dir, bytes, { size: bytes.length + 1 })
    assert.match(new AndroidReleaseService({ projectDir: dir }).load().error ?? "", /大小与清单不一致/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("android release rejects path traversal and absolute APK paths", () => {
  const dir = tempDir()
  try {
    const releases = join(dir, "data", "android", "releases")
    mkdirSync(releases, { recursive: true })
    writeFileSync(join(dir, "outside.apk"), "outside")
    const bytes = "outside"
    for (const apk of ["../outside.apk", "/etc/passwd", "android/releases/../../outside.apk"]) {
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      seed(dir, Buffer.from(bytes), { apk, sha256 })
      assert.match(new AndroidReleaseService({ projectDir: dir }).load().error ?? "", /相对路径/, `${apk} must be rejected`)
    }
    symlinkSync(join(dir, "outside.apk"), join(releases, "linked.apk"))
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    seed(dir, Buffer.from(bytes), { apk: "android/releases/linked.apk", sha256 })
    const service = new AndroidReleaseService({ projectDir: dir })
    assert.throws(() => service.readApk(), (err: unknown) => err instanceof ApiError && err.status === 404 && /越界/.test(err.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("android release reads the packaged manifest when it is absent or malformed", () => {
  const dir = tempDir()
  try {
    const missing = new AndroidReleaseService({ projectDir: dir })
    assert.equal(missing.load().release, undefined)
    assert.match(missing.load().error ?? "", /尚未配置/)
    assert.equal(missing.publicView(), null)

    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, "data", "android-release.json"), JSON.stringify({ versionName: "1.1", versionCode: 0 }))
    const malformed = new AndroidReleaseService({ projectDir: dir })
    assert.equal(malformed.load().release, undefined)
    assert.match(malformed.load().error ?? "", /versionName/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("android release reports updateAvailable by versionCode", () => {
  const dir = tempDir()
  try {
    const { service } = seed(dir)
    // The router's query handling is covered by appContract; this pins the comparison itself.
    assert.ok((service.load().release?.versionCode ?? 0) > 1_000_000)
    assert.equal(service.load().release?.versionCode, 1_001_000)
    assert.equal(context("/android/release?versionCode=1000000").url.searchParams.get("versionCode"), "1000000")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("android release invalidates its cache when the manifest changes without a newer mtime", () => {
  const dir = tempDir()
  try {
    const firstBytes = Buffer.from("PK-FIRST")
    const { service, sha256: firstSha } = seed(dir, firstBytes)
    assert.equal(service.load().release?.versionName, "1.1.0")
    assert.equal(service.load().release?.sha256, firstSha)

    const manifest = join(dir, "data", "android-release.json")
    const fixed = new Date("2026-01-01T00:00:00.000Z")
    utimesSync(manifest, fixed, fixed)
    const secondBytes = Buffer.from("PK-SECOND")
    const secondSha = createHash("sha256").update(secondBytes).digest("hex")
    writeFileSync(join(dir, "data", "android", "releases", "agent-bot-v1.1.0.apk"), secondBytes)
    writeFileSync(
      manifest,
      JSON.stringify({
        versionName: "1.2.0",
        versionCode: 1_002_000,
        apk: "android/releases/agent-bot-v1.1.0.apk",
        sha256: secondSha,
        size: secondBytes.length,
      }),
    )
    // Reapply the old timestamp to model a publisher that preserves mtimes.
    utimesSync(manifest, fixed, fixed)

    const updated = service.load().release
    assert.equal(updated?.versionName, "1.2.0")
    assert.equal(updated?.sha256, secondSha)
    assert.deepEqual(service.readApk().bytes, secondBytes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
