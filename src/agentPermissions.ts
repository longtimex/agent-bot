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
]

function segmentAt(argv: string[], segment: string[], from: number): number {
  for (let i = from; i + segment.length <= argv.length; i += 1) {
    if (segment.every((token, offset) => argv[i + offset] === token)) return i
  }
  return -1
}

export function stripPermissionBypass(argv: string[]): string[] {
  let out = argv
  for (const segment of PERMISSION_BYPASS_SEGMENTS) {
    for (let at = segmentAt(out, segment, 0); at >= 0; at = segmentAt(out, segment, at)) {
      out = [...out.slice(0, at), ...out.slice(at + segment.length)]
    }
  }
  return out
}

/** Whether this profile would run tools without asking. Used by the agents panel to warn. */
export function bypassesPermissionChecks(profile: AgentCliProfile): boolean {
  const argv = [...(profile.args.base ?? []), ...(profile.args.resumeBase ?? [])]
  return PERMISSION_BYPASS_SEGMENTS.some((segment) => segmentAt(argv, segment, 0) >= 0)
}

/** Whether this deployment asked for a review-first posture (`AGENT_CLI_SAFE_MODE=1`). */
export function safeModeEnabled(): boolean {
  const raw = process.env.AGENT_CLI_SAFE_MODE?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}
