#!/bin/bash
# Builds the download probe (probe/Probe.swift) for the iOS simulator, opens
# it and prints its DLPROBE lines until DLPROBE-DONE or the time limit.
# Run from the repository root after unzipping PocketGemma-source.zip.
# Usage: tools/check-model-downloads/run-probe.sh [minutes]
set -euo pipefail
minutes="${1:-60}"
root="$PWD"
source scripts/select-xcode.sh
mkdir -p build/Probe
(cd tools/check-model-downloads/probe && xcodegen generate --spec project.yml)
xcrun simctl list runtimes -j > build/Probe/runtimes.json
xcrun simctl list devicetypes -j > build/Probe/devicetypes.json
runtime_id="$(python3 -I - "$root/build/Probe/runtimes.json" <<'PY'
import json, sys
runtimes = json.load(open(sys.argv[1]))['runtimes']
usable = [r for r in runtimes if r.get('isAvailable') and r['name'].startswith('iOS') and int(r['version'].split('.')[0]) >= 26]
best = max(usable, key=lambda r: tuple(map(int, r['version'].split('.'))))
print(best['identifier'])
PY
)"
device_type="$(python3 -I - "$root/build/Probe/devicetypes.json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))['devicetypes']
preferred = [d for d in devices if d['name'] in ('iPhone 17 Pro', 'iPhone 16 Pro')]
print(preferred[0]['identifier'] if preferred else next(d['identifier'] for d in reversed(devices) if d['name'].startswith('iPhone')))
PY
)"
echo "DLPROBE-RUNTIME $runtime_id $device_type"
simulator_id="$(xcrun simctl create 'Fielua download probe' "$device_type" "$runtime_id")"
xcrun simctl boot "$simulator_id"
xcrun simctl bootstatus "$simulator_id" -b > build/Probe/boot.log 2>&1
# Signed locally (no team, no profile), as check-ui.sh signs the preview for
# the keychain: iOS's download service ends every background task of an
# unsigned simulator app at once with NSURLErrorDomain -1 (run 40825923927).
xcodebuild -project tools/check-model-downloads/probe/DownloadProbe.xcodeproj -scheme DownloadProbe -configuration Release \
  -destination "platform=iOS Simulator,id=$simulator_id" -derivedDataPath build/ProbeDerivedData \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build > build/Probe/compile.log 2>&1 \
  || { grep -E 'error:|\*\* .* FAILED' build/Probe/compile.log | head -40; exit 65; }
app="$(find build/ProbeDerivedData/Build/Products/Release-iphonesimulator -maxdepth 1 -name '*.app' | head -1)"
codesign -dv "$app" 2>&1 | grep -E 'Identifier|Signature' | sed 's/^/DLPROBE-SIGNED /' || true
xcrun simctl install "$simulator_id" "$app"
df -h "$HOME" | tail -1
xcrun simctl launch --console-pty "$simulator_id" app.pocketgemma.download-probe > build/Probe/probe.log 2>&1 &
pid=$!
deadline=$(( $(date +%s) + minutes * 60 ))
shown=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 15
  lines=$(grep -c 'DLPROBE' build/Probe/probe.log || true)
  if [ "$lines" -gt "$shown" ]; then
    grep 'DLPROBE' build/Probe/probe.log | sed -n "$((shown + 1)),${lines}p" | tr -d '\r' || true
    shown=$lines
  fi
  grep -q 'DLPROBE-DONE' build/Probe/probe.log && break
  kill -0 "$pid" 2> /dev/null || { echo 'DLPROBE-EXITED'; break; }
done
kill "$pid" > /dev/null 2>&1 || true
xcrun simctl shutdown "$simulator_id" || true
python3 -I - "$root/build/Probe/probe.log" <<'PY'
import json, sys
lines = [line.strip() for line in open(sys.argv[1], errors='replace')]
files = [json.loads(line.split(' ', 1)[1]) for line in lines if line.startswith('DLPROBE-FILE ')]
models = [json.loads(line.split(' ', 1)[1]) for line in lines if line.startswith('DLPROBE-MODEL ')]
done = any(line.startswith('DLPROBE-DONE') for line in lines)
for f in files:
    print('DLPROBE-SUMMARY', f['case'], f.get('session', 'background'), f['id'], 'OK' if f.get('ok') else 'FAILED',
          f.get('bytes', ''), f.get('download_seconds', ''), f.get('error', ''))
for line in lines:
    if line.startswith(('DLPROBE-FIRST-BYTE ', 'DLPROBE-STALL ', 'DLPROBE-RESUME-DATA ', 'DLPROBE-ERROR ')):
        print('DLPROBE-SUMMARY', line)
# A model counts once: by the app's background session, or else by the
# app's own session (1.1.0 (240)'s way round a stalled background task).
by_model = {}
for m in models:
    key = (m['case'], tuple(m['files']))
    by_model[key] = by_model.get(key, False) or m['ok']
failed = [key for key, ok in by_model.items() if not ok]
models = list(by_model)
print(f'DLPROBE-RESULT models={len(models)} failed={len(failed)} done={done}')
sys.exit(0 if done and not failed else 1)
PY
