import type { ChildProcess } from "node:child_process"

const KILL_ESCALATION_MS = 5_000

/**
 * How long a child's pipes get to drain after the process itself exited. A detached helper
 * it left behind (an MCP server, an npm shim) can hold the write end open forever, and
 * Node only fires `close` once every stream reached EOF.
 */
export const EXIT_DRAIN_MS = 2_000

const killTimers = new WeakMap<ChildProcess, NodeJS.Timeout>()

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Children are spawned detached, so the pid is also their process-group id;
    // signalling the group catches wrapper scripts that spawn the real CLI.
    if (child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Node fires a child's `close` only once every stdio stream has ended, so a pipe
 * that has not reached EOF still has another process holding the write end open.
 */
function stdioDrained(child: ChildProcess): boolean {
  return [child.stdout, child.stderr].every((stream) => !stream || stream.readableEnded || stream.destroyed)
}

/** SIGTERM now, SIGKILL if the process is still alive after `graceMs`. */
export function terminateProcess(child: ChildProcess, graceMs = KILL_ESCALATION_MS): void {
  // An exited leader is not proof that the group is gone: npm/curl wrapper shims
  // exit while the real CLI keeps the inherited pipes open, so the group signal is
  // what stops that orphan. Only a child whose stdio reached EOF is fully finished,
  // and signalling a recycled pid then is the risk worth avoiding.
  if ((child.exitCode !== null || child.signalCode !== null) && stdioDrained(child)) return
  signalChild(child, "SIGTERM")
  if (killTimers.has(child)) return

  const timer = setTimeout(() => {
    killTimers.delete(child)
    // Drained pipes say nothing about liveness: a CLI that closes its streams and then
    // ignores SIGTERM would otherwise stay alive forever with the group left unsignalled
    const alive = child.exitCode === null && child.signalCode === null
    if (alive || !stdioDrained(child)) signalChild(child, "SIGKILL")
  }, graceMs)
  timer.unref()
  killTimers.set(child, timer)
  child.once("close", () => {
    const pending = killTimers.get(child)
    if (pending) {
      clearTimeout(pending)
      killTimers.delete(child)
    }
  })
}
