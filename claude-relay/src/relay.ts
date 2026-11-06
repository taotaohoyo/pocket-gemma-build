// The relay's routes. The app talks to /v1/*, the developer's app also to
// /admin/*. Every answer is JSON (no-store) except a reply, which is
// Anthropic's own event stream passed through.
//
//   GET  /v1/status            the user and whether Claude can answer now
//   POST /v1/redeem            an invite code for an access token (once)
//   POST /v1/messages          a reply to the chat's text turns, streamed
//   POST /v1/leave             the user's own registration deleted (its token stops at once)
//   GET  /join                 the page an invite link opens (the code stays in the link's #)
//   GET  /admin/state          users, open invites, switches       (admin key)
//   POST /admin/invites        a new invite                        (admin key)
//   DELETE /admin/invites/:id  an open invite withdrawn            (admin key)
//   POST /admin/users/:id/revoke|restore, DELETE /admin/users/:id  (admin key)
//   POST /admin/settings       {friendsEnabled} or {resume: true}  (admin key)

import Anthropic from "@anthropic-ai/sdk";
import type { Invite, PauseReason, RedeemResult, Role, Settings, User, UserStatus } from "./core";
import { MAX_NAME_LENGTH } from "./core";
import { config, modelName, streamReply, type ClaudeConfig } from "./claude";
import { joinPage } from "./join";
import {
  adminKeyMatches, bearer, inviteHash, isAccessToken, newAccessToken, newID, newInviteCode, normalizeInviteCode, tokenHash,
} from "./security";
import { parseTurns, readJSON, type Turn } from "./turns";

/** The registry as the handler reaches it: the Durable Object's methods over RPC, or RegistryCore in the tests. */
export interface RegistryAPI {
  authenticate(tokenHash: string): Promise<User | null>;
  touch(id: string): Promise<void>;
  listUsers(): Promise<User[]>;
  setStatus(id: string, status: UserStatus): Promise<User | null>;
  deleteUser(id: string): Promise<boolean>;
  createInvite(id: string, codeHash: string, name: string, role: Role): Promise<Invite>;
  listInvites(): Promise<Invite[]>;
  cancelInvite(id: string): Promise<boolean>;
  redeem(codeHash: string, userID: string, tokenHash: string): Promise<RedeemResult>;
  settings(): Promise<Settings>;
  setFriendsEnabled(on: boolean): Promise<Settings>;
  pause(reason: PauseReason): Promise<Settings>;
  resume(): Promise<Settings>;
}

export interface RelayEnv {
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;
  CLAUDE_EFFORT?: string;
  ANTHROPIC_BASE_URL?: string;
}

export interface Deps {
  registry: RegistryAPI;
  claude?: (cfg: ClaudeConfig, turns: Turn[], userID: string, signal?: AbortSignal) => Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Why Claude can't answer this user now; null when it can. */
export type Unavailable = "not_configured" | "paused_billing" | "paused_limit" | "friends_disabled";

export async function handle(request: Request, env: RelayEnv, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (request.method === "GET" && path === "/join") return joinPage();
    if (path.startsWith("/v1/")) {
      if (request.method === "GET" && path === "/v1/status") return await status(request, env, deps);
      if (request.method === "POST" && path === "/v1/redeem") return await redeem(request, deps);
      if (request.method === "POST" && path === "/v1/messages") return await messages(request, env, deps);
      if (request.method === "POST" && path === "/v1/leave") return await leave(request, deps);
      return json(404, { error: "not_found" });
    }
    if (path.startsWith("/admin/")) return await admin(request, url, env, deps);
    return json(404, { error: "not_found" });
  } catch (error) {
    console.error("relay error", error instanceof Error ? error.name : "unknown");
    return json(500, { error: "server_error" });
  }
}

// MARK: The app

async function user(request: Request, deps: Deps): Promise<User | Response> {
  const token = bearer(request);
  if (!token || !isAccessToken(token)) return json(401, { error: "unauthorized" });
  const found = await deps.registry.authenticate(await tokenHash(token));
  if (!found) return json(401, { error: "unauthorized" });
  if (found.status !== "active") return json(403, { error: "revoked" });
  return found;
}

export function unavailable(person: User, settings: Settings, cfg: ClaudeConfig | null): Unavailable | null {
  if (!cfg) return "not_configured";
  if (settings.paused === "billing") return "paused_billing";
  if (settings.paused === "limit") return "paused_limit";
  if (person.role === "friend" && !settings.friendsEnabled) return "friends_disabled";
  return null;
}

async function status(request: Request, env: RelayEnv, deps: Deps): Promise<Response> {
  const person = await user(request, deps);
  if (person instanceof Response) return person;
  const settings = await deps.registry.settings();
  const cfg = config(env);
  const reason = unavailable(person, settings, cfg);
  const model = cfg?.model ?? env.CLAUDE_MODEL ?? "";
  return json(200, {
    name: person.name,
    role: person.role,
    available: reason === null,
    reason,
    model,
    modelName: modelName(model),
  });
}

async function redeem(request: Request, deps: Deps): Promise<Response> {
  const body = await readJSON(request);
  if (!body.ok) return json(body.error === "too_large" ? 413 : 400, { error: body.error });
  const raw = (body.value as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" ? normalizeInviteCode(raw) : null;
  const token = newAccessToken();
  // A malformed code counts as a wrong one: the same answer, the same count.
  const result = await deps.registry.redeem(await inviteHash(code ?? "-"), newID(), await tokenHash(token));
  if (!result.ok) return json(result.error === "too_many_attempts" ? 429 : 400, { error: result.error });
  return json(200, { token, name: result.user.name, role: result.user.role });
}

/** The app's 登録を解除: the user's own record goes, revoked or not, so nothing of theirs stays. */
async function leave(request: Request, deps: Deps): Promise<Response> {
  const token = bearer(request);
  if (!token || !isAccessToken(token)) return json(401, { error: "unauthorized" });
  const found = await deps.registry.authenticate(await tokenHash(token));
  if (!found) return json(401, { error: "unauthorized" });
  await deps.registry.deleteUser(found.id);
  return json(200, { left: true });
}

async function messages(request: Request, env: RelayEnv, deps: Deps): Promise<Response> {
  const person = await user(request, deps);
  if (person instanceof Response) return person;
  const cfg = config(env);
  const reason = unavailable(person, await deps.registry.settings(), cfg);
  if (reason || !cfg) return json(503, { error: "unavailable", reason: reason ?? "not_configured" });
  const body = await readJSON(request);
  if (!body.ok) return json(body.error === "too_large" ? 413 : 400, { error: body.error });
  const parsed = parseTurns(body.value);
  if (!parsed.ok) return json(parsed.error === "too_large" ? 413 : 400, { error: parsed.error });
  const call = deps.claude ?? streamReply;
  let upstream: Response;
  try {
    upstream = await call(cfg, parsed.turns, person.id, request.signal);
  } catch (error) {
    return await claudeFailure(error, deps);
  }
  deps.waitUntil?.(deps.registry.touch(person.id));
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Fielua-Model": cfg.model,
    },
  });
}

/** Anthropic's refusal before the stream began, in the app's words. Out of credit, or over the spend limit: the relay stops itself. */
export async function claudeFailure(error: unknown, deps: Deps): Promise<Response> {
  if (!(error instanceof Anthropic.APIError)) {
    console.error("claude call failed", error instanceof Error ? error.name : "unknown");
    return json(502, { error: "upstream_unreachable" });
  }
  if (error instanceof Anthropic.APIUserAbortError) return json(499, { error: "cancelled" });
  if (error instanceof Anthropic.APIConnectionError) return json(502, { error: "upstream_unreachable" });
  console.error("claude refused", error.status, error.type, error.errorCode, error.requestID);
  if (error.errorCode === "enforced_spend_limit_reached") {
    await deps.registry.pause("limit");
    return json(503, { error: "unavailable", reason: "paused_limit" });
  }
  if (error.type === "billing_error" || error.status === 402 || error.errorCode === "organization_on_hold") {
    await deps.registry.pause("billing");
    return json(503, { error: "unavailable", reason: "paused_billing" });
  }
  if (error.type === "authentication_error" || error.type === "permission_error") return json(502, { error: "server_key" });
  if (error.type === "rate_limit_error") return json(429, { error: "rate_limited" });
  if (error.type === "overloaded_error" || error.status === 529) return json(503, { error: "overloaded" });
  if (error.status === 413) return json(413, { error: "too_large" });
  if (error.type === "not_found_error") return json(502, { error: "model_unavailable" });
  if (error.type === "invalid_request_error") return json(400, { error: "rejected" });
  return json(502, { error: "upstream" });
}

// MARK: The developer

async function admin(request: Request, url: URL, env: RelayEnv, deps: Deps): Promise<Response> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return json(503, { error: "admin_not_configured" });
  if (!(await adminKeyMatches(bearer(request), env.ADMIN_TOKEN))) return json(401, { error: "unauthorized" });
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", ...]
  const registry = deps.registry;
  if (request.method === "GET" && parts[1] === "state" && parts.length === 2) {
    const [users, invites, settings] = await Promise.all([registry.listUsers(), registry.listInvites(), registry.settings()]);
    const cfg = config(env);
    return json(200, { users, invites, settings, model: cfg?.model ?? env.CLAUDE_MODEL ?? "", configured: cfg !== null });
  }
  if (parts[1] === "invites") {
    if (request.method === "POST" && parts.length === 2) {
      const body = await readJSON(request);
      if (!body.ok) return json(400, { error: body.error });
      const { name: rawName, role: rawRole } = (body.value ?? {}) as { name?: unknown; role?: unknown };
      const name = cleanName(rawName);
      const role: Role | null = rawRole === "developer" ? "developer" : rawRole === "friend" ? "friend" : null;
      if (!name || !role) return json(400, { error: "bad_request" });
      const code = newInviteCode();
      const invite = await registry.createInvite(newID(), await inviteHash(normalizeInviteCode(code)!), name, role);
      return json(200, { invite, code, link: `${url.origin}/join#${code}` });
    }
    if (request.method === "DELETE" && parts.length === 3) {
      return (await registry.cancelInvite(parts[2]!)) ? json(200, { ok: true }) : json(404, { error: "not_found" });
    }
  }
  if (parts[1] === "users" && parts.length >= 3) {
    const id = parts[2]!;
    if (request.method === "DELETE" && parts.length === 3) {
      return (await registry.deleteUser(id)) ? json(200, { ok: true }) : json(404, { error: "not_found" });
    }
    if (request.method === "POST" && parts.length === 4 && (parts[3] === "revoke" || parts[3] === "restore")) {
      const changed = await registry.setStatus(id, parts[3] === "revoke" ? "revoked" : "active");
      return changed ? json(200, { user: changed }) : json(404, { error: "not_found" });
    }
  }
  if (request.method === "POST" && parts[1] === "settings" && parts.length === 2) {
    const body = await readJSON(request);
    if (!body.ok) return json(400, { error: body.error });
    const value = (body.value ?? {}) as { friendsEnabled?: unknown; resume?: unknown };
    let settings: Settings | null = null;
    if (typeof value.friendsEnabled === "boolean") settings = await registry.setFriendsEnabled(value.friendsEnabled);
    if (value.resume === true) settings = await registry.resume();
    return settings ? json(200, { settings }) : json(400, { error: "bad_request" });
  }
  return json(404, { error: "not_found" });
}

/** A person's name as the developer typed it: control and invisible formatting characters out, 40 characters at most. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (!name) return null;
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join("");
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
