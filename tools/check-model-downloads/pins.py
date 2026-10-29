"""Reads every downloadable file the app knows from ModelSpec.swift (the
models and their parts) and prints them as JSON: id, name, file name, size,
SHA-256 and the exact download URL the app requests. The checks below take
their pins from here, so they test what the app ships, not a copy.
Usage: pins.py ModelSpec.swift [--matrix]"""
import json
import re
import sys

source = open(sys.argv[1], encoding='utf-8').read()
files = []
for match in re.finditer(r'public static let (\w+) = ModelSpec\((.*?)\n    \)', source, re.S):
    body = match.group(2)
    def field(name, pattern=r'"([^"]*)"'):
        found = re.search(name + r':\s*' + pattern, body)
        return found.group(1) if found else None
    url = re.search(r'downloadURL: URL\(string: "([^"]+)"\)', body).group(1)
    repo, revision = re.search(r'huggingface\.co/([^/]+/[^/]+)/resolve/([0-9a-f]{40})/', url).groups()
    files.append({
        'key': match.group(1),
        'id': field('id') or field('fileName'),
        'name': field('name') or field('fileName'),
        'file': field('fileName'),
        'bytes': int(field('byteCount', r'([\d_]+)').replace('_', '')),
        'sha256': field('sha256'),
        'url': url,
        'repo': repo,
        'revision': revision,
    })
catalog = re.search(r'static var catalog: \[ModelSpec\] \{\s*\[(.*?)\]', source, re.S).group(1)
order = [name.strip().lstrip('.') for name in catalog.split(',')]
parts = dict(re.findall(r'case Self\.(\w+)\.id: \[\.(\w+)\]', source))
listed = [key for model in order for key in [model, parts.get(model)] if key]
missing = [f['key'] for f in files if f['key'] not in listed]
if missing:
    sys.exit(f'files outside the catalog: {missing}')
files.sort(key=lambda f: listed.index(f['key']))
for f in files:
    f['owner'] = next((model for model, part in parts.items() if part == f['key']), f['key'])
if '--matrix' in sys.argv:
    print(json.dumps({'include': files}))
else:
    print(json.dumps(files, indent=1, ensure_ascii=False))
