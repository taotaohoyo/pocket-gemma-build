#!/bin/bash
# The network path of a model download (1.1.0 (241)): on the phone, E2B
# hardly moved on Wi-Fi and went on over 5G (2026-10-29 06:52 UTC). Prints
# NETCHECK lines: the Hub's redirect for the app's E2B link, each host's
# CNAME, IPv4 (A) and IPv6 (AAAA) addresses, the CDN's edges for Japanese
# networks (Google's resolver with an EDNS client subnet) and their names,
# and 32 MB of the file over IPv4 and over IPv6.
# Usage: tools/check-model-downloads/net.sh <the app's E2B URL>
set -uo pipefail
url="$1"
only() { grep -E "$1" | head -"${2:-4}" | tr '\n' ' '; }
hop=$(curl -sS -o /dev/null -r 0-0 -w '%{http_code} %{redirect_url}' "$url")
location="${hop#* }"
cdn=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname or "")' "$location")
echo "NETCHECK-REDIRECT status=${hop%% *} host=$cdn path=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).path[:40])' "$location")"
for host in huggingface.co "$cdn" cdn-lfs.hf.co cas-bridge.xethub.hf.co; do
  echo "NETCHECK-DNS $host CNAME=$(dig +short CNAME "$host" | only . 3) A=$(dig +short A "$host" | only '^[0-9.]+$') AAAA=$(dig +short AAAA "$host" | only ':')"
done
# Japanese networks: SoftBank BB, OCN, NTT docomo, KDDI au, and a NURO-like range.
for subnet in 126.0.0.0/24 153.156.0.0/24 49.96.0.0/24 106.128.0.0/24 220.208.0.0/24; do
  for host in huggingface.co "$cdn"; do
    a=$(dig +short @8.8.8.8 +subnet="$subnet" A "$host" | only '^[0-9.]+$' 2)
    aaaa=$(dig +short @8.8.8.8 +subnet="$subnet" AAAA "$host" | only ':' 2)
    edge=$(for ip in $a; do dig +short -x "$ip" | head -1; done | tr '\n' ' ')
    echo "NETCHECK-JP $subnet $host A=$a AAAA=$aaaa edge=$edge"
  done
done
for family in 4 6; do
  curl -"$family" -sS -o /dev/null -r 0-33554431 -L --max-time 40 \
    -w "NETCHECK-CURL ipv$family code=%{http_code} remote=%{remote_ip} http=%{http_version} connect=%{time_connect}s tls=%{time_appconnect}s first_byte=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download} speed=%{speed_download}B/s\n" \
    "$url" 2>&1 | tail -1
done
true
