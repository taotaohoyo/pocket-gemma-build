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
  /**
   * No longer offered, as a newer model took its place, but still taken:
   * a chat the iPhone app began with it goes on with it.
   */
  former?: true;
}

/**
 * The models a person may choose, in the order Fielua shows them: Fable 5.2
 * above Opus 5.5, so it doesn't look like the lighter one (Hachimoto さん,
 * 2026-11-11). Opus 5.5 stays the default (DEFAULT_MODEL). Checked against Anthropic's models overview and
 * effort pages on 2026-11-06, and Claude Fable 5.2 against its migration
 * guide on 2026-11-10: every one takes low to max; Fielua leaves max out.
 * Anything not here is refused.
 */
export const MODELS: readonly ModelInfo[] = [
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", efforts: EFFORTS, defaultEffort: "high", fallback: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: EFFORTS, defaultEffort: "medium", fallback: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: EFFORTS, defaultEffort: "high", fallback: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: EFFORTS, defaultEffort: "medium", fallback: false },
  // Claude Fable 5.2 took its place on 2026-11-10 (Anthropic still serves it).
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: EFFORTS, defaultEffort: "high", fallback: true, former: true },
];

export const DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * List prices in US dollars per million tokens, as Anthropic's pricing
 * page gave them on 2026-11-08 (the skill's model table, cached
 * 2026-10-06), and Claude Fable 5.2's as its migration guide gave them on
 * 2026-11-10. Used only for the estimate of the credit left: Anthropic
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
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** Server tools used: each web search costs $0.01 on top of the tokens. */
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** A web search, in millionths of a dollar ($10 per 1,000). */
export const SEARCH_MICROS = 10_000;

/** What a reply cost, in millionths of a dollar (tokens times the price per million tokens). */
export function costMicros(model: string, usage: Usage): number {
  const price = PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const rates = price.long && input + written + read > price.long.above ? price.long : price;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return Math.round(input * rates.input + written * rates.input * 1.25 + read * rates.cacheRead + output * rates.output + searches * SEARCH_MICROS);
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

/** The catalog as the app sees it, former models left out: `available` is null when Anthropic couldn't be asked. */
export function catalog(live: LiveModels | null) {
  return MODELS.filter((model) => !model.former).map(({ id, name, defaultEffort }) => {
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
    model: env.CLAUDE_MODEL && modelInfo(env.CLAUDE_MODEL) && !modelInfo(env.CLAUDE_MODEL)!.former ? env.CLAUDE_MODEL : DEFAULT_MODEL,
    maxTokens: Number.isFinite(tokens) ? Math.min(Math.max(tokens, 1024), 128000) : 64000,
    baseURL: base && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base) ? base : ANTHROPIC_API,
  };
}

/**
 * The tools the person turned on for a request (Fielua for the web's plus
 * menu), and the container a chat's earlier files are in. None by default:
 * the iPhone app sends none.
 */
export interface ToolChoice {
  /** Searching the web, and reading pages (Anthropic's server tools: $10 per 1,000 searches). */
  webSearch: boolean;
  /** Running code to make files the person downloads (code execution, with Anthropic's document skills). */
  files: boolean;
  /** A container this person's earlier reply made files in, to go on with them. */
  container: string | null;
}
export const NO_TOOLS: ToolChoice = { webSearch: false, files: false, container: null };

/** Searches in one reply: enough to compare a few sources, not a runaway bill. */
export const MAX_SEARCHES = 5;
/** Anthropic's own skills for making documents: PDF, Word, Excel, PowerPoint. */
export const FILE_SKILLS = ["pdf", "docx", "xlsx", "pptx"] as const;
const CODE_EXECUTION_BETA = "code-execution-2025-08-25";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The request's tools and container, as Anthropic takes them; nothing when none is on. */
export function toolParams(tools: ToolChoice): { tools?: Record<string, unknown>[]; container?: Record<string, unknown> } {
  const list: Record<string, unknown>[] = [];
  if (tools.webSearch) {
    if (tools.files) {
      // Code execution is on for files: the plain search, so code runs in one place only
      // (the dynamic-filtering versions run code of their own).
      list.push({ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES });
    } else {
      list.push({ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES });
      list.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_SEARCHES });
    }
  }
  if (tools.files) list.push({ type: "code_execution_20260521", name: "code_execution" });
  if (!list.length) return {};
  if (!tools.files) return { tools: list };
  return {
    tools: list,
    container: {
      ...(tools.container ? { id: tools.container } : {}),
      skills: FILE_SKILLS.map((id) => ({ type: "anthropic", skill_id: id, version: "latest" })),
    },
  };
}

/** What Claude is told about where it answers. No personal data, the same for everyone with the same tools, so it caches. */
export function systemPrompt(tools: ToolChoice = NO_TOOLS): string {
  return [
    "You are Claude, made by Anthropic, answering through Fielua, a personal chat app on iPhone and on the web.",
    "Reply in the language the person writes in.",
    "Fielua shows Markdown: headings, lists, tables, code blocks, and LaTeX math between $ signs.",
    "Keep answers focused, and go into detail when the person asks for it.",
    "You see this conversation, with the photos, PDFs and text files the person attached to it.",
    "A video arrives as a few still frames, each captioned with its time, and without sound.",
    tools.webSearch
      ? "You cannot see other chats. You can search the web when a question needs current or outside facts; Fielua lists the pages you cite under your reply."
      : "You cannot see other chats or browse the web.",
    ...(tools.files
      ? ["You can run code and make files. When the person asks for a file (PDF, Word, Excel, PowerPoint, text, CSV, an image and so on), make it and save it in $OUTPUT_DIR: Fielua shows every file saved there under your reply, to download. Name the file in your reply rather than pasting all of its content again."]
      : []),
  ].join(" ");
}
export const SYSTEM_PROMPT = systemPrompt();

/**
 * Starts a streamed reply. Resolves with Anthropic's own server-sent
 * events once it has accepted the request; rejects with the SDK's typed
 * errors (Anthropic.APIError and its subclasses) before that. The events
 * are passed on untouched, so the relay spends next to no CPU on them,
 * and `signal` (the app's connection) ends the request at Anthropic too.
 */
export async function streamReply(cfg: ClaudeConfig, choice: ReplyChoice, turns: Turn[], userID: string, signal?: AbortSignal, tools: ToolChoice = NO_TOOLS): Promise<Response> {
  // Everything explicit: the SDK would otherwise read ANTHROPIC_* from
  // process.env, which the Workers runtime fills with the Worker's vars.
  const client = new Anthropic({ apiKey: cfg.apiKey, authToken: null, baseURL: cfg.baseURL, maxRetries: 2, timeout: 10 * 60 * 1000 });
  const params = {
    model: choice.model.id,
    max_tokens: choice.maxTokens,
    stream: true as const,
    system: systemPrompt(tools),
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
  const betas = [...(fallback ? [FALLBACK_BETA] : []), ...(tools.files ? [CODE_EXECUTION_BETA] : [])];
  const send = (chosen: ToolChoice) => {
    const full = { ...params, ...toolParams(chosen), ...(fallback ? { fallbacks: "default" } : {}) };
    // The body is written here, not by the SDK: photos and PDFs go in as
    // they are (attachedBody), and the tools need no types of the SDK's.
    return client
      .post("/v1/messages?beta=true", {
        body: attachedBody(full) ?? JSON.stringify(full),
        headers: { "content-type": "application/json", ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}) },
        stream: true,
        signal,
      })
      .asResponse();
  };
  try {
    return await send(tools);
  } catch (error) {
    // A chat's container lapses 30 days after it was made (or was never there): start a new one.
    // The model was checked against Anthropic's list already, so a 404 here is the container's.
    if (tools.container && error instanceof Anthropic.APIError && (error.status === 404 || (error.status === 400 && /container/i.test(error.message)))) {
      return await send({ ...tools, container: null });
    }
    throw error;
  }
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
