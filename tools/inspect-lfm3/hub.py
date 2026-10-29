"""Prints, for the LFM3 and Kimi candidates of 1.1.0 (232), each Hugging Face
repo's newest revision, license, gating and every file with its size and
SHA-256, plus the GGUF repos the Hub finds for the Kimi models; then the
text files that decide the integration (license, chat template, configs).
Writes KEY=value pins for the chosen GGUF files to the file given.
Usage: hub.py OUT"""
import json
import sys
import urllib.parse
import urllib.request

REPOS = [
    'LiquidAI/LFM3-1.7B', 'LiquidAI/LFM3-1.7B-GGUF', 'LiquidAI/LFM3-1.7B-ONNX', 'LiquidAI/LFM3-1.7B-MLX-4bit',
    'LiquidAI/LFM3-VL-2B', 'LiquidAI/LFM3-VL-2B-GGUF', 'LiquidAI/LFM3-VL-2B-ONNX',
    'LiquidAI/LFM3-Audio-2B', 'LiquidAI/LFM3-Audio-2B-GGUF', 'LiquidAI/LFM3-Audio-2B-ONNX',
    'LiquidAI/LFM3-Omni-2B', 'LiquidAI/LFM3-Omni-2B-GGUF', 'LiquidAI/LFM3-Omni-2B-ONNX',
    'moonshotai/Kimi-VL-A3B-Instruct', 'moonshotai/Kimi-VL-A3B-Thinking-2506',
    'moonshotai/Moonlight-16B-A3B-Instruct', 'moonshotai/Kimi-Audio-7B-Instruct', 'moonshotai/Kimi-Audio-7B',
]
SEARCHES = ['LFM3', 'Kimi-VL-A3B', 'Moonlight-16B-A3B', 'Kimi-Audio-7B']
TEXTS = [
    ('LiquidAI/LFM3-1.7B', ['LICENSE', 'chat_template.jinja', 'generation_config.json', 'config.json', 'tokenizer_config.json']),
    ('LiquidAI/LFM3-1.7B-GGUF', ['README.md']),
    ('LiquidAI/LFM3-VL-2B', ['config.json', 'chat_template.jinja', 'preprocessor_config.json']),
    ('LiquidAI/LFM3-VL-2B-GGUF', ['README.md']),
    ('LiquidAI/LFM3-Audio-2B', ['README.md']),
    ('LiquidAI/LFM3-Omni-2B', ['README.md']),
    ('moonshotai/Kimi-VL-A3B-Instruct', ['LICENSE', 'config.json']),
    ('moonshotai/Moonlight-16B-A3B-Instruct', ['LICENSE', 'config.json']),
    ('moonshotai/Kimi-Audio-7B-Instruct', ['LICENSE']),
]


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'fielua-inspect'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def info(repo):
    try:
        return json.loads(get(f'https://huggingface.co/api/models/{repo}?blobs=true'))
    except Exception as error:  # a repo that does not exist answers 401/404
        print(f'== {repo} UNAVAILABLE {error}')
        return None


def main():
    out = sys.argv[1]
    pins = []
    revisions = {}
    for repo in REPOS:
        data = info(repo)
        if not data:
            continue
        revisions[repo] = data['sha']
        card = data.get('cardData') or {}
        print(f'== {repo} revision {data["sha"]} lastModified {data.get("lastModified")} license {card.get("license")} '
              f'license_name {card.get("license_name")} gated {data.get("gated")} pipeline {data.get("pipeline_tag")} '
              f'library {data.get("library_name")} downloads {data.get("downloads")}')
        total = 0
        for s in data.get('siblings', []):
            lfs = s.get('lfs') or {}
            size = s.get('size') or 0
            total += size
            print(f'   {s["rfilename"]} {size} {lfs.get("sha256", "")}')
            name = s['rfilename']
            if repo == 'LiquidAI/LFM3-1.7B-GGUF' and name.endswith('.gguf'):
                key = name.replace('LFM3-1.7B-', '').replace('.gguf', '').replace('-', '_').upper()
                pins.append(f'URL_{key}=https://huggingface.co/{repo}/resolve/{data["sha"]}/{name}?download=true')
                pins.append(f'FILE_{key}={name}')
                pins.append(f'SIZE_{key}={size}')
                pins.append(f'SHA_{key}={lfs.get("sha256", "")}')
        print(f'   total {total}')
    for query in SEARCHES:
        try:
            found = json.loads(get('https://huggingface.co/api/models?' + urllib.parse.urlencode(
                {'search': query, 'limit': 40, 'sort': 'downloads', 'direction': -1})))
        except Exception as error:
            print(f'## search {query} failed {error}')
            continue
        print(f'## search {query}: {len(found)}')
        for m in found:
            print(f'   {m["id"]} downloads {m.get("downloads")} tags {",".join(t for t in m.get("tags", []) if t in ("gguf", "mlx", "onnx", "litert", "litert-lm"))}')
            if 'gguf' in m.get('tags', []) and not m['id'].startswith('LiquidAI/') and query != 'LFM3':
                data = info(m['id'])
                if data:
                    for s in data.get('siblings', []):
                        if s['rfilename'].endswith('.gguf'):
                            print(f'      {s["rfilename"]} {s.get("size")}')
    for repo, names in TEXTS:
        rev = revisions.get(repo)
        if not rev:
            continue
        for name in names:
            try:
                text = get(f'https://huggingface.co/{repo}/resolve/{rev}/{name}').decode('utf-8', 'replace')
            except Exception as error:
                print(f'>>>>> {repo}/{name} missing {error}')
                continue
            print(f'>>>>> {repo}@{rev}/{name} ({len(text)} chars)')
            print(text[:30000])
            print(f'<<<<< {repo}/{name}')
    with open(out, 'a') as f:
        f.write('\n'.join(pins) + '\n')
    print('\n'.join(pins))


main()
