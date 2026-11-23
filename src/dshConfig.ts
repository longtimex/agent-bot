import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The model a DeepSeek Harness profile is configured to use.
 *
 * dsh has no `--model` flag and no `--list-models`: the model belongs to the profile, in
 * `cordis.patch.yml`. `dsh --dump-config` would print the whole merged tree — credentials
 * included — so this reads the patch files directly and gives up when they do not say.
 */
function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh")
}

/** Patch files to consult, most specific first. */
function candidates(): string[] {
  const home = dshHome()
  return [
    join(home, "profiles", "headless", "cordis.patch.yml"),
    join(home, "profiles", "web", "cordis.patch.yml"),
    join(home, "cordis.patch.yml"),
  ]
}

/** The configured model name, or undefined when no patch file names one. */
export function readDshModel(): string | undefined {
  for (const path of candidates()) {
    if (!existsSync(path)) continue
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      continue
    }
    // Only a bare `model:` key is read; nested structures and credentials are left alone
    const match = /^[ \t]*model:[ \t]*['"]?([A-Za-z0-9._:/-]+)['"]?[ \t]*(?:#.*)?$/m.exec(text)
    if (match?.[1]) return match[1]
  }
  return undefined
}
