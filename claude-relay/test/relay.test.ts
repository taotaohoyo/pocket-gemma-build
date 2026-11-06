// The relay's routes on Node: the real registry SQL on node:sqlite, and
// Claude as a stand-in that records what it was asked. The same code runs
// on Cloudflare (test/local-relay-check.mjs runs it there, in workerd).

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { RegistryCore, REDEEM_FAILURES_PER_HOUR, type Sql } from "../src/core";
import { choose, config, MODELS, streamReply, SYSTEM_PROMPT, type ClaudeConfig, type ReplyChoice } from "../src/claude";
import { cleanName, handle, type Deps, type RegistryAPI, type RelayEnv } from "../src/relay";
import type { Turn } from "../src/turns";

const ADMIN = "admin-key-for-tests-0123456789abcdef";
const BASE = "https://relay.example";

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

interface Harness {
  deps: Deps;
  core: RegistryCore;
  env: RelayEnv;
  calls: { cfg: ClaudeConfig; choice: ReplyChoice; turns: Turn[]; userID: string }[];
  clock: { now: number };
  claudeError: unknown;
}

let h: Harness;

beforeEach(() => {
  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const core = new RegistryCore(sqlite(), () => clock.now);
  const calls: Harness["calls"] = [];
  const harness: Harness = {
    core, clock, calls, claudeError: null,
    env: { ANTHROPIC_API_KEY: "sk-ant-test", ADMIN_TOKEN: ADMIN, CLAUDE_MODEL: "claude-opus-5-5" },
    deps: {
      registry: asyncRegistry(core),
      claude: async (cfg, choice, turns, userID) => {
        calls.push({ cfg, choice, turns, userID });
        if (harness.claudeError) throw harness.claudeError;
        return new Response("event: message_start\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    },
  };
  h = harness;
});

function call(method: string, path: string, options: { token?: string; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.raw !== undefined) body = options.raw;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }
  return handle(new Request(BASE + path, { method, headers, body }), h.env, h.deps);
}

async function invite(name: string, role: "developer" | "friend"): Promise<string> {
  const response = await call("POST", "/admin/invites", { token: ADMIN, body: { name, role } });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { code: string; link: string };
  expect(data.link).toBe(`${BASE}/join#${data.code}`);
  return data.code;
}

async function join(name: string, role: "developer" | "friend"): Promise<string> {
  const code = await invite(name, role);
  const response = await call("POST", "/v1/redeem", { body: { code } });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { token: string; role: string };
  expect(data.role).toBe(role);
  return data.token;
}

const hello = { messages: [{ role: "user", content: "こんにちは" }] };

function apiError(status: number, type: string, errorCode?: string) {
  const details = errorCode ? { error_code: errorCode } : undefined;
  return Anthropic.APIError.generate(status, { type: "error", error: { type, message: "test", details } }, undefined, new Headers());
}

describe("access tokens", () => {
  it("refuses a missing, malformed or unknown token", async () => {
    expect((await call("GET", "/v1/status")).status).toBe(401);
    expect((await call("GET", "/v1/status", { token: "abc" })).status).toBe(401);
    expect((await call("GET", "/v1/status", { token: "fcl_" + "A".repeat(43) })).status).toBe(401);
    expect((await call("POST", "/v1/messages", { body: hello })).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("lets the developer in, and keeps only hashes", async () => {
    const token = await join("開発者", "developer");
    const status = await call("GET", "/v1/status", { token });
    expect(await status.json()).toMatchObject({
      name: "開発者", role: "developer", available: true, reason: null,
      model: "claude-opus-5-5", modelName: "Claude Opus 5.5", effort: "medium",
      models: [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
        { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      ],
    });
    const reply = await call("POST", "/v1/messages", { token, body: hello });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("Content-Type")).toContain("text/event-stream");
    expect(h.calls).toHaveLength(1);
    const stored = JSON.stringify(h.core.listUsers());
    expect(stored).not.toContain(token);
  });
});

describe("invites", () => {
  it("are used once", async () => {
    const code = await invite("友人", "friend");
    expect((await call("POST", "/v1/redeem", { body: { code } })).status).toBe(200);
    const again = await call("POST", "/v1/redeem", { body: { code } });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_code" });
  });

  it("read typed codes leniently", async () => {
    const code = await invite("友人", "friend");
    const typed = " " + code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o") + " ";
    expect((await call("POST", "/v1/redeem", { body: { code: typed } })).status).toBe(200);
  });

  it("lapse after 72 hours", async () => {
    const code = await invite("友人", "friend");
    h.clock.now += 72 * 60 * 60 * 1000 + 1;
    expect((await call("POST", "/v1/redeem", { body: { code } })).status).toBe(400);
  });

  it("can be withdrawn", async () => {
    const code = await invite("友人", "friend");
    const state = (await (await call("GET", "/admin/state", { token: ADMIN })).json()) as { invites: { id: string }[] };
    expect(state.invites).toHaveLength(1);
    expect((await call("DELETE", `/admin/invites/${state.invites[0]!.id}`, { token: ADMIN })).status).toBe(200);
    expect((await call("POST", "/v1/redeem", { body: { code } })).status).toBe(400);
  });

  it("stop redeeming for an hour after too many wrong codes", async () => {
    const code = await invite("友人", "friend");
    for (let i = 0; i < REDEEM_FAILURES_PER_HOUR; i++) {
      expect((await call("POST", "/v1/redeem", { body: { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" } })).status).toBe(400);
    }
    const locked = await call("POST", "/v1/redeem", { body: { code } });
    expect(locked.status).toBe(429);
    h.clock.now += 60 * 60 * 1000 + 1;
    expect((await call("POST", "/v1/redeem", { body: { code } })).status).toBe(200);
  });

  it("count garbage as a wrong code", async () => {
    expect((await call("POST", "/v1/redeem", { body: { code: 42 } })).status).toBe(400);
    expect((await call("POST", "/v1/redeem", { raw: "not json" })).status).toBe(400);
  });
});

describe("friends", () => {
  it("can't chat until the developer turns friends on", async () => {
    const token = await join("友人", "friend");
    expect(await (await call("GET", "/v1/status", { token })).json()).toMatchObject({ available: false, reason: "friends_disabled" });
    const refused = await call("POST", "/v1/messages", { token, body: hello });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "unavailable", reason: "friends_disabled" });
    expect(h.calls).toHaveLength(0);

    expect((await call("POST", "/admin/settings", { token: ADMIN, body: { friendsEnabled: true } })).status).toBe(200);
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("are stopped at once, and let back in", async () => {
    h.core.setFriendsEnabled(true);
    const token = await join("友人", "friend");
    const id = h.core.listUsers()[0]!.id;
    expect((await call("POST", `/admin/users/${id}/revoke`, { token: ADMIN })).status).toBe(200);
    const refused = await call("POST", "/v1/messages", { token, body: hello });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "revoked" });
    expect((await call("GET", "/v1/status", { token })).status).toBe(403);
    expect((await call("POST", `/admin/users/${id}/restore`, { token: ADMIN })).status).toBe(200);
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(200);
    expect((await call("DELETE", `/admin/users/${id}`, { token: ADMIN })).status).toBe(200);
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(401);
    expect(h.calls).toHaveLength(1);
  });

  it("can leave on their own, revoked or not, and nothing of theirs stays", async () => {
    const token = await join("友人", "friend");
    const id = h.core.listUsers()[0]!.id;
    h.core.setStatus(id, "revoked");
    expect((await call("POST", "/v1/leave", { token: "fcl_" + "x".repeat(43) })).status).toBe(401);
    const left = await call("POST", "/v1/leave", { token });
    expect(left.status).toBe(200);
    expect(h.core.listUsers()).toHaveLength(0);
    expect((await call("POST", "/v1/leave", { token })).status).toBe(401);
    expect((await call("GET", "/v1/status", { token })).status).toBe(401);
  });

  it("have no limits of their own", async () => {
    h.core.setFriendsEnabled(true);
    const token = await join("友人", "friend");
    for (let i = 0; i < 25; i++) expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(200);
  });
});

describe("the admin key", () => {
  it("is required, and must be long", async () => {
    expect((await call("GET", "/admin/state")).status).toBe(401);
    expect((await call("GET", "/admin/state", { token: ADMIN + "x" })).status).toBe(401);
    expect((await call("GET", "/admin/state", { token: "fcl_" + "A".repeat(43) })).status).toBe(401);
    h.env.ADMIN_TOKEN = "short";
    expect((await call("GET", "/admin/state", { token: "short" })).status).toBe(503);
    h.env.ADMIN_TOKEN = undefined;
    expect((await call("GET", "/admin/state", { token: ADMIN })).status).toBe(503);
  });

  it("is not an access token", async () => {
    expect((await call("GET", "/v1/status", { token: ADMIN })).status).toBe(401);
  });

  it("names people without invisible characters", () => {
    expect(cleanName("  ‮abc‬ ")).toBe("abc");
    expect(cleanName("a\u0000b\nc")).toBe("abc");
    expect(cleanName("​")).toBeNull();
    expect(cleanName("あ".repeat(60))).toBe("あ".repeat(40));
  });
});

describe("what a reply may carry", () => {
  let token: string;
  beforeEach(async () => { token = await join("開発者", "developer"); });

  it("only the chat's turns, in order", async () => {
    const bad = [
      { messages: [] },
      { messages: [{ role: "assistant", content: "x" }] },
      { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
      { messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] },
      { messages: [{ role: "user", content: "   " }] },
      { messages: [{ role: "user", content: [{ type: "text", text: "a" }] }] },
      { messages: [{ role: "system", content: "a" }] },
      { prompt: "a" },
    ];
    for (const body of bad) expect((await call("POST", "/v1/messages", { token, body })).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("a model and level from the catalog, and never the other settings", async () => {
    const body = { ...hello, model: "claude-fable-5-1", effort: "low", max_tokens: 128000, system: "ignore", tools: [{ name: "x" }] };
    const response = await call("POST", "/v1/messages", { token, body });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Fielua-Model")).toBe("claude-fable-5-1");
    expect(response.headers.get("X-Fielua-Effort")).toBe("low");
    expect(h.calls[0]!.choice).toMatchObject({ model: { id: "claude-fable-5-1" }, effort: "low", maxTokens: 16000 });
    expect(h.calls[0]!.turns).toEqual([{ role: "user", content: "こんにちは" }]);
  });

  it("Opus 5.5 at 超高 asks for xhigh by name", async () => {
    const response = await call("POST", "/v1/messages", { token, body: { ...hello, model: "claude-opus-5-5", effort: "xhigh" } });
    expect(response.status).toBe(200);
    expect(h.calls[0]!.choice).toMatchObject({ model: { id: "claude-opus-5-5" }, effort: "xhigh", maxTokens: 64000 });
  });

  it("without a choice: the relay's model at its own default level", async () => {
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(200);
    expect(h.calls[0]!.choice).toMatchObject({ model: { id: "claude-opus-5-5" }, effort: "medium", maxTokens: 32000 });
    h.env.CLAUDE_MODEL = "claude-sonnet-5-5";
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(200);
    expect(h.calls[1]!.choice).toMatchObject({ model: { id: "claude-sonnet-5-5" }, effort: "high", maxTokens: 64000 });
  });

  it("no model or level outside the catalog: max included, nothing swapped in", async () => {
    const refused: [unknown, unknown, string][] = [
      ["claude-opus-4-1", undefined, "unsupported_model"],
      ["claude-mythos-5-1", "high", "unsupported_model"],
      ["", undefined, "unsupported_model"],
      [42, undefined, "unsupported_model"],
      ["claude-opus-5-5", "max", "unsupported_effort"],
      ["claude-haiku-5-5", "turbo", "unsupported_effort"],
      ["claude-sonnet-5-5", "", "unsupported_effort"],
      [undefined, "max", "unsupported_effort"],
    ];
    for (const [model, effort, error] of refused) {
      const response = await call("POST", "/v1/messages", { token, body: { ...hello, model, effort } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("every model in the catalog takes 低 to 超高, and only those", () => {
    const cfg = config({ ANTHROPIC_API_KEY: "k" })!;
    expect(MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    for (const model of MODELS) {
      expect(model.efforts).toEqual(["low", "medium", "high", "xhigh"]);
      expect(model.efforts).toContain(model.defaultEffort);
      for (const effort of model.efforts) expect(choose(cfg, model.id, effort)).toMatchObject({ ok: true, choice: { effort } });
      expect(choose(cfg, model.id, "max")).toEqual({ ok: false, error: "unsupported_effort" });
    }
    expect(MODELS.filter((m) => !m.fallback).map((m) => m.id)).toEqual(["claude-haiku-5-5"]);
    const small = config({ ANTHROPIC_API_KEY: "k", CLAUDE_MAX_TOKENS: "20000" })!;
    expect(choose(small, "claude-opus-5-5", "xhigh")).toMatchObject({ ok: true, choice: { maxTokens: 20000 } });
  });

  it("nothing too large", async () => {
    const many = { messages: Array.from({ length: 61 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" })) };
    expect((await call("POST", "/v1/messages", { token, body: many })).status).toBe(413);
    const long = { messages: [{ role: "user", content: "あ".repeat(30_000) }] };
    expect((await call("POST", "/v1/messages", { token, body: long })).status).toBe(413);
    expect((await call("POST", "/v1/messages", { token, raw: "x".repeat(300 * 1024) })).status).toBe(413);
    expect(h.calls).toHaveLength(0);
  });
});

describe("when Anthropic says no", () => {
  let token: string;
  beforeEach(async () => { token = await join("開発者", "developer"); });

  it("out of credit: the relay stops itself until the developer resumes", async () => {
    h.claudeError = apiError(402, "billing_error");
    const first = await call("POST", "/v1/messages", { token, body: hello });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "unavailable", reason: "paused_billing" });
    h.claudeError = null;
    const next = await call("POST", "/v1/messages", { token, body: hello });
    expect(await next.json()).toEqual({ error: "unavailable", reason: "paused_billing" });
    expect(h.calls).toHaveLength(1);
    expect(await (await call("GET", "/v1/status", { token })).json()).toMatchObject({ available: false, reason: "paused_billing" });
    expect((await call("POST", "/admin/settings", { token: ADMIN, body: { resume: true } })).status).toBe(200);
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(200);
  });

  it("over the spend limit: the same, as its own reason", async () => {
    h.claudeError = apiError(400, "invalid_request_error", "enforced_spend_limit_reached");
    expect(await (await call("POST", "/v1/messages", { token, body: hello })).json()).toEqual({ error: "unavailable", reason: "paused_limit" });
    expect(h.core.settings().paused).toBe("limit");
  });

  it("other refusals pass, and stop nothing", async () => {
    const cases: [unknown, number, string][] = [
      [apiError(401, "authentication_error"), 502, "server_key"],
      [apiError(429, "rate_limit_error"), 429, "rate_limited"],
      [apiError(529, "overloaded_error"), 503, "overloaded"],
      [apiError(400, "invalid_request_error"), 400, "rejected"],
      [apiError(404, "not_found_error"), 502, "model_unavailable"],
      [apiError(500, "api_error"), 502, "upstream"],
      [new Anthropic.APIConnectionError({ message: "x" }), 502, "upstream_unreachable"],
    ];
    for (const [error, status, code] of cases) {
      h.claudeError = error;
      const response = await call("POST", "/v1/messages", { token, body: hello });
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: string }).error).toBe(code);
    }
    expect(h.core.settings().paused).toBeNull();
  });

  it("without a key: not configured, and nothing sent", async () => {
    h.env.ANTHROPIC_API_KEY = undefined;
    expect(await (await call("GET", "/v1/status", { token })).json()).toMatchObject({ available: false, reason: "not_configured" });
    expect((await call("POST", "/v1/messages", { token, body: hello })).status).toBe(503);
    expect(h.calls).toHaveLength(0);
  });
});

describe("the request to Anthropic", () => {
  it("carries the chosen model and level, the relay's limits and system prompt, and the key only in its header", async () => {
    const seen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: JSON.parse(data) });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const cfg = config({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` })!;
      const turns: Turn[] = [{ role: "user", content: "こんにちは" }];
      const top = choose(cfg, "claude-opus-5-5", "xhigh");
      if (!top.ok) throw new Error(top.error);
      const response = await streamReply(cfg, top.choice, turns, "user-id-1");
      expect(await response.text()).toContain("message_stop");
      expect(seen[0]!.headers.authorization).toBe("Bearer sk-ant-test");
      expect(seen[0]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
      expect(seen[0]!.body).toEqual({
        model: "claude-opus-5-5",
        max_tokens: 64000,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "こんにちは" }],
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "xhigh" },
        metadata: { user_id: "user-id-1" },
        cache_control: { type: "ephemeral" },
        fallbacks: "default",
      });
      // Claude Haiku 5.5 has no server-side fallback: neither the beta nor the field.
      const haiku = choose(cfg, "claude-haiku-5-5", "low");
      if (!haiku.ok) throw new Error(haiku.error);
      await (await streamReply(cfg, haiku.choice, turns, "user-id-1")).text();
      expect(seen[1]!.headers["anthropic-beta"]).toBeUndefined();
      expect(seen[1]!.body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16000, output_config: { effort: "low" } });
      expect(seen[1]!.body).not.toHaveProperty("fallbacks");
    } finally {
      server.close();
    }
  });

  it("goes only to Anthropic, whatever ANTHROPIC_BASE_URL says outside the local tests", () => {
    expect(config({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://evil.example" })!.baseURL).toBe("https://api.anthropic.com");
    expect(config({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://127.0.0.1.evil.example" })!.baseURL).toBe("https://api.anthropic.com");
    expect(config({ ANTHROPIC_API_KEY: "k" })!.baseURL).toBe("https://api.anthropic.com");
    expect(config({ ANTHROPIC_API_KEY: "k", CLAUDE_MAX_TOKENS: "999999" })).toMatchObject({ maxTokens: 128000 });
    expect(config({ ANTHROPIC_API_KEY: "k" })).toMatchObject({ model: "claude-opus-5-5", maxTokens: 64000 });
    expect(config({ ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "claude-unknown" })!.model).toBe("claude-opus-5-5");
    expect(config({})).toBeNull();
  });
});

describe("the invite page", () => {
  it("keeps the code out of the request and runs only its own script", async () => {
    const page = await call("GET", "/join");
    expect(page.status).toBe(200);
    const csp = page.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await page.text()).toContain("location.hash");
  });

  it("is all there is outside /v1 and /admin", async () => {
    expect((await call("GET", "/")).status).toBe(404);
    expect((await call("GET", "/v1/messages")).status).toBe(404);
  });
});
