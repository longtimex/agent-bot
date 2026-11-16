#!/usr/bin/env node
/**
 * Restores a `/ops backup` archive. The bot can create backups from chat but never restore
 * one, which meant a backup nobody had ever unpacked; this keeps the destructive half on a
 * terminal where a human is present.
 *
 *   node scripts/restore-backup.mjs --list
 *   node scripts/restore-backup.mjs --file backup-20261116-101500123.tar.gz [--data data]
 *
 * A restore always snapshots the current state first, and refuses an archive whose entries
 * carry a path, so a tampered backup cannot write outside the data directory.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"

const NAME_RE = /^backup-\d{8}-\d{9}\.tar\.gz$/
const SECRET_FILES = new Set(["api-token.json", "api-enc-key.json"])

function argValue(flag) {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const dataDir = resolve(argValue("--data") ?? join(process.cwd(), "data"))
const backupDir = join(dataDir, "backups")

function listBackups() {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((name) => NAME_RE.test(name))
    .map((name) => {
      const stat = statSync(join(backupDir, name))
      return { name, bytes: stat.size, at: stat.mtime }
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
}

function fail(message) {
  console.error(`restore-backup: ${message}`)
  process.exit(1)
}

function archiveEntries(file) {
  // tar reads `host:path`, so a Windows drive letter in -f is taken for a remote host.
  // Running from the backup directory keeps the -f argument a bare file name.
  const result = spawnSync("tar", ["-tzf", file], { encoding: "utf8", cwd: backupDir })
  if (result.error) fail(`无法读取 tar：${result.error.message}`)
  if (result.status !== 0) fail(`tar 列表失败：${(result.stderr ?? "").trim()}`)
  return (result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
}

if (process.argv.includes("--list") || process.argv.length === 2) {
  const backups = listBackups()
  if (backups.length === 0) {
    console.log(`没有可用备份（${backupDir}）`)
    process.exit(0)
  }
  for (const backup of backups) {
    console.log(`${backup.name}  ${(backup.bytes / 1024).toFixed(1)}KB  ${backup.at.toISOString()}`)
  }
  process.exit(0)
}

const name = argValue("--file")
if (!name) fail("用法：--list 或 --file <backup-*.tar.gz>")
if (!NAME_RE.test(name)) fail(`文件名不匹配备份格式：${name}`)

const file = join(backupDir, name)
if (!file.startsWith(`${backupDir}/`) && !file.startsWith(`${backupDir}\\`)) fail("备份路径越界")
if (!existsSync(file)) fail(`备份不存在：${file}`)

// A tar entry is normally a bare file name because the archive is built with -C; anything
// carrying a separator or a parent segment would land outside the data directory.
const entries = archiveEntries(name)
const unsafe = entries.filter((entry) => entry.includes("/") || entry.includes("\\") || entry.startsWith(".."))
if (unsafe.length > 0) fail(`备份包含可疑条目，已拒绝恢复：${unsafe.slice(0, 3).join(", ")}`)

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)
const snapshotDir = join(backupDir, `pre-restore-${stamp}`)
mkdirSync(snapshotDir, { recursive: true })
let copied = 0
for (const entry of readdirSync(dataDir)) {
  if (!entry.endsWith(".json") || SECRET_FILES.has(entry)) continue
  const from = join(dataDir, entry)
  if (!statSync(from).isFile()) continue
  cpSync(from, join(snapshotDir, entry))
  copied += 1
}

// Both paths stay relative to a cwd inside the data directory: bsdtar on Windows treats a
// drive letter in -f or -C as a remote host name and then cannot find the directory.
const extract = spawnSync("tar", ["-xzf", `backups/${name}`], { encoding: "utf8", cwd: dataDir })
if (extract.error) fail(`解压失败：${extract.error.message}`)
if (extract.status !== 0) fail(`解压失败：${(extract.stderr ?? "").trim()}`)

console.log(`已恢复 ${entries.length} 个文件到 ${dataDir}`)
console.log(`恢复前的状态已快照到 ${snapshotDir}（${copied} 个 JSON 文件）`)
console.log("请重启 Bot 使恢复立即生效：/restart 或 systemctl restart telegram-bot")
