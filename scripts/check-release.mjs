#!/usr/bin/env node
// The fast gate that runs inside an update before a release may be activated.
// Android source checks and the full test suite still run in CI; this keeps the
// server able to build and serve the App after an update.
import { spawnSync } from "node:child_process"

const steps = [
  ["typecheck", ["run", "typecheck"]],
  ["android sources", ["run", "check:android"]],
  ["size budget", ["run", "check:size"]],
  ["unit tests", ["test"]],
]

for (const [label, args] of steps) {
  console.log(`\n== ${label} ==`)
  const result = spawnSync("npm", args, { stdio: "inherit", env: process.env })
  if (result.status !== 0) {
    console.error(`release gate failed: ${label}`)
    process.exit(result.status ?? 1)
  }
}
console.log("\nrelease gate passed")
