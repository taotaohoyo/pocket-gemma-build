// What the app may send for a reply: the chat's turns, with the photos,
// PDFs and text files the person attached to their own turns, and which of
// the relay's models and reasoning levels should answer (claude.ts checks
// those). The relay builds every content block itself from what it checked
// here: the app never sends Anthropic's blocks, URLs or file ids, only the
// bytes of what was attached. Limits, the system prompt and every other
// parameter are the relay's own; anything else in the body is ignored.

export type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageType; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string }
  | { type: "document"; source: { type: "text"; media_type: "text/plain"; data: string }; title?: string };

export interface Turn {
  role: "user" | "assistant";
  /** Text only, or (a user turn with attachments) the attachments and then the text. */
  content: string | Block[];
}

export const LIMITS = {
  /** The app sends at most 40 (ClaudeContext); a little room above it. */
  maxTurns: 60,
  /** One turn's typed text, in UTF-8 bytes. */
  maxTurnBytes: 64 * 1024,
  /** All the turns' typed text together. */
  maxTotalBytes: 192 * 1024,
  /** Attachments on one turn. */
  maxAttachmentsPerTurn: 40,
  /** Images in the whole request (Anthropic takes 100 on its smaller-context models). */
  maxImages: 100,
  /** PDFs and text files in the whole request. */
  maxDocuments: 20,
  /** One attached text file, in UTF-8 bytes. */
  maxTextFileBytes: 256 * 1024,
  /** All the attached text files together. */
  maxTextFilesBytes: 512 * 1024,
  /** A file name or a caption, in characters. */
  maxLabel: 200,
};

/** How much may be attached to one request: the Worker's ATTACHMENT_MB, 3 MB unless set. */
export interface AttachmentLimits {
  /** All the attached images and PDFs together, as base64. */
  chars: number;
  /** One image, as base64 (Anthropic takes up to 10 MB). */
  imageChars: number;
  /** The request body as read off the wire: the attachments, the text, and room for JSON. */
  bodyBytes: number;
}

/**
 * Cloudflare's free plan gives one request 10 ms of CPU, and the relay
 * spends about 3 ms on each MB it checks and passes on: 3 MB is the most
 * that fits there. On Workers Paid (30 s) it can be 20; a Worker has
 * 128 MB of memory and holds the body about three times over.
 */
export function attachmentLimits(env: { ATTACHMENT_MB?: string }): AttachmentLimits {
  const mb = Number.parseFloat(env.ATTACHMENT_MB ?? "");
  const chars = Math.round((Number.isFinite(mb) && mb > 0 ? Math.min(mb, 24) : 3) * 1024 * 1024);
  return { chars, imageChars: Math.min(chars, 8 * 1024 * 1024), bodyBytes: chars + 1024 * 1024 };
}

export type TurnsResult = { ok: true; turns: Turn[] } | { ok: false; error: "bad_request" | "too_large" | "bad_attachment" };

const encoder = new TextEncoder();
const IMAGE_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Looking for a character that doesn't belong is about six times faster
// than matching the whole text, and the relay's CPU time is short.
const NOT_BASE64 = /[^A-Za-z0-9+/=]/;

/** The first bytes of base64 data, to see that a file is what it says it is. */
function head(data: string): Uint8Array {
  const text = atob(data.slice(0, 24));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** A JPEG, PNG, GIF or WebP by its own first bytes, whatever the app called it. */
function matchesImage(type: string, data: string): boolean {
  const b = head(data);
  switch (type) {
    case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    case "image/gif": return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
    case "image/webp": return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    default: return false;
  }
}

function isPDF(data: string): boolean {
  const b = head(data);
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // %PDF-
}

/** Base64 text only: the relay places it into the request to Anthropic as it is (claude.ts). */
export function isBase64(data: unknown, maxChars: number): data is string {
  if (typeof data !== "string" || data.length < 16 || data.length > maxChars || data.length % 4 !== 0) return false;
  const padding = data.indexOf("=");
  if (padding !== -1 && padding < data.length - 2) return false;
  return !NOT_BASE64.test(data);
}

/** A file name or caption as text: no control characters, no longer than the limit. */
export function cleanLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim()).slice(0, LIMITS.maxLabel).join("");
}

interface Counts { images: number; documents: number; textBytes: number; chars: number }

/** One attachment as content blocks (a caption, then the image or document), or why not. */
function attachmentBlocks(raw: unknown, counts: Counts, limits: AttachmentLimits): Block[] | "bad_attachment" | "too_large" {
  if (typeof raw !== "object" || raw === null) return "bad_attachment";
  const a = raw as { type?: unknown; mediaType?: unknown; data?: unknown; text?: unknown; name?: unknown; caption?: unknown };
  const blocks: Block[] = [];
  const caption = cleanLabel(a.caption);
  if (caption) blocks.push({ type: "text", text: caption });
  const name = cleanLabel(a.name);
  switch (a.type) {
    case "image": {
      if (typeof a.mediaType !== "string" || !IMAGE_TYPES.has(a.mediaType)) return "bad_attachment";
      if (typeof a.data === "string" && a.data.length > limits.imageChars) return "too_large";
      if (!isBase64(a.data, limits.imageChars) || !matchesImage(a.mediaType, a.data)) return "bad_attachment";
      counts.chars += a.data.length;
      if (++counts.images > LIMITS.maxImages || counts.chars > limits.chars) return "too_large";
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType as ImageType, data: a.data } });
      return blocks;
    }
    case "pdf": {
      if (typeof a.data === "string" && a.data.length > limits.chars) return "too_large";
      if (!isBase64(a.data, limits.chars) || !isPDF(a.data)) return "bad_attachment";
      counts.chars += a.data.length;
      if (++counts.documents > LIMITS.maxDocuments || counts.chars > limits.chars) return "too_large";
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data }, ...(name ? { title: name } : {}) });
      return blocks;
    }
    case "text": {
      if (typeof a.text !== "string" || a.text.trim().length === 0) return "bad_attachment";
      const size = encoder.encode(a.text).length;
      counts.textBytes += size;
      if (size > LIMITS.maxTextFileBytes || counts.textBytes > LIMITS.maxTextFilesBytes) return "too_large";
      if (++counts.documents > LIMITS.maxDocuments) return "too_large";
      blocks.push({ type: "document", source: { type: "text", media_type: "text/plain", data: a.text }, ...(name ? { title: name } : {}) });
      return blocks;
    }
    default:
      return "bad_attachment";
  }
}

/** The turns of a request body: user first and last, user and assistant in turn, no empty turn. */
export function parseTurns(body: unknown, limits: AttachmentLimits = attachmentLimits({})): TurnsResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "bad_request" };
  if (messages.length > LIMITS.maxTurns) return { ok: false, error: "too_large" };
  const turns: Turn[] = [];
  const counts: Counts = { images: 0, documents: 0, textBytes: 0, chars: 0 };
  let total = 0;
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "object" || message === null) return { ok: false, error: "bad_request" };
    const { role, content, attachments } = message as { role?: unknown; content?: unknown; attachments?: unknown };
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected || typeof content !== "string") return { ok: false, error: "bad_request" };
    const bytes = encoder.encode(content).length;
    total += bytes;
    if (bytes > LIMITS.maxTurnBytes || total > LIMITS.maxTotalBytes) return { ok: false, error: "too_large" };
    if (attachments === undefined || (Array.isArray(attachments) && attachments.length === 0)) {
      if (content.trim().length === 0) return { ok: false, error: "bad_request" };
      turns.push({ role: expected, content });
      continue;
    }
    // Only the person's own turns carry what they attached.
    if (expected !== "user" || !Array.isArray(attachments)) return { ok: false, error: "bad_request" };
    if (attachments.length > LIMITS.maxAttachmentsPerTurn) return { ok: false, error: "too_large" };
    const blocks: Block[] = [];
    for (const attachment of attachments) {
      const made = attachmentBlocks(attachment, counts, limits);
      if (typeof made === "string") return { ok: false, error: made };
      blocks.push(...made);
    }
    if (content.trim().length > 0) blocks.push({ type: "text", text: content });
    turns.push({ role: expected, content: blocks });
  }
  if (turns[turns.length - 1]!.role !== "user") return { ok: false, error: "bad_request" };
  return { ok: true, turns };
}

/**
 * The body as JSON, refusing one larger than `maxBytes` however it is
 * sent. Read straight into one buffer when the size is known, so a large
 * body is held once while it is read.
 */
export async function readJSON(request: Request, maxBytes = 256 * 1024): Promise<{ ok: true; value: unknown } | { ok: false; error: "bad_request" | "too_large" }> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) return { ok: false, error: "too_large" };
  if (!request.body) return { ok: false, error: "bad_request" };
  const reader = request.body.getReader();
  let buffer = new Uint8Array(declared > 0 ? declared : 64 * 1024);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      await reader.cancel();
      return { ok: false, error: "too_large" };
    }
    if (size + value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(buffer.byteLength * 2, size + value.byteLength)));
      grown.set(buffer.subarray(0, size));
      buffer = grown;
    }
    buffer.set(value, size);
    size += value.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size));
  } catch {
    return { ok: false, error: "bad_request" };
  }
  buffer = new Uint8Array(0);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "bad_request" };
  }
}
