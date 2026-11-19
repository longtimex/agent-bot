import { spawnSync } from "node:child_process"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { whichSync } from "./agentCli.js"
import { projectEnv } from "./runtime.js"

/**
 * The opencode CLI is the built-in engine, but installing it means a global npm
 * install. That is a side effect the caller has to ask about, so both the installer
 * script and `bot install` resolve the same question before touching the machine.
 */

export function ensureOpencode(projectDir: string): void {
  const existing = whichSync("opencode")
  if (existing) {
    console.log(`opencode CLI: ${existing}`)
    return
  }
  console.log("Installing the opencode CLI…")
  const npm = whichSync("npm") ?? "npm"
  const result = spawnSync(npm, ["install", "-g", "opencode-ai", "--no-audit", "--no-fund"], {
    cwd: projectDir,
    env: projectEnv(projectDir),
    stdio: "inherit",
  })
  if (result.status !== 0) {
    console.error("Could not install opencode-ai globally; run: sudo npm install -g opencode-ai")
  }
}

/**
 * Decides whether this install manages OpenCode at all. `--opencode`/`--no-opencode`
 * answer it up front; without a flag a terminal gets the same menu `install.sh` shows,
 * while a piped or CI run installs nothing instead of touching global npm unattended.
 */
export async function resolveManageOpencode(requested: boolean | undefined): Promise<boolean> {
  if (requested !== undefined) return requested
  const existing = whichSync("opencode")
  if (existing) {
    console.log(`opencode CLI: ${existing}`)
    return true
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      "Skipping the opencode CLI (no terminal to ask); install it later with: npm install -g opencode-ai",
    )
    return false
  }
  console.log("")
  console.log("选择 Agent 引擎：")
  console.log("  1) 安装 OpenCode CLI，并交给 Bot 管理（内置引擎，推荐）")
  console.log("  2) 跳过，稍后自行安装（npm i -g opencode-ai）")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await rl.question("选择 [1/2]（回车 = 1）: ")).trim()
      if (answer === "" || answer === "1") return true
      if (answer === "2") return false
      console.log("请输入 1 或 2。")
    }
  } finally {
    rl.close()
  }
}
