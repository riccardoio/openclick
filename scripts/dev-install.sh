#!/usr/bin/env bash
# Local dev-install of OpenclickHelper.app from the latest Swift sources.
#
# Builds the dispatcher (debug, arm64), assembles a .app bundle with the
# embedded daemon, ad-hoc signs it, and installs it at
# /Applications/OpenclickHelper.app so macOS Launch Services finds it for
# auto-relaunches (the Screen Recording TCC grant flow).
#
# Use this for iterating on the Swift UI / dispatcher locally. For the
# real release flow, run scripts/sign-and-notarize.sh instead.
#
# Side effects:
#   - kills any running OpenclickHelper / openclick-daemon processes
#   - replaces /Applications/OpenclickHelper.app
#   - resets TCC for com.openclick.helper (Accessibility + ScreenCapture)
#   - launches the .app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/Applications/OpenclickHelper.app"
DAEMON_SOURCE="${OPENCLICK_DAEMON_SOURCE:-$ROOT/packages/cua-driver-darwin-arm64/CuaDriver.app/Contents/MacOS/cua-driver}"

if [[ ! -x "$DAEMON_SOURCE" ]]; then
  echo "missing daemon binary: $DAEMON_SOURCE" >&2
  exit 1
fi

pkill -f OpenclickHelper 2>/dev/null || true
pkill -f openclick-daemon 2>/dev/null || true
sleep 0.5

swift build --disable-sandbox --package-path "$ROOT/mac-app"

DEV_BIN="$ROOT/mac-app/.build/arm64-apple-macosx/debug/OpenclickHelper"
if [[ ! -x "$DEV_BIN" ]]; then
  echo "missing dev binary: $DEV_BIN" >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$DEV_BIN" "$APP_DIR/Contents/MacOS/OpenclickHelper"
cp "$ROOT/mac-app/Sources/OpenclickHelper/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$DAEMON_SOURCE" "$APP_DIR/Contents/Resources/openclick-daemon"
chmod 755 "$APP_DIR/Contents/MacOS/OpenclickHelper" "$APP_DIR/Contents/Resources/openclick-daemon"

# The daemon binary ships with hardened runtime + com.apple.security.automation.apple-events
# entitlement. macOS SIGKILLs hardened-runtime processes that aren't signed by a real
# Developer ID (ad-hoc signing isn't trusted enough). For dev iteration we need the
# real cert; notarization is only required for distribution, not for local launches.
SIGNING_IDENTITY="${CERT_APPLICATION_NAME:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep "Developer ID Application" \
    | head -1 \
    | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+[A-F0-9]+[[:space:]]+"([^"]+)".*/\1/')"
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "no Developer ID Application identity found in keychain" >&2
  echo "set CERT_APPLICATION_NAME to a valid signing identity, or run scripts/sign-and-notarize.sh first" >&2
  exit 1
fi

ENTITLEMENTS="$ROOT/mac-app/OpenclickHelper.entitlements"

codesign --force --options runtime --identifier com.openclick.helper.daemon \
  --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" \
  "$APP_DIR/Contents/Resources/openclick-daemon" >/dev/null

codesign --force --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" \
  "$APP_DIR" >/dev/null

codesign --verify --strict --verbose=1 "$APP_DIR/Contents/Resources/openclick-daemon" >/dev/null
codesign --verify --deep --strict --verbose=1 "$APP_DIR" >/dev/null
echo "Signed with: $SIGNING_IDENTITY"

if [[ "${1:-}" == "--reset-tcc" ]]; then
  tccutil reset Accessibility com.openclick.helper >/dev/null 2>&1 || true
  tccutil reset ScreenCapture com.openclick.helper >/dev/null 2>&1 || true
  echo "TCC reset for com.openclick.helper"
fi

echo "Installed dev OpenclickHelper.app at $APP_DIR"

if [[ "${1:-}" == "--launch" || "${2:-}" == "--launch" ]]; then
  open -n "$APP_DIR"
  echo "Launched $APP_DIR"
fi
