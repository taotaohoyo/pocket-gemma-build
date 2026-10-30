#!/bin/bash
# Why a long model download is slow when a short check is not (2026-10-30):
# on the phone over 5G (Speedtest 269 Mbps), LFM3 1.7B took 176 MB in five
# minutes (0.59 MB/s) while 1.1.0 (241)'s check took the first 8 MB of E2B at
# 1.7-7 MB/s. From Japan, the Hub's file server (us.aws.cdn.hf.co) is Amazon
# servers in Singapore (run 40832162321). This asks the same servers, the
# runner's own and a Singapore one (reached by its address), for:
# - the first 8 MB of E2B (asked for by everyone, likely kept ready),
# - 32 MB from the middle of LFM3 1.7B (rarely asked for), then the same
#   32 MB again,
# - 32 MB as four 8 MB pieces on four connections at once,
# - 32 MB over HTTP/1.1 instead of HTTP/2,
# and the Hub's own Xet route (the one its download tool uses): where the
# pieces of LFM3 1.7B come from, and that host's servers for Japan.
# Prints SPEED lines. Signed links and tokens are never printed.
# Usage: tools/check-model-downloads/speed.sh <E2B URL> <LFM3 1.7B URL> <LFM3 bytes>
set -uo pipefail
e2b="$1"; lfm="$2"; size="$3"
location() { curl -sS -o /dev/null -r 0-0 -w '%{redirect_url}' "$1"; }
host_of() { python3 -I -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname or "")' "$1"; }
e2b_at=$(location "$e2b"); lfm_at=$(location "$lfm")
cdn=$(host_of "$lfm_at")
sg=$(dig +short @8.8.8.8 +subnet=126.0.0.0/24 A "$cdn" | grep -E '^[0-9.]+$' | head -1)
us=$(dig +short A "$cdn" | grep -E '^[0-9.]+$' | head -1)
echo "SPEED-SERVERS cdn=$cdn runner=$us ($(dig +short -x "$us" | head -1)) singapore=$sg ($(dig +short -x "$sg" | head -1))"
# One transfer: the server's address, the range, curl's figures.
fetch() { # label address url first last [curl options]
  local label="$1" address="$2" url="$3" first="$4" last="$5"; shift 5
  curl -sS -o /dev/null --resolve "$cdn:443:$address" -r "$first-$last" --max-time 120 "$@" \
    -w "SPEED $label code=%{http_code} http=%{http_version} remote=%{remote_ip} connect=%{time_connect}s tls=%{time_appconnect}s first_byte=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download} MBps=%{speed_download}\n" \
    "$url" 2>&1 | tail -1 | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^MBps=/) { split($i, v, "="); $i = sprintf("MBps=%.1f", v[2] / 1000000) } print }'
}
mb=$((1024 * 1024))
for place in runner singapore; do
  address=$us; [ "$place" = singapore ] && address=$sg
  # A fresh middle part of LFM3 for each place, so neither warms the other.
  middle=$(( (size / 4 + (RANDOM % 256) * mb) / mb * mb ))
  [ "$place" = singapore ] && middle=$(( middle + 300 * mb ))
  fetch "$place e2b-first-8MB" "$address" "$e2b_at" 0 $((8 * mb - 1))
  fetch "$place lfm3-middle-32MB at=$((middle / mb))MB" "$address" "$lfm_at" "$middle" $((middle + 32 * mb - 1))
  fetch "$place lfm3-same-32MB-again" "$address" "$lfm_at" "$middle" $((middle + 32 * mb - 1))
  other=$((middle + 64 * mb))
  start=$(date +%s.%N)
  for piece in 0 1 2 3; do
    fetch "$place lfm3-four-at-once piece=$piece" "$address" "$lfm_at" $((other + piece * 8 * mb)) $((other + (piece + 1) * 8 * mb - 1)) &
  done
  wait
  echo "SPEED $place lfm3-four-at-once 32MB total=$(python3 -I -c "import sys, time; print(round(time.time() - float(sys.argv[1]), 2))" "$start")s"
  third=$((middle + 128 * mb))
  fetch "$place lfm3-http1.1-32MB" "$address" "$lfm_at" "$third" $((third + 32 * mb - 1)) --http1.1
done
# The Hub's Xet route for LFM3 1.7B: a read token, the file's Xet hash, and
# the reconstruction (which hosts serve its pieces).
python3 -I - "$lfm" <<'PY'
import json, socket, subprocess, sys, urllib.parse, urllib.request
url = sys.argv[1]
parts = urllib.parse.urlsplit(url)
repo, rev = parts.path.split('/resolve/')[0].strip('/'), parts.path.split('/resolve/')[1].split('/')[0]
class Stop(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None
opener = urllib.request.build_opener(Stop)
request = urllib.request.Request(url, method='HEAD')
try:
    response = opener.open(request)
    headers = response.headers
except urllib.error.HTTPError as error:
    headers = error.headers
xet_hash = headers.get('X-Xet-Hash')
print('SPEED-XET hash-header', 'present' if xet_hash else 'absent', 'link-xet', 'present' if 'xet' in (headers.get('Link') or '').lower() else 'absent')
try:
    token = json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/xet-read-token/{rev}'))
except Exception as error:
    print('SPEED-XET token failed', type(error).__name__, error); sys.exit()
cas = token.get('casUrl') or token.get('cas_url')
print('SPEED-XET cas', urllib.parse.urlsplit(cas).hostname if cas else None, 'token-fields', sorted(token.keys()))
if not (cas and xet_hash): sys.exit()
access = token.get('accessToken') or token.get('access_token')
for version in ('v2', 'v1'):
    try:
        plan = json.load(urllib.request.urlopen(urllib.request.Request(f'{cas}/{version}/reconstructions/{xet_hash}', headers={'Authorization': f'Bearer {access}'})))
        break
    except Exception as error:
        print('SPEED-XET reconstruction', version, 'failed', type(error).__name__, getattr(error, 'code', ''))
        plan = None
if not plan: sys.exit()
print('SPEED-XET reconstruction fields', sorted(plan.keys()), 'terms', len(plan.get('terms', [])))
hosts = {}
fetch_info = plan.get('fetch_info') or plan.get('xorbs') or {}
for xorb, entries in fetch_info.items():
    for entry in (entries if isinstance(entries, list) else [entries]):
        link = entry.get('url') or ''
        hosts.setdefault(urllib.parse.urlsplit(link).hostname, 0)
        hosts[urllib.parse.urlsplit(link).hostname] += 1
print('SPEED-XET piece hosts', hosts)
for host in hosts:
    if not host: continue
    for subnet in ('126.0.0.0/24', '49.96.0.0/24'):
        out = subprocess.run(['dig', '+short', '@8.8.8.8', f'+subnet={subnet}', 'A', host], capture_output=True, text=True).stdout.split()
        names = [subprocess.run(['dig', '+short', '-x', ip], capture_output=True, text=True).stdout.strip() for ip in out if ip[0].isdigit()][:2]
        print('SPEED-XET-JP', subnet, host, 'A', out[:4], 'names', names)
    aaaa = subprocess.run(['dig', '+short', 'AAAA', host], capture_output=True, text=True).stdout.split()
    print('SPEED-XET-AAAA', host, aaaa[:2])
PY
true
