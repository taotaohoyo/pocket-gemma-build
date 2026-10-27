"""Qwen3.5 4B with its thinking switch on returned no answer in the app's
simulator check (run 40448102818: ServiceError.emptyReply after a short
thought, 1.1.0 (206)). The same question on the official LiteRT-LM 0.18.0
CPU build with the app's settings: thinking budget 256 of 512 output tokens,
top-k 40, top-p 0.95, temperature 0.7, the app's system message; and with
no budget. Prints each reply's thought length, answer and how it ended.
Usage: qwen35_thinking.py MODEL"""
import os
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
QUESTIONS = [('sum', "17と23を足すといくつですか？", '40'), ('capital', "日本の首都はどこですか？", '東京')]


def main():
    model = sys.argv[1]
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    cache = os.path.abspath('cache-qwen35')
    os.makedirs(cache, exist_ok=True)
    engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=cache)
    with engine:
        for budget in (256, None):
            for seed in (1, 2, 3):
                for name, prompt, expected in QUESTIONS:
                    sampler = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=seed)
                    thinking = (litert_lm.ThinkingConfig(enable_thinking=True, thinking_token_budget=budget) if budget
                                else litert_lm.ThinkingConfig(enable_thinking=True))
                    start = time.monotonic()
                    text, thought, chunks, error = '', '', 0, None
                    with engine.create_conversation(system_message=SYSTEM, sampler_config=sampler, thinking_config=thinking,
                                                    automatic_tool_calling=False) as conversation:
                        try:
                            for chunk in conversation.send_message_async(litert_lm.Contents.of(prompt), max_output_tokens=512):
                                chunks += 1
                                text += str(chunk)
                                channels = getattr(chunk, 'channels', None) or {}
                                for value in (channels.values() if hasattr(channels, 'values') else []):
                                    thought += str(value)
                        except Exception as failure:  # noqa: BLE001
                            error = repr(failure)
                    answer = text.strip()
                    print(f'RESULT budget={budget} seed={seed} {name}: right={expected in answer} empty={not answer} '
                          f'chunks={chunks} thought={len(thought)} chars in {time.monotonic() - start:.1f} s error={error}\n'
                          f'  thought tail {thought[-160:]!r}\n  answer {answer[:200]!r}', flush=True)


main()
