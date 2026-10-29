#!/usr/bin/env bash
# Builds Jira Desktop for this Mac, signs it with the Developer ID certificate in your login
# keychain (unsigned when there is none), installs it to ~/Applications and opens it.
#
# Always the same install path, so macOS keeps the app's permission grants (notifications) and
# Launch Services shows the current icon after a rebuild.
#
# Usage: scripts/mac-local-install.sh             build, sign if a certificate is found, install, open
#        scripts/mac-local-install.sh --notarize  also notarize with an App Store Connect API key:
#                                                 export APPLE_API_KEY (path to the .p8 file),
#                                                 APPLE_API_KEY_ID and APPLE_API_ISSUER
#
# Release builds come from CI (.github/workflows/release.yml), never from this script.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "mac-local-install.sh runs on macOS only" >&2
  exit 1
fi

notarize=false
for arg in "$@"; do
  case "$arg" in
    --notarize) notarize=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Work from the repo root whatever the caller's directory, so npm and electron-builder read this
# repo's package.json and lockfile only
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo"

case "$(uname -m)" in
  arm64) arch=arm64; out=release/mac-arm64 ;;
  x86_64) arch=x64; out=release/mac ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

name="Jira Desktop"
# An empty or relative HOME would point the install (and the rm below) somewhere else
case "${HOME:-}" in
  /?*) ;;
  *) echo "HOME must be an absolute path" >&2; exit 1 ;;
esac
install_dir="$HOME/Applications"
target="$install_dir/$name.app"

builder_args=(--mac dir "--$arch" --publish never)
if [ "$notarize" = true ]; then
  for var in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
    if [ -z "${!var:-}" ]; then echo "--notarize needs $var exported" >&2; exit 1; fi
  done
  if [ ! -f "$APPLE_API_KEY" ]; then echo "APPLE_API_KEY must be the path to the .p8 key file" >&2; exit 1; fi
else
  # Notarization uploads the app to Apple and takes minutes; a local loop skips it
  builder_args+=(-c.mac.notarize=false)
fi

# --ignore-scripts: no dependency install script runs while this Mac's Developer ID key is in the
# login keychain. electron-builder downloads Electron itself, so packaging does not need them.
npm ci --ignore-scripts --no-audit --no-fund
npm run build
# The electron-builder npm ci installed from the lockfile; never one fetched from the network,
# since it runs next to the Developer ID key in the login keychain
builder=./node_modules/.bin/electron-builder
if [ ! -x "$builder" ]; then echo "electron-builder is missing from node_modules" >&2; exit 1; fi
"$builder" "${builder_args[@]}"

built="$out/$name.app"
if [ ! -d "$built" ]; then
  echo "build did not produce $built" >&2
  exit 1
fi

# Quit the running copy before replacing it
osascript -e "quit app \"$name\"" >/dev/null 2>&1 || true
sleep 1

mkdir -p "$install_dir"
# Remove only the exact bundle this script installs
if [ -e "$target" ]; then
  case "$target" in
    "$HOME/Applications/Jira Desktop.app") rm -rf -- "$target" ;;
    *) echo "refusing to remove unexpected path: $target" >&2; exit 1 ;;
  esac
fi
# ditto keeps the bundle's signature, symlinks and extended attributes intact
ditto "$built" "$target"

lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$lsregister" ]; then "$lsregister" -f "$target"; fi

# Captured first: piping codesign into grep -q under pipefail can fail on SIGPIPE when grep exits
# at its first match, which would report a signed app as unsigned
signature=$(codesign -dv "$target" 2>&1 || true)
if grep -q '^Authority=Developer ID Application' <<<"$signature"; then
  codesign --verify --deep --strict --verbose=2 "$target"
  echo "Installed $target (signed with Developer ID)"
  if [ "$notarize" = true ]; then
    spctl --assess --type execute --verbose=2 "$target"
    xcrun stapler validate "$target"
  fi
else
  echo "Installed $target (NOT signed with a Developer ID certificate: no identity found in the keychain)"
fi

open "$target"

# npm run dev and the e2e tests need the Electron binary that the electron package's own install
# script downloads; restore just that one, now that packaging is done
node node_modules/electron/install.js
