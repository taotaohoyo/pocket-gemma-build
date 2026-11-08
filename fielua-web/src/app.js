// Fielua for the web: sign in with a passkey, then chat with Claude
// through Fielua's relay. The page holds no secret of the developer's:
// the Anthropic API key lives only in the relay (a Cloudflare secret).

import { RELAY, RelayError, call, callJSON, session } from "./api.js";
import { ACCEPT, AttachError, LIMITS as ATTACH, prepare, release, sizeLabel, stored, timeLabel } from "./attach.js";
import { attachReplyActions, copyText, loadMath, ReplyView } from "./markdown.js";
import { createPasskey, forgetPasskey, newAdminKey, passkeysSupported, usePasskey } from "./passkey.js";
import { Pacer, readEvents } from "./stream.js";

const $ = (id) => document.getElementById(id);

// MARK: Models and levels

const EFFORTS = ["low", "medium", "high", "xhigh"];
const EFFORT = {
  low: { title: "低", help: "速く答えます。短い質問や確認に。" },
  medium: { title: "中", help: "速さと深さのバランスをとります。" },
  high: { title: "高", help: "難しい質問をじっくり考えます。" },
  xhigh: { title: "超高", help: "さらに深く考えます。時間と料金がいちばん増えます。" },
};
/** Fielua's top choice: Claude Opus 5.5 at 超高. */
const TOP = { model: "claude-opus-5-5", effort: "xhigh" };
/** The level every model starts at until the person chooses one (Hachimoto さん, 2026-11-08). */
const START_EFFORT = "medium";
const startEffort = (model) => (model.efforts.includes(START_EFFORT) ? START_EFFORT : model.defaultEffort);
/** The relay's catalog as this version knows it, in Fielua's order, until the relay answers. */
const BUILT_IN = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: EFFORTS, defaultEffort: "medium", available: null },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: EFFORTS, defaultEffort: "high", available: null },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: EFFORTS, defaultEffort: "high", available: null },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: EFFORTS, defaultEffort: "medium", available: null },
];

// As the relay takes them (claude-relay/src/turns.ts), with room to spare.
const MAX_TURNS = 40;
const MAX_TURN_BYTES = 60 * 1024;
const MAX_TOTAL_BYTES = 180 * 1024;
const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).length;

const state = {
  status: null,
  chat: loadChat(),
  prefs: loadPrefs(),
  streaming: null,
  views: new Map(),
  /** What is attached to the message being written. */
  draft: [],
  /** Files being made ready. */
  preparing: 0,
};

// MARK: Storage (this device only; the conversation only in this tab)

function loadPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem("fielua.prefs") ?? "{}");
    return { model: typeof value.model === "string" ? value.model : TOP.model, efforts: typeof value.efforts === "object" && value.efforts ? value.efforts : {} };
  } catch {
    return { model: TOP.model, efforts: {} };
  }
}
function savePrefs() {
  try { localStorage.setItem("fielua.prefs", JSON.stringify(state.prefs)); } catch { /* private mode */ }
}
function loadChat() {
  try {
    const value = JSON.parse(sessionStorage.getItem("fielua.chat") ?? "null");
    if (value && Array.isArray(value.messages)) return value;
  } catch { /* none */ }
  return { messages: [] };
}
function saveChat() {
  const write = (pictures) => sessionStorage.setItem("fielua.chat", JSON.stringify({
    messages: state.chat.messages.map(({ role, text, model, effort, served, end, error, attachments }) => ({
      role, text, model, effort, served, end, error,
      ...(attachments?.length ? { attachments: attachments.map((a) => ({ ...stored(a), thumb: pictures ? a.thumb : undefined })) } : {}),
    })),
  }));
  try {
    write(true);
  } catch {
    // The tab's storage is full: the names stay, the pictures only on the page.
    try { write(false); } catch { /* kept on the page only */ }
  }
}
function forgetChat() {
  sessionStorage.removeItem("fielua.chat");
  for (const message of state.chat.messages) message.attachments?.forEach(release);
  state.chat = { messages: [] };
}

// MARK: Little helpers

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

let toastTimer = 0;
function toast(text) {
  const element = $("toast");
  element.textContent = text;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, Math.max(2400, text.length * 90));
}

function confirmDialog({ title, body = [], ok = "OK", danger = false, check = null }) {
  const dialog = $("confirm");
  $("confirm-title").textContent = title;
  const holder = $("confirm-body");
  holder.replaceChildren(...body.map((item) => (typeof item === "string" ? h("p", { text: item }) : item)));
  const okButton = $("confirm-ok");
  okButton.textContent = ok;
  okButton.classList.toggle("danger", danger);
  let box = null;
  if (check) {
    box = h("input", { type: "checkbox" });
    holder.append(h("label", {}, box, h("span", { text: check })));
    okButton.disabled = true;
    box.addEventListener("change", () => { okButton.disabled = !box.checked; });
  } else {
    okButton.disabled = false;
  }
  return new Promise((resolve) => {
    const done = (value) => {
      okButton.onclick = null;
      $("confirm-cancel").onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    okButton.onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    dialog.onclose = () => done(false);
    dialog.showModal();
  });
}

function formatTime(ms) {
  return new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatUSD(value) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// MARK: What went wrong, in the app's words

const REASONS = {
  not_configured: "中継サーバーに Anthropic の API キーが設定されていません。",
  paused_billing: "Anthropic の API クレジットがなくなったため、Claude を止めています。追加購入はしていません。開発者が再開するまでお待ちください。",
  paused_limit: "Anthropic の利用上限に達したため、Claude を止めています。開発者が再開するまでお待ちください。",
  friends_disabled: "開発者が友人の利用をまだオンにしていません。",
};

function errorText(status, code, body = {}) {
  if (status === 0 || code === "network") return "Claude の中継サーバーに接続できません。インターネット接続を確かめてください。";
  switch (code) {
    case "unavailable": return REASONS[body.reason] ?? REASONS.not_configured;
    case "revoked": return "開発者がこのアカウントの利用を止めています。";
    case "unauthorized": return "ログインの期限が切れました。もう一度ログインしてください。";
    case "forbidden_origin": return "このアドレスからは使えません。";
    case "rate_limited": return "Claude への問い合わせが多すぎます。少し待ってからお試しください。";
    case "overloaded": return "Claude が混み合っています。少し待ってからお試しください。";
    case "server_key": return "中継サーバーの API キーが Anthropic に受け付けられませんでした。開発者がキーを確かめる必要があります。";
    case "model_unavailable": return "このモデルは今 Anthropic で使えません。モデルを選び直してください。";
    case "unsupported_model":
    case "unsupported_effort": return "このモデルか推論レベルは、中継サーバーで使えません。モデルの設定で選び直してください。";
    case "too_large": return "会話か添付が大きすぎます。添付を減らすか、新しい会話でお試しください。";
    case "bad_attachment": return "送れない添付がありました。外してからお試しください。";
    case "rejected": return "Anthropic がこの依頼を受け付けませんでした。添付を外すか、新しい会話でお試しください。";
    case "upstream_unreachable":
    case "upstream": return "Anthropic に接続できませんでした。少し待ってからお試しください。";
    case "cancelled": return "停止しました。";
    case "bad_request": return "送れない形のメッセージでした。新しい会話でお試しください。";
    default: return `中継サーバーから予期しない応答がありました（${status}）。`;
  }
}

function loginErrorText(error) {
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") return "パスキーの操作が取り消されたか、時間切れになりました。";
  if (error?.name === "SecurityError") return "このアドレスではパスキーを使えません。https://suelira.com/chat/ を開いてください。";
  if (error?.name === "InvalidStateError") return "この端末には、もうこのサイトのパスキーがあります。「パスキーでログイン」をお使いください。";
  if (!(error instanceof RelayError)) return "パスキーを使えませんでした。もう一度お試しください。";
  switch (error.code) {
    case "network": return "中継サーバーに接続できません。インターネット接続を確かめてください。";
    case "invalid_code": return "招待コードが無効です。使用済みか、72 時間を過ぎています。新しい招待をもらってください。";
    case "too_many_attempts": return "試した回数が多すぎます。1 時間ほど待ってからお試しください。";
    case "unknown_passkey": return "このパスキーの登録は削除されています。招待コードでもう一度登録してください。";
    case "revoked": return "開発者がこのアカウントの利用を止めています。";
    case "passkey_rejected": return "パスキーを確かめられませんでした。もう一度お試しください。";
    case "expired_challenge": return "時間がかかりすぎました。もう一度お試しください。";
    case "busy": return "混み合っています。少し待ってからお試しください。";
    case "web_not_configured": return "中継サーバーで Web 版がまだ有効になっていません（WEB_ORIGINS と WEB_RP_ID）。";
    case "forbidden_origin": return "このアドレスからは使えません。https://suelira.com/chat/ を開いてください。";
    case "unauthorized": return "管理キーが違います。Cloudflare の ADMIN_TOKEN と同じものを入れてください。";
    case "admin_not_configured": return "中継サーバーに管理キー（ADMIN_TOKEN、32 文字以上）が設定されていません。";
    default: return `中継サーバーから予期しない応答がありました（${error.status}）。`;
  }
}

// MARK: Sign in

function showLogin(panel = "main", message = "") {
  $("chat").hidden = true;
  $("login").hidden = false;
  for (const id of ["login-main", "login-invite", "login-setup"]) $(id).hidden = id !== `login-${panel}`;
  const error = $("login-error");
  error.textContent = message;
  error.hidden = !message;
  if (!passkeysSupported()) {
    error.textContent = "このブラウザはパスキーに対応していません。iPhone の Safari か、新しい Chrome・Edge・Safari でお試しください。";
    error.hidden = false;
  }
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

async function signInWithPasskey() {
  const options = await callJSON("/web/passkey/login/options", { method: "POST", body: {}, token: "" });
  const credential = await usePasskey(options.publicKey);
  try {
    return await callJSON("/web/passkey/login/verify", { method: "POST", body: { challengeId: options.challengeId, credential }, token: "" });
  } catch (error) {
    if (error instanceof RelayError && error.code === "unknown_passkey" && error.body.credentialId) {
      await forgetPasskey(options.publicKey.rpId, error.body.credentialId);
    }
    throw error;
  }
}

async function registerWithCode(code) {
  const options = await callJSON("/web/passkey/register/options", { method: "POST", body: { code }, token: "" });
  const credential = await createPasskey(options.publicKey);
  return callJSON("/web/passkey/register/verify", { method: "POST", body: { challengeId: options.challengeId, credential }, token: "" });
}

function wireLogin() {
  $("login-passkey").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true);
    try {
      session.set(await signInWithPasskey());
      await enterChat();
    } catch (error) {
      showLogin("main", loginErrorText(error));
    } finally {
      setBusy(button, false);
    }
  });
  $("show-invite").addEventListener("click", () => { showLogin("invite"); $("invite-code").focus(); });
  $("show-setup").addEventListener("click", () => showLogin("setup"));
  for (const back of document.querySelectorAll(".login .back")) back.addEventListener("click", () => showLogin("main"));

  $("invite-register").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const code = $("invite-code").value.trim();
    if (!code) { showLogin("invite", "招待コードを入れてください。"); return; }
    setBusy(button, true);
    try {
      session.set(await registerWithCode(code));
      $("invite-code").value = "";
      await enterChat();
      toast("登録しました。次からはパスキーでログインできます。");
    } catch (error) {
      showLogin("invite", loginErrorText(error));
    } finally {
      setBusy(button, false);
    }
  });

  $("make-admin-key").addEventListener("click", async () => {
    const key = newAdminKey();
    const output = $("made-admin-key");
    output.textContent = key;
    output.hidden = false;
    toast((await copyText(key)) ? "管理キーをコピーしました" : "管理キーを選んでコピーしてください");
  });

  $("setup-register").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const field = $("setup-admin-key");
    // The admin key is read once and leaves the field at once; it is never stored.
    const adminKey = field.value.trim();
    field.value = "";
    const name = $("setup-name").value.trim() || "開発者";
    if (adminKey.length < 32) { showLogin("setup", "管理キー（32 文字以上）を入れてください。"); return; }
    setBusy(button, true);
    try {
      const made = await callJSON("/admin/invites", { method: "POST", body: { name, role: "developer" }, token: adminKey });
      session.set(await registerWithCode(made.code));
      $("made-admin-key").hidden = true;
      $("made-admin-key").textContent = "";
      await enterChat();
      toast("開発者として登録しました。次からはパスキーでログインできます。");
    } catch (error) {
      showLogin("setup", loginErrorText(error));
    } finally {
      setBusy(button, false);
    }
  });
}

/** `#invite=CODE` in the address (an invite link): the code is put in its field and leaves the address. */
function readInviteLink() {
  const match = /^#invite=([A-Za-z0-9-]{8,40})$/.exec(location.hash);
  if (!match) return false;
  history.replaceState(null, "", location.pathname + location.search);
  $("invite-code").value = match[1];
  return true;
}

// MARK: The chat

async function enterChat() {
  await refreshStatus();
  if (!session.get()) return;
  $("login").hidden = true;
  $("chat").hidden = false;
  renderTopbar();
  renderThread();
  updateComposer();
  loadMath();
  if (!matchMedia("(pointer: coarse)").matches) $("input").focus();
}

async function refreshStatus() {
  try {
    state.status = await callJSON("/v1/status");
  } catch (error) {
    if (error instanceof RelayError && (error.status === 401 || error.code === "revoked")) {
      session.clear();
      showLogin("main", errorText(error.status, error.code));
      return;
    }
    // Offline or the relay unreachable: the chat stays, with a banner.
    state.status = state.status ?? null;
    showBanner(errorText(error.status ?? 0, error.code ?? "network"), true);
    return;
  }
  renderTopbar();
  renderCredit();
  updateBanner();
}

function catalog() {
  const models = state.status?.models;
  return Array.isArray(models) && models.length ? models : BUILT_IN;
}

function usable(model) {
  return model.available !== false && model.efforts.length > 0;
}

/** The model and level the next question goes with. */
function choice() {
  const list = catalog();
  const model = list.find((m) => m.id === state.prefs.model && usable(m)) ?? list.find(usable) ?? list[0];
  const saved = state.prefs.efforts[model.id];
  const preferred = startEffort(model);
  const effort = model.efforts.includes(saved) ? saved : model.efforts.includes(preferred) ? preferred : model.efforts[0] ?? "medium";
  return { model, effort };
}

function modelName(id) {
  return catalog().find((m) => m.id === id)?.name ?? id ?? "Claude";
}

function renderTopbar() {
  const { model, effort } = choice();
  $("model-name").textContent = model.name;
  $("model-sub").textContent = `推論 ${EFFORT[effort]?.title ?? effort} · 外部AI`;
  $("model-button").setAttribute("aria-label", `${model.name}、推論レベル${EFFORT[effort]?.title ?? effort}、外部AI。モデルと推論レベルを変える`);
  $("empty-line").textContent = "メッセージは Anthropic の Claude に送られます。";
}

function showBanner(text, warn = false) {
  const banner = $("banner");
  banner.textContent = text;
  banner.classList.toggle("warn", warn);
  banner.hidden = !text;
}

function updateBanner() {
  if (!navigator.onLine) { showBanner("インターネットに接続されていません。", true); return; }
  const status = state.status;
  if (status && !status.available) {
    const extra = status.role === "developer" && (status.reason === "paused_billing" || status.reason === "paused_limit") ? " 設定から再開できます。" : "";
    showBanner((REASONS[status.reason] ?? REASONS.not_configured) + extra, true);
    return;
  }
  showBanner("");
}

// MARK: Messages

function renderThread() {
  const holder = $("messages");
  holder.replaceChildren();
  state.views.clear();
  for (const message of state.chat.messages) holder.append(messageElement(message));
  $("empty").hidden = state.chat.messages.length > 0;
  requestAnimationFrame(() => scrollToEnd(false));
}

function messageElement(message) {
  if (message.role === "user") return sentElement(message);
  const reply = h("div", { class: "reply" });
  const element = h("div", { class: "msg assistant" }, reply);
  const view = new ReplyView(reply);
  state.views.set(message, { element, reply, view });
  if (message.text) view.update(message.text, { live: false, animate: false });
  finishElement(message);
  return element;
}

// MARK: Attachments, as the iPhone app shows them

const ICONS = {
  plus: ["M12 5.5v13M5.5 12h13"],
  photo: ["M6 5.5h12a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16V8A2.5 2.5 0 0 1 6 5.5Z", "m4 16.5 4.5-4.5 3.5 3.5 2.5-2.5 5.5 5.5", "M15.5 9.5h.01"],
  video: ["M5.5 6.5h8a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 15V9a2.5 2.5 0 0 1 2.5-2.5Z", "m16 10.5 5-3v9l-5-3"],
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"],
  doc: ["M7 3.5h6.5L18 8v12.5H7Z", "M13.5 3.5V8H18", "M9.5 12.5h6M9.5 16h4"],
  play: ["M9 6.8v10.4l8.2-5.2Z"],
  xmark: ["M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"],
};

function icon(name, cls = "icon") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** The app's xmark.circle.fill: a white cross on a gray disc. */
function removeMark() {
  const svg = icon("xmark", "remove-mark");
  const disc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  disc.setAttribute("cx", "12");
  disc.setAttribute("cy", "12");
  disc.setAttribute("r", "10");
  svg.prepend(disc);
  return svg;
}

const fileIcon = (attachment) => (attachment.kind === "image" ? "photo" : attachment.kind === "video" ? "video" : "doc");
const showsAsPicture = (attachment) => (attachment.kind === "image" || attachment.kind === "video") && !!attachment.thumb;

/** A sent photo's box: its own shape within 220 × 260, never thinner than 72 (the app's SentPhoto). */
function pictureBox(attachment) {
  const { width, height } = attachment;
  if (!width || !height) return { width: 200, height: 200 };
  const scale = Math.min(220 / width, 260 / height);
  return { width: Math.max(72, Math.round(width * scale)), height: Math.max(72, Math.round(height * scale)) };
}

function pictureElement(attachment) {
  const box = pictureBox(attachment);
  const figure = h("button", {
    type: "button", class: `sent-picture${attachment.kind === "video" ? " video" : ""}`,
    "aria-label": `${attachment.kind === "video" ? "動画" : "写真"}を開く: ${attachment.name}`,
    onclick: () => openViewer(attachment),
  }, h("img", { src: attachment.thumb, alt: "", width: String(box.width), height: String(box.height), draggable: "false" }));
  figure.style.width = `${box.width}px`;
  figure.style.height = `${box.height}px`;
  if (attachment.kind === "video") {
    figure.append(h("span", { class: "play" }, icon("play")));
    if (attachment.duration) figure.append(h("span", { class: "duration", text: timeLabel(attachment.duration) }));
  }
  return figure;
}

function fileMeta(attachment) {
  const kind = attachment.kind === "pdf" ? "PDF" : attachment.kind === "text" ? "テキスト" : attachment.kind === "video" ? "動画" : "写真";
  return attachment.size ? `${kind} · ${sizeLabel(attachment.size)}` : kind;
}

function fileChip(attachment) {
  return h("div", { class: "file-chip" }, icon(fileIcon(attachment)),
    h("span", { class: "file-text" }, h("span", { class: "file-name", text: attachment.name }), h("span", { class: "file-meta", text: fileMeta(attachment) })));
}

/** The person's message: photos and videos on their own above the bubble, files inside it with the text. */
function sentElement(message) {
  const column = h("div", { class: "sent" });
  const attachments = message.attachments ?? [];
  for (const attachment of attachments.filter(showsAsPicture)) {
    column.append(pictureElement(attachment));
    if (attachment.note) column.append(h("p", { class: "sent-note", text: attachment.note }));
  }
  const files = attachments.filter((attachment) => !showsAsPicture(attachment));
  if (files.length || message.text) {
    const bubble = h("div", { class: "bubble" });
    if (files.length) bubble.append(h("div", { class: "bubble-files" }, files.map(fileChip)));
    if (message.text) bubble.append(h("div", { class: "bubble-text", text: message.text }));
    column.append(bubble);
  }
  return h("div", { class: "msg user" }, column);
}

/** A photo at its sent size, or a video while this page still holds it. */
function openViewer(attachment) {
  const body = $("viewer-body");
  if (attachment.kind === "video" && attachment.play) {
    body.replaceChildren(h("video", { src: attachment.play, controls: true, playsinline: true, autoplay: true }));
  } else {
    const data = attachment.kind === "image" ? attachment.parts?.[0]?.data : null;
    body.replaceChildren(h("img", { src: data ? `data:image/jpeg;base64,${data}` : attachment.thumb, alt: attachment.name }));
  }
  $("viewer-title").textContent = attachment.name;
  $("viewer").showModal();
}

/** What one request may carry as base64, as the relay says; 0 when it does not say (an older relay). */
function attachChars() {
  const most = state.status?.attachments?.bytes;
  return Number.isFinite(most) && most > 0 ? Math.floor((most * 4) / 3) : 0;
}

function draftProblem(attachment, maxChars) {
  const sum = (key) => state.draft.reduce((total, item) => total + item[key], attachment[key]);
  const parts = state.draft.reduce((total, item) => total + item.parts.length, attachment.parts.length);
  if (sum("chars") > maxChars) return `添付が大きすぎます。1 回に送れるのは合計 ${sizeLabel((maxChars * 3) / 4, true)} までです。`;
  if (parts > ATTACH.partsPerMessage || sum("images") > ATTACH.images) return "写真と動画の場面が多すぎます。分けて送ってください。";
  if (sum("documents") > ATTACH.documents) return `PDF とテキストは 1 回に ${ATTACH.documents} 個までです。`;
  if (sum("textBytes") > ATTACH.textBytes) return `テキストファイルは合計 ${sizeLabel(ATTACH.textBytes, true)} までです。`;
  return null;
}

let preparingQueue = Promise.resolve();
/** Counts new chats and sign-outs, so a file still being read then is dropped. */
let draftEpoch = 0;

/** Picked, pasted or dropped files into the draft: one at a time (a phone's memory), in the order picked. */
function addFiles(list) {
  const files = Array.from(list ?? []).filter((file) => file && file.size >= 0);
  if (!files.length) return preparingQueue;
  const maxChars = attachChars();
  if (!maxChars) { toast("中継サーバーが古いため、添付を送れません。"); return preparingQueue; }
  const room = ATTACH.perMessage - state.draft.length - state.preparing;
  if (room <= 0 || files.length > room) toast(`添付は 1 回に ${ATTACH.perMessage} 個までです。`);
  const picked = files.slice(0, Math.max(0, room));
  if (!picked.length) return preparingQueue;
  state.preparing += picked.length;
  renderTray();
  const epoch = draftEpoch;
  preparingQueue = preparingQueue.then(() => prepareAll(picked, maxChars, epoch));
  return preparingQueue;
}

async function prepareAll(picked, maxChars, epoch) {
  for (const file of picked) {
    try {
      // A new chat or a sign-out since the pick: nothing more is read.
      if (epoch !== draftEpoch) continue;
      const attachment = await prepare(file, maxChars);
      const problem = epoch !== draftEpoch ? "" : draftProblem(attachment, maxChars);
      if (problem !== null) { release(attachment); if (problem) toast(problem); } else state.draft.push(attachment);
    } catch (error) {
      toast(error instanceof AttachError ? error.message : "添付を読み込めませんでした。");
    } finally {
      state.preparing--;
      renderTray();
    }
  }
}

function clearDraft() {
  draftEpoch++;
  state.draft.forEach(release);
  state.draft = [];
  renderTray();
}

function removeFromDraft(attachment) {
  state.draft = state.draft.filter((item) => item !== attachment);
  release(attachment);
  renderTray();
  if (!matchMedia("(pointer: coarse)").matches) $("input").focus();
}

/** The draft's attachments above the bar, each with its ×, as in the app. */
const trayItems = new WeakMap();

function renderTray() {
  const tray = $("tray");
  // Items already shown stay where they are (not put in again), so only a new one comes in.
  const wanted = state.draft.map((attachment) => {
    if (trayItems.has(attachment)) return trayItems.get(attachment);
    const item = h("div", { class: `tray-item${showsAsPicture(attachment) ? " picture" : " file"}` });
    trayItems.set(attachment, item);
    if (showsAsPicture(attachment)) {
      item.append(h("img", { src: attachment.thumb, alt: "", draggable: "false" }));
      if (attachment.kind === "video") item.append(h("span", { class: "play small" }, icon("play")));
    } else {
      item.append(icon(fileIcon(attachment)), h("span", { class: "tray-name", text: attachment.name }));
    }
    item.setAttribute("title", attachment.name);
    item.append(h("button", { type: "button", class: "tray-remove", "aria-label": `添付を外す: ${attachment.name}`, onclick: () => removeFromDraft(attachment) }, removeMark()));
    return item;
  });
  for (const child of [...tray.children]) if (!wanted.includes(child)) child.remove();
  wanted.forEach((item, index) => { if (tray.children[index] !== item) tray.insertBefore(item, tray.children[index] ?? null); });
  tray.hidden = state.draft.length === 0;
  tray.parentElement.classList.toggle("has-tray", !tray.hidden);
  $("tray-status").hidden = state.preparing === 0;
  updateComposer();
}

function wireAttachments() {
  const menu = $("attach-menu");
  const button = $("attach");
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    if (!menu.hidden) { close(); return; }
    const full = state.draft.length + state.preparing >= ATTACH.perMessage;
    for (const item of menu.querySelectorAll("[data-pick]")) item.disabled = !!state.streaming || state.preparing > 0 || full;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("[data-pick]:not(:disabled)")?.focus({ preventScroll: true });
  });
  for (const item of menu.querySelectorAll("[data-pick]")) {
    const input = $(`pick-${item.dataset.pick}`);
    input.accept = ACCEPT[item.dataset.pick];
    item.addEventListener("click", () => { close(); input.click(); });
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.value = "";
      addFiles(files);
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) { close(); button.focus(); }
  });
  // A pasted screenshot or file; text pastes as text.
  $("input").addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(files);
  });
  // Files dropped anywhere on the chat.
  const chat = $("chat");
  let depth = 0;
  const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  chat.addEventListener("dragenter", (event) => { if (carriesFiles(event)) { depth++; chat.classList.add("dropping"); } });
  chat.addEventListener("dragleave", (event) => { if (carriesFiles(event) && --depth <= 0) { depth = 0; chat.classList.remove("dropping"); } });
  chat.addEventListener("dragover", (event) => { if (carriesFiles(event)) event.preventDefault(); });
  chat.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    chat.classList.remove("dropping");
    addFiles(event.dataTransfer.files);
  });
  $("viewer").addEventListener("close", () => $("viewer-body").replaceChildren());
}

function captionFor(message) {
  const parts = [`${modelName(message.model)} · 推論 ${EFFORT[message.effort]?.title ?? message.effort}`];
  if (message.served && message.served !== message.model && !message.served.startsWith(message.model)) parts.push(`${modelName(message.served)} が答えました`);
  if (message.end === "stopped") parts.push("停止しました");
  const caption = h("div", { class: "caption" }, h("span", { text: parts.join(" · ") }));
  if (message.text) {
    caption.append(h("button", {
      type: "button", class: "text", text: "返信をコピー",
      onclick: async (event) => {
        const button = event.currentTarget;
        button.textContent = (await copyText(message.text)) ? "コピーしました" : "コピーできません";
        setTimeout(() => { button.textContent = "返信をコピー"; }, 1600);
      },
    }));
  }
  return caption;
}

const END_NOTICES = {
  refused: "Claude はこの質問への回答を控えました。",
  cutOff: "返信が長さの上限に達したため、ここで終わっています。",
};

/** The lines under a finished reply: which model answered, and what stopped it. */
function finishElement(message) {
  const entry = state.views.get(message);
  if (!entry) return;
  entry.element.querySelector(".thinking")?.remove();
  entry.element.querySelector(".caption")?.remove();
  entry.element.querySelector(".notice")?.remove();
  entry.reply.removeAttribute("aria-busy");
  if (message.end === "streaming") return;
  const text = message.error ?? END_NOTICES[message.end];
  if (text) {
    const notice = h("div", { class: `notice${message.error ? " error" : ""}`, role: message.error ? "alert" : null }, h("div", { text }));
    if (message.error && message.end === "failed" && isLast(message)) {
      notice.append(h("div", { class: "actions" }, h("button", { type: "button", class: "secondary", text: "もう一度送る", onclick: () => retry(message) })));
    }
    entry.element.append(notice);
  }
  if (message.text || message.end === "stopped") entry.element.append(captionFor(message));
}

function isLast(message) {
  const list = state.chat.messages;
  return list[list.length - 1] === message;
}

/**
 * The conversation as the relay takes it: user and assistant in turn, the
 * user's last. Attachments go newest first, as far as one request may
 * carry; older ones (or ones this page no longer holds) are named instead.
 */
function contextTurns(messages, maxChars = attachChars()) {
  const turns = [];
  for (const message of messages) {
    const text = message.text ?? "";
    if (message.role === "user") {
      const last = turns[turns.length - 1];
      if (last?.role === "user") {
        last.content = last.content && text ? `${last.content}\n\n${text}` : last.content || text;
        last.files.push(...(message.attachments ?? []));
      } else {
        turns.push({ role: "user", content: text, files: [...(message.attachments ?? [])] });
      }
    } else if (text.trim() && turns[turns.length - 1]?.role === "user") {
      turns.push({ role: "assistant", content: text });
    }
  }
  while (turns.length && turns[turns.length - 1].role !== "user") turns.pop();
  const total = () => turns.reduce((sum, turn) => sum + bytes(turn.content), 0);
  while (turns.length > 1 && (turns.length > MAX_TURNS || total() > MAX_TOTAL_BYTES)) turns.splice(0, 2);
  const used = { chars: 0, images: 0, documents: 0, textBytes: 0 };
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.role !== "user") continue;
    const files = turn.files;
    delete turn.files;
    const sent = [];
    const left = [];
    for (const file of files) {
      const fits = !!file.parts && used.chars + file.chars <= maxChars && used.images + file.images <= ATTACH.images &&
        used.documents + file.documents <= ATTACH.documents && used.textBytes + file.textBytes <= ATTACH.textBytes &&
        sent.length + file.parts.length <= ATTACH.partsPerMessage;
      if (!fits) { left.push(file); continue; }
      for (const key of Object.keys(used)) used[key] += file[key];
      sent.push(...file.parts);
    }
    if (sent.length) turn.attachments = sent;
    if (left.length) {
      const note = `（前に添付した${left.map((file) => `「${file.name}」`).join("")}は、今回は送っていません）`;
      turn.content = turn.content ? `${turn.content}\n\n${note}` : note;
    }
  }
  return turns;
}

// MARK: Sending

function updateComposer() {
  const input = $("input");
  const send = $("send");
  const streaming = !!state.streaming;
  $("composer").classList.toggle("streaming", streaming);
  send.setAttribute("aria-label", streaming ? "停止" : "送信");
  const blocked = state.status && !state.status.available;
  send.disabled = streaming ? false : (!input.value.trim() && !state.draft.length) || state.preparing > 0 || blocked;
}

function autoGrow() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}

async function sendFromComposer() {
  if (state.streaming) { stop(); return; }
  const input = $("input");
  const text = input.value.trim();
  if (!text && !state.draft.length) return;
  if (state.preparing) { toast("添付の読み込みが終わるまでお待ちください。"); return; }
  if (bytes(text) > MAX_TURN_BYTES) { toast("メッセージが長すぎます。分けて送ってください。"); return; }
  if (state.status && !state.status.available) { updateBanner(); return; }
  input.value = "";
  autoGrow();
  const message = { role: "user", text };
  if (state.draft.length) {
    message.attachments = state.draft;
    state.draft = [];
    renderTray();
  }
  state.chat.messages.push(message);
  $("messages").append(messageElement(message));
  $("empty").hidden = true;
  saveChat();
  await ask();
}

async function retry(failed) {
  if (state.streaming) return;
  const index = state.chat.messages.indexOf(failed);
  if (index < 0) return;
  state.chat.messages.splice(index, 1);
  state.views.get(failed)?.element.remove();
  state.views.delete(failed);
  saveChat();
  await ask();
}

function stop() {
  state.streaming?.controller.abort();
}

/** Asks Claude about the conversation so far and lays its reply out as it comes. */
async function ask() {
  const { model, effort } = choice();
  const turns = contextTurns(state.chat.messages);
  if (!turns.length) return;
  if (turns.some((turn) => bytes(turn.content) > MAX_TURN_BYTES)) { toast("メッセージが長すぎます。新しい会話でお試しください。"); return; }
  const message = { role: "assistant", text: "", model: model.id, effort, end: "streaming" };
  state.chat.messages.push(message);
  const element = messageElement(message);
  const entry = state.views.get(message);
  entry.reply.setAttribute("aria-busy", "true");
  const thinking = h("div", { class: "thinking" }, h("span", { class: "glow", "aria-hidden": "true" }), h("span", { class: "label", text: "" }));
  element.append(thinking);
  $("messages").append(element);
  scrollToEnd(true);

  const controller = new AbortController();
  const pacer = new Pacer();
  const run = { controller, message, pacer, shownAt: 0, rendered: -1, lastRender: 0, ended: false, frame: 0 };
  state.streaming = run;
  updateComposer();

  const render = (force = false) => {
    const now = performance.now();
    const shown = pacer.advance(now / 1000);
    // About 24 steps a second, fewer as a reply grows very long (the app's ReplyPacer.interval).
    const interval = 1000 / 24 + Math.min(pacer.text.length / 16000, 1) * (100 - 1000 / 24);
    if (shown !== run.rendered && (force || now - run.lastRender >= interval || pacer.finished)) {
      const wasPinned = isPinned();
      entry.view.update(pacer.text.slice(0, shown), { live: !pacer.finished, animate: true });
      run.rendered = shown;
      run.lastRender = now;
      if (shown > 0 && thinking.isConnected) thinking.remove();
      if (wasPinned) scrollToEnd(false);
    }
    if (run.ended && pacer.finished) { finish(); return; }
    run.frame = requestAnimationFrame(() => render());
  };

  const finish = () => {
    if (run.finished) return;
    run.finished = true;
    cancelAnimationFrame(run.frame);
    // The last chunk drawn once more as finished text (unchanged chunks stay as they are).
    pacer.shown = pacer.text.length;
    entry.view.update(pacer.text, { live: false, animate: true });
    message.text = pacer.text;
    if (message.end === "streaming") message.end = "done";
    state.streaming = null;
    finishElement(message);
    saveChat();
    updateComposer();
    if (isPinned(160)) scrollToEnd(false);
    refreshStatus();
  };

  const fail = (text, end = "failed") => {
    message.error = text;
    message.end = end;
  };

  let response;
  try {
    response = await call("/v1/messages", { method: "POST", body: { messages: turns, model: model.id, effort }, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") message.end = "stopped";
    else fail(errorText(0, "network"));
    run.ended = true;
    pacer.generating = false;
    finish();
    return;
  }
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (response.status === 401) {
      // The session lapsed: the question goes back into the composer for after the next sign-in.
      state.chat.messages.pop();
      element.remove();
      state.views.delete(message);
      const last = state.chat.messages[state.chat.messages.length - 1];
      if (last?.role === "user") {
        state.chat.messages.pop();
        const shown = $("messages").lastElementChild;
        if (shown?.classList.contains("user")) shown.remove();
        $("input").value = last.text;
        if (last.attachments?.length) {
          state.draft = last.attachments.filter((attachment) => attachment.parts);
          renderTray();
        }
      }
      state.streaming = null;
      updateComposer();
      saveChat();
      session.clear();
      showLogin("main", errorText(401, "unauthorized"));
      return;
    }
    fail(errorText(response.status, body.error, body));
    run.ended = true;
    pacer.generating = false;
    finish();
    if (body.error === "unavailable") refreshStatus();
    return;
  }

  run.frame = requestAnimationFrame(() => render());
  let sawDone = false;
  try {
    for await (const event of readEvents(response.body)) {
      if (event.type === "started") message.served = event.model;
      else if (event.type === "thinking") {
        const label = thinking.querySelector(".label");
        if (label && !label.textContent) label.textContent = "考えています";
      } else if (event.type === "text") pacer.text += event.text;
      else if (event.type === "refused") message.end = "refused";
      else if (event.type === "cutOff") message.end = "cutOff";
      else if (event.type === "failed") {
        fail(event.error === "overloaded_error"
          ? "Claude が混み合っているため、返信が途中で止まりました。ここまでの返信は残しています。"
          : "Claude との接続が切れました。ここまでの返信は残しています。");
      } else if (event.type === "done") { sawDone = true; break; }
    }
    if (!sawDone && !message.error && message.end === "streaming") fail("Claude との接続が切れました。ここまでの返信は残しています。");
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      message.end = "stopped";
    } else if (!message.error) {
      fail("Claude との接続が切れました。ここまでの返信は残しています。");
    }
  }
  if (controller.signal.aborted && message.end === "streaming") message.end = "stopped";
  pacer.generating = false;
  run.ended = true;
  // Stopped: what has come shows at once, nothing more is laid out.
  if (message.end === "stopped" || document.hidden) pacer.shown = pacer.text.length;
  if (document.hidden) finish();
}

// MARK: Scrolling

function isPinned(slack = 80) {
  const scroller = $("scroller");
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < slack;
}

function scrollToEnd(smooth) {
  const scroller = $("scroller");
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
}

function wireScroller() {
  const scroller = $("scroller");
  const update = () => {
    $("chat").classList.toggle("scrolled", scroller.scrollTop > 4);
    $("jump").hidden = isPinned(200);
  };
  scroller.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe($("messages"));
  $("jump").addEventListener("click", () => scrollToEnd(true));
}

/** iPhone Safari's keyboard: the chat follows the visible area, so the composer stays above it. */
function wireViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const chat = $("chat");
  const update = () => {
    const keyboard = window.innerHeight - viewport.height > 120;
    chat.classList.toggle("keyboard", keyboard);
    if (keyboard) {
      chat.style.height = `${viewport.height}px`;
      chat.style.transform = `translateY(${viewport.offsetTop}px)`;
    } else {
      chat.style.height = "";
      chat.style.transform = "";
    }
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
}

// MARK: The model sheet

function renderModelSheet() {
  const { model: current, effort: currentEffort } = choice();
  const list = $("model-list");
  list.replaceChildren(...catalog().map((model) => {
    const level = model.id === current.id ? currentEffort
      : (model.efforts.includes(state.prefs.efforts[model.id]) ? state.prefs.efforts[model.id] : startEffort(model));
    const top = model.id === TOP.model && level === TOP.effort;
    const sub = model.available === false ? "今は Anthropic で使えません"
      : model.available === null ? `推論レベル ${EFFORT[level]?.title ?? level}${top ? " · Fieluaの最上級" : ""} · 使えるか確かめられていません`
        : `推論レベル ${EFFORT[level]?.title ?? level}${top ? " · Fieluaの最上級" : ""}`;
    return h("button", {
      type: "button", class: "choice", role: "radio", "aria-checked": model.id === current.id ? "true" : "false",
      disabled: !usable(model),
      onclick: () => { state.prefs.model = model.id; savePrefs(); renderModelSheet(); renderTopbar(); },
    }, h("span", { class: "body" }, h("span", { class: "title" }, model.name), h("span", { class: "sub", text: sub })), h("span", { class: "check", "aria-hidden": "true" }));
  }));
  const efforts = $("effort-list");
  efforts.replaceChildren(...EFFORTS.map((level) => {
    const offered = current.efforts.includes(level);
    const title = h("span", { class: "title" }, EFFORT[level].title,
      startEffort(current) === level ? h("span", { class: "tag", text: "標準" }) : null,
      current.id === TOP.model && level === TOP.effort ? h("span", { class: "tag top", text: "Fieluaの最上級" }) : null);
    return h("button", {
      type: "button", class: "choice", role: "radio", "aria-checked": level === currentEffort ? "true" : "false",
      disabled: !offered,
      onclick: () => { state.prefs.efforts[current.id] = level; savePrefs(); renderModelSheet(); renderTopbar(); },
    }, h("span", { class: "body" }, title, h("span", { class: "sub", text: offered ? EFFORT[level].help : "このモデルでは使えません" })), h("span", { class: "check", "aria-hidden": "true" }));
  }));
}

// MARK: The credit left

const RING = 2 * Math.PI * 15;

function renderCredit() {
  const credit = state.status?.credit;
  const button = $("credit");
  const composer = $("composer");
  if (!credit) {
    button.hidden = true;
    composer.classList.remove("has-credit");
    return;
  }
  const percent = Math.max(0, Math.min(100, credit.percent));
  button.hidden = false;
  composer.classList.add("has-credit");
  const arc = $("credit-arc");
  arc.style.strokeDasharray = `${RING}`;
  arc.style.strokeDashoffset = `${RING * (1 - percent / 100)}`;
  $("credit-text").textContent = `${Math.round(percent)}`;
  button.classList.toggle("low", percent < 15);
  button.setAttribute("aria-label", `クレジットの残り、推定 ${Math.round(percent)}%`);
}

function ring(percent, big) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("aria-hidden", "true");
  for (const cls of ["track", "arc"]) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("class", cls);
    circle.setAttribute("cx", "18");
    circle.setAttribute("cy", "18");
    circle.setAttribute("r", "15");
    svg.append(circle);
  }
  const arc = svg.lastChild;
  arc.style.strokeDasharray = `${RING}`;
  arc.style.strokeDashoffset = `${RING * (1 - percent / 100)}`;
  return h("div", { class: `credit-big${percent < 15 ? " low" : ""}` }, svg, h("div", { class: "num", text: `${Math.round(percent)}%` }), big);
}

function renderCreditSheet() {
  const body = $("credit-body");
  const credit = state.status?.credit;
  const developer = state.status?.role === "developer";
  const items = [];
  if (credit) {
    items.push(ring(credit.percent, h("div", { class: "muted", text: `残り 約 ${formatUSD(credit.remainingUSD)}（推定）` })));
    items.push(h("div", { class: "card" },
      h("p", { text: `${formatTime(credit.setAt)} に入力した残高 ${formatUSD(credit.budgetUSD)} から、それ以降に Fielua（このサイトと iPhone）の返信で使った分 ${formatUSD(credit.spentUSD)} を引いた推定です。` }),
      h("p", { class: "muted", text: "使った分は、返信ごとのトークン数と Anthropic の公開料金から計算しています。同じ Anthropic アカウントのほかの利用や、途中で止めた返信の細かい分は入らないため、Console の表示と少しずれることがあります。" }),
      state.status?.reason === "paused_billing" ? h("p", { text: "Anthropic がクレジット切れと答えたため、0% にしています。" }) : null));
  } else {
    items.push(h("div", { class: "card" }, h("p", { text: "残りのクレジットはまだ入力されていません。" })));
  }
  if (developer) items.push(creditControls(credit));
  body.replaceChildren(...items);
}

function creditControls(credit) {
  const amount = h("input", { type: "text", inputmode: "decimal", placeholder: "例：25.00", "aria-label": "Console に出ている残高（米ドル）" });
  const save = h("button", {
    type: "button", class: "secondary", text: "保存",
    onclick: async () => {
      const value = Number(amount.value.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(value) || value <= 0 || value > 100000) { toast("0 より大きい金額（米ドル）を入れてください"); return; }
      const done = await adminCall("/admin/settings", { method: "POST", body: { creditUSD: Math.round(value * 100) / 100 } });
      if (done) { await refreshStatus(); renderCreditSheet(); toast("残高を保存しました"); }
    },
  });
  const friends = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "友人にも残りを表示", checked: credit?.friends ? true : null });
  friends.addEventListener("change", async () => {
    const done = await adminCall("/admin/settings", { method: "POST", body: { creditFriends: friends.checked } });
    if (!done) friends.checked = !friends.checked;
  });
  return h("div", { class: "card" },
    h("p", { text: "Anthropic の Console（Billing）に出ている残高を入れると、そこから推定します。クレジットを足したときも、新しい残高を入れ直してください。" }),
    h("div", { class: "inline-field" }, amount, save),
    credit ? h("div", { class: "row-actions" }, h("button", {
      type: "button", class: "text danger", text: "推定をやめる",
      onclick: async () => {
        if (await adminCall("/admin/settings", { method: "POST", body: { creditUSD: null } })) { await refreshStatus(); renderCreditSheet(); }
      },
    })) : null,
    h("div", { class: "switch-row" }, h("span", { text: "友人にも残りを表示" }), friends));
}

// MARK: Settings

/** An admin request with the developer's session; a sign-in older than 15 minutes asks for the passkey again. */
async function adminCall(path, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callJSON(path, options);
    } catch (error) {
      if (error instanceof RelayError && error.code === "reauth_required" && attempt === 0) {
        const ok = await confirmDialog({ title: "パスキーで確認", body: ["管理の操作の前に、もう一度パスキーで確認します。"], ok: "確認する" });
        if (!ok) return null;
        try {
          const old = session.get()?.token;
          session.set(await signInWithPasskey());
          if (old) call("/web/logout", { method: "POST", body: {}, token: old }).catch(() => {});
          await refreshStatus();
        } catch (reauth) {
          toast(loginErrorText(reauth));
          return null;
        }
        continue;
      }
      toast(error instanceof RelayError ? adminErrorText(error) : "操作できませんでした");
      return null;
    }
  }
  return null;
}

function adminErrorText(error) {
  switch (error.code) {
    case "forbidden": return "開発者だけができる操作です。";
    case "reauth_required": return "もう一度パスキーで確認してください。";
    case "admin_not_configured": return "中継サーバーに管理キー（ADMIN_TOKEN）が設定されていません。";
    case "not_found": return "見つかりませんでした。ほかの画面で変わったかもしれません。";
    default: return errorText(error.status, error.code, error.body);
  }
}

async function renderSettings() {
  const body = $("settings-body");
  const status = state.status;
  const me = session.get();
  const items = [];
  items.push(h("p", { class: "section-label", text: "アカウント" }));
  items.push(h("div", { class: "card" },
    h("p", {}, h("strong", { text: status?.name ?? me?.name ?? "" }), `（${(status?.role ?? me?.role) === "developer" ? "開発者" : "友人"}）`),
    status?.web?.expiresAt ? h("p", { class: "muted", text: `このログインは ${formatTime(status.web.expiresAt)} まで使えます。` }) : null,
    h("div", { class: "row-actions" },
      h("button", { type: "button", class: "secondary", text: "ログアウト", onclick: logout }),
      h("button", { type: "button", class: "secondary danger", text: "登録を解除", onclick: leave }))));
  items.push(h("p", { class: "section-label", text: "送られる内容" }));
  items.push(h("div", { class: "card" },
    h("p", { text: "書いたメッセージと添付、この会話のこれまでのやり取りが、Fielua の中継サーバー（Cloudflare）を通って Anthropic に送られ、外部 AI の Claude が答えます。" }),
    h("p", { class: "muted", text: "写真は小さくし、位置情報などを消してから送ります。動画は音声を送らず、いくつかの場面の静止画にします。PDF とテキストはそのまま送ります。" }),
    h("p", { class: "muted", text: "中継サーバーは会話を保存しません。会話はこのタブの中だけにあり、タブを閉じるかログアウトすると消えます。Anthropic は API の利用データを Anthropic の方針に沿って一定期間保持します。答えには誤りが含まれることがあります。" })));
  if ((status?.role ?? me?.role) === "developer") items.push(...await developerSection());
  body.replaceChildren(...items);
}

async function developerSection() {
  const section = [h("p", { class: "section-label", text: "開発者" })];
  const adminState = await adminCall("/admin/state");
  state.adminState = adminState;
  if (!adminState) {
    section.push(h("div", { class: "card" }, h("p", { text: "管理の画面を開けませんでした。" }),
      h("div", { class: "row-actions" }, h("button", { type: "button", class: "secondary", text: "もう一度", onclick: renderSettings }))));
    return section;
  }
  const { settings, users, invites } = adminState;
  // Claude's state, and resuming after the credit was topped up.
  const paused = settings.paused;
  section.push(h("div", { class: "card" },
    h("p", { text: !adminState.configured ? REASONS.not_configured : paused ? (paused === "billing" ? "クレジット切れで停止中です。" : "利用上限で停止中です。") : "Claude は使える状態です。" }),
    paused ? h("p", { class: "muted", text: "Anthropic の Console でクレジットや上限を確かめてから再開してください。このサイトから購入や自動チャージはしません。" }) : null,
    paused ? h("div", { class: "row-actions" }, h("button", {
      type: "button", class: "secondary", text: "再開する",
      onclick: async () => { if (await adminCall("/admin/settings", { method: "POST", body: { resume: true } })) { await refreshStatus(); renderSettings(); } },
    })) : null));
  // The credit left.
  section.push(h("div", { class: "card" },
    h("p", { text: adminState.credit ? `クレジットの残り：推定 ${Math.round(adminState.credit.percent)}%（約 ${formatUSD(adminState.credit.remainingUSD)}）` : "クレジットの残りは未入力です。" }),
    h("div", { class: "row-actions" }, h("button", { type: "button", class: "secondary", text: "残高を入力・変更", onclick: () => { $("settings-sheet").close(); openSheet("credit-sheet"); } }))));
  // Friends.
  const friendsSwitch = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "友人の利用", checked: settings.friendsEnabled ? true : null });
  friendsSwitch.addEventListener("change", async () => {
    if (friendsSwitch.checked) {
      const ok = await confirmDialog({
        title: "友人の利用をオンにする",
        body: ["友人の質問にも、開発者の Anthropic API キーとクレジットが使われます。", "オンにする前に、Anthropic の商用利用規約と利用ポリシー（AI であることの明示、18 歳未満への提供など）を確かめてください。"],
        ok: "オンにする",
        check: "Anthropic の規約と利用ポリシーを確かめました",
      });
      if (!ok) { friendsSwitch.checked = false; return; }
    }
    const done = await adminCall("/admin/settings", { method: "POST", body: { friendsEnabled: friendsSwitch.checked } });
    if (!done) friendsSwitch.checked = !friendsSwitch.checked;
    await refreshStatus();
  });
  section.push(h("div", { class: "card" },
    h("div", { class: "switch-row" }, h("span", { text: "友人の利用" }), friendsSwitch),
    h("p", { class: "muted", text: "Anthropic の規約を確かめるまでオフのままにしてください。オフの間、友人はログインできても Claude には送れません。" })));
  // Invites.
  const name = h("input", { type: "text", maxlength: "40", placeholder: "招待する人の名前", "aria-label": "招待する人の名前" });
  const role = h("select", { "aria-label": "役割", class: "role-select" }, h("option", { value: "friend", text: "友人" }), h("option", { value: "developer", text: "開発者" }));
  const made = h("div");
  section.push(h("div", { class: "card" },
    h("p", { text: "招待コードは 72 時間・一度だけ使えます。本人だけに直接渡してください。" }),
    h("div", { class: "inline-field" }, name, role, h("button", {
      type: "button", class: "secondary", text: "作る",
      onclick: async () => {
        if (!name.value.trim()) { toast("名前を入れてください"); return; }
        const result = await adminCall("/admin/invites", { method: "POST", body: { name: name.value.trim(), role: role.value } });
        if (!result) return;
        name.value = "";
        const link = `${location.origin}${location.pathname}#invite=${result.code}`;
        made.replaceChildren(
          h("div", { class: "link-out", text: result.code }),
          h("div", { class: "link-out", text: link }),
          h("div", { class: "row-actions" },
            h("button", { type: "button", class: "secondary", text: "コードをコピー", onclick: async () => toast((await copyText(result.code)) ? "コピーしました" : "コピーできません") }),
            h("button", { type: "button", class: "secondary", text: "リンクをコピー", onclick: async () => toast((await copyText(link)) ? "コピーしました" : "コピーできません") })));
      },
    })),
    made,
    invites.length ? h("div", { class: "people" }, invites.map((invite) => h("div", { class: "person" },
      h("span", { class: "name", text: `${invite.name}（${invite.role === "developer" ? "開発者" : "友人"}）` }),
      h("span", { class: "meta", text: `未使用 · ${formatTime(invite.expiresAt)} まで` }),
      h("div", { class: "row-actions" }, h("button", {
        type: "button", class: "text danger", text: "取り消す",
        onclick: async () => { if (await adminCall(`/admin/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" })) renderSettings(); },
      }))))) : null));
  // People.
  section.push(h("p", { class: "section-label", text: "登録している人" }));
  section.push(h("div", { class: "card" }, h("div", { class: "people" }, users.map((user) => h("div", { class: "person" },
    h("span", { class: "name", text: `${user.name}（${user.role === "developer" ? "開発者" : "友人"}）` }),
    h("span", { class: "meta", text: `${user.kind === "web" ? "Web（パスキー）" : "iPhone"} · ${user.status === "active" ? "利用中" : "停止中"}${user.lastUsedAt ? ` · 最後に使った日時 ${formatTime(user.lastUsedAt)}` : ""}` }),
    h("div", { class: "row-actions" },
      h("button", {
        type: "button", class: "secondary", text: user.status === "active" ? "止める" : "再開する",
        onclick: async () => { if (await adminCall(`/admin/users/${encodeURIComponent(user.id)}/${user.status === "active" ? "revoke" : "restore"}`, { method: "POST", body: {} })) renderSettings(); },
      }),
      h("button", {
        type: "button", class: "secondary danger", text: "削除",
        onclick: async () => {
          const ok = await confirmDialog({ title: `${user.name} を削除`, body: ["この人の登録、パスキー、ログインがすべて消え、もう使えなくなります。使うには新しい招待が必要です。"], ok: "削除", danger: true });
          if (ok && await adminCall(`/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" })) renderSettings();
        },
      })))))));
  return section;
}

async function logout() {
  stop();
  const token = session.get()?.token;
  session.clear();
  forgetChat();
  clearDraft();
  if (token) call("/web/logout", { method: "POST", body: {}, token }).catch(() => {});
  closeSheets();
  showLogin("main", "ログアウトしました。");
}

async function leave() {
  const ok = await confirmDialog({
    title: "登録を解除",
    body: ["あなたの登録とパスキーの記録が中継サーバーから消え、このアカウントは使えなくなります。もう一度使うには新しい招待が必要です。", "端末に残ったパスキーは、端末の設定（パスワード）から削除できます。"],
    ok: "登録を解除", danger: true,
  });
  if (!ok) return;
  try {
    await callJSON("/v1/leave", { method: "POST", body: {} });
  } catch (error) {
    toast(error instanceof RelayError ? errorText(error.status, error.code) : "解除できませんでした");
    return;
  }
  session.clear();
  forgetChat();
  clearDraft();
  closeSheets();
  showLogin("main", "登録を解除しました。");
}

// MARK: Sheets

function openSheet(id) {
  if (id === "model-sheet") renderModelSheet();
  if (id === "credit-sheet") renderCreditSheet();
  if (id === "settings-sheet") {
    $("settings-body").replaceChildren(h("p", { class: "section-foot", text: "読み込んでいます…" }));
    renderSettings();
  }
  $(id).showModal();
}

function closeSheets() {
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
}

function wireSheets() {
  for (const dialog of document.querySelectorAll("dialog.sheet")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
    });
  }
  $("model-button").addEventListener("click", () => openSheet("model-sheet"));
  $("settings-button").addEventListener("click", () => openSheet("settings-sheet"));
  $("credit").addEventListener("click", () => openSheet("credit-sheet"));
}

// MARK: Start

function wireComposer() {
  const input = $("input");
  const coarse = matchMedia("(pointer: coarse)").matches;
  // On a phone, return makes a new line and the button sends; with a keyboard, Enter sends.
  input.setAttribute("enterkeyhint", coarse ? "enter" : "send");
  input.addEventListener("input", () => { autoGrow(); updateComposer(); });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || coarse || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!state.streaming) sendFromComposer();
  });
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    sendFromComposer();
  });
  $("new-chat").addEventListener("click", async () => {
    if (!state.chat.messages.length && !state.draft.length) return;
    stop();
    forgetChat();
    clearDraft();
    renderThread();
    updateComposer();
    if (!coarse) input.focus();
  });
}

function start() {
  if (RELAY.startsWith("__")) {
    showLogin("main", "このページの組み立てが途中です（中継サーバーのアドレスがありません）。");
    return;
  }
  wireLogin();
  wireComposer();
  wireAttachments();
  wireSheets();
  wireScroller();
  wireViewport();
  attachReplyActions($("messages"));
  addEventListener("online", updateBanner);
  addEventListener("offline", updateBanner);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // Text that came while the tab was away shows at once.
    if (state.streaming) state.streaming.pacer.shown = state.streaming.pacer.text.length;
    if (session.get() && !$("chat").hidden) refreshStatus();
  });
  const invited = readInviteLink();
  if (session.get() && !invited) {
    enterChat().catch(() => showLogin("main"));
  } else {
    showLogin(invited ? "invite" : "main");
  }
}

start();
