import assert from "node:assert/strict"
import test from "node:test"
import type { AgentCliService } from "../src/agentCli.js"
import type { AgentCliInstaller } from "../src/agentInstaller.js"
import type { Logger } from "../src/logger.js"
import type { SessionStore } from "../src/store.js"
import type { Job } from "../src/telegram.js"
import { TelegramAgentCommands } from "../src/telegramAgentCommands.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const job = { key: "tg:1", chatId: 1, text: "", userId: 1, generation: 1 } as Job

function harness() {
  const sent: string[] = []
  const store = {
    engine: "opencode",
    getEngine() { return this.engine },
    setEngine(_key: string, engine: string) { this.engine = engine },
  } as unknown as SessionStore
  const profile = { id: "claude", label: "Claude Code", bin: "claude", desc: "Claude", supportsModel: false }
  const agents = {
    registry: {
      get: (id: string) => (id === "claude" ? profile : undefined),
      binPath: () => undefined,
      resolveEngine: (id: string) => (id === "opencode" || id === "claude" ? id : undefined),
      list: () => [profile],
      label: (id: string) => id,
      modelLabel: (id: string) => id,
      defaultModel: () => undefined,
    },
  } as unknown as AgentCliService
  const installer = {
    installCommand: () => "npm install -g claude",
    updateCommand: () => "npm update -g claude",
    uninstallCommand: () => "npm uninstall -g claude",
    isManaged: () => true,
  } as unknown as AgentCliInstaller
  const commands = new TelegramAgentCommands({
    agents,
    installer,
    store,
    log,
    sendText: async (_chatId, text) => { sent.push(text); return true },
    sendPanel: async () => {},
    agentPanel: () => ({ text: "agents", keyboard: undefined }),
    agentInstallerPanel: () => ({ text: "installer", keyboard: undefined }),
  })
  return { commands, sent, store }
}

test("agent commands switch engines and reject unknown names", async () => {
  const h = harness()
  await h.commands.handleCommand(job, "opencode")
  assert.equal(h.store.getEngine("tg:1"), "opencode")
  assert.ok(h.sent.some((text) => text.includes("已切换至 OpenCode")))

  await h.commands.handleCommand(job, "nope")
  assert.ok(h.sent.some((text) => text.includes("未识别的 Agent 引擎")))
})

test("agent commands expose installation preconditions", () => {
  const h = harness()
  assert.equal(h.commands.actionBlocked("tg:1", "install", "opencode"), "未识别的 Agent CLI")
  assert.equal(h.commands.actionBlocked("tg:1", "install", "claude"), undefined)
  assert.equal(h.commands.actionBlocked("tg:1", "uninstall", "nope"), "未识别的 Agent CLI")
})
