#!/usr/bin/env bash
# Build Sparrow without paid platform signing certificates.
#
# What you get:
#   macOS:   .app + .dmg with an ad-hoc signature (free; satisfies the
#            "must be signed" requirement on Apple Silicon). First-time
#            users have to clear the Gatekeeper quarantine flag — see
#            docs/RELEASE_WITHOUT_SIGNING.md for the one-liner.
#   Linux:   .AppImage + .deb. Works as-is; no signing expected.
#   Windows: .msi + setup.exe installers. Trigger SmartScreen on first
#            launch; users click "More info → Run anyway".
#
# What you DON'T get (and don't need for casual distribution):
#   - Apple notarization        (needs $99/yr Apple Developer Program)
#   - Windows Authenticode      (needs ~$200/yr code-signing cert)
#
# The Tauri auto-updater still works fully — its signing keypair is
# unrelated to platform code signing. Once a user has installed any
# Sparrow build (signed or unsigned), updates flow through the normal
# in-app prompt.

set -euo pipefail

OS="$(uname -s)"

case "$OS" in
  Darwin)
    # Tauri 2 / codesign treat "-" as a request for ad-hoc signing:
    # a valid signature attached, but not tied to any developer
    # identity. macOS lets the app run, but Gatekeeper still flags it
    # as "from an unidentified developer" on first launch.
    export APPLE_SIGNING_IDENTITY="-"
    echo "→ macOS: ad-hoc signing (no Apple Developer account needed)"
    ;;
  Linux)
    echo "→ Linux: no signing required"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "→ Windows: no signing (SmartScreen on first run)"
    ;;
  *)
    echo "→ Unknown OS '$OS' — proceeding anyway"
    ;;
esac

# Make absolutely sure we're not accidentally inheriting Apple Developer
# creds from the parent shell. If they're set, run scripts/macos-sign.sh
# instead; running this script would just double up the codesign call.
for v in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY \
         APPLE_API_KEY_PATH APPLE_API_ISSUER APPLE_API_KEY_ID; do
  if [[ -n "${!v:-}" ]]; then
    echo "⚠  $v is set in your environment."
    echo "   If you have a Developer ID, use ./scripts/macos-sign.sh for a properly notarized build."
    echo "   To force unsigned anyway, run:  unset $v && $0"
    exit 1
  fi
done

npm run tauri build

echo
echo "✓ Done. Artifacts:"
find src-tauri/target -path '*/bundle/*' -type f \
  \( -name '*.dmg' -o -name '*.app.tar.gz' \
     -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
     -o -name '*.msi' -o -name '*-setup.exe' \) \
  2>/dev/null | sort | sed 's/^/  /' || true

echo
echo "Next steps:"
echo "  - Upload the artifacts to a GitHub Release (or any HTTPS host)"
echo "  - Paste the macOS/Windows workaround snippets from"
echo "    docs/RELEASE_WITHOUT_SIGNING.md into the release notes"
