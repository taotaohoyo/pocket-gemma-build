// The relay's routes on Node: the real registry SQL on node:sqlite, and
// Claude as a stand-in that records what it was asked. The same code runs
// on Cloudflare (test/local-relay-check.mjs runs it there, in workerd).

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { RegistryCore, REDEEM_FAILURES_PER_HOUR, type Sql } from "../src/core";
import {
  attachedBody, choose, config, costMicros, MODELS, NO_TOOLS, streamReply, SYSTEM_PROMPT, systemPrompt, toolParams, type ClaudeConfig, type ReplyChoice,
  type ToolChoice,
} from "../src/claude";
import { meter } from "../src/meter";
import { cleanName, handle, safeFilename, type Deps, type RegistryAPI, type RelayEnv } from "../src/relay";
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
  calls: { cfg: ClaudeConfig; choice: ReplyChoice; turns: Turn[]; userID: string; tools: ToolChoice }[];
  clock: { now: number };
  claudeError: unknown;
  /** What the stand-in streams back; a plain start by default. */
  stream: string;
  /** Work the relay leaves running after its answer (waitUntil). */
  pending: Promise<unknown>[];
}

let h: Harness;

beforeEach(() => {
  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const core = new RegistryCore(sqlite(), () => clock.now);
  const calls: Harness["calls"] = [];
  const harness: Harness = {
    core, clock, calls, claudeError: null, stream: "event: message_start\ndata: {}\n\n", pending: [],
    env: { ANTHROPIC_API_KEY: "sk-ant-test", ADMIN_TOKEN: ADMIN, CLAUDE_MODEL: "claude-opus-5-5" },
    deps: {
      registry: asyncRegistry(core),
      models: async () => null,
      now: () => clock.now,
      claude: async (cfg, choice, turns, userID, _signal, tools = NO_TOOLS) => {
        calls.push({ cfg, choice, turns, userID, tools });
        if (harness.claudeError) throw harness.claudeError;
        return new Response(harness.stream, { headers: { "Content-Type": "text/event-stream" } });
      },
      waitUntil: (promise) => { harness.pending.push(promise); },
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
        { id: "claude-fable-5-2", name: "Claude Fable 5.2", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
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
    const body = { ...hello, model: "claude-fable-5-2", effort: "low", max_tokens: 128000, system: "ignore", tools: [{ name: "x" }] };
    const response = await call("POST", "/v1/messages", { token, body });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Fielua-Model")).toBe("claude-fable-5-2");
    expect(response.headers.get("X-Fielua-Effort")).toBe("low");
    expect(h.calls[0]!.choice).toMatchObject({ model: { id: "claude-fable-5-2" }, effort: "low", maxTokens: 16000 });
    expect(h.calls[0]!.turns).toEqual([{ role: "user", content: "こんにちは" }]);
  });

  it("Claude Fable 5.1 is no longer offered, but a chat begun with it goes on", async () => {
    const status = await (await call("GET", "/v1/status", { token })).json() as { models: { id: string }[] };
    expect(status.models.map((m) => m.id)).not.toContain("claude-fable-5-1");
    const response = await call("POST", "/v1/messages", { token, body: { ...hello, model: "claude-fable-5-1", effort: "high" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Fielua-Model")).toBe("claude-fable-5-1");
    expect(h.calls[0]!.choice).toMatchObject({ model: { id: "claude-fable-5-1" }, effort: "high" });
    // Never the default, even when the Worker's variable names it.
    expect(config({ ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "claude-fable-5-1" })!.model).toBe("claude-opus-5-5");
    expect(config({ ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "claude-fable-5-2" })!.model).toBe("claude-fable-5-2");
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
    expect(MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
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
    expect((await call("POST", "/v1/messages", { token, raw: "x".repeat(5 * 1024 * 1024) })).status).toBe(413);
    expect(h.calls).toHaveLength(0);
  });
});


// Small real files, as base64: a 1×1 JPEG and PNG, a one-page PDF's first bytes.
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9));
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1));
const PDF = btoa("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");

describe("what a person may attach", () => {
  let token: string;
  beforeEach(async () => { token = await join("開発者", "developer"); });
  const send = (attachments: unknown[], content = "これは何？", role = "user") =>
    call("POST", "/v1/messages", { token, body: { messages: [{ role, content, attachments }] } });

  it("photos, PDFs and text files become Anthropic's blocks, made by the relay, before the text", async () => {
    const response = await send([
      { type: "image", mediaType: "image/jpeg", data: JPEG, caption: "動画「旅.mov」 0:03\n(音声なし)" },
      { type: "image", mediaType: "image/png", data: PNG },
      { type: "pdf", name: "資料.pdf", data: PDF },
      { type: "text", name: "メモ.txt", text: "牛乳を買う" },
    ]);
    expect(response.status).toBe(200);
    expect(h.calls[0]!.turns[0]!.content).toEqual([
      { type: "text", text: "動画「旅.mov」 0:03 (音声なし)" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF }, title: "資料.pdf" },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "牛乳を買う" }, title: "メモ.txt" },
      { type: "text", text: "これは何？" },
    ]);
  });

  it("a photo alone, with nothing typed", async () => {
    expect((await send([{ type: "image", mediaType: "image/jpeg", data: JPEG }], "")).status).toBe(200);
    expect(h.calls[0]!.turns[0]!.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG } }]);
  });

  it("nothing that isn't what it says, nothing from elsewhere, only on the person's turns", async () => {
    const bad = [
      [{ type: "image", mediaType: "image/jpeg", data: PNG }],
      [{ type: "image", mediaType: "image/svg+xml", data: JPEG }],
      [{ type: "image", mediaType: "image/jpeg", data: `${JPEG.slice(0, -4)}"}],` }],
      [{ type: "image", mediaType: "image/jpeg", data: `${JPEG}\\u0022` }],
      [{ type: "image", source: { type: "url", url: "https://example.com/a.jpg" } }],
      [{ type: "document", source: { type: "file", file_id: "file_1" } }],
      [{ type: "pdf", data: JPEG }],
      [{ type: "text", text: "  " }],
      [{ type: "video", data: JPEG }],
      ["x"],
    ];
    for (const attachments of bad) expect((await send(attachments)).status).toBe(400);
    const assistant = await call("POST", "/v1/messages", {
      token,
      body: { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", attachments: [{ type: "image", mediaType: "image/jpeg", data: JPEG }] }, { role: "user", content: "c" }] },
    });
    expect(assistant.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("no more than the Worker's ATTACHMENT_MB, and it says how much in the status", async () => {
    const status = (await (await call("GET", "/v1/status", { token })).json()) as { attachments: { bytes: number } };
    expect(status.attachments.bytes).toBe(3 * 1024 * 1024 * 0.75);
    const big = JPEG.slice(0, 8) + "A".repeat(2 * 1024 * 1024);
    expect((await send([{ type: "image", mediaType: "image/jpeg", data: big }, { type: "image", mediaType: "image/jpeg", data: big }])).status).toBe(413);
    h.env.ATTACHMENT_MB = "10";
    expect((await send([{ type: "image", mediaType: "image/jpeg", data: big }, { type: "image", mediaType: "image/jpeg", data: big }])).status).toBe(200);
  });
});

describe("the body with attachments", () => {
  it("is the same JSON as the SDK would write, with each file's base64 placed as it is", () => {
    const params = {
      model: "claude-opus-5-5",
      messages: [
        { role: "user", content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: JPEG } }, { type: "text" as const, text: "fielua-marker \"引用\" \\" }] },
        { role: "assistant", content: "はい" },
        { role: "user", content: [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: PDF }, title: "a.pdf" }, { type: "text" as const, text: "次" }] },
      ],
    };
    const blob = attachedBody(params)!;
    return blob.text().then((text) => {
      expect(JSON.parse(text)).toEqual(params);
      expect(text).not.toMatch(/fielua-[0-9a-f]{8}-/);
      expect(attachedBody({ model: "x", messages: [{ role: "user", content: "text only" }] })).toBeNull();
    });
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
      // With a photo: the same request, the photo before the question.
      const photo: Turn[] = [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG } }, { type: "text", text: "これは？" }] }];
      await (await streamReply(cfg, top.choice, photo, "user-id-1")).text();
      expect(seen[2]!.headers["content-type"]).toBe("application/json");
      expect(seen[2]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
      expect(seen[2]!.body).toEqual({ ...seen[0]!.body, messages: photo });
      await (await streamReply(cfg, haiku.choice, photo, "user-id-1")).text();
      expect(seen[3]!.headers["anthropic-beta"]).toBeUndefined();
      expect(seen[3]!.body).not.toHaveProperty("fallbacks");
      expect(seen[3]!.body).toMatchObject({ model: "claude-haiku-5-5", messages: photo });
      // Web search and files: the tools, the container with Anthropic's document skills, and code execution's beta.
      await (await streamReply(cfg, top.choice, turns, "user-id-1", undefined, { webSearch: true, files: true, container: "container_abc123" })).text();
      expect(seen[4]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01,code-execution-2025-08-25");
      expect(seen[4]!.body).toMatchObject({
        system: systemPrompt({ webSearch: true, files: true, container: null }),
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { type: "code_execution_20260521", name: "code_execution" }],
        container: { id: "container_abc123", skills: [{ type: "anthropic", skill_id: "pdf", version: "latest" }, {}, {}, {}] },
      });
    } finally {
      server.close();
    }
  });

  it.each([
    [400, { type: "invalid_request_error", message: "container_old111 has expired" }],
    // What Anthropic answers for a lapsed container is not documented: a 404 of any wording counts too.
    [404, { type: "not_found_error", message: "Not found" }],
  ])("starts a new container when a chat's old one has lapsed (%i)", async (status, error) => {
    const containers: unknown[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = JSON.parse(data) as { container?: { id?: string } };
        containers.push(body.container?.id ?? null);
        if (body.container?.id) {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const cfg = config({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })!;
      const top = choose(cfg, "claude-opus-5-5", "medium");
      if (!top.ok) throw new Error(top.error);
      const response = await streamReply(cfg, top.choice, [{ role: "user", content: "続き" }], "user-id-1", undefined, { webSearch: false, files: true, container: "container_old111" });
      expect(await response.text()).toContain("message_stop");
      expect(containers).toEqual(["container_old111", null]);
    } finally {
      server.close();
    }
  });

  it.each([
    // Refused for something else: passed on as it is, asked once.
    [400, { type: "invalid_request_error", message: "max_tokens: 999999 > 128000" }, ["container_old111"]],
    // Refused again without the container: passed on, asked twice in all.
    [404, { type: "not_found_error", message: "Not found" }, ["container_old111", null]],
  ])("starts again without the container only once, and only for the container (%i)", async (status, error, asked) => {
    const containers: unknown[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        containers.push((JSON.parse(data) as { container?: { id?: string } }).container?.id ?? null);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const cfg = config({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })!;
      const top = choose(cfg, "claude-opus-5-5", "medium");
      if (!top.ok) throw new Error(top.error);
      await expect(streamReply(cfg, top.choice, [{ role: "user", content: "続き" }], "user-id-1", undefined, { webSearch: false, files: true, container: "container_old111" }))
        .rejects.toMatchObject({ status });
      expect(containers).toEqual(asked);
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

describe("web search and files", () => {
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const made = (container: string, files: string[]) => [
    sse("message_start", { type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", container: { id: container }, usage: { input_tokens: 1000, output_tokens: 1 } } }),
    sse("content_block_start", { type: "content_block_start", index: 1, content_block: {
      type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_1",
      content: { type: "bash_code_execution_result", stdout: "", stderr: "", return_code: 0, content: files.map((file_id) => ({ type: "bash_code_execution_output", file_id })) },
    } }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100, server_tool_use: { web_search_requests: 2 } } }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");

  it("are off unless the app turns them on, with true and nothing else", async () => {
    const token = await join("開発者", "developer");
    await call("POST", "/v1/messages", { token, body: hello });
    await call("POST", "/v1/messages", { token, body: { ...hello, tools: { webSearch: "yes", files: 1 } } });
    await call("POST", "/v1/messages", { token, body: { ...hello, tools: { webSearch: true, files: true } } });
    expect(h.calls.map((c) => c.tools)).toEqual([NO_TOOLS, NO_TOOLS, { webSearch: true, files: true, container: null }]);
    const status = (await (await call("GET", "/v1/status", { token })).json()) as { tools: unknown };
    expect(status.tools).toEqual({ webSearch: true, files: true });
  });

  it("go to Anthropic as its server tools: plain search beside code execution, the newer search alone", () => {
    expect(toolParams(NO_TOOLS)).toEqual({});
    expect(toolParams({ webSearch: true, files: false, container: null })).toEqual({ tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
    ] });
    const skills = ["pdf", "docx", "xlsx", "pptx"].map((skill_id) => ({ type: "anthropic", skill_id, version: "latest" }));
    expect(toolParams({ webSearch: false, files: true, container: "container_abc123" })).toEqual({
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      container: { id: "container_abc123", skills },
    });
    expect(toolParams({ webSearch: true, files: true, container: null })).toEqual({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { type: "code_execution_20260521", name: "code_execution" }],
      container: { skills },
    });
    expect(SYSTEM_PROMPT).toContain("cannot see other chats or browse the web");
    expect(systemPrompt({ webSearch: true, files: false, container: null })).toContain("search the web");
    expect(systemPrompt({ webSearch: false, files: true, container: null })).toContain("$OUTPUT_DIR");
  });

  it("a search costs $0.01 on top of the tokens, in the estimate", async () => {
    expect(costMicros("claude-opus-5-5", { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } })).toBe(4000 + 2000 + 20000);
    const metered = meter(new Response(made("container_abc123", ["file_one111", "file_two222"])).body!, "claude-opus-5-5");
    await new Response(metered.body).text();
    expect(await metered.cost).toBe(26000);
    expect(await metered.outputs).toEqual({ container: "container_abc123", files: ["file_one111", "file_two222"] });
  });

  it("files a reply made are its person's own: only they get them, and go on in its container", async () => {
    const dev = await join("開発者", "developer");
    await call("POST", "/admin/settings", { token: ADMIN, body: { friendsEnabled: true } });
    const friend = await join("友人", "friend");
    h.stream = made("container_dev111", ["file_dev111"]);
    await (await call("POST", "/v1/messages", { token: dev, body: { ...hello, tools: { files: true } } })).text();
    await Promise.all(h.pending);
    const fetched: string[] = [];
    h.deps.files = {
      metadata: async (_cfg, id) => ({ filename: "../../報告書.pdf", mime_type: "application/pdf", size_bytes: 1234, downloadable: true, id }),
      content: async (_cfg, id) => { fetched.push(id); return new Response("%PDF-1.7 本文", { headers: { "Content-Length": "16" } }); },
    };
    const meta = await call("GET", "/v1/files/file_dev111", { token: dev });
    expect(await meta.json()).toEqual({ id: "file_dev111", filename: "報告書.pdf", mimeType: "application/pdf", size: 1234 });
    const file = await call("GET", "/v1/files/file_dev111/content", { token: dev });
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(file.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.pdf");
    expect(await file.text()).toBe("%PDF-1.7 本文");
    // The friend, a stranger and a made-up id all find nothing, and Anthropic is never asked.
    for (const [token, path] of [[friend, "/v1/files/file_dev111/content"], [friend, "/v1/files/file_dev111"], [dev, "/v1/files/file_other99/content"], [dev, "/v1/files/..%2Fadmin/content"]] as const) {
      expect((await call("GET", path, { token })).status).toBe(404);
    }
    expect((await call("GET", "/v1/files/file_dev111/content")).status).toBe(401);
    expect(fetched).toEqual(["file_dev111"]);
    // The next question goes on in the developer's own container; the friend's claim to it is dropped.
    h.stream = "event: message_start\ndata: {}\n\n";
    await call("POST", "/v1/messages", { token: dev, body: { ...hello, tools: { files: true, container: "container_dev111" } } });
    await call("POST", "/v1/messages", { token: friend, body: { ...hello, tools: { files: true, container: "container_dev111" } } });
    expect(h.calls.at(-2)!.tools.container).toBe("container_dev111");
    expect(h.calls.at(-1)!.tools.container).toBeNull();
    // Gone with the person.
    const users = (await (await call("GET", "/admin/state", { token: ADMIN })).json()) as { users: { id: string; role: string }[] };
    await call("DELETE", `/admin/users/${users.users.find((u) => u.role === "developer")!.id}`, { token: ADMIN });
    expect(h.core.ownsOutput(users.users.find((u) => u.role === "developer")!.id, "file", "file_dev111")).toBe(false);
  });

  it("file names are shown and saved as their last part only", () => {
    expect(safeFilename("/mnt/outputs/表.xlsx")).toBe("表.xlsx");
    expect(safeFilename("..\\..\\x.txt")).toBe("x.txt");
    expect(safeFilename("a\u202Eb.pdf")).toBe("ab.pdf");
    expect(safeFilename("..")).toBe("file");
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
