#!/bin/bash
# TestFlight archive job (testflight.yml; no secrets). Completes the unsigned
# archive the way scripts/build-ios.sh completes the device app (runtime
# receipt, open-source licenses), adds the App Store privacy manifest, and
# checks the app with the source's own IPA check.
# Usage, from the source checkout: finish-archive.sh <xcarchive>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
archive="$1"
app="$archive/Products/Applications/PocketGemma.app"
test -f "$app/PocketGemma"
test -f "$app/Info.plist"
# The model download's Live Activity (Dynamic Island) extension.
test -f "$app/PlugIns/PocketActivity.appex/Info.plist"
python3 scripts/record-runtime-build.py --app "$app" --derived-data build/DerivedData --target iphoneos --configuration Release
# Same license files as scripts/build-ios.sh (Settings > オープンソースライセンス).
licenses="$app/ThirdPartyLicenses"
mkdir -p "$licenses"
litert_license=Packages/PocketLiteRTLM/LICENSE
[[ -f "$litert_license" ]] || litert_license="$(find build/DerivedData/SourcePackages/checkouts -maxdepth 2 -path '*LiteRT-LM*/LICENSE' 2>/dev/null | head -1 || true)"
[[ -n "$litert_license" && -f "$litert_license" ]] && cp "$litert_license" "$licenses/LiteRT-LM.txt" || true
zip_license="$(find build/DerivedData/SourcePackages/checkouts -maxdepth 2 -path '*ZIPFoundation*/LICENSE' 2>/dev/null | head -1 || true)"
[[ -n "$zip_license" ]] && cp "$zip_license" "$licenses/ZIPFoundation.txt" || true
math_license="$(find build/DerivedData/SourcePackages/checkouts -maxdepth 2 -path '*SwiftMath*/LICENSE*' 2>/dev/null | head -1 || true)"
[[ -n "$math_license" ]] && cp "$math_license" "$licenses/SwiftMath.txt" || true
ls "$licenses"
# App Store Connect asks for the reasons behind these APIs. Kept here rather
# than in PocketGemma-source.zip while several threads edit that zip.
cp "$here/PrivacyInfo.xcprivacy" "$app/PrivacyInfo.xcprivacy"
plutil -lint "$app/PrivacyInfo.xcprivacy"
# Which embedded binaries call the boot-time clock the manifest declares.
for binary in "$app/PocketGemma" "$app"/Frameworks/*.framework/*; do
  [[ -f "$binary" && -x "$binary" ]] || continue
  if nm -u "$binary" 2>/dev/null | grep -q -x '_mach_absolute_time'; then
    echo "PRIVACY-CHECK: ${binary#"$app"/} uses mach_absolute_time"
  fi
done
# The source's own check of the packaged app: identifier, ARM64, frameworks,
# runtime receipt, extension version.
work="$(mktemp -d)"
mkdir -p "$work/Payload"
ditto "$app" "$work/Payload/PocketGemma.app"
(cd "$work" && ditto -c -k --keepParent Payload check.ipa)
python3 scripts/check-ipa.py "$work/check.ipa"
rm -rf "$work"
