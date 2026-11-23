import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readDshModel } from "../src/dshConfig.js"

function withDshHome(files: Record<string, string>): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bot-dsh-home-"))
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, body)
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("the headless profile's model is read from its patch file", () => {
  const home = withDshHome({
    "profiles/headless/cordis.patch.yml": ['provider: deepseek-official', 'model: "deepseek-v4-flash"', ""].join("\n"),
  })
  try {
    assert.equal(readDshModel(), "deepseek-v4-flash")
  } finally {
    home.restore()
  }
})

test("the global patch is consulted when no profile names a model", () => {
  const home = withDshHome({ "cordis.patch.yml": "model: deepseek-v4-pro\n" })
  try {
    assert.equal(readDshModel(), "deepseek-v4-pro")
  } finally {
    home.restore()
  }
})

test("credentials in the patch are never mistaken for a model", () => {
  const home = withDshHome({
    "profiles/headless/cordis.patch.yml": [
      "api_key: sk-should-never-surface",
      "providers:",
      "  - name: deepseek",
      "    models:",
      "      - deepseek-chat",
      "",
    ].join("\n"),
  })
  try {
    // No top-level `model:` key: nothing is returned rather than a guess
    assert.equal(readDshModel(), undefined)
  } finally {
    home.restore()
  }
})

test("no config at all yields undefined instead of throwing", () => {
  const home = withDshHome({})
  try {
    assert.equal(readDshModel(), undefined)
  } finally {
    home.restore()
  }
})
