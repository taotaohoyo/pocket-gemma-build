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
xcodebuild -project tools/check-model-downloads/probe/DownloadProbe.xcodeproj -scheme DownloadProbe -configuration Release \
  -destination "platform=iOS Simulator,id=$simulator_id" -derivedDataPath build/ProbeDerivedData \
  CODE_SIGNING_ALLOWED=NO build > build/Probe/compile.log 2>&1 \
  || { grep -E 'error:|\*\* .* FAILED' build/Probe/compile.log | head -40; exit 65; }
app="$(find build/ProbeDerivedData/Build/Products/Release-iphonesimulator -maxdepth 1 -name '*.app' | head -1)"
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
    print('DLPROBE-SUMMARY', f['case'], f['id'], 'OK' if f.get('ok') else 'FAILED', f.get('bytes', ''), f.get('download_seconds', ''), f.get('error', ''))
failed = [m for m in models if not m['ok']]
print(f'DLPROBE-RESULT models={len(models)} failed={len(failed)} done={done}')
sys.exit(0 if done and not failed else 1)
PY
