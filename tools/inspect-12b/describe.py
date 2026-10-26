"""Prints what a .litertlm file holds: its sections, its LLM metadata (chat
template, stop tokens, attention settings) and, for each TFLite graph, the
signatures with their tensor shapes and the ops it uses. Used to compare the
Gemma 4 12B export with E4B's when 12B's chat replies came out garbled on the
iPhone GPU (1.1.0 (200), 2026-10-26)."""
import collections
import mmap
import os
import sys

import tflite
from litert_lm_builder import litertlm_peek

TYPES = {getattr(tflite.TensorType, n): n for n in dir(tflite.TensorType) if n.isupper()}
OPS = {getattr(tflite.BuiltinOperator, n): n for n in dir(tflite.BuiltinOperator) if n.isupper()}


def is_magic(n):
    return n >= 11 and n % 2 and all(n % i for i in range(3, int(n ** 0.5) + 1, 2))


def describe_graph(path):
    with open(path, 'rb') as f:
        buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    model = tflite.Model.GetRootAsModel(buf, 0)
    print(f'\n=== {os.path.basename(path)} ({len(buf) / 1e6:.1f} MB) subgraphs={model.SubgraphsLength()} signatures={model.SignatureDefsLength()}')
    for s in range(model.SignatureDefsLength()):
        sig = model.SignatureDefs(s)
        graph = model.Subgraphs(sig.SubgraphIndex())

        def line(tm):
            t = graph.Tensors(tm.TensorIndex())
            shape = [int(x) for x in t.ShapeAsNumpy()] if t.ShapeLength() else []
            magic = [x for x in shape if is_magic(x)]
            return f'{tm.Name().decode()} {TYPES.get(t.Type(), t.Type())} {shape}' + (f' magic={magic}' if magic else '')

        ins = [line(sig.Inputs(i)) for i in range(sig.InputsLength())]
        outs = [line(sig.Outputs(i)) for i in range(sig.OutputsLength())]
        key = sig.SignatureKey().decode()
        ops = collections.Counter()
        for o in range(graph.OperatorsLength()):
            code = model.OperatorCodes(graph.Operators(o).OpcodeIndex())
            b = max(code.BuiltinCode(), code.DeprecatedBuiltinCode())
            ops[code.CustomCode().decode() if code.CustomCode() else OPS.get(b, b)] += 1
        print(f'-- signature {key}: subgraph {sig.SubgraphIndex()}, {graph.OperatorsLength()} ops, {len(ins)} inputs, {len(outs)} outputs')
        # KV caches are many; show the non-cache tensors and a few caches.
        caches = [x for x in ins if x.startswith('kv_cache')]
        for x in [x for x in ins if not x.startswith('kv_cache')] + caches[:4] + (['...'] if len(caches) > 4 else []) + caches[-4:]:
            print('   in ', x)
        for x in [x for x in outs if not x.startswith('kv_cache')][:12]:
            print('   out', x)
        print('   ops', dict(ops.most_common(40)))
        shapes = collections.Counter(tuple(int(v) for v in graph.Tensors(sig.Inputs(i).TensorIndex()).ShapeAsNumpy())
                                     for i in range(sig.InputsLength()) if sig.Inputs(i).Name().decode().startswith('kv_cache'))
        print('   kv cache shapes', dict(shapes))


def main():
    path, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    litertlm_peek.peek_litertlm_file(path, out, sys.stdout)
    sys.stdout.flush()
    for name in sorted(os.listdir(out)):
        full = os.path.join(out, name)
        print('file', name, os.path.getsize(full))
    for name in sorted(os.listdir(out)):
        if name.endswith('.tflite'):
            try:
                describe_graph(os.path.join(out, name))
            except Exception as e:  # keep going for the other graphs
                print('could not read', name, e)
        sys.stdout.flush()


main()
