import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { MigrationResult } from "./dataMigration.js"

export interface StartupSelfCheck {
  at: string
  version: string
  pid?: number
  commit?: string
  release?: string
  previousRelease?: string
  migration: Pick<MigrationResult, "ok" | "fromVersion" | "toVersion" | "message" | "warning">
  api?: { requested: boolean; reachable?: boolean; error?: string }
  engine?: string
  failure?: string
  notes: string[]
}

export function writeStartupSelfCheck(dataDir: string, check: Omit<StartupSelfCheck, "migration"> & Partial<Pick<StartupSelfCheck, "migration">>): string {
  const path = join(dataDir, "startup-check.json")
  mkdirSync(dataDir, { recursive: true })
  appendFileSync(join(dataDir, "startup-checks.jsonl"), `${JSON.stringify(check)}\n`, { mode: 0o600 })
  writeAtomic(path, `${JSON.stringify(check, null, 2)}\n`)
  return path
}

export function readStartupSelfCheck(dataDir: string): StartupSelfCheck | undefined {
  const path = join(dataDir, "startup-check.json")
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StartupSelfCheck
  } catch {
    return undefined
  }
}

export function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, content, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
    chmodSync(path, 0o600)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // best effort
    }
    throw err
  }
}

/** Written when startup aborts before the normal self-check (bad config, failed bind, etc.). */
export function writeStartupFailure(dataDir: string, message: string, extras: Partial<StartupSelfCheck> = {}): void {
  try {
    writeStartupSelfCheck(dataDir, {
      ...extras,
      at: new Date().toISOString(),
      version: extras.version ?? "unknown",
      failure: message,
      notes: extras.notes ?? ["启动失败，未进入正常服务阶段"],
    })
  } catch {
    // The original error is the useful one; never mask it with a diagnostics write failure.
  }
}
