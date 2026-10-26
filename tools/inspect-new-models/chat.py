"""Runs Phi-4-mini-reasoning or Qwen3.5 4B on the CPU with the app's
Japanese chat setup (its default instruction, TopK 40, TopP 0.95,
temperature 0.7) and prints, per case, the answer text, the thought
channel's length and start, the time and the tokens. Also checks whether a
second conversation on the same engine answers as one on a fresh engine
(Qwen3.5's card says to make a new engine for each conversation).
Usage: chat.py MODEL phi|qwen"""
import os
import resource
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
CHAT = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=1)
GREEDY = litert_lm.SamplerConfig(top_k=1, top_p=1.0, temperature=0.0)
MATH = "りんごが3個ずつ入った箱が4つあります。そこから5個食べると、残りは何個ですか？"
HELLO = "こんにちは！あなたは何ができますか？短く教えてください。"
CAPITAL = "日本の首都はどこですか？一文で答えてください。"
MULTIPLY = "17×23はいくつですか？"

# name: (system, sampler, enable thinking, budget, prompt, max output tokens)
CASES = {
    'phi': [
        ('math-think-1536', SYSTEM, CHAT, True, 1536, MATH, 3000),
        ('math-no-think-flag', SYSTEM, CHAT, False, 0, MATH, 3000),
        ('hello-think-1536', SYSTEM, CHAT, True, 1536, HELLO, 3000),
        ('math-budget-64', SYSTEM, CHAT, True, 64, MATH, 1200),
    ],
    'qwen': [
        ('hello', SYSTEM, CHAT, False, 0, HELLO, 400),
        ('capital', SYSTEM, CHAT, False, 0, CAPITAL, 200),
        ('multiply-think-256', SYSTEM, CHAT, True, 256, MULTIPLY, 800),
        ('multiply-no-think', SYSTEM, CHAT, False, 0, MULTIPLY, 400),
    ],
}


def rss():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6


def run(engine, name, system, sampler, think, budget, prompt, tokens, messages=None):
    start = time.time()
    try:
        with engine.create_conversation(system_message=system, sampler_config=sampler, messages=messages,
                                        thinking_config=litert_lm.ThinkingConfig(enable_thinking=think, thinking_token_budget=budget),
                                        automatic_tool_calling=False) as conversation:
            if name == 'render':
                print('RENDER', repr(conversation.render_message_to_string(prompt)), flush=True)
            # Content parts, as the app's Swift messages are sent.
            reply = conversation.send_message(litert_lm.Contents.of(prompt), max_output_tokens=tokens)
            count = conversation.token_count if isinstance(type(conversation).token_count, property) else conversation.token_count()
        text = str(reply)
        thought = (reply.channels or {}).get('thought', '')
        other = {k: len(v) for k, v in (reply.channels or {}).items() if k != 'thought'}
        print(f'RESULT {name} ({time.time() - start:.1f} s, {count} tokens in the conversation, peak RSS {rss():.2f} GB)\n'
              f'  answer {text!r}\n  thought {len(thought)} chars: {thought[:300]!r} ... {thought[-200:]!r}\n  other channels {other}', flush=True)
        return text
    except Exception as e:
        print(f'RESULT {name} error {e}', flush=True)
        return None


def main():
    model, kind = sys.argv[1], sys.argv[2]
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    cache = os.path.abspath(f'cache-{kind}')
    os.makedirs(cache, exist_ok=True)
    for attempt in ('first start (writes the cache)', 'second start (reads the cache)'):
        start = time.time()
        engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=cache)
        print(f'ENGINE {attempt}: {time.time() - start:.1f} s, peak RSS {rss():.2f} GB', flush=True)
        if attempt.startswith('first'):
            engine.close()
    with engine:
        run(engine, 'render', SYSTEM, GREEDY, False, 0, CAPITAL, 64)
        for case in CASES[kind]:
            run(engine, *case)
        # A two-turn chat rebuilt from history, as the app does after a switch.
        run(engine, 'history', SYSTEM, CHAT, kind == 'phi', 1536 if kind == 'phi' else 0, 'では、その答えを2倍にすると？', 3000,
            messages=[{'role': 'user', 'content': MATH}, {'role': 'assistant', 'content': '残りは7個です。'}])
        reused = run(engine, 'greedy-on-used-engine', SYSTEM, GREEDY, False, 0, CAPITAL, 120)
    fresh_engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=cache)
    with fresh_engine:
        fresh = run(fresh_engine, 'greedy-on-fresh-engine', SYSTEM, GREEDY, False, 0, CAPITAL, 120)
        again = run(fresh_engine, 'greedy-second-conversation', SYSTEM, GREEDY, False, 0, CAPITAL, 120)
    print(f'CARRY-OVER used-engine==fresh {reused == fresh}; second-conversation==fresh {again == fresh}', flush=True)


main()
