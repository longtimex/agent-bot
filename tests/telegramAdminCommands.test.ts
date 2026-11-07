import assert from "node:assert/strict"
import test from "node:test"
import type { BotConfig } from "../src/config.js"
import type { OpsService } from "../src/ops.js"
import { TelegramAdminCommands } from "../src/telegramAdminCommands.js"

function harness(users: string[], owner: number | undefined, envOk = true) {
  const sent: string[] = []
  const env: Array<{ key: string; value: string }> = []
  const applied: Array<{ key: string; value: string }> = []
  const cfg = {
    telegram: { allowUsers: new Set(users), allowAll: false },
  } as unknown as BotConfig
  const ops = {
    envSet: (key: string, value: string) => {
      env.push({ key, value })
      return { ok: envOk, message: envOk ? "" : "写入失败" }
    },
  } as unknown as OpsService
  const commands = new TelegramAdminCommands({
    cfg,
    ops,
    ownerChatId: owner,
    timezone: () => "Asia/Shanghai",
    applyLiveEnv: (key, value) => {
      applied.push({ key, value })
      if (key === "TELEGRAM_ALLOW_USERS") {
        cfg.telegram.allowUsers.clear()
        for (const id of value.split(",").filter(Boolean)) cfg.telegram.allowUsers.add(id)
      }
    },
    sendText: async (_chatId, text) => { sent.push(text); return true },
    sendPanel: async () => {},
    accessPanel: () => ({ text: "access", keyboard: undefined }),
    timezonePanel: () => "timezone",
  })
  return { commands, cfg, sent, env, applied }
}

test("admin commands add and remove whitelist users and persist the change", () => {
  const h = harness(["7", "8"], 7)
  assert.equal(h.commands.addAccess(["9"]).ok, true)
  assert.deepEqual([...h.cfg.telegram.allowUsers], ["7", "8", "9"])
  assert.deepEqual(h.env.at(-1), { key: "TELEGRAM_ALLOW_USERS", value: "7,8,9" })
  assert.deepEqual(h.applied.at(-1), { key: "TELEGRAM_ALLOW_USERS", value: "7,8,9" })

  assert.equal(h.commands.removeAccess(["8"]).ok, true)
  assert.deepEqual([...h.cfg.telegram.allowUsers], ["7", "9"])
})

test("admin commands refuse to remove the owner, empty the list, or accept invalid ids", () => {
  const h = harness(["7", "8"], 7)
  assert.equal(h.commands.removeAccess(["7"]).ok, false)
  assert.equal(h.commands.removeAccess(["not-an-id"]).ok, false)
  assert.equal(h.commands.addAccess(["7"]).ok, false, "duplicate add is a no-op")

  const single = harness(["9"], undefined)
  assert.equal(single.commands.removeAccess(["9"]).ok, false)
  assert.deepEqual([...single.cfg.telegram.allowUsers], ["9"])
})

test("admin commands handle /access and /timezone through the service deps", async () => {
  const h = harness(["7"], 7)
  await h.commands.handleAccessCommand(1, 7, "add 42")
  assert.ok(h.sent.some((text) => text.includes("已加入白名单")))
  assert.deepEqual(h.applied.at(-1), { key: "TELEGRAM_ALLOW_USERS", value: "7,42" })

  await h.commands.handleTimeZone(1, "Europe/Berlin")
  assert.deepEqual(h.env.at(-1), { key: "REMINDER_TIMEZONE", value: "Europe/Berlin" })
  assert.deepEqual(h.applied.at(-1), { key: "REMINDER_TIMEZONE", value: "Europe/Berlin" })
})

test("admin commands report a failed timezone write", async () => {
  const h = harness(["7"], 7, false)
  await h.commands.handleTimeZone(1, "Europe/Berlin")
  assert.ok(h.sent.some((text) => text.includes("写入失败")))
  assert.equal(h.applied.length, 0)
})
