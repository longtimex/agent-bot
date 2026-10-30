import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"
import { extendedPath } from "../src/binPath.js"
import {
  AgentCliRegistry,
  AgentCliService,
  buildCliArgs,
  normalizeWorkDirInput,
  parseCliOutput,
  terminateProcess,
  whichSync,
  type AgentCliProfile,
} from "../src/agentCli.js"
import type { Logger } from "../src/logger.js"
import { SessionStore } from "../src/store.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`)
  chmodSync(path, 0o755)
}

function profileById(registry: AgentCliRegistry, id: string): AgentCliProfile {
  const profile = registry.get(id)
  assert.ok(profile, `expected profile ${id}`)
  return profile
}

test("registry ships the mainstream Linux agent CLIs and resolves aliases", () => {
  const registry = new AgentCliRegistry({ log })
  const ids = registry.list().map((profile) => profile.id)
  for (const id of ["qoder", "claude", "codex", "gemini", "qwen", "cursor", "copilot", "opencode-cli", "aider", "goose", "amp", "droid"]) {
    assert.ok(ids.includes(id), `missing builtin profile ${id}`)
  }

  assert.equal(registry.resolve("claude-code"), "claude")
  assert.equal(registry.resolve("QWEN"), "qwen")
  assert.equal(registry.resolve("cursor-agent"), "cursor")
  assert.equal(registry.resolve("q"), "qoder")
  assert.equal(registry.resolve("github-copilot"), "copilot")
  assert.equal(registry.resolve("does-not-exist"), undefined)

  assert.equal(registry.resolveEngine("OpenCode"), "opencode")
  assert.equal(registry.resolveEngine("oc"), "opencode")
  assert.equal(registry.resolveEngine("open-code"), "opencode")
  assert.equal(registry.resolveEngine("codex"), "codex")
  assert.equal(registry.resolveEngine("nope"), undefined)

  assert.equal(registry.label("opencode"), "OpenCode")
  assert.equal(registry.label("claude"), "Claude Code")
  assert.equal(registry.label("unknown-engine"), "unknown-engine")

  assert.deepEqual(profileById(registry, "claude").installSpec, {
    method: "npm",
    package: "@anthropic-ai/claude-code",
  })
  assert.deepEqual(profileById(registry, "aider").installSpec, { method: "pip", package: "aider-chat" })
  assert.equal(profileById(registry, "qoder").installSpec, undefined)
})

test("registry resolves strict and open models per profile", () => {
  const registry = new AgentCliRegistry({ log })
  assert.equal(registry.resolveModel("qoder", "deepseek"), "DeepSeek-Flash")
  assert.equal(registry.resolveModel("qoder", "Qwen3.8-Flash"), "Qwen3.8-Flash")
  assert.equal(registry.resolveModel("qoder", "llama"), undefined)
  assert.equal(registry.resolveModel("claude", "sonnet"), "sonnet")
  assert.equal(registry.resolveModel("claude", "claude-opus"), "opus")
  assert.equal(registry.resolveModel("claude", "some-other-model"), "some-other-model")
  assert.equal(registry.resolveModel("goose", "anything"), undefined)

  assert.equal(registry.modelLabel("claude", "sonnet"), "Claude Sonnet")
  assert.equal(registry.modelLabel("claude", "custom"), "custom")
  assert.equal(registry.defaultModel("qoder"), "Qwen3.8-Flash")
  assert.equal(registry.defaultModel("claude"), undefined)
})

test("model ids cannot smuggle extra CLI flags into argv", () => {
  const registry = new AgentCliRegistry({ log })
  assert.equal(registry.resolveModel("claude", "-p"), undefined)
  assert.equal(registry.resolveModel("claude", "--dangerously-skip-permissions"), undefined)
  assert.equal(registry.resolveModel("claude", "gpt-5\t--json"), undefined)
  assert.equal(registry.resolveModel("claude", `${"x".repeat(121)}`), undefined)
  assert.equal(registry.resolveModel("claude", "some-other-model"), "some-other-model")

  const profile = profileById(registry, "claude")
  const smuggled = buildCliArgs(profile, { workDir: "/tmp", model: "--json", prompt: "hi" }, true)
  assert.ok(!smuggled.includes("--json"))
  assert.ok(!smuggled.includes("--model"))

  const kept = buildCliArgs(profile, { workDir: "/tmp", model: "sonnet", prompt: "hi" }, true)
  const at = kept.indexOf("--model")
  assert.ok(at >= 0)
  assert.equal(kept[at + 1], "sonnet")
})

test("registry loads custom profiles, overrides builtins and ignores invalid entries", () => {
  const dir = tempDir("agent-cli-profile-")
  try {
    const path = join(dir, "agents.json")
    writeFileSync(
      path,
      JSON.stringify({
        agents: {
          mycli: {
            label: "My CLI",
            bin: "/bin/echo",
            desc: "custom",
            args: { prompt: ["--ask", "{prompt}"] },
            models: { fast: "Fast Mode" },
            defaultModel: "fast",
          },
          qoder: { defaultModel: "DeepSeek-Flash" },
          "Bad Id": { bin: "x" },
          badplaceholder: { bin: "x", args: { prompt: ["{nope}"] } },
          badinstall: { bin: "x", installSpec: { method: "npm", package: "foo; rm -rf /" } },
          opencode: { bin: "x" },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path, log })

    const custom = profileById(registry, "mycli")
    assert.equal(custom.label, "My CLI")
    assert.equal(custom.supportsModel, true)
    assert.equal(custom.defaultModel, "fast")
    assert.deepEqual(custom.args.prompt, ["--ask", "{prompt}"])
    assert.equal(registry.resolveModel("mycli", "fast mode"), "fast")
    assert.equal(registry.resolveModel("mycli", "anything-else"), "anything-else")

    assert.equal(profileById(registry, "qoder").defaultModel, "DeepSeek-Flash")
    assert.equal(registry.resolveModel("qoder", "qwen"), "Qwen3.8-Flash")

    assert.equal(registry.get("bad id"), undefined)
    assert.equal(registry.get("badplaceholder"), undefined)
    assert.equal(registry.get("badinstall"), undefined)
    assert.equal(registry.get("opencode"), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("registry supports array-form profile files", () => {
  const dir = tempDir("agent-cli-array-")
  try {
    const path = join(dir, "agents.json")
    writeFileSync(
      path,
      JSON.stringify([
        { id: "echoer", bin: "/bin/echo", args: { prompt: ["{prompt}"] } },
        { id: "ignored" },
      ]),
    )
    const registry = new AgentCliRegistry({ path, log })
    assert.equal(registry.get("echoer")?.bin, "/bin/echo")
    assert.equal(registry.get("ignored"), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("whichSync finds executables by absolute path and reports misses", () => {
  assert.equal(whichSync(process.execPath), process.execPath)
  assert.equal(whichSync("/definitely/not/a/real/binary-xyz"), undefined)
  assert.equal(whichSync("definitely-not-a-real-binary-xyz"), undefined)
})

test("whichSync expands a leading tilde", () => {
  const dir = tempDir("agent-cli-home-")
  try {
    mkdirSync(join(dir, "bin"), { recursive: true })
    const tool = join(dir, "bin", "tool")
    writeExecutable(tool, "")
    const previous = process.env.HOME
    process.env.HOME = dir
    try {
      assert.equal(whichSync("~/bin/tool"), tool)
      assert.equal(whichSync("~/bin/missing"), undefined)
    } finally {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildCliArgs keeps placeholders inside substituted values literal", () => {
  const profile: AgentCliProfile = {
    id: "tpl",
    label: "Tpl",
    bin: "tpl",
    desc: "test",
    sessionMode: "stateless",
    parse: "text",
    args: {
      base: ["run"],
      model: ["--model", "{model}"],
      prompt: ["{prompt}"],
    },
  }
  assert.deepEqual(
    buildCliArgs(
      profile,
      { workDir: "/w/{prompt}", model: "{prompt}", prompt: "keep {model} and {workDir}" },
      true,
    ),
    ["run", "--model", "{prompt}", "keep {model} and {workDir}"],
  )
  assert.deepEqual(buildCliArgs(profile, { workDir: "/w", prompt: "a{b} {sessionId}" }, true), [
    "run",
    "a{b} {sessionId}",
  ])
})

test("buildCliArgs never lets a prompt reach argv as a flag", () => {
  const positional: AgentCliProfile = {
    id: "pos",
    label: "Pos",
    bin: "pos",
    desc: "test",
    sessionMode: "stateless",
    parse: "text",
    args: { base: ["-p", "--sandbox"], prompt: ["{prompt}"] },
  }
  const bound: AgentCliProfile = {
    id: "bound",
    label: "Bound",
    bin: "bound",
    desc: "test",
    sessionMode: "stateless",
    parse: "text",
    args: { base: ["run"], prompt: ["--message", "{prompt}"] },
  }

  // `-c` would otherwise be commander's --continue and resume another session;
  // a pasted bullet list broke the invocation outright
  for (const raw of ["-c", "--dangerously-skip-permissions", "- item one\n- item two"]) {
    const args = buildCliArgs(positional, { workDir: "/w", prompt: raw }, true)
    assert.deepEqual(args.slice(0, 2), ["-p", "--sandbox"])
    assert.equal(args[2]?.startsWith(" "), true, `${raw} reached argv as an option`)
    assert.equal(args[2]?.trim(), raw)

    const boundArgs = buildCliArgs(bound, { workDir: "/w", prompt: raw }, true)
    assert.deepEqual(boundArgs, ["run", "--message", ` ${raw}`])
  }

  // A prompt that only happens to contain a dash later stays untouched
  assert.deepEqual(buildCliArgs(positional, { workDir: "/w", prompt: "a -b c" }, true), [
    "-p",
    "--sandbox",
    "a -b c",
  ])
})

test("buildCliArgs renders placeholders in a stable order", () => {
  const registry = new AgentCliRegistry({ log })
  const qoder = profileById(registry, "qoder")
  assert.deepEqual(buildCliArgs(qoder, { workDir: "/work", sessionId: "s-1", model: "DeepSeek-Flash", prompt: "检查" }, true), [
    "-p",
    "--session-id",
    "s-1",
    "--dangerously-skip-permissions",
    "-w",
    "/work",
    "-m",
    "DeepSeek-Flash",
    "检查",
  ])
  assert.deepEqual(buildCliArgs(qoder, { workDir: "/work", sessionId: "s-1", model: "Qwen3.8-Flash", prompt: "继续" }, false), [
    "-p",
    "-r",
    "s-1",
    "--dangerously-skip-permissions",
    "-w",
    "/work",
    "-m",
    "Qwen3.8-Flash",
    "继续",
  ])

  const codex = profileById(registry, "codex")
  assert.deepEqual(buildCliArgs(codex, { workDir: "/repo", prompt: "hi" }, true), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/repo",
    "hi",
  ])
  assert.deepEqual(buildCliArgs(codex, { workDir: "/repo", sessionId: "t-9", prompt: "again" }, false), [
    "exec",
    "resume",
    "t-9",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/repo",
    "again",
  ])

  const copilot = profileById(registry, "copilot")
  assert.deepEqual(buildCliArgs(copilot, { workDir: "/repo", model: "gpt-5", prompt: "hello" }, true), [
    "-p",
    "--allow-all-tools",
    "--allow-all-paths",
    "--silent",
    "--model",
    "gpt-5",
    "hello",
  ])
})

test("buildCliArgs only uses resumeBase when a session actually resumes", () => {
  const profile: AgentCliProfile = {
    id: "stateless",
    label: "Stateless",
    bin: "stateless",
    desc: "test",
    sessionMode: "stateless",
    parse: "text",
    args: {
      base: ["run"],
      resumeBase: ["should-not-appear"],
      resumeSession: ["--resume", "{sessionId}"],
      prompt: ["{prompt}"],
    },
  }
  assert.deepEqual(buildCliArgs(profile, { workDir: "/w", prompt: "hi" }, false), ["run", "hi"])
  assert.deepEqual(buildCliArgs(profile, { workDir: "/w", sessionId: "s-1", prompt: "hi" }, false), [
    "should-not-appear",
    "--resume",
    "s-1",
    "hi",
  ])
})

test("normalizeWorkDirInput expands ~ and refuses unusable paths", () => {
  const cwd = "/srv/bot"
  const home = "/home/lee"
  assert.equal(normalizeWorkDirInput("~/projects/app", cwd, home), "/home/lee/projects/app")
  assert.equal(normalizeWorkDirInput("~", cwd, home), home)
  assert.equal(normalizeWorkDirInput("repo/sub", cwd, home), "/srv/bot/repo/sub")
  assert.equal(normalizeWorkDirInput("/var/data/", cwd, home), "/var/data")
  assert.equal(normalizeWorkDirInput('"/var/data"', cwd, home), "/var/data")
  assert.equal(normalizeWorkDirInput("/", cwd, home), undefined)
  assert.equal(normalizeWorkDirInput("", cwd, home), undefined)
  assert.equal(normalizeWorkDirInput("a\u0000b", cwd, home), undefined)
  assert.equal(normalizeWorkDirInput("x".repeat(600), cwd, home), undefined)
})

test("AgentCliService runs CLI engines in the chat's own working directory", async () => {
  const dir = tempDir("agent-cli-workdir-")
  try {
    const other = join(dir, "other")
    mkdirSync(other)
    const bin = join(dir, "fake-cwd.js")
    writeExecutable(bin, `process.stdout.write(process.cwd() + "\\n" + (process.argv[2] ?? ""))`)
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: {
          fakecwd: { bin, sessionMode: "stateless", parse: "text", args: { prompt: ["{workDir}"] } },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)
    const base = realpathSync(dir)
    const alt = realpathSync(other)

    assert.equal((await service.prompt("chat", "fakecwd", "hi")).includes(base), true)

    store.setDir("chat", alt)
    assert.equal(service.workDir("chat"), alt)
    const moved = await service.prompt("chat", "fakecwd", "hi")
    assert.equal(moved.includes(alt), true, "the CLI must start inside the chosen directory")
    assert.equal(moved.includes("{workDir}"), false, "the placeholder must reach argv resolved")

    // A directory that vanished has to fall back instead of failing the spawn
    store.setDir("chat", join(dir, "gone"))
    assert.equal(service.workDir("chat"), base)
    store.clearDir("chat")
    assert.equal(store.getDir("chat"), undefined)
    assert.equal(service.workDir("chat"), base)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseCliOutput strips ANSI and handles text mode", () => {
  assert.deepEqual(parseCliOutput("text", "\u001b[31mhello\u001b[0m\r\nworld"), { text: "hello\nworld" })
  assert.deepEqual(parseCliOutput(undefined, "plain"), { text: "plain" })
})

test("parseCliOutput reads single JSON results and errors", () => {
  assert.deepEqual(parseCliOutput("json-result", '{"result":"done","session_id":"s1"}'), {
    text: "done",
    sessionId: "s1",
    error: undefined,
  })
  assert.deepEqual(parseCliOutput("claude-json", '{"type":"result","result":"all good","session_id":"c1","is_error":false}'), {
    text: "all good",
    sessionId: "c1",
    error: undefined,
  })
  const failed = parseCliOutput("json-result", '{"is_error":true,"result":"boom","session_id":"s2"}')
  assert.equal(failed.text, "boom")
  assert.equal(failed.sessionId, "s2")
  assert.equal(failed.error, "boom")

  const broken = parseCliOutput("json-result", '{"oops":')
  assert.equal(broken.error, "无法解析 CLI 返回的 JSON")
})

test("parseCliOutput reads Codex JSONL streams", () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":" world"}}',
    '{"type":"turn.completed"}',
  ].join("\n")
  assert.deepEqual(parseCliOutput("codex-jsonl", raw), { text: "Hello world", sessionId: "t1", error: undefined })

  const failed = parseCliOutput("codex-jsonl", '{"type":"turn.failed","error":{"message":"overloaded"}}')
  assert.equal(failed.error, "overloaded")

  const fallback = parseCliOutput("codex-jsonl", '{"result":"single object","session_id":"one"}')
  assert.deepEqual(fallback, { text: "single object", sessionId: "one", error: undefined })
})

test("parseCliOutput merges Gemini stream messages and detects errors", () => {
  const delta = [
    '{"type":"init","session_id":"g1"}',
    '{"type":"message","role":"assistant","content":"Hi ","delta":true}',
    '{"type":"message","role":"assistant","content":"there","delta":true}',
    '{"type":"result","status":"success"}',
  ].join("\n")
  assert.deepEqual(parseCliOutput("gemini-stream", delta), { text: "Hi there", sessionId: "g1", error: undefined })

  const cumulative = [
    '{"type":"message","role":"model","content":"Hello"}',
    '{"type":"message","role":"model","content":"Hello world"}',
  ].join("\n")
  assert.equal(parseCliOutput("gemini-stream", cumulative).text, "Hello world")

  const failed = parseCliOutput("gemini-stream", '{"type":"result","status":"error","error":"quota exceeded"}')
  assert.equal(failed.error, "quota exceeded")
})

test("AgentCliService preassigns, stores and resumes sessions", async () => {
  const dir = tempDir("agent-cli-preassign-")
  try {
    const argsLog = join(dir, "args.log")
    const bin = join(dir, "fake-pre.js")
    writeExecutable(
      bin,
      `const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
process.stdout.write("first line\\nsecond line\\n")`,
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: {
          fakepre: {
            bin,
            sessionMode: "preassign",
            parse: "text",
            args: {
              base: ["-p"],
              newSession: ["--session-id", "{sessionId}"],
              resumeSession: ["-r", "{sessionId}"],
              prompt: ["{prompt}"],
            },
          },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)

    const progress: string[] = []
    const first = await service.prompt("chat", "fakepre", "hello world", undefined, (step) => progress.push(step))
    assert.match(first, /first line/)
    const session = store.getCliSession("chat", "fakepre")
    assert.ok(session, "session should be assigned before spawning")
    const calls = readFileSync(argsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls[0], ["-p", "--session-id", session, "hello world"])
    assert.ok(progress.includes("first line"))

    await service.prompt("chat", "fakepre", "more")
    const resumed = readFileSync(argsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    assert.deepEqual(resumed[1], ["-p", "-r", session, "more"])
    assert.equal(store.getCliSession("chat", "fakepre"), session)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AgentCliService captures session ids from output and resumes them", async () => {
  const dir = tempDir("agent-cli-capture-")
  try {
    const argsLog = join(dir, "args.log")
    const bin = join(dir, "fake-capture.js")
    writeExecutable(
      bin,
      `const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
process.stdout.write(JSON.stringify({ result: "captured reply", session_id: "cap-1" }))`,
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: {
          fakecap: {
            bin,
            sessionMode: "capture",
            parse: "json-result",
            args: { base: ["run"], resumeSession: ["--resume", "{sessionId}"], prompt: ["{prompt}"] },
          },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)

    assert.equal(await service.prompt("chat", "fakecap", "hello"), "captured reply")
    assert.equal(store.getCliSession("chat", "fakecap"), "cap-1")

    assert.equal(await service.prompt("chat", "fakecap", "again"), "captured reply")
    const calls = readFileSync(argsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls[1], ["run", "--resume", "cap-1", "again"])
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AgentCliService retries with a fresh session when resume fails", async () => {
  const dir = tempDir("agent-cli-retry-")
  try {
    const argsLog = join(dir, "args.log")
    const bin = join(dir, "fake-retry.js")
    writeExecutable(
      bin,
      `const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n")
if (args.includes("dead-id")) {
  process.stderr.write("Error: session not found\\n")
  process.exit(1)
}
const index = args.indexOf("--session-id")
const id = index >= 0 ? args[index + 1] : "none"
process.stdout.write(JSON.stringify({ result: "fresh ok", session_id: id }))`,
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: {
          fakeretry: {
            bin,
            sessionMode: "preassign",
            parse: "json-result",
            resumeErrorPattern: "session not found",
            args: {
              base: ["-p"],
              newSession: ["--session-id", "{sessionId}"],
              resumeSession: ["-r", "{sessionId}"],
              prompt: ["{prompt}"],
            },
          },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    store.setCliSession("chat", "fakeretry", "dead-id")
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)

    assert.equal(await service.prompt("chat", "fakeretry", "resume me"), "fresh ok")
    const calls = readFileSync(argsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], ["-p", "-r", "dead-id", "resume me"])
    assert.equal(calls[1]?.[1], "--session-id")

    const stored = store.getCliSession("chat", "fakeretry")
    assert.ok(stored && stored !== "dead-id")
    assert.equal(calls[1]?.[2], stored)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AgentCliService reports missing executables with install hints", async () => {
  const dir = tempDir("agent-cli-missing-")
  try {
    const registryPath = join(dir, "agents.json")
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: {
          ghost: { label: "Ghost CLI", bin: "/nonexistent/ghost-cli", install: "npm install -g ghost", args: {} },
        },
      }),
    )
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)

    await assert.rejects(service.prompt("chat", "ghost", "hi"), /未找到 \/nonexistent\/ghost-cli 可执行文件.*npm install -g ghost/s)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("terminateProcess escalates to SIGKILL when SIGTERM is ignored", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  )
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve())
      child.once("error", reject)
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }))
    })

    const startedAt = Date.now()
    terminateProcess(child, 150)
    const result = await closed

    assert.equal(result.signal, "SIGKILL")
    assert.ok(Date.now() - startedAt >= 100, "SIGKILL must wait for the grace period")
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})

test("extendedPath finds self-installed CLIs without demoting system PATH entries", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-home-"))
  const systemBin = mkdtempSync(join(tmpdir(), "bot-system-"))
  try {
    mkdirSync(join(home, ".local/bin"), { recursive: true })
    writeExecutable(join(home, ".local/bin", "fake-agent"), "echo home")
    writeExecutable(join(systemBin, "fake-agent"), "echo system")

    const withSystem = extendedPath(systemBin, home)
    assert.ok(withSystem.split(delimiter).includes(join(home, ".local/bin")))
    assert.equal(whichSync("fake-agent", withSystem), join(systemBin, "fake-agent"))

    // systemd / cron start the bot with a PATH that lacks every per-user bin dir
    assert.equal(whichSync("fake-agent", extendedPath("", home)), join(home, ".local/bin", "fake-agent"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(systemBin, { recursive: true, force: true })
  }
})

test("buildCliArgs drops a session id that argv would read as another flag", () => {
  const registry = new AgentCliRegistry({ log })
  const profile = profileById(registry, "claude")
  const vars = { workDir: "/srv/project", model: "sonnet", prompt: "hi" }

  const injected = buildCliArgs(profile, { ...vars, sessionId: "--no-sandbox-injected" }, false)
  assert.ok(!injected.includes("--no-sandbox-injected"), "session id must not become a flag")
  assert.ok(!injected.includes("-r"), "the resume switch must be dropped with the unusable id")
  assert.ok(!injected.includes(""), "an empty placeholder must not reach argv")

  const usable = buildCliArgs(profile, { ...vars, sessionId: "550e8400-e29b-41d4-a716-446655440000" }, false)
  assert.ok(usable.includes("550e8400-e29b-41d4-a716-446655440000"))
})

test("AgentCliService reassembles a multi-byte reply split across output chunks", async () => {
  const dir = tempDir("agent-cli-utf8-")
  try {
    const bin = join(dir, "fake-split.js")
    // 好 is e5 a5 bd: the stream is written as two halves so they arrive in separate
    // data events, which is what a chunk-by-chunk toString() corrupts
    writeExecutable(
      bin,
      `process.stdout.write(Buffer.from([0xe5, 0xa5]))
setTimeout(() => process.stdout.write(Buffer.from([0xbd, 0xe8, 0xaf, 0xb7])), 50)`,
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(registryPath, JSON.stringify({ agents: { split: { bin, parse: "text", args: {} } } }))
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)

    assert.equal(await service.prompt("chat", "split", "hi"), "好请")
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("AgentCliService reports carriage-return progress without buffering the run", async () => {
  const dir = tempDir("agent-cli-cr-")
  try {
    const bin = join(dir, "fake-cr.js")
    writeExecutable(
      bin,
      `process.stdout.write("\\rphase one\\rphase two\\n")
setTimeout(() => process.stdout.write("done\\n"), 60)`,
    )
    const registryPath = join(dir, "agents.json")
    writeFileSync(registryPath, JSON.stringify({ agents: { cr: { bin, parse: "text", args: {} } } }))
    const registry = new AgentCliRegistry({ path: registryPath, log })
    const store = new SessionStore(join(dir, "sessions.json"), log)
    const service = new AgentCliService(dir, store, log, 10_000, 10_000, undefined, registry)

    const steps: string[] = []
    const reply = await service.prompt("chat", "cr", "hi", undefined, (step) => steps.push(step))
    assert.match(reply, /done$/)
    assert.deepEqual(steps, ["phase one", "phase two", "done"])
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("terminateProcess reaches a grandchild that outlives its wrapper shim", async () => {
  const wrapper =
    'const { spawn } = require("node:child_process");' +
    'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });' +
    "process.exit(0)"
  const child = spawn(process.execPath, ["-e", wrapper], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const grace = new Promise<never[]>((resolve) => {
    setTimeout(() => resolve([]), 5_000).unref()
  })
  try {
    const drained = new Promise<string>((resolve) => {
      child.stdout!.once("end", () => resolve("end"))
      void grace.then(() => resolve("timeout"))
    })
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve())
      child.once("error", reject)
    })

    terminateProcess(child, 200)
    assert.equal(await drained, "end", "an exited wrapper must still cost its group a signal")
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
  }
})
