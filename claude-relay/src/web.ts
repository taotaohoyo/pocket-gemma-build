// Signing in to Fielua for the web (https://suelira.com/chat/) with a
// passkey. A friend (or the developer) registers once with an invite code
// the developer made, which the passkey then replaces; after that, Face
// ID (or the device's own check) signs them in. Each sign-in gives the
// browser a session token that works only from the web app's origin and
// lapses after 12 hours. Nothing here sets a cookie.

import type { Context } from "./relay";
import { json } from "./relay";
import { inviteHash, isWebSessionToken, bearer, newChallenge, newID, newWebSessionToken, normalizeInviteCode, webSessionHash } from "./security";
import { readJSON } from "./turns";
import { COSE_ALGORITHMS, readAssertion, toBase64url, verifyAssertion, verifyRegistration, type WebAuthnConfig } from "./webauthn";

export interface WebConfig extends WebAuthnConfig {
  rpName: string;
}

const encoder = new TextEncoder();

/**
 * WEB_ORIGINS and WEB_RP_ID, checked: https origins on the RP's domain
 * (http only for localhost, for the tests). Null turns /web/* off and
 * refuses web sessions everywhere.
 */
export function webConfig(env: { WEB_ORIGINS?: string; WEB_RP_ID?: string }): WebConfig | null {
  const rpID = (env.WEB_RP_ID ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(rpID)) return null;
  const origins = (env.WEB_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => {
      const match = /^(https?):\/\/([a-z0-9.-]+)(:\d+)?$/.exec(origin);
      if (!match) return false;
      const [, scheme, host] = match;
      if (scheme === "http" && host !== "localhost") return false;
      return host === rpID || host!.endsWith("." + rpID);
    });
  if (origins.length === 0) return null;
  return { rpID, origins, rpName: "Fielua" };
}

/**
 * Fielua for the web's own page (WEB_APP_URL, e.g. https://suelira.com/chat/),
 * where the invite page sends a person who registers in the browser: only
 * on one of WEB_ORIGINS, without a query or a fragment. Null hides that
 * choice (the web is off, or the address is not the web's).
 */
export function webAppURL(env: { WEB_APP_URL?: string }, web: WebConfig | null): string | null {
  if (!web || !env.WEB_APP_URL) return null;
  let url: URL;
  try { url = new URL(env.WEB_APP_URL.trim()); } catch { return null; }
  if (url.search || url.hash || url.username || url.password) return null;
  if (!web.origins.includes(url.origin)) return null;
  return url.origin + url.pathname;
}

const TIMEOUT_MS = 120_000;

export async function webRoutes(request: Request, path: string, ctx: Context): Promise<Response> {
  if (!ctx.web) return json(503, { error: "web_not_configured" });
  // Only the web app's own pages: a request from anywhere else is refused before anything is read.
  if (!ctx.origin) return json(403, { error: "forbidden_origin" });
  if (request.method !== "POST") return json(404, { error: "not_found" });
  switch (path) {
    case "/web/passkey/register/options": return registerOptions(request, ctx, ctx.web);
    case "/web/passkey/register/verify": return registerVerify(request, ctx, ctx.web);
    case "/web/passkey/login/options": return loginOptions(ctx, ctx.web);
    case "/web/passkey/login/verify": return loginVerify(request, ctx, ctx.web);
    case "/web/logout": return logout(request, ctx);
    default: return json(404, { error: "not_found" });
  }
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  const read = await readJSON(request);
  if (!read.ok) return json(read.error === "too_large" ? 413 : 400, { error: read.error });
  if (typeof read.value !== "object" || read.value === null) return json(400, { error: "bad_request" });
  return read.value as Record<string, unknown>;
}

/** An invite code for the options of a new passkey. The code is only looked at here; it is used up once the passkey is made. */
async function registerOptions(request: Request, ctx: Context, web: WebConfig): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  const code = typeof value.code === "string" ? normalizeInviteCode(value.code) : null;
  const codeHash = await inviteHash(code ?? "-");
  const checked = await ctx.deps.registry.checkInvite(codeHash);
  if (!checked.ok) return json(checked.error === "too_many_attempts" ? 429 : 400, { error: checked.error });
  const userID = newID();
  const challenge = await ctx.deps.registry.createChallenge({
    id: newID(), challenge: newChallenge(), purpose: "register", inviteHash: codeHash, userID,
  });
  if (!challenge) return json(429, { error: "busy" });
  const name = checked.invite.name;
  return json(200, {
    challengeId: challenge.id,
    invite: { name, role: checked.invite.role },
    publicKey: {
      challenge: challenge.challenge,
      rp: { id: web.rpID, name: web.rpName },
      user: { id: toBase64url(encoder.encode(userID)), name, displayName: name },
      pubKeyCredParams: COSE_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      attestation: "none",
      timeout: TIMEOUT_MS,
    },
  });
}

async function registerVerify(request: Request, ctx: Context, web: WebConfig): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  const challenge = typeof value.challengeId === "string" ? await ctx.deps.registry.takeChallenge(value.challengeId, "register") : null;
  if (!challenge || !challenge.inviteHash || !challenge.userID) return json(400, { error: "expired_challenge" });
  const verified = await verifyRegistration(value.credential, challenge.challenge, web);
  if (!verified.ok) return json(400, { error: "passkey_rejected", reason: verified.error });
  const redeemed = await ctx.deps.registry.redeemWithPasskey(challenge.inviteHash, challenge.userID, {
    id: verified.value.credentialID, key: verified.value.key, signCount: verified.value.signCount,
  });
  if (!redeemed.ok) return json(redeemed.error === "too_many_attempts" ? 429 : 400, { error: redeemed.error });
  return session(ctx, redeemed.user.id, redeemed.user.name, redeemed.user.role);
}

async function loginOptions(ctx: Context, web: WebConfig): Promise<Response> {
  const challenge = await ctx.deps.registry.createChallenge({ id: newID(), challenge: newChallenge(), purpose: "login", inviteHash: null, userID: null });
  if (!challenge) return json(429, { error: "busy" });
  return json(200, {
    challengeId: challenge.id,
    // No list of passkeys: the browser offers the ones it has for this site.
    publicKey: { challenge: challenge.challenge, rpId: web.rpID, userVerification: "required", allowCredentials: [], timeout: TIMEOUT_MS },
  });
}

async function loginVerify(request: Request, ctx: Context, web: WebConfig): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  const challenge = typeof value.challengeId === "string" ? await ctx.deps.registry.takeChallenge(value.challengeId, "login") : null;
  if (!challenge) return json(400, { error: "expired_challenge" });
  const assertion = readAssertion(value.credential);
  if (!assertion) return json(400, { error: "passkey_rejected", reason: "bad_credential" });
  const passkey = await ctx.deps.registry.passkey(assertion.credentialID);
  const person = passkey ? await ctx.deps.registry.user(passkey.userID) : null;
  // The passkey's own id is said back, so the page can tell the browser to forget a passkey the relay no longer knows.
  if (!passkey || !person) return json(401, { error: "unknown_passkey", credentialId: assertion.credentialID });
  const handle = (value.credential as { response?: { userHandle?: unknown } }).response?.userHandle;
  if (typeof handle === "string" && handle !== "" && handle !== toBase64url(encoder.encode(person.id))) {
    return json(401, { error: "passkey_rejected", reason: "bad_credential" });
  }
  const verified = await verifyAssertion(assertion, passkey.key, passkey.signCount, challenge.challenge, web);
  if (!verified.ok) return json(401, { error: "passkey_rejected", reason: verified.error });
  await ctx.deps.registry.usedPasskey(passkey.id, verified.value);
  if (person.status !== "active") return json(403, { error: "revoked" });
  return session(ctx, person.id, person.name, person.role);
}

async function session(ctx: Context, userID: string, name: string, role: string): Promise<Response> {
  const token = newWebSessionToken();
  const made = await ctx.deps.registry.createSession(await webSessionHash(token), userID);
  return json(200, { session: token, expiresAt: made.expiresAt, name, role });
}

async function logout(request: Request, ctx: Context): Promise<Response> {
  const token = bearer(request);
  if (token && isWebSessionToken(token)) await ctx.deps.registry.endSession(await webSessionHash(token));
  return json(200, { ok: true });
}
