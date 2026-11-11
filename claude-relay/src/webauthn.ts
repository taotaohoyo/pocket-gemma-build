// Passkeys (WebAuthn) for Fielua on the web (https://suelira.com/chat/).
//
// The browser and the person's passkey (Face ID, Touch ID, Windows Hello,
// a security key) do the asking; the relay only checks what comes back:
// that it answers the challenge the relay gave, for the web app's own
// origin and relying party, with the person verified, signed by a key the
// relay registered. No attestation is asked for, and nothing here needs a
// library: a little CBOR, and WebCrypto for the signatures.

const encoder = new TextEncoder();

/** The algorithms a passkey may sign with: Ed25519, ES256 (P-256) and RS256, as COSE numbers. */
export const COSE_ALGORITHMS = [-8, -7, -257] as const;
export type CoseAlgorithm = (typeof COSE_ALGORITHMS)[number];

export interface WebAuthnConfig {
  /** The relying party: the web app's registrable domain ("suelira.com"). */
  rpID: string;
  /** Where the web app may run ("https://suelira.com", "https://www.suelira.com"). */
  origins: readonly string[];
}

/** A registered passkey's public key, kept as a JWK with its algorithm. */
export interface StoredKey {
  alg: CoseAlgorithm;
  jwk: JsonWebKey;
}

export type WebAuthnError =
  | "bad_credential"
  | "wrong_type"
  | "wrong_challenge"
  | "wrong_origin"
  | "wrong_rp"
  | "not_verified"
  | "unsupported_key"
  | "bad_signature"
  | "counter";

export type Result<T> = { ok: true; value: T } | { ok: false; error: WebAuthnError };

// MARK: base64url

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: unknown, maxBytes = 16 * 1024): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0 || text.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return null;
  const clean = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// MARK: CBOR (the subset WebAuthn uses: definite lengths, no floats)

type CborValue = number | bigint | Uint8Array | string | CborValue[] | Map<CborValue, CborValue> | boolean | null | undefined;

class CborReader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array, private depth = 0) {}

  read(): CborValue {
    if (this.depth > 16) throw new Error("cbor: too deep");
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      throw new Error("cbor: unsupported simple value");
    }
    const length = this.length(info);
    switch (major) {
      case 0: return length;
      case 1: return typeof length === "bigint" ? -1n - length : -1 - length;
      case 2: return this.take(Number(length));
      case 3: return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(this.take(Number(length)));
      case 4: {
        const items: CborValue[] = [];
        this.depth++;
        for (let i = 0; i < Number(length); i++) items.push(this.read());
        this.depth--;
        return items;
      }
      case 5: {
        const map = new Map<CborValue, CborValue>();
        this.depth++;
        for (let i = 0; i < Number(length); i++) {
          const key = this.read();
          map.set(key, this.read());
        }
        this.depth--;
        return map;
      }
      case 6: return this.read(); // a tag: its value is all WebAuthn needs
      default: throw new Error("cbor: bad major type");
    }
  }

  private length(info: number): number | bigint {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return (this.byte() << 8) | this.byte();
    if (info === 26) return ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
    if (info === 27) {
      let value = 0n;
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(this.byte());
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    throw new Error("cbor: indefinite or reserved length");
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("cbor: truncated");
    return this.bytes[this.offset++]!;
  }

  take(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.bytes.length) throw new Error("cbor: truncated");
    const slice = this.bytes.slice(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
}

/** One CBOR item from the start of `bytes`, and where it ended. */
export function decodeCbor(bytes: Uint8Array): { value: CborValue; length: number } {
  const reader = new CborReader(bytes);
  const value = reader.read();
  return { value, length: reader.offset };
}

// MARK: Authenticator data

export interface AuthenticatorData {
  rpIDHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialID?: Uint8Array;
  publicKey?: Map<CborValue, CborValue>;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new Error("authData: short");
  const flags = bytes[32]!;
  const signCount = ((bytes[33]! << 24) >>> 0) + (bytes[34]! << 16) + (bytes[35]! << 8) + bytes[36]!;
  const data: AuthenticatorData = {
    rpIDHash: bytes.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount,
  };
  if (flags & 0x40) {
    // Attested credential data: AAGUID (16), the id's length (2), the id, the COSE key.
    let offset = 37 + 16;
    if (bytes.length < offset + 2) throw new Error("authData: short");
    const idLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
    if (idLength === 0 || idLength > 1023 || bytes.length < offset + idLength) throw new Error("authData: bad credential id");
    data.credentialID = bytes.slice(offset, offset + idLength);
    offset += idLength;
    const { value } = decodeCbor(bytes.slice(offset));
    if (!(value instanceof Map)) throw new Error("authData: bad key");
    data.publicKey = value;
  }
  return data;
}

// MARK: COSE keys

/** A COSE public key as a JWK WebCrypto can import; null for a kind the relay doesn't take. */
export function coseToKey(cose: Map<CborValue, CborValue>): StoredKey | null {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label: number) => {
    const value = cose.get(label);
    return value instanceof Uint8Array ? value : null;
  };
  if (alg === -7 && kty === 2 && cose.get(-1) === 1) {
    const x = bytes(-2), y = bytes(-3);
    if (!x || !y || x.length !== 32 || y.length !== 32) return null;
    return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: toBase64url(x), y: toBase64url(y) } };
  }
  if (alg === -257 && kty === 3) {
    const n = bytes(-1), e = bytes(-2);
    if (!n || !e || n.length < 256) return null; // RSA 2048 bits at least
    return { alg: -257, jwk: { kty: "RSA", n: toBase64url(n), e: toBase64url(e) } };
  }
  if (alg === -8 && kty === 1 && cose.get(-1) === 6) {
    const x = bytes(-2);
    if (!x || x.length !== 32) return null;
    return { alg: -8, jwk: { kty: "OKP", crv: "Ed25519", x: toBase64url(x) } };
  }
  return null;
}

async function importKey(key: StoredKey): Promise<CryptoKey> {
  const jwk = { ...key.jwk, ext: true };
  if (key.alg === -7) return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (key.alg === -257) return crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
}

/** ECDSA signatures come DER-encoded; WebCrypto wants r and s side by side, 32 bytes each. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30) return null;
  let offset = 2;
  if (der[1]! & 0x80) offset = 2 + (der[1]! & 0x7f);
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[offset] !== 0x02) return null;
    let length = der[offset + 1]!;
    offset += 2;
    let start = offset;
    while (length > 32 && der[start] === 0) { start++; length--; }
    if (length > 32 || start + length > der.length) return null;
    out.set(der.slice(start, start + length), part * 32 + (32 - length));
    offset = start + length;
  }
  return out;
}

async function verifySignature(key: StoredKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const cryptoKey = await importKey(key);
    if (key.alg === -7) {
      const raw = derToRaw(signature);
      if (!raw) return false;
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, raw, data);
    }
    if (key.alg === -257) return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, cryptoKey, signature, data);
    return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signature, data);
  } catch {
    return false;
  }
}

// MARK: The two ceremonies

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function parseClientData(bytes: Uint8Array): ClientData | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Partial<ClientData>;
    if (typeof value.type !== "string" || typeof value.challenge !== "string" || typeof value.origin !== "string") return null;
    return value as ClientData;
  } catch {
    return null;
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function checkClientData(client: ClientData | null, type: string, challenge: string, cfg: WebAuthnConfig): WebAuthnError | null {
  if (!client) return "bad_credential";
  if (client.type !== type) return "wrong_type";
  if (!equal(encoder.encode(client.challenge), encoder.encode(challenge))) return "wrong_challenge";
  if (!cfg.origins.includes(client.origin) || client.crossOrigin === true) return "wrong_origin";
  return null;
}

async function checkAuthData(auth: AuthenticatorData, cfg: WebAuthnConfig): Promise<WebAuthnError | null> {
  if (!equal(auth.rpIDHash, await sha256(encoder.encode(cfg.rpID)))) return "wrong_rp";
  // Face ID, Touch ID or the device's PIN: a passkey on an unlocked phone isn't enough.
  if (!auth.userPresent || !auth.userVerified) return "not_verified";
  return null;
}

export interface NewPasskey {
  credentialID: string;
  key: StoredKey;
  signCount: number;
}

/** A new passkey, from navigator.credentials.create()'s answer (its byte fields in base64url). */
export async function verifyRegistration(credential: unknown, challenge: string, cfg: WebAuthnConfig): Promise<Result<NewPasskey>> {
  const c = credential as { id?: unknown; type?: unknown; response?: { clientDataJSON?: unknown; attestationObject?: unknown } } | null;
  if (!c || c.type !== "public-key" || typeof c.id !== "string" || !c.response) return { ok: false, error: "bad_credential" };
  const clientBytes = fromBase64url(c.response.clientDataJSON);
  const attestationBytes = fromBase64url(c.response.attestationObject, 64 * 1024);
  if (!clientBytes || !attestationBytes) return { ok: false, error: "bad_credential" };
  const clientError = checkClientData(parseClientData(clientBytes), "webauthn.create", challenge, cfg);
  if (clientError) return { ok: false, error: clientError };
  let auth: AuthenticatorData;
  try {
    const { value } = decodeCbor(attestationBytes);
    const authData = value instanceof Map ? value.get("authData") : null;
    if (!(authData instanceof Uint8Array)) return { ok: false, error: "bad_credential" };
    // The attestation statement isn't checked: the relay asks for none,
    // and who made the passkey doesn't change whom it lets in.
    auth = parseAuthenticatorData(authData);
  } catch {
    return { ok: false, error: "bad_credential" };
  }
  const authError = await checkAuthData(auth, cfg);
  if (authError) return { ok: false, error: authError };
  if (!auth.credentialID || !auth.publicKey) return { ok: false, error: "bad_credential" };
  const credentialID = toBase64url(auth.credentialID);
  if (credentialID !== c.id) return { ok: false, error: "bad_credential" };
  const key = coseToKey(auth.publicKey);
  if (!key) return { ok: false, error: "unsupported_key" };
  return { ok: true, value: { credentialID, key, signCount: auth.signCount } };
}

export interface Assertion {
  credentialID: string;
  clientData: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}

/** navigator.credentials.get()'s answer, read: which passkey it claims to be. */
export function readAssertion(credential: unknown): Assertion | null {
  const c = credential as { id?: unknown; type?: unknown; response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown } } | null;
  if (!c || c.type !== "public-key" || typeof c.id !== "string" || !c.response) return null;
  const clientData = fromBase64url(c.response.clientDataJSON);
  const authenticatorData = fromBase64url(c.response.authenticatorData);
  const signature = fromBase64url(c.response.signature, 1024);
  const id = fromBase64url(c.id, 1023);
  if (!clientData || !authenticatorData || !signature || !id) return null;
  return { credentialID: toBase64url(id), clientData, authenticatorData, signature };
}

/** The assertion against the passkey it names: the new signature counter when it holds. */
export async function verifyAssertion(assertion: Assertion, key: StoredKey, storedCount: number, challenge: string, cfg: WebAuthnConfig): Promise<Result<number>> {
  const clientError = checkClientData(parseClientData(assertion.clientData), "webauthn.get", challenge, cfg);
  if (clientError) return { ok: false, error: clientError };
  let auth: AuthenticatorData;
  try {
    auth = parseAuthenticatorData(assertion.authenticatorData);
  } catch {
    return { ok: false, error: "bad_credential" };
  }
  const authError = await checkAuthData(auth, cfg);
  if (authError) return { ok: false, error: authError };
  const clientHash = await sha256(assertion.clientData);
  const signed = new Uint8Array(assertion.authenticatorData.length + clientHash.length);
  signed.set(assertion.authenticatorData, 0);
  signed.set(clientHash, assertion.authenticatorData.length);
  if (!(await verifySignature(key, assertion.signature, signed))) return { ok: false, error: "bad_signature" };
  // Synced passkeys (iCloud Keychain, Google) always say 0. A counter that
  // goes backwards on a key that counts means a copy of the key.
  if ((auth.signCount !== 0 || storedCount !== 0) && auth.signCount <= storedCount) return { ok: false, error: "counter" };
  return { ok: true, value: auth.signCount };
}
