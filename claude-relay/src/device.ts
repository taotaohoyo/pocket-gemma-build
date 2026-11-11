// The developer's iPhone managing the relay with Face ID (1.1.0 (262)),
// as Fielua for the web does with a passkey.
//
// When the app redeems a developer's invite, it sends the public half of
// a key it made in the iPhone's Secure Enclave, which signs only after
// Face ID (or the passcode). The invite, used once, ties that key to the
// new person, as it ties a passkey on the web; a friend's invite ties
// none. To manage, the app asks for a challenge with its access token,
// lets the key sign it, and gets an admin token (fda_) good for 15
// minutes, as the web's passkey sign-in is. The private key never leaves
// the iPhone, and an access token alone still can't manage anything.
//
//   POST /v1/admin-session/options   a challenge for this iPhone's key   (a developer's access token)
//   POST /v1/admin-session           the challenge signed: an admin token for 15 minutes

import type { Context } from "./relay";
import { caller, json } from "./relay";
import { bearer, deviceAdminHash, isAccessToken, newChallenge, newDeviceAdminToken, newID } from "./security";
import { readJSON } from "./turns";
import { fromBase64url } from "./webauthn";

const encoder = new TextEncoder();
const CURVE = { name: "ECDSA", namedCurve: "P-256" } as const;

/** What the key signs: this, then the challenge (so a signature here means nothing anywhere else). */
export const DEVICE_SIGNED_PREFIX = "fielua-claude-admin-v1:";

/**
 * A P-256 public key as the app sends it: base64url of the 65-byte
 * uncompressed point (CryptoKit's x963Representation). Null unless it is
 * a point on the curve.
 */
export async function readDeviceKey(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(raw)) return null;
  const bytes = fromBase64url(raw, 65);
  if (!bytes || bytes.length !== 65 || bytes[0] !== 4) return null;
  try {
    await crypto.subtle.importKey("raw", bytes, CURVE, false, ["verify"]);
  } catch {
    return null;
  }
  return raw;
}

/** Whether the key signed the challenge: ECDSA with SHA-256, r and s as 64 raw bytes (CryptoKit's rawRepresentation). */
export async function verifyDeviceSignature(publicKey: string, challenge: string, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const raw = fromBase64url(signature, 64);
  const point = fromBase64url(publicKey, 65);
  if (!raw || raw.length !== 64 || !point) return false;
  try {
    const key = await crypto.subtle.importKey("raw", point, CURVE, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, encoder.encode(DEVICE_SIGNED_PREFIX + challenge));
  } catch {
    return false;
  }
}

export async function deviceAdminRoutes(request: Request, path: string, ctx: Context): Promise<Response> {
  // An iPhone's access token alone: not a web session, not the admin key.
  const token = bearer(request);
  if (!token || !isAccessToken(token)) return json(401, { error: "unauthorized" });
  const person = await caller(request, ctx);
  if (person instanceof Response) return person;
  if (person.role !== "developer") return json(403, { error: "forbidden" });
  const registry = ctx.deps.registry;
  const key = await registry.deviceKey(person.id);
  if (!key) return json(403, { error: "no_device_key" });
  if (path === "/v1/admin-session/options") {
    const challenge = await registry.createChallenge({
      id: newID(), challenge: newChallenge(), purpose: "device-admin", inviteHash: null, userID: person.id,
    });
    if (!challenge) return json(429, { error: "busy" });
    return json(200, { challengeId: challenge.id, challenge: challenge.challenge });
  }
  const read = await readJSON(request);
  if (!read.ok) return json(read.error === "too_large" ? 413 : 400, { error: read.error });
  const value = (read.value ?? {}) as { challengeId?: unknown; signature?: unknown };
  const challenge = typeof value.challengeId === "string" ? await registry.takeChallenge(value.challengeId, "device-admin") : null;
  // Someone else's challenge is no challenge at all (and is used up all the same).
  if (!challenge || challenge.userID !== person.id) return json(400, { error: "expired_challenge" });
  if (!(await verifyDeviceSignature(key, challenge.challenge, value.signature))) return json(401, { error: "signature_rejected" });
  const session = newDeviceAdminToken();
  const made = await registry.createDeviceAdmin(await deviceAdminHash(session), person.id);
  return json(200, { token: session, expiresAt: made.expiresAt });
}
