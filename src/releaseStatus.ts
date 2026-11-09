import type { ReleaseState } from "./releaseManager.js"
import type { StartupSelfCheck } from "./startupSelfCheck.js"
import { buildReleaseDiagnostics, type ReleaseDiagnostics, type UpdateTarget } from "./updateChecker.js"

export interface ReleaseOverview {
  release?: ReleaseDiagnostics
  update?: UpdateTarget
  startup?: StartupSelfCheck
  lastBackupAt: number
}

/** Cheap release-card view: no git/opencode/statfs probes. */
export function buildReleaseOverview(
  state: ReleaseState,
  target: UpdateTarget,
  startup: StartupSelfCheck | undefined,
  lastBackupAt: number,
): ReleaseOverview {
  const diagnostics = buildReleaseDiagnostics(state, target)
  return {
    release: diagnostics.release,
    update: diagnostics.update,
    ...(startup ? { startup } : {}),
    lastBackupAt,
  }
}

