import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { ApiError } from "./apiCore.js"
import type { ApiRequestContext } from "./apiCore.js"
import { res_attachment_binary } from "./apiHttp.js"

export const ANDROID_RELEASE_MANIFEST = "data/android-release.json"

export interface AndroidRelease {
  versionName: string
  versionCode: number
  apk: string
  sha256: string
  size: number
  notes?: string
  publishedAt?: string
}

interface StoredManifest {
  versionName?: unknown
  versionCode?: unknown
  apk?: unknown
  sha256?: unknown
  size?: unknown
  notes?: unknown
  publishedAt?: unknown
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256_RE = /^[0-9a-f]{64}$/i

export interface AndroidReleaseOptions {
  manifestPath?: string
  projectDir?: string
}

interface FileSignature {
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
}

function manifestPath(options: AndroidReleaseOptions): string {
  return resolve(options.projectDir ?? process.cwd(), options.manifestPath ?? ANDROID_RELEASE_MANIFEST)
}

function apkPath(manifestFile: string, apk: string): string {
  // Apache-relative paths would otherwise escape the directory an operator pointed at.
  if (isAbsolute(apk) || apk.split(/[\\/]/).includes("..")) throw new Error("APK 路径必须是 manifest 同目录下的相对路径")
  return join(manifestFile, "..", apk)
}

function validate(raw: StoredManifest): AndroidRelease {
  const versionName = typeof raw.versionName === "string" ? raw.versionName.trim() : ""
  const versionCode = typeof raw.versionCode === "number" ? raw.versionCode : Number(raw.versionCode)
  const apk = typeof raw.apk === "string" ? raw.apk.trim() : ""
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256.trim().toLowerCase() : ""
  const declaredSize = Number(raw.size)
  if (!VERSION_RE.test(versionName)) throw new Error("versionName 必须形如 1.2.3")
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error("versionCode 必须是正整数")
  if (!apk || apk.includes("\0")) throw new Error("apk 不能为空")
  if (!SHA256_RE.test(sha256)) throw new Error("sha256 必须是 64 位十六进制")
  return {
    versionName,
    versionCode,
    apk,
    sha256,
    size: Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : 0,
    ...(typeof raw.notes === "string" ? { notes: raw.notes.slice(0, 2_000) } : {}),
    ...(typeof raw.publishedAt === "string" ? { publishedAt: raw.publishedAt } : {}),
  }
}

/**
 * The App's update feed. The server never proxies an arbitrary URL: an operator places
 * one APK and a manifest on the host, and the same authenticated API serves both. That
 * keeps the update path available when GitHub is blocked and prevents an API caller from
 * turning the bot into an SSRF relay.
 */
export class AndroidReleaseService {
  readonly #options: AndroidReleaseOptions
  #cached?: { signature: FileSignature; release?: AndroidRelease; error?: string }

  constructor(options: AndroidReleaseOptions = {}) {
    this.#options = options
  }

  get manifestFile(): string {
    return manifestPath(this.#options)
  }

  get manifestPath(): string {
    return manifestPath(this.#options)
  }

  load(): { release?: AndroidRelease; error?: string } {
    const file = this.manifestPath
    if (!existsSync(file)) return { error: "服务器尚未配置 Android 更新清单" }
    const info = statSync(file)
    // mtime alone is not a content identity: a publisher may replace the
    // manifest while preserving its timestamp. Include the inode and change
    // time so an in-place rewrite invalidates the cached release too.
    const signature = { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino }
    const cached = this.#cached
    if (
      cached &&
      cached.signature.mtimeMs === signature.mtimeMs &&
      cached.signature.ctimeMs === signature.ctimeMs &&
      cached.signature.size === signature.size &&
      cached.signature.ino === signature.ino
    ) {
      return cached
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredManifest
      const release = validate(parsed)
      const apkFile = resolve(apkPath(file, release.apk))
      if (!existsSync(apkFile) || !statSync(apkFile).isFile()) {
        throw new Error(`APK 不存在：${release.apk}`)
      }
      const bytes = statSync(apkFile).size
      if (release.size > 0 && release.size !== bytes) {
        throw new Error(`APK 大小与清单不一致：清单 ${release.size} 字节，文件 ${bytes} 字节`)
      }
      release.size = bytes
      this.#cached = { signature, release }
      return this.#cached
    } catch (err) {
      this.#cached = { signature, error: err instanceof Error ? err.message : String(err) }
      return this.#cached
    }
  }

  /** Public view: no server path leaks to the client. */
  publicView(): Record<string, unknown> | null {
    const { release } = this.load()
    if (!release) return null
    return {
      versionName: release.versionName,
      versionCode: release.versionCode,
      size: release.size,
      sha256: release.sha256,
      notes: release.notes ?? "",
      publishedAt: release.publishedAt ?? "",
      downloadUrl: "/api/v1/android/release/apk",
    }
  }

  readApk(): { release: AndroidRelease; bytes: Buffer; filename: string } {
    const { release, error } = this.load()
    if (!release) throw new ApiError(404, error ?? "服务器尚未配置 Android 更新包")
    const apkFile = resolve(apkPath(this.manifestPath, release.apk))
    const real = realpathSync(apkFile)
    // A symlink inside the release directory is fine only when it still points there.
    const base = realpathSync(join(this.manifestPath, ".."))
    if (!real.startsWith(`${base}/`)) throw new ApiError(404, "APK 路径越界")
    const bytes = readFileSync(real)
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== release.sha256) throw new ApiError(500, "APK 校验失败：文件与清单的 SHA-256 不一致")
    if (release.size && bytes.length !== release.size) throw new ApiError(500, "APK 校验失败：文件大小与清单不一致")
    return { release, bytes, filename: `agent-bot-v${release.versionName}.apk` }
  }
}

/** GET /android/release and GET /android/release/apk. */
export function routeAndroidRelease(
  service: AndroidReleaseService,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void,
): boolean {
  if (ctx.method !== "GET" || id !== "release") return false
  if (action === "apk") {
    const { bytes, filename } = service.readApk()
    res_attachment_binary(ctx.res, filename, "application/vnd.android.package-archive", bytes)
    return true
  }
  if (action !== undefined) return false
  const { release, error } = service.load()
  const view = release ? service.publicView() : null
  const body = {
    configured: Boolean(release),
    ...view,
    ...(error && !release ? { message: error } : {}),
    ...(ctx.url.searchParams.get("versionCode")
      ? { updateAvailable: release ? release.versionCode > Number.parseInt(ctx.url.searchParams.get("versionCode") ?? "0", 10) : false }
      : {}),
  }
  // A not-yet-configured updater is a normal state for a new install, not an API failure.
  // Use the shared JSON responder so a paired App gets the same message-level encryption,
  // no-store/security headers and gzip behaviour as every other endpoint.
  json(ctx.res, 200, body)
  return true
}
