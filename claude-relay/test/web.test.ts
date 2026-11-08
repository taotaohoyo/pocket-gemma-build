// Fielua for the web: passkeys, web sessions, the web app's origin, the
// developer's admin work from the browser, the models Anthropic offers
// now, and the estimate of the credit left. A software authenticator
// stands in for Face ID: real keys (P-256, Ed25519, RSA) and real
// signatures, so the relay's checks run as they would against a phone.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { RegistryCore, WEB_ADMIN_FRESH_MS, WEB_SESSION_LIFETIME_MS, type Sql } from "../src/core";
import { costMicros, type ClaudeConfig, type LiveModels, type ReplyChoice } from "../src/claude";
import { estimateTokens, meter, readReply } from "../src/meter";
import { handle, type Deps, type RegistryAPI, type RelayEnv } from "../src/relay";
import type { Turn } from "../src/turns";
import { derToRaw, fromBase64url, toBase64url } from "../src/webauthn";
import { webConfig } from "../src/web";

const ADMIN = "admin-key-for-tests-0123456789abcdef";
const BASE = "https://relay.example";
const WEB = "https://suelira.com";
const RP = "suelira.com";
const encoder = new TextEncoder();

function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*SELECT/i.test(query) ? (statement.all(...bindings) as Record<string, unknown>[]) : (statement.run(...bindings), []);
      return { toArray: () => rows };
    },
  };
}

function asyncRegistry(core: RegistryCore): RegistryAPI {
  return new Proxy({} as RegistryAPI, {
    get: (_, name: string) => async (...args: unknown[]) => (core as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args),
  });
}

// MARK: A software authenticator

type Cbor = number | Uint8Array | string | Cbor[] | Map<Cbor, Cbor>;

function cbor(value: Cbor): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const parts: number[] = [];
  const write = (v: Cbor) => {
    if (typeof v === "number") parts.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    else if (v instanceof Uint8Array) parts.push(...head(2, v.length), ...v);
    else if (typeof v === "string") { const b = encoder.encode(v); parts.push(...head(3, b.length), ...b); }
    else if (Array.isArray(v)) { parts.push(...head(4, v.length)); v.forEach(write); }
    else { parts.push(...head(5, v.size)); for (const [k, x] of v) { write(k); write(x); } }
  };
  write(value);
  return new Uint8Array(parts);
}

const b = (text: string) => fromBase64url(text)!;
const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const concat = (...arrays: Uint8Array[]) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
};

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

class SoftAuthenticator {
  keys = new Map<string, { pair: CryptoKeyPair; userHandle: string; count: number }>();
  verified = true;
  rpID = RP;
  constructor(readonly alg: -7 | -8 | -257 = -7, readonly counts = false) {}

  private async generate(): Promise<CryptoKeyPair> {
    if (this.alg === -7) return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    if (this.alg === -8) return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  }

  private async cose(pair: CryptoKeyPair): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (this.alg === -7) return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, b(jwk.x!)], [-3, b(jwk.y!)]]));
    if (this.alg === -8) return cbor(new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, b(jwk.x!)]]));
    return cbor(new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, b(jwk.n!)], [-2, b(jwk.e!)]]));
  }

  private flags(attested: boolean) {
    return (this.verified ? 0x05 : 0x01) | (attested ? 0x40 : 0);
  }

  private counter(n: number) {
    return new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }

  async create(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin = WEB, extra: { challenge?: string; type?: string } = {}) {
    const pair = await this.generate();
    const id = crypto.getRandomValues(new Uint8Array(32));
    const idText = toBase64url(id);
    this.keys.set(idText, { pair, userHandle: options.user.id, count: 0 });
    const clientData = encoder.encode(JSON.stringify({ type: extra.type ?? "webauthn.create", challenge: extra.challenge ?? options.challenge, origin, crossOrigin: false }));
    const authData = concat(await sha256(encoder.encode(this.rpID)), new Uint8Array([this.flags(true)]), this.counter(0),
      new Uint8Array(16), new Uint8Array([0, id.length]), id, await this.cose(pair));
    const attestation = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: idText, rawId: idText, type: "public-key", response: { clientDataJSON: toBase64url(clientData), attestationObject: toBase64url(attestation) } };
  }

  async get(options: { challenge: string }, origin = WEB, which?: string) {
    const [idText, key] = which ? [which, this.keys.get(which)!] : [...this.keys.entries()][0]!;
    if (this.counts) key.count++;
    const clientData = encoder.encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }));
    const authData = concat(await sha256(encoder.encode(this.rpID)), new Uint8Array([this.flags(false)]), this.counter(key.count));
    const signed = concat(authData, await sha256(clientData));
    let signature: Uint8Array;
    if (this.alg === -7) signature = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.pair.privateKey, signed)));
    else if (this.alg === -8) signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.pair.privateKey, signed));
    else signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key.pair.privateKey, signed));
    return {
      id: idText, rawId: idText, type: "public-key",
      response: { clientDataJSON: toBase64url(clientData), authenticatorData: toBase64url(authData), signature: toBase64url(signature), userHandle: key.userHandle },
    };
  }
}

// MARK: The harness

interface Harness {
  deps: Deps;
  core: RegistryCore;
  env: RelayEnv;
  clock: { now: number };
  calls: { choice: ReplyChoice; turns: Turn[] }[];
  live: LiveModels | null;
  reply: string;
  background: Promise<unknown>[];
}

let h: Harness;

beforeEach(() => {
  const clock = { now: Date.UTC(2026, 10, 8, 12) };
  const core = new RegistryCore(sqlite(), () => clock.now);
  const harness: Harness = {
    core, clock, calls: [], live: null, background: [],
    reply: "event: message_start\ndata: {}\n\n",
    env: { ANTHROPIC_API_KEY: "sk-ant-test", ADMIN_TOKEN: ADMIN, CLAUDE_MODEL: "claude-opus-5-5", WEB_ORIGINS: `${WEB},https://www.suelira.com`, WEB_RP_ID: RP },
    deps: {
      registry: asyncRegistry(core),
      now: () => clock.now,
      models: async () => harness.live,
      waitUntil: (promise) => harness.background.push(promise),
      claude: async (_cfg: ClaudeConfig, choice, turns) => {
        harness.calls.push({ choice, turns });
        return new Response(harness.reply, { headers: { "Content-Type": "text/event-stream" } });
      },
    },
  };
  h = harness;
});

function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const origin = options.origin === undefined ? WEB : options.origin;
  if (origin) headers.Origin = origin;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }
  return handle(new Request(BASE + path, { method, headers, body }), h.env, h.deps);
}

async function invite(name: string, role: "developer" | "friend"): Promise<string> {
  const made = await call("POST", "/admin/invites", { token: ADMIN, body: { name, role }, origin: null });
  return ((await made.json()) as { code: string }).code;
}

async function register(authenticator: SoftAuthenticator, code: string) {
  const asked = await call("POST", "/web/passkey/register/options", { body: { code } });
  if (asked.status !== 200) return asked;
  const options = await asked.json() as {
    challengeId: string; publicKey: { challenge: string; rp: { id: string }; user: { id: string } };
  };
  const credential = await authenticator.create(options.publicKey);
  return call("POST", "/web/passkey/register/verify", { body: { challengeId: options.challengeId, credential } });
}

async function signUp(name: string, role: "developer" | "friend", authenticator = new SoftAuthenticator()): Promise<string> {
  const response = await register(authenticator, await invite(name, role));
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: string }).session;
}

async function login(authenticator: SoftAuthenticator, origin = WEB) {
  const options = await (await call("POST", "/web/passkey/login/options", {})).json() as { challengeId: string; publicKey: { challenge: string } };
  const credential = await authenticator.get(options.publicKey, origin);
  return call("POST", "/web/passkey/login/verify", { body: { challengeId: options.challengeId, credential } });
}

const hello = { messages: [{ role: "user", content: "こんにちは" }] };

// MARK: Tests

describe("the web app's origin", () => {
  it("is the only one a browser may call from", async () => {
    const ok = await call("OPTIONS", "/v1/messages");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(ok.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(ok.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const evil = await call("OPTIONS", "/v1/messages", { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const look = await call("POST", "/web/passkey/login/options", { origin: "https://suelira.com.evil.example" });
    expect(look.status).toBe(403);
    expect(look.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("reads its config strictly", () => {
    expect(webConfig({ WEB_ORIGINS: "https://suelira.com, https://www.suelira.com/", WEB_RP_ID: "suelira.com" })?.origins).toEqual(["https://suelira.com", "https://www.suelira.com"]);
    expect(webConfig({ WEB_ORIGINS: "http://suelira.com,https://evil.example", WEB_RP_ID: "suelira.com" })).toBeNull();
    expect(webConfig({ WEB_ORIGINS: "http://localhost:8080", WEB_RP_ID: "localhost" })?.origins).toEqual(["http://localhost:8080"]);
    expect(webConfig({ WEB_ORIGINS: "", WEB_RP_ID: "suelira.com" })).toBeNull();
  });

  it("is off without its config: web sessions and /web are refused", async () => {
    const token = await signUp("開発者", "developer");
    h.env.WEB_ORIGINS = "";
    expect((await call("GET", "/v1/status", { token })).status).toBe(403);
    expect((await call("POST", "/web/passkey/login/options")).status).toBe(503);
  });
});

describe("registering with a passkey", () => {
  for (const [name, alg] of [["P-256", -7], ["Ed25519", -8], ["RSA", -257]] as const) {
    it(`takes an invite once, with a ${name} passkey, and signs in`, async () => {
      const authenticator = new SoftAuthenticator(alg);
      const code = await invite("はっちー", "developer");
      const first = await register(authenticator, code);
      expect(first.status).toBe(200);
      const data = await first.json() as { session: string; name: string; role: string; expiresAt: number };
      expect(data).toMatchObject({ name: "はっちー", role: "developer", expiresAt: h.clock.now + WEB_SESSION_LIFETIME_MS });
      expect(data.session).toMatch(/^fws_[A-Za-z0-9_-]{43}$/);
      expect((await register(new SoftAuthenticator(alg), code)).status).toBe(400);
      const status = await (await call("GET", "/v1/status", { token: data.session })).json() as Record<string, unknown>;
      expect(status).toMatchObject({ name: "はっちー", role: "developer", available: true });
      expect(h.core.listUsers()[0]).toMatchObject({ kind: "web" });
      const again = await login(authenticator);
      expect(again.status).toBe(200);
    });
  }

  it("refuses a wrong code before any passkey is made, and counts it", async () => {
    const wrong = await call("POST", "/web/passkey/register/options", { body: { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_code" });
    for (let i = 0; i < 29; i++) await call("POST", "/web/passkey/register/options", { body: { code: "nope" } });
    const code = await invite("友人", "friend");
    expect((await call("POST", "/web/passkey/register/options", { body: { code } })).status).toBe(429);
  });

  it("refuses an answer to another challenge, origin or site, or without Face ID", async () => {
    const code = await invite("友人", "friend");
    const cases: [string, (a: SoftAuthenticator, o: { challenge: string; rp: { id: string }; user: { id: string } }) => Promise<unknown>][] = [
      ["wrong_challenge", (a, o) => a.create(o, WEB, { challenge: toBase64url(new Uint8Array(32)) })],
      ["wrong_origin", (a, o) => a.create(o, "https://evil.example")],
      ["wrong_type", (a, o) => a.create(o, WEB, { type: "webauthn.get" })],
      ["wrong_rp", (a, o) => { a.rpID = "evil.example"; return a.create(o); }],
      ["not_verified", (a, o) => { a.verified = false; return a.create(o); }],
    ];
    for (const [reason, make] of cases) {
      const options = await (await call("POST", "/web/passkey/register/options", { body: { code } })).json() as { challengeId: string; publicKey: never };
      const credential = await make(new SoftAuthenticator(), options.publicKey);
      const response = await call("POST", "/web/passkey/register/verify", { body: { challengeId: options.challengeId, credential } });
      expect(response.status, reason).toBe(400);
      expect(await response.json()).toEqual({ error: "passkey_rejected", reason });
    }
    // The invite is still there for the right answer.
    expect((await register(new SoftAuthenticator(), code)).status).toBe(200);
  });

  it("uses a challenge once, and not after five minutes", async () => {
    const code = await invite("友人", "friend");
    const options = await (await call("POST", "/web/passkey/register/options", { body: { code } })).json() as { challengeId: string; publicKey: never };
    const authenticator = new SoftAuthenticator();
    const credential = await authenticator.create(options.publicKey);
    h.clock.now += 5 * 60 * 1000 + 1;
    const late = await call("POST", "/web/passkey/register/verify", { body: { challengeId: options.challengeId, credential } });
    expect(await late.json()).toEqual({ error: "expired_challenge" });
    const twice = await call("POST", "/web/passkey/register/verify", { body: { challengeId: options.challengeId, credential } });
    expect(await twice.json()).toEqual({ error: "expired_challenge" });
  });

  it("asks for a resident passkey with Face ID, for suelira.com", async () => {
    const code = await invite("友人", "friend");
    const options = await (await call("POST", "/web/passkey/register/options", { body: { code } })).json() as { publicKey: Record<string, unknown> };
    expect(options.publicKey).toMatchObject({
      rp: { id: RP, name: "Fielua" },
      user: { name: "友人", displayName: "友人" },
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    });
  });
});

describe("signing in", () => {
  it("refuses a tampered signature, another origin, an unknown passkey, and a revoked person", async () => {
    const authenticator = new SoftAuthenticator();
    await signUp("友人", "friend", authenticator);
    const options = await (await call("POST", "/web/passkey/login/options")).json() as { challengeId: string; publicKey: { challenge: string } };
    const credential = await authenticator.get(options.publicKey);
    const signature = b(credential.response.signature);
    signature[signature.length - 1] ^= 1;
    credential.response.signature = toBase64url(signature);
    const tampered = await call("POST", "/web/passkey/login/verify", { body: { challengeId: options.challengeId, credential } });
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({ error: "passkey_rejected" });

    expect(await (await login(authenticator, "https://evil.example")).json()).toEqual({ error: "passkey_rejected", reason: "wrong_origin" });
    const stranger = new SoftAuthenticator();
    await stranger.create({ challenge: "x", rp: { id: RP }, user: { id: "x" } });
    expect(await (await login(stranger)).json()).toMatchObject({ error: "unknown_passkey" });

    const id = h.core.listUsers()[0]!.id;
    await call("POST", `/admin/users/${id}/revoke`, { token: ADMIN, origin: null });
    expect((await login(authenticator)).status).toBe(403);
  });

  it("refuses a counter that goes backwards", async () => {
    const authenticator = new SoftAuthenticator(-7, true);
    await signUp("友人", "friend", authenticator);
    expect((await login(authenticator)).status).toBe(200);
    const key = [...authenticator.keys.values()][0]!;
    key.count = 0; // a copy of the key, behind the real one
    expect(await (await login(authenticator)).json()).toEqual({ error: "passkey_rejected", reason: "counter" });
  });

  it("gives sessions that last 12 hours, work only from the web app, and end at logout", async () => {
    const token = await signUp("開発者", "developer");
    expect((await call("GET", "/v1/status", { token, origin: null })).status).toBe(403);
    expect((await call("GET", "/v1/status", { token, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("GET", "/v1/status", { token, origin: "https://www.suelira.com" })).status).toBe(200);
    expect(JSON.stringify(h.core.listUsers())).not.toContain(token);
    expect((await call("POST", "/web/logout", { token })).status).toBe(200);
    expect((await call("GET", "/v1/status", { token })).status).toBe(401);

    const authenticator = new SoftAuthenticator();
    const later = await signUp("友人", "friend", authenticator);
    h.clock.now += WEB_SESSION_LIFETIME_MS;
    expect((await call("GET", "/v1/status", { token: later })).status).toBe(401);
  });

  it("ends with 登録を解除: passkeys and sessions go with the person", async () => {
    const authenticator = new SoftAuthenticator();
    const token = await signUp("友人", "friend", authenticator);
    expect((await call("POST", "/v1/leave", { token })).status).toBe(200);
    expect(h.core.listUsers()).toHaveLength(0);
    expect((await call("GET", "/v1/status", { token })).status).toBe(401);
    expect(await (await login(authenticator)).json()).toMatchObject({ error: "unknown_passkey" });
  });
});

describe("chatting from the web", () => {
  it("sends the chosen model and level, and friends wait for the switch", async () => {
    const developer = await signUp("開発者", "developer");
    const reply = await call("POST", "/v1/messages", { token: developer, body: { ...hello, model: "claude-opus-5-5", effort: "xhigh" } });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(reply.headers.get("Access-Control-Expose-Headers")).toContain("X-Fielua-Effort");
    expect(h.calls.at(-1)!.choice).toMatchObject({ model: { id: "claude-opus-5-5" }, effort: "xhigh", maxTokens: 64000 });

    const friend = await signUp("友人", "friend");
    const refused = await call("POST", "/v1/messages", { token: friend, body: hello });
    expect(await refused.json()).toEqual({ error: "unavailable", reason: "friends_disabled" });
    expect(h.calls).toHaveLength(1);
  });

  it("disables what Anthropic doesn't offer now, and sends none of it", async () => {
    const token = await signUp("開発者", "developer");
    h.live = new Map([
      ["claude-opus-5-5", { id: "claude-opus-5-5", efforts: ["low", "medium", "high", "max"] }],
      ["claude-sonnet-5-5", { id: "claude-sonnet-5-5", efforts: null }],
      ["claude-haiku-5-5", { id: "claude-haiku-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] }],
    ]);
    const status = await (await call("GET", "/v1/status", { token })).json() as { models: { id: string; efforts: string[]; available: boolean | null }[] };
    expect(status.models.map((m) => [m.id, m.available, m.efforts.join("/")])).toEqual([
      ["claude-opus-5-5", true, "low/medium/high"],
      ["claude-fable-5-1", false, "low/medium/high/xhigh"],
      ["claude-sonnet-5-5", true, "low/medium/high/xhigh"],
      ["claude-haiku-5-5", true, "low/medium/high/xhigh"],
    ]);
    const fable = await call("POST", "/v1/messages", { token, body: { ...hello, model: "claude-fable-5-1" } });
    expect(await fable.json()).toEqual({ error: "model_unavailable" });
    const xhigh = await call("POST", "/v1/messages", { token, body: { ...hello, model: "claude-opus-5-5", effort: "xhigh" } });
    expect(await xhigh.json()).toEqual({ error: "unsupported_effort" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("the developer's admin work from the web", () => {
  it("needs a passkey sign-in at most 15 minutes old, and is never a friend's", async () => {
    const authenticator = new SoftAuthenticator();
    const token = await signUp("開発者", "developer", authenticator);
    expect((await call("GET", "/admin/state", { token })).status).toBe(200);
    const status = await (await call("GET", "/v1/status", { token })).json() as { web: { adminUntil: number } };
    expect(status.web.adminUntil).toBe(h.clock.now + WEB_ADMIN_FRESH_MS);
    h.clock.now += WEB_ADMIN_FRESH_MS + 1;
    const stale = await call("POST", "/admin/invites", { token, body: { name: "友人", role: "friend" } });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "reauth_required" });
    const fresh = ((await (await login(authenticator)).json()) as { session: string }).session;
    expect((await call("POST", "/admin/invites", { token: fresh, body: { name: "友人", role: "friend" } })).status).toBe(200);

    const friend = await signUp("友人", "friend");
    expect(await (await call("GET", "/admin/state", { token: friend })).json()).toEqual({ error: "forbidden" });
    expect((await call("POST", "/admin/settings", { token: friend, body: { friendsEnabled: true } })).status).toBe(403);
    expect(h.core.settings().friendsEnabled).toBe(false);
  });

  it("shows where each person registered", async () => {
    await signUp("Web の友人", "friend");
    await call("POST", "/v1/redeem", { body: { code: await invite("iPhone の友人", "friend") }, origin: null });
    const state = await (await call("GET", "/admin/state", { token: ADMIN, origin: null })).json() as { users: { name: string; kind: string }[] };
    expect(state.users.map((u) => [u.name, u.kind])).toEqual([["Web の友人", "web"], ["iPhone の友人", "device"]]);
  });
});

describe("the estimate of the credit left", () => {
  const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

  it("counts each reply's usage against the balance the developer entered", async () => {
    const token = await signUp("開発者", "developer");
    expect(((await (await call("GET", "/v1/status", { token })).json()) as { credit: unknown }).credit).toBeNull();
    const set = await call("POST", "/admin/settings", { token, body: { creditUSD: 10 } });
    expect(await set.json()).toMatchObject({ credit: { budgetUSD: 10, remainingUSD: 10, percent: 100, estimated: true } });
    h.reply = sse([
      ["message_start", { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 100000, cache_read_input_tokens: 0, output_tokens: 1 } } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "こんにちは" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50000 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    const reply = await call("POST", "/v1/messages", { token, body: hello });
    expect(await reply.text()).toBe(h.reply); // unchanged on the way
    await Promise.all(h.background);
    // 100,000 × $4 + 50,000 × $20 per million = $0.40 + $1.00
    const status = await (await call("GET", "/v1/status", { token })).json() as { credit: Record<string, number> };
    expect(status.credit).toMatchObject({ spentUSD: 1.4, remainingUSD: 8.6, percent: 86 });
  });

  it("is the developer's unless shown to friends, and 0% once the credit ran out", async () => {
    h.core.setFriendsEnabled(true);
    h.core.setCredit(5_000_000);
    const friend = await signUp("友人", "friend");
    expect(((await (await call("GET", "/v1/status", { token: friend })).json()) as { credit: unknown }).credit).toBeNull();
    h.core.setCreditFriends(true);
    expect(((await (await call("GET", "/v1/status", { token: friend })).json()) as { credit: { percent: number } }).credit.percent).toBe(100);
    h.core.pause("billing");
    expect(((await (await call("GET", "/v1/status", { token: friend })).json()) as { credit: { percent: number } }).credit.percent).toBe(0);
  });

  it("refuses a balance that can't be one", async () => {
    for (const creditUSD of [0, -1, 1e9, "10"]) {
      expect((await call("POST", "/admin/settings", { token: ADMIN, body: { creditUSD }, origin: null })).status).toBe(400);
    }
  });

  it("prices each model, Haiku's long prompts and cache reads included", () => {
    expect(costMicros("claude-fable-5-1", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10_000_000);
    expect(costMicros("claude-sonnet-5-5", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBe(200_000 + 2_500_000);
    expect(costMicros("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 1_000 })).toBe(5_000 + 500);
    expect(costMicros("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 1_000 })).toBe(75_000 + 2_500);
  });

  it("counts a stopped reply by its length", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"message":{"model":"claude-opus-5-5","usage":{"input_tokens":1000}}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"日本語の返信 and English"}}\n\n'));
      },
    });
    // The app's connection ends (the request's signal), as when the person presses stop.
    const stopped = new AbortController();
    const metered = meter(source, "claude-opus-5-5", stopped.signal, false);
    const reader = metered.body.getReader();
    await reader.read();
    await reader.read();
    stopped.abort();
    await reader.cancel();
    expect(estimateTokens("日本語の返信 and English")).toBe(9);
    expect(await metered.cost).toBe(1000 * 4 + 9 * 20);
  });
});

describe("a long reply, read once at its end", () => {
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const long = (withFile: boolean) => encoder.encode([
    ev("message_start", { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 2000, output_tokens: 1 } } }),
    ...Array.from({ length: 3000 }, (_, i) => ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `文章の続き ${i}` } })),
    ...(withFile ? [ev("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "bash_code_execution_tool_result", content: { content: [{ file_id: "file_middle01" }] } } })] : []),
    ...Array.from({ length: 3000 }, () => ev("content_block_delta", { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "後半" } })),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", container: { id: "container_end01" } }, usage: { output_tokens: 9000 } }),
    ev("message_stop", { type: "message_stop" }),
  ].join(""));

  it("counts it from its start and its end", () => {
    const bytes = long(false);
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    const read = readReply(bytes, "claude-opus-5-5", false);
    expect(read.micros).toBe(2000 * 4 + 9000 * 20);
    expect(read.outputs.container).toBe("container_end01");
  });

  it("finds a file made in the middle when code could run", () => {
    expect(readReply(long(true), "claude-opus-5-5", true).outputs.files).toEqual(["file_middle01"]);
  });
});

describe("ECDSA signatures", () => {
  it("are read from DER with and without padding", () => {
    const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    const small = new Uint8Array(64);
    small[31] = 1;
    small[63] = 2;
    expect(derToRaw(rawToDer(small))).toEqual(small);
  });
});
