import assert from "node:assert/strict"
import { statSync } from "node:fs"
import process from "node:process"

/**
 * Windows exposes no POSIX permission bits: chmod() succeeds but the mode reads back as
 * 0o666, so every `mode & 0o777 === 0o600` assertion fails there for reasons the product
 * cannot fix. The rest of the suite still needs to mean something on a Windows dev box,
 * so the check degrades to "the file exists" instead of being skipped entirely.
 */
export const posixModes = process.platform !== "win32"

export function assertFileMode(path: string, mode: number, message?: string): void {
  if (!posixModes) {
    assert.ok(statSync(path), message)
    return
  }
  assert.equal(statSync(path).mode & 0o777, mode, message)
}
