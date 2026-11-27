#!/usr/bin/env bash
# Run a command with the proxy currently enabled from the Telegram /proxy panel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_ROOT="${DATA_DIR:-$ROOT/data}"
case "$DATA_ROOT" in
  /*) ;;
  *) DATA_ROOT="$ROOT/$DATA_ROOT" ;;
esac
PROXY_ENV="$DATA_ROOT/proxy.env"

if [ -f "$PROXY_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PROXY_ENV"
  set +a
fi

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/proxy-exec.sh <command> [args...]" >&2
  exit 1
fi

exec "$@"
