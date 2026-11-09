#!/usr/bin/env node
// Publish an already-built, signed APK to the bot's authenticated update feed.
//   node scripts/publish-android-release.mjs --apk ./agent-bot-v1.1.0.apk \
//     --version 1.1.0 --version-code 1001000 --notes "更新说明"
// The APK is copied into data/android/releases and data/android-release.json is
// atomically replaced, so a running bot picks it up without a restart.
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import process from "node:process"

function usage(message) {
  if (message) console.error(`error: ${message}`)
  console.error(
    "usage: node scripts/publish-android-release.mjs --apk <path> --version <x.y.z> [--version-code <n>] [--notes <text>]",
  )
  process.exit(2)
}

const args = process.argv.slice(2)
const options = { manifest: undefined }
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (!arg.startsWith("--")) usage(`unexpected argument: ${arg}`)
  const key = arg.slice(2)
  const value = args[i + 1]
  if (!value || value.startsWith("--")) usage(`${arg} needs a value`)
  i++
  if (!["apk", "version", "version-code", "notes", "manifest"].includes(key)) usage(`unknown option: ${arg}`)
  options[key] = value
}
if (!options.apk) usage("--apk is required")
if (!/^\d+\.\d+\.\d+$/.test(options.version ?? "")) usage("--version must look like 1.2.3")
const [major, minor, patch] = options.version.split(".").map(Number)
if (minor >= 1000 || patch >= 1000) usage("minor and patch must be below 1000 so versionCode stays monotonic")
const derivedCode = major * 1_000_000 + minor * 1_000 + patch
const versionCode = options["version-code"] ? Number(options["version-code"]) : derivedCode
if (options["version-code"] && versionCode !== derivedCode) {
  console.warn(`warning: versionCode ${versionCode} differs from the tag convention ${derivedCode}`)
}
if (!Number.isSafeInteger(versionCode) || versionCode < 1) usage("--version-code must be a positive integer")
if (!existsSync(options.apk) || !statSync(options.apk).isFile()) usage(`APK not found: ${options.apk}`)

const root = resolve(process.env.PROJECT_DIR ?? process.cwd())
const dataDir = resolve(root, process.env.DATA_DIR ?? "data")
const releasesDir = join(dataDir, "android", "releases")
const manifestPath = resolve(root, options.manifest ?? join(dataDir, "android-release.json"))
const filename = `agent-bot-v${options.version}.apk`
const destination = join(releasesDir, filename)

mkdirSync(releasesDir, { recursive: true })
// Hash the bytes actually published, not a prior read of the source path.
const staging = `${destination}.${process.pid}.part`
copyFileSync(options.apk, staging)
const bytes = readFileSync(staging)
const sha256 = createHash("sha256").update(bytes).digest("hex")
renameSync(staging, destination)

const manifest = {
  versionName: options.version,
  versionCode,
  apk: `android/releases/${basename(destination)}`,
  sha256,
  size: bytes.length,
  notes: options.notes ? String(options.notes).slice(0, 2_000) : "",
  publishedAt: new Date().toISOString(),
}
const temporary = `${manifestPath}.${process.pid}.tmp`
try {
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, manifestPath)
} catch (err) {
  try {
    unlinkSync(temporary)
  } catch {
    // best effort
  }
  throw err
}

console.log(`published ${filename}`)
console.log(`versionCode: ${versionCode}`)
console.log(`sha256: ${sha256}`)
console.log(`manifest: ${manifestPath}`)
