import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { DATA_SCHEMA_VERSION, migrateDataDirectory, readSchemaState } from "../src/dataMigration.js"
import type { Logger } from "../src/logger.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("migration snapshots state before stamping the schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-migrate-"))
  try {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ app: { sessionID: "s1", updatedAt: "" } }))
    writeFileSync(join(dir, "reminders.json"), JSON.stringify({ nextId: 1, reminders: [] }))
    writeFileSync(join(dir, "api-token.json"), JSON.stringify({ token: "secret" }))
    const result = migrateDataDirectory(dir, log, new Date("2026-01-02T03:04:05Z"))
    assert.equal(result.ok, true)
    assert.deepEqual(result.files.sort(), ["reminders.json", "sessions.json"])
    const state = readSchemaState(dir)
    assert.equal(state?.version, DATA_SCHEMA_VERSION)
    assert.ok(state?.lastSnapshot && existsSync(state.lastSnapshot))
    assert.equal(readFileSync(join(state.lastSnapshot!, "sessions.json"), "utf8").includes("s1"), true)
    assert.equal(existsSync(join(state.lastSnapshot!, "api-token.json")), false, "secrets never enter a migration snapshot")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("migration is idempotent and leaves a malformed store untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-migrate-"))
  try {
    writeFileSync(join(dir, "broken.json"), "{not-json")
    const first = migrateDataDirectory(dir, log)
    assert.equal(first.ok, true)
    assert.match(first.warning ?? "", /broken/)
    const second = migrateDataDirectory(dir, log)
    assert.equal(second.ok, true)
    assert.equal(second.files.length, 0)
    assert.equal(readFileSync(join(dir, "broken.json"), "utf8"), "{not-json")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
