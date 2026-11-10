// Fielua for the web, end to end on this machine: the built /chat/ folder
// served as Sakura would serve it (with the .htaccess headers), the relay
// in Cloudflare's own runtime (wrangler dev / workerd), a stand-in for
// Anthropic, and Chromium with a virtual passkey authenticator (Face ID's
// stand-in). No real key, no network, no real Anthropic call: a pass here
// is not a pass against the real Claude API.
//
//   node test/e2e.mjs            (PEOPLE_SHOTS=dir also saves 2x screenshots for people)
//   STUDIO=dir node test/e2e.mjs (no checks: every screen and each motion as pictures, test/studio.mjs)

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { connect, createServer as createCable } from "node:net";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(root, "..", "claude-relay");
const ADMIN = "e2e-admin-key-0123456789abcdef0123456789";
const SHOTS = join(root, "test-results");
const PEOPLE = process.env.PEOPLE_SHOTS;
mkdirSync(SHOTS, { recursive: true });
if (PEOPLE) mkdirSync(PEOPLE, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MARK: The stand-in for Anthropic

const DEEP = "途中で切れても、考え直さずに最後まで書きました。".repeat(4);

const MD = [
  "## 東京の週末プラン",
  "",
  "これは**「重要」**です。`npm run build` で組み立てます。詳しくは[公式サイト](https://example.com/docs)と https://example.org を見てください。",
  "",
  "1. 朝は**浅草**へ",
  "2. 昼は*上野*で美術館",
  "   - 国立西洋美術館",
  "   - 東京都美術館",
  "3. 夜は~~銀座~~新宿",
  "",
  "> 引用です。混雑に注意してください。",
  "",
  "| 日程 | 場所 | 費用 |",
  "| :--- | :---: | ---: |",
  "| 土曜 | 浅草 | 1,200円 |",
  "| 日曜 | 上野 | 2,000円 |",
  "| 合計 | — | 3,200円 |",
  "",
  "```python",
  "def total(prices):",
  "    # 合計を出す",
  "    return sum(prices)  # 3200",
  "```",
  "",
  "円の面積は $S = \\pi r^2$ で、価格は $5 と $10 です。",
  "",
  "$$",
  "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
  "$$",
  "",
  "<script>window.__xss = 1</script> <img src=x onerror=\"window.__xss = 2\"> [押す](javascript:window.__xss=3) ![猫](javascript:alert(1))",
  "",
  "---",
  "",
  "### まとめ",
  "",
  "楽しい週末を。",
].join("\n");

const LONG = ["```js", ...Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`), "```", "", "| n | 二乗 |", "|---:|---:|",
  ...Array.from({ length: 40 }, (_, i) => `| ${i} | ${i * i} |`)].join("\n");

// Haiku isn't offered and Fable takes no 超高: the page must not let either be chosen.
const OFFERED = {
  "claude-opus-5-5": ["low", "medium", "high", "xhigh"],
  "claude-fable-5-2": ["low", "medium", "high"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh"],
};

const upstream = { requests: [], closedEarly: 0, files: [], asked: [] };
// The files a reply's code made, as the Files API keeps them (the chart's picture is drawn in the browser later).
const MADE = {
  file_e2e_report: { filename: "週末の予定.csv", mime_type: "text/csv", bytes: Buffer.from("日程,場所,費用\n土曜,浅草,1200\n日曜,上野,2000\n") },
  file_e2e_chart: { filename: "/mnt/user-data/outputs/費用のグラフ.png", mime_type: "image/png", bytes: Buffer.alloc(0) },
};

/** A reply that searched the web (and, for 「調べもの」, stopped to continue), or that made two files with code. */
function toolEvents(question, body) {
  const types = (body.tools ?? []).map((tool) => tool.type);
  const events = [["message_start", { type: "message_start", message: { id: "msg_e2e_tools", model: body.model, content: [], usage: { input_tokens: 1200, output_tokens: 1 },
    ...(types.some((t) => t.startsWith("code_execution")) ? { container: { id: "container_e2e01", expires_at: "2026-12-08T00:00:00Z" } } : {}) } }]];
  const text = (index, pieces) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
    for (const piece of pieces) {
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: typeof piece === "string" ? { type: "text_delta", text: piece } : { type: "citations_delta", citation: piece } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  };
  const tool = (index, name, json, result) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "server_tool_use", id: `srvtoolu_e2e${index}`, name, input: {} } }]);
    for (let i = 0; i < json.length; i += 12) events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 12) } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    events.push({ wait: 900 });
    events.push(["content_block_start", { type: "content_block_start", index: index + 1, content_block: { tool_use_id: `srvtoolu_e2e${index}`, ...result } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: index + 1 }]);
  };
  let searches = 0;
  let stop = "end_turn";
  if (question === "検索" || question === "調べもの") {
    if (!types.some((t) => t.startsWith("web_search"))) return null;
    text(0, ["調べます。"]);
    tool(1, "web_search", JSON.stringify({ query: "東京 週末の天気" }), { type: "web_search_tool_result", content: [
      { type: "web_search_result", url: "https://weather.example.jp/tokyo", title: "東京の週末の天気", encrypted_content: "e2e", page_age: "2026-11-08" },
      { type: "web_search_result", url: "https://www.news.example.com/weekend", title: "週末は晴れ　関東の天気", encrypted_content: "e2e" },
      { type: "web_search_result", url: "javascript:alert(1)", title: "悪いページ", encrypted_content: "e2e" },
    ] });
    searches = 1;
    if (question === "調べもの") stop = "pause_turn";
    else text(3, ["週末の東京は", { type: "web_search_result_location", url: "https://weather.example.jp/tokyo", title: "東京の週末の天気", cited_text: "晴れ", encrypted_index: "e2e" }, "**晴れ**です。"]);
  } else if (question === "ファイル") {
    if (!types.some((t) => t.startsWith("code_execution"))) return null;
    text(0, ["表とグラフを作ります。"]);
    tool(1, "text_editor_code_execution", JSON.stringify({ command: "create", path: "/mnt/user-data/outputs/週末の予定.csv", file_text: "日程,場所" }),
      { type: "text_editor_code_execution_tool_result", content: { type: "text_editor_code_execution_create_result", is_file_update: false } });
    tool(3, "bash_code_execution", JSON.stringify({ command: "python chart.py" }), { type: "bash_code_execution_tool_result", content: {
      type: "bash_code_execution_result", stdout: "ok", stderr: "", return_code: 0,
      content: [{ type: "bash_code_execution_output", file_id: "file_e2e_report" }, { type: "bash_code_execution_output", file_id: "file_e2e_chart" }],
    } });
    text(5, ["作りました。"]);
  } else return null;
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 150, ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}) } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events;
}

const anthropic = createServer((req, res) => {
  const filePath = /^\/v1\/files\/([^/?]+)(\/content)?(?:\?.*)?$/.exec(req.url);
  if (req.method === "GET" && filePath) {
    upstream.files.push({ id: filePath[1], content: !!filePath[2], headers: req.headers });
    const file = MADE[filePath[1]];
    if (!file) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "File not found" } })); return; }
    if (filePath[2]) { res.writeHead(200, { "Content-Type": file.mime_type, "Content-Length": file.bytes.length }); res.end(file.bytes); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "file", id: filePath[1], filename: file.filename, mime_type: file.mime_type, size_bytes: file.bytes.length, created_at: "2026-11-08T00:00:00Z", downloadable: true }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    const data = Object.entries(OFFERED).map(([id, levels]) => {
      const effort = { supported: true };
      for (const level of ["low", "medium", "high", "xhigh", "max"]) effort[level] = { supported: levels.includes(level) || level === "max" };
      return { type: "model", id, display_name: id, created_at: "2026-10-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort } };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }));
    return;
  }
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    const body = JSON.parse(data);
    upstream.requests.push({ headers: req.headers, body });
    const lastContent = body.messages.at(-1).content;
    // A message with attachments: its text is the last block.
    const question = (typeof lastContent === "string" ? lastContent : (lastContent.filter((b) => b.type === "text").at(-1)?.text ?? "")).trim();
    upstream.asked.push(question);
    if (question === "billing") {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low." } }));
      return;
    }
    // "late": Anthropic takes a while before it answers at all (the page's question is still unanswered).
    if (question === "late") {
      let gone = false;
      res.on("close", () => { if (!res.headersSent) { gone = true; upstream.closedEarly++; } });
      setTimeout(() => { if (!gone) answer(question, body, res); }, 1500);
      return;
    }
    answer(question, body, res);
  });
});
function answer(question, body, res) {
  {
    let reply = `受け取りました：${question}`;
    let pieceSize = 6;
    let every = 15;
    let usage = { input_tokens: 1000, output_tokens: 100 };
    if (question === "md") reply = MD;
    if (question === "long") { reply = LONG; pieceSize = 200; }
    if (question === "slow") { reply = "ゆっくり答えます。".repeat(200); pieceSize = 3; every = 60; }
    if (question === "添付") {
      const blocks = body.messages.filter((m) => Array.isArray(m.content)).flatMap((m) => m.content).map((b) => b.type === "text" ? "text" : `${b.type}:${b.source.media_type}`);
      reply = `blocks=${blocks.join(",")}`;
    }
    if (question === "echo") {
      reply = `model=${body.model} effort=${body.output_config?.effort} max=${body.max_tokens} turns=${body.messages.length} thinking=${body.thinking?.type}`;
      usage = { input_tokens: 200000, output_tokens: 100000 };
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    const scripted = toolEvents(question, body);
    if (scripted) {
      let closed = false;
      res.on("close", () => { closed = true; });
      (async () => {
        for (const item of scripted) {
          if (closed) return;
          if (item.wait) { await sleep(item.wait); continue; }
          send(...item);
          await sleep(15);
        }
        res.end();
      })();
      return;
    }
    send("message_start", { type: "message_start", message: { id: "msg_e2e", model: body.model, content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
    let index = 0;
    const pieces = [];
    if (question === "think") {
      for (let i = 0; i < 20; i++) pieces.push({ thinking: "…" });
      reply = "考えた結果、答えは 42 です。";
    }
    if (question === "deep" || question === "late") {
      // A long think (3 seconds), then the reply: the connection is cut while it thinks.
      for (let i = 0; i < 30; i++) pieces.push({ thinking: "…" });
      reply = DEEP;
      every = 100;
    }
    for (let i = 0; i < reply.length; i += pieceSize) pieces.push({ text: reply.slice(i, i + pieceSize) });
    if (question === "overload") pieces.splice(3, pieces.length, { error: "overloaded_error" });
    let started = null;
    let done = false;
    const timer = setInterval(() => {
      const piece = pieces[index++];
      if (!piece) {
        clearInterval(timer);
        if (started) send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } });
        send("message_stop", { type: "message_stop" });
        done = true;
        res.end();
        return;
      }
      if (piece.error) {
        clearInterval(timer);
        send("error", { type: "error", error: { type: piece.error, message: "Overloaded" } });
        done = true;
        res.end();
        return;
      }
      const kind = piece.thinking ? "thinking" : "text";
      if (started !== kind) {
        if (started) send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } });
        started = kind;
      }
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: kind === "text" ? { type: "text_delta", text: piece.text } : { type: "thinking_delta", thinking: piece.thinking } });
    }, every);
    res.on("close", () => {
      clearInterval(timer);
      if (!done) upstream.closedEarly++;
    });
  }
}
await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
const anthropicPort = anthropic.address().port;

// MARK: The page, served as Sakura serves the folder

const webPort = 19000 + Math.floor(Math.random() * 500);
const relayPort = 18500 + Math.floor(Math.random() * 400);
// The page reaches the relay over a cable the test can cut, as Safari drops a page's connections in the background.
const cablePort = 17500 + Math.floor(Math.random() * 400);
const relay = `http://127.0.0.1:${cablePort}`;
const cable = { sockets: new Set(), refuse: false, replyGets: 0 };
cable.cut = () => { for (const socket of cable.sockets) socket.destroy(); };
const cableServer = createCable((client) => {
  if (cable.refuse) { client.destroy(); return; }
  const far = connect(relayPort, "127.0.0.1");
  cable.sockets.add(client);
  client.on("data", (chunk) => { if (/^GET \/v1\/replies\/[0-9a-f]{32} /m.test(chunk.toString("latin1"))) cable.replyGets++; });
  client.pipe(far).pipe(client);
  const close = () => { cable.sockets.delete(client); client.destroy(); far.destroy(); };
  client.on("error", close).on("close", close);
  far.on("error", close).on("close", close);
});
await new Promise((resolve) => cableServer.listen(cablePort, "127.0.0.1", resolve));
execFileSync("node", ["build.mjs"], { cwd: root, env: { ...process.env, RELAY_URL: relay, OUT_DIR: "dist-test", NO_ZIP: "1" }, stdio: "inherit" });
const site = join(root, "dist-test", "chat");
const htaccess = readFileSync(join(site, ".htaccess"), "utf8");
const headerCSP = /Content-Security-Policy "([^"]+)"/.exec(htaccess)[1];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<p>suelira top</p>"); return; }
  if (!url.pathname.startsWith("/chat/")) { res.writeHead(404); res.end(); return; }
  let path = normalize(join(site, decodeURIComponent(url.pathname.slice(6)) || "index.html"));
  if (!path.startsWith(site) || path.endsWith(".htaccess")) { res.writeHead(403); res.end(); return; }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
    "Content-Security-Policy": headerCSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(readFileSync(path));
});
await new Promise((resolve) => web.listen(webPort, "127.0.0.1", resolve));
const page0 = `http://localhost:${webPort}/chat/`;

// MARK: The relay in workerd

const persist = mkdtempSync(join(tmpdir(), "fielua-web-e2e-"));
const wrangler = spawn("npx", [
  "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(relayPort), "--persist-to", persist,
  "--var", "ANTHROPIC_API_KEY:sk-ant-e2e-stand-in",
  "--var", `ADMIN_TOKEN:${ADMIN}`,
  "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${anthropicPort}`,
  "--var", `WEB_ORIGINS:http://localhost:${webPort}`,
  "--var", "WEB_RP_ID:localhost",
], { cwd: relayDir, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let relayLog = "";
wrangler.stdout.on("data", (d) => (relayLog += d));
wrangler.stderr.on("data", (d) => (relayLog += d));
const stopRelay = () => { try { process.kill(-wrangler.pid, "SIGTERM"); } catch {} };
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${relay}/join`)).ok) break; } catch {}
  await sleep(500);
}

// MARK: Helpers

async function passkeyDevice(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

async function watch(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // A refused request (401, 403, 503) or no connection is logged by the browser itself; those are checked one by one above.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  return errors;
}

/** A sheet or an alert goes with a motion: what comes next waits until it has gone. */
const settled = (page) => page.waitForFunction(() => !document.querySelector("dialog.closing"));
/** True once the page shows `selector` `count` times (what leaves goes with a motion, so not at once). */
const becomes = (page, selector, count, timeout = 3000) =>
  page.waitForFunction(([s, n]) => document.querySelectorAll(s).length === n, [selector, count], { timeout }).then(() => true, () => false);
/** True once `selector` is out of sight (or in sight, with `shown`). */
const goes = (page, selector, shown = false, timeout = 3000) =>
  page.waitForSelector(selector, { state: shown ? "visible" : "hidden", timeout }).then(() => true, () => false);

async function sendMessage(page, text) {
  await page.fill("#input", text);
  await page.click("#send");
}

async function waitReply(page, timeout = 20000) {
  await page.waitForFunction(() => !document.querySelector("#composer").classList.contains("streaming")
    && document.querySelector(".msg.assistant:last-child .caption, .msg.assistant:last-child .notice"), null, { timeout });
}

const lastReply = (page) => page.locator(".msg.assistant").last();

/** A finger dragged across the screen (real touch events, as on a phone; not a mouse). */
async function swipe(page, from, to, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

// A UTF-8 locale, as people's phones and PCs have: under Linux's plain C locale Chromium saves 週末の予定.csv as "download".
const browser = await chromium.launch({ env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
// STUDIO=dir: no checks; the screens and their motion, as pictures to look at (test/studio.mjs).
if (process.env.STUDIO) {
  let failed = false;
  try {
    const { default: studio } = await import(process.env.STUDIO_SCRIPT ?? "./studio.mjs");
    await studio({ browser, page0, relay, admin: ADMIN, out: process.env.STUDIO, passkeyDevice, sendMessage, waitReply, swipe, sleep, cable });
  } catch (error) {
    failed = true;
    console.error(error?.stack ?? error);
  } finally {
    await browser.close();
    stopRelay();
    web.close();
    anthropic.close();
    cable.cut();
    cableServer.close();
  }
  process.exit(failed ? 1 : 0);
}
try {
  // MARK: Unsigned-in
  const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1" };
  const devContext = await browser.newContext({ ...iphone });
  const dev = await devContext.newPage();
  const devErrors = await watch(dev);
  await passkeyDevice(devContext, dev);
  await dev.goto(page0);
  await dev.waitForSelector("#login:not([hidden])");
  check("the sign-in screen shows first", await dev.isVisible("#login-passkey"));
  await dev.screenshot({ path: join(SHOTS, "check-login.png") });

  const refused = await dev.evaluate(async (relayURL) => {
    const r = await fetch(`${relayURL}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    return r.status;
  }, relay);
  check("Claude can't be reached without signing in", refused === 401, `status ${refused}`);
  const foreign = await fetch(`${relay}/v1/status`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
  check("another site's page is refused before anything is read", foreign.status === 403 && !foreign.headers.get("access-control-allow-origin"));

  // MARK: The developer's first setup
  await dev.click("#show-setup");
  await dev.click(".make-key summary");
  await dev.click("#make-admin-key");
  const made = await dev.textContent("#made-admin-key");
  check("an admin key is made in the page", /^[A-Za-z0-9_-]{43}$/.test(made ?? ""));
  await dev.fill("#setup-admin-key", "wrong-key-wrong-key-wrong-key-wrong-key");
  await dev.fill("#setup-name", "はっちー");
  await dev.click("#setup-register");
  await dev.waitForSelector("#login-error:not([hidden])");
  check("a wrong admin key is refused", (await dev.textContent("#login-error")).includes("管理キーが違います"));
  check("the admin key leaves its field", (await dev.inputValue("#setup-admin-key")) === "");
  await dev.fill("#setup-admin-key", ADMIN);
  await dev.click("#setup-register");
  await dev.waitForSelector("#chat:not([hidden])", { timeout: 15000 });
  check("the developer registers with a passkey and the chat opens", await dev.isVisible("#composer"));
  const storage = await dev.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  check("the web session is in this tab only", /"token":"fws_/.test(storage.session["fielua.session"] ?? "") && !JSON.stringify(storage.local).includes("fws_"));
  check("no key is kept anywhere in the browser", !JSON.stringify(storage).includes(ADMIN) && !JSON.stringify(storage).includes("sk-ant"));
  check("Claude Opus 5.5 at 中 at first", (await dev.textContent("#model-name")) === "Claude Opus 5.5" && (await dev.textContent("#model-sub")).includes("推論 中"));

  // MARK: Markdown, streamed
  await sendMessage(dev, "md");
  await dev.waitForSelector(".msg.assistant .reply table", { timeout: 10000 });
  await dev.evaluate(() => { window.__first = document.querySelector(".msg.assistant .reply").firstElementChild; window.__maxScrollGap = 0; window.__gap = setInterval(() => { const s = document.getElementById("scroller"); window.__maxScrollGap = Math.max(window.__maxScrollGap, s.scrollHeight - s.scrollTop - s.clientHeight); }, 30); });
  await sleep(500);
  await dev.screenshot({ path: join(SHOTS, "check-streaming.png") });
  await waitReply(dev);
  const md = await dev.evaluate(() => {
    const reply = document.querySelector(".msg.assistant .reply");
    clearInterval(window.__gap);
    return {
      firstKept: window.__first === reply.firstElementChild,
      maxGap: window.__maxScrollGap,
      h2: reply.querySelector("h2")?.textContent,
      h3: reply.querySelector("h3")?.textContent,
      strong: Array.from(reply.querySelectorAll("strong")).map((e) => e.textContent),
      em: reply.querySelector("em")?.textContent,
      del: reply.querySelector("del, s")?.textContent,
      ol: reply.querySelectorAll("ol > li").length,
      nested: reply.querySelectorAll("ol li ul li").length,
      quote: reply.querySelector("blockquote")?.textContent.trim(),
      rows: reply.querySelectorAll("table tbody tr").length,
      right: reply.querySelectorAll("td.al-right").length,
      center: reply.querySelectorAll("th.al-center").length,
      codeLang: reply.querySelector(".fl-code-lang")?.textContent,
      keyword: reply.querySelector(".fl-code .tk-keyword")?.textContent,
      comment: reply.querySelector(".fl-code .tk-comment")?.textContent,
      inlineCode: reply.querySelector("p code")?.textContent,
      katex: reply.querySelectorAll(".katex").length,
      display: reply.querySelectorAll(".fl-math.display .katex-display").length,
      priceText: reply.textContent.includes("価格は $5 と $10 です"),
      links: Array.from(reply.querySelectorAll("a")).map((a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel })),
      scripts: document.querySelectorAll(".messages script, .messages img, .messages iframe, .messages [onerror], .messages [onclick], .messages [onload]").length,
      xss: window.__xss,
      literal: reply.textContent.includes("<script>window.__xss = 1</script>"),
      hr: reply.querySelectorAll("hr").length,
      caption: document.querySelector(".msg.assistant .caption span")?.textContent,
      fades: reply.querySelectorAll(".fl-new").length,
      csp: window.__csp,
      overflow: document.scrollingElement.scrollWidth - window.innerWidth,
    };
  });
  check("headings", md.h2 === "東京の週末プラン" && md.h3 === "まとめ");
  check("bold next to Japanese punctuation", md.strong.includes("「重要」") && md.strong.includes("浅草"), md.strong.join(","));
  check("italic and strikethrough", md.em === "上野" && md.del === "銀座");
  check("lists, nested", md.ol === 3 && md.nested === 2);
  check("quote", md.quote === "引用です。混雑に注意してください。");
  check("table with its alignment", md.rows === 3 && md.right === 3 && md.center === 1);
  check("code block, named and coloured", md.codeLang === "Python" && md.keyword === "def" && md.comment?.includes("合計"));
  check("inline code", md.inlineCode === "npm run build");
  check("math: inline and display, by KaTeX", md.katex >= 2 && md.display === 1, `${md.katex} formulas`);
  check("prices stay text", md.priceText);
  check("links open in a new tab, without the opener or a referrer", md.links.length >= 2 && md.links.every((l) => /^https:\/\//.test(l.href ?? "") && l.target === "_blank" && l.rel.includes("noopener") && l.rel.includes("noreferrer")), JSON.stringify(md.links));
  check("no HTML from the reply runs: no script, no image, no handlers, no javascript: link", md.scripts === 0 && md.xss === undefined && md.links.every((l) => !/^javascript/i.test(l.href ?? "")));
  check("raw HTML shows as text", md.literal);
  check("rule", md.hr === 1);
  check("the chunks above the one being written are never redrawn", md.firstKept);
  check("the view followed the reply to its end", md.maxGap < 200, `largest gap ${md.maxGap}px`);
  check("the caption says who answered at which level", md.caption === "Claude Opus 5.5 · 推論 中", md.caption);
  check("no Content Security Policy violation", md.csp.length === 0, md.csp.join(" | "));
  check("nothing runs wider than the iPhone's screen", md.overflow <= 0, `${md.overflow}px`);
  const sent = upstream.requests.at(-1).body;
  check("the relay asked for Opus 5.5 at medium with 32,000 tokens and adaptive thinking", sent.model === "claude-opus-5-5" && sent.output_config?.effort === "medium" && sent.max_tokens === 32000 && sent.thinking?.type === "adaptive");
  // The SDK sends the key as a bearer token.
  check("Anthropic got the relay's own key, which the page never had", upstream.requests.at(-1).headers.authorization === "Bearer sk-ant-e2e-stand-in");
  await dev.screenshot({ path: join(SHOTS, "check-markdown.png"), fullPage: false });

  // MARK: Long code and long tables fold
  await sendMessage(dev, "long");
  await waitReply(dev);
  const long = await dev.evaluate(() => {
    const reply = document.querySelectorAll(".msg.assistant .reply")[1];
    const code = reply.querySelector(".fl-code");
    const table = reply.querySelector(".fl-table");
    return {
      codeCollapsed: code.classList.contains("collapsed"), more: code.querySelector(".fl-more")?.textContent,
      tableCollapsed: table.classList.contains("collapsed"), rows: table.querySelector(".fl-rows")?.textContent,
      hiddenRows: Array.from(table.querySelectorAll("tbody tr")).filter((tr) => getComputedStyle(tr).display === "none").length,
      allRows: table.querySelectorAll("tbody tr").length, hiddenAt: Array.from(table.querySelectorAll("tbody tr")).map((tr, i) => getComputedStyle(tr).display === "none" ? i : -1).filter((i) => i >= 0).join(","), tbodies: table.querySelectorAll("tbody").length, rule: [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((r) => r.selectorText && r.selectorText.includes("tbody tr")).map((r) => r.cssText).join(" ## "),
    };
  });
  check("code over 60 lines shows 40 until opened", long.codeCollapsed && long.more === "残り40行を表示", long.more);
  check("a table over 30 rows shows 20 until opened", long.tableCollapsed && long.rows === "残り20行を表示" && long.hiddenRows === 20, JSON.stringify(long));
  await dev.locator(".fl-more").last().click();
  check("opening long code", (await dev.locator(".fl-more").last().textContent()) === "折りたたむ");

  // MARK: Models and levels
  await dev.click("#model-button");
  await dev.waitForSelector("#model-sheet[open]");
  const sheet = await dev.evaluate(() => ({
    models: Array.from(document.querySelectorAll("#model-list .choice")).map((b) => ({ name: b.querySelector(".title").textContent, disabled: b.disabled, checked: b.getAttribute("aria-checked") })),
    efforts: Array.from(document.querySelectorAll("#effort-list .choice")).map((b) => ({ title: b.querySelector(".title").textContent, sub: b.querySelector(".sub")?.textContent ?? "", disabled: b.disabled, checked: b.getAttribute("aria-checked") })),
    subs: Array.from(document.querySelectorAll("#model-list .choice .sub")).map((sub) => sub.textContent),
    text: document.getElementById("model-sheet").textContent,
  }));
  check("models in Fielua's order, Opus 5.5 first", sheet.models.map((m) => m.name).join(",") === "Claude Opus 5.5,Claude Fable 5.2,Claude Sonnet 5.5,Claude Haiku 5.5", sheet.models.map((m) => m.name).join(","));
  check("a model Anthropic doesn't offer can't be chosen", sheet.models[3].disabled && !sheet.models[0].disabled);
  check("中 is chosen and marked 標準; 超高 is just 超高", sheet.efforts[1].checked === "true" && sheet.efforts[1].title.includes("標準") &&
    sheet.efforts[3].title === "超高", JSON.stringify(sheet.efforts));
  check("no Fielua rank on Claude's models, and no explanations: levels are their names alone",
    !sheet.text.includes("最上級") && !sheet.text.includes("Fielua") && sheet.efforts.every((e) => e.sub === "") && sheet.subs[0] === "推論レベル 中", JSON.stringify({ subs: sheet.subs, efforts: sheet.efforts }));
  check("no max level", sheet.efforts.length === 4 && !sheet.efforts.some((e) => /max|最大/.test(e.title)));
  await sleep(450);
  await dev.screenshot({ path: join(SHOTS, "check-model-sheet.png") });
  await dev.locator("#model-list .choice").nth(1).click();
  const fable = await dev.evaluate(() => Array.from(document.querySelectorAll("#effort-list .choice")).map((b) => b.disabled));
  check("a level the model doesn't take can't be chosen (Fable 5.2 at 超高)", fable[3] === true && fable[0] === false);
  // With a keyboard: Down walks to the next model and chooses it, the keyboard stays on the row, and the list is one Tab stop.
  await dev.locator("#model-list .choice").nth(1).focus();
  await dev.keyboard.press("ArrowDown");
  const walked = await dev.evaluate(() => {
    const rows = [...document.querySelectorAll("#model-list .choice")];
    return { at: rows.indexOf(document.activeElement), checked: rows.findIndex((row) => row.getAttribute("aria-checked") === "true"), stops: rows.filter((row) => row.tabIndex === 0).length };
  });
  check("the arrow keys walk the models and choose; the keyboard stays on the row", walked.at === 2 && walked.checked === 2 && walked.stops === 1, JSON.stringify(walked));
  await dev.locator("#effort-list .choice").nth(0).click();
  // A press that began in the sheet (selecting text) and ended on the dimmed page doesn't close it; a tap on the dimmed page does.
  const sheetBox = await dev.locator("#model-sheet").boundingBox();
  await dev.mouse.move(sheetBox.x + 60, sheetBox.y + 40);
  await dev.mouse.down();
  await dev.mouse.move(sheetBox.x + 60, sheetBox.y - 30, { steps: 4 });
  await dev.mouse.up();
  await sleep(450);
  check("a drag that ends outside a sheet doesn't close it", await dev.evaluate(() => document.getElementById("model-sheet").open));
  await dev.click("#model-sheet [data-close]");
  await settled(dev);
  check("the top bar follows the choice", (await dev.textContent("#model-name")) === "Claude Sonnet 5.5" && (await dev.textContent("#model-sub")).includes("低"));

  // MARK: The credit left
  await dev.click("#settings-button");
  await dev.waitForSelector("#settings-sheet[open] .person", { timeout: 10000 });
  await sleep(450);
  await dev.screenshot({ path: join(SHOTS, "check-settings.png") });
  await dev.getByRole("button", { name: "残高を入力・変更" }).click();
  await dev.waitForSelector("#credit-sheet[open]");
  await dev.fill("#credit-sheet input[inputmode=decimal]", "10");
  await dev.getByRole("button", { name: "保存" }).click();
  await dev.waitForSelector("#credit:not([hidden])");
  check("the ring shows once the balance is entered", (await dev.textContent("#credit-text")) === "100");
  await dev.click("#credit-sheet [data-close]");
  await settled(dev);

  await sendMessage(dev, "echo");
  await waitReply(dev);
  const echo = await lastReply(dev).locator(".reply").textContent();
  check("the next question goes with Sonnet 5.5 at 低 (16,000 tokens)", echo.includes("model=claude-sonnet-5-5") && echo.includes("effort=low") && echo.includes("max=16000"), echo);
  check("the conversation so far goes with it", /turns=5/.test(echo), echo);
  await dev.waitForFunction(() => Number(document.getElementById("credit-text").textContent) < 100, null, { timeout: 8000 });
  check("the ring empties as replies are paid for", Number(await dev.textContent("#credit-text")) < 100, await dev.textContent("#credit-text"));

  // MARK: Stop
  await sendMessage(dev, "slow");
  await dev.waitForFunction(() => (document.querySelector(".msg.assistant:last-child .reply")?.textContent.length ?? 0) > 20, null, { timeout: 10000 });
  const before = upstream.closedEarly;
  check("the send button becomes stop while Claude writes", (await dev.getAttribute("#send", "aria-label")) === "停止");
  await dev.click("#send");
  await waitReply(dev);
  await sleep(800);
  check("stop ends the request at Anthropic too", upstream.closedEarly === before + 1, `${upstream.closedEarly - before}`);
  check("what had come stays, marked stopped", (await lastReply(dev).locator(".caption").textContent()).includes("停止しました"));
  check("the composer is ready again", (await dev.getAttribute("#send", "aria-label")) === "送信");

  // MARK: Thinking, and a reply broken by Anthropic
  await sendMessage(dev, "think");
  await dev.waitForSelector(".msg.assistant:last-child .thinking .label:not(:empty)", { timeout: 5000 });
  check("「考えています」 shows while Claude thinks", (await dev.textContent(".msg.assistant:last-child .thinking .label")) === "考えています");
  await waitReply(dev);
  check("the thinking itself is never shown", (await lastReply(dev).locator(".reply").textContent()) === "考えた結果、答えは 42 です。");
  await sendMessage(dev, "overload");
  await waitReply(dev);
  check("a reply broken off says so and keeps what came", (await lastReply(dev).locator(".notice").textContent()).includes("混み合っている"));

  // MARK: Safari in the background: the connection drops while Claude thinks, and the reply goes on
  const replyIDs = [];
  dev.on("response", (response) => { const id = response.headers()["x-fielua-reply"]; if (id && !replyIDs.includes(id)) replyIDs.push(id); });
  const asked = (question) => upstream.asked.filter((q) => q === question).length;
  const keptAtRelay = (id) => dev.evaluate(async ([relayURL, replyID]) => {
    const token = JSON.parse(sessionStorage.getItem("fielua.session")).token;
    return (await fetch(`${relayURL}/v1/replies/${replyID}`, { headers: { Authorization: `Bearer ${token}` } })).status;
  }, [relay, id]);
  const replyDone = (page) => page.waitForFunction((text) => document.querySelector(".msg.assistant:last-child .reply")?.textContent === text
    && !document.querySelector("#composer").classList.contains("streaming"), DEEP, { timeout: 30000 });
  await dev.evaluate(() => {
    window.__work = [];
    new MutationObserver(() => {
      const text = document.querySelector(".msg.assistant:last-child .work")?.textContent ?? "";
      if (text && window.__work.at(-1) !== text) window.__work.push(text);
    }).observe(document.getElementById("messages"), { subtree: true, childList: true, characterData: true });
  });
  const closedBeforeDeep = upstream.closedEarly;
  await sendMessage(dev, "deep");
  await dev.waitForSelector(".msg.assistant:last-child .thinking .label:not(:empty)", { timeout: 5000 });
  cable.refuse = true;
  cable.cut();
  await sleep(1500);
  check("cut off while Claude thinks: the page says it is reconnecting", (await dev.evaluate(() => window.__work)).includes("つなぎ直しています…"), JSON.stringify(await dev.evaluate(() => window.__work)));
  cable.refuse = false;
  await replyDone(dev);
  const deepCaption = await lastReply(dev).locator(".caption").textContent();
  check("once the connection is back, the reply comes whole", (await lastReply(dev).locator(".reply").textContent()) === DEEP);
  check("Claude thought once: asked once at Anthropic, never stopped there", asked("deep") === 1 && upstream.closedEarly === closedBeforeDeep, `${asked("deep")} ${upstream.closedEarly - closedBeforeDeep}`);
  check("no error, and not marked stopped", (await lastReply(dev).locator(".notice").count()) === 0 && !deepCaption.includes("停止しました"), deepCaption);
  await sleep(300);
  check("the page has it: the relay lets go of it", replyIDs.length === 1 && (await keptAtRelay(replyIDs[0])) === 404);

  // Back after a while away (the old connection may have died without a word): a new one, nothing lost.
  await sendMessage(dev, "deep");
  await dev.waitForSelector(".msg.assistant:last-child .thinking .label:not(:empty)", { timeout: 5000 });
  const getsBefore = cable.replyGets;
  await dev.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(3300);
  await dev.evaluate(() => {
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await replyDone(dev);
  check("back from the background: a new connection, and the reply whole", cable.replyGets === getsBefore + 1 && (await lastReply(dev).locator(".reply").textContent()) === DEEP, `${cable.replyGets - getsBefore}`);
  check("still thought once", asked("deep") === 2 && upstream.closedEarly === closedBeforeDeep);

  // Safari reloaded the page while Claude was thinking: the reply is picked up again, into the same place.
  await sendMessage(dev, "deep");
  await dev.waitForSelector(".msg.assistant:last-child .thinking .label:not(:empty)", { timeout: 5000 });
  const repliesBeforeReload = await dev.locator(".msg.assistant").count();
  await sleep(500);
  await dev.reload();
  await replyDone(dev);
  const reloadedCaption = await lastReply(dev).locator(".caption").textContent();
  check("reloaded while thinking: the reply goes on and comes whole", (await lastReply(dev).locator(".reply").textContent()) === DEEP && !reloadedCaption.includes("停止しました") &&
    (await dev.locator(".msg.assistant").count()) === repliesBeforeReload, reloadedCaption);
  check("asked once, never stopped at Anthropic", asked("deep") === 3 && upstream.closedEarly === closedBeforeDeep);
  await sleep(300);
  check("and the relay lets go of it once the page has it", replyIDs.length === 3 && (await keptAtRelay(replyIDs[2])) === 404);
  const keptCopy = await dev.evaluate(() => JSON.parse(sessionStorage.getItem("fielua.chat")).messages.at(-1));
  check("kept as a finished reply (no id left behind)", keptCopy.end === "done" && keptCopy.text === DEEP && !("reply" in keptCopy), JSON.stringify(keptCopy).slice(0, 200));

  // Safari went to the background before Anthropic had answered at all: the question isn't asked twice.
  const askedKeys = [];
  dev.on("request", (request) => {
    const key = /\/v1\/replies\/([0-9a-f]{32})$/.exec(request.url())?.[1];
    if (key && request.method() === "POST") askedKeys.push(key);
  });
  await sendMessage(dev, "late");
  await sleep(400);
  cable.refuse = true;
  cable.cut();
  await sleep(1000);
  cable.refuse = false;
  await replyDone(dev);
  const lateCaption = await lastReply(dev).locator(".caption").textContent();
  check("cut off before Anthropic answered: the reply still comes whole", (await lastReply(dev).locator(".reply").textContent()) === DEEP &&
    (await lastReply(dev).locator(".notice").count()) === 0 && !lateCaption.includes("停止しました"), lateCaption);
  check("and the question was asked once, never stopped", asked("late") === 1 && upstream.closedEarly === closedBeforeDeep, `${asked("late")} ${upstream.closedEarly - closedBeforeDeep}`);

  // Stopped before Anthropic answered: nothing is left at the relay, and Anthropic stops (or is never asked).
  await sendMessage(dev, "late");
  await sleep(300);
  await dev.click("#send");
  await dev.waitForFunction(() => !document.querySelector("#composer").classList.contains("streaming"), null, { timeout: 5000 });
  await sleep(2500);
  const stoppedKey = askedKeys.at(-1);
  const lateAsked = asked("late") - 1;
  check("stopped before the answer: nothing goes on at Anthropic", (lateAsked === 0 || upstream.closedEarly === closedBeforeDeep + 1) && upstream.closedEarly <= closedBeforeDeep + 1, `${lateAsked} ${upstream.closedEarly - closedBeforeDeep}`);
  check("and nothing is kept at the relay", askedKeys.length === 2 && (await keptAtRelay(stoppedKey)) === 404);
  check("the composer is ready again", (await dev.getAttribute("#send", "aria-label")) === "送信");
  // The question stopped before any answer goes again with the next one (as the app does): one more, so the photos below go alone.
  await sendMessage(dev, "続けて");
  await waitReply(dev);

  // MARK: Photos, a video and files, as the iPhone app attaches them
  // A large photo with its location in it (an Exif block), made in the browser.
  const madeJPEG = await dev.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2000;
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 3000, 2000);
    gradient.addColorStop(0, "#f6c945");
    gradient.addColorStop(1, "#3a7bd5");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 3000, 2000);
    context.fillStyle = "#000";
    context.font = "200px sans-serif";
    context.fillText("Fielua", 400, 1000);
    return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  });
  const plain = Buffer.from(madeJPEG, "base64");
  const tiff = Buffer.from("Exif\0\0II*\0\x08\0\0\0\0\0GPSLatitude 35.6812 N GPSLongitude 139.7671 E", "binary");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (tiff.length + 2) >> 8, (tiff.length + 2) & 0xff]), tiff]);
  const located = Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]);
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
  // 「こんにちは、Fielua」 in Shift_JIS, as Windows' Notepad saves Japanese text.
  const sjis = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x81, 0x41, 0x46, 0x69, 0x65, 0x6c, 0x75, 0x61]);

  await dev.click("#attach");
  const menu = await dev.evaluate(() => Array.from(document.querySelectorAll("#attach-menu [data-pick]")).map((b) => b.textContent.trim()));
  check("the plus opens 写真, ファイル and 動画, in the app's order", menu.join(",") === "写真,ファイル,動画", menu.join(","));
  await sleep(400);
  check("the menu opens above the plus", await dev.isVisible("#attach-menu [data-pick=photos]"));
  await dev.screenshot({ path: join(SHOTS, "check-attach-menu.png") });
  await dev.keyboard.press("Escape");
  check("the menu closes", await goes(dev, "#attach-menu"));

  await dev.setInputFiles("#pick-photos", [
    { name: "東京駅.jpg", mimeType: "image/jpeg", buffer: located },
    { name: "flower.png", mimeType: "image/png", buffer: readFileSync(join(root, "src/assets/flower.png")) },
  ]);
  await dev.waitForFunction(() => document.querySelectorAll("#tray .tray-item.picture").length === 2, null, { timeout: 10000 });
  check("picked photos wait above the bar, each with its ×", await dev.locator("#tray .tray-remove").count() === 2);
  check("a photo alone can be sent", !(await dev.isDisabled("#send")));
  await dev.locator("#tray .tray-remove").nth(1).click();
  check("× takes one off", await becomes(dev, "#tray .tray-item", 1));
  await dev.setInputFiles("#pick-files", [
    { name: "教材.pdf", mimeType: "application/pdf", buffer: pdfBytes },
    { name: "メモ.txt", mimeType: "text/plain", buffer: sjis },
  ]);
  await dev.waitForFunction(() => document.querySelectorAll("#tray .tray-item.file").length === 2, null, { timeout: 10000 });
  await dev.setInputFiles("#pick-videos", [{ name: "海.webm", mimeType: "video/webm", buffer: readFileSync(join(root, "test/fixtures/clip.webm")) }]);
  await dev.waitForFunction(() => document.querySelectorAll("#tray .tray-item.picture").length === 2, null, { timeout: 20000 });
  check("a video waits as its first scene, marked to play", await dev.locator("#tray .tray-item .play").count() === 1,
    await dev.evaluate(() => [...document.querySelectorAll("#tray .tray-item")].map((item) => `${item.className}:${item.title}`).join(" | ")));
  await dev.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["dropped words"], "落とした.md", { type: "text/markdown" }));
    document.getElementById("chat").dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await dev.waitForFunction(() => document.querySelectorAll("#tray .tray-item").length === 5, null, { timeout: 5000 });
  check("a file dropped on the chat is attached too", true);
  await dev.setInputFiles("#pick-files", [{ name: "報告.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK\x03\x04", "binary") }]);
  await dev.waitForSelector("#toast:not([hidden])");
  check("a Word file is refused with what to do", (await dev.textContent("#toast")).includes("PDF に書き出して"), await dev.textContent("#toast"));
  const bigPDF = Buffer.concat([pdfBytes, Buffer.alloc(2_400_000, 0x20)]);
  await dev.setInputFiles("#pick-files", [{ name: "厚い教材.pdf", mimeType: "application/pdf", buffer: bigPDF }]);
  await dev.waitForFunction(() => document.getElementById("toast").textContent.includes("厚い教材"), null, { timeout: 5000 });
  check("a PDF over what one request carries is refused before sending", (await dev.textContent("#toast")).includes("2.2 MB まで"), await dev.textContent("#toast"));
  check("still five waiting", await dev.locator("#tray .tray-item").count() === 5);
  await dev.evaluate(() => { document.getElementById("toast").hidden = true; });
  await dev.screenshot({ path: join(SHOTS, "check-attach-tray.png") });

  await sendMessage(dev, "添付");
  await waitReply(dev);
  const withFiles = upstream.requests.at(-1).body;
  const sentBlocks = withFiles.messages.at(-1).content;
  const images = sentBlocks.filter((b) => b.type === "image");
  const photoBytes = Buffer.from(images[0].source.data, "base64");
  // The JPEG's frame header (SOF0) holds its height and width.
  const sof = photoBytes.indexOf(Buffer.from([0xff, 0xc0]));
  const dims = sof > 0 ? { height: photoBytes.readUInt16BE(sof + 5), width: photoBytes.readUInt16BE(sof + 7) } : {};
  check("the photo goes smaller: 1568 on its long edge", dims.width === 1568 && dims.height === 1045, JSON.stringify(dims));
  check("and without its location (no Exif)", !photoBytes.includes(Buffer.from("Exif")) && !photoBytes.includes(Buffer.from("GPS")));
  const captions = sentBlocks.filter((b) => b.type === "text").map((b) => b.text);
  check("the video goes as 4 scenes, each with its time, said to be without sound", images.length === 5 && captions.filter((c) => c.includes("海.webm")).length === 4 &&
    captions[0].includes("音声なし") && captions[0].includes("4 場面") && captions.some((c) => c.includes("0:11 の場面")), captions.join(" | "));
  const docs = sentBlocks.filter((b) => b.type === "document");
  check("the PDF goes as itself, with its name", docs[0]?.source.media_type === "application/pdf" && docs[0].title === "教材.pdf" && Buffer.from(docs[0].source.data, "base64").equals(pdfBytes));
  check("a Shift_JIS text file is read as Japanese", docs[1]?.source.media_type === "text/plain" && docs[1].source.data === "こんにちは、Fielua" && docs[1].title === "メモ.txt", docs[1]?.source.data);
  check("the dropped file too, and the question last", docs[2]?.title === "落とした.md" && sentBlocks.at(-1).text === "添付");
  check("the tray empties once sent", await dev.isHidden("#tray"));
  const bubble = await dev.evaluate(() => {
    const message = [...document.querySelectorAll(".msg.user")].at(-1);
    return {
      pictures: message.querySelectorAll(".sent-picture").length,
      play: message.querySelectorAll(".sent-picture .play").length,
      duration: message.querySelector(".sent-picture .duration")?.textContent,
      note: message.querySelector(".sent-note")?.textContent,
      files: [...message.querySelectorAll(".bubble .file-name")].map((e) => e.textContent),
      text: message.querySelector(".bubble-text")?.textContent,
      firstInBubble: !!message.querySelector(".bubble .sent-picture"),
    };
  });
  check("sent photos and the video stand on their own above the bubble", bubble.pictures === 2 && !bubble.firstInBubble && bubble.play === 1 && bubble.duration === "0:12", JSON.stringify(bubble));
  check("with how the video was sent", bubble.note === "音声なし・4 場面", bubble.note);
  check("files sit in the bubble with the text", bubble.files.join(",") === "教材.pdf,メモ.txt,落とした.md" && bubble.text === "添付", JSON.stringify(bubble));
  await dev.locator(".msg.user .sent-picture").first().click();
  await dev.waitForSelector("#viewer[open] img");
  check("a sent photo opens larger", (await dev.getAttribute("#viewer-body img", "src")).startsWith("data:image/jpeg;base64,"));
  await dev.click("#viewer [data-close]");
  await settled(dev);
  await dev.locator(".msg.user .sent-picture").nth(0).scrollIntoViewIfNeeded();
  await dev.screenshot({ path: join(SHOTS, "check-attach-sent.png") });

  await sendMessage(dev, "続き");
  await waitReply(dev);
  const follow = upstream.requests.at(-1).body.messages;
  check("the next question carries them again (the conversation so far)", follow.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image")));
  await dev.reload();
  await dev.waitForSelector("#chat:not([hidden])");
  check("after reloading, the photos still show (pictures only)", await dev.locator(".msg.user .sent-picture img").count() === 2);
  await sendMessage(dev, "もう一度");
  await waitReply(dev);
  const reloaded = upstream.requests.at(-1).body.messages;
  const named = reloaded.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  check("then, Claude is told they were attached but are not sent again", named.includes("「東京駅.jpg」") && named.includes("今回は送っていません") && !reloaded.some((m) => Array.isArray(m.content)), named.slice(-200));
  check("nothing of the attachments' data is kept in the tab", !(await dev.evaluate(() => sessionStorage.getItem("fielua.chat"))).includes(images[0].source.data.slice(2000, 2060)));

  // MARK: Web search and files a reply made
  MADE.file_e2e_chart.bytes = Buffer.from(await dev.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    context.fillStyle = "#FFFDF9";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#E8A012";
    context.fillRect(140, 150, 120, 170);
    context.fillRect(380, 60, 120, 260);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  const chatBeforeTools = await dev.evaluate(() => sessionStorage.getItem("fielua.chat"));
  const spent = () => dev.evaluate(async (relayURL) => {
    const token = JSON.parse(sessionStorage.getItem("fielua.session")).token;
    return (await (await fetch(`${relayURL}/v1/status`, { headers: { Authorization: `Bearer ${token}` } })).json()).credit?.spentUSD ?? null;
  }, relay);
  // MARK: 会話一覧 (this device only, encrypted)
  const shownBefore = await dev.locator(".msg").count();
  const firstReplyText = (await dev.locator(".msg.assistant .reply").first().textContent()).replace(/\s+/g, "").slice(0, 14);
  await dev.click("#history-button");
  await dev.waitForSelector("#chat.history-shown .history-row");
  await sleep(600);
  const drawerShape = await dev.evaluate(() => ({
    rows: [...document.querySelectorAll(".history-row")].map((row) => ({ title: row.textContent, current: row.getAttribute("aria-current") })),
    panelX: Math.round(document.getElementById("chat-panel").getBoundingClientRect().left),
    width: innerWidth,
    inert: document.getElementById("chat-panel").inert,
    focused: document.activeElement?.getAttribute("aria-current"),
    active: `${document.activeElement?.tagName}#${document.activeElement?.id}.${document.activeElement?.className}`,
  }));
  check("会話一覧 opens with the conversation, named by its first question, the open one marked and focused",
    drawerShape.rows.length === 1 && drawerShape.rows[0].title === "md" && drawerShape.rows[0].current === "true" && drawerShape.focused === "true", JSON.stringify(drawerShape));
  check("the chat slides aside, 92 px of it left in sight, and can't be used meanwhile", drawerShape.width - drawerShape.panelX === 92 && drawerShape.inert, String(drawerShape.panelX));
  await dev.screenshot({ path: join(SHOTS, "check-history.png") });
  const kept = await dev.evaluate(async ([relayURL, probes]) => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith("fielua-history-"));
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(names[0]); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const all = await new Promise((resolve) => {
      const tx = db.transaction(["meta", "chats"]);
      const out = {};
      tx.objectStore("chats").getAll().onsuccess = (e) => { out.chats = e.target.result; };
      tx.objectStore("meta").getAll().onsuccess = (e) => { out.meta = e.target.result; };
      tx.oncomplete = () => resolve(out);
    });
    db.close();
    const text = (records) => records.map((r) => new TextDecoder().decode(r.data)).join("");
    const token = JSON.parse(sessionStorage.getItem("fielua.session")).token;
    const response = await fetch(`${relayURL}/v1/history-key`, { headers: { Authorization: `Bearer ${token}` } });
    const { key } = await response.json();
    const plain = text(all.chats) + text(all.meta);
    const storages = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    const records = [...all.chats, ...all.meta];
    const shaped = records.every((r) => r.iv instanceof Uint8Array && r.iv.length === 12 && r.data instanceof Uint8Array && r.data.length >= 16);
    // And it opens with this person's key from the relay (AES-GCM, bound to its store and id).
    const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const record = all.chats[0];
    const opened = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv, additionalData: new TextEncoder().encode(`fielua-history-v1:chats:${record.id}`) }, aes, record.data));
    return {
      names, chats: all.chats.length, meta: all.meta.length, shaped, readable: probes.filter((probe) => plain.includes(probe)),
      opens: probes.filter((probe) => !probe.startsWith('"')).every((probe) => opened.includes(probe)), keyFound: storages.includes(key) || plain.includes(key), keyLength: key.length, cache: response.headers.get("cache-control"),
    };
  }, [relay, ["東京駅.jpg", "教材.pdf", "もう一度", "東京の週末プラン", "\"title\"", "\"messages\""]]);
  check("the history stays in this browser, encrypted: no question, reply, file name or key readable in its storage",
    kept.names.length === 1 && kept.chats === 1 && kept.meta === 1 && kept.shaped && kept.readable.length === 0 && kept.opens && !kept.keyFound && kept.keyLength === 43,
    JSON.stringify(kept));
  await dev.click("#history-new");
  await sleep(600);
  check("チャット starts a new chat, the list goes, and the one before stays in it",
    (await dev.locator(".msg").count()) === 0 && !(await dev.evaluate(() => document.getElementById("chat").classList.contains("history-shown"))) && (await dev.evaluate(() => sessionStorage.getItem("fielua.chat"))) !== chatBeforeTools);
  // A finger, not a click: a sideways swipe opens the list, and one back from the strip closes it.
  const panelAt = () => dev.evaluate(() => ({ shown: document.getElementById("chat").classList.contains("history-shown"), x: Math.round(document.getElementById("chat-panel").getBoundingClientRect().left), inert: document.getElementById("chat-panel").inert }));
  await swipe(dev, { x: 30, y: 420 }, { x: 330, y: 430 });
  await sleep(600);
  const swipedOpen = await panelAt();
  await swipe(dev, { x: 370, y: 420 }, { x: 60, y: 430 });
  await sleep(600);
  const swipedShut = await panelAt();
  check("a sideways swipe opens the list, and a swipe back on the strip closes it (touch)",
    swipedOpen.shown && swipedOpen.x === 298 && swipedOpen.inert && !swipedShut.shown && swipedShut.x === 0 && !swipedShut.inert, JSON.stringify({ swipedOpen, swipedShut }));
  await dev.click("#attach");
  await dev.waitForSelector("#attach-menu:not([hidden])");
  const toolRows = await dev.evaluate(() => [...document.querySelectorAll("#attach-menu [data-tool]")].map((row) => `${row.dataset.tool}:${row.hidden ? "hidden" : "shown"}:${row.getAttribute("aria-checked")}`));
  check("the plus menu has ウェブ検索 and ファイル作成, both off", toolRows.join(",") === "webSearch:shown:false,files:shown:false", toolRows.join(","));
  await dev.click("#attach-menu [data-tool=webSearch]");
  check("turned on, the menu closes and the 検索 pill shows by the plus", await goes(dev, "#attach-menu") && (await dev.locator("#tool-pills .tool-pill").allTextContents()).join() === "検索");
  await dev.screenshot({ path: join(SHOTS, "check-tools-pill.png") });
  const spentBeforeSearch = await spent();
  const requestsBefore = upstream.requests.length;
  await sendMessage(dev, "検索");
  await dev.waitForFunction(() => document.querySelector(".msg.assistant:last-child .work.busy")?.textContent.includes("「東京 週末の天気」をウェブで検索しています"), null, { timeout: 8000 });
  check("while it searches, the line above says what", true);
  check("the pill can't be turned off meanwhile", await dev.isDisabled("#tool-pills .tool-pill"));
  await waitReply(dev);
  const searched = upstream.requests[requestsBefore].body;
  check("the question goes with web search (and fetch), at most 5 each, nothing for files",
    searched.tools?.map((t) => `${t.type}/${t.max_uses}`).join() === "web_search_20260209/5,web_fetch_20260209/5" && !searched.container, JSON.stringify(searched.tools));
  check("Claude is told it may search", JSON.stringify(searched.system).includes("search the web"));
  const searchView = await dev.evaluate(() => {
    const reply = document.querySelector(".msg.assistant:last-child");
    return {
      work: reply.querySelector(".work")?.textContent, busy: reply.querySelector(".work")?.classList.contains("busy"),
      text: reply.querySelector(".reply")?.textContent,
      sources: [...reply.querySelectorAll(".source")].map((a) => `${a.querySelector(".source-name").textContent}|${a.querySelector(".source-site").textContent}|${a.target}|${a.rel}`),
      hrefs: [...reply.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    };
  });
  check("after: 「…」をウェブで検索しました above the reply", searchView.work === "「東京 週末の天気」をウェブで検索しました" && !searchView.busy, searchView.work);
  check("the text after the search starts a paragraph of its own", searchView.text.startsWith("調べます。") && searchView.text.includes("週末の東京は晴れです。"), searchView.text);
  check("情報源 lists the page it cited, opening in a new tab", searchView.sources.join() === "東京の週末の天気|weather.example.jp|_blank|noopener noreferrer", searchView.sources.join(" / "));
  check("no javascript: address is ever a link", !searchView.hrefs.some((href) => /^javascript:/i.test(href ?? "")));
  let spentOnSearch = 0;
  for (let i = 0; i < 20 && spentOnSearch < 0.01; i++) { await sleep(300); spentOnSearch = (await spent()) - spentBeforeSearch; }
  check("the search's $0.01 is counted in the credit estimate", spentOnSearch >= 0.01 && spentOnSearch < 0.05, `$${spentOnSearch.toFixed(4)}`);
  await dev.screenshot({ path: join(SHOTS, "check-tools-search.png") });

  await sendMessage(dev, "調べもの");
  await waitReply(dev);
  check("a reply paused mid-research says how to go on", (await lastReply(dev).locator(".notice").textContent()).includes("「続けて」と送る"));

  await dev.click("#tool-pills .tool-pill");
  check("the pill turns search off", await becomes(dev, "#tool-pills .tool-pill", 0));
  await dev.click("#attach");
  await dev.click("#attach-menu [data-tool=files]");
  check("ファイル作成 on: its pill shows", (await dev.locator("#tool-pills .tool-pill").allTextContents()).join() === "ファイル");
  const filesBefore = upstream.requests.length;
  await sendMessage(dev, "ファイル");
  await dev.waitForFunction(() => /ファイルを書いています|コードを実行しています/.test(document.querySelector(".msg.assistant:last-child .work.busy")?.textContent ?? ""), null, { timeout: 8000 });
  check("while code runs, the line above says so", true);
  await waitReply(dev);
  const making = upstream.requests[filesBefore].body;
  check("the question goes with code execution and the PDF, Word, Excel and PowerPoint skills",
    making.tools?.map((t) => t.type).join() === "code_execution_20260521" && making.container?.skills?.map((x) => x.skill_id).join() === "pdf,docx,xlsx,pptx" && !making.container.id, JSON.stringify(making.container));
  check("Claude is told where to save files", JSON.stringify(making.system).includes("$OUTPUT_DIR"));
  await dev.waitForFunction(() => document.querySelectorAll(".msg.assistant:last-child .made-file .file-name").length === 2
    && ![...document.querySelectorAll(".msg.assistant:last-child .made-file .file-meta")].some((e) => e.textContent.includes("読み込んでいます")), null, { timeout: 10000 });
  const madeView = await dev.evaluate(() => [...document.querySelectorAll(".msg.assistant:last-child .made-file")].map((card) =>
    `${card.querySelector(".file-name").textContent}|${card.querySelector(".file-meta").textContent}|${card.querySelector(".made-picture") ? "picture" : "-"}`));
  check("the files it made show under the reply, with names, kinds and sizes", madeView[0]?.startsWith("週末の予定.csv|CSV · ") && madeView[1]?.startsWith("費用のグラフ.png|画像 · "), madeView.join(" / "));
  check("the folder part of a name is dropped", !madeView.join().includes("/mnt/"));
  await dev.waitForSelector(".msg.assistant:last-child .made-picture:not([hidden])", { timeout: 8000 });
  check("a picture it made shows itself", (await dev.getAttribute(".msg.assistant:last-child .made-picture", "src")).startsWith("blob:"));
  const [download] = await Promise.all([dev.waitForEvent("download"), dev.locator(".msg.assistant:last-child .made-file .download").first().click()]);
  const downloaded = readFileSync(await download.path(), "utf8");
  check("保存 downloads the file as it was made", download.suggestedFilename() === "週末の予定.csv" && downloaded === MADE.file_e2e_report.bytes.toString("utf8"), download.suggestedFilename());
  const fileCalls = upstream.files.filter((f) => f.id === "file_e2e_report");
  check("the relay fetches it from Anthropic with the key (never the page)", fileCalls.length >= 2 && fileCalls.every((f) => f.headers.authorization === "Bearer sk-ant-e2e-stand-in"));
  const devToken = await dev.evaluate(() => JSON.parse(sessionStorage.getItem("fielua.session")).token);
  const directResponse = await fetch(`${relay}/v1/files/file_e2e_report/content`, { headers: { Authorization: `Bearer ${devToken}`, Origin: `http://localhost:${webPort}` } });
  const direct = { type: directResponse.headers.get("content-type"), disposition: directResponse.headers.get("content-disposition"), csp: directResponse.headers.get("content-security-policy") };
  check("from the relay, a file is always a download of plain bytes", direct.type === "application/octet-stream" && direct.disposition?.startsWith("attachment;") && direct.disposition.includes("filename*=UTF-8''") && direct.csp?.includes("sandbox"), JSON.stringify(direct));
  await dev.screenshot({ path: join(SHOTS, "check-tools-files.png") });

  await sendMessage(dev, "ファイル");
  await waitReply(dev);
  check("the next question goes on in the same container", upstream.requests.at(-1).body.container?.id === "container_e2e01");
  await dev.reload();
  await dev.waitForSelector("#chat:not([hidden])");
  const afterReload = await dev.evaluate(() => ({
    sources: document.querySelectorAll(".source").length, files: document.querySelectorAll(".made-file").length,
    pill: [...document.querySelectorAll("#tool-pills .tool-pill")].map((e) => e.textContent).join(),
    work: [...document.querySelectorAll(".work:not([hidden])")].map((e) => e.textContent),
  }));
  const chatWithTools = await dev.evaluate(() => sessionStorage.getItem("fielua.chat"));
  check("after reloading, 情報源, the files and the switch are still there", afterReload.sources === 3 && afterReload.files === 4 && afterReload.pill === "ファイル", JSON.stringify(afterReload));
  await dev.click("#tool-pills .tool-pill");
  check("all off: the next question goes without tools", await becomes(dev, "#tool-pills .tool-pill", 0));

  // The list after a reload: both conversations, the latest question first; searching their text; opening and deleting.
  await dev.click("#history-button");
  await dev.waitForSelector("#chat.history-shown .history-row >> nth=1");
  const titles = await dev.locator(".history-row").allTextContents();
  check("both conversations are listed, the one asked last first", titles.length === 2 && titles[0] === "検索" && titles[1] === "md", titles.join(" | "));
  await dev.click("#history-search-button");
  await dev.fill("#history-query", firstReplyText.slice(2, 8));
  await dev.waitForFunction(() => document.querySelectorAll(".history-row").length === 1, null, { timeout: 5000 });
  check("searching finds a conversation by what a reply said", (await dev.locator(".history-row").textContent()) === "md");
  await dev.fill("#history-query", "存在しない言葉ですよ");
  await dev.waitForSelector("#history-empty:not([hidden])");
  check("nothing found: 見つかりませんでした", (await dev.textContent("#history-empty")) === "見つかりませんでした");
  await dev.click("#history-search-button");
  await dev.waitForFunction(() => document.querySelectorAll(".history-row").length === 2, null, { timeout: 5000 });
  await dev.click(".history-row >> text=md");
  await dev.waitForFunction((n) => document.querySelectorAll(".msg").length === n, shownBefore, { timeout: 5000 });
  await sleep(600);
  check("opening it from the list brings the conversation back as it was", !(await dev.evaluate(() => document.getElementById("chat").classList.contains("history-shown"))));
  await dev.click("#history-button");
  await dev.waitForSelector("#chat.history-shown .history-row[aria-current=true]");
  await dev.click(".history-row[aria-current=true]", { button: "right" });
  await dev.waitForSelector("#history-menu:not([hidden])");
  await dev.click("#history-delete");
  await dev.waitForSelector("#confirm[open]");
  check("deleting asks first, naming the conversation", (await dev.textContent("#confirm-title")) === "この会話を削除しますか？" && (await dev.textContent("#confirm-body")).includes("md"));
  await dev.click("#confirm-ok");
  await settled(dev);
  await dev.waitForFunction(() => document.querySelectorAll(".history-row").length === 1, null, { timeout: 5000 });
  check("deleted, the open one gives way to a new chat and the list stays open",
    (await dev.locator(".msg").count()) === 0 && (await dev.evaluate(() => document.getElementById("chat").classList.contains("history-shown"))));
  await dev.click(".history-row >> text=検索");
  await dev.waitForSelector(".msg.assistant .made-file");
  check("the other conversation opens again, its files with it", (await dev.locator(".made-file").count()) === 4);

  // MARK: Two tabs, one history
  {
    const tab2 = await devContext.newPage();
    const tab2Errors = await watch(tab2);
    await tab2.addInitScript((s) => { if (!sessionStorage.getItem("fielua.session")) sessionStorage.setItem("fielua.session", s); }, await dev.evaluate(() => sessionStorage.getItem("fielua.session")));
    await tab2.goto(page0);
    await tab2.waitForSelector("#chat:not([hidden])");
    const reopened = await tab2.waitForFunction(() => document.querySelectorAll(".msg.assistant .made-file").length === 4, null, { timeout: 8000 }).then(() => true, () => false);
    check("a second tab opens on the conversation open last", reopened);
    const before = await dev.locator(".msg").count();
    await sendMessage(tab2, "echo");
    await waitReply(tab2);
    const followed = await dev.waitForFunction((n) => document.querySelectorAll(".msg").length === n + 2, before, { timeout: 8000 }).then(() => true, () => false);
    check("what one tab adds to a conversation shows in the other, which then can't write an older copy over it", followed, `${before} → ${await dev.locator(".msg").count()}`);
    const staleCopy = await dev.evaluate(() => sessionStorage.getItem("fielua.chat"));
    await tab2.click("#history-button");
    await tab2.waitForSelector("#chat.history-shown .history-row[aria-current=true]");
    await tab2.click(".history-row[aria-current=true]", { button: "right" });
    await tab2.click("#history-delete");
    await tab2.click("#confirm-ok");
    await settled(tab2);
    const gone = await dev.waitForFunction(() => document.querySelectorAll(".msg").length === 0, null, { timeout: 8000 }).then(() => true, () => false);
    check("deleted in one tab, it goes from the other too", gone);
    // A tab that missed it (its own copy still in the tab's storage) doesn't bring it back on a reload.
    await dev.evaluate((copy) => sessionStorage.setItem("fielua.chat", copy), staleCopy);
    await dev.reload();
    await dev.waitForSelector("#chat:not([hidden])");
    await sleep(1000);
    check("nor does a reload bring a deleted conversation back", (await dev.locator(".msg").count()) === 0 && JSON.parse(staleCopy).messages.length > 0);
    // The 12 hours run out while the tab is away: back in view, it signs out, the list locked with it.
    await tab2.evaluate(() => {
      const value = JSON.parse(sessionStorage.getItem("fielua.session"));
      value.expiresAt = Date.now() - 1000;
      sessionStorage.setItem("fielua.session", JSON.stringify(value));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const lockedOut = await tab2.waitForSelector("#login:not([hidden])", { timeout: 5000 }).then(() => true, () => false);
    check("a sign-in that ran out signs the page out, its history list with it", lockedOut && (await tab2.locator(".history-row").count()) === 0);
    check("no page errors in the second tab", tab2Errors.length === 0, tab2Errors.join(" | "));
    await tab2.close();
  }

  // MARK: A long conversation
  {
    const longContext = await browser.newContext({ ...iphone });
    await longContext.addInitScript(([s, c]) => { sessionStorage.setItem("fielua.session", s); sessionStorage.setItem("fielua.chat", c); },
      [await dev.evaluate(() => sessionStorage.getItem("fielua.session")),
        JSON.stringify({ messages: Array.from({ length: 30 }, (_, i) => [{ role: "user", text: `質問 ${i}` }, { role: "assistant", text: `答え ${i}`, model: "claude-opus-5-5", effort: "medium", end: "done" }]).flat() })]);
    const longPage = await longContext.newPage();
    await longPage.goto(page0);
    await longPage.waitForSelector("#chat:not([hidden])");
    await sendMessage(longPage, "echo");
    await waitReply(longPage);
    const sentTurns = upstream.requests.at(-1).body.messages;
    const longCaption = await longPage.locator(".msg.assistant").last().locator(".caption").textContent();
    check("a long conversation says its first questions no longer go to Claude", sentTurns.length === 39 && longCaption.includes("最初の 11 問は Claude に送っていません"), `${sentTurns.length} turns, ${longCaption}`);
    await longContext.close();
  }

  // MARK: A friend
  await dev.click("#settings-button");
  await dev.waitForSelector("#settings-sheet[open] .person", { timeout: 10000 });
  await dev.fill("#settings-sheet input[placeholder='招待する人の名前']", "ともだち");
  await dev.getByRole("button", { name: "作る" }).click();
  await dev.waitForSelector("#settings-sheet .link-out");
  const code = await dev.locator("#settings-sheet .link-out").first().textContent();
  await dev.click("#settings-sheet [data-close]");
  await settled(dev);

  const friendContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const friend = await friendContext.newPage();
  const friendErrors = await watch(friend);
  await passkeyDevice(friendContext, friend);
  await friend.goto(`${page0}#invite=${code}`);
  await friend.waitForSelector("#login-invite:not([hidden])");
  check("an invite link opens the invite with its code, and the code leaves the address", (await friend.inputValue("#invite-code")) === code && !friend.url().includes(code));
  await friend.focus("#invite-code");
  await friend.keyboard.press("Enter");
  await friend.waitForSelector("#chat:not([hidden])", { timeout: 15000 });
  check("the friend registers with a passkey", await friend.isVisible("#composer"));
  await friend.fill("#input", "こんにちは");
  check("friends can't send until the developer turns them on", await friend.isDisabled("#send") && (await friend.textContent("#banner")).includes("友人の利用をまだオンにしていません"));
  check("friends don't see the developer's credit", await friend.isHidden("#credit"));
  const friendAdmin = await friend.evaluate(async (relayURL) => {
    const token = JSON.parse(sessionStorage.getItem("fielua.session")).token;
    const r = await fetch(`${relayURL}/admin/state`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() };
  }, relay);
  check("a friend's session can't do the developer's work", friendAdmin.status === 403 && friendAdmin.body.error === "forbidden");
  const friendSettings = await friend.evaluate(() => document.getElementById("settings-button") !== null);
  check("the settings open for a friend without the developer's part", friendSettings);

  await dev.click("#settings-button");
  await dev.waitForSelector("#settings-sheet[open] .person", { timeout: 10000 });
  await dev.locator("#settings-sheet input[aria-label='友人の利用']").click();
  await dev.waitForSelector("#confirm[open]");
  check("turning friends on asks to confirm Anthropic's terms first", await dev.isDisabled("#confirm-ok"));
  await dev.locator("#confirm input[type=checkbox]").check();
  await dev.click("#confirm-ok");
  await settled(dev);
  await sleep(600);
  await dev.click("#settings-sheet [data-close]");
  await settled(dev);
  await friend.reload();
  await friend.waitForSelector("#chat:not([hidden])");
  await friend.fill("#input", "こんにちは");
  await friend.click("#send");
  await waitReply(friend);
  check("once on, the friend chats", (await lastReply(friend).locator(".reply").textContent()).includes("受け取りました"));
  const friendDownload = await friend.evaluate(async (relayURL) => {
    const token = JSON.parse(sessionStorage.getItem("fielua.session")).token;
    const r = await fetch(`${relayURL}/v1/files/file_e2e_report/content`, { headers: { Authorization: `Bearer ${token}` } });
    return r.status;
  }, relay);
  check("a friend can't download the developer's files", friendDownload === 404, `status ${friendDownload}`);
  await friend.waitForSelector(".history-row");
  const dock = await friend.evaluate(() => ({
    docked: document.getElementById("chat").classList.contains("docked"),
    panel: Math.round(document.getElementById("chat-panel").getBoundingClientRect().left),
    rows: [...document.querySelectorAll(".history-row")].map((row) => row.textContent),
    label: document.getElementById("history-button").getAttribute("aria-label"),
  }));
  check("on a PC the list stands beside the chat, with the friend's own conversation only", dock.docked && dock.panel === 360 && dock.rows.join() === "こんにちは" && dock.label === "会話一覧を閉じる", JSON.stringify(dock));
  await friend.screenshot({ path: join(SHOTS, "check-pc-friend.png") });
  await friend.click("#settings-button");
  await friend.getByRole("button", { name: "ログアウト" }).click();
  await friend.waitForSelector("#login:not([hidden])");
  check("signed out: the list leaves the page", (await friend.locator(".history-row").count()) === 0 && !(await friend.evaluate(() => document.getElementById("history-list").textContent)));
  await friend.click("#login-passkey");
  await friend.waitForSelector("#chat:not([hidden]) .history-row", { timeout: 15000 });
  check("signed in again: the history and the conversation open last are back",
    (await friend.locator(".history-row").count()) === 1 && (await friend.locator(".msg").count()) === 2);
  // A second tab of the friend's, open while they leave in the first.
  const friend2 = await friendContext.newPage();
  const friend2Errors = await watch(friend2);
  await friend2.addInitScript((s) => { if (!sessionStorage.getItem("fielua.session")) sessionStorage.setItem("fielua.session", s); }, await friend.evaluate(() => sessionStorage.getItem("fielua.session")));
  await friend2.goto(page0);
  await friend2.waitForSelector("#chat:not([hidden]) .history-row", { timeout: 15000 });
  await friend.click("#settings-button");
  await friend.getByRole("button", { name: "登録を解除" }).click();
  await friend.waitForSelector("#confirm[open]");
  check("登録を解除 says this device's history goes too", (await friend.textContent("#confirm-body")).includes("この端末の会話履歴も消えます"));
  await friend.click("#confirm-ok");
  await settled(friend);
  await friend.waitForSelector("#login:not([hidden])");
  await sleep(300);
  const gone = await friend.evaluate(async () => (await indexedDB.databases()).filter((d) => d.name.startsWith("fielua-history-")).length);
  check("left: the friend's history database is gone from this browser", gone === 0, `${gone} left`);
  const otherTabOut = await friend2.waitForSelector("#login:not([hidden])", { timeout: 5000 }).then(() => true, () => false);
  await sleep(500);
  const stillGone = await friend.evaluate(async () => (await indexedDB.databases()).filter((d) => d.name.startsWith("fielua-history-")).length);
  check("the friend's other tab signs out too, and doesn't make the database again", otherTabOut && stillGone === 0 && (await friend2.locator(".history-row").count()) === 0, `${otherTabOut} ${stillGone}`);
  check("no page errors in the friend's other tab", friend2Errors.length === 0, friend2Errors.join(" | "));
  await friend2.close();

  // MARK: Out of credit
  await sendMessage(dev, "billing");
  await waitReply(dev);
  check("out of credit: said plainly, nothing bought", (await lastReply(dev).locator(".notice").textContent()).includes("追加購入はしていません"));
  await dev.waitForFunction(() => document.getElementById("credit-text").textContent === "0", null, { timeout: 8000 });
  check("the ring shows 0% once Anthropic says the credit ran out", true);
  check("sending waits until the developer resumes", await goes(dev, "#banner", true));
  await dev.click("#settings-button");
  await dev.getByRole("button", { name: "再開する" }).click();
  await sleep(800);
  await dev.click("#settings-sheet [data-close]");
  await settled(dev);
  check("the developer resumes", await goes(dev, "#banner"));

  // MARK: Offline
  await devContext.setOffline(true);
  await dev.evaluate(() => window.dispatchEvent(new Event("offline")));
  await sendMessage(dev, "オフライン");
  await waitReply(dev);
  check("no connection: said plainly", (await lastReply(dev).locator(".notice").textContent()).includes("接続できません"));
  await devContext.setOffline(false);
  await dev.evaluate(() => window.dispatchEvent(new Event("online")));

  // MARK: Dark
  await dev.emulateMedia({ colorScheme: "dark" });
  // (The conversation with files was deleted in the two-tab check: whatever is open now.)
  const madeCard = dev.locator(".msg.assistant .made-file").first();
  if (await madeCard.count()) await madeCard.scrollIntoViewIfNeeded();
  await dev.screenshot({ path: join(SHOTS, "check-dark.png") });

  // Fable 5.1 chosen before Fable 5.2 came: the page goes on with 5.2, at the level chosen for 5.1, and a reply 5.1 wrote keeps its name.
  {
    const session = await dev.evaluate(() => sessionStorage.getItem("fielua.session"));
    const chat = JSON.parse(chatBeforeTools);
    const old = chat.messages.find((m) => m.role === "assistant" && m.text);
    Object.assign(old, { model: "claude-fable-5-1", effort: "high", served: "claude-fable-5-1" });
    chat.messages = chat.messages.slice(0, chat.messages.indexOf(old) + 1);
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
    await context.addInitScript(([s, c]) => {
      sessionStorage.setItem("fielua.session", s);
      sessionStorage.setItem("fielua.chat", c);
      localStorage.setItem("fielua.prefs", JSON.stringify({ model: "claude-fable-5-1", efforts: { "claude-fable-5-1": "low" } }));
    }, [session, JSON.stringify(chat)]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(page0);
    await page.waitForSelector(".msg.assistant .caption");
    await page.waitForFunction(() => document.getElementById("model-name").textContent === "Claude Fable 5.2", null, { timeout: 5000 }).catch(() => {});
    const seen = await page.evaluate(() => ({
      name: document.getElementById("model-name").textContent,
      sub: document.getElementById("model-sub").textContent,
      caption: document.querySelector(".msg.assistant .caption span").textContent,
      prefs: JSON.parse(localStorage.getItem("fielua.prefs")),
    }));
    check("a saved Fable 5.1 goes on as Fable 5.2, at its level", seen.name === "Claude Fable 5.2" && seen.sub.includes("低"), JSON.stringify(seen));
    check("a reply Fable 5.1 wrote keeps its name", seen.caption.startsWith("Claude Fable 5.1 · 推論 高") && !seen.caption.includes("claude-"), seen.caption);
    check("no page errors with a saved Fable 5.1", errors.length === 0, errors.join(" | "));
    await context.close();
  }

  check("no page errors on the iPhone", devErrors.length === 0, devErrors.join(" | "));
  check("no page errors on the PC", friendErrors.length === 0, friendErrors.join(" | "));

  // MARK: Pictures for people (2x)
  if (PEOPLE) {
    const saved = await dev.evaluate((chat) => ({ session: sessionStorage.getItem("fielua.session"), chat }), chatBeforeTools);
    const chat = JSON.parse(saved.chat);
    chat.messages = chat.messages.slice(0, 2);
    const seed = (context) => context.addInitScript(([session, conversation]) => {
      sessionStorage.setItem("fielua.session", session);
      sessionStorage.setItem("fielua.chat", conversation);
    }, [saved.session, JSON.stringify(chat)]);
    for (const [name, options, scheme] of [
      ["iphone-light", { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, "light"],
      ["iphone-dark", { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, "dark"],
      ["pc-light", { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }, "light"],
    ]) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      await seed(context);
      const page = await context.newPage();
      await page.goto(page0);
      await page.waitForSelector(".msg.assistant .katex");
      await sleep(400);
      await page.evaluate(() => document.getElementById("scroller").scrollTo({ top: 0 }));
      await page.screenshot({ path: join(PEOPLE, `${name}-top.png`) });
      await page.evaluate(() => { const s = document.getElementById("scroller"); s.scrollTo({ top: s.scrollHeight }); });
      await sleep(200);
      await page.screenshot({ path: join(PEOPLE, `${name}-end.png`) });
      if (name === "iphone-light") {
        await page.click("#model-button");
        await sleep(500);
        await page.screenshot({ path: join(PEOPLE, "iphone-model-sheet.png") });
        await page.click("#model-sheet [data-close]");
        await settled(page);
        await page.click("#credit");
        await sleep(500);
        await page.screenshot({ path: join(PEOPLE, "iphone-credit.png") });
      }
      await context.close();
    }
    // The attachments: a sent photo, video and files, and two more waiting above the bar.
    const full = JSON.parse(saved.chat);
    const at = full.messages.findIndex((m) => m.attachments?.length);
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
      await context.addInitScript(([session, conversation]) => {
        sessionStorage.setItem("fielua.session", session);
        sessionStorage.setItem("fielua.chat", conversation);
      }, [saved.session, JSON.stringify({ messages: full.messages.slice(at, at + 2).map((m) => (m.role === "assistant" ? { ...m, text: "写真と動画、PDF、メモを受け取りました。" } : m)) })]);
      const page = await context.newPage();
      await page.goto(page0);
      await page.waitForSelector(".msg.user .sent-picture img");
      await page.setInputFiles("#pick-photos", [{ name: "東京駅.jpg", mimeType: "image/jpeg", buffer: located }]);
      await page.setInputFiles("#pick-files", [{ name: "教材.pdf", mimeType: "application/pdf", buffer: pdfBytes }]);
      await page.waitForFunction(() => document.querySelectorAll("#tray .tray-item").length === 2);
      await page.fill("#input", "この写真の場所はどこ？");
      await sleep(400);
      await page.screenshot({ path: join(PEOPLE, `iphone-attachments-${scheme}.png`) });
      if (scheme === "light") {
        await page.click("#attach");
        await sleep(400);
        await page.screenshot({ path: join(PEOPLE, "iphone-attach-menu.png") });
      }
      await context.close();
    }
    // A reply that searched, one that made files, and the plus menu with its switches.
    const tooled = JSON.parse(chatWithTools);
    const searchAt = tooled.messages.findIndex((m) => m.search?.pages?.some((p) => p.cited));
    const filesAt = tooled.messages.findIndex((m) => m.files?.length);
    const shown = [...tooled.messages.slice(searchAt - 1, searchAt + 1), ...tooled.messages.slice(filesAt - 1, filesAt + 1)];
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
      await context.addInitScript(([session, conversation]) => {
        sessionStorage.setItem("fielua.session", session);
        sessionStorage.setItem("fielua.chat", conversation);
        localStorage.setItem("fielua.prefs", JSON.stringify({ tools: { webSearch: true, files: true } }));
      }, [saved.session, JSON.stringify({ messages: shown, container: tooled.container })]);
      const page = await context.newPage();
      await page.goto(page0);
      await page.waitForSelector(".made-picture:not([hidden])", { timeout: 10000 });
      await sleep(400);
      await page.evaluate(() => { const s = document.getElementById("scroller"); s.scrollTo({ top: s.scrollHeight }); });
      await sleep(200);
      await page.screenshot({ path: join(PEOPLE, `iphone-tools-${scheme}.png`) });
      if (scheme === "light") {
        await page.evaluate(() => document.getElementById("scroller").scrollTo({ top: 0 }));
        await page.screenshot({ path: join(PEOPLE, "iphone-tools-search.png") });
        await page.click("#attach");
        await sleep(400);
        await page.screenshot({ path: join(PEOPLE, "iphone-tools-menu.png") });
      }
      await context.close();
    }
    const login = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const loginPage = await login.newPage();
    await loginPage.goto(page0);
    await loginPage.waitForSelector("#login:not([hidden])");
    await loginPage.screenshot({ path: join(PEOPLE, "iphone-login.png") });
    await login.close();
  }
} catch (error) {
  check("the run finished", false, String(error?.stack ?? error));
} finally {
  await browser.close();
  stopRelay();
  web.close();
  anthropic.close();
  cable.cut();
  cableServer.close();
}

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length} passed, ${failedChecks.length} failed`);
if (failedChecks.length && process.env.RELAY_LOG) console.log(relayLog);
process.exit(failedChecks.length ? 1 : 0);
