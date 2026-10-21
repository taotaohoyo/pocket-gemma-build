#!/bin/bash
# TestFlight upload job (testflight.yml). The archive job builds without
# signing, so the archived app carries no entitlements. Signs it in place ad
# hoc with what each target is distributed with: the identifiers the App Store
# profile expects, plus the address-space entitlements when asked. The export
# keeps these entitlements while it re-signs with the paid team's certificate.
# Usage: TEAM_ID=<team> sign-archive.sh <xcarchive> <address space: true|false>
set -euo pipefail
archive="$1"
address_space="${2:-false}"
: "${TEAM_ID:?the APPLE_TEAM_ID secret is missing}"
app="$archive/Products/Applications/PocketGemma.app"
test -f "$app/Info.plist"
work="$(mktemp -d)"

# entitlements <bundle> <output> <address space>
entitlements() {
  python3 - "$@" <<'PY'
import os
import plistlib
import sys
bundle, output, address_space = sys.argv[1], sys.argv[2], sys.argv[3] == 'true'
team = os.environ['TEAM_ID']
with open(os.path.join(bundle, 'Info.plist'), 'rb') as handle:
    identifier = plistlib.load(handle)['CFBundleIdentifier']
value = {'application-identifier': f'{team}.{identifier}',
         'com.apple.developer.team-identifier': team}
if address_space:
    value['com.apple.developer.kernel.extended-virtual-addressing'] = True
    value['com.apple.developer.kernel.increased-memory-limit'] = True
with open(output, 'wb') as handle:
    plistlib.dump(value, handle)
print(f'{identifier}: {sorted(key for key in value if key.startswith("com.apple.developer.kernel")) or "identifiers only"}')
PY
}

xattr -cr "$app"
# Nested code first, deepest first; frameworks and libraries carry no
# entitlements.
while IFS= read -r -d '' nested; do
  codesign --force --sign - --timestamp=none "$nested"
done < <(find "$app" -mindepth 1 -depth \( -name '*.framework' -o -name '*.dylib' \) -print0)
# The Live Activity extension gets its own identifiers only.
for extension in "$app"/PlugIns/*.appex; do
  name="$(basename "$extension" .appex)"
  entitlements "$extension" "$work/$name.entitlements" false
  codesign --force --sign - --timestamp=none --generate-entitlement-der \
    --entitlements "$work/$name.entitlements" "$extension"
done
entitlements "$app" "$work/app.entitlements" "$address_space"
codesign --force --sign - --timestamp=none --generate-entitlement-der \
  --entitlements "$work/app.entitlements" "$app"
codesign --verify --deep --strict "$app"
rm -rf "$work"
echo "Signed ad hoc for export"
