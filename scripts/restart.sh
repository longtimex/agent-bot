#!/usr/bin/env bash
# Compatibility entry point. Lifecycle logic lives in src/bot-cli.ts so this
# script, `npm run restart`, and the chat /restart command share one health gate.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f dist/bot-cli.js ]; then
  exec node dist/bot-cli.js restart
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
  exec node "$release_cli" restart
fi

if [ -f src/bot-cli.ts ]; then
  exec npx --no-install tsx src/bot-cli.ts restart
fi
echo "agent-bot: no usable lifecycle entry; run npm run bot -- install first" >&2
exit 1
