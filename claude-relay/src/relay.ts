// The relay's routes. The iPhone app talks to /v1/*, the developer's app
// also to /admin/*. Fielua for the web (https://suelira.com/chat/) signs
// in at /web/* with a passkey and then uses the same /v1/* and /admin/*
// routes with its session, from its own origin only. Every answer is JSON
// (no-store) except a reply, which is Anthropic's own event stream passed
// through.
//
//   GET  /v1/status            the user and whether Claude can answer now
//   POST /v1/redeem            an invite code for an access token (once)
//   POST /v1/messages          a reply to the chat's text turns, streamed, by the chosen model and level
//   POST /v1/leave             the user's own registration deleted (its token stops at once)
//   GET  /join                 the page an invite link opens (the code stays in the link's #)
//   POST /web/passkey/register/options|verify   an invite code for a passkey and a web session
//   POST /web/passkey/login/options|verify      a passkey for a web session
//   POST /web/logout                            the web session ended
//   GET  /admin/state          users, open invites, switches       (admin key, or a developer's fresh web session)
//   POST /admin/invites        a new invite                        (admin)
//   DELETE /admin/invites/:id  an open invite withdrawn            (admin)
//   POST /admin/users/:id/revoke|restore, DELETE /admin/users/:id  (admin)
//   POST /admin/settings       {friendsEnabled} {resume: true} {creditUSD} {creditFriends}  (admin)

import Anthropic from "@anthropic-ai/sdk";
import type { Challenge, Credit, Invite, InviteCheck, Passkey, PauseReason, RedeemResult, Role, Settings, User, UserStatus, WebSession } from "./core";
import { MAX_CREDIT_MICROS, MAX_NAME_LENGTH, WEB_ADMIN_FRESH_MS } from "./core";
import {
  catalog, choose, config, liveModels, modelInfo, modelName, streamReply, type ClaudeConfig, type LiveModels, type ReplyChoice,
} from "./claude";
import { joinPage } from "./join";
import { meter } from "./meter";
import {
  adminKeyMatches, bearer, inviteHash, isAccessToken, isWebSessionToken, newAccessToken, newID, newInviteCode, normalizeInviteCode,
  tokenHash, webSessionHash,
} from "./security";
import { parseTurns, readJSON, type Turn } from "./turns";
import type { StoredKey } from "./webauthn";
import { webConfig, webRoutes, type WebConfig } from "./web";

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
  user(id: string): Promise<User | null>;
  checkInvite(codeHash: string): Promise<InviteCheck>;
  createChallenge(challenge: Omit<Challenge, "expiresAt">): Promise<Challenge | null>;
  takeChallenge(id: string, purpose: Challenge["purpose"]): Promise<Challenge | null>;
  redeemWithPasskey(codeHash: string, userID: string, passkey: { id: string; key: StoredKey; signCount: number }): Promise<RedeemResult>;
  passkey(id: string): Promise<Passkey | null>;
  usedPasskey(id: string, signCount: number): Promise<void>;
  createSession(tokenHash: string, userID: string): Promise<WebSession>;
  sessionUser(tokenHash: string): Promise<{ user: User; session: WebSession } | null>;
  endSession(tokenHash: string): Promise<void>;
  setCredit(budgetMicros: number | null): Promise<Settings>;
  setCreditFriends(on: boolean): Promise<Settings>;
  addSpend(micros: number): Promise<void>;
}

export interface RelayEnv {
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;
  ANTHROPIC_BASE_URL?: string;
  /** Where Fielua for the web runs, comma-separated ("https://suelira.com,https://www.suelira.com"). */
  WEB_ORIGINS?: string;
  /** The web app's passkeys are for this domain ("suelira.com"). */
  WEB_RP_ID?: string;
}

export interface Deps {
  registry: RegistryAPI;
  claude?: (cfg: ClaudeConfig, choice: ReplyChoice, turns: Turn[], userID: string, signal?: AbortSignal) => Promise<Response>;
  /** What Anthropic says its models can do now (liveModels); the tests stand in for it. */
  models?: (cfg: ClaudeConfig) => Promise<LiveModels | null>;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
}

/** One request's surroundings: the config, and the web app's origin when the request comes from it. */
export interface Context {
  env: RelayEnv;
  deps: Deps;
  web: WebConfig | null;
  /** The request's Origin, when it is one of WEB_ORIGINS; null for the iPhone app, curl, or another site. */
  origin: string | null;
}

/** A person as a request reaches the relay: with the web session when it came that way. */
export type Caller = User & { session: WebSession | null };

/** Why Claude can't answer this user now; null when it can. */
export type Unavailable = "not_configured" | "paused_billing" | "paused_limit" | "friends_disabled";

export async function handle(request: Request, env: RelayEnv, deps: Deps): Promise<Response> {
  const web = webConfig(env);
  const requestOrigin = request.headers.get("Origin");
  const origin = requestOrigin && web?.origins.includes(requestOrigin) ? requestOrigin : null;
  const ctx: Context = { env, deps, web, origin };
  if (request.method === "OPTIONS") return preflight(origin);
  let response: Response;
  try {
    response = await route(request, ctx);
  } catch (error) {
    console.error("relay error", error instanceof Error ? error.name : "unknown");
    response = json(500, { error: "server_error" });
  }
  return origin ? withCORS(response, origin) : response;
}

async function route(request: Request, ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/join") return joinPage();
  if (path.startsWith("/v1/")) {
    if (request.method === "GET" && path === "/v1/status") return await status(request, ctx);
    if (request.method === "POST" && path === "/v1/redeem") return await redeem(request, ctx.deps);
    if (request.method === "POST" && path === "/v1/messages") return await messages(request, ctx);
    if (request.method === "POST" && path === "/v1/leave") return await leave(request, ctx);
    return json(404, { error: "not_found" });
  }
  if (path.startsWith("/web/")) return await webRoutes(request, path, ctx);
  if (path.startsWith("/admin/")) return await admin(request, url, ctx);
  return json(404, { error: "not_found" });
}

// MARK: Cross-origin (the web app only)

/**
 * The browser's question before a cross-origin request with a key in it.
 * Only the web app's own origins get a yes, so another site's page can't
 * even send a request with a stolen token; the iPhone app sends none.
 */
function preflight(origin: string | null): Response {
  if (!origin) return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  return withCORS(new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, DELETE",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    },
  }), origin);
}

function withCORS(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "X-Fielua-Model, X-Fielua-Effort");
  headers.append("Vary", "Origin");
  // No cookies are ever used: the session travels in the Authorization header.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// MARK: Who is asking

/**
 * The person behind the request's token: an iPhone's access token
 * (fcl_), or a web session (fws_), which counts only from the web app's
 * own origin and lapses on its own.
 */
export async function caller(request: Request, ctx: Context): Promise<Caller | Response> {
  const token = bearer(request);
  if (token && isAccessToken(token)) {
    const found = await ctx.deps.registry.authenticate(await tokenHash(token));
    if (!found) return json(401, { error: "unauthorized" });
    if (found.status !== "active") return json(403, { error: "revoked" });
    return { ...found, session: null };
  }
  if (token && isWebSessionToken(token)) {
    if (!ctx.web || !ctx.origin) return json(403, { error: "forbidden_origin" });
    const found = await ctx.deps.registry.sessionUser(await webSessionHash(token));
    if (!found) return json(401, { error: "unauthorized" });
    if (found.user.status !== "active") return json(403, { error: "revoked" });
    return { ...found.user, session: found.session };
  }
  return json(401, { error: "unauthorized" });
}

export function unavailable(person: User, settings: Settings, cfg: ClaudeConfig | null): Unavailable | null {
  if (!cfg) return "not_configured";
  if (settings.paused === "billing") return "paused_billing";
  if (settings.paused === "limit") return "paused_limit";
  if (person.role === "friend" && !settings.friendsEnabled) return "friends_disabled";
  return null;
}

/** The estimate of the credit left, for whoever may see it; null when no balance was entered. */
export function creditView(credit: Credit, settings: Settings, person: User | null) {
  if (credit.budgetMicros === null || credit.setAt === null) return null;
  if (person && person.role !== "developer" && !credit.friends) return null;
  const remaining = settings.paused === "billing" ? 0 : Math.max(0, credit.budgetMicros - credit.spentMicros);
  return {
    estimated: true,
    budgetUSD: credit.budgetMicros / 1e6,
    spentUSD: credit.spentMicros / 1e6,
    remainingUSD: remaining / 1e6,
    percent: credit.budgetMicros > 0 ? Math.round((remaining / credit.budgetMicros) * 1000) / 10 : 0,
    setAt: credit.setAt,
    /** Whether friends see it too (the developer's switch). */
    friends: credit.friends,
  };
}

function now(ctx: Context): number {
  return (ctx.deps.now ?? Date.now)();
}

async function status(request: Request, ctx: Context): Promise<Response> {
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  const settings = await ctx.deps.registry.settings();
  const cfg = config(ctx.env);
  const reason = unavailable(person, settings, cfg);
  const model = cfg?.model ?? ctx.env.CLAUDE_MODEL ?? "";
  const live = cfg ? await (ctx.deps.models ?? liveModels)(cfg) : null;
  return json(200, {
    name: person.name,
    role: person.role,
    available: reason === null,
    reason,
    // The default, and everything the app may choose instead.
    model,
    modelName: modelName(model),
    effort: modelInfo(model)?.defaultEffort ?? null,
    models: catalog(live),
    credit: creditView(settings.credit, settings, person),
    web: person.session
      ? { expiresAt: person.session.expiresAt, adminUntil: person.role === "developer" ? person.session.createdAt + WEB_ADMIN_FRESH_MS : null }
      : undefined,
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

/** 登録を解除: the user's own record goes, revoked or not, with their passkeys and web sessions. */
async function leave(request: Request, ctx: Context): Promise<Response> {
  const token = bearer(request);
  let found: User | null = null;
  if (token && isAccessToken(token)) {
    found = await ctx.deps.registry.authenticate(await tokenHash(token));
  } else if (token && isWebSessionToken(token)) {
    if (!ctx.web || !ctx.origin) return json(403, { error: "forbidden_origin" });
    found = (await ctx.deps.registry.sessionUser(await webSessionHash(token)))?.user ?? null;
  }
  if (!found) return json(401, { error: "unauthorized" });
  await ctx.deps.registry.deleteUser(found.id);
  return json(200, { left: true });
}

async function messages(request: Request, ctx: Context): Promise<Response> {
  const { deps } = ctx;
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  const cfg = config(ctx.env);
  const settings = await deps.registry.settings();
  const reason = unavailable(person, settings, cfg);
  if (reason || !cfg) return json(503, { error: "unavailable", reason: reason ?? "not_configured" });
  const body = await readJSON(request);
  if (!body.ok) return json(body.error === "too_large" ? 413 : 400, { error: body.error });
  const parsed = parseTurns(body.value);
  if (!parsed.ok) return json(parsed.error === "too_large" ? 413 : 400, { error: parsed.error });
  const { model, effort } = body.value as { model?: unknown; effort?: unknown };
  const chosen = choose(cfg, model, effort, await (deps.models ?? liveModels)(cfg));
  if (!chosen.ok) return json(400, { error: chosen.error });
  const call = deps.claude ?? streamReply;
  let upstream: Response;
  try {
    upstream = await call(cfg, chosen.choice, parsed.turns, person.id, request.signal);
  } catch (error) {
    return await claudeFailure(error, deps);
  }
  deps.waitUntil?.(deps.registry.touch(person.id));
  let stream = upstream.body;
  if (stream && settings.credit.budgetMicros !== null) {
    // Only the usage is read, for the estimate of the credit left.
    const metered = meter(stream, chosen.choice.model.id, request.signal);
    stream = metered.body;
    deps.waitUntil?.(metered.cost.then((micros) => deps.registry.addSpend(micros)));
  }
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Fielua-Model": chosen.choice.model.id,
      "X-Fielua-Effort": chosen.choice.effort,
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

/**
 * The admin key (the iPhone app, curl), or the developer's web session
 * when its passkey sign-in is at most 15 minutes old: older ones are asked
 * to sign in again (reauth_required), friends are refused (forbidden).
 */
async function adminAllowed(request: Request, ctx: Context): Promise<Response | null> {
  const token = bearer(request);
  if (token && isWebSessionToken(token)) {
    const person = await caller(request, ctx);
    if (person instanceof Response) return person;
    if (person.role !== "developer") return json(403, { error: "forbidden" });
    if (!person.session || now(ctx) - person.session.createdAt > WEB_ADMIN_FRESH_MS) return json(401, { error: "reauth_required" });
    return null;
  }
  if (!(await adminKeyMatches(token, ctx.env.ADMIN_TOKEN))) return json(401, { error: "unauthorized" });
  return null;
}

async function admin(request: Request, url: URL, ctx: Context): Promise<Response> {
  const { env, deps } = ctx;
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return json(503, { error: "admin_not_configured" });
  const refused = await adminAllowed(request, ctx);
  if (refused) return refused;
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", ...]
  const registry = deps.registry;
  if (request.method === "GET" && parts[1] === "state" && parts.length === 2) {
    const [users, invites, settings] = await Promise.all([registry.listUsers(), registry.listInvites(), registry.settings()]);
    const cfg = config(env);
    return json(200, {
      users, invites, settings, model: cfg?.model ?? env.CLAUDE_MODEL ?? "", configured: cfg !== null,
      credit: creditView(settings.credit, settings, null),
    });
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
    const value = (body.value ?? {}) as { friendsEnabled?: unknown; resume?: unknown; creditUSD?: unknown; creditFriends?: unknown };
    let settings: Settings | null = null;
    if (typeof value.friendsEnabled === "boolean") settings = await registry.setFriendsEnabled(value.friendsEnabled);
    if (value.resume === true) settings = await registry.resume();
    if (value.creditUSD === null) settings = await registry.setCredit(null);
    if (typeof value.creditUSD === "number") {
      const micros = Math.round(value.creditUSD * 1e6);
      if (!Number.isFinite(micros) || micros <= 0 || micros > MAX_CREDIT_MICROS) return json(400, { error: "bad_request" });
      settings = await registry.setCredit(micros);
    }
    if (typeof value.creditFriends === "boolean") settings = await registry.setCreditFriends(value.creditFriends);
    return settings ? json(200, { settings, credit: creditView(settings.credit, settings, null) }) : json(400, { error: "bad_request" });
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
