import assert from "node:assert/strict"
import test from "node:test"
import { TelegramAccountCommands } from "../src/telegramAccountCommands.js"

interface View {
  id: string
  name: string
  category: string
  username: string
  secret?: string
  url?: string
  notes?: string
}

/** A fake store mirroring the slice the commands use, so no file or key is needed. */
function fakeStore() {
  const entries = new Map<string, View>()
  let seq = 0
  return {
    add(input: { name: string; username: string; password?: string; category?: string; url?: string; notes?: string }) {
      const entry: View = {
        id: `id${seq++}`,
        name: input.name,
        category: input.category ?? "未分类",
        username: input.username,
        secret: input.password ? `enc:${input.password}` : undefined,
        url: input.url,
        notes: input.notes,
      }
      entries.set(entry.id, entry)
      return entry
    },
    list(category?: string) {
      return [...entries.values()].filter((entry) => !category || entry.category === category)
    },
    categories() {
      const counts = new Map<string, number>()
      for (const entry of entries.values()) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
      return [...counts.entries()].map(([name, count]) => ({ name, count }))
    },
    find(ref: string) {
      // The real store resolves both an id and a name; the commands remove by id.
      return [...entries.values()].find(
        (entry) => entry.id === ref || entry.name.toLowerCase() === ref.toLowerCase(),
      )
    },
    reveal(ref: string) {
      const entry = this.find(ref)
      if (!entry) return undefined
      return { entry, password: entry.secret?.replace("enc:", "") ?? "" }
    },
    remove(ref: string) {
      const entry = this.find(ref)
      if (!entry) return undefined
      entries.delete(entry.id)
      return entry
    },
  }
}

function setup() {
  const sent: string[] = []
  const commands = new TelegramAccountCommands({
    accounts: fakeStore() as never,
    sendText: async (_chatId, text) => {
      sent.push(text)
    },
  })
  return { commands, sent }
}

test("account command saves an entry from pipe-separated fields", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add GitHub | me@example.com | s3cret | 开发 | https://github.com | 双因素已开")
  assert.match(sent[0] ?? "", /已保存 \*GitHub\*/)
  assert.match(sent[0] ?? "", /开发/)

  await commands.handle(1, "ls")
  assert.match(sent[1] ?? "", /GitHub/)
  assert.match(sent[1] ?? "", /me@example\.com/)
})

test("account command shows the password masked and reveals it only on request", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add Bank | u1 | p@ss | 金融")

  await commands.handle(1, "show Bank")
  assert.match(sent[1] ?? "", /密码：\*\*\*\*/)
  assert.ok(!(sent[1] ?? "").includes("p@ss"), "show must not leak the password")

  await commands.handle(1, "pass Bank")
  assert.ok((sent[2] ?? "").includes("p@ss"), "pass must return the plain password")
})

test("account removal needs an explicit yes", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add Temp | u")

  await commands.handle(1, "rm Temp")
  assert.match(sent[1] ?? "", /确认删除/)
  assert.equal(sent.length, 2, "nothing is removed before confirmation")

  await commands.handle(1, "rm Temp yes")
  assert.match(sent[2] ?? "", /已删除/)

  await commands.handle(1, "ls")
  assert.match(sent[3] ?? "", /还是空的|没有条目/)
})

test("account command reports an unknown name instead of failing silently", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "show nope")
  assert.match(sent[0] ?? "", /没有找到/)
})

test("account overview lists categories with counts", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add A | u | p | 开发")
  await commands.handle(1, "add B | u | p | 开发")
  await commands.handle(1, "add C | u | p | 社交")

  await commands.handle(1, "")
  assert.match(sent[3] ?? "", /共 3 条/)
  assert.match(sent[3] ?? "", /开发（2）/)
  assert.match(sent[3] ?? "", /社交（1）/)
})
