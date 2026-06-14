#!/usr/bin/env bash
# Lighthouse Walrus Sites deploy script.
#
# Builds a static SPA shell (WALRUS_SPA=1), then ships it to a Walrus Site
# object via site-builder. Idempotent: subsequent runs reuse the object_id
# stored in ws-resources.json (auto-managed by site-builder).
#
# Defaults to TESTNET — Lighthouse v1 on-chain wiring targets testnet. For the
# public wal.app portal + lighthouse.wal.app SuiNS URL, promote to mainnet:
#   NETWORK=mainnet bun run deploy:walrus:mainnet
#
# Usage:
#   VITE_API_BASE_URL=https://api.example.com bun run deploy:walrus
#   NETWORK=mainnet VITE_API_BASE_URL=https://api.example.com bun run deploy:walrus:mainnet
#
# Prereqs (per LIGHTHOUSE.md §14.1):
#   curl -sSfL https://raw.githubusercontent.com/MystenLabs/suiup/main/install.sh | sh
#   suiup install site-builder@testnet
#   curl https://raw.githubusercontent.com/MystenLabs/walrus-sites/refs/heads/main/sites-config.yaml \
#     -o ~/.config/walrus/sites-config.yaml
#   walrus get-wal

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
EPOCHS="${EPOCHS:-53}"
SITE_NAME="${SITE_NAME:-lighthouse}"
# TanStack Start SPA mode (without Nitro) writes the shell to dist/client/index.html.
DIST_DIR="${DIST_DIR:-./dist/client}"
SITES_CONFIG="${SITES_CONFIG:-$HOME/.config/walrus/sites-config.yaml}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$WEB_DIR"

echo "==> Lighthouse Walrus Sites deploy"
echo "    network = $NETWORK"
echo "    epochs  = $EPOCHS (testnet ≈ $EPOCHS days, mainnet ≈ $((EPOCHS * 14)) days)"
echo "    dist    = $DIST_DIR"
echo "    name    = $SITE_NAME"
echo

if ! command -v site-builder >/dev/null 2>&1; then
  echo "==> site-builder not found — downloading testnet binary from GCS"
  mkdir -p "$HOME/.local/bin"
  SYSTEM="${SITE_BUILDER_SYSTEM:-macos-arm64}"
  BIN="$HOME/.local/bin/site-builder"
  curl -fsSL \
    "https://storage.googleapis.com/mysten-walrus-binaries/site-builder-${NETWORK}-latest-${SYSTEM}" \
    -o "$BIN"
  chmod +x "$BIN"
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v site-builder >/dev/null 2>&1; then
    echo "ERROR: site-builder install failed."
    echo "  Try: suiup install site-builder@$NETWORK"
    echo "  Or set SITE_BUILDER_SYSTEM (ubuntu-x86_64, macos-x86_64, macos-arm64)."
    exit 1
  fi
fi

if [[ ! -f "$SITES_CONFIG" ]]; then
  echo "==> sites-config.yaml missing — downloading canonical config"
  mkdir -p "$(dirname "$SITES_CONFIG")"
  curl -fsSL \
    https://raw.githubusercontent.com/MystenLabs/walrus-sites/refs/heads/main/sites-config.yaml \
    -o "$SITES_CONFIG"
  echo "    wrote $SITES_CONFIG"
  echo
fi

if [[ -z "${VITE_API_BASE_URL:-}" ]]; then
  echo "WARNING: VITE_API_BASE_URL is unset."
  echo "  The Walrus-hosted SPA will not reach your backend (coach/trade/auth API)."
  echo "  Re-run with: VITE_API_BASE_URL=https://<your-backend-host> bun run deploy:walrus"
  echo
fi

echo "==> Building static SPA (WALRUS_SPA=1)"
if command -v bun >/dev/null 2>&1; then
  WALRUS_SPA=1 bun run build:walrus
else
  WALRUS_SPA=1 npm run build:walrus
fi

if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: build output dir '$DIST_DIR' does not exist."
  echo "  Expected TanStack Start SPA shell at $DIST_DIR/index.html"
  exit 1
fi

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "ERROR: $DIST_DIR/index.html missing."
  echo "  SPA mode did not emit a static shell. Check web/vite.config.ts WALRUS_SPA settings."
  exit 1
fi

echo "==> Verifying ws-resources.json is present"
if [[ ! -f "$WEB_DIR/ws-resources.json" ]]; then
  echo "ERROR: ws-resources.json missing from $WEB_DIR."
  exit 1
fi

cp "$WEB_DIR/ws-resources.json" "$DIST_DIR/ws-resources.json"

echo
echo "==> Deploying to Walrus Sites ($NETWORK)"
echo "    site-builder --context=$NETWORK deploy --epochs $EPOCHS $DIST_DIR --site-name $SITE_NAME"
echo

site-builder \
  --context="$NETWORK" \
  deploy \
  --epochs "$EPOCHS" \
  "$DIST_DIR" \
  --site-name "$SITE_NAME"

# site-builder writes object_id into the dist copy — sync back to repo root.
if [[ -f "$DIST_DIR/ws-resources.json" ]]; then
  cp "$DIST_DIR/ws-resources.json" "$WEB_DIR/ws-resources.json"
  echo "==> Synced ws-resources.json (object_id) to $WEB_DIR/ws-resources.json"
fi

echo
echo "==> Done."
echo
echo "Next steps:"
echo "  1. Note the printed Site Object ID and portal URL."
echo "  2. Open the URL — verify / loads and /trade redirects guests to /auth."
echo "  3. (Mainnet only) Bind SuiNS walrus_site_id for https://lighthouse.wal.app"
echo "  4. Commit the updated ws-resources.json (object_id field)."
