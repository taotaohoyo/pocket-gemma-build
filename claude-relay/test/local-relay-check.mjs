// The relay in Cloudflare's own runtime (workerd, through `wrangler dev`),
// against a stand-in for Anthropic on this machine: the registry's
// Durable Object, a streamed reply arriving piece by piece, the app
// stopping a reply (the stand-in must see its connection close), and the
// relay stopping itself when the credit runs out.
//
//   npm run test:local
//
// No real key and no network: the stand-in answers on 127.0.0.1.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN = "local-check-admin-key-0123456789abcdef";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// MARK: The stand-in for Anthropic

const upstream = { requests: [], closedEarly: 0, finished: 0 };
const anthropic = createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    const body = JSON.parse(data);
    upstream.requests.push({ headers: req.headers, body });
    const question = body.messages.at(-1).content;
    if (question === "billing") {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low." } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "msg_local", model: body.model, content: [] } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const pieces = question === "slow" ? 100 : 5;
    let sent = 0;
    let done = false;
    const timer = setInterval(() => {
      if (sent < pieces) {
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `片${sent} ` } });
        sent++;
        return;
      }
      clearInterval(timer);
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: pieces } });
      send("message_stop", { type: "message_stop" });
      done = true;
      upstream.finished++;
      res.end();
    }, question === "slow" ? 150 : 20);
    res.on("close", () => {
      clearInterval(timer);
      if (!done) upstream.closedEarly++;
    });
  });
});
await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
const anthropicPort = anthropic.address().port;

// MARK: The relay in workerd

const relayPort = 18000 + Math.floor(Math.random() * 1000);
const state = mkdtempSync(join(tmpdir(), "fielua-relay-"));
const wrangler = spawn("npx", [
  "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(relayPort), "--persist-to", state,
  "--var", "ANTHROPIC_API_KEY:sk-ant-local-check",
  "--var", `ADMIN_TOKEN:${ADMIN}`,
  "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${anthropicPort}`,
], { env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
// npx, wrangler and workerd: the whole group goes when the check ends.
const stopRelay = () => { try { process.kill(-wrangler.pid, "SIGTERM"); } catch {} };
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));

const relay = `http://127.0.0.1:${relayPort}`;
async function ready() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${relay}/join`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function api(method, path, { token, body, signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(relay + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
}

const ask = (content) => ({ messages: [{ role: "user", content }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (!(await ready())) throw new Error("wrangler dev did not start:\n" + log);

  // Admin and invites
  check("admin routes refuse a wrong key", (await api("GET", "/admin/state", { token: "wrong" })).status === 401);
  const made = await (await api("POST", "/admin/invites", { token: ADMIN, body: { name: "開発者", role: "developer" } })).json();
  check("an invite link carries the code after #", made.link === `${relay}/join#${made.code}`);
  const redeemed = await api("POST", "/v1/redeem", { body: { code: made.code } });
  const { token } = await redeemed.json();
  check("the invite gives an access token", redeemed.status === 200 && /^fcl_/.test(token));
  check("and only once", (await api("POST", "/v1/redeem", { body: { code: made.code } })).status === 400);
  const status = await (await api("GET", "/v1/status", { token })).json();
  check("the developer can use Claude", status.available === true && status.modelName === "Claude Opus 5.5", JSON.stringify(status));

  // A reply, streamed
  const started = Date.now();
  const reply = await api("POST", "/v1/messages", { token, body: ask("こんにちは") });
  const text = await reply.text();
  check("a reply streams back as Anthropic's events", reply.status === 200 && text.includes("片4") && text.includes("message_stop"));
  const sent = upstream.requests.at(-1);
  check("the key goes only to Anthropic, in its header", sent.headers.authorization === "Bearer sk-ant-local-check");
  check("with the relay's model and system prompt", sent.body.model === "claude-opus-5-5" && sent.body.system.includes("Fielua") && sent.body.fallbacks === "default");
  check("the app never sees the key", !text.includes("sk-ant-local-check"));
  console.log(`  (reply in ${Date.now() - started} ms)`);

  // The model and level the person chose
  check("the app learns the four models and their levels", JSON.stringify(status.models?.map((m) => [m.id, m.efforts.join("/")])) ===
    JSON.stringify(["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => [id, "low/medium/high/xhigh"])));
  await (await api("POST", "/v1/messages", { token, body: { ...ask("こんにちは"), model: "claude-opus-5-5", effort: "xhigh" } })).text();
  const top = upstream.requests.at(-1).body;
  check("Opus 5.5 at 超高 goes out as effort xhigh", top.model === "claude-opus-5-5" && top.output_config?.effort === "xhigh" && top.max_tokens === 64000, JSON.stringify(top.output_config));
  await (await api("POST", "/v1/messages", { token, body: { ...ask("こんにちは"), model: "claude-haiku-5-5", effort: "low" } })).text();
  const haiku = upstream.requests.at(-1);
  check("Haiku 5.5 at 低 goes out as itself, without a fallback", haiku.body.model === "claude-haiku-5-5" && haiku.body.output_config?.effort === "low" && !("fallbacks" in haiku.body) && !haiku.headers["anthropic-beta"]);
  const before1 = upstream.requests.length;
  const maxed = await api("POST", "/v1/messages", { token, body: { ...ask("こんにちは"), model: "claude-opus-5-5", effort: "max" } });
  const unknown = await api("POST", "/v1/messages", { token, body: { ...ask("こんにちは"), model: "claude-opus-4-1" } });
  check("max and unknown models are refused, and not sent", maxed.status === 400 && (await maxed.json()).error === "unsupported_effort" &&
    unknown.status === 400 && (await unknown.json()).error === "unsupported_model" && upstream.requests.length === before1);

  // Pieces arrive as they come, not all at the end
  const finishedBefore = upstream.finished;
  const slow = await api("POST", "/v1/messages", { token, body: ask("slow") });
  const reader = slow.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now();
  check("the first piece arrives before the reply ends", !first.done && upstream.finished === finishedBefore);

  // Stopping: the app closes its connection, and Anthropic's request ends too
  const before = upstream.closedEarly;
  await sleep(600);
  await reader.cancel();
  let closed = false;
  for (let i = 0; i < 40 && !closed; i++) {
    await sleep(250);
    closed = upstream.closedEarly > before;
  }
  check("stopping a reply closes the request to Anthropic", closed, `${Date.now() - firstAt} ms after the first piece`);

  // The same with an aborted fetch (how URLSession's cancel looks)
  const controller = new AbortController();
  const aborted = await api("POST", "/v1/messages", { token, body: ask("slow"), signal: controller.signal });
  const abortReader = aborted.body.getReader();
  await abortReader.read();
  const beforeAbort = upstream.closedEarly;
  controller.abort();
  closed = false;
  for (let i = 0; i < 40 && !closed; i++) {
    await sleep(250);
    closed = upstream.closedEarly > beforeAbort;
  }
  check("an aborted request is stopped at Anthropic too", closed);

  // Friends
  const friendInvite = await (await api("POST", "/admin/invites", { token: ADMIN, body: { name: "友人", role: "friend" } })).json();
  const friend = (await (await api("POST", "/v1/redeem", { body: { code: friendInvite.code } })).json()).token;
  const before2 = upstream.requests.length;
  const refused = await api("POST", "/v1/messages", { token: friend, body: ask("こんにちは") });
  check("a friend is refused while friends are off", refused.status === 503 && (await refused.json()).reason === "friends_disabled");
  check("and nothing reaches Anthropic", upstream.requests.length === before2);
  await api("POST", "/admin/settings", { token: ADMIN, body: { friendsEnabled: true } });
  check("friends on: the friend can use Claude", (await api("POST", "/v1/messages", { token: friend, body: ask("こんにちは") })).status === 200);
  const state1 = await (await api("GET", "/admin/state", { token: ADMIN })).json();
  const friendID = state1.users.find((u) => u.role === "friend").id;
  await api("POST", `/admin/users/${friendID}/revoke`, { token: ADMIN });
  check("a revoked friend is refused on the next request", (await api("POST", "/v1/messages", { token: friend, body: ask("こんにちは") })).status === 403);
  await api("DELETE", `/admin/users/${friendID}`, { token: ADMIN });
  check("a deleted friend's token is unknown", (await api("GET", "/v1/status", { token: friend })).status === 401);
  check("the admin list holds no tokens", !JSON.stringify(state1).includes("fcl_"));

  // Out of credit
  const billing = await api("POST", "/v1/messages", { token, body: ask("billing") });
  check("out of credit: the relay stops itself", billing.status === 503 && (await billing.json()).reason === "paused_billing");
  const before3 = upstream.requests.length;
  const stillPaused = await api("POST", "/v1/messages", { token, body: ask("こんにちは") });
  check("and sends nothing more to Anthropic", stillPaused.status === 503 && upstream.requests.length === before3);
  await api("POST", "/admin/settings", { token: ADMIN, body: { resume: true } });
  check("until the developer resumes", (await api("POST", "/v1/messages", { token, body: ask("こんにちは") })).status === 200);
} catch (error) {
  check("the check ran", false, String(error));
} finally {
  stopRelay();
  anthropic.close();
  await sleep(500);
  rmSync(state, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
