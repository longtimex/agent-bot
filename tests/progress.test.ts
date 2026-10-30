import assert from "node:assert/strict"
import test from "node:test"
import type { Bot } from "grammy"
import { ProgressTracker } from "../src/progress.js"

interface ApiCall {
  method: string
  args: unknown[]
}

interface Harness {
  calls: ApiCall[]
  tracker: ProgressTracker
  bot: Bot
  deleteMessageId: (id: number) => boolean
  advance: (ms: number) => void
}

/** A card only renders two seconds in, so the clock jumps once the tracker has taken its start time. */
function harness(options: { sendMessage?: () => Promise<void>; edit?: () => Promise<void> } = {}): Harness & {
  restore: () => void
} {
  const calls: ApiCall[] = []
  const start = Date.now()
  let offset = 60_000
  const bot = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        calls.push({ method: "sendMessage", args: [text] })
        await options.sendMessage?.()
        return { message_id: 5 }
      },
      editMessageText: async (_chatId: number, messageId: number, text: string) => {
        calls.push({ method: "editMessageText", args: [messageId, text] })
        await options.edit?.()
        return { message_id: messageId }
      },
      deleteMessage: async (_chatId: number, messageId: number) => {
        calls.push({ method: "deleteMessage", args: [messageId] })
      },
    },
  } as unknown as Bot
  const tracker = new ProgressTracker(bot, 42)
  const original = Date.now
  Date.now = () => start + offset
  return {
    calls,
    tracker,
    bot,
    deleteMessageId: (id) => calls.some((call) => call.method === "deleteMessage" && call.args[0] === id),
    advance: (ms) => {
      offset += ms
    },
    restore: () => {
      Date.now = original
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test("progress card renders once, edits on a new step and is deleted by finish", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const h = harness()
  try {
    h.tracker.update("connecting to OpenCode")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1)

    // The same status on the next tick must not spam the chat
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1)
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 0)

    h.tracker.update("running tool: bash")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 1)

    await h.tracker.finish()
    assert.equal(h.deleteMessageId(5), true)

    // finish() must stop the timer: a later tick may not resurrect the card
    const sent = h.calls.filter((call) => call.method === "sendMessage").length
    t.mock.timers.tick(6000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, sent)
  } finally {
    h.restore()
    await h.tracker.finish()
  }
})

test("finish during an in-flight send deletes the card instead of leaving an orphan", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness({ sendMessage: () => gate })
  try {
    h.tracker.update("waiting for the model")
    t.mock.timers.tick(2000)
    // The send is now suspended inside sendMessage, so the message id is still unknown
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1)
    assert.equal(h.deleteMessageId(5), false)

    await h.tracker.finish()
    release()
    await settle()
    assert.equal(h.deleteMessageId(5), true, "a card that lands after finish must be deleted")
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 0)
  } finally {
    h.restore()
    release()
    await h.tracker.finish()
  }
})

test("progress card is reposted when the previous card was deleted", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const gone = Object.assign(new Error("400: Bad Request: message to edit not found"), {
    error_code: 400,
    description: "message to edit not found",
  })
  const h = harness({ edit: () => Promise.reject(gone) })
  try {
    h.tracker.update("connecting to OpenCode")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1)

    h.tracker.update("running tool: bash")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 1)

    // Without the reset the tracker would keep editing the dead id for the whole task
    h.tracker.update("writing the answer")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 2)
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 1)
  } finally {
    h.restore()
    await h.tracker.finish()
  }
})

test("a flood error keeps the card id and backs off instead of hammering it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const flood = Object.assign(new Error("420: Flood"), {
    error_code: 420,
    description: "Too Many Requests: retry after 30",
    parameters: { retry_after: 30 },
  })
  const h = harness({ edit: () => Promise.reject(flood) })
  try {
    h.tracker.update("connecting to OpenCode")
    t.mock.timers.tick(2000)
    await settle()

    h.tracker.update("running tool: bash")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 1)

    // Inside the retry-after window every further edit attempt only deepens the limit
    h.tracker.update("writing the answer")
    t.mock.timers.tick(2000)
    h.tracker.update("still writing")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 1, "edits must pause")
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1, "the card must not be re-posted")

    // Once the window passes, the same card is edited rather than replaced
    h.advance(31_000)
    t.mock.timers.tick(2000)
    await settle()
    const edits = h.calls.filter((call) => call.method === "editMessageText")
    assert.equal(edits.length, 2)
    assert.equal((edits[1]?.args as unknown[])[0], 5, "a rate-limited card still exists and must be reused")
  } finally {
    h.restore()
    await h.tracker.finish()
  }
})

test("an unchanged card is only refreshed on the elapsed-clock cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const h = harness()
  try {
    h.tracker.update("running tool: bash")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1)

    // The elapsed counter moves on its own: re-sending for it would be one edit
    // every two seconds for the whole task
    for (let tick = 0; tick < 5; tick++) {
      h.advance(5_000)
      t.mock.timers.tick(2000)
    }
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 0)

    h.advance(31_000)
    t.mock.timers.tick(2000)
    await settle()
    const edits = h.calls.filter((call) => call.method === "editMessageText")
    assert.equal(edits.length, 1, "the card must still refresh its elapsed time periodically")
    assert.match(String((edits[0]?.args as unknown[])[1]), /1m/)

    h.tracker.update("writing the answer")
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(h.calls.filter((call) => call.method === "editMessageText").length, 2, "a new step edits at once")
  } finally {
    h.restore()
    await h.tracker.finish()
  }
})

test("progress card strips Markdown control characters from statuses", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const h = harness()
  try {
    h.tracker.update("reading `secret` [redacted] *bold* _text_ and c:\\*users\\*")
    t.mock.timers.tick(2000)
    await settle()
    const sent = h.calls.find((call) => call.method === "sendMessage")
    assert.ok(sent)
    const text = String((sent.args as unknown[])[0])
    for (const injection of ["`secret`", "[redacted]", "*bold*", "_text_", "\\*"]) {
      assert.ok(!text.includes(injection), `markdown marker ${injection} reached the card`)
    }
    assert.ok(!text.includes("\\"), "a backslash would make Telegram reject the Markdown card")
    assert.ok(text.includes("reading"), "the status text itself must survive escaping")
  } finally {
    h.restore()
    await h.tracker.finish()
  }
})
