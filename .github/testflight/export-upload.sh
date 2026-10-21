#!/bin/bash
# TestFlight upload job (testflight.yml). Exports the archive for App Store
# Connect with the paid team's cloud-managed distribution certificate and
# uploads it as a TestFlight build for internal testers only, signed in with
# the App Store Connect API key. No IPA, profile or full log leaves the
# runner; the public job log shows only filtered, redacted lines.
# Usage: TEAM_ID ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 [XCODE] export-upload.sh <xcarchive>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
archive="$1"
: "${TEAM_ID:?the APPLE_TEAM_ID secret is missing}"
: "${ASC_KEY_ID:?the ASC_KEY_ID secret is missing}"
: "${ASC_ISSUER_ID:?the ASC_ISSUER_ID secret is missing}"
: "${ASC_KEY_P8:?the ASC_KEY_P8 secret is missing}"

# The Xcode the archive job used; otherwise the newest stable Xcode 26 or
# later, as scripts/select-xcode.sh picks it.
if [[ -n "${XCODE:-}" && -d "$XCODE" ]]; then
  export DEVELOPER_DIR="$XCODE"
else
  DEVELOPER_DIR="$(python3 - <<'PY'
import glob, re
found = []
for path in glob.glob('/Applications/Xcode_*.app'):
    match = re.fullmatch(r'/Applications/Xcode_(\d+(?:\.\d+)*).app', path)
    if match and int(match[1].split('.')[0]) >= 26:
        found.append((tuple(map(int, match[1].split('.'))), path))
print(max(found)[1] + '/Contents/Developer')
PY
)"
  export DEVELOPER_DIR
fi
xcodebuild -version

keys="$RUNNER_TEMP/private_keys"
mkdir -p "$keys"
chmod 700 "$keys"
key="$keys/AuthKey_$ASC_KEY_ID.p8"
(umask 077; printf '%s\n' "$ASC_KEY_P8" > "$key")
grep -q 'BEGIN PRIVATE KEY' "$key" || { echo 'ASC_KEY_P8 is not the .p8 file text (BEGIN PRIVATE KEY ... END PRIVATE KEY)'; exit 64; }

options="$RUNNER_TEMP/ExportOptions.plist"
python3 - "$options" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'wb') as handle:
    plistlib.dump({
        'method': 'app-store-connect',
        'destination': 'upload',
        'signingStyle': 'automatic',
        'teamID': os.environ['TEAM_ID'],
        # The build can go to internal testers only, never to App Review.
        'testFlightInternalTestingOnly': True,
        'manageAppVersionAndBuildNumber': False,
        'uploadSymbols': True,
    }, handle)
PY

log="$RUNNER_TEMP/export.log"
status=0
xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportOptionsPlist "$options" \
  -exportPath "$RUNNER_TEMP/export" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$key" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  > "$log" 2>&1 || status=$?
echo "xcodebuild -exportArchive exited with $status"
python3 "$here/redact-log.py" "$log"
if [[ $status -ne 0 ]]; then
  # Xcode keeps the details in its distribution logs; show their errors only.
  while IFS= read -r -d '' detail; do
    echo "--- ${detail##*/}"
    python3 "$here/redact-log.py" "$detail" --all-errors --limit 60
  done < <(find "${TMPDIR:-/tmp}" -path '*.xcdistributionlogs/*.log' -newer "$options" -print0 2>/dev/null)
fi
# With destination upload nothing should be here; never keep a signed IPA.
rm -rf "$RUNNER_TEMP/export"
exit "$status"
