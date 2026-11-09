#!/usr/bin/env bash
# Compatibility entry point for units generated before the lifecycle CLI.
# `exec` keeps the PID systemd supervises; bot-cli run resolves the release once.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f dist/bot-cli.js ]; then
  exec node dist/bot-cli.js run
fi

release_cli="$(node -e '
  const fs = require("fs");
  const path = require("path");
  try { process.loadEnvFile(".env") } catch {}
  const statePath = path.resolve(process.env.DATA_DIR || "data", "releases", "state.json");
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const key of ["current", "pending", "previous"]) {
      const release = state[key];
      if (!release || typeof release.path !== "string") continue;
      const entry = path.join(release.path, "dist", "bot-cli.js");
      if (fs.existsSync(entry)) { process.stdout.write(entry); break }
    }
  } catch {}
' 2>/dev/null || true)"
if [ -n "$release_cli" ]; then
  exec node "$release_cli" run
fi

if [ -f src/bot-cli.ts ]; then
  exec npx --no-install tsx src/bot-cli.ts run
fi
echo "run-current: no usable lifecycle entry; run npm run build first" >&2
exit 1
