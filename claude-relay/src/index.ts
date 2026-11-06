// Fielua's relay to the Claude API, on Cloudflare Workers.
//
// The Anthropic API key lives only here, as a Worker secret
// (ANTHROPIC_API_KEY): never in the app, on the phone or in GitHub. The
// app holds a per-device access token instead, which the developer can
// revoke at any time; friends are let in by one-time invites and only
// once the developer turns friends on.

import { DurableObject } from "cloudflare:workers";
import { RegistryCore, type Invite, type PauseReason, type RedeemResult, type Role, type Settings, type User, type UserStatus } from "./core";
import { handle, type RegistryAPI, type RelayEnv } from "./relay";

export interface Env extends RelayEnv {
  REGISTRY: DurableObjectNamespace<Registry>;
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
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    return handle(request, env, { registry, waitUntil: (promise) => ctx.waitUntil(promise) });
  },
} satisfies ExportedHandler<Env>;
