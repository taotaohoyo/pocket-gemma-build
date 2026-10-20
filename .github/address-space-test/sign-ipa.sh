#!/bin/bash
# Address-space test build only (build-device-candidate.yml, address_space_test).
# Signs a copy of the unsigned device IPA ad hoc so that the app carries
# Extended Virtual Addressing and Increased Memory Limit. An unsigned app has
# no entitlements for the installer to keep when it re-signs; the installer
# replaces this signature with its own. Normal builds stay unsigned.
# Usage: sign-ipa.sh <unsigned.ipa> <signed.ipa>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
unsigned="$1"
mkdir -p "$(dirname "$2")"
signed="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
work="$(mktemp -d)"
ditto -x -k "$unsigned" "$work"
app="$work/Payload/PocketGemma.app"
xattr -cr "$app"
# Nested code first, deepest first (frameworks, the Live Activity extension),
# then the app itself with the two entitlements.
while IFS= read -r -d '' nested; do
  codesign --force --sign - --timestamp=none "$nested"
done < <(find "$app" -mindepth 1 -depth \( -name '*.framework' -o -name '*.dylib' -o -name '*.appex' \) -print0)
codesign --force --sign - --timestamp=none --generate-entitlement-der \
  --entitlements "$here/address-space.entitlements" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=2 "$app"
codesign --display --entitlements - --xml "$app" || codesign --display --entitlements :- "$app" || true
echo
rm -f "$signed"
# Same packaging as scripts/build-ios.sh.
(cd "$work" && ditto -c -k --keepParent Payload "$signed")
python3 "$here/check-signed-ipa.py" "$unsigned" "$signed"
