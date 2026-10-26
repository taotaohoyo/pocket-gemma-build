"""Prints the newest revision of each Hugging Face repo given, with every
file's size and SHA-256, and writes the chosen file's pinned download URL,
size and hash as KEY=value lines for the next steps.
Usage: resolve.py OUT REPO:FILE:KEY..."""
import json
import sys
import urllib.request


def main():
    out, pairs = sys.argv[1], sys.argv[2:]
    lines = []
    for pair in pairs:
        repo, name, key = pair.split(':')
        with urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}?blobs=true') as r:
            info = json.load(r)
        print(f'== {repo} revision {info["sha"]} lastModified {info.get("lastModified")} '
              f'license {(info.get("cardData") or {}).get("license")} gated {info.get("gated")}')
        chosen = None
        for s in info.get('siblings', []):
            lfs = s.get('lfs') or {}
            print(f'   {s["rfilename"]} {s.get("size")} {lfs.get("sha256", "")}')
            if s['rfilename'] == name:
                chosen = (s.get('size'), lfs.get('sha256'))
        if not chosen:
            sys.exit(f'{name} not in {repo}')
        url = f'https://huggingface.co/{repo}/resolve/{info["sha"]}/{name}?download=true'
        lines += [f'URL_{key}={url}', f'SIZE_{key}={chosen[0]}', f'SHA_{key}={chosen[1]}']
        print(f'PIN {key} {url} {chosen[0]} {chosen[1]}')
    with open(out, 'a') as f:
        f.write('\n'.join(lines) + '\n')


main()
