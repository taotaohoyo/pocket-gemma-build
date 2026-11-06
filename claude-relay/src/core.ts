// The relay's registry: who may use it, their invites and the relay's
// switches. Plain SQL over the Durable Object's SQLite (registry.ts), so
// the same code runs in the tests on Node's SQLite.
//
// Nothing secret is stored: access tokens and invite codes are kept only
// as SHA-256 hashes (security.ts), and nothing of a conversation is ever
// written here.

export type Role = "developer" | "friend";
export type UserStatus = "active" | "revoked";
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
}

export type RedeemResult =
  | { ok: true; user: User }
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

  deleteUser(id: string): boolean {
    const before = this.listUsers().length;
    this.sql.exec(`DELETE FROM users WHERE id = ?`, id);
    return this.listUsers().length < before;
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
   * hour stop redeeming until the hour has passed.
   */
  redeem(codeHash: string, userID: string, tokenHash: string): RedeemResult {
    const now = this.now();
    this.sql.exec(`DELETE FROM redeem_failures WHERE at <= ?`, now - HOUR_MS);
    const failures = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM redeem_failures`).toArray()[0]?.n ?? 0);
    if (failures >= REDEEM_FAILURES_PER_HOUR) return { ok: false, error: "too_many_attempts" };
    const row = this.sql.exec(`SELECT * FROM invites WHERE code_hash = ? AND expires_at > ?`, codeHash, now).toArray()[0];
    if (!row) {
      this.sql.exec(`INSERT INTO redeem_failures (at) VALUES (?)`, now);
      return { ok: false, error: "invalid_code" };
    }
    const invite = toInvite(row);
    this.sql.exec(`DELETE FROM invites WHERE id = ?`, invite.id);
    this.sql.exec(`INSERT INTO users (id, name, role, status, token_hash, created_at, last_used_at) VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
      userID, invite.name, invite.role, tokenHash, now);
    return { ok: true, user: { id: userID, name: invite.name, role: invite.role, status: "active", createdAt: now, lastUsedAt: null } };
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
    };
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
  };
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
