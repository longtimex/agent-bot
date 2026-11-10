import assert from "node:assert/strict"
import test from "node:test"
import type { HistoryEntry } from "../src/history.js"
import { TelegramStatsPanels, type StatsPanelDeps } from "../src/telegramStats.js"

interface Button {
  text: string
  callback_data?: string
}

function panelsWithHistory(total: number, failed = false): TelegramStatsPanels {
  // Newest first, exactly like the store, and long enough that a 50-entry window cannot
  // fit one Telegram message
  const entries: HistoryEntry[] = Array.from({ length: total }, (_, index) => ({
    at: 1_700_000_000_000 - index * 60_000,
    prompt: `记录${index + 1}-${"x".repeat(90)}`,
    engine: "codex",
    ms: 1_200,
    outcome: failed ? ("failed" as const) : ("ok" as const),
    ...(failed ? { errorCode: "ENGINE_UNAVAILABLE" as const } : {}),
  }))
  const deps = {
    agents: { registry: { label: () => "Codex CLI" } },
    history: {
      count: () => entries.length,
      list: (_key: string, limit = 10, offset = 0) => entries.slice(offset, offset + limit),
    },
    timezone: () => "UTC",
  } as unknown as StatsPanelDeps
  return new TelegramStatsPanels(deps)
}

function buttons(panel: { keyboard?: unknown }): Button[] {
  const rows = (panel.keyboard as { inline_keyboard?: Button[][] }).inline_keyboard ?? []
  return rows.flat()
}

test("history panel pages from what it rendered, so 「更早」 always shows new records", () => {
  const panels = panelsWithHistory(30)
  const first = panels.historyPanel("tg:1", 50)

  const rendered = Number(/第 1-(\d+) 条 \/ 共 30 条/.exec(first.text)?.[1])
  assert.ok(rendered > 0, `expected a rendered count in the header, got ${first.text.slice(0, 80)}`)
  assert.ok(rendered < 30, "the message must actually be too long for a full window")
  assert.match(first.text, /消息过长/)

  const more = buttons(first).find((button) => button.text.includes("更早"))
  assert.ok(more?.callback_data, "an unfinished history needs a 更早 button")
  // The old button grew the window (show:history:60) instead of moving past what was drawn,
  // so pressing it re-rendered the same records forever
  assert.equal(more.callback_data, `show:history:50:${rendered}`)

  const second = panels.historyPanel("tg:1", 50, rendered)
  assert.match(second.text, new RegExp(`记录${rendered + 1}-`), "the next page must start where this one ended")
  assert.ok(!second.text.includes(`记录${rendered}-`), "a page must not repeat the record before it")
  assert.ok(buttons(second).some((button) => button.callback_data === "show:history"), "回到最新 comes back")

  const last = panels.historyPanel("tg:1", 50, 29)
  assert.match(last.text, /第 30-30 条 \/ 共 30 条/)
  assert.ok(!buttons(last).some((button) => button.text.includes("更早")), "no page past the newest-to-oldest end")
})

test("history panel clamps a stale offset after records are cleared", () => {
  const panels = panelsWithHistory(3)
  const panel = panels.historyPanel("tg:1", 10, 99)
  // An offset past the end would otherwise answer with an empty list and a "第 100-99" header
  assert.match(panel.text, /第 3-3 条 \/ 共 3 条/)
  assert.match(panel.text, /记录3-/)
  assert.ok(!buttons(panel).some((button) => button.text.includes("更早")))
})


test("history panel exposes the stable failure code next to the status", () => {
  const panel = panelsWithHistory(1, true).historyPanel("tg:1", 1)
  assert.match(panel.text, /❌ 失败/)
  assert.match(panel.text, /ENGINE_UNAVAILABLE/)
})
