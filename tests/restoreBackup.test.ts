import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import test from "node:test"

const SCRIPT = "scripts/restore-backup.mjs"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function makeBackup(dir: string, name: string, files: Record<string, string>): string {
  const stage = join(dir, "stage")
  mkdirSync(stage, { recursive: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(stage, file), content)
  const out = join(dir, name)
  const tar = spawnSync("tar", ["-czf", name, "-C", stage, ...Object.keys(files)], { encoding: "utf8", cwd: dir })
  assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`)
  return out
}

test("restore-backup lists an empty backup directory without failing", () => {
  const dir = tempDir("bot-restore-empty-")
  try {
    const result = run(["--list", "--data", join(dir, "data")])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /没有可用备份/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup restores a backup and snapshots the current state first", () => {
  const dir = tempDir("bot-restore-ok-")
  try {
    const data = join(dir, "data")
    const backups = join(data, "backups")
    mkdirSync(backups, { recursive: true })
    writeFileSync(join(data, "models.json"), '{"before":true}\n')
    makeBackup(backups, "backup-20260101-000000000.tar.gz", { "models.json": '{"after":true}\n' })

    const result = run(["--file", "backup-20260101-000000000.tar.gz", "--data", data])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(data, "models.json"), "utf8"), '{"after":true}\n')

    // The restore is irreversible on its own, so the previous state must survive somewhere
    const snapshots = spawnSync("ls", [backups], { encoding: "utf8" }).stdout.split("\n")
    assert.ok(snapshots.some((name) => name.startsWith("pre-restore-")), "a pre-restore snapshot is required")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup refuses a name that is not a backup file", () => {
  const dir = tempDir("bot-restore-name-")
  try {
    const data = join(dir, "data")
    mkdirSync(join(data, "backups"), { recursive: true })
    writeFileSync(join(data, "backups", "notes.tar.gz"), "")
    const result = run(["--file", "notes.tar.gz", "--data", data])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /文件名不匹配备份格式/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup refuses an archive that carries a path", () => {
  const dir = tempDir("bot-restore-evil-")
  try {
    const data = join(dir, "data")
    const backups = join(data, "backups")
    mkdirSync(backups, { recursive: true })
    mkdirSync(join(dir, "outside"), { recursive: true })
    writeFileSync(join(dir, "outside", "secret.txt"), "leak")

    const tar = spawnSync("tar", ["-czf", "backup-20260101-000000001.tar.gz", "-C", join(dir, "outside"), "../outside/secret.txt"], {
      encoding: "utf8",
      cwd: backups,
    })
    assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`)

    const result = run(["--file", "backup-20260101-000000001.tar.gz", "--data", data])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /可疑条目/)
    assert.equal(existsSync(join(data, "secret.txt")), false, "nothing may be written outside the archive")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup refuses encrypted stores when no key can decrypt them", () => {
  const dir = tempDir("bot-restore-nokey-")
  try {
    const data = join(dir, "data")
    const backups = join(data, "backups")
    mkdirSync(backups, { recursive: true })
    makeBackup(backups, "backup-20260101-000000002.tar.gz", { "accounts.json": '{"version":1,"accounts":[]}\n' })

    const refused = run(["--file", "backup-20260101-000000002.tar.gz", "--data", data])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /accounts\.key/)
    assert.equal(existsSync(join(data, "accounts.json")), false, "nothing may be restored on refusal")

    const forced = run(["--file", "backup-20260101-000000002.tar.gz", "--data", data, "--allow-missing-key"])
    assert.equal(forced.status, 0, forced.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup restores the account key together with the vault", () => {
  const dir = tempDir("bot-restore-key-")
  try {
    const data = join(dir, "data")
    const backups = join(data, "backups")
    mkdirSync(backups, { recursive: true })
    const key = `${"cd".repeat(32)}\n`
    makeBackup(backups, "backup-20260101-000000003.tar.gz", {
      "accounts.json": '{"version":1,"accounts":[]}\n',
      "accounts.key": key,
    })
    const result = run(["--file", "backup-20260101-000000003.tar.gz", "--data", data])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(data, "accounts.key"), "utf8"), key)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup refuses an archive that carries a symlink", { skip: process.platform === "win32" }, () => {
  const dir = tempDir("bot-restore-link-")
  try {
    const data = join(dir, "data")
    const backups = join(data, "backups")
    mkdirSync(backups, { recursive: true })
    const stage = join(dir, "stage")
    mkdirSync(stage, { recursive: true })
    spawnSync("ln", ["-s", "/etc/passwd", join(stage, "sessions.json")])
    const tar = spawnSync("tar", ["-czf", "backup-20260101-000000004.tar.gz", "-C", stage, "sessions.json"], {
      encoding: "utf8",
      cwd: backups,
    })
    assert.equal(tar.status, 0, tar.stderr)
    const result = run(["--file", "backup-20260101-000000004.tar.gz", "--data", data])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /非普通文件/)
    assert.equal(existsSync(join(data, "sessions.json")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("restore-backup refuses while the bot is running and --force overrides", () => {
  const dir = tempDir("bot-restore-running-")
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" })
  try {
    const data = join(dir, "data")
    const backups = join(data, "backups")
    mkdirSync(backups, { recursive: true })
    writeFileSync(join(data, "models.json"), '{"before":true}\n')
    makeBackup(backups, "backup-20260101-000000005.tar.gz", { "models.json": '{"after":true}\n' })
    // A live process holds the bot lock, the way a running bot does
    writeFileSync(join(data, "bot.lock"), `${sleeper.pid}\n`)

    const refused = run(["--file", "backup-20260101-000000005.tar.gz", "--data", data])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /正在运行/)
    assert.equal(readFileSync(join(data, "models.json"), "utf8"), '{"before":true}\n', "nothing restored")

    const forced = run(["--file", "backup-20260101-000000005.tar.gz", "--data", data, "--force"])
    assert.equal(forced.status, 0, forced.stderr)
    assert.equal(readFileSync(join(data, "models.json"), "utf8"), '{"after":true}\n')

    // A lock left by a dead process does not block a restore
    sleeper.kill()
    writeFileSync(join(data, "bot.lock"), "2147483646\n")
    const stale = run(["--file", "backup-20260101-000000005.tar.gz", "--data", data])
    assert.equal(stale.status, 0, stale.stderr)
  } finally {
    sleeper.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
