"""Reads what precision each weight of a .litertlm file is stored in.

For every TFLite section it counts each constant buffer once and groups it
by element type and quantization (per-tensor, per-channel, blockwise with its
block size), with the bits per weight measured from the stored bytes. It also
lists the weights that feed the matrix ops, the KV cache types of the decode
signature and the largest tensor families by name. Read-only: nothing is
converted or written back. Survey of Fielua's models, 2026-10-26.
"""
import collections
import io
import math
import mmap
import os
import re
import sys

import flatbuffers
import tflite

# The flatbuffer schema's TensorType (not the C runtime's TfLiteType).
TYPES = {0: 'FLOAT32', 1: 'FLOAT16', 2: 'INT32', 3: 'UINT8', 4: 'INT64', 5: 'STRING', 6: 'BOOL',
         7: 'INT16', 8: 'COMPLEX64', 9: 'INT8', 10: 'FLOAT64', 11: 'COMPLEX128', 12: 'UINT64',
         13: 'RESOURCE', 14: 'VARIANT', 15: 'UINT32', 16: 'UINT16', 17: 'INT4', 18: 'BFLOAT16'}
OPS = {getattr(tflite.BuiltinOperator, n): n for n in dir(tflite.BuiltinOperator) if n.isupper()}
MIN_BYTES = int(os.environ.get('SURVEY_MIN_BYTES', 100_000))
MIN_FAMILY_ELEMENTS = int(os.environ.get('SURVEY_MIN_FAMILY_ELEMENTS', 1 << 20))
MATRIX_OPS = {'FULLY_CONNECTED', 'EMBEDDING_LOOKUP', 'BATCH_MATMUL', 'CONV_2D', 'DEPTHWISE_CONV_2D',
              'DEQUANTIZE', 'GATHER'}


def type_name(t):
    return TYPES.get(t, f'TYPE{t}')


def quant_kind(tensor, graph):
    q = tensor.Quantization()
    if q is None:
        return 'none'
    if q.DetailsType() == 2:  # BlockwiseQuantization {scales, zero_points, block_size}
        tab = q.Details()
        fields = []
        for slot in (4, 6, 8):
            o = tab.Offset(slot)
            fields.append(tab.Get(flatbuffers.number_types.Int32Flags, o + tab.Pos) if o else None)
        scales, zero_points, block = fields
        scale_type = type_name(graph.Tensors(scales).Type()) if scales is not None and scales >= 0 else '?'
        return f'blockwise(block={block}, scales={scale_type}, zp={"yes" if zero_points not in (None, -1) else "no"})'
    if q.DetailsType() != 0:
        return f'details{q.DetailsType()}'
    n = q.ScaleLength()
    if n > 1:
        return f'per-channel(axis={q.QuantizedDimension()})'
    if n == 1:
        return 'per-tensor'
    return 'none'


def elements(tensor):
    if not tensor.ShapeLength():
        return 1
    return int(math.prod(int(x) for x in tensor.ShapeAsNumpy()))


def describe(path):
    with open(path, 'rb') as f:
        buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    model = tflite.Model.GetRootAsModel(buf, 0)
    sizes = []
    for i in range(model.BuffersLength()):
        b = model.Buffers(i)
        sizes.append(b.Size() if b.Offset() > 1 else b.DataLength())
    totals = collections.defaultdict(lambda: [0, 0, 0])  # bytes, elements, tensors
    families = collections.defaultdict(lambda: [0, 0])
    matrix = collections.Counter()
    seen = set()
    for s in range(model.SubgraphsLength()):
        graph = model.Subgraphs(s)
        for t in range(graph.TensorsLength()):
            tensor = graph.Tensors(t)
            bi = tensor.Buffer()
            if bi <= 0 or bi in seen or bi >= len(sizes) or sizes[bi] == 0:
                continue
            seen.add(bi)
            n = elements(tensor)
            key = (type_name(tensor.Type()), quant_kind(tensor, graph))
            totals[key][0] += sizes[bi]
            totals[key][1] += n
            totals[key][2] += 1
            if n >= MIN_FAMILY_ELEMENTS:
                name = re.sub(r'\d+', '#', (tensor.Name() or b'').decode(errors='replace'))[:90]
                families[(name,) + key][0] += sizes[bi]
                families[(name,) + key][1] += 1
        for o in range(graph.OperatorsLength()):
            op = graph.Operators(o)
            code = model.OperatorCodes(op.OpcodeIndex())
            b = max(code.BuiltinCode(), code.DeprecatedBuiltinCode())
            name = OPS.get(b, str(b))
            if name not in MATRIX_OPS:
                continue
            for k in range(op.InputsLength()):
                ti = op.Inputs(k)
                if ti < 0:
                    continue
                tensor = graph.Tensors(ti)
                bi = tensor.Buffer()
                if bi > 0 and bi < len(sizes) and sizes[bi] > 0:
                    matrix[(name, k, type_name(tensor.Type()), quant_kind(tensor, graph))] += 1
    all_bytes = sum(v[0] for v in totals.values())
    print(f'\n=== {os.path.basename(path)}: {len(buf) / 1e6:.1f} MB, constant data {all_bytes / 1e6:.1f} MB')
    print('  by type and quantization (bytes, share, bits per element, tensors):')
    for key, (nbytes, n, count) in sorted(totals.items(), key=lambda kv: -kv[1][0]):
        if nbytes < MIN_BYTES:
            continue
        print(f'    {key[0]:9} {key[1]:58} {nbytes / 1e6:10.1f} MB {100 * nbytes / all_bytes:5.1f}%  '
              f'{8 * nbytes / max(n, 1):5.2f} bits  {count} tensors')
    print('  constant inputs of matrix ops (op, input, type, quantization: count):')
    for key, count in sorted(matrix.items(), key=lambda kv: -kv[1])[:30]:
        print(f'    {key[0]}[{key[1]}] {key[2]} {key[3]}: {count}')
    print('  largest tensor families (name with digits as #):')
    for key, (nbytes, count) in sorted(families.items(), key=lambda kv: -kv[1][0])[:45]:
        print(f'    {nbytes / 1e6:9.1f} MB x{count:<4} {key[1]:8} {key[2]:50} {key[0]}')
    for s in range(model.SignatureDefsLength()):
        sig = model.SignatureDefs(s)
        graph = model.Subgraphs(sig.SubgraphIndex())
        kv = collections.Counter()
        for i in range(sig.InputsLength()):
            tm = sig.Inputs(i)
            if tm.Name().decode().startswith('kv_cache'):
                t = graph.Tensors(tm.TensorIndex())
                kv[(type_name(t.Type()), tuple(int(x) for x in t.ShapeAsNumpy()))] += 1
        outs = []
        for i in range(sig.OutputsLength()):
            tm = sig.Outputs(i)
            if tm.Name().decode() in ('logits', 'activations', 'features', 'embeddings'):
                t = graph.Tensors(tm.TensorIndex())
                outs.append(f'{tm.Name().decode()} {type_name(t.Type())}')
        print(f'  signature {sig.SignatureKey().decode()}: kv {dict(kv)} outputs {outs}')
    sys.stdout.flush()


def main():
    from litert_lm_builder import litertlm_peek
    path, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    header = io.StringIO()
    litertlm_peek.peek_litertlm_file(path, out, header)
    for line in header.getvalue().splitlines():
        if 'jinja_prompt_template' in line or 'prefill_input_name' in line or 'prefill_output_name' in line \
                or 'decode_input_name' in line or 'decode_output_name' in line:
            continue
        print(line[:300])
    for name in sorted(os.listdir(out)):
        print('file', name, os.path.getsize(os.path.join(out, name)))
    for name in sorted(os.listdir(out)):
        if name.endswith('.tflite'):
            try:
                describe(os.path.join(out, name))
            except Exception as e:  # keep going for the other graphs
                print('could not read', name, repr(e))


if __name__ == '__main__':
    if len(sys.argv) == 2:
        describe(sys.argv[1])
    else:
        main()
