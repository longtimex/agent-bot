import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { AVAILABLE_MODELS, resolveModelKey } from "../src/models.js"
import { ModelAdmin, type LiveSessionModels } from "../src/modelAdmin.js"

interface Fixture {
  dir: string
  project: string
  admin: ModelAdmin
  cleanup(): void
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bot-model-admin-"))
  const project = join(dir, "project")
  mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify(
      {
        model: "custom/base",
        provider: {
          custom: {
            name: "Custom",
            models: {
              base: { name: "Base" },
            },
          },
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(project, ".opencode", "agent", "assistant.md"),
    "---\ndescription: Telegram bot\nmode: primary\nmodel: custom/base\n---\n\nYou are helpful.\n",
  )
  writeFileSync(
    join(project, ".opencode", "agent", "helper.md"),
    "---\ndescription: Helper agent\nmode: subagent\n---\n\nHelp out.\n",
  )
  const admin = new ModelAdmin(join(dir, "data", "models.json"), project, "assistant")
  return {
    dir,
    project,
    admin,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function readProjectConfig(project: string): Record<string, any> {
  return JSON.parse(readFileSync(join(project, "opencode.json"), "utf8"))
}

test("ModelAdmin.add registers a model and syncs opencode.json", () => {
  const fx = createFixture()
  try {
    const result = fx.admin.add({ key: "zeta", providerID: "custom", modelID: "zeta-1", label: "Zeta One" })
    assert.equal(result.providerUpdated, true)
    assert.equal(result.entry.label, "Zeta One")

    const config = readProjectConfig(fx.project)
    assert.equal(config.provider.custom.models["zeta-1"].name, "Zeta One")

    assert.equal(resolveModelKey("zeta"), "zeta")
    assert.equal(AVAILABLE_MODELS.zeta!.modelID, "zeta-1")
    assert.equal(fx.admin.listCustomModels().zeta!.providerID, "custom")
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.add accepts model ids that shadow Object.prototype names", () => {
  const fx = createFixture()
  try {
    // `modelID in models` used to hit Object.prototype and reject "toString"
    // with a bogus "already exists in opencode.json" error
    const result = fx.admin.add({ key: "proto", providerID: "custom", modelID: "toString" })
    assert.equal(result.providerUpdated, true)
    const config = readProjectConfig(fx.project)
    assert.ok(Object.hasOwn(config.provider.custom.models, "toString"))
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.add rejects builtin keys, duplicates and alias clashes", () => {  const fx = createFixture()
  try {
    assert.throws(() => fx.admin.add({ key: "gemini", providerID: "custom", modelID: "x" }), /内置模型冲突/)
    assert.throws(() => fx.admin.add({ key: "sonnet", providerID: "custom", modelID: "x" }), /内置模型冲突/)
    assert.throws(() => fx.admin.add({ key: "claude", providerID: "custom", modelID: "x" }), /别名冲突/)
    assert.throws(() => fx.admin.add({ key: "base", providerID: "custom", modelID: "base" }), /已存在/)
    assert.throws(() => fx.admin.add({ key: "Bad Key", providerID: "custom", modelID: "x" }), /只能包含/)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.add keeps registry-only models when the provider is absent", () => {
  const fx = createFixture()
  try {
    const result = fx.admin.add({ key: "remote", providerID: "missing", modelID: "m1" })
    assert.equal(result.providerUpdated, false)
    assert.equal(fx.admin.listCustomModels().remote!.modelID, "m1")
    assert.equal(resolveModelKey("remote"), "remote")
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.remove deletes registry and provider entries", () => {
  const fx = createFixture()
  try {
    fx.admin.add({ key: "zeta", providerID: "custom", modelID: "zeta-1" })
    const removed = fx.admin.remove("zeta")
    assert.ok(removed)
    assert.equal(removed.providerUpdated, true)
    assert.equal(fx.admin.listCustomModels().zeta, undefined)
    assert.equal(readProjectConfig(fx.project).provider.custom.models["zeta-1"], undefined)
    assert.equal(resolveModelKey("zeta"), undefined)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.remove refuses to break agents until forced", () => {
  const fx = createFixture()
  try {
    fx.admin.add({ key: "zeta", providerID: "custom", modelID: "zeta-1" })
    const assigned = fx.admin.assignAgent("self", "zeta")
    assert.equal(assigned.agent, "assistant")
    assert.equal(assigned.model, "custom/zeta-1")

    assert.throws(() => fx.admin.remove("zeta"), /仍在使用中.*agent assistant/)
    const removed = fx.admin.remove("zeta", true)
    assert.ok(removed)
    assert.deepEqual(removed.references, [])
    assert.deepEqual(removed.resetAgents, ["assistant"])

    // the dangling binding is gone, and the rest of the frontmatter survives
    const content = readFileSync(join(fx.project, ".opencode", "agent", "assistant.md"), "utf8")
    assert.doesNotMatch(content, /^model:/m)
    assert.match(content, /description: Telegram bot/)
    assert.match(content, /mode: primary/)
    assert.equal(fx.admin.listAgents().find((agent) => agent.name === "assistant")?.model, undefined)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.force remove clears quoted bindings and keeps file permissions", () => {
  const fx = createFixture()
  const file = join(fx.project, ".opencode", "agent", "private.md")
  try {
    fx.admin.add({ key: "solo", providerID: "custom", modelID: "so-lo" })
    writeFileSync(file, "---\ndescription: 'costs $& literal'\nmodel:  'custom/so-lo'\nmode: subagent\n---\n\nBody.\n")
    chmodSync(file, 0o600)

    const removed = fx.admin.remove("solo", true)
    assert.ok(removed)
    assert.deepEqual(removed.resetAgents, ["private"])
    assert.deepEqual(removed.references, [])

    const content = readFileSync(file, "utf8")
    // `$&` is a replacement pattern in a RegExp source, so compare literally
    assert.ok(content.includes("description: 'costs $& literal'"), content)
    assert.match(content, /^mode: subagent$/m)
    assert.doesNotMatch(content, /custom\/so-lo/)
    assert.equal(statSync(file).mode & 0o777, 0o600)

    // a second delete of an already cleared binding must not rewrite anything
    fx.admin.add({ key: "solo2", providerID: "custom", modelID: "solo-2" })
    writeFileSync(file, "---\ndescription: d\nmode: subagent\n---\n\nBody.\n")
    const before = readFileSync(file, "utf8")
    const again = fx.admin.remove("solo2", true)
    assert.ok(again)
    assert.deepEqual(again.resetAgents, [])
    assert.deepEqual(again.references, [])
    assert.equal(readFileSync(file, "utf8"), before)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.assignAgent edits frontmatter and lists agents", () => {
  const fx = createFixture()
  try {
    const result = fx.admin.assignAgent("helper", "custom/base")
    assert.equal(result.model, "custom/base")

    const content = readFileSync(join(fx.project, ".opencode", "agent", "helper.md"), "utf8")
    assert.match(content, /^model: custom\/base\n/m)
    assert.match(content, /description: Helper agent/)

    const agents = fx.admin.listAgents()
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["assistant", "helper"],
    )
    assert.equal(agents.find((agent) => agent.name === "helper")!.model, "custom/base")
    assert.match(agents.find((agent) => agent.name === "helper")!.description ?? "", /Helper agent/)

    assert.throws(() => fx.admin.assignAgent("missing", "custom/base"), /Agent 不存在/)
    assert.throws(() => fx.admin.assignAgent("bad name", "custom/base"), /Agent 名称无效/)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.assignAgent keeps $-sequences in frontmatter literal", () => {
  const fx = createFixture()
  try {
    const file = join(fx.project, ".opencode", "agent", "helper.md")
    writeFileSync(file, "---\ndescription: costs $& and $' literal\nmode: subagent\n---\n\nHelp out.\n")

    fx.admin.assignAgent("helper", "custom/base")

    const content = readFileSync(file, "utf8")
    assert.equal(content, "---\nmodel: custom/base\ndescription: costs $& and $' literal\nmode: subagent\n---\n\nHelp out.\n")
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.resolveModel accepts keys and provider/model refs", () => {
  const fx = createFixture()
  try {
    assert.equal(fx.admin.resolveModel("gemini").modelID, "gemini-3.8-flash-high")
    assert.deepEqual(
      { providerID: fx.admin.resolveModel("custom/whatever").providerID, modelID: fx.admin.resolveModel("custom/whatever").modelID },
      { providerID: "custom", modelID: "whatever" },
    )
    assert.throws(() => fx.admin.resolveModel("not-a-model"), /未识别的模型/)
    assert.throws(() => fx.admin.resolveModel("-bad/ref"), /未识别的模型|无效/)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin treats quoted frontmatter models as live references", () => {
  const fx = createFixture()
  const quotedFile = join(fx.project, ".opencode", "agent", "quoted.md")
  try {
    fx.admin.add({ key: "cb", providerID: "custom", modelID: "cb", label: "CB" })
    writeFileSync(quotedFile, '---\nmode: subagent\nmodel: "custom/cb"\n---\n\nBody.\n')

    assert.equal(fx.admin.listAgents().find((agent) => agent.name === "quoted")?.model, "custom/cb")
    assert.throws(() => fx.admin.remove("cb"), /仍在使用中：agent quoted/)
    const removed = fx.admin.remove("cb", true)
    assert.ok(removed)
    assert.deepEqual(removed.references, [])
    assert.deepEqual(removed.resetAgents, ["quoted"])
    assert.match(readFileSync(quotedFile, "utf8"), /^mode: subagent$/m)
    assert.doesNotMatch(readFileSync(quotedFile, "utf8"), /model:/)

    // padded names resolve to the same agent file and the returned name is normalized
    writeFileSync(quotedFile, '---\nmode: subagent\nmodel: "custom/cb"\n---\n\nBody.\n')
    const assigned = fx.admin.assignAgent(" quoted ", "custom/other")
    assert.equal(assigned.agent, "quoted")
    assert.match(readFileSync(quotedFile, "utf8"), /^model: custom\/other$/m)
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin.remove treats chat selections as live references and resets them", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-model-admin-chats-"))
  try {
    const project = join(dir, "project")
    mkdirSync(join(project, ".opencode", "agent"), { recursive: true })
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({ provider: { custom: { name: "Custom", models: {} } } }),
    )

    const chats = new Map<string, string>([
      ["tg:1", "custom/zeta-1"],
      ["tg:2", "custom/other"],
    ])
    const live: LiveSessionModels = {
      listModelRefs: () =>
        [...chats].map(([key, ref]) => {
          const [providerID = "", modelID = ""] = ref.split("/")
          return { key, providerID, modelID }
        }),
      clearModel: (key) => chats.delete(key),
    }
    const admin = new ModelAdmin(join(dir, "data", "models.json"), project, "assistant", live)
    admin.add({ key: "zeta", providerID: "custom", modelID: "zeta-1" })

    assert.throws(() => admin.remove("zeta"), /仍在使用中：会话 tg:1/)
    const removed = admin.remove("zeta", true)
    assert.ok(removed)
    assert.deepEqual(removed.resetChats, ["tg:1"])
    assert.deepEqual(removed.references, [])
    assert.deepEqual([...chats.keys()], ["tg:2"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ModelAdmin refuses to overwrite a registry it cannot parse", () => {
  const fx = createFixture()
  try {
    const registryPath = fx.admin.registryPath
    mkdirSync(dirname(registryPath), { recursive: true })
    const corrupt = '{"version":1,"models":{"fast":'
    writeFileSync(registryPath, corrupt)
    const configPath = join(fx.project, "opencode.json")
    const configBefore = readFileSync(configPath, "utf8")

    assert.throws(
      () => fx.admin.add({ key: "damagedcheck", providerID: "custom", modelID: "d-1" }),
      /无法解析/,
    )

    assert.equal(readFileSync(registryPath, "utf8"), corrupt, "the damaged file must survive for repair")
    assert.equal(readFileSync(configPath, "utf8"), configBefore, "nothing else may be touched first")
  } finally {
    fx.cleanup()
  }
})

test("ModelAdmin keeps a restricted mode on the project config", () => {
  const fx = createFixture()
  try {
    const configPath = join(fx.project, "opencode.json")
    chmodSync(configPath, 0o600)

    fx.admin.add({ key: "modesafe", providerID: "custom", modelID: "m-1" })

    assert.equal(statSync(configPath).mode & 0o777, 0o600, "a hand-restricted config must stay unreadable by others")
    assert.equal(statSync(fx.admin.registryPath).mode & 0o777, 0o600)
  } finally {
    fx.cleanup()
  }
})

test("a label cut at the limit never ends in half of an emoji", () => {
  // Telegram rejects a message carrying a lone surrogate with a 400, so the label
  // must not be cut between the two halves of a code point
  const fx = createFixture()
  try {
    const label = `${"x".repeat(59)}😀`
    const { entry } = fx.admin.add({ key: "wide", providerID: "custom", modelID: "wide-1", label })
    assert.equal(entry.label, "x".repeat(59))
    assert.equal(entry.label.charCodeAt(entry.label.length - 1), "x".charCodeAt(0))
    assert.equal(readProjectConfig(fx.project).provider.custom.models["wide-1"].name, "x".repeat(59))
  } finally {
    fx.cleanup()
  }
})
