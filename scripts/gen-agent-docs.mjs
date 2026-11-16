#!/usr/bin/env node
/**
 * Regenerates the two agent tables in README.md from src/agentProfiles.ts.
 *
 *   node --import tsx scripts/gen-agent-docs.mjs           # rewrite README.md
 *   node --import tsx scripts/gen-agent-docs.mjs --check   # fail when stale (CI)
 *
 * The tables used to be hand-maintained next to the profile list, so adding or removing a
 * CLI meant editing five places and hoping none was missed. One of them already drifted:
 * the ops hint still advertised `/agents install opencode-cli` after that profile was gone.
 */
import { readFileSync, writeFileSync } from "node:fs"
import process from "node:process"
import { BUILTIN_AGENT_PROFILES } from "../src/agentProfiles.ts"

const README = "README.md"
const TABLE_MARK = "AGENT TABLE"
const INSTALL_MARK = "AGENT INSTALL TABLE"

const SESSION_LABEL = {
  preassign: "续接",
  capture: "捕获续接",
  stateless: "单次",
}

function modelDiscovery(profile) {
  const suffix = profile.experimental ? "（实验性）" : ""
  if (!profile.supportsModel) return `不支持切换${suffix}`
  if (profile.modelProbe) return `\`${profile.bin} ${profile.modelProbe.args.join(" ")}\`${suffix}`
  return `无列表命令，模型 ID 透传${suffix}`
}

function renderAgentTable() {
  const rows = BUILTIN_AGENT_PROFILES.map((profile) => {
    const session = SESSION_LABEL[profile.sessionMode] ?? profile.sessionMode
    return `| \`${profile.id}\` | ${profile.label} | \`${profile.bin}\` | ${session} | ${modelDiscovery(profile)} |`
  })
  return [
    `<!-- BEGIN ${TABLE_MARK}: edited by \`npm run docs:agents\`, do not hand-edit -->`,
    "| id | 名称 | 可执行文件 | 会话 | 模型发现 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    `<!-- END ${TABLE_MARK} -->`,
  ].join("\n")
}

function installCommand(spec) {
  if (!spec) return undefined
  if (spec.method === "npm") return `npm install -g ${spec.package}`
  if (spec.method === "pip") return `python3 -m pip install --user ${spec.package}`
  return undefined
}

function renderInstallTable() {
  const rows = BUILTIN_AGENT_PROFILES.flatMap((profile) => {
    const command = installCommand(profile.installSpec)
    return command ? [`| \`${profile.id}\` | \`${command}\` |`] : []
  })
  return [
    `<!-- BEGIN ${INSTALL_MARK}: edited by \`npm run docs:agents\`, do not hand-edit -->`,
    "| id | 安装命令 |",
    "| --- | --- |",
    ...rows,
    `<!-- END ${INSTALL_MARK} -->`,
  ].join("\n")
}

function replaceBlock(source, mark, body) {
  const begin = `<!-- BEGIN ${mark}:`
  const end = `<!-- END ${mark} -->`
  const beginAt = source.indexOf(begin)
  const endAt = source.indexOf(end)
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    throw new Error(`README.md 缺少 ${mark} 标记，无法安全替换`)
  }
  const lineStart = source.lastIndexOf("\n", beginAt) + 1
  const lineEnd = source.indexOf("\n", endAt)
  const tail = lineEnd < 0 ? "" : source.slice(lineEnd)
  return source.slice(0, lineStart) + body + tail
}

function regenerate(source) {
  return replaceBlock(replaceBlock(source, TABLE_MARK, renderAgentTable()), INSTALL_MARK, renderInstallTable())
}

const check = process.argv.includes("--check")
const current = readFileSync(README, "utf8")
const next = regenerate(current)

if (next === current) {
  console.log(`agent docs ok: ${BUILTIN_AGENT_PROFILES.length} profile(s)`)
  process.exit(0)
}

if (check) {
  console.error("README.md 的引擎表与 src/agentProfiles.ts 不一致。运行 `npm run docs:agents` 重新生成。")
  process.exit(1)
}

writeFileSync(README, next)
console.log(`agent docs regenerated: ${BUILTIN_AGENT_PROFILES.length} profile(s)`)
