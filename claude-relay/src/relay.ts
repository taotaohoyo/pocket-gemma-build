// The relay's routes. The iPhone app talks to /v1/*, the developer's app
// also to /admin/*. Fielua for the web (https://suelira.com/chat/) signs
// in at /web/* with a passkey and then uses the same /v1/* and /admin/*
// routes with its session, from its own origin only. Every answer is JSON
// (no-store) except a reply, which is Anthropic's own event stream passed
// through.
//
//   GET  /v1/status            the user and whether Claude can answer now
//   POST /v1/redeem            an invite code for an access token (once)
//   POST /v1/messages          a reply to the chat's turns, streamed, by the chosen model and level (and tools: web search, files)
//   POST /v1/replies/:key      the same reply, which a dropped connection doesn't end (reply.ts); the page picks the key
//   GET  /v1/replies/:key      that reply again from its first byte, and what is still coming (its own person only)
//   DELETE /v1/replies/:key    that reply stopped, if it is still being written (or before it begins), and forgotten
//   GET  /v1/files/:id         a file the person's own reply made: its name, type and size
//   GET  /v1/files/:id/content the file itself, to download
//   POST /v1/leave             the user's own registration deleted (its token stops at once)
//   GET  /v1/history-key       the key a web user's browser encrypts its own history with (web sessions only)
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
import type { Challenge, Credit, Invite, InviteCheck, OutputKind, Passkey, PauseReason, RedeemResult, Role, Settings, User, UserStatus, WebSession } from "./core";
import { MAX_CREDIT_MICROS, MAX_NAME_LENGTH, WEB_ADMIN_FRESH_MS } from "./core";
import {
  catalog, choose, config, liveModels, modelInfo, modelName, NO_TOOLS, streamReply, type ClaudeConfig, type LiveModels, type ReplyChoice,
  type ToolChoice,
} from "./claude";
import { joinPage } from "./join";
import { meter, OUTPUT_ID } from "./meter";
import { REPLY_KEY, type ReplyKeeper } from "./reply";
import {
  adminKeyMatches, bearer, inviteHash, isAccessToken, isWebSessionToken, newAccessToken, newHistoryKey, newID, newInviteCode, normalizeInviteCode,
  tokenHash, webSessionHash,
} from "./security";
import { attachmentLimits, parseTurns, readJSON, type Turn } from "./turns";
import type { StoredKey } from "./webauthn";
import { webConfig, webRoutes, type WebConfig, webAppURL } from "./web";

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
  rememberOutputs(userID: string, container: string | null, files: string[]): Promise<void>;
  ownsOutput(userID: string, kind: OutputKind, id: string): Promise<boolean>;
  historyKey(userID: string, candidate: string): Promise<string | null>;
}

export interface RelayEnv {
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;
  ANTHROPIC_BASE_URL?: string;
  /** Where Fielua for the web runs, comma-separated ("https://suelira.com,https://www.suelira.com"). */
  WEB_ORIGINS?: string;
  /** Fielua for the web's page, offered on the invite page beside the app (webAppURL). */
  WEB_APP_URL?: string;
  /** The web app's passkeys are for this domain ("suelira.com"). */
  WEB_RP_ID?: string;
  /** How many MB of photos and PDFs one request may carry (3 on the free plan; turns.ts). */
  ATTACHMENT_MB?: string;
}

export interface Deps {
  registry: RegistryAPI;
  claude?: (cfg: ClaudeConfig, choice: ReplyChoice, turns: Turn[], userID: string, signal?: AbortSignal, tools?: ToolChoice) => Promise<Response>;
  /** Anthropic's Files API for a file code execution made; the tests stand in for it. */
  files?: FilesAPI;
  /** What Anthropic says its models can do now (liveModels); the tests stand in for it. */
  models?: (cfg: ClaudeConfig) => Promise<LiveModels | null>;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
  /** Replies a dropped connection doesn't end, each in a Durable Object of its own (index.ts); none in the tests unless they stand in. */
  replies?: ReplyHub;
  /** Inside one of those objects: its reply's keeper. */
  keeper?: ReplyKeeper;
}

/**
 * Where the replies of /v1/replies run, each in the object of its person
 * and key: the person was checked already, and is checked again there.
 */
export interface ReplyHub {
  /** The request, sent on to the reply's object, which answers it as /v1/messages would, with the reply kept. */
  start(request: Request, key: string, owner: string): Promise<Response>;
  /** A reply again, for its own person: 409 while it hasn't begun, 404 when there is none. */
  again(key: string, owner: string): Promise<Response>;
  /** A reply stopped and forgotten: 404 when there was none (then it never begins). */
  end(key: string, owner: string): Promise<Response>;
}

/** The Files API as the relay uses it: a file's details, and its content as a stream. */
export interface FilesAPI {
  metadata(cfg: ClaudeConfig, id: string): Promise<{ filename: string; mime_type: string; size_bytes: number; downloadable?: boolean }>;
  content(cfg: ClaudeConfig, id: string, signal?: AbortSignal): Promise<Response>;
}

const anthropicFiles: FilesAPI = {
  metadata(cfg, id) {
    return client(cfg).files.retrieveMetadata(id);
  },
  async content(cfg, id, signal) {
    return client(cfg).files.download(id, {}, { signal });
  },
};

function client(cfg: ClaudeConfig): Anthropic {
  return new Anthropic({ apiKey: cfg.apiKey, authToken: null, baseURL: cfg.baseURL, maxRetries: 2, timeout: 5 * 60 * 1000 });
}

/** One request's surroundings: the config, and the web app's origin when the request comes from it. */
export interface Context {
  env: RelayEnv;
  deps: Deps;
  web: WebConfig | null;
  /** The request's Origin, when it is one of WEB_ORIGINS; null for the iPhone app, curl, or another site. */
  origin: string | null;
  /** In a kept reply's own object: the key the page named it by. */
  replyKey?: string;
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
  if (request.method === "GET" && path === "/join") return joinPage(webAppURL(ctx.env, ctx.web));
  if (path.startsWith("/v1/")) {
    if (request.method === "GET" && path === "/v1/status") return await status(request, ctx);
    if (request.method === "POST" && path === "/v1/redeem") return await redeem(request, ctx.deps);
    if (request.method === "POST" && path === "/v1/messages") return await messages(request, ctx);
    const kept = /^\/v1\/replies\/([^/]+)$/.exec(path);
    if (kept && ["POST", "GET", "DELETE"].includes(request.method)) return await keptReply(request, ctx, kept[1]!);
    if (request.method === "POST" && path === "/v1/leave") return await leave(request, ctx);
    if (request.method === "GET" && path === "/v1/history-key") return await historyKey(request, ctx);
    const file = /^\/v1\/files\/([^/]+)(\/content)?$/.exec(path);
    if (request.method === "GET" && file) return await download(request, ctx, file[1]!, !!file[2]);
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
  headers.set("Access-Control-Expose-Headers", "X-Fielua-Model, X-Fielua-Effort, X-Fielua-Reply");
  if (!/\bOrigin\b/.test(headers.get("Vary") ?? "")) headers.append("Vary", "Origin");
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
    // What the app may attach, so it can shrink photos and say what fits before sending.
    attachments: { bytes: Math.floor((attachmentLimits(ctx.env).chars * 3) / 4) },
    // The tools the app may turn on for a reply.
    tools: { webSearch: true, files: true },
    // Whether a reply can be asked at /v1/replies, to be read again after the connection drops.
    resumable: !!ctx.deps.replies,
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

/**
 * The key Fielua for the web encrypts the conversations it keeps on the
 * person's own device with. Only a signed-in web session gets it (from the
 * web app's own origin), always the same one for the same person, and it is
 * deleted with them: then that device's history can't be read any more.
 */
async function historyKey(request: Request, ctx: Context): Promise<Response> {
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  if (!person.session) return json(403, { error: "forbidden" });
  const key = await ctx.deps.registry.historyKey(person.id, newHistoryKey());
  // Deleted a moment ago (登録を解除 in another tab): as for any request from someone no longer registered.
  if (!key) return json(401, { error: "unauthorized" });
  return json(200, { key });
}

async function messages(request: Request, ctx: Context): Promise<Response> {
  const { deps } = ctx;
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  const cfg = config(ctx.env);
  const settings = await deps.registry.settings();
  const reason = unavailable(person, settings, cfg);
  if (reason || !cfg) return json(503, { error: "unavailable", reason: reason ?? "not_configured" });
  const limits = attachmentLimits(ctx.env);
  const body = await readJSON(request, limits.bodyBytes);
  if (!body.ok) return json(body.error === "too_large" ? 413 : 400, { error: body.error });
  const parsed = parseTurns(body.value, limits);
  if (!parsed.ok) return json(parsed.error === "too_large" ? 413 : 400, { error: parsed.error });
  const { model, effort, tools: rawTools } = body.value as { model?: unknown; effort?: unknown; tools?: unknown };
  const chosen = choose(cfg, model, effort, await (deps.models ?? liveModels)(cfg));
  if (!chosen.ok) return json(400, { error: chosen.error });
  const tools = await toolChoice(rawTools, person, deps);
  const call = deps.claude ?? streamReply;
  // A kept reply (/v1/replies) ends only when the page says so, or with its age: never with the page's connection.
  const keeper = deps.keeper ?? null;
  const signal = keeper ? keeper.begin(person.id, ctx.replyKey ?? "") : request.signal;
  // The page stopped it before it got here (its DELETE overtook this request): nothing is asked.
  if (!signal) return json(409, { error: "stopped" });
  let upstream: Response;
  try {
    upstream = await call(cfg, chosen.choice, parsed.turns, person.id, signal, tools);
  } catch (error) {
    keeper?.end(person.id);
    return await claudeFailure(error, deps);
  }
  deps.waitUntil?.(deps.registry.touch(person.id));
  let stream = upstream.body;
  const counting = settings.credit.budgetMicros !== null;
  if (stream && (counting || tools.files)) {
    // Only the usage is read, for the estimate of the credit left, and the
    // ids of the files code execution made, so they are this person's alone.
    const metered = meter(stream, chosen.choice.model.id, signal, tools.files, keeper !== null);
    stream = metered.body;
    if (counting) deps.waitUntil?.(metered.cost.then((micros) => deps.registry.addSpend(micros)));
    if (tools.files) {
      deps.waitUntil?.(metered.outputs.then((made) =>
        made.container || made.files.length ? deps.registry.rememberOutputs(person.id, made.container, made.files) : undefined));
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Fielua-Model": chosen.choice.model.id,
    "X-Fielua-Effort": chosen.choice.effort,
  };
  if (keeper) {
    if (!stream) keeper.end(person.id);
    else {
      stream = keeper.hold(stream, headers);
      headers["X-Fielua-Reply"] = ctx.replyKey ?? "";
    }
  }
  return new Response(stream, { status: 200, headers });
}

// MARK: Replies a dropped connection doesn't end

/**
 * A reply of /v1/replies/:key. POST asks it: checked here, so no reply's
 * object starts for a stranger, then sent on to the object of this person
 * and key (ReplyHub.start), which answers it as /v1/messages does, with
 * the reply kept. GET reads it again, DELETE stops and forgets it: only
 * the person's own (the key alone finds nothing); anything else is "not
 * found".
 */
async function keptReply(request: Request, ctx: Context, key: string): Promise<Response> {
  const hub = ctx.deps.replies;
  if (!hub || ctx.deps.keeper) return json(404, { error: "not_found" });
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  if (!REPLY_KEY.test(key)) return json(404, { error: "not_found" });
  if (request.method === "POST") return await hub.start(request, key, person.id);
  return request.method === "DELETE" ? await hub.end(key, person.id) : await hub.again(key, person.id);
}

/**
 * The request a reply's own object got (from ReplyHub.start): only POST
 * /v1/replies/:key, answered with the object's keeper. The page's origin is
 * the request's own, so a web session counts as it does at the edge; the
 * edge adds the cross-origin headers.
 */
export async function replyInObject(request: Request, env: RelayEnv, deps: Deps): Promise<Response> {
  const web = webConfig(env);
  const requestOrigin = request.headers.get("Origin");
  const origin = requestOrigin && web?.origins.includes(requestOrigin) ? requestOrigin : null;
  const key = /^\/v1\/replies\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
  if (request.method !== "POST" || !key || !REPLY_KEY.test(key) || !deps.keeper) return json(404, { error: "not_found" });
  try {
    return await messages(request, { env, deps, web, origin, replyKey: key });
  } catch (error) {
    deps.keeper.abandon();
    console.error("relay error", error instanceof Error ? error.name : "unknown");
    return json(500, { error: "server_error" });
  }
}

/**
 * The tools the app turned on, checked: only true turns one on, and a
 * container is kept only when one of this person's own replies made it.
 */
export async function toolChoice(raw: unknown, person: User, deps: Deps): Promise<ToolChoice> {
  if (typeof raw !== "object" || raw === null) return NO_TOOLS;
  const { webSearch, files, container } = raw as { webSearch?: unknown; files?: unknown; container?: unknown };
  const making = files === true;
  const own = making && typeof container === "string" && OUTPUT_ID.test(container) && await deps.registry.ownsOutput(person.id, "container", container);
  return { webSearch: webSearch === true, files: making, container: own ? container as string : null };
}

/**
 * A file one of the person's own replies made, from Anthropic's Files
 * API: its details as JSON, or its content passed through as it comes
 * (no CPU spent on it). Anyone else's file, or one never made here, is
 * "not found", the same as a file that doesn't exist.
 */
async function download(request: Request, ctx: Context, id: string, content: boolean): Promise<Response> {
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  if (!OUTPUT_ID.test(id) || !(await ctx.deps.registry.ownsOutput(person.id, "file", id))) return json(404, { error: "not_found" });
  const cfg = config(ctx.env);
  if (!cfg) return json(503, { error: "unavailable", reason: "not_configured" });
  const files = ctx.deps.files ?? anthropicFiles;
  try {
    const meta = await files.metadata(cfg, id);
    if (meta.downloadable === false) return json(404, { error: "not_found" });
    const filename = safeFilename(meta.filename);
    if (!content) return json(200, { id, filename, mimeType: meta.mime_type, size: meta.size_bytes });
    const upstream = await files.content(cfg, id, request.signal);
    if (!upstream.ok || !upstream.body) return json(upstream.status === 404 ? 404 : 502, { error: upstream.status === 404 ? "not_found" : "upstream" });
    return new Response(upstream.body, {
      status: 200,
      headers: {
        // Never shown as a page here: always a download, of a type that runs nothing.
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        ...(upstream.headers.get("Content-Length") ? { "Content-Length": upstream.headers.get("Content-Length")! } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError && (error.status === 404 || error.status === 410)) return json(404, { error: "not_found" });
    return await claudeFailure(error, ctx.deps);
  }
}

/** A file name to show and save: its last part only, no control characters, 120 characters at most. */
export function safeFilename(raw: unknown): string {
  const name = String(raw ?? "").split(/[\\/]/).pop()!.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const short = Array.from(name).slice(-120).join("");
  return short && short !== "." && short !== ".." ? short : "file";
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
  // What was wrong with a request the relay built (a tool, a container): Anthropic names the field, not the conversation.
  if (error.status === 400) console.error("claude refused because", String(error.message).slice(0, 300));
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
