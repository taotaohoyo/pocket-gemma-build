"""Phi-4-mini-reasoning answered most Japanese questions in Chinese on an Arm
CPU with the app's chat setup, whatever its thinking budget (run
40439991123). Asks the same questions with the app's system message alone
and with a note on the answer's language, and counts the answers written in
Japanese (with hiragana) and in Chinese (simplified-only characters, no
hiragana).
Usage: phi_language.py MODEL none|note"""
import os
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
NOTE = ("Write your final answer in the same language as the user's message: a question in Japanese gets its "
        "answer in Japanese, never in Chinese or English.")
QUESTIONS = [
    ('apples', "りんごが3個ずつ入った箱が4つあります。そこから5個食べると、残りは何個ですか？", '7'),
    ('change', "1個120円のパンを3個買って、1000円札で払いました。おつりはいくらですか？", '640'),
    ('capital', "日本の首都はどこですか？", '東京'),
]
SIMPLIFIED = set('个们这为剩总购买时说吗么从还东车门问间题过应们给钱场设计数结发现实')


def hiragana(text):
    return sum(0x3040 <= ord(c) <= 0x309F for c in text)


def main():
    model, variant = sys.argv[1], sys.argv[2]
    system = SYSTEM + (" " + NOTE if variant == 'note' else '')
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    cache = os.path.abspath('cache-phi')
    os.makedirs(cache, exist_ok=True)
    engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=cache)
    japanese = chinese = right = total = 0
    with engine:
        for seed in (1, 2, 3):
            for name, prompt, expected in QUESTIONS:
                sampler = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=seed)
                start = time.monotonic()
                with engine.create_conversation(system_message=system, sampler_config=sampler,
                                                thinking_config=litert_lm.ThinkingConfig(enable_thinking=True, thinking_token_budget=1536),
                                                automatic_tool_calling=False) as conversation:
                    text, first = '', None
                    for chunk in conversation.send_message_async(litert_lm.Contents.of(prompt), max_output_tokens=4096 - 512):
                        piece = str(chunk)
                        if piece and first is None:
                            first = time.monotonic() - start
                        text += piece
                answer = text.strip()
                is_japanese = hiragana(answer) >= 3
                is_chinese = not is_japanese and any(c in SIMPLIFIED for c in answer)
                total += 1; right += expected in answer; japanese += is_japanese; chinese += is_chinese
                print(f'RESULT {variant} seed={seed} {name}: right={expected in answer} japanese={is_japanese} chinese={is_chinese} '
                      f'answer starts {first and round(first, 1)} s of {time.monotonic() - start:.1f} s\n  answer {answer[:240]!r}', flush=True)
    print(f'SUMMARY {variant}: right {right}/{total}, Japanese {japanese}/{total}, Chinese {chinese}/{total}', flush=True)


main()
