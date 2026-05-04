#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/mac-app"
APP_NAME="OpenclickHelper.app"
EXECUTABLE_NAME="OpenclickHelper"
DAEMON_NAME="openclick-daemon"
BUILD_DIR="$ROOT/.build/openclick-helper-universal"
APP_DIR="$BUILD_DIR/$APP_NAME"

# The embedded daemon is the upstream cua-driver Mach-O. We bundle it into
# OpenclickHelper.app/Contents/Resources/openclick-daemon and let
# `codesign --deep` re-sign it under com.openclick.helper as part of bundle
# signing. Override with OPENCLICK_DAEMON_SOURCE to point at an alternate
# pre-built daemon (e.g., when upstream ships a universal binary).
DAEMON_SOURCE="${OPENCLICK_DAEMON_SOURCE:-$ROOT/packages/cua-driver-darwin-arm64/CuaDriver.app/Contents/MacOS/cua-driver}"

if [[ ! -x "$DAEMON_SOURCE" ]]; then
  echo "missing daemon binary: $DAEMON_SOURCE" >&2
  echo "set OPENCLICK_DAEMON_SOURCE to the path of the upstream cua-driver binary" >&2
  exit 1
fi

swift build --package-path "$PACKAGE_DIR" -c release --arch arm64
swift build --package-path "$PACKAGE_DIR" -c release --arch x86_64

ARM64_BIN="$PACKAGE_DIR/.build/arm64-apple-macosx/release/$EXECUTABLE_NAME"
X86_64_BIN="$PACKAGE_DIR/.build/x86_64-apple-macosx/release/$EXECUTABLE_NAME"

if [[ ! -x "$ARM64_BIN" ]]; then
  echo "missing arm64 executable: $ARM64_BIN" >&2
  exit 1
fi
if [[ ! -x "$X86_64_BIN" ]]; then
  echo "missing x86_64 executable: $X86_64_BIN" >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$PACKAGE_DIR/Sources/OpenclickHelper/Info.plist" "$APP_DIR/Contents/Info.plist"
lipo -create "$ARM64_BIN" "$X86_64_BIN" -output "$APP_DIR/Contents/MacOS/$EXECUTABLE_NAME"
chmod 755 "$APP_DIR/Contents/MacOS/$EXECUTABLE_NAME"

cp "$DAEMON_SOURCE" "$APP_DIR/Contents/Resources/$DAEMON_NAME"
chmod 755 "$APP_DIR/Contents/Resources/$DAEMON_NAME"

echo "$APP_DIR"
