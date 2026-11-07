import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentCliRegistry, AgentCliService } from "../src/agentCli.js"
import type { Logger } from "../src/logger.js"
import { SessionStore } from "../src/store.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`)
  chmodSync(path, 0o755)
}

test("AgentCliService dispose waits until a SIGTERM-ignoring CLI has actually exited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-dispose-"))
  const pidFile = join(dir, "child.pid")
  try {
    const bin = join(dir, "ignore-term")
    writeExecutable(
      bin,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: {
          stubborn: {
            label: "StubbornCLI",
            bin,
            parse: "text",
            args: { prompt: [pidFile, "{prompt}"] },
          },
        },
      }),
    )
    const service = new AgentCliService(
      dir,
      new SessionStore(join(dir, "sessions.json"), log),
      log,
      20_000,
      20_000,
      undefined,
      new AgentCliRegistry({ path: registryPath, log }),
    )
    const run = service.prompt("chat", "stubborn", "wait").catch(() => {})
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const pid = Number(readFileSync(pidFile, "utf8"))
    assert.ok(Number.isInteger(pid) && pid > 1, "the fake CLI must report its pid")

    const stopped = (service.dispose as unknown as (graceMs?: number) => void | Promise<void>)(100)
    assert.ok(stopped instanceof Promise, "shutdown must be awaitable so the parent cannot exit first")
    await stopped
    await run

    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "dispose returned while the CLI was still alive")
  } finally {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"))
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL")
    } catch {
      // already reaped
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
