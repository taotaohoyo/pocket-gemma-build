#!/bin/bash
# The app's model download (its ModelStore, DownloadActivity, AppFiles and
# download record, as PocketGemma-source.zip ships them) in the iOS
# simulator, against server.py's stand-in for the Hub (1.1.0 (293)).
# Run on macOS from the repository root.
# Usage: tools/check-model-downloads/harness/run-harness.sh VARIANT SOURCE_ZIP [SCENARIO,...]
#   VARIANT 292 builds the store as 292 had it (Harness.swift's STORE_292);
#   293, 294 and 295 as they are, the app's closing from the app switcher too.
set -euo pipefail
variant="$1"
zip="$2"
only="${3:-}"
root="$PWD"
here="$root/tools/check-model-downloads/harness"
work="$root/build/Harness/$variant"
rm -rf "$work"
mkdir -p "$work/source" "$work/app" "$work/out"
unzip -q -o "$zip" -d "$work/source"
src="$work/source"

# The app's files, unchanged but for the store's request, which goes to the
# stand-in (HarnessRequest).
for file in PocketGemma/Services/ModelStore.swift PocketGemma/Services/DownloadActivity.swift \
  PocketGemma/Services/AppFiles.swift PocketGemma/Views/DownloadDiagnostics.swift Activity/ModelDownloadAttributes.swift; do
  cp "$src/$file" "$work/app/"
done
sed -i '' 's/ModelDownload\.request(for: spec, cellular: allowsCellular)/HarnessRequest.request(for: spec, cellular: allowsCellular)/' "$work/app/ModelStore.swift"
grep -q 'HarnessRequest.request(for: spec' "$work/app/ModelStore.swift" || { echo 'HARNESS-ERROR the store request was not found'; exit 1; }
# The app closed from the app switcher (1.1.0 (294)): the harness stops the
# store's task as iOS does and hands its end to the next launch, through
# the store's session, its task tags and systemStopped.
if [ "$variant" != 292 ]; then
  sed -i '' -e 's/private lazy var session: URLSession = {/lazy var session: URLSession = {/' \
    -e 's/private var restartedTasks: Set<String>/var restartedTasks: Set<String>/' \
    -e 's/private func systemStopped(/func systemStopped(/' "$work/app/ModelStore.swift"
  for opened in 'lazy var session: URLSession = {' 'var restartedTasks: Set<String>' 'func systemStopped('; do
    grep -q "^    $opened" "$work/app/ModelStore.swift" || { echo "HARNESS-ERROR not opened: $opened"; exit 1; }
  done
fi
cp "$here/Harness.swift" "$here/Stubs.swift" "$work/app/"
flags='$(inherited)'
[ "$variant" = 292 ] && flags='$(inherited) -DSTORE_292'
cat > "$work/project.yml" <<YML
name: DownloadHarness
options:
  deploymentTarget:
    iOS: "26.4"
packages:
  PocketCore:
    path: source/Packages/PocketCore
targets:
  DownloadHarness:
    type: application
    platform: iOS
    sources:
      - path: app
    info:
      path: Info.plist
      properties:
        CFBundleDisplayName: Download Harness
        UILaunchScreen: {}
        UIApplicationSceneManifest:
          UIApplicationSupportsMultipleScenes: false
        NSSupportsLiveActivities: true
        BGTaskSchedulerPermittedIdentifiers:
          - \$(PRODUCT_BUNDLE_IDENTIFIER).model-download.*
          - \$(PRODUCT_BUNDLE_IDENTIFIER).*
        NSAppTransportSecurity:
          NSAllowsArbitraryLoads: true
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: app.pocketgemma.harness
        SWIFT_VERSION: "5.0"
        CODE_SIGNING_ALLOWED: NO
        GENERATE_INFOPLIST_FILE: NO
        OTHER_SWIFT_FLAGS: "$flags"
    dependencies:
      - package: PocketCore
YML
source "$src/scripts/select-xcode.sh"
(cd "$work" && xcodegen generate --spec project.yml > xcodegen.log)

# The file the app pins (ModelSpec.qwen3), fetched once for both variants.
file="$root/build/Harness/qwen3.litertlm"
url='https://huggingface.co/litert-community/Qwen3-0.6B/resolve/a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm?download=true'
sha='03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856'
if [ ! -f "$file" ] || [ "$(shasum -a 256 "$file" | cut -d' ' -f1)" != "$sha" ]; then
  curl -fsSL --retry 4 -o "$file" "$url"
  [ "$(shasum -a 256 "$file" | cut -d' ' -f1)" = "$sha" ] || { echo 'HARNESS-ERROR the model file did not match its SHA-256'; exit 1; }
fi
grep -q "$sha" "$src/Packages/PocketCore/Sources/PocketCore/ModelSpec.swift" || { echo 'HARNESS-ERROR the source pins another Qwen3 0.6B'; exit 1; }

xcrun simctl list runtimes -j > "$work/runtimes.json"
xcrun simctl list devicetypes -j > "$work/devicetypes.json"
runtime_id="$(python3 -I - "$work/runtimes.json" <<'PY'
import json, sys
runtimes = json.load(open(sys.argv[1]))['runtimes']
usable = [r for r in runtimes if r.get('isAvailable') and r['name'].startswith('iOS') and int(r['version'].split('.')[0]) >= 26]
best = max(usable, key=lambda r: tuple(map(int, r['version'].split('.'))))
print(best['identifier'])
PY
)"
device_type="$(python3 -I - "$work/devicetypes.json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))['devicetypes']
preferred = [d for d in devices if d['name'] in ('iPhone 17 Pro', 'iPhone 16 Pro')]
print(preferred[0]['identifier'] if preferred else next(d['identifier'] for d in reversed(devices) if d['name'].startswith('iPhone')))
PY
)"
echo "HARNESS-RUNTIME $variant $runtime_id $device_type"
simulator_id="$(xcrun simctl create "Fielua download harness $variant" "$device_type" "$runtime_id")"
xcrun simctl boot "$simulator_id"
xcrun simctl bootstatus "$simulator_id" -b > "$work/boot.log" 2>&1
# Signed locally, as run-probe.sh does: iOS's download service ends every
# background task of an unsigned simulator app at once (run 40825923927).
xcodebuild -project "$work/DownloadHarness.xcodeproj" -scheme DownloadHarness -configuration Release \
  -destination "platform=iOS Simulator,id=$simulator_id" -derivedDataPath "$work/DerivedData" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build > "$work/compile.log" 2>&1 \
  || { grep -E 'error:|\*\* .* FAILED' "$work/compile.log" | head -60; exit 65; }
app="$(find "$work/DerivedData/Build/Products/Release-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)"

# iOS's side, for the record: the download service, background tasks and
# the scheduler that decides when they run.
xcrun simctl spawn "$simulator_id" log stream --style compact --level info \
  --predicate 'process == "nsurlsessiond" OR subsystem BEGINSWITH "com.apple.BackgroundTasks" OR process == "dasd" OR (process == "DownloadHarness" AND subsystem == "com.apple.CFNetwork" AND messageType >= 16)' \
  > "$work/out/simulator-log.txt" 2>&1 &
log_pid=$!
status=0
python3 -I "$here/server.py" --udid "$simulator_id" --bundle app.pocketgemma.harness --app "$app" --file "$file" \
  --variant "$variant" --out "$work/out" --only "$only" | tee "$work/out/harness.txt" || status=$?
kill "$log_pid" > /dev/null 2>&1 || true
xcrun simctl shutdown "$simulator_id" || true
python3 -I - "$work/out/$variant-results.json" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1])):
    print('HARNESS-SUMMARY', r['variant'], r['scenario'], 'installed' if r['installed'] else 'NOT INSTALLED',
          'size ok' if r['size_ok'] else 'size ?', 'from-zero %d' % r['restarts_from_zero'],
          'served %.1f MB' % r['served_mb'], json.dumps(r['checks'], ensure_ascii=False))
PY
exit "$status"
