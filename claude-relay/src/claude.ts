// The one call to Anthropic: the chat's turns go to the Messages API with
// the model and reasoning level the person chose from the relay's catalog,
// streamed back as Anthropic sends them.

import Anthropic from "@anthropic-ai/sdk";
import type { Block, Turn } from "./turns";

export interface ClaudeConfig {
  apiKey: string;
  /** The model a request gets when the app names none (CLAUDE_MODEL, if it is in the catalog). */
  model: string;
  /** The most a reply may be, whatever its effort (CLAUDE_MAX_TOKENS). */
  maxTokens: number;
  /**
   * Anthropic's API, or a local stand-in (http://127.0.0.1 or localhost)
   * for the relay's own tests; any other ANTHROPIC_BASE_URL is ignored, so
   * the key can't be sent elsewhere by a mistyped variable.
   */
  baseURL: string;
}

/** The reasoning levels Fielua offers: 低, 中, 高, 超高. Never "max". */
export type Effort = "low" | "medium" | "high" | "xhigh";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

export interface ModelInfo {
  id: string;
  name: string;
  efforts: readonly Effort[];
  /** Anthropic's own default for the model. */
  defaultEffort: Effort;
  /** Takes the server-side fallback on a refusal (Claude Haiku 5.5 has none). */
  fallback: boolean;
}

/**
 * The models a person may choose, in the order Fielua shows them (Opus 5.5
 * first: Fielua's top choice is Opus 5.5 at 超高). Checked against
 * Anthropic's models overview and effort pages on 2026-11-06: every one
 * takes low to max; Fielua leaves max out. Anything not here is refused.
 */
export const MODELS: readonly ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: EFFORTS, defaultEffort: "medium", fallback: true },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: EFFORTS, defaultEffort: "high", fallback: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: EFFORTS, defaultEffort: "high", fallback: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: EFFORTS, defaultEffort: "medium", fallback: false },
];

export const DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * List prices in US dollars per million tokens, as Anthropic's pricing
 * page gave them on 2026-11-08 (the skill's model table, cached
 * 2026-10-06). Used only for the estimate of the credit left: Anthropic
 * has no API for the balance itself. A 5-minute cache write costs 1.25
 * times the input price. Claude Haiku 5.5 costs more past 100K input.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  long?: { above: number; input: number; output: number; cacheRead: number };
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** What a reply cost, in millionths of a dollar (tokens times the price per million tokens). */
export function costMicros(model: string, usage: Usage): number {
  const price = PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const rates = price.long && input + written + read > price.long.above ? price.long : price;
  return Math.round(input * rates.input + written * rates.input * 1.25 + read * rates.cacheRead + output * rates.output);
}

export function modelInfo(id: string): ModelInfo | undefined {
  return MODELS.find((model) => model.id === id);
}

export function modelName(model: string): string {
  return modelInfo(model)?.name ?? model;
}

/** Room for a reply at each level: thinking counts against max_tokens, and more effort thinks longer. */
const EFFORT_TOKENS: Record<Effort, number> = { low: 16000, medium: 32000, high: 64000, xhigh: 64000 };

/** What one request asks Anthropic for: a model from the catalog, one of its levels, and the room that level needs. */
export interface ReplyChoice {
  model: ModelInfo;
  effort: Effort;
  maxTokens: number;
}

export type ChoiceResult = { ok: true; choice: ReplyChoice } | { ok: false; error: "unsupported_model" | "unsupported_effort" };

export type ChoiceError = "unsupported_model" | "unsupported_effort" | "model_unavailable";

/**
 * The app's choice, checked: an unknown model or level (max included) is
 * refused, never swapped for another. With what Anthropic says its
 * models can do now (`live`), a model it doesn't list, or a level the
 * model doesn't take, is refused too, before anything is sent.
 */
export function choose(cfg: ClaudeConfig, model: unknown, effort: unknown, live: LiveModels | null = null): ChoiceResult | { ok: false; error: ChoiceError } {
  const info = model === undefined || model === null ? modelInfo(cfg.model) : typeof model === "string" ? modelInfo(model) : undefined;
  if (!info) return { ok: false, error: "unsupported_model" };
  const now = live?.get(info.id);
  if (live && !now) return { ok: false, error: "model_unavailable" };
  const efforts = offeredEfforts(info, now);
  const level = effort === undefined || effort === null ? info.defaultEffort : efforts.find((e) => e === effort);
  if (!level || !efforts.includes(level)) return { ok: false, error: "unsupported_effort" };
  return { ok: true, choice: { model: info, effort: level, maxTokens: Math.min(EFFORT_TOKENS[level], cfg.maxTokens) } };
}

/** What Anthropic's Models API says a model can do now: its effort levels, or null when it doesn't say. */
export interface LiveModel {
  id: string;
  efforts: Effort[] | null;
}
export type LiveModels = Map<string, LiveModel>;

/** A model's levels: Fielua's, less any Anthropic says the model doesn't take now. */
export function offeredEfforts(info: ModelInfo, live: LiveModel | undefined): Effort[] {
  return live?.efforts ? info.efforts.filter((e) => live.efforts!.includes(e)) : [...info.efforts];
}

/** The catalog as the app sees it: `available` is null when Anthropic couldn't be asked. */
export function catalog(live: LiveModels | null) {
  return MODELS.map(({ id, name, defaultEffort }) => {
    const now = live?.get(id);
    const info = modelInfo(id)!;
    return { id, name, efforts: offeredEfforts(info, now), defaultEffort, available: live ? now !== undefined : null };
  });
}

const LIVE_FOR_MS = 30 * 60 * 1000;
const RETRY_AFTER_MS = 2 * 60 * 1000;
let liveCache: { at: number; base: string; value: LiveModels | null } | null = null;

/**
 * Anthropic's models and the effort levels each takes, from the Models
 * API (no tokens, no cost), kept for 30 minutes; null for 2 minutes when
 * it can't be reached, and the catalog stands unchecked.
 */
export async function liveModels(cfg: ClaudeConfig, now = Date.now()): Promise<LiveModels | null> {
  if (liveCache && liveCache.base === cfg.baseURL && now - liveCache.at < (liveCache.value ? LIVE_FOR_MS : RETRY_AFTER_MS)) return liveCache.value;
  let value: LiveModels | null = null;
  try {
    const client = new Anthropic({ apiKey: cfg.apiKey, authToken: null, baseURL: cfg.baseURL, maxRetries: 1, timeout: 10_000 });
    const found: LiveModels = new Map();
    for await (const model of client.models.list({ limit: 100 })) {
      const effort = model.capabilities?.effort;
      const efforts = effort ? (effort.supported ? EFFORTS.filter((level) => effort[level]?.supported === true) : []) : null;
      found.set(model.id, { id: model.id, efforts });
    }
    value = found;
  } catch (error) {
    console.error("models list failed", error instanceof Error ? error.name : "unknown");
  }
  liveCache = { at: now, base: cfg.baseURL, value };
  return value;
}

export function forgetLiveModels(): void {
  liveCache = null;
}

export function config(env: {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;
  ANTHROPIC_BASE_URL?: string;
}): ClaudeConfig | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const tokens = Number.parseInt(env.CLAUDE_MAX_TOKENS ?? "", 10);
  const base = env.ANTHROPIC_BASE_URL;
  return {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.CLAUDE_MODEL && modelInfo(env.CLAUDE_MODEL) ? env.CLAUDE_MODEL : DEFAULT_MODEL,
    maxTokens: Number.isFinite(tokens) ? Math.min(Math.max(tokens, 1024), 128000) : 64000,
    baseURL: base && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base) ? base : ANTHROPIC_API,
  };
}

/** What Claude is told about where it answers. No personal data, the same for everyone, so it caches. */
export const SYSTEM_PROMPT = [
  "You are Claude, made by Anthropic, answering through Fielua, a personal chat app on iPhone and on the web.",
  "Reply in the language the person writes in.",
  "Fielua shows Markdown: headings, lists, tables, code blocks, and LaTeX math between $ signs.",
  "Keep answers focused, and go into detail when the person asks for it.",
  "You see this conversation, with the photos, PDFs and text files the person attached to it.",
  "A video arrives as a few still frames, each captioned with its time, and without sound.",
  "You cannot see other chats or browse the web.",
].join(" ");

/**
 * Starts a streamed reply. Resolves with Anthropic's own server-sent
 * events once it has accepted the request; rejects with the SDK's typed
 * errors (Anthropic.APIError and its subclasses) before that. The events
 * are passed on untouched, so the relay spends next to no CPU on them,
 * and `signal` (the app's connection) ends the request at Anthropic too.
 */
export async function streamReply(cfg: ClaudeConfig, choice: ReplyChoice, turns: Turn[], userID: string, signal?: AbortSignal): Promise<Response> {
  // Everything explicit: the SDK would otherwise read ANTHROPIC_* from
  // process.env, which the Workers runtime fills with the Worker's vars.
  const client = new Anthropic({ apiKey: cfg.apiKey, authToken: null, baseURL: cfg.baseURL, maxRetries: 2, timeout: 10 * 60 * 1000 });
  const params = {
    model: choice.model.id,
    max_tokens: choice.maxTokens,
    stream: true as const,
    system: SYSTEM_PROMPT,
    messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    // Summaries of the thinking, not silence: a long think at 超高 keeps
    // the app's connection busy. Billed the same as hidden thinking.
    thinking: { type: "adaptive" as const, display: "summarized" as const },
    // Always said, even at the model's default: the level the person chose.
    output_config: { effort: choice.effort },
    // An opaque id for Anthropic's abuse checks: never a name.
    metadata: { user_id: userID },
    // The conversation so far is the same at the next question.
    cache_control: { type: "ephemeral" as const },
  };
  const fallback = choice.model.fallback;
  const attached = attachedBody({ ...params, ...(fallback ? { fallbacks: "default" } : {}) });
  if (attached) {
    // Photos and PDFs: the body is written here, not by the SDK (see attachedBody).
    return client
      .post("/v1/messages?beta=true", {
        body: attached,
        headers: { "content-type": "application/json", ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}) },
        stream: true,
        signal,
      })
      .asResponse();
  }
  return client.beta.messages
    .create({ ...params, ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}) }, { signal })
    .asResponse();
}

/**
 * The request body for a conversation with photos or PDFs, or null when it
 * has none. Writing megabytes of base64 out again through JSON.stringify is
 * the relay's most expensive step (about 4.5 ms a MB, where Cloudflare's
 * free plan gives a request 10 ms), so each file's base64 goes into the body
 * as it is, between the JSON written for everything else. That is safe
 * because turns.ts let through only base64 characters, which never end or
 * escape a JSON string; the place marker is new for every request, so no
 * text in the conversation can stand in for it.
 */
export function attachedBody(params: { messages: { role: string; content: string | Block[] }[] } & Record<string, unknown>): Blob | null {
  const files: string[] = [];
  const marker = `fielua-${crypto.randomUUID()}`;
  const messages = params.messages.map((message) => {
    if (typeof message.content === "string") return message;
    return {
      role: message.role,
      content: message.content.map((block) => {
        if (block.type !== "text" && block.source.type === "base64") {
          files.push(block.source.data);
          return { ...block, source: { ...block.source, data: marker } };
        }
        return block;
      }),
    };
  });
  if (!files.length) return null;
  const json = JSON.stringify({ ...params, messages });
  const pieces = json.split(marker);
  if (pieces.length !== files.length + 1) throw new Error("attachment marker");
  const parts: string[] = [pieces[0]!];
  files.forEach((data, index) => parts.push(data, pieces[index + 1]!));
  return new Blob(parts, { type: "application/json" });
}
