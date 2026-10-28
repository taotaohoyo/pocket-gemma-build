"""Asks LFM3-1.7B short Japanese questions through llama-server, the way the
app will ask them (1.1.0 (232)): the official chat template rendered by the
server, thinking on and off, then a raw completion of that prompt with the
model card's sampling. Prints each prompt once, each reply with its thought
apart, the token counts and speeds, and a summary line per case.
Usage: chat.py LABEL"""
import json
import re
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:8080'
SYSTEM = 'You are a kind and straightforward assistant. Please answer clearly in the same language as the user.'
QUESTIONS = [
    'こんにちは。あなたは誰ですか？2文で教えてください。',
    '日本の首都はどこですか？',
    'りんごが3個、みかんが5個あります。果物は全部で何個ですか？',
    '朝の時間を有効に使うコツを3つ、箇条書きで教えてください。',
    '「ありがとう」を英語と韓国語にしてください。',
    '15 × 12 はいくつですか？',
]


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return json.load(r)


def japanese_share(text):
    letters = [c for c in text if not c.isspace() and not c.isdigit() and c not in '.,!?。、！？「」()（）*-:：#']
    if not letters:
        return 0.0
    jp = sum(1 for c in letters if '぀' <= c <= 'ヿ' or '一' <= c <= '鿿' or '＀' <= c <= '￯')
    return jp / len(letters)


def split(content):
    m = re.search(r'<think>(.*?)</think>', content, re.S)
    if m:
        return m.group(1).strip(), (content[:m.start()] + content[m.end():]).strip()
    if '</think>' in content:
        head, _, tail = content.partition('</think>')
        return head.replace('<think>', '').strip(), tail.strip()
    if '<think>' in content:
        return content.split('<think>', 1)[1].strip(), ''
    return '', content.strip()


def ask(messages, thinking, label, n_predict):
    rendered = post('/apply-template', {'messages': messages, 'chat_template_kwargs': {'enable_thinking': thinking}})
    prompt = rendered['prompt']
    start = time.time()
    out = post('/completion', {'prompt': prompt, 'n_predict': n_predict, 'temperature': 0.1, 'top_k': 50, 'top_p': 1.0,
                               'min_p': 0.0, 'repeat_penalty': 1.1, 'repeat_last_n': 64, 'cache_prompt': False,
                               'seed': 7, 'stream': False, 'return_tokens': False})
    wall = time.time() - start
    content = out['content']
    thought, answer = split(content)
    t = out.get('timings', {})
    print(f'----- {label} thinking={thinking}')
    print(f'PROMPT {json.dumps(prompt, ensure_ascii=False)}')
    print(f'RAW {json.dumps(content[:3000], ensure_ascii=False)}')
    print(f'THOUGHT {len(thought)} chars: {json.dumps(thought[:600], ensure_ascii=False)}')
    print(f'ANSWER {json.dumps(answer, ensure_ascii=False)}')
    print(f'STATS prompt_n={t.get("prompt_n")} prefill={t.get("prompt_per_second", 0):.1f}/s predicted_n={t.get("predicted_n")} '
          f'decode={t.get("predicted_per_second", 0):.1f}/s wall={wall:.1f}s stop={out.get("stop_type")} '
          f'truncated={out.get("truncated")} japanese={japanese_share(answer):.2f}')
    return thought, answer, t, wall, out.get('stop_type')


def main():
    label = sys.argv[1]
    props = get('/props')
    print('CHAT_TEMPLATE_BEGIN')
    print(props.get('chat_template', '')[:20000])
    print('CHAT_TEMPLATE_END')
    print('PROPS', json.dumps({k: v for k, v in props.items() if k != 'chat_template'}, ensure_ascii=False)[:4000])
    rows = []
    for thinking in (False, True):
        for i, q in enumerate(QUESTIONS):
            messages = [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': q}]
            thought, answer, t, wall, stop = ask(messages, thinking, f'{label} q{i}', 2048 if thinking else 768)
            rows.append((thinking, i, len(thought), len(answer), t.get('predicted_n'), t.get('predicted_per_second', 0), wall,
                         japanese_share(answer), stop))
            if i == 0:
                # The next turn, as the app sends it: the earlier answer
                # without its thought.
                follow = messages + [{'role': 'assistant', 'content': answer},
                                     {'role': 'user', 'content': 'ありがとう。では、あなたが得意なことを1つ教えて。'}]
                thought2, answer2, t2, wall2, stop2 = ask(follow, thinking, f'{label} q{i} follow-up', 2048 if thinking else 768)
                rows.append((thinking, f'{i}f', len(thought2), len(answer2), t2.get('predicted_n'),
                             t2.get('predicted_per_second', 0), wall2, japanese_share(answer2), stop2))
    print('SUMMARY label thinking case thought_chars answer_chars tokens decode_tps wall_s japanese stop')
    for r in rows:
        print(f'SUMMARY {label} {r[0]} {r[1]} {r[2]} {r[3]} {r[4]} {r[5]:.1f} {r[6]:.1f} {r[7]:.2f} {r[8]}')


main()
