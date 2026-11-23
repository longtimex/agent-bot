#!/usr/bin/env node
/**
 * Restores a `/ops backup` archive. The bot can create backups from chat but never restore
 * one, which meant a backup nobody had ever unpacked; this keeps the destructive half on a
 * terminal where a human is present.
 *
 *   node scripts/restore-backup.mjs --list
 *   node scripts/restore-backup.mjs --file backup-20261116-101500123.tar.gz [--data data] [--force]
 *
 * Stop the bot first: a running bot writes its in-memory state back over the restored files.
 *
 * A restore always snapshots the current state first, and refuses an archive whose entries
 * carry a path, so a tampered backup cannot write outside the data directory.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"

const NAME_RE = /^backup-\d{8}-\d{9}\.tar\.gz$/
const SECRET_FILES = new Set(["api-token.json", "api-enc-key.json"])
// Ciphertext under accounts.key; restoring them without a matching key restores nothing usable
const KEY_FILE = "accounts.key"
const ENCRYPTED_STORES = ["accounts.json", "agent-providers.json", "agent-custom-models.json"]

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

/** Entries that are not regular files (symlinks, hard links, devices, directories). */
function nonRegularEntries(file) {
  // The first column of a verbose listing is the type: "-" is a regular file in both GNU tar
  // and bsdtar. A symlink named sessions.json would otherwise be restored as a link that points
  // outside the data directory, and every plain read of that store would follow it.
  const result = spawnSync("tar", ["-tvzf", file], { encoding: "utf8", cwd: backupDir })
  if (result.error) fail(`无法读取 tar：${result.error.message}`)
  if (result.status !== 0) fail(`tar 列表失败：${(result.stderr ?? "").trim()}`)
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("-"))
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

/**
 * The pid in data/bot.lock when that process is still alive. The bot loads every store once and
 * writes its in-memory copy back on the next change, so a restore under a running bot is quietly
 * undone by the next task, reminder or alias edit, with nothing to say it happened.
 */
function liveBotPid(dir) {
  let pid
  try {
    pid = Number(readFileSync(join(dir, "bot.lock"), "utf8").trim().split(/\s+/, 1)[0])
  } catch {
    return undefined
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch (err) {
    // EPERM: the process exists but belongs to another user, which is still a running bot
    return err?.code === "EPERM" ? pid : undefined
  }
}

const name = argValue("--file")
if (!name) fail("用法：--list 或 --file <backup-*.tar.gz>")
const runningPid = liveBotPid(dataDir)
if (runningPid !== undefined && !process.argv.includes("--force")) {
  fail(
    `Bot 正在运行（PID ${runningPid}），恢复后它会用内存里的旧数据覆盖刚恢复的文件。` +
      "请先执行 npm run bot -- stop，再恢复；确认要强制恢复可加 --force。",
  )
}
if (!NAME_RE.test(name)) fail(`文件名不匹配备份格式：${name}`)

const file = join(backupDir, name)
if (!file.startsWith(`${backupDir}/`) && !file.startsWith(`${backupDir}\\`)) fail("备份路径越界")
if (!existsSync(file)) fail(`备份不存在：${file}`)

// A tar entry is normally a bare file name because the archive is built with -C; anything
// carrying a separator or a parent segment would land outside the data directory.
const entries = archiveEntries(name)
const unsafe = entries.filter((entry) => entry.includes("/") || entry.includes("\\") || entry.startsWith(".."))
if (unsafe.length > 0) fail(`备份包含可疑条目，已拒绝恢复：${unsafe.slice(0, 3).join(", ")}`)
const special = nonRegularEntries(name)
if (special.length > 0) fail(`备份包含非普通文件（链接或目录），已拒绝恢复：${special.slice(0, 3).join(" | ")}`)

// Older backups left the account key out. Restoring their encrypted stores onto a machine that
// has no key would succeed silently and leave every password unreadable, so stop and say why.
const archiveHasKey = entries.includes(KEY_FILE)
const encryptedInArchive = ENCRYPTED_STORES.filter((store) => entries.includes(store))
const localKey = existsSync(join(dataDir, KEY_FILE))
if (encryptedInArchive.length > 0 && !archiveHasKey) {
  if (!localKey && !process.argv.includes("--allow-missing-key")) {
    fail(
      `备份含加密数据（${encryptedInArchive.join(", ")}）但不含 ${KEY_FILE}，当前目录也没有该密钥：恢复后密码将无法解密。` +
        `请先把原机器的 data/${KEY_FILE} 复制到 ${dataDir}，或加 --allow-missing-key 强制恢复。`,
    )
  }
  if (localKey) {
    console.warn(`注意：备份不含 ${KEY_FILE}，将沿用当前密钥；若它不是备份当时的那把，已存密码将无法解密。`)
  }
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)
const snapshotDir = join(backupDir, `pre-restore-${stamp}`)
mkdirSync(snapshotDir, { recursive: true })
let copied = 0
for (const entry of readdirSync(dataDir)) {
  // The key goes in too: a restore may overwrite it, and the snapshot is the only way back
  if ((!entry.endsWith(".json") && entry !== KEY_FILE) || SECRET_FILES.has(entry)) continue
  const from = join(dataDir, entry)
  if (!statSync(from).isFile()) continue
  cpSync(from, join(snapshotDir, entry))
  copied += 1
}

// Both paths stay relative to a cwd inside the data directory: bsdtar on Windows treats a
// drive letter in -f or -C as a remote host name and then cannot find the directory.
const extract = spawnSync("tar", ["-xzf", `backups/${name}`, "--no-same-owner"], { encoding: "utf8", cwd: dataDir })
if (extract.error) fail(`解压失败：${extract.error.message}`)
if (extract.status !== 0) fail(`解压失败：${(extract.stderr ?? "").trim()}`)

console.log(`已恢复 ${entries.length} 个文件到 ${dataDir}`)
console.log(`恢复前的状态已快照到 ${snapshotDir}（${copied} 个文件）`)
if (archiveHasKey) chmodSync(join(dataDir, KEY_FILE), 0o600)
console.log("请重启 Bot 使恢复立即生效：/restart 或 systemctl restart telegram-bot")
