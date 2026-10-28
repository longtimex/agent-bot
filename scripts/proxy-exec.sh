#!/usr/bin/env bash
# Run a command with the proxy currently enabled from the Telegram /proxy panel.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f data/proxy.env ]; then
  set -a
  # shellcheck disable=SC1091
  . data/proxy.env
  set +a
fi

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/proxy-exec.sh <command> [args...]" >&2
  exit 1
fi

exec "$@"
