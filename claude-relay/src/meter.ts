// What a reply cost, read off Anthropic's event stream: the usage in
// message_start and message_delta (a stopped reply's unfinished part is
// counted by its length, as an estimate). And the files code execution
// made, and the container they are in, so only the person who asked can
// download them. The events reach the app unchanged.
//
// The stream is split in two (tee): one copy goes to the app as it comes,
// with no code of the relay's in its way; the other is gathered by the
// runtime itself and read once, when the reply ends. Reading every event
// as it passed cost CPU for each piece of a long reply, more than
// Cloudflare's free plan gives a request (10 ms).

import { costMicros, type Usage } from "./claude";

export interface Metered {
  /** The stream to send on: the same bytes as Anthropic's. */
  body: ReadableStream<Uint8Array>;
  /** Settles once the reply ended or was stopped, with what it cost (millionths of a dollar). */
  cost: Promise<number>;
  /** Settles with it: the container the reply's code ran in, and the files it made. */
  outputs: Promise<Outputs>;
}

export interface Outputs {
  container: string | null;
  files: string[];
}

/** Ids Anthropic gives files and containers: letters, digits, _ and -. */
export const OUTPUT_ID = /^[A-Za-z0-9_-]{6,128}$/;

/** Every file_id in a code execution result block (bash or text editor), however deep. */
export function fileIDs(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) fileIDs(item, found, depth + 1);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "file_id" && typeof item === "string" && OUTPUT_ID.test(item) && !found.includes(item)) found.push(item);
    else if (typeof item === "object") fileIDs(item, found, depth + 1);
  }
  return found;
}

/** Tokens for text the stream never gave a count for: about 4 letters of English, or 1 Japanese character, each. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other);
}

const decoder = new TextDecoder();

/**
 * The second copy of the reply, whole, or as far as it came when the app
 * stopped it (`signal`). In Cloudflare's runtime the copy is gathered
 * natively (IdentityTransformStream); elsewhere (the tests) in JavaScript.
 */
export async function gather(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  const Identity = (globalThis as { IdentityTransformStream?: typeof IdentityTransformStream }).IdentityTransformStream;
  if (Identity) {
    const pass = new Identity();
    const whole = new Response(pass.readable).arrayBuffer();
    try {
      await stream.pipeTo(pass.writable, { signal, preventAbort: true });
    } catch {
      // Stopped or broken: what came is kept.
      try { await pass.writable.close(); } catch { /* already closed */ }
    }
    return new Uint8Array(await whole);
  }
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  const stop = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      length += next.value.length;
    }
  } catch { /* stopped or broken: what came is kept */ }
  signal?.removeEventListener("abort", stop);
  const whole = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  return whole;
}

/** The data line of the event that starts at `at` in `text`, parsed; null if it isn't one. */
function dataAfter(text: string, at: number): Record<string, unknown> | null {
  const line = text.indexOf("\ndata:", at);
  if (line < 0) return null;
  const end = text.indexOf("\n", line + 1);
  try {
    return JSON.parse(text.slice(line + 6, end < 0 ? text.length : end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** What the gathered reply cost, and what its code made. */
export function readReply(bytes: Uint8Array, requestedModel: string, wantOutputs = true): { micros: number; outputs: Outputs } {
  const outputs: Outputs = { container: null, files: [] };
  const containerOf = (value: unknown) => {
    const id = (value as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string" && OUTPUT_ID.test(id)) outputs.container = id;
  };
  // Only the start and the end are read, unless code ran (its files may be anywhere) or the reply was cut.
  const head = decoder.decode(bytes.subarray(0, 16 * 1024));
  const tail = bytes.length > 64 * 1024 ? decoder.decode(bytes.subarray(bytes.length - 48 * 1024)) : null;
  let whole: string | null = tail === null ? decoder.decode(bytes) : null;
  const all = () => (whole ??= decoder.decode(bytes));

  let model = requestedModel;
  const usage: Usage = {};
  const startAt = head.indexOf("event: message_start");
  const start = startAt >= 0 ? dataAfter(head, startAt) : null;
  const message = start?.message as { model?: unknown; usage?: Usage; container?: unknown } | undefined;
  if (typeof message?.model === "string") model = message.model;
  Object.assign(usage, message?.usage ?? {});
  containerOf(message?.container);

  // message_delta's counts are the totals so far: the last one says it all.
  const end = tail ?? all();
  const deltaAt = end.lastIndexOf("event: message_delta");
  const delta = deltaAt >= 0 ? dataAfter(end, deltaAt) : null;
  let output: number | null = null;
  if (delta) {
    const counts = delta.usage as Usage | undefined;
    if (counts) {
      for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
        if (typeof counts[key] === "number") usage[key] = counts[key];
      }
      if (typeof counts.output_tokens === "number") output = counts.output_tokens;
      if (counts.server_tool_use) usage.server_tool_use = counts.server_tool_use;
    }
    containerOf((delta.delta as { container?: unknown } | undefined)?.container);
    containerOf(delta.container);
  }

  // A code execution result arrives whole in its block's start: only those lines are read, for their file ids.
  const full = wantOutputs || output === null ? all() : "";
  for (let at = full.indexOf("code_execution_tool_result"); at >= 0; at = full.indexOf("code_execution_tool_result", at + 1)) {
    const lineStart = full.lastIndexOf("\n", at) + 1;
    const lineEnd = full.indexOf("\n", at);
    const line = full.slice(lineStart, lineEnd < 0 ? full.length : lineEnd);
    if (line.startsWith("data:") && line.includes('"content_block_start"')) {
      try { fileIDs((JSON.parse(line.slice(5)) as { content_block?: unknown }).content_block, outputs.files); } catch { /* not ours to judge */ }
    }
    if (lineEnd < 0) break;
    at = lineEnd;
  }
  if (output === null) {
    // Stopped before Anthropic said how long it was: the text and thinking that came, estimated.
    let written = "";
    for (let at = full.indexOf("event: content_block_delta"); at >= 0; at = full.indexOf("event: content_block_delta", at + 1)) {
      const line = full.indexOf("\ndata:", at);
      if (line < 0) break;
      const lineEnd = full.indexOf("\n", line + 1);
      const data = full.slice(line + 6, lineEnd < 0 ? full.length : lineEnd).trimEnd();
      if (data.includes('"text_delta"') || data.includes('"thinking_delta"')) {
        const value = data.lastIndexOf('":"');
        if (value >= 0) written += data.slice(value + 3, data.length - (data.endsWith('"}}') ? 3 : data.endsWith('"}') ? 2 : 0));
      }
      if (written.length > 2_000_000 || lineEnd < 0) break;
      at = lineEnd;
    }
    output = Math.max(usage.output_tokens ?? 0, estimateTokens(written));
  }
  return { micros: costMicros(model, { ...usage, output_tokens: output }), outputs };
}

/**
 * `wantOutputs`: code could run (files on), so the whole reply is searched for the files it made.
 * `kept`: a reply of /v1/replies (reply.ts), which the app's connection doesn't end: its stop is
 * `signal` alone, and the app's copy is passed on as the runtime split it, for the keeper to split
 * again. (In workerd a split IdentityTransformStream can't be piped on: "Inter-TransformStream
 * ReadableStream.pipeTo() is not implemented", and that copy is then never read nor let go.)
 */
export function meter(source: ReadableStream<Uint8Array>, requestedModel: string, signal?: AbortSignal, wantOutputs = true, kept = false): Metered {
  const [toApp, copy] = source.tee();
  // The copy ends when the app's connection does (the request's signal, or
  // its copy cancelled): both copies gone, the request to Anthropic ends too.
  const stop = new AbortController();
  signal?.addEventListener("abort", () => stop.abort(), { once: true });
  let body = toApp;
  const Identity = (globalThis as { IdentityTransformStream?: typeof IdentityTransformStream }).IdentityTransformStream;
  if (Identity && !kept) {
    const pass = new Identity();
    toApp.pipeTo(pass.writable).catch(() => stop.abort());
    body = pass.readable;
  }
  const read = gather(copy, stop.signal).then((bytes) => readReply(bytes, requestedModel, wantOutputs));
  return { body, cost: read.then((result) => result.micros), outputs: read.then((result) => result.outputs) };
}
