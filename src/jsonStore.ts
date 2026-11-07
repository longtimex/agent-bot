import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"

/**
 * Reads a JSON object store. Returns undefined when the file is absent.
 *
 * A file that exists but cannot be parsed (or whose root is not an object) is moved
 * aside instead of being ignored: every caller rebuilds its state from empty and
 * saves on the next mutation, so leaving the damaged file in place would silently
 * destroy whatever records were still recoverable from it.
 */
export function readJsonObject(path: string, warn: (message: string) => void): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  let problem: string
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    problem = "root is not a JSON object"
  } catch (error) {
    problem = (error as Error).message
  }
  const aside = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, aside)
    warn(`store ${path} is unreadable (${problem}); moved it to ${aside} and started empty`)
  } catch (error) {
    warn(`store ${path} is unreadable (${problem}) and could not be moved aside: ${(error as Error).message}`)
  }
  return undefined
}

/**
 * Publishes `content` to `path` so a reader never sees a half-written store: the payload is
 * fsynced into a sibling temp file before the rename, which is what makes the swap atomic
 * against power loss. Mode 0600 is applied to the destination after the rename because
 * openSync's mode only takes effect when the file is created, and an attacker-writable
 * pre-existing file must never survive as the token store.
 *
 * Throws so callers keep their own wording for what failed to persist.
 */
export function writePrivateAtomic(path: string, content: string, tempPath = `${path}.tmp`): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    const fd = openSync(tempPath, "w", 0o600)
    try {
      writeSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, path)
    chmodSync(path, 0o600)
  } catch (err) {
    try {
      unlinkSync(tempPath)
    } catch {
      // A temp file we cannot remove is not the failure worth reporting
    }
    throw err
  }
}
