import { readFileSync } from "node:fs"
import { resolve } from "node:path"

let cached: string | undefined

/** Package version, read once; "dev" when package.json is missing or unreadable. */
export function appVersion(): string {
  if (cached) return cached
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version?: string }
    cached = pkg.version?.trim() || "dev"
  } catch {
    cached = "dev"
  }
  return cached
}
