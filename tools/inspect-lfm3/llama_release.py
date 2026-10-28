"""Finds the newest llama.cpp release (ggml-org) and the first whose notes
or tag come after LFM3 support (PR 31252, merged 2026-10-27), prints its
assets, and writes TAG, the xcframework URL and its SHA-256 (which is the
SwiftPM checksum of a binary target) to the file given.
Usage: llama_release.py OUT"""
import hashlib
import json
import os
import sys
import urllib.request


def get(url, raw=False):
    headers = {'User-Agent': 'fielua-inspect', 'Accept': 'application/vnd.github+json'}
    if os.environ.get('GH_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
        return r.read() if raw else json.load(r)


def main():
    out = sys.argv[1]
    releases = get('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30')
    for r in releases[:30]:
        print(f'{r["tag_name"]} {r["published_at"]} {r["target_commitish"]} prerelease={r["prerelease"]}')
    newest = releases[0]
    tag = newest['tag_name']
    print(f'== newest {tag}')
    for a in newest['assets']:
        print(f'   {a["name"]} {a["size"]}')
    xc = next(a for a in newest['assets'] if a['name'].endswith('-xcframework.zip'))
    data = get(xc['browser_download_url'], raw=True)
    digest = hashlib.sha256(data).hexdigest()
    with open('llama-xcframework.zip', 'wb') as f:
        f.write(data)
    commit = get(f'https://api.github.com/repos/ggml-org/llama.cpp/commits/{tag}')
    print(f'== {tag} commit {commit["sha"]} {commit["commit"]["committer"]["date"]}')
    # Is the LFM3 merge (19cce69) an ancestor of the tag?
    compare = get(f'https://api.github.com/repos/ggml-org/llama.cpp/compare/19cce6919992fdffd92e0ac152caaf1e2b8f254e...{tag}')
    print(f'== LFM3 merge vs {tag}: {compare["status"]} ahead_by {compare["ahead_by"]} behind_by {compare["behind_by"]}')
    with open(out, 'a') as f:
        f.write(f'LLAMA_TAG={tag}\nLLAMA_XC_URL={xc["browser_download_url"]}\nLLAMA_XC_SHA={digest}\n'
                f'LLAMA_COMMIT={commit["sha"]}\n')
    print(f'PIN llama {tag} {xc["browser_download_url"]} {len(data)} {digest}')


main()
