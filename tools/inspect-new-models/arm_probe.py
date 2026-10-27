"""Times Phi-4-mini-reasoning or Qwen3.5 4B on an Arm CPU (Linux arm64 or
macOS arm64, like the iPhone's) with the app's chat setup, streaming as the
app does: engine start, the first chunk, the first thought, the first
answer text, chunks per second, memory and the cache files. 1.1.0 (205)
showed only 「考えています…」 on the phone for both models.
Usage: arm_probe.py MODEL phi|qwen [threads]"""
import os
import platform
import subprocess
import sys
import threading
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
CHAT = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=1)
CAPITAL = "日本の首都はどこですか？"
MATH = "りんごが3個ずつ入った箱が4つあります。そこから5個食べると、残りは何個ですか？"
# name: (prompt, enable thinking, budget, max output tokens, seconds allowed); the app's settings per model.
CASES = {
    'qwen': [('capital', CAPITAL, False, 0, 1024, 900), ('math', MATH, False, 0, 1024, 600)],
    'phi': [('capital', CAPITAL, True, 1536, 2048, 1500), ('math', MATH, True, 1536, 2048, 1500)],
}


def rss_gb():
    out = subprocess.run(['ps', '-o', 'rss=', '-p', str(os.getpid())], capture_output=True, text=True).stdout.strip()
    return int(out or 0) / 1e6


def pageins():
    """Pages read from disk so far, system-wide (macOS vm_stat, Linux /proc/vmstat)."""
    try:
        if sys.platform == 'darwin':
            for line in subprocess.run(['vm_stat'], capture_output=True, text=True).stdout.splitlines():
                if line.startswith('Pageins'):
                    return int(line.split(':')[1].strip().rstrip('.'))
        else:
            for line in open('/proc/vmstat'):
                if line.startswith('pgmajfault'):
                    return int(line.split()[1])
    except Exception:
        pass
    return -1


def cache_files(cache):
    rows = []
    for root, _, files in os.walk(cache):
        for name in files:
            path = os.path.join(root, name)
            rows.append(f'{os.path.relpath(path, cache)} {os.path.getsize(path) / 1e9:.2f} GB')
    return rows


def run(engine, name, prompt, think, budget, tokens, allowed):
    state = {'chunks': 0, 'text': '', 'thought': '', 'first': None, 'first_thought': None, 'first_text': None,
             'done': False}
    start = time.monotonic()
    page0 = pageins()
    with engine.create_conversation(system_message=SYSTEM, sampler_config=CHAT,
                                    thinking_config=litert_lm.ThinkingConfig(enable_thinking=think, thinking_token_budget=budget),
                                    automatic_tool_calling=False) as conversation:

        def watch():
            while not state['done']:
                time.sleep(15)
                if state['done']:
                    break
                elapsed = time.monotonic() - start
                print(f'  PROGRESS {name} {elapsed:.0f} s: chunks {state["chunks"]}, answer {len(state["text"])} chars, '
                      f'thought {len(state["thought"])} chars, RSS {rss_gb():.2f} GB, pageins +{pageins() - page0}', flush=True)
                if elapsed > allowed:
                    print(f'  STOPPED {name} after {elapsed:.0f} s', flush=True)
                    conversation.cancel_process()
                    break

        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        try:
            for chunk in conversation.send_message_async(litert_lm.Contents.of(prompt), max_output_tokens=tokens):
                now = time.monotonic() - start
                state['chunks'] += 1
                state['first'] = state['first'] or now
                text = str(chunk)
                thought = (chunk.channels or {}).get('thought', '')
                if thought and state['first_thought'] is None:
                    state['first_thought'] = now
                if text and state['first_text'] is None:
                    state['first_text'] = now
                state['text'] += text
                state['thought'] += thought
        except Exception as e:
            print(f'  ERROR {name} {e}', flush=True)
        state['done'] = True
        total = time.monotonic() - start
        try:
            count = conversation.token_count if isinstance(type(conversation).token_count, property) else conversation.token_count()
        except Exception:
            count = -1
    rate = state['chunks'] / max(0.001, total - (state['first'] or total)) if state['first'] else 0
    print(f'RESULT {name}: {total:.1f} s, first chunk {state["first"]}, first thought {state["first_thought"]}, '
          f'first answer text {state["first_text"]}, {state["chunks"]} chunks ({rate:.2f}/s after the first), '
          f'{count} tokens in the conversation, RSS {rss_gb():.2f} GB, pageins +{pageins() - page0}\n'
          f'  answer {state["text"][:400]!r}\n  thought {len(state["thought"])} chars: {state["thought"][:200]!r} ... '
          f'{state["thought"][-120:]!r}', flush=True)


def main():
    model, kind = sys.argv[1], sys.argv[2]
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else None
    print(f'PLATFORM {platform.platform()} {platform.machine()} cpus {os.cpu_count()} threads {threads}', flush=True)
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    cache = os.path.abspath(f'cache-{kind}-{threads}')
    os.makedirs(cache, exist_ok=True)
    start = time.monotonic()
    page0 = pageins()
    engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(thread_count=threads), max_num_tokens=4096,
                              cache_dir=cache)
    print(f'ENGINE {time.monotonic() - start:.1f} s, RSS {rss_gb():.2f} GB, pageins +{pageins() - page0}', flush=True)
    for row in cache_files(cache):
        print(f'  CACHE {row}', flush=True)
    with engine:
        for case in CASES[kind]:
            run(engine, *case)


main()
