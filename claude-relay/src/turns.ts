// What the app may send for a reply: the chat's text turns, and which of
// the relay's models and reasoning levels should answer (claude.ts checks
// those). Limits, the system prompt and every other parameter are the
// relay's own; anything else in the body is ignored.

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export const LIMITS = {
  /** The app sends at most 40 (ClaudeContext); a little room above it. */
  maxTurns: 60,
  /** One turn's text, in UTF-8 bytes. */
  maxTurnBytes: 64 * 1024,
  /** All the turns together. */
  maxTotalBytes: 192 * 1024,
  /** The request body as read off the wire. */
  maxBodyBytes: 256 * 1024,
};

export type TurnsResult = { ok: true; turns: Turn[] } | { ok: false; error: "bad_request" | "too_large" };

const encoder = new TextEncoder();

/** The turns of a request body: user first and last, user and assistant in turn, no empty text. */
export function parseTurns(body: unknown): TurnsResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "bad_request" };
  if (messages.length > LIMITS.maxTurns) return { ok: false, error: "too_large" };
  const turns: Turn[] = [];
  let total = 0;
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "object" || message === null) return { ok: false, error: "bad_request" };
    const { role, content } = message as { role?: unknown; content?: unknown };
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected || typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, error: "bad_request" };
    }
    const bytes = encoder.encode(content).length;
    total += bytes;
    if (bytes > LIMITS.maxTurnBytes || total > LIMITS.maxTotalBytes) return { ok: false, error: "too_large" };
    turns.push({ role: expected, content });
  }
  if (turns[turns.length - 1]!.role !== "user") return { ok: false, error: "bad_request" };
  return { ok: true, turns };
}

/** The body as JSON, refusing one larger than LIMITS.maxBodyBytes however it is sent. */
export async function readJSON(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: "bad_request" | "too_large" }> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > LIMITS.maxBodyBytes) return { ok: false, error: "too_large" };
  if (!request.body) return { ok: false, error: "bad_request" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.maxBodyBytes) {
      await reader.cancel();
      return { ok: false, error: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return { ok: false, error: "bad_request" };
  }
}
