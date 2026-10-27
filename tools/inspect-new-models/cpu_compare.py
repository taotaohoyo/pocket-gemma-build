"""One question on the CPU with the official LiteRT-LM 0.18.0 build: engine
start, the first chunk, chunks per second, the process's CPU time and the
pages it read from disk. The simulator's cpu-compare probe asks the app's
runtime the same, on the same runner, for Qwen3 0.6B (block-32 4-bit like
the new models), E2B and Qwen3.5 4B.
Usage: cpu_compare.py NAME MODEL"""
import os
import resource
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."


def usage():
    r = resource.getrusage(resource.RUSAGE_SELF)
    rss = r.ru_maxrss / (1e9 if sys.platform == 'darwin' else 1e6)
    return f'user={r.ru_utime:.1f}s sys={r.ru_stime:.1f}s majflt={r.ru_majflt} maxrss={rss:.2f}GB'


def main():
    name, model = sys.argv[1], sys.argv[2]
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    cache = os.path.abspath(f'cache-{name}')
    os.makedirs(cache, exist_ok=True)
    start = time.monotonic()
    engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=cache)
    print(f'CPU_COMPARE {name} engine {time.monotonic() - start:.1f}s {usage()}', flush=True)
    with engine:
        sampler = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=1)
        with engine.create_conversation(system_message=SYSTEM, sampler_config=sampler,
                                        thinking_config=litert_lm.ThinkingConfig(enable_thinking=False, thinking_token_budget=0),
                                        automatic_tool_calling=False) as conversation:
            start = time.monotonic()
            first, chunks, text = None, 0, ''
            for chunk in conversation.send_message_async(litert_lm.Contents.of("日本の首都はどこですか？"), max_output_tokens=96):
                now = time.monotonic() - start
                chunks += 1
                first = first or now
                text += str(chunk)
                print(f'CPU_COMPARE {name} chunk {chunks} t={now:.2f}s {usage()}', flush=True)
            total = time.monotonic() - start
            rate = (chunks - 1) / max(0.001, total - first) if first else 0
            print(f'CPU_COMPARE {name} done {total:.1f}s first {first and round(first, 2)}s chunks={chunks} '
                  f'({rate:.2f}/s after the first) {usage()} answer={text!r}', flush=True)


main()
