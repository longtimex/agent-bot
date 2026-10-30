import { existsSync, readFileSync, renameSync } from "node:fs"

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
