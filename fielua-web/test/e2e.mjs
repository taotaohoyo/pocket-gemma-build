// Fielua for the web, end to end on this machine: the built /chat/ folder
// served as Sakura would serve it (with the .htaccess headers), the relay
// in Cloudflare's own runtime (wrangler dev / workerd), a stand-in for
// Anthropic, and Chromium with a virtual passkey authenticator (Face ID's
// stand-in). No real key, no network, no real Anthropic call: a pass here
// is not a pass against the real Claude API.
//
//   node test/e2e.mjs            (PEOPLE_SHOTS=dir also saves 2x screenshots for people)

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
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
  "claude-fable-5-1": ["low", "medium", "high"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh"],
};

const upstream = { requests: [], closedEarly: 0 };
const anthropic = createServer((req, res) => {
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
    const question = body.messages.at(-1).content.trim();
    if (question === "billing") {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low." } }));
      return;
    }
    let reply = `受け取りました：${question}`;
    let pieceSize = 6;
    let every = 15;
    let usage = { input_tokens: 1000, output_tokens: 100 };
    if (question === "md") reply = MD;
    if (question === "long") { reply = LONG; pieceSize = 200; }
    if (question === "slow") { reply = "ゆっくり答えます。".repeat(200); pieceSize = 3; every = 60; }
    if (question === "echo") {
      reply = `model=${body.model} effort=${body.output_config?.effort} max=${body.max_tokens} turns=${body.messages.length} thinking=${body.thinking?.type}`;
      usage = { input_tokens: 200000, output_tokens: 100000 };
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "msg_e2e", model: body.model, content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
    let index = 0;
    const pieces = [];
    if (question === "think") {
      for (let i = 0; i < 20; i++) pieces.push({ thinking: "…" });
      reply = "考えた結果、答えは 42 です。";
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
  });
});
await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
const anthropicPort = anthropic.address().port;

// MARK: The page, served as Sakura serves the folder

const webPort = 19000 + Math.floor(Math.random() * 500);
const relayPort = 18500 + Math.floor(Math.random() * 400);
const relay = `http://127.0.0.1:${relayPort}`;
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

async function sendMessage(page, text) {
  await page.fill("#input", text);
  await page.click("#send");
}

async function waitReply(page, timeout = 20000) {
  await page.waitForFunction(() => !document.querySelector("#composer").classList.contains("streaming")
    && document.querySelector(".msg.assistant:last-child .caption, .msg.assistant:last-child .notice"), null, { timeout });
}

const lastReply = (page) => page.locator(".msg.assistant").last();

const browser = await chromium.launch();
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
  check("Fielua's top is chosen at first: Claude Opus 5.5 at 超高", (await dev.textContent("#model-name")) === "Claude Opus 5.5" && (await dev.textContent("#model-sub")).includes("超高"));

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
  check("the caption says who answered at which level", md.caption === "Claude Opus 5.5 · 推論 超高", md.caption);
  check("no Content Security Policy violation", md.csp.length === 0, md.csp.join(" | "));
  check("nothing runs wider than the iPhone's screen", md.overflow <= 0, `${md.overflow}px`);
  const sent = upstream.requests.at(-1).body;
  check("the relay asked for Opus 5.5 at xhigh with 64,000 tokens and adaptive thinking", sent.model === "claude-opus-5-5" && sent.output_config?.effort === "xhigh" && sent.max_tokens === 64000 && sent.thinking?.type === "adaptive");
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
    efforts: Array.from(document.querySelectorAll("#effort-list .choice")).map((b) => ({ title: b.querySelector(".title").textContent, disabled: b.disabled, checked: b.getAttribute("aria-checked") })),
  }));
  check("models in Fielua's order, Opus 5.5 first", sheet.models.map((m) => m.name).join(",") === "Claude Opus 5.5,Claude Fable 5.1,Claude Sonnet 5.5,Claude Haiku 5.5");
  check("a model Anthropic doesn't offer can't be chosen", sheet.models[3].disabled && !sheet.models[0].disabled);
  check("Opus 5.5 at 超高 is marked Fielua's top", sheet.efforts[3].title.includes("超高") && sheet.efforts[3].title.includes("Fieluaの最上級") && sheet.efforts[3].checked === "true");
  check("no max level", sheet.efforts.length === 4 && !sheet.efforts.some((e) => /max|最大/.test(e.title)));
  await sleep(450);
  await dev.screenshot({ path: join(SHOTS, "check-model-sheet.png") });
  await dev.locator("#model-list .choice").nth(1).click();
  const fable = await dev.evaluate(() => Array.from(document.querySelectorAll("#effort-list .choice")).map((b) => b.disabled));
  check("a level the model doesn't take can't be chosen (Fable 5.1 at 超高)", fable[3] === true && fable[0] === false);
  await dev.locator("#model-list .choice").nth(2).click();
  await dev.locator("#effort-list .choice").nth(0).click();
  await dev.click("#model-sheet [data-close]");
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

  // MARK: A friend
  await dev.click("#settings-button");
  await dev.waitForSelector("#settings-sheet[open] .person", { timeout: 10000 });
  await dev.fill("#settings-sheet input[placeholder='招待する人の名前']", "ともだち");
  await dev.getByRole("button", { name: "作る" }).click();
  await dev.waitForSelector("#settings-sheet .link-out");
  const code = await dev.locator("#settings-sheet .link-out").first().textContent();
  await dev.click("#settings-sheet [data-close]");

  const friendContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const friend = await friendContext.newPage();
  const friendErrors = await watch(friend);
  await passkeyDevice(friendContext, friend);
  await friend.goto(`${page0}#invite=${code}`);
  await friend.waitForSelector("#login-invite:not([hidden])");
  check("an invite link opens the invite with its code, and the code leaves the address", (await friend.inputValue("#invite-code")) === code && !friend.url().includes(code));
  await friend.click("#invite-register");
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
  await sleep(600);
  await dev.click("#settings-sheet [data-close]");
  await friend.reload();
  await friend.waitForSelector("#chat:not([hidden])");
  await friend.fill("#input", "こんにちは");
  await friend.click("#send");
  await waitReply(friend);
  check("once on, the friend chats", (await lastReply(friend).locator(".reply").textContent()).includes("受け取りました"));
  await friend.screenshot({ path: join(SHOTS, "check-pc-friend.png") });

  // MARK: Out of credit
  await sendMessage(dev, "billing");
  await waitReply(dev);
  check("out of credit: said plainly, nothing bought", (await lastReply(dev).locator(".notice").textContent()).includes("追加購入はしていません"));
  await dev.waitForFunction(() => document.getElementById("credit-text").textContent === "0", null, { timeout: 8000 });
  check("the ring shows 0% once Anthropic says the credit ran out", true);
  check("sending waits until the developer resumes", !(await dev.isHidden("#banner")));
  await dev.click("#settings-button");
  await dev.getByRole("button", { name: "再開する" }).click();
  await sleep(800);
  await dev.click("#settings-sheet [data-close]");
  check("the developer resumes", await dev.isHidden("#banner"));

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
  await dev.locator(".msg.assistant .reply h2").first().scrollIntoViewIfNeeded();
  await dev.screenshot({ path: join(SHOTS, "check-dark.png") });

  check("no page errors on the iPhone", devErrors.length === 0, devErrors.join(" | "));
  check("no page errors on the PC", friendErrors.length === 0, friendErrors.join(" | "));

  // MARK: Pictures for people (2x)
  if (PEOPLE) {
    const saved = await dev.evaluate(() => ({ session: sessionStorage.getItem("fielua.session"), chat: sessionStorage.getItem("fielua.chat") }));
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
        await page.click("#credit");
        await sleep(500);
        await page.screenshot({ path: join(PEOPLE, "iphone-credit.png") });
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
}

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length} passed, ${failedChecks.length} failed`);
if (failedChecks.length && process.env.RELAY_LOG) console.log(relayLog);
process.exit(failedChecks.length ? 1 : 0);
