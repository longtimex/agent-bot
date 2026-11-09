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
set -eu

repo="${AGENT_BOT_REPO:-https://github.com/longtimex/agent-bot.git}"
branch="${AGENT_BOT_BRANCH:-main}"
install_dir="${AGENT_BOT_DIR:-}"
want_opencode="${AGENT_BOT_OPENCODE:-1}"
want_setup="${AGENT_BOT_SETUP:-auto}"
use_local=auto
start_after=0
dry_run=0

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
  --start            start the bot after a successful install
  --dry-run          print what would run without changing anything
  -h, --help         show this help

Clients: Telegram / Android / Feishu. The wizard can configure one or more;
rerun npm run clients later to add another client without losing existing settings.

Environment: AGENT_BOT_REPO, AGENT_BOT_BRANCH, AGENT_BOT_DIR,
AGENT_BOT_OPENCODE=0, AGENT_BOT_SETUP=0|1
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
    --start) start_after=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

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
if [ -f package-lock.json ]; then
  run npm ci --no-audit --no-fund
else
  run npm install --no-audit --no-fund
fi

step "Building..."
run npm run build

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
  npm run setup || fail "the setup wizard did not finish; rerun npm run setup in ${install_dir}"
  # Re-read .env so --start sees a client that was configured just now.
  has_channel=0
  if has_control_channel; then has_channel=1; fi
fi

if [ "$start_after" -eq 1 ] && [ "$dry_run" -eq 0 ]; then
  [ "$has_channel" -eq 1 ] || fail "refusing to start without a configured Telegram, Android App or Feishu client; run npm run setup or edit .env first"
  step "Starting the bot..."
  run npm run restart
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
  printf '    2. %snpm run serve%s   # terminal 1: start opencode on 127.0.0.1:4096\n' "$bold" "$reset"
  printf '       %snpm run clients%s # add or edit another control client later\n' "$bold" "$reset"
fi
printf '    3. %snpm run restart%s # start the bot in the background (log: data/bot.log)\n' "$bold" "$reset"
printf '    4. Open Telegram or Feishu and send /start; pair the Android App from its Settings screen\n\n'
if [ "$dry_run" -eq 1 ]; then
  printf '  Dry run only; nothing was changed.\n\n'
fi
