"""Phi-4-mini-reasoning's second turn on the CPU, as the app makes it.

The first inspection's follow-up (run 40412428363: a chat rebuilt from a
two-turn history, TopK 40, TopP 0.95, temperature 0.7) fell apart into
repeated words. This runs one variant per job, to tell a bad draw from a
setup the model can't take: the same history greedy or with other seeds,
the earlier answer with its thinking kept, both turns in one live
conversation, and the history without the app's system turn, and each turn with a note
asking for the final answer in Japanese (note-*).
Usage: followup.py MODEL VARIANT"""
import os
import sys
import time

import litert_lm

SYSTEM = "You are a kind and straightforward assistant. Please answer clearly in the same language as the user."
MATH = "りんごが3個ずつ入った箱が4つあります。そこから5個食べると、残りは何個ですか？"
FOLLOW = "では、その答えを2倍にすると？"
ANSWER = "残りは7個です。"
# The note the app could add to each turn for a reasoning model.
NOTE = "\n\n(Write the final answer in Japanese.)"


def sampler(variant):
    if variant.startswith('greedy'):
        return litert_lm.SamplerConfig(top_k=1, top_p=1.0, temperature=0.0)
    seed = int(variant.rsplit('seed', 1)[1]) if 'seed' in variant else 1
    return litert_lm.SamplerConfig(top_k=40, top_p=0.95, temperature=0.7, seed=seed)


def show(name, start, conversation, reply):
    count = conversation.token_count if isinstance(type(conversation).token_count, property) else conversation.token_count()
    text, thought = str(reply), (reply.channels or {}).get('thought', '')
    words = text.split()
    print(f'RESULT {name} ({time.time() - start:.1f} s, {count} tokens in the conversation)\n'
          f'  answer {len(text)} chars, {len(set(words))} distinct of {len(words)} words: {text[:600]!r} ... {text[-200:]!r}\n'
          f'  thought {len(thought)} chars: {thought[:240]!r} ... {thought[-160:]!r}', flush=True)


def main():
    model, variant = sys.argv[1], sys.argv[2]
    litert_lm.set_min_log_severity(litert_lm.LogSeverity.WARNING)
    os.makedirs('cache', exist_ok=True)
    engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096, cache_dir=os.path.abspath('cache'))
    thinking = litert_lm.ThinkingConfig(enable_thinking=True, thinking_token_budget=1536)
    history = [{'role': 'user', 'content': MATH}, {'role': 'assistant', 'content': ANSWER}]
    if variant == 'think-in-history':
        history[1]['content'] = '<think>\n3×4=12、12−5=7。\n</think>\n\n' + ANSWER
    system = None if variant == 'no-system' else SYSTEM
    noted = variant.startswith('note')
    ask = (lambda text: text + NOTE) if noted else (lambda text: text)
    with engine:
        start = time.time()
        if variant in ('live', 'note-live'):
            with engine.create_conversation(system_message=system, sampler_config=sampler(variant), thinking_config=thinking,
                                            automatic_tool_calling=False) as conversation:
                show('live-first', start, conversation, conversation.send_message(litert_lm.Contents.of(ask(MATH)), max_output_tokens=1800))
                start = time.time()
                show('live-second', start, conversation, conversation.send_message(litert_lm.Contents.of(ask(FOLLOW)), max_output_tokens=1800))
            return
        with engine.create_conversation(system_message=system, sampler_config=sampler(variant), messages=history,
                                        thinking_config=thinking, automatic_tool_calling=False) as conversation:
            if variant == 'greedy':
                print('RENDER', repr(conversation.render_message_to_string(FOLLOW)), flush=True)
            show(variant, start, conversation, conversation.send_message(litert_lm.Contents.of(ask(FOLLOW)), max_output_tokens=1800))


main()
