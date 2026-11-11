#!/usr/bin/env sh
# Installs Agent Bot (Telegram, Android App and Feishu control clients) from a git
# checkout or a fresh clone.
#
#   ./install.sh                         # use this checkout
#   curl -fsSL https://raw.githubusercontent.com/longtimex/agent-bot/main/install.sh | sh
#   ./install.sh --dir /opt/agent-bot    # install into a dedicated directory
#
# Environment:
#   AGENT_BOT_REPO      git repository (default: https://github.com/longtimex/agent-bot.git)
#   AGENT_BOT_BRANCH    branch to install (default: main)
#   AGENT_BOT_DIR       install directory (default: the checkout, or ~/.agent-bot)
#   AGENT_BOT_OPENCODE  1 to install the opencode CLI (default: 1)
#   AGENT_BOT_SETUP     1 to run the client setup wizard (Telegram / Android / Feishu)
#                       (default: 1 only when stdin is a TTY)
#   AGENT_BOT_TOOLS     auto to detect and offer Agent CLI / magpie / cc-switch,
#                       check to detect only, 0 to skip (default: auto)
#   AGENT_BOT_SYSTEMD   1 to install a systemd system unit, or user for --user
#   AGENT_BOT_START     1 to start after a successful install
#   AGENT_BOT_SKIP_DEPS / AGENT_BOT_SKIP_BUILD  1 to reuse prepared artifacts
set -eu

repo="${AGENT_BOT_REPO:-https://github.com/longtimex/agent-bot.git}"
branch="${AGENT_BOT_BRANCH:-main}"
install_dir="${AGENT_BOT_DIR:-}"
want_opencode="${AGENT_BOT_OPENCODE:-1}"
want_setup="${AGENT_BOT_SETUP:-auto}"
want_tools="${AGENT_BOT_TOOLS:-auto}"
use_local=auto
start_after="${AGENT_BOT_START:-0}"
dry_run=0
use_systemd=0
use_user_systemd=0
case "${AGENT_BOT_SYSTEMD:-0}" in
  0|"") ;;
  user) use_user_systemd=1 ;;
  1) use_systemd=1 ;;
  *) echo "install.sh: AGENT_BOT_SYSTEMD must be 0, 1 or user" >&2; exit 2 ;;
esac
skip_deps="${AGENT_BOT_SKIP_DEPS:-0}"
skip_build="${AGENT_BOT_SKIP_BUILD:-0}"
want_uninstall=0
purge_data=0
assume_yes=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --dir DIR          install into DIR
  --repo URL         git repository to clone
  --branch NAME      git branch (default: main)
  --local            install this checkout (default when the script is in one)
  --no-opencode      do not install the opencode CLI
  --setup            always open the client setup wizard (even if a client exists)
  --no-setup         do not run the client setup wizard
  --tools            detect and offer Agent CLI / magpie / cc-switch (interactive)
  --check-tools      detect existing Agent CLI / magpie / cc-switch without installing
  --no-tools         skip tool detection and installation
  --start            start the bot after a successful install
  --systemd          install and enable a system-wide systemd unit
  --user-systemd     install and enable a systemd --user unit
  --skip-deps        reuse node_modules (useful for an already-prepared checkout)
  --skip-build       reuse dist/ after a separately run build
  --uninstall        stop the service and remove the launcher/unit; keep data and .env
  --purge-data       with --uninstall: also remove data/ and .env
  --yes              with --uninstall: do not ask for confirmation
  --dry-run          print what would run without changing anything
  -h, --help         show this help

Clients: Telegram / Android / Feishu. The wizard can configure one or more;
rerun npm run clients later to add another client without losing existing settings.

Environment: AGENT_BOT_REPO, AGENT_BOT_BRANCH, AGENT_BOT_DIR,
AGENT_BOT_OPENCODE=0, AGENT_BOT_SETUP=0|1, AGENT_BOT_TOOLS=auto|check|1|0,
AGENT_BOT_SYSTEMD=0|1|user, AGENT_BOT_START=0|1,
AGENT_BOT_SKIP_DEPS=0|1, AGENT_BOT_SKIP_BUILD=0|1
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || { echo "install.sh: --dir needs a path" >&2; exit 2; }
      install_dir="$2"; shift 2 ;;
    --repo)
      [ "$#" -ge 2 ] || { echo "install.sh: --repo needs a URL" >&2; exit 2; }
      repo="$2"; shift 2 ;;
    --branch)
      [ "$#" -ge 2 ] || { echo "install.sh: --branch needs a name" >&2; exit 2; }
      branch="$2"; shift 2 ;;
    --local) use_local=1; shift ;;
    --no-opencode) want_opencode=0; shift ;;
    --setup) want_setup=1; shift ;;
    --no-setup) want_setup=0; shift ;;
    --tools) want_tools=1; shift ;;
    --check-tools) want_tools=check; shift ;;
    --no-tools) want_tools=0; shift ;;
    --start) start_after=1; shift ;;
    --systemd) use_systemd=1; shift ;;
    --user-systemd) use_user_systemd=1; shift ;;
    --skip-deps) skip_deps=1; shift ;;
    --skip-build) skip_build=1; shift ;;
    --uninstall) want_uninstall=1; shift ;;
    --purge-data) purge_data=1; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$use_systemd" -eq 1 ] && [ "$use_user_systemd" -eq 1 ]; then
  echo "install.sh: --systemd and --user-systemd are mutually exclusive" >&2
  exit 2
fi
if [ "$purge_data" -eq 1 ] && [ "$want_uninstall" -eq 0 ]; then
  echo "install.sh: --purge-data requires --uninstall" >&2
  exit 2
fi
case "$start_after" in
  0|1) ;;
  *) echo "install.sh: AGENT_BOT_START must be 0 or 1" >&2; exit 2 ;;
esac
case "$skip_deps" in
  0|1) ;;
  *) echo "install.sh: AGENT_BOT_SKIP_DEPS must be 0 or 1" >&2; exit 2 ;;
esac
case "$skip_build" in
  0|1) ;;
  *) echo "install.sh: AGENT_BOT_SKIP_BUILD must be 0 or 1" >&2; exit 2 ;;
esac

fail() {
  printf '\ninstall.sh: %s\n' "$1" >&2
  exit 1
}

# ANSI only on stderr, so `curl | sh` keeps stdout clean.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
bold= muted= green= reset=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; green="$(printf '\033[32m')"
fi
step() { printf '  %s%s%s\n' "$muted" "$1" "$reset" >&2; }
ok() { printf '  %s%s%s\n' "$green" "$1" "$reset" >&2; }

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf '  + %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

script_dir=""
if [ -n "${0:-}" ] && [ -f "$0" ]; then
  script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
fi

# Prefer an existing checkout when the installer is run from one. A piped
# installer has no script path and therefore clones instead.
from_checkout=0
if [ "$use_local" != 0 ] && [ -n "$script_dir" ] && [ -f "$script_dir/package.json" ] && [ -f "$script_dir/src/index.ts" ]; then
  from_checkout=1
fi
if [ "$use_local" = 1 ] && [ "$from_checkout" -eq 0 ]; then
  fail "--local was requested, but this script is not inside an agent-bot checkout"
fi
if [ -z "$install_dir" ]; then
  if [ "$from_checkout" -eq 1 ]; then install_dir="$script_dir"; else install_dir="$HOME/.agent-bot"; fi
fi

if [ "$want_uninstall" -eq 1 ]; then
  if [ ! -d "$install_dir" ]; then
    fail "cannot uninstall: ${install_dir} does not exist"
  fi
  cd "$install_dir" || fail "cannot enter ${install_dir}"
  if [ ! -f dist/bot-cli.js ] && [ ! -f src/bot-cli.ts ]; then
    fail "cannot uninstall: no lifecycle CLI in ${install_dir}"
  fi
  uninstall_args="uninstall"
  [ "$purge_data" -eq 1 ] && uninstall_args="$uninstall_args --purge-data"
  [ "$assume_yes" -eq 1 ] && uninstall_args="$uninstall_args --yes"
  [ "$dry_run" -eq 1 ] && uninstall_args="$uninstall_args --dry-run"
  step "Uninstalling Agent Bot from ${install_dir}..."
  if [ "$dry_run" -eq 1 ]; then
    # Execute the CLI so it can list the exact units/files it would touch.
    if [ -f dist/bot-cli.js ]; then
      node dist/bot-cli.js $uninstall_args
    else
      npx --no-install tsx src/bot-cli.ts $uninstall_args
    fi
  elif [ -f dist/bot-cli.js ]; then
    node dist/bot-cli.js $uninstall_args
  else
    npx --no-install tsx src/bot-cli.ts $uninstall_args
  fi
  exit 0
fi

step "Checking prerequisites..."
command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js >= 20.18.1 is required (https://nodejs.org)"
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)"
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a < 20 || (a === 20 && (b < 18 || (b === 18 && c < 1)))) process.exit(1)' \
  || fail "Node.js >= 20.18.1 is required (found $(node -v))"

step "Installing into ${install_dir}"
if [ "$from_checkout" -eq 1 ]; then
  ok "Using the existing checkout at ${install_dir}"
elif [ -d "$install_dir/.git" ]; then
  step "Updating the existing checkout..."
  if [ -n "$(git -C "$install_dir" status --porcelain 2>/dev/null)" ]; then
    printf '  %s\n' "Working tree has local changes; leaving it untouched." >&2
  else
    run git -C "$install_dir" fetch --depth 1 origin "$branch"
    run git -C "$install_dir" checkout "$branch"
    run git -C "$install_dir" pull --ff-only
  fi
elif [ -e "$install_dir" ] && [ -n "$(ls -A "$install_dir" 2>/dev/null)" ]; then
  fail "${install_dir} exists and is not an agent-bot checkout"
else
  run mkdir -p "$(dirname "$install_dir")"
  run git clone --depth 1 --branch "$branch" "$repo" "$install_dir"
fi

cd "$install_dir" || fail "cannot enter ${install_dir}"

step "Installing dependencies..."
if [ "$skip_deps" -eq 1 ]; then
  ok "Skipping dependency install (--skip-deps)"
elif [ -f package-lock.json ]; then
  run npm ci --no-audit --no-fund
else
  run npm install --no-audit --no-fund
fi

step "Building..."
if [ "$skip_build" -eq 1 ]; then
  ok "Skipping build (--skip-build)"
  { [ -f dist/index.js ] && [ -f dist/bot-cli.js ]; } || fail "--skip-build requires an existing dist/index.js and dist/bot-cli.js"
else
  run npm run build
fi

step "Preparing runtime directories..."
run mkdir -p data data/inbox data/outbox
if [ ! -f .env ]; then
  run cp .env.example .env
  run chmod 600 .env
  if [ "$dry_run" -eq 1 ]; then ok "Would create .env from .env.example (mode 600)"; else ok "Created .env from .env.example (mode 600)"; fi
else
  ok ".env already exists; leaving it unchanged"
fi

if [ "$want_opencode" != 0 ] && [ "$dry_run" -eq 0 ]; then
  if command -v opencode >/dev/null 2>&1; then
    ok "opencode CLI already installed"
  else
    step "Installing the opencode CLI..."
    if npm install -g opencode-ai --no-audit --no-fund; then
      ok "Installed opencode-ai"
    else
      printf '  %s\n' "Could not install opencode globally; run: sudo npm install -g opencode-ai" >&2
    fi
  fi
fi

# The setup wizard owns the tool stage when it runs, so clients and optional tools
# appear in one flow. A piped installer or CI run has no TTY; auto mode then only
# detects and leaves installation to `npm run setup:tools` instead of downloading
# third-party binaries unattended.
case "$want_tools" in
  auto)
    if [ "$interactive" = true ] && [ -t 0 ]; then want_tools=1; else want_tools=check; fi ;;
  1|check|0) ;;
  *) fail "AGENT_BOT_TOOLS must be auto, check, 1 or 0 (found ${want_tools})" ;;
esac

# Telegram, Feishu or a phone-reachable Android API is enough to start the bot.
# The sample .env enables the API on loopback; that is the default, not a configured client.
env_value() {
  [ -f .env ] || return 1
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 | tr -d '\r'
}

has_control_channel() {
  [ -n "$(env_value TELEGRAM_BOT_TOKEN)" ] && return 0
  if [ -n "$(env_value FEISHU_APP_ID)" ] && [ -n "$(env_value FEISHU_APP_SECRET)" ]; then return 0; fi
  case "$(env_value API_ENABLED || true)" in 0|false|no|off) return 1 ;; esac
  [ -n "$(env_value API_PUBLIC_URL)" ] && return 0
  case "$(env_value API_BIND || true)" in
    127.*|localhost|*.localhost|"::1"|"[::1]"|0.0.0.0|"::"|"[::]"|"") return 1 ;;
    *) return 0 ;;
  esac
}

has_channel=0
if has_control_channel; then has_channel=1; fi
if [ "$want_setup" = auto ]; then
  if [ "$interactive" = true ] && [ -t 0 ]; then want_setup=1; else want_setup=0; fi
fi
if [ "$want_setup" != 0 ] && [ "$dry_run" -eq 0 ]; then
  if [ "$has_channel" -eq 1 ]; then
    step "A control client is already configured. Opening the client wizard to add or edit one..."
  else
    step "Starting the client setup wizard (Telegram / Android App / Feishu)..."
  fi
  setup_tools_flag=""
  case "$want_tools" in
    1) setup_tools_flag="" ;;
    check) setup_tools_flag="--check-tools" ;;
    0) setup_tools_flag="--no-tools" ;;
  esac
  if [ -n "$setup_tools_flag" ]; then
    npm run setup -- "$setup_tools_flag" || fail "the setup wizard did not finish; rerun npm run setup in ${install_dir}"
  else
    npm run setup || fail "the setup wizard did not finish; rerun npm run setup in ${install_dir}"
  fi
  # Re-read .env so --start sees a client that was configured just now.
  has_channel=0
  if has_control_channel; then has_channel=1; fi
elif [ "$want_tools" != 0 ]; then
  # No client wizard in this run: detect tools without blocking a piped/CI install.
  step "Detecting existing Agent CLI / magpie / cc-switch..."
  if [ "$dry_run" -eq 1 ]; then
    run npm run setup:tools -- --check
  elif ! npm run setup:tools -- --check; then
    printf '  %s\n' "Tool detection did not finish; rerun npm run setup:tools -- --check in ${install_dir}." >&2
  fi
fi

# A plain install creates .env from the sample above. Re-evaluate after the
# optional setup stage and the file creation so --start does not reject a
# configuration that exists by the time it runs.
has_channel=0
if has_control_channel; then has_channel=1; fi

if [ "$use_systemd" -eq 1 ] || [ "$use_user_systemd" -eq 1 ]; then
  step "Installing systemd units..."
  systemd_args=""
  if [ "$use_systemd" -eq 1 ]; then systemd_args="--systemd"; else systemd_args="--user-systemd"; fi
  opencode_args=""
  if [ "$want_opencode" -eq 0 ]; then opencode_args="--no-opencode"; fi
  run npm run bot -- install --skip-deps --skip-build $opencode_args "$systemd_args"
fi

if [ "$start_after" -eq 1 ] && [ "$dry_run" -eq 0 ]; then
  [ "$has_channel" -eq 1 ] || fail "refusing to start without a configured Telegram, Android App or Feishu client; run npm run setup or edit .env first"
  step "Starting the bot..."
  if [ "$use_systemd" -eq 0 ] && [ "$use_user_systemd" -eq 0 ]; then
    run npm run bot -- install --skip-deps --skip-build
  fi
  run npm run bot -- start
fi

printf '\n'
if [ "$dry_run" -eq 1 ]; then
  ok "Dry run complete for ${install_dir}"
else
  ok "Agent Bot installed in ${install_dir}"
fi
printf '  Next steps:\n'
printf '    1. %scd %s%s\n' "$bold" "$install_dir" "$reset"
if [ "$has_channel" -eq 0 ]; then
  printf '    2. %snpm run setup%s   # choose Telegram, Android App or Feishu\n' "$bold" "$reset"
else
  printf '    2. %snpm run bot -- start%s # start the bot and its local opencode (log: data/bot.log)\n' "$bold" "$reset"
  printf '       %snpm run clients%s   # add or edit another control client later\n' "$bold" "$reset"
fi
printf '    3. %snpm run setup:tools%s # add Agent CLI / magpie / cc-switch later\n' "$bold" "$reset"
printf '    4. %snpm run bot -- status%s # inspect supervisor, release and health\n' "$bold" "$reset"
printf '    5. Open Telegram or Feishu and send /start; pair the Android App from its Settings screen\n\n'
if [ "$dry_run" -eq 1 ]; then
  printf '  Dry run only; nothing was changed.\n\n'
fi
