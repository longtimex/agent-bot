import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { main } from "../src/bot-cli.js"
import { isSafeDataRoot, removeManaged, removeUnit } from "../src/lifecycle-files.js"
import { parseLifecycleOptions } from "../src/lifecycle-options.js"
import { writeInstallManifest } from "../src/runtime.js"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bot-lifecycle-"))
}

function writeManifest(dir: string, extra: Record<string, unknown> = {}): void {
  writeInstallManifest(dir, {
    version: 1,
    projectDir: dir,
    supervisor: "script",
    installedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  })
}

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(previous)
  }
}

test("lifecycle options keep subcommand flags and consume shared flags", () => {
  const parsed = parseLifecycleOptions([
    "setup",
    "--check-tools",
    "--skip-deps",
    "--skip-build",
    "--no-opencode",
    "--purge-data",
    "--yes",
  ])
  assert.equal(parsed.command, "setup")
  assert.deepEqual(parsed.args, ["--check-tools"])
  assert.equal(parsed.options.skipDeps, true)
  assert.equal(parsed.options.skipBuild, true)
  assert.equal(parsed.options.opencode, false)
  assert.equal(parsed.options.purgeData, true)
  assert.equal(parsed.options.yes, true)
})

test("managed removal refuses unmanaged files and accepts regular managed files", () => {
  const dir = tempDir()
  try {
    const managed = join(dir, "managed")
    const unmanaged = join(dir, "unmanaged")
    writeFileSync(managed, "# managed by agent-bot\n")
    writeFileSync(unmanaged, "keep me\n")
    assert.equal(removeManaged(managed, "launcher", false), true)
    assert.equal(existsSync(managed), false)
    assert.equal(removeManaged(unmanaged, "launcher", false), false)
    assert.equal(readFileSync(unmanaged, "utf8"), "keep me\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstall keeps data and .env by default and removes its launcher", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "data", "keep.json"), "{}\n")
    writeFileSync(join(dir, ".env"), "DATA_DIR=./data\n")
    const launcher = join(dir, "bin", "agent-bot")
    writeFileSync(launcher, "#!/bin/sh\n# managed by agent-bot\nexit 0\n")
    writeManifest(dir, { launcher })
    await inDir(dir, async () => assert.equal(await main(["uninstall", "--yes"]), 0))
    assert.equal(existsSync(join(dir, "data", "keep.json")), true)
    assert.equal(existsSync(join(dir, ".env")), true)
    assert.equal(existsSync(launcher), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstall --purge-data removes data and .env but leaves the checkout", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, "data", "remove.json"), "{}\n")
    writeFileSync(join(dir, ".env"), "DATA_DIR=./data\n")
    writeManifest(dir)
    await inDir(dir, async () => assert.equal(await main(["uninstall", "--purge-data", "--yes"]), 0))
    assert.equal(existsSync(join(dir, "data")), false)
    assert.equal(existsSync(join(dir, ".env")), false)
    assert.equal(existsSync(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstall --dry-run removes nothing", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, ".env"), "DATA_DIR=./data\n")
    writeManifest(dir)
    await inDir(dir, async () => assert.equal(await main(["uninstall", "--purge-data", "--dry-run", "--yes"]), 0))
    assert.equal(existsSync(join(dir, "data")), true)
    assert.equal(existsSync(join(dir, ".env")), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstall rejects an unsafe data root before stopping or deleting anything", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "project"), { recursive: true })
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "project", "keep.json"), "{}\n")
    // DATA_DIR must not resolve to the checkout itself: purging it would remove
    // the repository along with its launcher and metadata.
    writeFileSync(join(dir, ".env"), "DATA_DIR=.\n")
    const launcher = join(dir, "bin", "agent-bot")
    writeFileSync(launcher, "#!/bin/sh\n# managed by agent-bot\nexit 0\n")
    writeManifest(dir, { launcher, projectDir: dir })
    await inDir(dir, async () => {
      assert.equal(await main(["uninstall", "--purge-data", "--yes"]), 1)
    })
    assert.equal(existsSync(join(dir, "project", "keep.json")), true)
    assert.equal(existsSync(launcher), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstall --dry-run reports a system unit without probing sudo", async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "data"), { recursive: true })
    const unitPath = join(dir, "agent-bot.service")
    writeFileSync(unitPath, "# managed by agent-bot\n[Service]\n")
    writeManifest(dir, {
      supervisor: "systemd",
      unitPath,
      unitName: "agent-bot.service",
      systemdScope: "system",
    })
    // A dry run is informational: it must not require sudo just to read a
    // root-owned unit or decide whether removal is possible.
    await inDir(dir, async () => assert.equal(await main(["uninstall", "--dry-run", "--yes"]), 0))
    assert.equal(existsSync(unitPath), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--keep-data overrides an earlier --purge-data", () => {
  const parsed = parseLifecycleOptions(["uninstall", "--purge-data", "--keep-data"])
  assert.equal(parsed.options.purgeData, false)
  assert.equal(parsed.options.keepData, true)
})

test("lifecycle rejects conflicting supervisor and purge options", async () => {
  assert.equal(await main(["install", "--systemd", "--user-systemd", "--dry-run"]), 1)
  assert.equal(await main(["install", "--docker", "--systemd", "--dry-run"]), 1)
  assert.equal(await main(["start", "--purge-data", "--dry-run", "--yes"]), 1)
})

test("an unsafe data root cannot be purged", () => {
  assert.equal(isSafeDataRoot("/tmp/project", "/tmp/project"), false)
  assert.equal(isSafeDataRoot("/", "/project"), false)
  assert.equal(isSafeDataRoot("/tmp/project-data", "/tmp/project"), true)
  assert.equal(isSafeDataRoot("/tmp", "/tmp/project"), false)
})

test("unit removal uses the managed marker", () => {
  const dir = tempDir()
  try {
    const unit = join(dir, "agent-bot.service")
    writeFileSync(unit, "[Service]\n")
    assert.equal(removeUnit(unit, true, false), false)
    assert.equal(existsSync(unit), true)
    writeFileSync(unit, "# managed by agent-bot\n[Service]\n")
    assert.equal(removeUnit(unit, true, false), true)
    assert.equal(existsSync(unit), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
