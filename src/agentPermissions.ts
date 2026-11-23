import type { AgentCliProfile } from "./agentCli.js"

/**
 * argv segments that hand every tool call to the CLI without asking. They are what make an
 * unattended bot able to run arbitrary commands, so a deployment that wants a review-first
 * posture needs a way to drop them without editing the profile list.
 */
const PERMISSION_BYPASS_SEGMENTS: string[][] = [
  ["--dangerously-skip-permissions"],
  ["--dangerously-bypass-approvals-and-sandbox"],
  ["--dangerously-allow-all"],
  ["--approval-mode", "yolo"],
  // GitHub Copilot CLI: every tool and every path without a prompt
  ["--allow-all-tools"],
  ["--allow-all-paths"],
]

/**
 * Flags that only mean "run without asking" for one CLI. `--force` is Cursor Agent's switch for
 * executing commands unattended, but the same word is an ordinary option elsewhere, so it is
 * matched only on the engine that defines it. Missing these let safe mode leave Cursor and Copilot
 * fully unattended while the agents panel showed no warning for them.
 */
const ENGINE_BYPASS_SEGMENTS: Record<string, string[][]> = {
  cursor: [["--force"]],
}

function segmentsFor(engine?: string): string[][] {
  const scoped = engine && Object.hasOwn(ENGINE_BYPASS_SEGMENTS, engine) ? ENGINE_BYPASS_SEGMENTS[engine]! : []
  return [...PERMISSION_BYPASS_SEGMENTS, ...scoped]
}

function segmentAt(argv: string[], segment: string[], from: number): number {
  for (let i = from; i + segment.length <= argv.length; i += 1) {
    if (segment.every((token, offset) => argv[i + offset] === token)) return i
  }
  return -1
}

export function stripPermissionBypass(argv: string[], engine?: string): string[] {
  let out = argv
  for (const segment of segmentsFor(engine)) {
    for (let at = segmentAt(out, segment, 0); at >= 0; at = segmentAt(out, segment, at)) {
      out = [...out.slice(0, at), ...out.slice(at + segment.length)]
    }
  }
  return out
}

/** Whether this profile would run tools without asking. Used by the agents panel to warn. */
export function bypassesPermissionChecks(profile: AgentCliProfile): boolean {
  // Every template, not only base/resumeBase: Qoder puts its bypass in newSession and
  // resumeSession, so reading two fields hid the warning for an engine that never asks
  const args = profile.args
  const templates = [args.base, args.resumeBase, args.newSession, args.resumeSession, args.cwd, args.model, args.prompt]
  return templates.some(
    (argv) => argv !== undefined && segmentsFor(profile.id).some((segment) => segmentAt(argv, segment, 0) >= 0),
  )
}

/** Whether this deployment asked for a review-first posture (`AGENT_CLI_SAFE_MODE=1`). */
export function safeModeEnabled(): boolean {
  const raw = process.env.AGENT_CLI_SAFE_MODE?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}
