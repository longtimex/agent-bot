import assert from "node:assert/strict"
import test from "node:test"
import { parseBotCommand } from "../src/telegramCommand.js"

test("parseBotCommand splits a command from its argument", () => {
  assert.deepEqual(parseBotCommand("/stop"), { command: "/stop", arg: "" })
  assert.deepEqual(parseBotCommand("/model sonnet"), { command: "/model", arg: "sonnet" })
  // The argument keeps its inner spacing and case; only the token is normalised
  assert.deepEqual(parseBotCommand("/cc  model   list"), { command: "/cc", arg: "model   list" })
})

test("parseBotCommand lower-cases the token and drops the group @botname suffix", () => {
  assert.deepEqual(parseBotCommand("/STOP"), { command: "/stop", arg: "" })
  assert.deepEqual(parseBotCommand("/Stop@MyBot now"), { command: "/stop", arg: "now" })
  // A leading @ is not a suffix: only what follows the command token is stripped
  assert.deepEqual(parseBotCommand("/status"), { command: "/status", arg: "" })
})

test("parseBotCommand treats a plain message as a task", () => {
  assert.deepEqual(parseBotCommand("检查一下服务器"), { command: "检查一下服务器", arg: "" })
  assert.deepEqual(parseBotCommand("  /status  "), { command: "/status", arg: "" })
  assert.deepEqual(parseBotCommand(""), { command: "", arg: "" })
  assert.deepEqual(parseBotCommand("   "), { command: "", arg: "" })
})
