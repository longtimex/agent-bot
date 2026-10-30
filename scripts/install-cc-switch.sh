#!/usr/bin/env bash
# Install the cc-switch CLI binary into ./bin (or CC_SWITCH_INSTALL_DIR).
# Usage: bash scripts/install-cc-switch.sh [version] [--force]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="SaladDay/cc-switch-cli"
BIN_NAME="cc-switch"
INSTALL_DIR="${CC_SWITCH_INSTALL_DIR:-$ROOT/bin}"
TARGET="${INSTALL_DIR}/${BIN_NAME}"
RELEASES_URL="https://github.com/${REPO}/releases"
VERSION="latest"
FORCE=0
ASSET=""

for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    *) VERSION="$arg" ;;
  esac
done
[[ "$VERSION" == "latest" || "$VERSION" =~ ^v ]] || VERSION="v${VERSION}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: missing required command: $1" >&2; exit 1; }; }

detect_asset() {
  local os arch
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  case "$os" in
    Darwin) ASSET="cc-switch-cli-darwin-universal.tar.gz" ;;
    Linux)
      case "$arch" in
        x86_64|amd64) ASSET="cc-switch-cli-linux-x64-musl.tar.gz" ;;
        aarch64|arm64) ASSET="cc-switch-cli-linux-arm64-musl.tar.gz" ;;
        *) echo "error: unsupported Linux architecture: $arch" >&2; exit 1 ;;
      esac
      ;;
    *) echo "error: unsupported OS: $os (download manually: $RELEASES_URL)" >&2; exit 1 ;;
  esac
}

need tar
if command -v curl >/dev/null 2>&1; then
  download() { curl --fail --location --silent --show-error --output "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget --quiet --output-document="$2" "$1"; }
else
  echo "error: curl or wget is required" >&2
  exit 1
fi

if [[ -e "$TARGET" && "$FORCE" != "1" ]]; then
  echo "cc-switch already exists at $TARGET"
  echo "Re-run with --force to overwrite: bash scripts/install-cc-switch.sh $VERSION --force"
  exit 0
fi

detect_asset
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ "$VERSION" == "latest" ]]; then
  URL="${RELEASES_URL}/latest/download/${ASSET}"
else
  URL="${RELEASES_URL}/download/${VERSION}/${ASSET}"
fi

echo "Downloading $ASSET ..."
download "$URL" "$TMP_DIR/$ASSET"
tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
[[ -f "$TMP_DIR/$BIN_NAME" ]] || { echo "error: $BIN_NAME not found in archive" >&2; exit 1; }

mkdir -p "$INSTALL_DIR"
cp "$TMP_DIR/$BIN_NAME" "$TARGET.new"
chmod 755 "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"

echo "Installed: $TARGET"
"$TARGET" --version 2>/dev/null | head -n 1 || true
if [[ ":$PATH:" != *":$INSTALL_DIR:"* && "$INSTALL_DIR" != "$ROOT/bin" ]]; then
  echo "note: $INSTALL_DIR is not in PATH; set CC_SWITCH_BIN=$TARGET or add it to PATH."
fi
