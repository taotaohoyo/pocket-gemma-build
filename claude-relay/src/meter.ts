// What a reply cost, read off Anthropic's event stream as it passes
// through: the usage in message_start and message_delta, nothing of the
// text itself (a stopped reply's unfinished part is counted by its
// length, as an estimate). And the files code execution made, and the
// container they are in, so only the person who asked can download them.
// The events reach the app unchanged.

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

export function meter(source: ReadableStream<Uint8Array>, requestedModel: string, signal?: AbortSignal): Metered {
  const decoder = new TextDecoder();
  let pending = "";
  let event = "";
  let model = requestedModel;
  const usage: Usage = {};
  let finalOutput: number | null = null;
  let deltaText = "";
  let settled = false;
  let settle: (micros: number) => void = () => {};
  const cost = new Promise<number>((resolve) => (settle = resolve));
  let settleOutputs: (outputs: Outputs) => void = () => {};
  const outputs = new Promise<Outputs>((resolve) => (settleOutputs = resolve));
  const made: Outputs = { container: null, files: [] };

  const finish = () => {
    if (settled) return;
    settled = true;
    const output = finalOutput ?? Math.max(usage.output_tokens ?? 0, estimateTokens(deltaText));
    settle(costMicros(model, { ...usage, output_tokens: output }));
    settleOutputs(made);
  };
  const containerOf = (value: unknown) => {
    const id = (value as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string" && OUTPUT_ID.test(id)) made.container = id;
  };

  const line = (text: string) => {
    if (text.startsWith("event:")) {
      event = text.slice(6).trim();
      return;
    }
    if (!text.startsWith("data:")) return;
    // A code execution result arrives whole in its block's start: only those are read, for their file ids.
    if (event === "content_block_start") {
      if (!text.includes("code_execution_tool_result")) return;
      try {
        fileIDs((JSON.parse(text.slice(5)) as { content_block?: unknown }).content_block, made.files);
      } catch { /* not ours to judge */ }
      return;
    }
    if (event !== "message_start" && event !== "message_delta" && event !== "content_block_delta") return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text.slice(5)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === "message_start") {
      const message = data.message as { model?: unknown; usage?: Usage; container?: unknown } | undefined;
      if (typeof message?.model === "string") model = message.model;
      Object.assign(usage, message?.usage ?? {});
      containerOf(message?.container);
    } else if (event === "message_delta") {
      const delta = data.usage as Usage | undefined;
      if (delta) {
        // message_delta's counts are the totals so far.
        for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
          if (typeof delta[key] === "number") usage[key] = delta[key];
        }
        if (typeof delta.output_tokens === "number") finalOutput = delta.output_tokens;
        if (delta.server_tool_use) usage.server_tool_use = delta.server_tool_use;
      }
      containerOf((data.delta as { container?: unknown } | undefined)?.container);
      containerOf(data.container);
    } else if (finalOutput === null && deltaText.length < 2_000_000) {
      const delta = data.delta as { text?: unknown; thinking?: unknown } | undefined;
      if (typeof delta?.text === "string") deltaText += delta.text;
      if (typeof delta?.thinking === "string") deltaText += delta.thinking;
    }
  };

  const feed = (chunk: Uint8Array | null) => {
    pending += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      line(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
    }
    if (!chunk && pending) {
      line(pending);
      pending = "";
    }
  };

  signal?.addEventListener("abort", finish, { once: true });
  // Pulled by the app's connection, so a stopped reply cancels Anthropic's
  // stream (and so its request) and is counted, whichever side stops.
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        finish();
        controller.error(error);
        return;
      }
      if (next.done) {
        try { feed(null); } catch {}
        finish();
        controller.close();
        return;
      }
      controller.enqueue(next.value);
      try {
        feed(next.value);
      } catch {
        // Counting never stands in the reply's way.
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return { body, cost, outputs };
}
