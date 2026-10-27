"""Phi-4-mini-reasoning's thinking budget against its answers, on an Arm CPU
with the app's chat setup: how many tokens it thinks, how long that takes
and whether the answer is right and in Japanese. On the phone's CPU the
1,536-token budget meant minutes of 「じっくり考えています…」 before a word.
Usage: phi_budget.py MODEL BUDGET"""
import os
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
QUESTIONS = [
    ('apples', "りんごが3個ずつ入った箱が4つあります。そこから5個食べると、残りは何個ですか？", '7'),
    ('change', "1個120円のパンを3個買って、1000円札で払いました。おつりはいくらですか？", '640'),
    ('capital', "日本の首都はどこですか？", '東京'),
]


def japanese(text):
    return any(0x3040 <= ord(c) <= 0x30FF for c in text)


def main():
    model, budget = sys.argv[1], int(sys.argv[2])
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    cache = os.path.abspath('cache-phi')
    os.makedirs(cache, exist_ok=True)
    engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=cache)
    with engine:
        for seed in (1, 2, 3):
            for name, prompt, expected in QUESTIONS:
                if name == 'capital' and seed > 1:
                    continue
                sampler = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=seed)
                start = time.monotonic()
                with engine.create_conversation(system_message=SYSTEM, sampler_config=sampler,
                                                thinking_config=litert_lm.ThinkingConfig(enable_thinking=True, thinking_token_budget=budget),
                                                automatic_tool_calling=False) as conversation:
                    first_text, text, thought, chunks = None, '', '', 0
                    for chunk in conversation.send_message_async(litert_lm.Contents.of(prompt), max_output_tokens=4096 - 512):
                        chunks += 1
                        piece = str(chunk)
                        if piece and first_text is None:
                            first_text = time.monotonic() - start
                        text += piece
                        thought += (chunk.channels or {}).get('thought', '')
                total = time.monotonic() - start
                answer = text.strip()
                print(f'RESULT budget={budget} seed={seed} {name}: right={expected in answer} japanese={japanese(answer)} '
                      f'answer starts {first_text and round(first_text, 1)} s of {total:.1f} s, {chunks} chunks, '
                      f'thought {len(thought)} chars, answer {len(answer)} chars\n  answer {answer[:300]!r}', flush=True)


main()
