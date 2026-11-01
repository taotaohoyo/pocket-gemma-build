#!/bin/bash
# TestFlight upload job (testflight.yml). The archive job builds without
# signing, so the archived app carries no entitlements. Signs it in place ad
# hoc with what each target is distributed with: the identifiers the App Store
# profile expects, plus the memory entitlements asked for, on the app only
# (never on the Live Activity extension or the Apple Watch app), and with
# icloud private (1.1.0 (252) on) the app's own iCloud container
# iCloud.<app identifier> for iCloud Documents, also on the app only: the
# chat backup is kept there outside the container's Documents folder, so the
# Files app does not list it.
# The export keeps these entitlements while it re-signs with the paid team's
# certificate.
# Usage: TEAM_ID=<team> sign-archive.sh <xcarchive> <memory: eva+iml|eva|iml|none> [icloud: private|none]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
archive="$1"
memory="${2:-none}"
icloud="${3:-none}"
case "$memory" in eva+iml|eva|iml|none) ;; *) echo "unknown memory entitlements: $memory"; exit 64 ;; esac
case "$icloud" in private|none) ;; *) echo "unknown iCloud choice: $icloud"; exit 64 ;; esac
: "${TEAM_ID:?the APPLE_TEAM_ID secret is missing}"
app="$archive/Products/Applications/PocketGemma.app"
test -f "$app/Info.plist"
work="$(mktemp -d)"

# entitlements <bundle> <output> <memory> <icloud>
entitlements() {
  python3 - "$@" <<'PY'
import os
import plistlib
import sys
bundle, output, memory, icloud = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
team = os.environ['TEAM_ID']
with open(os.path.join(bundle, 'Info.plist'), 'rb') as handle:
    identifier = plistlib.load(handle)['CFBundleIdentifier']
value = {'application-identifier': f'{team}.{identifier}',
         'com.apple.developer.team-identifier': team}
if memory in ('eva+iml', 'eva'):
    value['com.apple.developer.kernel.extended-virtual-addressing'] = True
if memory in ('eva+iml', 'iml'):
    value['com.apple.developer.kernel.increased-memory-limit'] = True
if icloud == 'private':
    # iCloud Documents in the app's own container; the export sets the
    # environment from ExportOptions (Production) as well.
    container = f'iCloud.{identifier}'
    value['com.apple.developer.icloud-container-identifiers'] = [container]
    value['com.apple.developer.ubiquity-container-identifiers'] = [container]
    value['com.apple.developer.icloud-services'] = ['CloudDocuments']
    value['com.apple.developer.icloud-container-environment'] = 'Production'
with open(output, 'wb') as handle:
    plistlib.dump(value, handle)
extra = sorted(key for key in value if key.startswith(('com.apple.developer.kernel', 'com.apple.developer.icloud', 'com.apple.developer.ubiquity')))
print(f'{identifier}: {extra or "identifiers only"}')
PY
}

xattr -cr "$app"
# Nested code first, deepest first; frameworks and libraries carry no
# entitlements.
while IFS= read -r -d '' nested; do
  codesign --force --sign - --timestamp=none "$nested"
done < <(find "$app" -mindepth 1 -depth \( -name '*.framework' -o -name '*.dylib' \) -print0)
# The Live Activity extension gets its own identifiers only: it never needs
# the memory entitlements.
for extension in "$app"/PlugIns/*.appex; do
  name="$(basename "$extension" .appex)"
  entitlements "$extension" "$work/$name.entitlements" none none
  codesign --force --sign - --timestamp=none --generate-entitlement-der \
    --entitlements "$work/$name.entitlements" "$extension"
done
# The Apple Watch app (Watch/), likewise with its own identifiers only.
for watch in "$app"/Watch/*.app; do
  [[ -d "$watch" ]] || continue
  name="$(basename "$watch" .app)"
  entitlements "$watch" "$work/$name.entitlements" none none
  codesign --force --sign - --timestamp=none --generate-entitlement-der \
    --entitlements "$work/$name.entitlements" "$watch"
done
entitlements "$app" "$work/app.entitlements" "$memory" "$icloud"
codesign --force --sign - --timestamp=none --generate-entitlement-der \
  --entitlements "$work/app.entitlements" "$app"
rm -rf "$work"
python3 "$here/check-export.py" "$app" --memory "$memory" --icloud "$icloud" --adhoc
echo "Signed ad hoc for export"
