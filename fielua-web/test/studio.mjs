// Fielua for the web, looked at rather than checked: every screen in light
// and dark, on a phone and on a PC, and each motion as a strip of frames
// taken while it runs (Chromium's screencast, so the timing is the page's
// own). Run through the end-to-end test's stand-ins:
//
//   STUDIO=out-dir node test/e2e.mjs
//   STUDIO=out-dir STUDIO_ONLY=sheet,alert node test/e2e.mjs   (scenes whose name has one of these words)
//
// Nothing here passes or fails: the pictures are for a person (or Claude) to look at.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IPHONE = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1" };
const PC = { viewport: { width: 1280, height: 800 } };

export default async function studio({ browser, page0, admin, out, passkeyDevice, sendMessage, waitReply, swipe, sleep }) {
  mkdirSync(out, { recursive: true });
  const only = (process.env.STUDIO_ONLY ?? "").split(",").map((word) => word.trim()).filter(Boolean);
  const wanted = (name) => !only.length || only.some((word) => name.includes(word));
  const scale = Number(process.env.STUDIO_SCALE ?? 1);

  // MARK: A signed-in developer, once; every other window borrows the session.
  const first = await browser.newContext({ ...IPHONE, deviceScaleFactor: scale });
  const firstPage = await first.newPage();
  await passkeyDevice(first, firstPage);
  await firstPage.goto(page0);
  await firstPage.waitForSelector("#login:not([hidden])");
  await firstPage.click("#show-setup");
  await firstPage.fill("#setup-admin-key", admin);
  await firstPage.fill("#setup-name", "はっちー");
  await firstPage.click("#setup-register");
  await firstPage.waitForSelector("#chat:not([hidden])", { timeout: 15000 });
  const session = await firstPage.evaluate(() => sessionStorage.getItem("fielua.session"));
  await first.close();

  /** A window of one kind ("iphone" or "pc") and scheme, signed in unless `signedOut`. */
  async function open(kind, scheme, { signedOut = false, reduced = false, prefs = null } = {}) {
    const context = await browser.newContext({ ...(kind === "pc" ? PC : IPHONE), deviceScaleFactor: scale, colorScheme: scheme, reducedMotion: reduced ? "reduce" : "no-preference" });
    if (!signedOut) {
      await context.addInitScript(([s, p]) => {
        if (!sessionStorage.getItem("fielua.session")) sessionStorage.setItem("fielua.session", s);
        if (p && !localStorage.getItem("fielua.prefs")) localStorage.setItem("fielua.prefs", p);
      }, [session, prefs ? JSON.stringify(prefs) : null]);
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => { errors.push(String(error)); console.log(`page error: ${error}`); });
    page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) console.log(`console: ${message.text()}`); });
    await page.goto(page0);
    await page.waitForSelector(signedOut ? "#login:not([hidden])" : "#chat:not([hidden])", { timeout: 15000 });
    await sleep(350);
    return { context, page, errors, kind, scheme };
  }

  const shot = async (page, name) => {
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log(`shot  ${name}`);
  };

  /**
   * A motion as a strip: the frames Chromium drew from just before `action`
   * until `ms` later, at most `max` of them, evenly picked, each with its
   * time. `crop` ({ x, y, width, height } in CSS px) keeps one part.
   */
  async function strip(page, name, action, { ms = 700, max = 10, crop = null, width = 200 } = {}) {
    if (!wanted(`strip-${name}`)) { await action(); await sleep(ms); return; }
    const cdp = await page.context().newCDPSession(page);
    const frames = [];
    cdp.on("Page.screencastFrame", (frame) => {
      frames.push({ data: frame.data, at: frame.metadata.timestamp * 1000 });
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await sleep(150);
    const began = Date.now();
    const before = frames.at(-1);
    await action();
    await sleep(ms);
    await cdp.send("Page.stopScreencast");
    await cdp.detach();
    const during = frames.filter((frame) => frame.at >= began - 8);
    const all = [...(before && !during.includes(before) ? [{ ...before, at: began }] : []), ...during];
    const picked = all.length <= max ? all : Array.from({ length: max }, (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))]);
    const viewport = page.viewportSize();
    const box = crop ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const ratio = width / box.width;
    const sheet = await page.context().browser().newPage({ viewport: { width: Math.min(picked.length, 6) * (width + 10) + 10, height: 100 } });
    await sheet.setContent(`<body style="margin:0;padding:10px 0 0 10px;background:#888;font:11px/1.4 monospace;color:#fff;display:flex;flex-wrap:wrap;gap:10px">${picked.map((frame) =>
      `<figure style="margin:0 0 10px"><div style="width:${width}px;height:${Math.round(box.height * ratio)}px;overflow:hidden;position:relative;background:#000"><img src="data:image/png;base64,${frame.data}" style="position:absolute;left:${-box.x * ratio}px;top:${-box.y * ratio}px;width:${viewport.width * ratio}px"></div><figcaption>+${Math.max(0, Math.round(frame.at - began))} ms</figcaption></figure>`).join("")}<p style="width:100%;margin:0 0 6px">${name} · ${all.length} frames in ${ms} ms</p></body>`);
    await sheet.screenshot({ path: join(out, `strip-${name}.png`), fullPage: true });
    await sheet.close();
    console.log(`strip ${name} (${all.length} frames)`);
  }

  const notes = [];

  // MARK: The tour: each screen, still.
  for (const [kind, scheme] of [["iphone", "light"], ["iphone", "dark"], ["pc", "light"], ["pc", "dark"]]) {
    const tag = `${kind}-${scheme}`;
    if (!wanted(`tour-${tag}`)) continue;
    const signedOut = await open(kind, scheme, { signedOut: true });
    await shot(signedOut.page, `tour-${tag}-login`);
    await signedOut.context.close();

    const { context, page, errors } = await open(kind, scheme);
    await shot(page, `tour-${tag}-empty`);
    await sendMessage(page, "md");
    await waitReply(page);
    await sleep(900);
    await shot(page, `tour-${tag}-reply-end`);
    await page.evaluate(() => document.getElementById("scroller").scrollTo({ top: 0 }));
    await sleep(300);
    await shot(page, `tour-${tag}-reply-top`);
    await page.click("#model-button");
    await sleep(500);
    await shot(page, `tour-${tag}-model-sheet`);
    await page.click("#model-sheet [data-close]");
    await page.click("#attach");
    await sleep(400);
    await shot(page, `tour-${tag}-plus-menu`);
    await page.keyboard.press("Escape");
    await page.click(kind === "pc" ? "#settings-button" : "#settings-button");
    await sleep(500);
    await shot(page, `tour-${tag}-settings`);
    await page.evaluate(() => { const body = document.getElementById("settings-body"); body.scrollTo({ top: body.scrollHeight }); });
    await sleep(200);
    await shot(page, `tour-${tag}-settings-end`);
    await page.click("#settings-sheet [data-close]");
    // Two more chats, then the list.
    for (const question of ["こんにちは", "think"]) {
      await page.click("#attach");
      await page.click("#menu-new-chat");
      await sendMessage(page, question);
      await waitReply(page);
    }
    if (kind === "iphone") { await page.click("#history-button"); await sleep(600); }
    await shot(page, `tour-${tag}-history`);
    if (errors.length) notes.push(`${tag}: ${errors.join(" | ")}`);
    await context.close();
  }

  // MARK: The motion: one strip each.
  if (wanted("strip")) {
    const { context, page, errors } = await open("iphone", "light");
    const lower = { x: 0, y: 352, width: 393, height: 500 };
    const middle = { x: 96, y: 250, width: 200, height: 200 };
    await strip(page, "first-paint-signed-in", async () => { await page.reload(); }, { ms: 900 });
    await strip(page, "empty-alive", async () => {}, { ms: 9500, max: 18, crop: middle, width: 150 });
    await strip(page, "empty-typing", async () => { await page.fill("#input", "こんにちは"); }, { ms: 800, crop: middle, width: 150 });
    await strip(page, "empty-typing-back", async () => { await page.fill("#input", ""); }, { ms: 1100, crop: middle, width: 150 });
    await strip(page, "send-think", async () => { await sendMessage(page, "think"); }, { ms: 1400, max: 12 });
    await waitReply(page);
    await strip(page, "send-md", async () => { await sendMessage(page, "md"); }, { ms: 1600, max: 12 });
    await waitReply(page);
    await strip(page, "model-sheet-open", async () => { await page.click("#model-button"); }, { ms: 600 });
    await strip(page, "model-sheet-choose", async () => { await page.locator("#effort-list .choice").nth(2).click(); }, { ms: 400, crop: lower });
    await strip(page, "model-sheet-close", async () => { await page.click("#model-sheet [data-close]"); }, { ms: 600 });
    await strip(page, "plus-menu-open", async () => { await page.click("#attach"); }, { ms: 450, crop: lower });
    await strip(page, "plus-menu-close", async () => { await page.keyboard.press("Escape"); }, { ms: 450, crop: lower });
    await strip(page, "settings-open", async () => { await page.click("#settings-button"); }, { ms: 600 });
    await strip(page, "settings-close", async () => { await page.click("#settings-sheet [data-close]"); }, { ms: 600 });
    await strip(page, "history-open", async () => { await page.click("#history-button"); }, { ms: 650 });
    await strip(page, "history-close", async () => { await page.click("#history-close"); }, { ms: 650 });
    await page.evaluate(() => document.getElementById("scroller").scrollTo({ top: 0 }));
    await strip(page, "jump-appears", async () => { await page.evaluate(() => document.getElementById("scroller").scrollBy({ top: 40 })); }, { ms: 500, crop: lower });
    await strip(page, "jump-pressed", async () => { await page.click("#jump"); }, { ms: 800, crop: lower });
    await strip(page, "copy-toast", async () => { await page.locator(".caption button").last().click(); }, { ms: 2600, crop: lower, max: 12 });
    await page.evaluate(() => document.getElementById("scroller").scrollTo({ top: 1e6 }));
    await strip(page, "composer-grow", async () => { await page.fill("#input", "一行目\n二行目\n三行目"); }, { ms: 500, crop: lower });
    await strip(page, "composer-shrink", async () => { await page.fill("#input", ""); }, { ms: 500, crop: lower });
    const png = readFileSync(new URL("../src/assets/flower.png", import.meta.url));
    await strip(page, "tray-open", async () => { await page.setInputFiles("#pick-photos", [{ name: "a.png", mimeType: "image/png", buffer: png }, { name: "b.png", mimeType: "image/png", buffer: png }]); }, { ms: 900, crop: lower });
    await strip(page, "tray-remove-one", async () => { await page.locator("#tray .tray-remove").first().click(); }, { ms: 500, crop: lower });
    await strip(page, "tray-close", async () => { await page.locator("#tray .tray-remove").first().click(); }, { ms: 600, crop: lower });
    await strip(page, "toast", async () => { await page.setInputFiles("#pick-files", [{ name: "報告.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK\x03\x04", "binary") }]); }, { ms: 900, crop: { x: 0, y: 0, width: 393, height: 300 } });
    await page.click("#settings-button");
    await sleep(900);
    await strip(page, "alert-open", async () => { await page.getByRole("button", { name: "登録を解除" }).click(); }, { ms: 600 });
    await shot(page, "still-alert");
    await strip(page, "alert-close", async () => { await page.click("#confirm-cancel"); }, { ms: 500 });
    await page.click("#settings-sheet [data-close]");
    await sleep(600);
    await page.click("#history-button");
    await sleep(600);
    await strip(page, "search-open", async () => { await page.click("#history-search-button"); }, { ms: 700, crop: { x: 0, y: 0, width: 393, height: 200 } });
    await strip(page, "search-close", async () => { await page.click("#history-search-button"); }, { ms: 500, crop: { x: 0, y: 0, width: 393, height: 200 } });
    if (errors.length) notes.push(`strips: ${errors.join(" | ")}`);
    await context.close();

    const signedOut = await open("iphone", "light", { signedOut: true });
    await strip(signedOut.page, "login-first-paint", async () => { await signedOut.page.reload(); }, { ms: 2400, max: 18, width: 150 });
    await strip(signedOut.page, "login-panel-switch", async () => { await signedOut.page.click("#show-invite"); }, { ms: 500 });
    await signedOut.context.close();
  }

  writeFileSync(join(out, "notes.txt"), notes.length ? notes.join("\n") : "no page errors\n");
  console.log(notes.length ? `page errors:\n${notes.join("\n")}` : "no page errors");
}
