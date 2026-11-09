import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"

export const MANAGED_MARKER = "managed by agent-bot"

export function writeManagedFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
}

function managedFile(path: string): { state: "missing" | "managed" | "unmanaged" | "error"; detail?: string } {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return { state: "unmanaged", detail: "not a regular file" }
    return readFileSync(path, "utf8").includes(MANAGED_MARKER)
      ? { state: "managed" }
      : { state: "unmanaged" }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { state: "missing" }
    return { state: "error", detail: err instanceof Error ? err.message : String(err) }
  }
}

function managedSystemFile(path: string): { state: "missing" | "managed" | "unmanaged" | "error"; detail?: string } {
  const test = spawnSync("sudo", ["-n", "test", "-f", path], { encoding: "utf8" })
  if (test.status === 1 && !(test.stderr ?? "").trim()) return { state: "missing" }
  if (test.status !== 0) return { state: "error", detail: (test.stderr ?? "").trim() || "sudo test failed" }
  const grep = spawnSync("sudo", ["-n", "grep", "-Fq", MANAGED_MARKER, path], { encoding: "utf8" })
  if (grep.status === 1) return { state: "unmanaged" }
  if (grep.status !== 0) return { state: "error", detail: (grep.stderr ?? "").trim() || "sudo grep failed" }
  return { state: "managed" }
}

export function removeManaged(path: string, label: string, dryRun: boolean): boolean {
  const check = managedFile(path)
  if (check.state === "missing") return true
  if (check.state !== "managed") {
    console.error(`refusing to remove unmanaged ${label}: ${path}${check.detail ? ` (${check.detail})` : ""}`)
    return false
  }
  if (dryRun) {
    console.log(`would remove ${label}: ${path}`)
    return true
  }
  rmSync(path, { force: true })
  console.log(`removed ${label}: ${path}`)
  return true
}

export function removeUnit(path: string, userScope: boolean, dryRun: boolean): boolean {
  if (process.getuid?.() === 0 || userScope) return removeManaged(path, "unit", dryRun)
  if (dryRun) {
    // Reading a root-owned unit needs sudo. A dry run must not prompt for or
    // depend on elevated access, so report the intended action without probing.
    console.log(`would verify the managed marker and remove unit: ${path}`)
    return true
  }
  const check = managedSystemFile(path)
  if (check.state === "missing") return true
  if (check.state !== "managed") {
    console.error(`refusing to remove unmanaged unit: ${path}${check.detail ? ` (${check.detail})` : ""}`)
    return false
  }
  if (dryRun) {
    console.log(`would remove unit: ${path}`)
    return true
  }
  const result = spawnSync("sudo", ["-n", "rm", "-f", path], { encoding: "utf8" })
  if (result.status !== 0) {
    console.error(`could not remove unit ${path}: ${(result.stderr ?? "").trim()}`)
    return false
  }
  console.log(`removed unit: ${path}`)
  return true
}

export function isSafeDataRoot(dataDir: string, projectDir: string): boolean {
  const data = resolve(dataDir)
  const project = resolve(projectDir)
  if (data === "/" || project === data) return false
  return !project.startsWith(`${data}/`)
}

