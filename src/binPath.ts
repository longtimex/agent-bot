import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import process from "node:process"

// Global installs done by the Bot itself (npm -g, pip --user, cargo, bun, pnpm) land in per-user bin
// directories that systemd, cron and non-login shells usually leave out of PATH.
const EXTRA_BIN_DIRS = [
  ".npm-global/bin",
  ".local/bin",
  ".local/share/pnpm",
  ".bun/bin",
  ".deno/bin",
  ".cargo/bin",
  ".pyenv/shims",
  "bin",
]
const EXTRA_SYSTEM_DIRS = ["/usr/local/bin", "/snap/bin"]

/**
 * Re-checked on every call: a `npm -g` or `pip` install triggered from Telegram
 * creates these directories while the bot is running, and a cached snapshot would
 * keep the freshly installed CLI invisible until the next restart.
 */
function extraBinDirs(home: string): string[] {
  return [...EXTRA_BIN_DIRS.map((relative) => join(home, relative)), ...EXTRA_SYSTEM_DIRS].filter((dir) => {
    try {
      return existsSync(dir)
    } catch {
      return false
    }
  })
}

/** PATH plus the usual per-user global bin directories, so self-installed agent CLIs stay discoverable. */
export function extendedPath(envPath = process.env.PATH ?? "", home = homedir()): string {
  const parts = envPath.split(delimiter).filter(Boolean)
  for (const dir of extraBinDirs(home)) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(delimiter)
}

/**
 * Child-process environment with the extended PATH applied. Keeps the real PATH entries first so a
 * system-wide install still wins over a per-user one.
 */
export function extendedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, PATH: extendedPath(env.PATH ?? "") }
}

/**
 * Credentials and access-control values that belong to the bot process alone. A CLI talks to
 * its own provider, an installer only builds files, and neither can have a use for the token
 * that would let them drive the bot (and every whitelisted chat) from inside a script.
 * Engine children run with approvals bypassed by design, so anything readable here is
 * reachable by whatever the model is told to do.
 */
const BOT_ONLY = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOW_USERS",
  "TELEGRAM_ALLOW_ALL_USERS",
  // The Feishu app secret can mint tenant tokens for the bot's own app, and the
  // whitelist names who may drive it. Neither is a provider credential an engine
  // has any use for.
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_ALLOW_OPEN_IDS",
  "FEISHU_ALLOW_ALL_USERS",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  // The HTTP API bearer token is root-equivalent for this bot: git pull, npm install and
  // filesystem browsing all sit behind it. No engine needs it.
  "API_TOKEN",
  // Transcript keys belong to the bot's voice pipeline; providers use their own variable names.
  "STT_API_KEY",
  // Account-automation credentials, never consumed by an engine.
  "SNIPER_EMAIL",
  "SNIPER_PASSWORD",
])

const CREDENTIAL_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

/**
 * Environment for a child process: PATH extended, the bot's own credentials removed.
 * `dropCredentials` also removes anything that looks like a secret, which is what an
 * installer needs: `npm install` runs lifecycle scripts written by the package author, and
 * a hijacked or typosquatted package has no business reading the provider keys in env.
 * Ambient keys a CLI genuinely needs stay untouched when it is false.
 */
export function scrubEnv(
  env: Record<string, string | undefined>,
  dropCredentials = false,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || BOT_ONLY.has(name)) continue
    if (dropCredentials && CREDENTIAL_NAME.test(name)) continue
    out[name] = value
  }
  return out
}

export function childEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return extendedEnv(scrubEnv(env))
}

export function installerChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return extendedEnv(scrubEnv(env, true))
}

/**
 * Environment for release-gate commands. A supervisor may inject NODE_OPTIONS
 * (browser preloads on hosted desktops, coverage hooks, etc.); those preloads
 * are not part of the project and can break forked test runners or stale paths.
 * DATA_DIR and UPDATE_BRANCH/UPDATE_CHANNEL are also runtime routing, not
 * project config: forwarding the running instance's absolute data directory
 * makes gate tests read/write live state, and a test release branch changes
 * assertions that describe the default main channel. The staging cwd must
 * choose its own ./data and the tests' default channel instead.
 * Never let ambient runtime wiring decide whether a release is safe to activate.
 */
export function releaseChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = installerChildEnv(env)
  delete out.NODE_OPTIONS
  delete out.DATA_DIR
  delete out.UPDATE_BRANCH
  delete out.UPDATE_CHANNEL
  return out
}
