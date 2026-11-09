import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"

/**
 * The JSON stores grew independently and most of them have no schema version. A release
 * must not rewrite them in place just to stamp a number: a network filesystem, a full disk
 * or an interrupted upgrade would then lose state that the old binary still understood.
 *
 * Instead this migration is deliberately non-destructive:
 *   - snapshot every top-level *.json once per app/data-schema version;
 *   - validate that each snapshot is parseable JSON (or leave it untouched);
 *   - record hashes in data/schema.json for diagnostics and future explicit upgrades.
 * A later migration can read `fromVersion` and transform a snapshot, but the current one
 * only establishes the baseline and makes every future update reversible.
 */
export const DATA_SCHEMA_VERSION = 1

export interface DataSchemaState {
  version: number
  updatedAt: string
  lastSnapshot?: string
  files?: Record<string, { bytes: number; sha256: string }>
}

export interface MigrationResult {
  ok: boolean
  fromVersion?: number
  toVersion: number
  snapshot?: string
  files: string[]
  message: string
  warning?: string
}

const EXCLUDED = new Set(["schema.json", "api-token.json", "api-enc-key.json", "bot.lock", "bot.pid", "opencode.pid"])

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function safeJson(content: Buffer): boolean {
  try {
    JSON.parse(content.toString("utf8"))
    return true
  } catch {
    return false
  }
}

function schemaPath(dataDir: string): string {
  return join(dataDir, "schema.json")
}

export function readSchemaState(dataDir: string): DataSchemaState | undefined {
  const path = schemaPath(dataDir)
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as DataSchemaState
  } catch {
    return undefined
  }
}

/**
 * Take a private snapshot of the current state before any release is activated. This runs
 * at process startup, after `.env` is read but before the stores open their files. Errors
 * are reported but never crash the bot: a read-only data directory must not turn a working
 * installation into a dead one.
 */
export function migrateDataDirectory(dataDir: string, log: Logger, now = new Date()): MigrationResult {
  const current = readSchemaState(dataDir)
  if (current?.version === DATA_SCHEMA_VERSION) {
    return {
      ok: true,
      fromVersion: current.version,
      toVersion: DATA_SCHEMA_VERSION,
      files: Object.keys(current.files ?? {}),
      message: `数据 schema 已是最新（v${DATA_SCHEMA_VERSION}）。`,
    }
  }
  if (!existsSync(dataDir)) {
    return {
      ok: true,
      toVersion: DATA_SCHEMA_VERSION,
      files: [],
      message: "数据目录尚不存在，首次启动会自动创建。",
    }
  }

  let names: string[]
  try {
    names = readdirSync(dataDir)
      .filter((name) => name.endsWith(".json") && !EXCLUDED.has(name) && !name.startsWith("."))
      .sort()
  } catch (err) {
    return { ok: false, toVersion: DATA_SCHEMA_VERSION, files: [], message: `无法读取数据目录：${(err as Error).message}` }
  }

  const stamp = now.toISOString().replace(/[:.]/g, "-")
  const snapshots = join(dataDir, "snapshots")
  const destination = join(snapshots, `schema-v${DATA_SCHEMA_VERSION}-${stamp}`)
  const files: Record<string, { bytes: number; sha256: string }> = {}
  const copied: string[] = []
  let warning: string | undefined
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const name of names) {
      const source = join(dataDir, name)
      const info = statSync(source)
      if (!info.isFile()) continue
      const content = readFileSync(source)
      if (!safeJson(content)) {
        warning = `${name} 不是可解析的 JSON，已保留原文件但没有写入迁移清单。`
        continue
      }
      copyFileSync(source, join(destination, name))
      files[name] = { bytes: content.length, sha256: hash(content) }
      copied.push(name)
    }
    const state: DataSchemaState = {
      version: DATA_SCHEMA_VERSION,
      updatedAt: now.toISOString(),
      lastSnapshot: destination,
      files,
    }
    writePrivateAtomic(schemaPath(dataDir), `${JSON.stringify(state, null, 2)}\n`)
    pruneSnapshots(snapshots, 5)
    log.info(`data schema v${DATA_SCHEMA_VERSION}: snapshotted ${copied.length} file(s) at ${destination}`)
    return {
      ok: true,
      ...(current?.version ? { fromVersion: current.version } : {}),
      toVersion: DATA_SCHEMA_VERSION,
      snapshot: destination,
      files: copied,
      message: copied.length ? `已备份 ${copied.length} 个状态文件。` : "没有需要备份的状态文件。",
      ...(warning ? { warning } : {}),
    }
  } catch (err) {
    const message = `数据迁移快照失败：${(err as Error).message}`
    log.warn(message)
    return {
      ok: false,
      ...(current?.version ? { fromVersion: current.version } : {}),
      toVersion: DATA_SCHEMA_VERSION,
      files: [],
      message,
    }
  }
}

function pruneSnapshots(dir: string, keep: number): void {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("schema-v"))
    .map((entry) => entry.name)
    .sort()
  for (const stale of entries.slice(0, Math.max(0, entries.length - keep))) {
    try {
      const path = join(dir, stale)
      const aside = `${path}.deleting`
      renameSync(path, aside)
      rmrf(aside)
    } catch {
      // A leftover snapshot is harmless.
    }
  }
}

function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

