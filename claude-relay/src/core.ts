// The relay's registry: who may use it, their invites and the relay's
// switches. Plain SQL over the Durable Object's SQLite (registry.ts), so
// the same code runs in the tests on Node's SQLite.
//
// Nothing secret of the app's is stored: access tokens and invite codes are
// kept only as SHA-256 hashes (security.ts), and nothing of a conversation is
// ever written here. The one key kept as it is: each web user's history key,
// with which their own browser encrypts the history it keeps (no use without
// that device's data, and gone when the person is deleted).

import type { StoredKey } from "./webauthn";

export type Role = "developer" | "friend";
export type UserStatus = "active" | "revoked";
/**
 * Where a person registered: "device" with an invite redeemed in the
 * iPhone app (an access token in its keychain), "web" with a passkey on
 * Fielua for the web (no access token at all).
 */
export type UserKind = "device" | "web";
/**
 * Why the relay stopped itself: "billing" when Anthropic said the credit
 * ran out (or the account's billing is on hold), "limit" when the
 * account's monthly spend limit was reached. Nothing is bought or raised
 * automatically: the developer resumes after deciding what to do.
 */
export type PauseReason = "billing" | "limit";

export interface User {
  id: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: number;
  lastUsedAt: number | null;
  kind: UserKind;
}

export interface Invite {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
}

export interface Settings {
  /** Friends may chat only once the developer turns this on (after the terms check). */
  friendsEnabled: boolean;
  paused: PauseReason | null;
  pausedAt: number | null;
  credit: Credit;
}

/**
 * The estimate of the credit left. Anthropic has no API for the balance,
 * so the developer enters what the Console shows, and the relay adds up
 * what each reply cost by its usage and the list prices (claude.ts).
 * Amounts are in millionths of a dollar.
 */
export interface Credit {
  budgetMicros: number | null;
  spentMicros: number;
  setAt: number | null;
  /** Friends see the estimate too (off at first: it is the developer's money). */
  friends: boolean;
}

/** The most the developer may enter as the balance: $100,000. */
export const MAX_CREDIT_MICROS = 100_000 * 1_000_000;

export type RedeemResult =
  /** deviceAdmin: the iPhone's Face ID key was tied to the person (a developer's invite only; device.ts). */
  | { ok: true; user: User; deviceAdmin?: boolean }
  | { ok: false; error: "invalid_code" | "too_many_attempts" };

/** A passkey the web app signs in with: its credential id, public key and signature counter. Never a secret. */
export interface Passkey {
  id: string;
  userID: string;
  key: StoredKey;
  signCount: number;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A signed-in browser: a random token (kept as its hash) that lapses after WEB_SESSION_LIFETIME_MS. */
export interface WebSession {
  userID: string;
  createdAt: number;
  expiresAt: number;
}

/** A WebAuthn challenge the relay handed out (or one for the developer's iPhone, device.ts), used once within CHALLENGE_LIFETIME_MS. */
export interface Challenge {
  id: string;
  challenge: string;
  purpose: "register" | "login" | "device-admin";
  /** For a registration: the invite it will use up, and the new person's id (the passkey's user handle). */
  inviteHash: string | null;
  userID: string | null;
  expiresAt: number;
}

export type InviteCheck =
  | { ok: true; invite: Invite }
  | { ok: false; error: "invalid_code" | "too_many_attempts" };

/** The SQLite surface the registry needs: Cloudflare's SqlStorage has it, and the tests adapt node:sqlite to it. */
export interface Sql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

export const INVITE_LIFETIME_MS = 72 * 60 * 60 * 1000;
/** Failed invite codes within an hour before redeeming pauses until the hour ends. */
export const REDEEM_FAILURES_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 40;
/** A web sign-in lasts 12 hours; then Face ID (or the device's own check) again. */
export const WEB_SESSION_LIFETIME_MS = 12 * HOUR_MS;
/** The developer's admin work on the web needs a passkey sign-in at most 15 minutes old. */
export const WEB_ADMIN_FRESH_MS = 15 * 60 * 1000;
/** And on the developer's iPhone, Face ID at most as long ago (device.ts). */
export const DEVICE_ADMIN_LIFETIME_MS = WEB_ADMIN_FRESH_MS;
export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
/** Open challenges at once, everyone together: more is someone knocking, and gets "busy". */
export const MAX_OPEN_CHALLENGES = 200;
export const MAX_SESSIONS_PER_USER = 10;
/** Anthropic keeps a container's files for 30 days. */
export const OUTPUTS_KEPT_MS = 30 * 24 * HOUR_MS;
export type OutputKind = "file" | "container";
/** The token hash of a person who registered on the web: no access token can ever hash to it. */
const WEB_ONLY = "web-only:";

export class RegistryCore {
  constructor(private readonly sql: Sql, private readonly now: () => number = Date.now) {
    sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS redeem_failures (at INTEGER NOT NULL)`);
    // Fielua for the web: passkeys, signed-in browsers and open challenges.
    sql.exec(`CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, sign_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL, last_used_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS web_challenges (
      id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, invite_hash TEXT, user_id TEXT,
      expires_at INTEGER NOT NULL)`);
    // What a person's replies made with code execution: whose each file and container is (ids only).
    sql.exec(`CREATE TABLE IF NOT EXISTS outputs (
      kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (kind, id))`);
    // The key each web user's browser encrypts its own history with (the history stays on that device).
    sql.exec(`CREATE TABLE IF NOT EXISTS history_keys (user_id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    // The developer's iPhone (1.1.0 (262), device.ts): the public half of its Face ID key, and its admin tokens (hashes).
    sql.exec(`CREATE TABLE IF NOT EXISTS device_keys (
      user_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS device_admin (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  // MARK: Users

  /** The user a token hash belongs to, revoked or not; null for none. */
  authenticate(tokenHash: string): User | null {
    const row = this.sql.exec(`SELECT * FROM users WHERE token_hash = ?`, tokenHash).toArray()[0];
    return row ? toUser(row) : null;
  }

  touch(id: string): void {
    this.sql.exec(`UPDATE users SET last_used_at = ? WHERE id = ?`, this.now(), id);
  }

  listUsers(): User[] {
    return this.sql.exec(`SELECT * FROM users ORDER BY created_at`).toArray().map(toUser);
  }

  setStatus(id: string, status: UserStatus): User | null {
    this.sql.exec(`UPDATE users SET status = ? WHERE id = ?`, status, id);
    const row = this.sql.exec(`SELECT * FROM users WHERE id = ?`, id).toArray()[0];
    return row ? toUser(row) : null;
  }

  /** The person and everything that signs them in: their passkeys, their browsers' sessions and their iPhone's key too. */
  deleteUser(id: string): boolean {
    const before = this.listUsers().length;
    this.sql.exec(`DELETE FROM users WHERE id = ?`, id);
    this.sql.exec(`DELETE FROM passkeys WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM web_sessions WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM device_keys WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM device_admin WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM outputs WHERE user_id = ?`, id);
    this.sql.exec(`DELETE FROM history_keys WHERE user_id = ?`, id);
    return this.listUsers().length < before;
  }

  // MARK: What code execution made

  /** The container and files a person's reply made, as theirs; ones older than Anthropic keeps them are let go. */
  rememberOutputs(userID: string, container: string | null, files: string[]): void {
    const at = this.now();
    this.sql.exec(`DELETE FROM outputs WHERE created_at <= ?`, at - OUTPUTS_KEPT_MS);
    const add = (kind: OutputKind, id: string) =>
      this.sql.exec(`INSERT INTO outputs (kind, id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO NOTHING`, kind, id, userID, at);
    if (container) add("container", container);
    for (const file of files.slice(0, 50)) add("file", file);
  }

  /** Whether a file or container is this person's own (made by one of their replies, still kept). */
  ownsOutput(userID: string, kind: OutputKind, id: string): boolean {
    const row = this.sql.exec(`SELECT user_id, created_at FROM outputs WHERE kind = ? AND id = ?`, kind, id).toArray()[0];
    return !!row && row.user_id === userID && Number(row.created_at) > this.now() - OUTPUTS_KEPT_MS;
  }

  // MARK: The history key

  /**
   * The person's history key: the one kept, or `candidate`, kept now as
   * theirs (the first time they ask). Null when they are no longer
   * registered (deleted between their request's sign-in check and this), so
   * no key is left behind for nobody.
   */
  historyKey(userID: string, candidate: string): string | null {
    this.sql.exec(
      `INSERT INTO history_keys (user_id, key, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT(user_id) DO NOTHING`,
      userID, candidate, this.now(), userID);
    const row = this.sql.exec(`SELECT key FROM history_keys WHERE user_id = ?`, userID).toArray()[0];
    return row ? String(row.key) : null;
  }

  // MARK: Invites

  /** A one-time invite, by its code's hash; it lapses after INVITE_LIFETIME_MS. */
  createInvite(id: string, codeHash: string, name: string, role: Role): Invite {
    const createdAt = this.now();
    const expiresAt = createdAt + INVITE_LIFETIME_MS;
    this.sql.exec(`DELETE FROM invites WHERE expires_at <= ?`, createdAt);
    this.sql.exec(`INSERT INTO invites (id, code_hash, name, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, codeHash, name, role, createdAt, expiresAt);
    return { id, name, role, createdAt, expiresAt };
  }

  listInvites(): Invite[] {
    this.sql.exec(`DELETE FROM invites WHERE expires_at <= ?`, this.now());
    return this.sql.exec(`SELECT * FROM invites ORDER BY created_at`).toArray().map(toInvite);
  }

  cancelInvite(id: string): boolean {
    const before = this.listInvites().length;
    this.sql.exec(`DELETE FROM invites WHERE id = ?`, id);
    return this.listInvites().length < before;
  }

  /**
   * Trades an invite for a user with the given token hash: the invite is
   * used up at once, whatever happens next. Too many wrong codes within an
   * hour stop redeeming until the hour has passed. A developer's invite
   * also ties the iPhone's Face ID key (checked already, device.ts) to
   * the new person; a friend's ties none.
   */
  redeem(codeHash: string, userID: string, tokenHash: string, deviceKey: string | null = null): RedeemResult {
    const checked = this.checkInvite(codeHash);
    if (!checked.ok) return checked;
    const user = this.useInvite(checked.invite, userID, tokenHash);
    const deviceAdmin = !!deviceKey && user.role === "developer";
    if (deviceAdmin) {
      this.sql.exec(`INSERT INTO device_keys (user_id, public_key, created_at, last_used_at) VALUES (?, ?, ?, NULL)`, userID, deviceKey, this.now());
    }
    return { ok: true, user, deviceAdmin };
  }

  /**
   * Whether an invite code is open, without using it up (the web asks
   * before it makes a passkey). A wrong code counts toward the same
   * hourly limit as redeeming one.
   */
  checkInvite(codeHash: string): InviteCheck {
    const now = this.now();
    this.sql.exec(`DELETE FROM redeem_failures WHERE at <= ?`, now - HOUR_MS);
    const failures = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM redeem_failures`).toArray()[0]?.n ?? 0);
    if (failures >= REDEEM_FAILURES_PER_HOUR) return { ok: false, error: "too_many_attempts" };
    const row = this.sql.exec(`SELECT * FROM invites WHERE code_hash = ? AND expires_at > ?`, codeHash, now).toArray()[0];
    if (!row) {
      this.sql.exec(`INSERT INTO redeem_failures (at) VALUES (?)`, now);
      return { ok: false, error: "invalid_code" };
    }
    return { ok: true, invite: toInvite(row) };
  }

  private useInvite(invite: Invite, userID: string, tokenHash: string): User {
    const now = this.now();
    this.sql.exec(`DELETE FROM invites WHERE id = ?`, invite.id);
    this.sql.exec(`INSERT INTO users (id, name, role, status, token_hash, created_at, last_used_at) VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
      userID, invite.name, invite.role, tokenHash, now);
    return { id: userID, name: invite.name, role: invite.role, status: "active", createdAt: now, lastUsedAt: null, kind: kindOf(tokenHash) };
  }

  // MARK: Fielua for the web

  /** A challenge for a passkey ceremony; null when too many are open at once. */
  createChallenge(challenge: Omit<Challenge, "expiresAt">): Challenge | null {
    const now = this.now();
    this.sql.exec(`DELETE FROM web_challenges WHERE expires_at <= ?`, now);
    const open = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM web_challenges`).toArray()[0]?.n ?? 0);
    if (open >= MAX_OPEN_CHALLENGES) return null;
    const expiresAt = now + CHALLENGE_LIFETIME_MS;
    this.sql.exec(`INSERT INTO web_challenges (id, challenge, purpose, invite_hash, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      challenge.id, challenge.challenge, challenge.purpose, challenge.inviteHash, challenge.userID, expiresAt);
    return { ...challenge, expiresAt };
  }

  /** The challenge, used up whatever the answer turns out to be; null when unknown, lapsed or for something else. */
  takeChallenge(id: string, purpose: Challenge["purpose"]): Challenge | null {
    const row = this.sql.exec(`SELECT * FROM web_challenges WHERE id = ?`, id).toArray()[0];
    this.sql.exec(`DELETE FROM web_challenges WHERE id = ?`, id);
    if (!row || row.purpose !== purpose || Number(row.expires_at) <= this.now()) return null;
    return {
      id: String(row.id), challenge: String(row.challenge), purpose,
      inviteHash: row.invite_hash == null ? null : String(row.invite_hash),
      userID: row.user_id == null ? null : String(row.user_id),
      expiresAt: Number(row.expires_at),
    };
  }

  /** The invite traded for a person who signs in with this passkey (no access token). */
  redeemWithPasskey(codeHash: string, userID: string, passkey: { id: string; key: StoredKey; signCount: number }): RedeemResult {
    if (this.passkey(passkey.id)) return { ok: false, error: "invalid_code" };
    const checked = this.checkInvite(codeHash);
    if (!checked.ok) return checked;
    const user = this.useInvite(checked.invite, userID, WEB_ONLY + userID);
    this.sql.exec(`INSERT INTO passkeys (id, user_id, public_key, sign_count, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)`,
      passkey.id, userID, JSON.stringify(passkey.key), passkey.signCount, this.now());
    return { ok: true, user };
  }

  passkey(id: string): Passkey | null {
    const row = this.sql.exec(`SELECT * FROM passkeys WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    return {
      id: String(row.id), userID: String(row.user_id), key: JSON.parse(String(row.public_key)) as StoredKey,
      signCount: Number(row.sign_count), createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    };
  }

  usedPasskey(id: string, signCount: number): void {
    this.sql.exec(`UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?`, signCount, this.now(), id);
  }

  user(id: string): User | null {
    const row = this.sql.exec(`SELECT * FROM users WHERE id = ?`, id).toArray()[0];
    return row ? toUser(row) : null;
  }

  /** A new signed-in browser for the person. Their oldest sessions go past MAX_SESSIONS_PER_USER. */
  createSession(tokenHash: string, userID: string): WebSession {
    const now = this.now();
    this.sql.exec(`DELETE FROM web_sessions WHERE expires_at <= ?`, now);
    const expiresAt = now + WEB_SESSION_LIFETIME_MS;
    this.sql.exec(`INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, tokenHash, userID, now, expiresAt);
    this.sql.exec(`DELETE FROM web_sessions WHERE user_id = ? AND token_hash NOT IN
      (SELECT token_hash FROM web_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`, userID, userID, MAX_SESSIONS_PER_USER);
    return { userID, createdAt: now, expiresAt };
  }

  /** The person a browser's session belongs to, revoked or not; null once it lapsed, ended or the person was deleted. */
  sessionUser(tokenHash: string): { user: User; session: WebSession } | null {
    const row = this.sql.exec(`SELECT * FROM web_sessions WHERE token_hash = ?`, tokenHash).toArray()[0];
    if (!row) return null;
    const session = { userID: String(row.user_id), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
    if (session.expiresAt <= this.now()) {
      this.sql.exec(`DELETE FROM web_sessions WHERE token_hash = ?`, tokenHash);
      return null;
    }
    const user = this.user(session.userID);
    return user ? { user, session } : null;
  }

  endSession(tokenHash: string): void {
    this.sql.exec(`DELETE FROM web_sessions WHERE token_hash = ?`, tokenHash);
  }

  // MARK: The developer's iPhone (device.ts)

  /** The public half of the person's Face ID key; null when their invite tied none. */
  deviceKey(userID: string): string | null {
    const row = this.sql.exec(`SELECT public_key FROM device_keys WHERE user_id = ?`, userID).toArray()[0];
    return row ? String(row.public_key) : null;
  }

  /** An admin token for the person's iPhone, after its key signed: the one before it goes. */
  createDeviceAdmin(tokenHash: string, userID: string): { createdAt: number; expiresAt: number } {
    const now = this.now();
    this.sql.exec(`DELETE FROM device_admin WHERE expires_at <= ? OR user_id = ?`, now, userID);
    const expiresAt = now + DEVICE_ADMIN_LIFETIME_MS;
    this.sql.exec(`INSERT INTO device_admin (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, tokenHash, userID, now, expiresAt);
    this.sql.exec(`UPDATE device_keys SET last_used_at = ? WHERE user_id = ?`, now, userID);
    return { createdAt: now, expiresAt };
  }

  /** The person an iPhone's admin token belongs to, revoked or not; null once it lapsed or the person was deleted. */
  deviceAdminUser(tokenHash: string): User | null {
    const row = this.sql.exec(`SELECT * FROM device_admin WHERE token_hash = ?`, tokenHash).toArray()[0];
    if (!row) return null;
    if (Number(row.expires_at) <= this.now()) {
      this.sql.exec(`DELETE FROM device_admin WHERE token_hash = ?`, tokenHash);
      return null;
    }
    return this.user(String(row.user_id));
  }

  // MARK: Settings

  settings(): Settings {
    const rows = this.sql.exec(`SELECT key, value FROM settings`).toArray();
    const map = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    const paused = map.get("paused");
    return {
      friendsEnabled: map.get("friends_enabled") === "1",
      paused: paused === "billing" || paused === "limit" ? paused : null,
      pausedAt: map.has("paused_at") ? Number(map.get("paused_at")) : null,
      credit: {
        budgetMicros: map.has("credit_budget") ? Number(map.get("credit_budget")) : null,
        spentMicros: Number(map.get("credit_spent") ?? "0"),
        setAt: map.has("credit_set_at") ? Number(map.get("credit_set_at")) : null,
        friends: map.get("credit_friends") === "1",
      },
    };
  }

  /** The balance as the Console shows it now; what was spent before no longer counts. Null clears the estimate. */
  setCredit(budgetMicros: number | null): Settings {
    if (budgetMicros === null) {
      this.sql.exec(`DELETE FROM settings WHERE key IN ('credit_budget', 'credit_spent', 'credit_set_at')`);
    } else {
      this.put("credit_budget", String(Math.round(Math.min(Math.max(budgetMicros, 0), MAX_CREDIT_MICROS))));
      this.put("credit_spent", "0");
      this.put("credit_set_at", String(this.now()));
    }
    return this.settings();
  }

  setCreditFriends(on: boolean): Settings {
    this.put("credit_friends", on ? "1" : "0");
    return this.settings();
  }

  /** A reply's cost, added to what was spent (only while a balance is set). */
  addSpend(micros: number): void {
    if (!Number.isFinite(micros) || micros <= 0) return;
    this.sql.exec(`UPDATE settings SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'credit_spent'`, Math.round(micros));
  }

  setFriendsEnabled(on: boolean): Settings {
    this.put("friends_enabled", on ? "1" : "0");
    return this.settings();
  }

  /** Stops every request before it reaches Anthropic, until the developer resumes. */
  pause(reason: PauseReason): Settings {
    if (this.settings().paused === null) {
      this.put("paused", reason);
      this.put("paused_at", String(this.now()));
    }
    return this.settings();
  }

  resume(): Settings {
    this.sql.exec(`DELETE FROM settings WHERE key IN ('paused', 'paused_at')`);
    return this.settings();
  }

  private put(key: string, value: string): void {
    this.sql.exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }
}

function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role === "developer" ? "developer" : "friend",
    status: row.status === "active" ? "active" : "revoked",
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    kind: kindOf(String(row.token_hash)),
  };
}

function kindOf(tokenHash: string): UserKind {
  return tokenHash.startsWith(WEB_ONLY) ? "web" : "device";
}

function toInvite(row: Record<string, unknown>): Invite {
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role === "developer" ? "developer" : "friend",
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}
