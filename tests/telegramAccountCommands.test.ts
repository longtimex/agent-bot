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
  tags?: string[]
  extras?: Record<string, string>
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
    update(ref: string, patch: Record<string, unknown>) {
      const entry = this.find(ref)
      if (!entry) throw new Error(`没有找到「${ref}」。`)
      if (typeof patch.name === "string") entry.name = patch.name
      if (typeof patch.username === "string") entry.username = patch.username
      if (patch.password !== undefined) {
        entry.secret = patch.password === null ? undefined : `enc:${patch.password}`
      }
      if (patch.category !== undefined) entry.category = (patch.category as string) ?? "未分类"
      if (patch.notes !== undefined) entry.notes = (patch.notes as string) ?? undefined
      if (patch.tags !== undefined) entry.tags = patch.tags as string[]
      if (patch.extras !== undefined) entry.extras = patch.extras as Record<string, string>
      return entry
    },
    sharedPasswords() {
      const groups = new Map<string, string[]>()
      for (const entry of entries.values()) {
        if (!entry.secret) continue
        groups.set(entry.secret, [...(groups.get(entry.secret) ?? []), entry.name])
      }
      return [...groups.values()].filter((names) => names.length > 1).map((names) => ({ names }))
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
  const secrets: string[] = []
  const commands = new TelegramAccountCommands({
    accounts: fakeStore() as never,
    sendText: async (_chatId, text) => {
      sent.push(text)
    },
    sendSecret: async (_chatId, text) => {
      secrets.push(text)
    },
  })
  return { commands, sent, secrets }
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
  const { commands, sent, secrets } = setup()
  await commands.handle(1, "add Bank | u1 | p@ss | 金融")

  await commands.handle(1, "show Bank")
  assert.match(sent[1] ?? "", /密码：\*\*\*\*/)
  assert.ok(!(sent[1] ?? "").includes("p@ss"), "show must not leak the password")

  await commands.handle(1, "pass Bank")
  assert.ok((secrets[0] ?? "").includes("p@ss"), "pass must return the plain password")
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

test("account edit changes only the segments that are filled in", async () => {
  const { commands, sent, secrets } = setup()
  await commands.handle(1, "add Edit | old-user | old-pass | 开发 | https://x | 旧备注")

  await commands.handle(1, "edit Edit | new-user | new-pass | | | ")
  assert.match(sent[1] ?? "", /已更新 \*Edit\*/)

  await commands.handle(1, "show Edit")
  assert.match(sent[2] ?? "", /new-user/)
  assert.match(sent[2] ?? "", /开发/, "an empty segment must keep the old category")
  assert.match(sent[2] ?? "", /旧备注/, "an empty segment must keep the old notes")

  await commands.handle(1, "pass Edit")
  assert.ok((secrets.at(-1) ?? "").includes("new-pass"))
})

test("account edit with a dash clears a field", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add Clear | u | p | 开发 | https://x | 备注")
  await commands.handle(1, "edit Clear | | - | - | - | -")
  await commands.handle(1, "show Clear")
  assert.match(sent[2] ?? "", /（未保存）/, "the password must be gone")
  assert.match(sent[2] ?? "", /未分类/, "the category must fall back to the default")
})

test("account tag replaces the whole label set", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add Tagged | u")
  await commands.handle(1, "tag Tagged 小红书,美妆 A组")
  assert.match(sent[1] ?? "", /#小红书/)
  assert.match(sent[1] ?? "", /#A组/)
})

test("account field merges a key=value pair and unfield removes one", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add Fields | u")
  await commands.handle(1, "field Fields 绑定邮箱=op@example.com")
  assert.match(sent[1] ?? "", /绑定邮箱：op@example\.com/)

  await commands.handle(1, "field Fields 负责人=小王")
  const merged = sent[2] ?? ""
  assert.match(merged, /绑定邮箱/, "the earlier field must survive a merge")
  assert.match(merged, /负责人/)

  await commands.handle(1, "unfield Fields 绑定邮箱")
  assert.match(sent[3] ?? "", /已删除字段/)
})

test("account pass sends the password as a disappearing message", async () => {
  const { commands, secrets, sent } = setup()
  await commands.handle(1, "add Secret | u | top-secret")
  await commands.handle(1, "pass Secret")
  assert.equal(secrets.length, 1, "the password must go through sendSecret")
  assert.ok((secrets[0] ?? "").includes("top-secret"))
  assert.ok((secrets[0] ?? "").includes("60 秒后自动删除"))
  assert.equal(sent.length, 1, "no plain copy may be left in the chat")
})

test("account dup warns about shared passwords without printing them", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add Alpha | u | same")
  await commands.handle(1, "add Beta | u | same")
  await commands.handle(1, "add Gamma | u | unique")
  await commands.handle(1, "dup")
  const report = sent[3] ?? ""
  assert.match(report, /Alpha \/ Beta/)
  assert.ok(!report.includes("same"), "the password itself must never appear")
})

test("account dup says so when every password is distinct", async () => {
  const { commands, sent } = setup()
  await commands.handle(1, "add One | u | a")
  await commands.handle(1, "add Two | u | b")
  await commands.handle(1, "dup")
  assert.match(sent[2] ?? "", /没有发现重复密码/)
})
