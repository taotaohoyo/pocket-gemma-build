// Fielua's relay to the Claude API, on Cloudflare Workers.
//
// The Anthropic API key lives only here, as a Worker secret
// (ANTHROPIC_API_KEY): never in the app, on the phone or in GitHub. The
// app holds a per-device access token instead, which the developer can
// revoke at any time; friends are let in by one-time invites and only
// once the developer turns friends on.

import { DurableObject } from "cloudflare:workers";
import {
  RegistryCore, type Challenge, type Invite, type InviteCheck, type OutputKind, type Passkey, type PauseReason, type RedeemResult, type Role,
  type Settings, type User, type UserStatus, type WebSession,
} from "./core";
import type { StoredKey } from "./webauthn";
import { handle, json, replyInObject, type RegistryAPI, type RelayEnv, type ReplyHub } from "./relay";
import { ReplyKeeper } from "./reply";

export interface Env extends RelayEnv {
  REGISTRY: DurableObjectNamespace<Registry>;
  REPLY: DurableObjectNamespace<Reply>;
}

/** The single registry: one Durable Object, so every change is seen by the next request. */
export class Registry extends DurableObject<Env> implements RegistryAPI {
  private readonly core: RegistryCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new RegistryCore(ctx.storage.sql);
  }

  async authenticate(tokenHash: string): Promise<User | null> { return this.core.authenticate(tokenHash); }
  async touch(id: string): Promise<void> { this.core.touch(id); }
  async listUsers(): Promise<User[]> { return this.core.listUsers(); }
  async setStatus(id: string, status: UserStatus): Promise<User | null> { return this.core.setStatus(id, status); }
  async deleteUser(id: string): Promise<boolean> { return this.core.deleteUser(id); }
  async createInvite(id: string, codeHash: string, name: string, role: Role): Promise<Invite> {
    return this.core.createInvite(id, codeHash, name, role);
  }
  async listInvites(): Promise<Invite[]> { return this.core.listInvites(); }
  async cancelInvite(id: string): Promise<boolean> { return this.core.cancelInvite(id); }
  async redeem(codeHash: string, userID: string, tokenHash: string): Promise<RedeemResult> {
    return this.core.redeem(codeHash, userID, tokenHash);
  }
  async settings(): Promise<Settings> { return this.core.settings(); }
  async setFriendsEnabled(on: boolean): Promise<Settings> { return this.core.setFriendsEnabled(on); }
  async pause(reason: PauseReason): Promise<Settings> { return this.core.pause(reason); }
  async resume(): Promise<Settings> { return this.core.resume(); }
  // Fielua for the web
  async user(id: string): Promise<User | null> { return this.core.user(id); }
  async checkInvite(codeHash: string): Promise<InviteCheck> { return this.core.checkInvite(codeHash); }
  async createChallenge(challenge: Omit<Challenge, "expiresAt">): Promise<Challenge | null> { return this.core.createChallenge(challenge); }
  async takeChallenge(id: string, purpose: Challenge["purpose"]): Promise<Challenge | null> { return this.core.takeChallenge(id, purpose); }
  async redeemWithPasskey(codeHash: string, userID: string, passkey: { id: string; key: StoredKey; signCount: number }): Promise<RedeemResult> {
    return this.core.redeemWithPasskey(codeHash, userID, passkey);
  }
  async passkey(id: string): Promise<Passkey | null> { return this.core.passkey(id); }
  async usedPasskey(id: string, signCount: number): Promise<void> { this.core.usedPasskey(id, signCount); }
  async createSession(tokenHash: string, userID: string): Promise<WebSession> { return this.core.createSession(tokenHash, userID); }
  async sessionUser(tokenHash: string): Promise<{ user: User; session: WebSession } | null> { return this.core.sessionUser(tokenHash); }
  async endSession(tokenHash: string): Promise<void> { this.core.endSession(tokenHash); }
  // The estimate of the credit left
  async setCredit(budgetMicros: number | null): Promise<Settings> { return this.core.setCredit(budgetMicros); }
  async setCreditFriends(on: boolean): Promise<Settings> { return this.core.setCreditFriends(on); }
  async addSpend(micros: number): Promise<void> { this.core.addSpend(micros); }
  // What code execution made, and whose it is
  async rememberOutputs(userID: string, container: string | null, files: string[]): Promise<void> { this.core.rememberOutputs(userID, container, files); }
  async ownsOutput(userID: string, kind: OutputKind, id: string): Promise<boolean> { return this.core.ownsOutput(userID, kind, id); }
  // The key a web user's browser encrypts its own history with
  async historyKey(userID: string, candidate: string): Promise<string | null> { return this.core.historyKey(userID, candidate); }
}

/**
 * One reply of /v1/replies (reply.ts): a Durable Object of its own, which
 * goes on asking Anthropic when the page's connection drops (an outbound
 * request keeps it running) and keeps the reply in memory only, never in
 * its storage, until the page has it or it lapses.
 */
export class Reply extends DurableObject<Env> {
  private readonly keeper: ReplyKeeper;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.keeper = new ReplyKeeper();
  }

  async fetch(request: Request): Promise<Response> {
    return replyInObject(request, this.env, { registry: registry(this.env), keeper: this.keeper, waitUntil: (promise) => this.ctx.waitUntil(promise) });
  }

  async again(owner: string): Promise<Response> {
    const kept = this.keeper.again(owner);
    if (kept === "not_ready") return json(409, { error: "not_ready" });
    if (!kept) return json(404, { error: "not_found" });
    return new Response(kept.body, { status: 200, headers: kept.headers });
  }

  async end(owner: string): Promise<boolean> {
    return this.keeper.end(owner);
  }
}

function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

/** The replies' objects as the edge reaches them: one for each person and key the page picked. */
function replies(env: Env): ReplyHub {
  const object = (key: string, owner: string) => env.REPLY.get(env.REPLY.idFromName(`${owner}:${key}`));
  return {
    async start(request, key, owner) {
      return object(key, owner).fetch(request);
    },
    async again(key, owner) {
      return object(key, owner).again(owner);
    },
    async end(key, owner) {
      return (await object(key, owner).end(owner)) ? json(200, { ended: true }) : json(404, { error: "not_found" });
    },
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handle(request, env, { registry: registry(env), replies: replies(env), waitUntil: (promise) => ctx.waitUntil(promise) });
  },
} satisfies ExportedHandler<Env>;
