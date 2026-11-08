// A reply as the relay passes on Anthropic's event stream, read as the
// iPhone app reads it (PocketCore/ClaudeLink.swift ClaudeStreamEvent):
// only the `data:` lines count; the thinking, a summary, is never shown.
// And the pace its text is laid out at (PocketCore/ReplyPacer.swift).

import { tableHeadEnd, wholeSyntax } from "./mdsource.js";

/** One `data:` line's event, or null for anything else. */
export function streamEvent(line) {
  if (line.startsWith(":")) return { type: "alive" };
  if (!line.startsWith("data:")) return null;
  let object;
  try {
    object = JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
  switch (object?.type) {
    case "message_start": return { type: "started", model: object.message?.model ?? "" };
    case "content_block_start": {
      const block = object.content_block ?? {};
      if (block.type === "thinking" || block.type === "redacted_thinking") return { type: "thinking" };
      if (block.type === "text" && block.text) return { type: "text", text: block.text };
      return { type: "alive" };
    }
    case "content_block_delta": {
      const delta = object.delta ?? {};
      if (delta.type === "text_delta") return { type: "text", text: delta.text ?? "" };
      if (delta.type === "thinking_delta" || delta.type === "signature_delta") return { type: "thinking" };
      return { type: "alive" };
    }
    case "message_delta": {
      const reason = object.delta?.stop_reason;
      if (reason === "refusal") return { type: "refused" };
      if (reason === "max_tokens") return { type: "cutOff" };
      return { type: "alive" };
    }
    case "message_stop": return { type: "done" };
    case "error": return { type: "failed", error: object.error?.type ?? "api_error" };
    default: return { type: "alive" };
  }
}

/** The events of a streamed response body, as they come. */
export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const event = streamEvent(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const event = streamEvent(buffer.replace(/\r$/, ""));
      if (event) yield event;
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * How much of the reply shows: unhurried, a share of the model's speed,
 * yet never so far behind that the backlog outgrows two seconds; after
 * the end, on at the pace it had. A table's head is taken whole, and a
 * step never ends inside Markdown or LaTeX syntax.
 */
export class Pacer {
  static relaxation = 0.75;
  static rateWindow = 2.5;
  static drainLag = 2.0;
  static lagWhileWriting = 1.0;
  static slowestWhileWriting = 12;
  static slowestAfterEnd = 15;
  static paceSmoothing = 0.3;
  static paceSmoothingAfterEnd = 0.35;
  static longestStep = 0.15;

  constructor() {
    this.text = "";
    this.shown = 0;
    this.generating = true;
    this.pace = 0;
    this.carry = 0;
    this.arrivals = [];
    this.paceAtEnd = null;
    this.lastTick = null;
  }

  /** The length shown after a step at `now` (seconds). */
  advance(now) {
    const elapsed = Math.min(Math.max(now - (this.lastTick ?? now), 0), Pacer.longestStep);
    this.lastTick = now;
    const total = this.text.length;
    if (this.shown > total) { this.shown = total; this.carry = 0; return this.shown; }
    if (total > 0 && this.arrivals[this.arrivals.length - 1]?.count !== total) this.arrivals.push({ at: now, count: total });
    const backlog = total - this.shown;
    const modelPace = this.rate(now, total);
    const unhurried = Math.max(Pacer.relaxation * modelPace, backlog / Pacer.drainLag);
    let target;
    if (this.generating) {
      this.paceAtEnd = null;
      target = Math.max(Pacer.slowestWhileWriting, Math.min(backlog / Pacer.lagWhileWriting, unhurried));
    } else {
      const kept = this.paceAtEnd ?? this.pace;
      this.paceAtEnd = kept;
      target = Math.max(Pacer.slowestAfterEnd, kept, unhurried);
    }
    if (this.pace === 0) this.pace = target;
    else this.pace += (target - this.pace) * (1 - Math.exp(-elapsed / (this.generating ? Pacer.paceSmoothing : Pacer.paceSmoothingAfterEnd)));
    if (backlog <= 0) { this.carry = 0; return this.shown; }
    this.carry += this.pace * elapsed;
    const step = Math.min(Math.floor(this.carry), backlog);
    if (step <= 0) return this.shown;
    const end = Math.min(tableHeadEnd(this.text, wholeSyntax(this.text, this.shown + step)), total);
    if (end <= this.shown) return this.shown;
    this.carry = step < backlog ? this.carry - step : 0;
    this.shown = end;
    return this.shown;
  }

  rate(now, total) {
    while (this.arrivals.length >= 2 && this.arrivals[1].at <= now - Pacer.rateWindow) this.arrivals.shift();
    const base = this.arrivals[0];
    if (!base || now <= base.at) return 0;
    return Math.max(total - base.count, 0) / (now - base.at);
  }

  get finished() {
    return !this.generating && this.shown >= this.text.length;
  }
}
