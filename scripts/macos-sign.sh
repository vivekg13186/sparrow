#!/usr/bin/env bash
# Build a signed + notarized Sparrow.app + .dmg for macOS.
#
# Tauri 2 handles the actual codesign + notarytool calls automatically
# once the right env vars are present. This wrapper just sanity-checks
# the environment, picks a default target, and prints the artifact paths
# at the end so it's obvious what to ship.
#
# Env vars (always required):
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
#
# Notarization style A (Apple ID + app-specific password):
#   APPLE_ID                 e.g. "you@example.com"
#   APPLE_PASSWORD           app-specific password
#   APPLE_TEAM_ID            10-char team id
#
# Notarization style B (App Store Connect API key, preferred for CI):
#   APPLE_API_KEY_PATH       path to AuthKey_<KEYID>.p8
#   APPLE_API_ISSUER         issuer UUID
#   APPLE_API_KEY_ID         10-char key id
#
# Optional:
#   TAURI_TARGETS            override the rust target triple
#                            (defaults to universal-apple-darwin)

set -euo pipefail

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
dim()   { printf "\033[2m%s\033[0m\n" "$1"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  red "This script only runs on macOS."
  exit 1
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  red "Missing APPLE_SIGNING_IDENTITY."
  echo "Set it to your Developer ID Application identity, e.g.:"
  echo '  export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"'
  echo
  echo "Listing identities that look usable on this machine:"
  security find-identity -p codesigning -v | grep -i "Developer ID Application" || true
  exit 1
fi

has_apple_id_auth=0
has_api_key_auth=0
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  has_apple_id_auth=1
fi
if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_ID:-}" ]]; then
  has_api_key_auth=1
fi
if [[ $has_apple_id_auth -eq 0 && $has_api_key_auth -eq 0 ]]; then
  red "No notarization credentials set."
  echo "Provide either:"
  echo "  APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or"
  echo "  APPLE_API_KEY_PATH + APPLE_API_ISSUER + APPLE_API_KEY_ID"
  exit 1
fi

# Default to a universal binary so the same .app runs on Apple Silicon
# and Intel. Requires both rustup targets installed:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
TARGETS="${TAURI_TARGETS:-universal-apple-darwin}"

green "Sparrow macOS build"
dim   "  identity: $APPLE_SIGNING_IDENTITY"
dim   "  target:   $TARGETS"
if [[ $has_apple_id_auth -eq 1 ]]; then
  dim "  notary:   Apple ID ($APPLE_ID, team $APPLE_TEAM_ID)"
else
  dim "  notary:   API key ($APPLE_API_KEY_ID, issuer $APPLE_API_ISSUER)"
fi
echo

# Make sure rustup has the universal target halves; the universal build
# script needs both to lipo them together.
if [[ "$TARGETS" == "universal-apple-darwin" ]]; then
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    if ! rustup target list --installed 2>/dev/null | grep -qx "$t"; then
      dim "  installing rust target $t …"
      rustup target add "$t"
    fi
  done
fi

npm run tauri build -- --target "$TARGETS"

echo
green "Done. Artifacts:"
find src-tauri/target -path "*/bundle/macos/*.app" 2>/dev/null | sed 's/^/  /' || true
find src-tauri/target -path "*/bundle/dmg/*.dmg"   2>/dev/null | sed 's/^/  /' || true

echo
green "Quick verification:"
APP_PATH="$(find src-tauri/target -path '*/bundle/macos/*.app' 2>/dev/null | head -1 || true)"
if [[ -n "$APP_PATH" ]]; then
  echo "  codesign:  codesign --verify --deep --strict --verbose \"$APP_PATH\""
  echo "  Gatekeeper: spctl --assess --verbose=4 --type execute \"$APP_PATH\""
  echo "  Staple:     stapler validate \"$APP_PATH\""
fi
