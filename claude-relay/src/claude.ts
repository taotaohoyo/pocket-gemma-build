// The one call to Anthropic: the chat's turns go to the Messages API with
// the model and reasoning level the person chose from the relay's catalog,
// streamed back as Anthropic sends them.

import Anthropic from "@anthropic-ai/sdk";
import type { Turn } from "./turns";

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
 * The models a person may choose, in the order Fielua shows them (Opus 5.5,
 * the default, first). Checked against Anthropic's models overview and
 * effort pages on 2026-11-06, and Claude Fable 5.2 against its migration
 * guide on 2026-11-10: every one takes low to max; Fielua leaves max out.
 * Anything not here is refused.
 */
export const MODELS: readonly ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: EFFORTS, defaultEffort: "medium", fallback: true },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", efforts: EFFORTS, defaultEffort: "high", fallback: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: EFFORTS, defaultEffort: "high", fallback: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: EFFORTS, defaultEffort: "medium", fallback: false },
  // Claude Fable 5.2 took its place on 2026-11-10 (Anthropic still serves it).
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: EFFORTS, defaultEffort: "high", fallback: true, former: true },
];

export const DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_API = "https://api.anthropic.com";

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

/** The app's choice, checked: an unknown model or level (max included) is refused, never swapped for another. */
export function choose(cfg: ClaudeConfig, model: unknown, effort: unknown): ChoiceResult {
  const info = model === undefined || model === null ? modelInfo(cfg.model) : typeof model === "string" ? modelInfo(model) : undefined;
  if (!info) return { ok: false, error: "unsupported_model" };
  const level = effort === undefined || effort === null ? info.defaultEffort : info.efforts.find((e) => e === effort);
  if (!level) return { ok: false, error: "unsupported_effort" };
  return { ok: true, choice: { model: info, effort: level, maxTokens: Math.min(EFFORT_TOKENS[level], cfg.maxTokens) } };
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

/** What Claude is told about where it answers. No personal data, the same for everyone, so it caches. */
export const SYSTEM_PROMPT = [
  "You are Claude, made by Anthropic, answering through Fielua, a personal chat app on iPhone.",
  "Reply in the language the person writes in.",
  "Fielua shows Markdown: headings, lists, tables, code blocks, and LaTeX math between $ signs.",
  "Keep answers focused, and go into detail when the person asks for it.",
  "You see only this conversation's text: not the person's photos, files or other chats, and you cannot browse the web.",
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
  return client.beta.messages
    .create(
      {
        model: choice.model.id,
        max_tokens: choice.maxTokens,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
        // Summaries of the thinking, not silence: a long think at 超高 keeps
        // the app's connection busy. Billed the same as hidden thinking.
        thinking: { type: "adaptive", display: "summarized" },
        // Always said, even at the model's default: the level the person chose.
        output_config: { effort: choice.effort },
        // An opaque id for Anthropic's abuse checks: never a name.
        metadata: { user_id: userID },
        // The conversation so far is the same at the next question.
        cache_control: { type: "ephemeral" },
        ...(choice.model.fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    )
    .asResponse();
}
