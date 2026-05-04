#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIGNING_ENV="$HOME/.openclick/signing.env"
APP_NAME="OpenclickHelper.app"
EXECUTABLE_NAME="OpenclickHelper"
BUILD_DIR="$ROOT/.build/openclick-helper-universal"
APP_DIR="$BUILD_DIR/$APP_NAME"
ZIP_PATH="$BUILD_DIR/OpenclickHelper.zip"
NOTARY_OUTPUT="$BUILD_DIR/notary-submit.json"
PACKAGE_APP_DIR="$ROOT/packages/openclick-helper-darwin/$APP_NAME"

if [[ ! -f "$SIGNING_ENV" ]]; then
  echo "missing $SIGNING_ENV" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$SIGNING_ENV"

required_vars=(
  APPLE_TEAM_ID
  APPLE_NOTARY_KEY_ID
  APPLE_NOTARY_ISSUER_ID
  CERT_APPLICATION_NAME
  CERT_INSTALLER_NAME
  APPLE_ID
  APP_SPECIFIC_PASSWORD
  VERSION
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "missing required signing env var: $var_name" >&2
    exit 1
  fi
done

"$ROOT/scripts/build-universal.sh" >/dev/null

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP_DIR/Contents/Info.plist"

codesign \
  --force \
  --deep \
  --options runtime \
  --entitlements "$ROOT/mac-app/OpenclickHelper.entitlements" \
  --sign "$CERT_APPLICATION_NAME" \
  "$APP_DIR"

rm -f "$ZIP_PATH" "$NOTARY_OUTPUT"
(
  cd "$BUILD_DIR"
  /usr/bin/ditto -c -k --keepParent "$APP_NAME" "$ZIP_PATH"
)

notary_args=(xcrun notarytool submit "$ZIP_PATH" --wait --timeout "${NOTARY_TIMEOUT_SECONDS:-1800}" --output-format json)
api_key_path="$HOME/.openclick/AuthKey_${APPLE_NOTARY_KEY_ID}.p8"
if [[ -f "$api_key_path" ]]; then
  notary_args+=(--key "$api_key_path" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
else
  notary_args+=(--apple-id "$APPLE_ID" --password "$APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi

if ! "${notary_args[@]}" >"$NOTARY_OUTPUT"; then
  echo "notary submission failed" >&2
  cat "$NOTARY_OUTPUT" >&2 || true
  submission_id="$(awk -F'"' '/"id"/ { print $4; exit }' "$NOTARY_OUTPUT" 2>/dev/null || true)"
  if [[ -n "$submission_id" ]]; then
    xcrun notarytool log "$submission_id" --apple-id "$APPLE_ID" --password "$APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" >&2 || true
  fi
  exit 1
fi

status="$(awk -F'"' '/"status"/ { print $4; exit }' "$NOTARY_OUTPUT" 2>/dev/null || true)"
if [[ "$status" != "Accepted" ]]; then
  echo "notary submission was not accepted" >&2
  cat "$NOTARY_OUTPUT" >&2 || true
  submission_id="$(awk -F'"' '/"id"/ { print $4; exit }' "$NOTARY_OUTPUT" 2>/dev/null || true)"
  if [[ -n "$submission_id" ]]; then
    xcrun notarytool log "$submission_id" --apple-id "$APPLE_ID" --password "$APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" >&2 || true
  fi
  exit 1
fi

xcrun stapler staple "$APP_DIR"
spctl -a -vvv -t install "$APP_DIR"

rm -rf "$PACKAGE_APP_DIR"
mkdir -p "$(dirname "$PACKAGE_APP_DIR")"
cp -R "$APP_DIR" "$PACKAGE_APP_DIR"

codesign --verify --deep --strict "$PACKAGE_APP_DIR"
test -x "$PACKAGE_APP_DIR/Contents/MacOS/$EXECUTABLE_NAME"
