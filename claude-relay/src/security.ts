// Tokens, invite codes and the admin key: how they are made, written and compared.

const encoder = new TextEncoder();

/** An access token: "fcl_" and 32 random bytes in base64url. Given to the app once; only its hash is kept. */
export function newAccessToken(): string {
  return "fcl_" + base64url(randomBytes(32));
}

export function isAccessToken(text: string): boolean {
  return /^fcl_[A-Za-z0-9_-]{43}$/.test(text);
}

/**
 * A web session token: "fws_" and 32 random bytes in base64url, given to
 * the browser after a passkey sign-in and kept only as its hash. It works
 * only from the web app's own origin (WEB_ORIGINS) and lapses after 12 hours.
 */
export function newWebSessionToken(): string {
  return "fws_" + base64url(randomBytes(32));
}

export function isWebSessionToken(text: string): boolean {
  return /^fws_[A-Za-z0-9_-]{43}$/.test(text);
}

export async function webSessionHash(token: string): Promise<string> {
  return sha256hex("fielua-web-session-v1:" + token);
}

/**
 * The developer's iPhone managing the relay (1.1.0 (262)): "fda_" and 32
 * random bytes in base64url, given after Face ID let the iPhone's own key
 * sign the relay's challenge (device.ts), kept only as its hash, and good
 * for 15 minutes, as a passkey sign-in is for the web's management.
 */
export function newDeviceAdminToken(): string {
  return "fda_" + base64url(randomBytes(32));
}

export function isDeviceAdminToken(text: string): boolean {
  return /^fda_[A-Za-z0-9_-]{43}$/.test(text);
}

export async function deviceAdminHash(token: string): Promise<string> {
  return sha256hex("fielua-device-admin-v1:" + token);
}

/** A WebAuthn challenge: 32 random bytes in base64url. */
export function newChallenge(): string {
  return base64url(randomBytes(32));
}

/** Crockford's base32, without I, L, O and U, so a code read aloud or typed is hard to get wrong. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** An invite code: 16 characters (80 bits), shown as four groups of four. */
export function newInviteCode(): string {
  const bytes = randomBytes(16);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code.match(/.{4}/g)!.join("-");
}

/** The code as typed: case, dashes and spaces ignored, and O, I, L read as 0, 1, 1. Null when it can't be one. */
export function normalizeInviteCode(text: string): string | null {
  const cleaned = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (cleaned.length !== 16) return null;
  for (const char of cleaned) if (!CODE_ALPHABET.includes(char)) return null;
  return cleaned;
}

/**
 * A person's history key: 32 random bytes in base64url. Fielua for the web
 * encrypts the conversations it keeps on the person's own device with it, so
 * they can be read there only after signing in. The relay keeps the key and
 * never sees a conversation.
 */
export function newHistoryKey(): string {
  return base64url(randomBytes(32));
}

export function newID(): string {
  return base64url(randomBytes(12));
}

export async function tokenHash(token: string): Promise<string> {
  return sha256hex("fielua-claude-token-v1:" + token);
}

export async function inviteHash(normalizedCode: string): Promise<string> {
  return sha256hex("fielua-claude-invite-v1:" + normalizedCode);
}

/**
 * The admin key against the Worker's secret, in constant time (their
 * hashes are compared, so the length doesn't show either). A secret
 * shorter than 32 characters turns the admin routes off.
 */
export async function adminKeyMatches(given: string | null, secret: string | undefined): Promise<boolean> {
  if (!given || !secret || secret.length < 32) return false;
  const [a, b] = await Promise.all([sha256(encoder.encode(given)), sha256(encoder.encode(secret))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1]! : null;
}

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function sha256hex(text: string): Promise<string> {
  const digest = await sha256(encoder.encode(text));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
