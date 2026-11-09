/**
 * Small state-only CLI used by scripts/apply-release.sh. Keeping activation and
 * rollback here means state.json is never edited by ad-hoc shell JSON.
 */
import { ReleaseManager } from "./releaseManager.js"
import { whichSync } from "./agentCli.js"

function main(): void {
  const command = process.argv[2]
  const dataDir = process.env.DATA_DIR ?? "data"
  const manager = new ReleaseManager({
    projectDir: process.cwd(),
    dataDir,
    run: async () => ({ code: 1, stdout: "", stderr: "release-control does not run build commands" }),
    which: (bin) => whichSync(bin),
    env: process.env,
  })
  if (command === "current-id") {
    const current = manager.readState().current
    if (manager.isUsable(current)) process.stdout.write(`${current.id}\n`)
    return
  }
  if (command === "entry") {
    const which = process.argv[3]
    const state = manager.readState()
    const release = which === "pending" ? state.pending : which === "previous" ? state.previous : state.current
    if (manager.isUsable(release)) process.stdout.write(`${release.path}/dist/index.js\n`)
    return
  }
  if (command === "activate") {
    const result = manager.activatePending()
    if (!result.ok) throw new Error(result.message)
    process.stdout.write(`${result.message}\n`)
    return
  }
  if (command === "rollback") {
    const result = manager.rollback()
    if (!result.ok) throw new Error(result.message)
    process.stdout.write(`${result.message}\n`)
    return
  }
  if (command === "record-ok") {
    const state = manager.readState()
    const current = state.current
    manager.recordUpdate(
      {
        fromCommit: current?.previousCommit,
        toCommit: current?.commit,
        toVersion: current?.version,
        steps: [],
        apiReachable: true,
      },
      "ok",
      "新版本已通过健康检查。",
    )
    return
  }
  throw new Error(`未知命令：${command ?? "(empty)"}`)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
