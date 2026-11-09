#!/usr/bin/env bash
# systemd ExecStart entrypoint: run the active managed release, or the checkout
# before the first managed update. `exec` keeps the PID systemd supervises.
set -euo pipefail

cd "$(dirname "$0")/.."

DATA_DIR="${DATA_DIR:-data}"
entry=""
# The release control CLI is part of the checkout build. If the checkout lost its
# dist/ (or the build is older than this script), fall back to the release's own
# copy when one exists; never silently run a different release than state.json says.
if [ -f dist/release-control.js ]; then
  entry="$(node dist/release-control.js entry current 2>/dev/null || true)"
else
  current="$(node -e 'const fs=require("fs");const p=process.argv[1];try{const s=JSON.parse(fs.readFileSync(p,"utf8"));if(s.current&&s.current.path)process.stdout.write(s.current.path+"/dist/index.js")}catch{}' "$DATA_DIR/releases/state.json" 2>/dev/null || true)"
  [ -n "$current" ] && [ -f "$current" ] && entry="$current"
fi
if [ -z "$entry" ] || [ ! -f "$entry" ]; then
  entry="$PWD/dist/index.js"
fi
if [ ! -f "$entry" ]; then
  echo "run-current: no usable dist/index.js (run npm run build first)" >&2
  exit 1
fi
exec node "$entry"
