#!/usr/bin/env node
// Architecture guard: large files need an explicit budget, and existing budgets
// must keep shrinking rather than silently regrowing. New files default to 900 lines.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DEFAULT_BUDGET = 900
const budgets = new Map([
  ["telegram.ts", 2200],
  ["api.ts", 1250],
  ["ops.ts", 1200],
  ["agentCli.ts", 1120],
  ["ccCommands.ts", 1100],
  ["ccswitch.ts", 950],
])

const dir = "src"
const violations = []
let checked = 0

for (const name of readdirSync(dir)) {
  if (!name.endsWith(".ts")) continue
  const lines = readFileSync(join(dir, name), "utf8").split("\n").length
  const budget = budgets.get(name) ?? DEFAULT_BUDGET
  checked += 1
  if (lines > budget) violations.push(`${name}: ${lines} lines > budget ${budget}`)
}

if (violations.length > 0) {
  console.error("File size budget exceeded:")
  for (const item of violations) console.error(`  - ${item}`)
  console.error("\nSplit the file or raise its budget deliberately in scripts/check-size.mjs.")
  process.exit(1)
}

console.log(`file size budgets ok (${checked} files)`)
