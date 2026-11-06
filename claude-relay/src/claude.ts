// The one call to Anthropic: the chat's turns go to the Messages API with
// the relay's model and limits, streamed back as Anthropic sends them.

import Anthropic from "@anthropic-ai/sdk";
import type { Turn } from "./turns";

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Anthropic's API, or a local stand-in (http://127.0.0.1 or localhost)
   * for the relay's own tests; any other ANTHROPIC_BASE_URL is ignored, so
   * the key can't be sent elsewhere by a mistyped variable.
   */
  baseURL: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_API = "https://api.anthropic.com";

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
};

export function modelName(model: string): string {
  return MODEL_NAMES[model] ?? model;
}

/** Models that take the server-side fallback on a refusal (Claude Haiku 5.5 has none). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export function config(env: {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;
  CLAUDE_EFFORT?: string;
  ANTHROPIC_BASE_URL?: string;
}): ClaudeConfig | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const tokens = Number.parseInt(env.CLAUDE_MAX_TOKENS ?? "", 10);
  const effort = env.CLAUDE_EFFORT;
  const base = env.ANTHROPIC_BASE_URL;
  return {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.CLAUDE_MODEL || DEFAULT_MODEL,
    maxTokens: Number.isFinite(tokens) ? Math.min(Math.max(tokens, 1024), 64000) : 16000,
    effort: effort === "low" || effort === "high" || effort === "xhigh" || effort === "max" ? effort : "medium",
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
export async function streamReply(cfg: ClaudeConfig, turns: Turn[], userID: string, signal?: AbortSignal): Promise<Response> {
  // Everything explicit: the SDK would otherwise read ANTHROPIC_* from
  // process.env, which the Workers runtime fills with the Worker's vars.
  const client = new Anthropic({ apiKey: cfg.apiKey, authToken: null, baseURL: cfg.baseURL, maxRetries: 2, timeout: 10 * 60 * 1000 });
  const fallback = FALLBACK_MODELS.has(cfg.model);
  return client.beta.messages
    .create(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
        output_config: { effort: cfg.effort },
        // An opaque id for Anthropic's abuse checks: never a name.
        metadata: { user_id: userID },
        // The conversation so far is the same at the next question.
        cache_control: { type: "ephemeral" },
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    )
    .asResponse();
}
