"""Runs Gemma 4 12B the way the developer 12B check (1.1.0 (199)) did and the
way the 1.1.0 (200) chat did, one difference at a time, and prints each
reply as it ends. On the iPhone GPU the check answered and the chat came out
garbled; the differences are the context (1024 vs 4096), the system message
and the sampler. Usage: chat.py MODEL BACKEND CASE..."""
import os
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
QUESTION = "日本の首都はどこですか？一文で答えてください。"
HELLO = "こんにちはー！"
GREEDY = litert_lm.SamplerConfig(top_k=1, top_p=1.0, temperature=0.0)
CHAT = litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=1)

# name: (context, fp32, system message, sampler, prompt)
CASES = {
    'ctx1024-check': (1024, False, None, GREEDY, QUESTION),
    'ctx1024-hello-greedy': (1024, False, None, GREEDY, HELLO),
    'ctx1024-chat': (1024, False, SYSTEM, CHAT, HELLO),
    'ctx2048-chat': (2048, False, SYSTEM, CHAT, HELLO),
    'ctx4096-hello-greedy': (4096, False, None, GREEDY, HELLO),
    'ctx4096-check': (4096, False, None, GREEDY, QUESTION),
    'ctx4096-chat': (4096, False, SYSTEM, CHAT, HELLO),
    'ctx4096-chat-fp32': (4096, True, SYSTEM, CHAT, HELLO),
}


def main():
    model, backend_name, names = sys.argv[1], sys.argv[2], sys.argv[3:]
    tokens = int(os.environ.get('MAX_OUTPUT_TOKENS', '40'))
    backend = litert_lm.Backend.GPU() if backend_name == 'gpu' else litert_lm.Backend.CPU()
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    groups = {}
    for name in names:
        context, fp32 = CASES[name][:2]
        groups.setdefault((context, fp32), []).append(name)
    for (context, fp32), members in groups.items():
        cache = os.path.abspath(f'cache-{backend_name}-{context}-{"fp32" if fp32 else "default"}')
        os.makedirs(cache, exist_ok=True)
        extra = {'activation_data_type': litert_lm.ActivationDataType.FLOAT32} if fp32 else {}
        start = time.time()
        print(f'\n##### engine {backend_name} context={context} fp32={fp32}', flush=True)
        try:
            engine = litert_lm.Engine(model, backend=backend, max_num_tokens=context, cache_dir=cache, **extra)
        except Exception as e:
            print(f'RESULT engine-failed {backend_name} {context} {e}', flush=True)
            continue
        print(f'engine ready in {time.time() - start:.1f} s', flush=True)
        with engine:
            for name in members:
                _, _, system, sampler, prompt = CASES[name]
                start = time.time()
                try:
                    with engine.create_conversation(system_message=system, sampler_config=sampler,
                                                    thinking_config=litert_lm.ThinkingConfig(enable_thinking=False, thinking_token_budget=0),
                                                    automatic_tool_calling=False) as conversation:
                        reply = str(conversation.send_message(prompt, max_output_tokens=tokens))
                except Exception as e:
                    reply = f'<error {e}>'
                print(f'RESULT {backend_name} {name} ({time.time() - start:.1f} s): {reply!r}', flush=True)


main()
