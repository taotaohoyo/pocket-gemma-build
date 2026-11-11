// The relay in Cloudflare's own runtime (workerd, through `wrangler dev`),
// against a stand-in for Anthropic on this machine: the registry's
// Durable Object, a streamed reply arriving piece by piece, the app
// stopping a reply (the stand-in must see its connection close), a kept
// reply going on when its connection drops and read again from its first
// byte, and the relay stopping itself when the credit runs out.
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

const upstream = { requests: [], closedEarly: 0, finished: 0, files: [], ended: [], cut: [] };
// Anthropic's Models API, as the relay asks it which models and levels it offers now.
const MODEL_IDS = ["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
function modelsList(res) {
  const effort = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };
  const data = MODEL_IDS.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-10-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort } }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }));
}

// A file code execution made, as Anthropic's Files API serves it.
const MADE = { id: "file_local1", filename: "報告書.pdf", bytes: Buffer.from("%PDF-1.7 made in the container") };

const anthropic = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) return modelsList(res);
  if (req.method === "GET" && req.url.startsWith(`/v1/files/${MADE.id}`)) {
    upstream.files.push({ url: req.url, headers: req.headers });
    if (req.url.split("?")[0].endsWith("/content")) {
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(MADE.bytes.length) });
      res.end(MADE.bytes);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "file", id: MADE.id, filename: MADE.filename, mime_type: "application/pdf", size_bytes: MADE.bytes.length, created_at: "2026-11-08T00:00:00Z", downloadable: true }));
    }
    return;
  }
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
    const tools = (body.tools ?? []).map((t) => t.type);
    if (tools.length) {
      // A reply that searched once and made a file.
      send("message_start", { type: "message_start", message: { id: "msg_tools", model: body.model, content: [], container: tools.some((t) => t.startsWith("code_execution")) ? { id: "container_local1" } : null, usage: { input_tokens: 1000, output_tokens: 1 } } });
      let index = 0;
      if (tools.some((t) => t.startsWith("web_search"))) {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "server_tool_use", id: "srvtoolu_s", name: "web_search", input: {} } });
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{\"query\":\"東京 天気\"}" } });
        send("content_block_stop", { type: "content_block_stop", index: index++ });
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_s", content: [{ type: "web_search_result", url: "https://example.com/tenki", title: "東京の天気", encrypted_content: "x".repeat(2000), page_age: null }] } });
        send("content_block_stop", { type: "content_block_stop", index: index++ });
      }
      if (tools.some((t) => t.startsWith("code_execution"))) {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "server_tool_use", id: "srvtoolu_c", name: "bash_code_execution", input: {} } });
        send("content_block_stop", { type: "content_block_stop", index: index++ });
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_c", content: { type: "bash_code_execution_result", stdout: "", stderr: "", return_code: 0, content: [{ type: "bash_code_execution_output", file_id: MADE.id }] } } });
        send("content_block_stop", { type: "content_block_stop", index: index++ });
      }
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: "できました。" } });
      send("content_block_stop", { type: "content_block_stop", index });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10, server_tool_use: { web_search_requests: tools.some((t) => t.startsWith("web_search")) ? 1 : 0 } } });
      send("message_stop", { type: "message_stop" });
      upstream.finished++;
      res.end();
      return;
    }
    send("message_start", { type: "message_start", message: { id: "msg_local", model: body.model, content: [], usage: { input_tokens: 1000, output_tokens: 1 } } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const slowly = String(question).startsWith("slow");
    const pieces = slowly ? 100 : 5;
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
      upstream.ended.push(question);
      res.end();
    }, slowly ? 150 : 20);
    res.on("close", () => {
      clearInterval(timer);
      if (!done) { upstream.closedEarly++; upstream.cut.push(question); }
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
  const page = await (await fetch(`${relay}/join`)).text();
  check("its page offers the iPhone app or Fielua for the web", page.includes("iPhone の Fielua アプリで登録") &&
    page.includes('id="web"') && page.includes('"https://suelira.com/chat/" + "#invite="'));
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
    JSON.stringify(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => [id, "low/medium/high/xhigh"])));
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

  // Photos and PDFs: checked, then passed on byte for byte in the body the relay writes
  const fileOf = (head, size) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7919 + 13) & 0xff;
    bytes.set(head);
    return Buffer.from(bytes).toString("base64");
  };
  const photo = fileOf([0xff, 0xd8, 0xff, 0xe0], 1_500_000);
  const pdf = fileOf([0x25, 0x50, 0x44, 0x46, 0x2d], 600_000);
  const attachedAsk = (attachments, content = "これは何？") => ({ messages: [{ role: "user", content, attachments }] });
  const photoStarted = Date.now();
  const withFiles = await api("POST", "/v1/messages", { token, body: attachedAsk([
    { type: "image", mediaType: "image/jpeg", data: photo, caption: "動画「海.mov」 0:12" },
    { type: "pdf", name: "教材.pdf", data: pdf },
    { type: "text", name: "メモ.txt", text: "三行のメモ" },
  ]) });
  const withFilesText = await withFiles.text();
  const filed = upstream.requests.at(-1);
  const blocks = filed.body.messages[0].content;
  check("a photo, a PDF and a text file reach Anthropic as they were sent", withFiles.status === 200 && withFilesText.includes("message_stop") &&
    blocks.length === 5 && blocks[0].text === "動画「海.mov」 0:12" && blocks[1].source.data === photo && blocks[1].source.media_type === "image/jpeg" &&
    blocks[2].source.data === pdf && blocks[2].title === "教材.pdf" && blocks[3].source.data === "三行のメモ" && blocks[4].text === "これは何？",
    `${Date.now() - photoStarted} ms, ${blocks.map((b) => b.type).join(",")}`);
  check("with the relay's own parameters around them", filed.body.model === "claude-opus-5-5" && filed.body.fallbacks === "default" &&
    filed.headers["anthropic-beta"]?.includes("server-side-fallback") && filed.body.system.includes("still frames") && filed.headers.authorization === "Bearer sk-ant-local-check");
  const before4 = upstream.requests.length;
  const tooBig = await api("POST", "/v1/messages", { token, body: attachedAsk([{ type: "pdf", name: "大きい.pdf", data: fileOf([0x25, 0x50, 0x44, 0x46, 0x2d], 2_600_000) }]) });
  const notPhoto = await api("POST", "/v1/messages", { token, body: attachedAsk([{ type: "image", mediaType: "image/png", data: photo }]) });
  check("too much, or a photo that is not what it says, is refused and not sent", tooBig.status === 413 && (await tooBig.json()).error === "too_large" &&
    notPhoto.status === 400 && (await notPhoto.json()).error === "bad_attachment" && upstream.requests.length === before4);
  check("the app learns how much it may attach", status.attachments?.bytes === 3 * 1024 * 1024 * 0.75, JSON.stringify(status.attachments));

  // Web search and files: the tools go out, a search is counted, and the file made is the developer's alone
  await api("POST", "/admin/settings", { token: ADMIN, body: { creditUSD: 10 } });
  const before5 = (await (await api("GET", "/v1/status", { token })).json()).credit?.spentUSD ?? 0;
  const tooled = await api("POST", "/v1/messages", { token, body: { ...ask("報告書を PDF で"), tools: { webSearch: true, files: true } } });
  const tooledText = await tooled.text();
  const sentTools = upstream.requests.at(-1);
  check("web search and file making go out as Anthropic's server tools", tooled.status === 200 && tooledText.includes("file_local1") &&
    JSON.stringify(sentTools.body.tools.map((t) => t.type)) === JSON.stringify(["web_search_20250305", "code_execution_20260521"]) &&
    sentTools.body.container?.skills?.length === 4 && sentTools.headers["anthropic-beta"]?.includes("code-execution-2025-08-25"), JSON.stringify(sentTools.body.tools));
  await sleep(300);
  const after5 = (await (await api("GET", "/v1/status", { token })).json()).credit?.spentUSD ?? 0;
  check("a search is counted at $0.01 with the tokens", Math.abs(after5 - before5 - (0.004 + 0.0002 + 0.01)) < 1e-9, `${after5 - before5}`);
  const meta = await api("GET", "/v1/files/file_local1", { token });
  const metaBody = await meta.json();
  const file = await api("GET", "/v1/files/file_local1/content", { token });
  const fileBytes = Buffer.from(await file.arrayBuffer());
  check("the file it made comes down, by name, as a download", meta.status === 200 && metaBody.filename === "報告書.pdf" && file.status === 200 &&
    fileBytes.equals(MADE.bytes) && file.headers.get("content-type") === "application/octet-stream" && file.headers.get("content-disposition")?.startsWith("attachment"),
    JSON.stringify(metaBody));
  check("the Files API got the relay's key, which the app never has", upstream.files.at(-1)?.headers["x-api-key"] === "sk-ant-local-check" || upstream.files.at(-1)?.headers.authorization === "Bearer sk-ant-local-check");
  await (await api("POST", "/v1/messages", { token, body: { ...ask("直して"), tools: { files: true, container: "container_local1" } } })).text();
  check("the next question goes on in the same container", upstream.requests.at(-1).body.container?.id === "container_local1");

  check("Anthropic's Models API says the four models are offered", status.models?.every((m) => m.available === true), JSON.stringify(status.models?.map((m) => m.available)));

  // The web app's origin, and no other
  const pre = await fetch(`${relay}/v1/messages`, { method: "OPTIONS", headers: { Origin: "https://suelira.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
  const evil = await fetch(`${relay}/v1/messages`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  check("a browser may call from suelira.com only", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "https://suelira.com" &&
    evil.status === 403 && !evil.headers.get("access-control-allow-origin"));
  check("the web's sign-in refuses other origins", (await fetch(`${relay}/web/passkey/login/options`, { method: "POST", headers: { Origin: "https://evil.example" } })).status === 403);

  // The estimate of the credit left: each reply's usage, against the balance entered
  const credit = await (await api("POST", "/admin/settings", { token: ADMIN, body: { creditUSD: 10 } })).json();
  check("the developer enters the balance", credit.credit?.percent === 100 && credit.credit?.budgetUSD === 10);
  await (await api("POST", "/v1/messages", { token, body: ask("こんにちは") })).text();
  await sleep(300);
  const spent = (await (await api("GET", "/v1/status", { token })).json()).credit;
  // 1,000 input at $4 and 5 output at $20 per million: $0.0041
  check("a reply's usage is counted at Opus 5.5's prices", Math.abs(spent?.spentUSD - 0.0041) < 1e-9 && Math.abs(spent?.remainingUSD - 9.9959) < 1e-9, JSON.stringify(spent));

  // Pieces arrive as they come, not all at the end (the credit meter in the way)
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
  await sleep(300);
  const afterStops = (await (await api("GET", "/v1/status", { token })).json()).credit;
  check("stopped replies are counted too", afterStops?.spentUSD > spent?.spentUSD, JSON.stringify(afterStops));

  // Friends
  const friendInvite = await (await api("POST", "/admin/invites", { token: ADMIN, body: { name: "友人", role: "friend" } })).json();
  const friend = (await (await api("POST", "/v1/redeem", { body: { code: friendInvite.code } })).json()).token;
  const before2 = upstream.requests.length;
  const refused = await api("POST", "/v1/messages", { token: friend, body: ask("こんにちは") });
  check("a friend is refused while friends are off", refused.status === 503 && (await refused.json()).reason === "friends_disabled");
  check("and nothing reaches Anthropic", upstream.requests.length === before2);
  await api("POST", "/admin/settings", { token: ADMIN, body: { friendsEnabled: true } });
  check("friends on: the friend can use Claude", (await api("POST", "/v1/messages", { token: friend, body: ask("こんにちは") })).status === 200);
  const filesBefore = upstream.files.length;
  check("a friend can't download the developer's file", (await api("GET", "/v1/files/file_local1/content", { token: friend })).status === 404 && upstream.files.length === filesBefore);

  // A reply a dropped connection doesn't end (Fielua for the web, Safari in the background)
  check("the relay says replies can be read again", (await (await api("GET", "/v1/status", { token })).json()).resumable === true);
  const count = (list, question) => list.filter((q) => q === question).length;
  const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const dropping = new AbortController();
  const replyID = newKey();
  const kept = await api("POST", `/v1/replies/${replyID}`, { token, body: ask("slow-kept"), signal: dropping.signal });
  check("a kept reply streams, under the key the page chose", kept.status === 200 && kept.headers.get("x-fielua-reply") === replyID, `${kept.status}`);
  const keptReader = kept.body.getReader();
  let firstBytes = new Uint8Array(0);
  while (firstBytes.length < 400) {
    const next = await keptReader.read();
    if (next.done) break;
    firstBytes = new Uint8Array([...firstBytes, ...next.value]);
  }
  dropping.abort();
  await sleep(1200);
  check("the connection dropped: Anthropic goes on writing", !count(upstream.cut, "slow-kept") && !count(upstream.ended, "slow-kept"),
    JSON.stringify({ cut: count(upstream.cut, "slow-kept"), ended: count(upstream.ended, "slow-kept") }));
  check("someone else can't read it, even with its key", (await api("GET", `/v1/replies/${replyID}`, { token: friend })).status === 404);
  check("nor anyone without a key", (await api("GET", `/v1/replies/${replyID}`)).status === 401);
  check("a made-up key is not found", (await api("GET", `/v1/replies/${newKey()}`, { token })).status === 404 &&
    (await api("GET", "/v1/replies/nonsense", { token })).status === 404 && (await api("POST", "/v1/replies/nonsense", { token, body: ask("x") })).status === 404);
  const again = await api("GET", `/v1/replies/${replyID}`, { token });
  const againReader = again.body.getReader();
  const againFirst = await againReader.read();
  check("read again, it arrives at once, before the reply ends", again.status === 200 && !againFirst.done && !count(upstream.ended, "slow-kept") &&
    again.headers.get("x-fielua-reply") === replyID);
  let againBytes = againFirst.value ?? new Uint8Array(0);
  for (;;) {
    const next = await againReader.read();
    if (next.done) break;
    againBytes = new Uint8Array([...againBytes, ...next.value]);
  }
  const againText = new TextDecoder().decode(againBytes);
  check("from the first byte, the same bytes as were sent", firstBytes.length > 0 && firstBytes.every((byte, i) => againBytes[i] === byte));
  check("and on to the end, written once at Anthropic", againText.includes("片99") && againText.includes("message_stop") &&
    count(upstream.ended, "slow-kept") === 1 && !count(upstream.cut, "slow-kept") && count(upstream.requests.map((r) => r.body.messages.at(-1).content), "slow-kept") === 1);
  const afterEnd = await api("GET", `/v1/replies/${replyID}`, { token });
  check("after the end, the whole reply once more", afterEnd.status === 200 && (await afterEnd.text()) === againText);
  check("the page says it has it: forgotten", (await api("DELETE", `/v1/replies/${replyID}`, { token })).status === 200 &&
    (await api("GET", `/v1/replies/${replyID}`, { token })).status === 404 && (await api("DELETE", `/v1/replies/${replyID}`, { token })).status === 404);
  const stopID = newKey();
  const stopping = await api("POST", `/v1/replies/${stopID}`, { token, body: ask("slow-stop") });
  await stopping.body.getReader().read();
  check("someone else can't stop it", (await api("DELETE", `/v1/replies/${stopID}`, { token: friend })).status === 404);
  const stopped = await api("DELETE", `/v1/replies/${stopID}`, { token });
  let stoppedAtAnthropic = false;
  for (let i = 0; i < 40 && !stoppedAtAnthropic; i++) {
    await sleep(250);
    stoppedAtAnthropic = count(upstream.cut, "slow-stop") === 1;
  }
  check("停止 (DELETE) stops it at Anthropic", stopped.status === 200 && stoppedAtAnthropic);
  check("and it is gone", (await api("GET", `/v1/replies/${stopID}`, { token })).status === 404);
  const earlyID = newKey();
  const earlyStop = await api("DELETE", `/v1/replies/${earlyID}`, { token });
  const asksBefore = upstream.requests.length;
  const late = await api("POST", `/v1/replies/${earlyID}`, { token, body: ask("slow-late") });
  check("停止 that overtook its question: the question asks nothing", earlyStop.status === 404 && late.status === 409 && upstream.requests.length === asksBefore);

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
