// Fielua for the web: sign in with a passkey, then chat with Claude
// through Fielua's relay. The page holds no secret of the developer's:
// the Anthropic API key lives only in the relay (a Cloudflare secret).

import { RELAY, RelayError, call, callJSON, session } from "./api.js";
import { ACCEPT, AttachError, LIMITS as ATTACH, prepare, release, sizeLabel, stored, timeLabel } from "./attach.js";
import * as archive from "./history.js";
import { attachReplyActions, copyText, flash, loadMath, ReplyView } from "./markdown.js";
import { closeDialog, closeDialogNow, dismiss, isFolding, isLeaving, move, openDialog, place, present, replay, still, unfold, watchDialogs } from "./motion.js";
import { alive, bloom, flowerMark } from "./flower.js";
import { createPasskey, forgetPasskey, newAdminKey, passkeysSupported, usePasskey } from "./passkey.js";
import { Pacer, readEvents } from "./stream.js";

const $ = (id) => document.getElementById(id);

// MARK: Models and levels

const EFFORTS = ["low", "medium", "high", "xhigh"];
const EFFORT = {
  low: { title: "低" },
  medium: { title: "中" },
  high: { title: "高" },
  xhigh: { title: "超高" },
};
/** The model a new person starts with. (No Fielua rank on Anthropic's models: Hachimoto さん, 2026-11-09.) */
const DEFAULT_MODEL = "claude-opus-5-5";
/** The level every model starts at until the person chooses one (Hachimoto さん, 2026-11-08). */
const START_EFFORT = "medium";
const startEffort = (model) => (model.efforts.includes(START_EFFORT) ? START_EFFORT : model.defaultEffort);
/** The relay's catalog as this version knows it, in Fielua's order, until the relay answers. */
const BUILT_IN = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: EFFORTS, defaultEffort: "medium", available: null },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", efforts: EFFORTS, defaultEffort: "high", available: null },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: EFFORTS, defaultEffort: "high", available: null },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: EFFORTS, defaultEffort: "medium", available: null },
];
/** Models the relay no longer offers, and what took their place: a saved choice moves on, and old replies keep their name. */
const FORMER = new Map([
  ["claude-fable-5-1", { name: "Claude Fable 5.1", now: "claude-fable-5-2" }],
]);

// As the relay takes them (claude-relay/src/turns.ts), with room to spare.
const MAX_TURNS = 40;
const MAX_TURN_BYTES = 60 * 1024;
const MAX_TOTAL_BYTES = 180 * 1024;
const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).length;

/** How long Anthropic keeps a code container, from when it was made; the page lets one go a day early. */
const CONTAINER_DAYS = 29;
/** How long the relay hands out a file a reply made (its own rule: it knows whose each one is that long). */
const FILE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A kept reply's key: chosen here before it is asked, so it can be stopped or read again whatever becomes of the question (before `state`: a reload's copy is read with it). */
const REPLY_KEY = /^[0-9a-f]{32}$/;

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
    const saved = typeof value.model === "string" ? value.model : DEFAULT_MODEL;
    const efforts = typeof value.efforts === "object" && value.efforts ? value.efforts : {};
    // Fable 5.1 chosen before Fable 5.2 came: Fable 5.2, at the level chosen for 5.1.
    const now = FORMER.get(saved)?.now;
    if (now && efforts[now] === undefined && efforts[saved] !== undefined) efforts[now] = efforts[saved];
    return {
      model: now ?? saved,
      efforts,
      // The plus menu's switches: off until turned on, then kept on this device.
      tools: { webSearch: value.tools?.webSearch === true, files: value.tools?.files === true },
      // On a wide screen, whether the list stands beside the chat (open until closed).
      historyDocked: value.historyDocked !== false,
    };
  } catch {
    return { model: DEFAULT_MODEL, efforts: {}, tools: { webSearch: false, files: false }, historyDocked: true };
  }
}
function savePrefs() {
  try { localStorage.setItem("fielua.prefs", JSON.stringify(state.prefs)); } catch { /* private mode */ }
}
function newChatID() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new, empty conversation (kept in the history once its first question is sent). */
function blankChat() {
  return { id: newChatID(), createdAt: Date.now(), updatedAt: 0, messages: [] };
}

/** A conversation read back from the tab or the history: what it lacks filled in, a reply cut off mid-way marked stopped. */
function restoreChat(value) {
  const chat = {
    ...value,
    id: typeof value.id === "string" && /^[\w-]{8,64}$/.test(value.id) ? value.id : newChatID(),
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || (value.messages.length ? Date.now() : 0),
    savedAt: Number(value.savedAt) || 0,
    owner: typeof value.owner === "string" ? value.owner : "",
    messages: value.messages.filter((message) => message && (message.role === "user" || message.role === "assistant")),
  };
  for (const message of chat.messages) {
    // Cut off, or still being written in another tab: shown as stopped, never written back as such by this copy's file names.
    if (message.end === "streaming") {
      message.end = message.error ? "failed" : "stopped";
      message.unfinished = true;
      // The relay may still have it (resumeCutReply): only this tab's own copy is ever picked up again.
      if (typeof message.reply === "string" && REPLY_KEY.test(message.reply)) message.cutReply = message.reply;
    }
    delete message.reply;
  }
  return chat;
}

function loadChat() {
  try {
    const value = JSON.parse(sessionStorage.getItem("fielua.chat") ?? "null");
    if (value && Array.isArray(value.messages)) return restoreChat(value);
  } catch { /* none */ }
  return blankChat();
}

/** A conversation as it is kept: the text and what was shown, never an attachment's data. */
function serialize(chat, pictures = true) {
  return {
    id: chat.id, createdAt: chat.createdAt, updatedAt: chat.updatedAt, savedAt: chat.savedAt ?? 0,
    // Whose history it goes into (someone else signing in in this tab doesn't get it).
    ...(chat.owner ? { owner: chat.owner } : {}),
    ...(chat.container ? { container: chat.container, ...(chat.containerAt ? { containerAt: chat.containerAt } : {}) } : {}),
    messages: chat.messages.map(({ role, text, model, effort, served, end, error, attachments, search, files, trimmed, reply }) => ({
      role, text, model, effort, served, end, error, ...(trimmed ? { trimmed } : {}),
      // A reply still being written that the relay keeps: a reload of this tab picks it up again.
      ...(reply && end === "streaming" ? { reply } : {}),
      ...(attachments?.length ? { attachments: attachments.map((a) => ({ ...stored(a), thumb: pictures ? a.thumb : undefined })) } : {}),
      ...(search?.queries.length || search?.pages.length ? { search: { queries: search.queries, pages: search.pages.slice(0, 12), failed: search.failed ?? null } } : {}),
      ...(files?.length ? { files: files.map(({ id, name, size, mimeType, madeAt }) => ({ id, name, size, mimeType, ...(madeAt ? { madeAt } : {}) })) } : {}),
    })),
  };
}

/**
 * Keeps a conversation: in this tab (the open one, for a reload) and in
 * this device's history. Each change raises its revision (savedAt), so the
 * newer of two copies (this tab's, another tab's) is known.
 */
function saveChat(chat = state.chat, { history = true } = {}) {
  if (history) {
    chat.savedAt = Math.max(Date.now(), (chat.savedAt ?? 0) + 1);
    keepInHistory(chat);
  }
  if (chat === state.chat) {
    const write = (pictures) => sessionStorage.setItem("fielua.chat", JSON.stringify(pictures ? serialize(chat, true) : { ...serialize(chat, false), picturesDropped: true }));
    try {
      write(true);
    } catch {
      // The tab's storage is full: the names stay, the pictures only on the page (and in the history).
      try {
        write(false);
      } catch {
        // Not even that: no older copy is left to come back on a reload (the history has this one).
        try { sessionStorage.removeItem("fielua.chat"); } catch { /* none */ }
      }
    }
  }
}

function forgetChat() {
  sessionStorage.removeItem("fielua.chat");
  for (const message of state.chat.messages) message.attachments?.forEach(release);
  state.chat = blankChat();
}

const graphemes = (text) => (typeof Intl.Segmenter === "function"
  ? Array.from(new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text), (part) => part.segment)
  : Array.from(text));

/** A conversation's name in the list, as the iPhone app makes it: the first question's first 28 characters. */
function titleOf(chat) {
  const first = chat.messages.find((message) => message.role === "user");
  if (!first) return "新しいチャット";
  const text = (first.text ?? "").trim().replace(/\r?\n/g, " ");
  if (text) return graphemes(text).slice(0, 28).join("");
  const kinds = (first.attachments ?? []).map((attachment) => attachment.kind);
  return kinds.includes("video") ? "動画" : kinds.includes("image") ? "写真" : kinds.length ? "ファイル" : "新しいチャット";
}

// MARK: The history (this device only, encrypted; see history.js)

const historySaves = new Map();
let historyTimer = 0;
let historyWriting = Promise.resolve();
let historyWarned = false;

/** A conversation goes into the history once it has a question: written a moment later, the latest state once. */
function keepInHistory(chat) {
  if (!archive.isOpen() || !chat.messages.some((message) => message.role === "user")) return;
  const tag = archive.ownerTag();
  // Someone else's conversation (left in this tab when their sign-in lapsed) never goes into this history.
  if (chat.owner && chat.owner !== tag) return;
  chat.owner = tag;
  historySaves.set(chat.id, chat);
  clearTimeout(historyTimer);
  historyTimer = setTimeout(flushHistory, 300);
}

/** Writes what waits, one after another. */
function flushHistory() {
  clearTimeout(historyTimer);
  const chats = [...historySaves.values()];
  historySaves.clear();
  if (!chats.length) return historyWriting;
  // Written for the person they were queued for, and nobody else (save refuses once another key is here).
  const whose = archive.ownerTag();
  historyWriting = historyWriting.catch(() => {}).then(async () => {
    for (const chat of chats) {
      const meta = { title: titleOf(chat), createdAt: chat.createdAt, updatedAt: chat.updatedAt };
      try {
        if (!await archive.save(serialize(chat, true), meta, whose)) continue;
      } catch (error) {
        try {
          // The device is full: the conversation is kept without its pictures.
          if (error?.name !== "QuotaExceededError") throw error;
          if (!await archive.save(serialize(chat, false), meta, whose)) continue;
        } catch (again) {
          if (!archive.isOpen()) return;
          console.warn("history", again?.name ?? "error");
          if (!historyWarned) { historyWarned = true; toast(again?.name === "QuotaExceededError" ? "端末の空きが足りないため、会話履歴に保存できませんでした。" : "会話履歴に保存できませんでした。"); }
          continue;
        }
      }
      archive.keep();
    }
    renderHistory();
  });
  return historyWriting;
}

/** A reply being written: what has come so far is kept now (the page may go before the next checkpoint). */
function syncStreaming() {
  const run = state.streaming;
  // Read again after a reload and not as far as before yet: what the message had stays.
  if (!run || !run.pacer.text || run.message.text === run.pacer.text || run.pacer.text.length < (run.known ?? 0)) return;
  run.message.text = run.pacer.text;
  saveChat(run.chat);
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
/** A short line above the composer; with `action` ({ label, run }), a button in it, for a few seconds more. */
function toast(text, action = null) {
  const element = $("toast");
  hostToast();
  element.replaceChildren(h("span", { text }));
  if (action) {
    element.append(h("button", { type: "button", class: "toast-action", text: action.label, onclick: () => { clearTimeout(toastTimer); present(element, false); action.run(); } }));
  }
  present(element, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => present(element, false), action ? 6000 : Math.max(2400, text.length * 90));
}

/** A sheet or an alert covers everything else on the page: while one is open, the toast is shown in it. */
function hostToast() {
  const element = $("toast");
  const host = [...document.querySelectorAll("dialog[open]:not(.closing)")].pop() ?? document.body;
  if (element.parentElement === host) return;
  // A dialog still on its way in would carry the toast along (its transform
  // and its fade are the toast's too): the toast joins it once it has arrived.
  const arriving = host === document.body ? [] : (host.getAnimations?.() ?? []).filter((motion) => motion.playState === "running");
  if (arriving.length) {
    Promise.allSettled(arriving.map((motion) => motion.finished)).then(hostToast);
    return;
  }
  // Moved while it shows: it stays as it is, with no second entrance.
  if (!element.hidden) element.classList.add("stayed");
  host.append(element);
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
      dialog.oncancel = null;
      closeDialog(dialog);
      resolve(value);
    };
    okButton.onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    // Escape: answered no, and it leaves as it would for キャンセル.
    dialog.oncancel = (event) => { event.preventDefault(); done(false); };
    dialog.onclose = () => done(false);
    openDialog(dialog);
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
  paused_billing: "Anthropic のクレジットが切れたため停止中です。追加購入はしていません。",
  paused_limit: "Anthropic の利用上限に達したため停止中です。",
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
    case "server_key": return "中継サーバーの API キーが Anthropic に受け付けられませんでした。";
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
    case "invalid_code": return "招待コードが無効です。使用済みか、72 時間を過ぎています。";
    case "too_many_attempts": return "試した回数が多すぎます。1 時間ほど待ってからお試しください。";
    case "unknown_passkey": return "このパスキーの登録は削除されています。招待コードでもう一度登録してください。";
    case "revoked": return "開発者がこのアカウントの利用を止めています。";
    case "passkey_rejected": return "パスキーを確かめられませんでした。もう一度お試しください。";
    case "expired_challenge": return "時間がかかりすぎました。もう一度お試しください。";
    case "busy": return "混み合っています。少し待ってからお試しください。";
    case "web_not_configured": return "中継サーバーで Web 版がまだ有効になっていません（WEB_ORIGINS と WEB_RP_ID）。";
    case "forbidden_origin": return "このアドレスからは使えません。https://suelira.com/chat/ を開いてください。";
    case "unauthorized": return "管理キーが違います。";
    case "admin_not_configured": return "中継サーバーに管理キー（ADMIN_TOKEN、32 文字以上）が設定されていません。";
    default: return `中継サーバーから予期しない応答がありました（${error.status}）。`;
  }
}

// MARK: Sign in

let loginOpening = 0;
/** `tone` "note": the message is no error, only what the person just did (signed out). */
function showLogin(panel = "main", message = "", tone = "error") {
  const login = $("login");
  const appearing = login.hidden || isLeaving(login);
  place($("splash"), false);
  $("chat").hidden = true;
  place(login, true);
  for (const id of ["login-main", "login-invite", "login-setup"]) {
    const section = $(id);
    const shown = id === `login-${panel}`;
    // Another form under the name: it comes up into place (the same one again, for an error, stays).
    if (shown && section.hidden && !appearing) replay(section, "switched");
    section.hidden = !shown;
  }
  const error = $("login-error");
  const text = passkeysSupported() ? message : "このブラウザはパスキーに対応していません。";
  if (text && (error.hidden || error.textContent !== text)) replay(error, "switched");
  const note = tone === "note" && text === message;
  error.classList.toggle("note", note);
  error.setAttribute("role", note ? "status" : "alert");
  error.textContent = text;
  error.hidden = !text;
  if (appearing) {
    // The sign-in screen comes into view: the flower opens, and the name and the form come up under it.
    flowers.stopBloom?.();
    flowers.stopBloom = flowers.login ? bloom(flowers.login) : null;
    replay(login, "opening");
    clearTimeout(loginOpening);
    loginOpening = setTimeout(() => login.classList.remove("opening"), 1300);
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
      await enterChat(true);
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
      await enterChat(true);
      toast("登録しました。");
    } catch (error) {
      showLogin("invite", loginErrorText(error));
    } finally {
      setBusy(button, false);
    }
  });

  enterPresses($("invite-code"), $("invite-register"));
  enterPresses($("setup-admin-key"), $("setup-register"));
  enterPresses($("setup-name"), $("setup-register"));

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
      await enterChat(true);
      toast("開発者として登録しました。");
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

async function enterChat(signedIn = false) {
  await refreshStatus();
  if (!session.get()) return;
  // Signed in anew in this tab: the conversation left from before waits, unseen, until the key says whose it is.
  if (signedIn) holdChat();
  // The chat comes in over what was there: the sign-in screen, or the flower that stood for the page.
  const chat = $("chat");
  const splash = $("splash");
  if (chat.hidden && splash.hidden) replay(chat, "arriving");
  present(splash, false);
  present($("login"), false);
  chat.hidden = false;
  applyDock(false);
  renderTopbar();
  renderThread();
  updateComposer();
  loadMath();
  if (!matchMedia("(pointer: coarse)").matches) $("input").focus();
  watchExpiry();
  // The history after the chat shows (it waits on the relay for the key).
  const unlocked = unlockHistory();
  // Back after Safari reloaded the page: a reply that was still coming is picked up again, once the history is open.
  if (!signedIn) resumeCutReply(unlocked);
  await unlocked;
}

let expiryTimer = 0;
/** When the sign-in's 12 hours end, the page signs out by itself (the history locked with it). */
function watchExpiry() {
  clearTimeout(expiryTimer);
  const ends = session.get()?.expiresAt;
  if (typeof ends !== "number") return;
  expiryTimer = setTimeout(expired, Math.min(Math.max(ends - Date.now(), 0) + 1000, 2 ** 31 - 1));
}
function expired() {
  if ($("chat").hidden) return;
  if (session.get()) { watchExpiry(); return; }
  // A reply being written ends first.
  if (state.streaming) { expiryTimer = setTimeout(expired, 5000); return; }
  signedOut();
  closeSheets();
  showLogin("main", errorText(401, "unauthorized"));
}

async function refreshStatus() {
  try {
    state.status = await callJSON("/v1/status");
  } catch (error) {
    if (error instanceof RelayError && (error.status === 401 || error.code === "revoked")) {
      signedOut();
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
  renderTools();
  updateBanner();
  retryHistory();
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
  return catalog().find((m) => m.id === id)?.name ?? FORMER.get(id)?.name ?? id ?? "Claude";
}

function renderTopbar() {
  const { model, effort } = choice();
  // A changed name or level comes up into its place; the same one again (every status check) does nothing.
  for (const [element, text] of [[$("model-name"), model.name], [$("model-sub"), `推論 ${EFFORT[effort]?.title ?? effort} · 外部AI`]]) {
    if (element.textContent === text) continue;
    const first = !element.dataset.set || $("chat").hidden;
    element.textContent = text;
    element.dataset.set = "1";
    if (!first) replay(element, "changed");
  }
  // The name read aloud starts with what the button shows (voice control says what it sees).
  $("model-button").setAttribute("aria-label", `${model.name} 推論 ${EFFORT[effort]?.title ?? effort} · 外部AI、モデルと推論レベルを変える`);
  $("empty-line").textContent = "メッセージは Anthropic の Claude に送られます。";
}

function showBanner(text, warn = false) {
  const banner = $("banner");
  // Its room opens and closes (the words stay while it closes).
  if (text) banner.replaceChildren(...(warn ? [icon("alert")] : []), h("span", { text }));
  if (text) banner.classList.toggle("warn", warn);
  if ($("chat").hidden) banner.hidden = !text; else unfold(banner, !!text);
}

function updateBanner() {
  if (!navigator.onLine) { showBanner("インターネットに接続されていません。", true); return; }
  const status = state.status;
  if (status && !status.available) {
    showBanner(REASONS[status.reason] ?? REASONS.not_configured, true);
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
  // Another conversation, or a new one: it fades in, with no part of it moving.
  const empty = $("empty");
  const wasEmpty = !empty.hidden && !isLeaving(empty);
  place(empty, state.chat.messages.length === 0);
  if (!$("chat").hidden) {
    if (state.chat.messages.length) replay(holder, "switched");
    else if (!wasEmpty) replay(empty, "shown");
  }
  checkFlower();
  requestAnimationFrame(() => scrollToEnd(false));
}

function messageElement(message) {
  if (message.role === "user") return sentElement(message);
  const reply = h("div", { class: "reply" });
  const work = h("div", { class: "work", hidden: true });
  const element = h("div", { class: "msg assistant" }, work, reply);
  const view = new ReplyView(reply);
  state.views.set(message, { element, reply, view, work });
  if (message.text) view.update(message.text, { live: false, animate: false });
  finishElement(message);
  return element;
}

// MARK: Attachments, as the iPhone app shows them

const ICONS = {
  plus: ["M12 5.5v13M5.5 12h13"],
  alert: ["M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z", "M12 7.8v5.2", "M12 16.2h.01"],
  photo: ["M6 5.5h12a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16V8A2.5 2.5 0 0 1 6 5.5Z", "m4 16.5 4.5-4.5 3.5 3.5 2.5-2.5 5.5 5.5", "M15.5 9.5h.01"],
  video: ["M5.5 6.5h8a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 15V9a2.5 2.5 0 0 1 2.5-2.5Z", "m16 10.5 5-3v9l-5-3"],
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"],
  doc: ["M7 3.5h6.5L18 8v12.5H7Z", "M13.5 3.5V8H18", "M9.5 12.5h6M9.5 16h4"],
  play: ["M9 6.8v10.4l8.2-5.2Z"],
  globe: ["M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z", "M3.5 12h17", "M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5Z"],
  make: ["M7 3.5h6.5L18 8v12.5H7Z", "M13.5 3.5V8H18", "M12.5 11v6M9.5 14h6"],
  out: ["M8.5 15.5 15.5 8.5M10 8.5h5.5V14"],
  check: ["m5.5 12.5 4 4 9-9"],
  down: ["M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5", "M6 19h12"],
  xmark: ["M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"],
  again: ["M19 12a7 7 0 1 1-2.05-4.95", "M19.5 4.5V8H16"],
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
    "aria-label": attachment.kind === "video" && attachment.duration
      ? `${timeLabel(attachment.duration)} 動画を開く: ${attachment.name}`
      : `${attachment.kind === "video" ? "動画" : "写真"}を開く: ${attachment.name}`,
    onclick: (event) => openViewer(attachment, event.currentTarget),
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
function openViewer(attachment, pressed = null) {
  const body = $("viewer-body");
  if (attachment.kind === "video" && attachment.play) {
    body.replaceChildren(h("video", { src: attachment.play, controls: true, playsinline: true, autoplay: true }));
  } else {
    const data = attachment.kind === "image" ? attachment.parts?.[0]?.data : null;
    body.replaceChildren(h("img", { src: data ? `data:image/jpeg;base64,${data}` : attachment.thumb, alt: attachment.name }));
  }
  $("viewer-title").textContent = attachment.name;
  openDialog($("viewer"));
  // The picture grows out of the one that was pressed (the sheet around it only fades in), and stays.
  const picture = body.firstElementChild;
  if (!pressed || picture.tagName !== "IMG") return;
  const grow = () => {
    const from = pressed.getBoundingClientRect();
    const to = picture.getBoundingClientRect();
    if (!from.width || !to.width || !to.height || !picture.isConnected) return;
    const scale = Math.max(from.width / to.width, from.height / to.height);
    const x = from.left + from.width / 2 - to.left - to.width / 2;
    const y = from.top + from.height / 2 - to.top - to.height / 2;
    move(picture, [
      { transform: `translate(${x}px, ${y}px) scale(${scale})`, borderRadius: `${18 / scale}px` },
      { transform: "none", borderRadius: "12px" },
    ], { ms: 590, curve: "--sheet-open" });
  };
  if (picture.complete && picture.naturalWidth) grow(); else picture.addEventListener("load", grow, { once: true });
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
  const empty = state.draft.length === 0;
  // The last one out: the row closes with it still in it; otherwise the one taken out shrinks away.
  for (const child of [...tray.children]) if (!wanted.includes(child) && !isLeaving(child)) { if (empty) child.dataset.gone = "1"; else dismiss(child); }
  if (!empty) for (const child of [...tray.children]) if (child.dataset.gone) child.remove();
  const staying = () => [...tray.children].filter((child) => !isLeaving(child) && !child.dataset.gone);
  wanted.forEach((item, index) => { if (staying()[index] !== item) tray.insertBefore(item, staying()[index] ?? null); });
  unfold(tray, !empty);
  tray.parentElement.classList.toggle("has-tray", !empty);
  unfold($("tray-status"), state.preparing > 0);
  updateComposer();
}

function wireAttachments() {
  const menu = $("attach-menu");
  const button = $("attach");
  const isOpen = () => !menu.hidden && !isLeaving(menu);
  const close = () => {
    present(menu, false);
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    if (isOpen()) { close(); return; }
    const full = state.draft.length + state.preparing >= ATTACH.perMessage;
    for (const item of menu.querySelectorAll("[data-pick]")) item.disabled = !!state.streaming || state.preparing > 0 || full;
    $("menu-new-chat").disabled = !!state.streaming;
    present(menu, true);
    button.setAttribute("aria-expanded", "true");
    renderTools();
    menu.querySelector("button:not(:disabled):not([hidden])")?.focus({ preventScroll: true });
  });
  for (const row of menu.querySelectorAll("[data-tool]")) {
    row.addEventListener("click", () => {
      setTool(row.dataset.tool, !state.prefs.tools[row.dataset.tool]);
      close();
    });
  }
  $("menu-new-chat").addEventListener("click", () => { close(); startNewChat(); });
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
    if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) { close(); button.focus(); }
  });
  walkWithArrows(menu, "button");
  // Tab leaves the menu shut, and the keyboard is back on the plus (which a chosen row leaves too).
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && isOpen()) { event.preventDefault(); close(); button.focus(); }
  });
  menu.addEventListener("click", (event) => {
    // (Unless the row put the keyboard somewhere itself, as a new chat does.)
    if (event.detail === 0 && !isOpen() && menu.contains(document.activeElement)) button.focus({ preventScroll: true });
  });
  // An ordinary wheel moves along the attachments (they lie in a row).
  $("tray").addEventListener("wheel", (event) => {
    const tray = event.currentTarget;
    if (event.deltaX || !event.deltaY || event.ctrlKey || tray.scrollWidth <= tray.clientWidth) return;
    event.preventDefault();
    tray.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
  }, { passive: false });
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

// MARK: Web search and files a reply made

/** The tools the next question goes with, when the relay offers them and the person turned any on. */
function toolsFor() {
  if (!state.status?.tools) return null;
  const { webSearch, files } = state.prefs.tools;
  if (!webSearch && !files) return null;
  return { webSearch, files, ...(files && liveContainer(state.chat) ? { container: state.chat.container } : {}) };
}

/** The chat's code container, while Anthropic still keeps it (30 days from when it was made). */
function liveContainer(chat) {
  if (!chat.container) return null;
  if (chat.containerAt && Date.now() - chat.containerAt > CONTAINER_DAYS * DAY_MS) return null;
  return chat.container;
}

const TOOL_LABELS = {
  webSearch: { name: "ウェブ検索", short: "検索", icon: "globe" },
  files: { name: "ファイル作成", short: "ファイル", icon: "make" },
};

/** While a tool is on: a pill beside the plus that says so in the accent color and turns it off (the app's ウェブ検索). */
function renderTools() {
  const offered = !!state.status?.tools;
  const pills = $("tool-pills");
  // A pill stays while its tool is on (drawn again, it would come in again): it comes in when the tool is turned on, and goes when it is turned off.
  const keys = Object.keys(TOOL_LABELS);
  for (const [key, label] of Object.entries(TOOL_LABELS)) {
    const on = offered && !!state.prefs.tools[key];
    let pill = [...pills.children].find((child) => child.dataset.tool === key && !isLeaving(child));
    if (on && !pill) {
      pill = h("button", {
        type: "button", class: `tool-pill${pills.dataset.drawn ? " fresh" : ""}`, "aria-label": `${label.name}をオフにする`, dataset: { tool: key },
        onclick: () => setTool(key, false),
      }, icon(label.icon), h("span", { text: label.short }));
      pills.insertBefore(pill, [...pills.children].find((child) => keys.indexOf(child.dataset.tool) > keys.indexOf(key)) ?? null);
    } else if (!on && pill) {
      dismiss(pill);
      pill = null;
    }
    if (pill) pill.disabled = !!state.streaming;
  }
  pills.dataset.drawn = "1";
  for (const row of document.querySelectorAll("#attach-menu [data-tool]")) {
    row.hidden = !offered;
    row.disabled = !!state.streaming;
    row.setAttribute("aria-checked", state.prefs.tools[row.dataset.tool] ? "true" : "false");
  }
  $("attach-menu-gap").hidden = !offered;
  $("attach-menu").classList.toggle("has-checks", offered);
}

function setTool(key, on) {
  state.prefs.tools[key] = on;
  savePrefs();
  renderTools();
}

/** The line above a reply: what it searched (the app's WebSearchHeader), or what it is doing now. */
function renderWork(message) {
  const entry = state.views.get(message);
  if (!entry) return;
  const live = message.end === "streaming" ? message.activity : null;
  const search = message.search;
  let text = "";
  let symbol = "globe";
  if (live?.kind === "search") text = live.query ? `「${live.query}」をウェブで検索しています…` : "ウェブで検索しています…";
  else if (live?.kind === "fetch") text = "ページを読んでいます…";
  else if (live?.kind === "edit") { text = "ファイルを書いています…"; symbol = "make"; }
  else if (live?.kind === "code") { text = "コードを実行しています…"; symbol = "make"; }
  else if (live?.kind === "reconnect") { text = "つなぎ直しています…"; symbol = "again"; }
  else if (search?.queries.length) {
    const queries = search.queries.map((query) => `「${query}」`).join("");
    text = search.failed && !search.pages.length ? `${queries}を検索できませんでした` : `${queries}をウェブで検索しました`;
  }
  entry.work.hidden = !text;
  entry.work.classList.toggle("busy", !!live);
  entry.work.replaceChildren(...(text ? [icon(symbol), h("span", { text })] : []));
}

function addPages(message, pages, cited) {
  message.search ??= { queries: [], pages: [], failed: null };
  for (const page of pages) {
    const known = message.search.pages.find((item) => item.url === page.url);
    if (known) known.cited ||= cited;
    else if (message.search.pages.length < 40) message.search.pages.push({ ...page, cited });
  }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** Below a written reply: the pages it cited (or, citing none, the ones it read), six at most, each opening in a new tab. */
function sourcesElement(message) {
  const pages = message.search?.pages ?? [];
  const cited = pages.filter((page) => page.cited);
  const list = (cited.length ? cited : pages).slice(0, 6);
  if (!list.length) return null;
  return h("div", { class: "sources" }, h("p", { class: "sources-title", text: "情報源" }),
    list.map((page, index) => h("a", { class: "source", href: page.url, target: "_blank", rel: "noopener noreferrer" },
      h("span", { class: "source-num", text: String(index + 1) }),
      h("span", { class: "source-text" }, h("span", { class: "source-name", text: page.title }), h("span", { class: "source-site", text: hostOf(page.url) })),
      icon("out"))));
}

/** Types a download keeps; anything else (HTML, SVG, scripts…) goes as plain bytes, so nothing it holds can run here. */
const SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv", "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/json", "application/zip"]);
const previews = new Map();

function fileKind(file) {
  const name = (file.name ?? "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PowerPoint", csv: "CSV", txt: "テキスト", md: "テキスト", png: "画像", jpg: "画像", jpeg: "画像", json: "JSON", zip: "ZIP" }[ext] ?? "ファイル";
}

/** The files a reply made, each with its download button; a picture shows itself too. */
const fileExpired = (file) => !!file.madeAt && Date.now() - file.madeAt > FILE_DAYS * DAY_MS;

function filesElement(message) {
  return h("div", { class: "made-files" }, message.files.map((file) => {
    const expired = fileExpired(file);
    const button = expired ? null : h("button", { type: "button", class: "secondary download", "aria-label": `保存: ${file.name ?? "ファイル"}` }, icon("down"), h("span", { text: "保存" }));
    button?.addEventListener("click", () => downloadFile(file, button));
    const meta = expired ? "作成から 30 日を過ぎたため保存できません"
      : file.name ? `${fileKind(file)}${file.size ? ` · ${sizeLabel(file.size)}` : ""}` : "読み込んでいます…";
    const card = h("div", { class: "made-file" },
      icon("doc"),
      h("span", { class: "file-text" }, h("span", { class: "file-name", text: file.name ?? "ファイル" }),
        h("span", { class: "file-meta", text: meta })),
      button);
    if (!expired && /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType ?? "") && (file.size ?? 0) < 8 * 1024 * 1024) {
      const picture = h("img", { class: "made-picture", alt: file.name ?? "", hidden: true });
      card.prepend(picture);
      card.classList.add("with-picture");
      fileBlob(file).then((blob) => {
        if (!previews.has(file.id)) previews.set(file.id, URL.createObjectURL(blob));
        picture.src = previews.get(file.id);
        picture.hidden = false;
      }).catch(() => {});
    }
    return card;
  }));
}

async function fileBlob(file) {
  const response = await call(`/v1/files/${encodeURIComponent(file.id)}/content`);
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    throw new RelayError(response.status, body.error ?? "unexpected", body);
  }
  const type = SAFE_TYPES.has(file.mimeType) ? file.mimeType : "application/octet-stream";
  return new Blob([await response.arrayBuffer()], { type });
}

async function downloadFile(file, button) {
  button.disabled = true;
  button.classList.add("busy");
  try {
    const url = URL.createObjectURL(await fileBlob(file));
    const link = h("a", { href: url, download: file.name ?? "file", hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    toast(error?.code === "not_found" ? "このファイルは保存できませんでした。" : errorText(error?.status ?? 0, error?.code ?? "network"));
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}

/** The names and sizes of the files a finished reply made (the relay knows them as this person's a moment after the reply ends). */
async function loadFileInfo(message, chat = state.chat) {
  let changed = false;
  for (const file of message.files ?? []) {
    if (file.name || fileExpired(file)) continue;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const info = await callJSON(`/v1/files/${encodeURIComponent(file.id)}`);
        Object.assign(file, { name: info.filename, size: info.size, mimeType: info.mimeType });
        changed = true;
        break;
      } catch (error) {
        if (!(error instanceof RelayError) || error.code !== "not_found" || attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  }
  // Not for a conversation deleted or replaced meanwhile (it would come back, or an older copy would win);
  // a reply cut off mid-way in a copy from another tab only shows the names (that tab writes the reply).
  if (changed && (chat === state.chat || liveChats.get(chat.id) === chat)) {
    saveChat(chat, { history: !message.unfinished });
    if (chat === state.chat) finishElement(message);
  }
}

function captionFor(message) {
  const parts = [`${modelName(message.model)} · 推論 ${EFFORT[message.effort]?.title ?? message.effort}`];
  if (message.served && message.served !== message.model && !message.served.startsWith(message.model)) parts.push(`${modelName(message.served)} が答えました`);
  if (message.end === "stopped") parts.push("停止しました");
  // A long conversation: its first questions no longer went to Claude (the relay takes 40 turns at most).
  if (message.trimmed) parts.push(`最初の ${message.trimmed} 問は Claude に送っていません`);
  const caption = h("div", { class: "caption" }, h("span", { text: parts.join(" · ") }));
  if (message.text) {
    caption.append(h("button", {
      type: "button", class: "text", text: "返信をコピー",
      onclick: async (event) => {
        const button = event.currentTarget;
        flash(button, (await copyText(message.text)) ? "コピーしました" : "コピーできません");
      },
    }));
  }
  return caption;
}

const END_NOTICES = {
  refused: "Claude はこの質問への回答を控えました。",
  cutOff: "返信が長さの上限に達したため、ここで終わっています。",
  paused: "ここで一度止まりました。「続けて」と送ると続きを書きます。",
};

/** The lines under a finished reply: which model answered, and what stopped it. */
/** What stands around a reply once it has ended. `fresh`: it ended just now, so these come in softly. */
function finishElement(message, fresh = false) {
  const entry = state.views.get(message);
  if (!entry) return;
  entry.element.classList.toggle("ended-now", fresh);
  entry.element.querySelector(".thinking")?.remove();
  entry.element.querySelector(".caption")?.remove();
  entry.element.querySelector(".notice")?.remove();
  entry.element.querySelector(".sources")?.remove();
  entry.element.querySelector(".made-files")?.remove();
  entry.reply.removeAttribute("aria-busy");
  renderWork(message);
  if (message.end === "streaming") return;
  const sources = sourcesElement(message);
  if (sources) entry.element.append(sources);
  if (message.files?.length) entry.element.append(filesElement(message));
  const text = message.error ?? END_NOTICES[message.end];
  if (text) {
    const notice = h("div", { class: `notice${message.error ? " error" : ""}`, role: message.error && fresh ? "alert" : null }, message.error ? icon("alert") : null, h("div", { text }));
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
  let dropped = 0;
  while (turns.length > 1 && (turns.length > MAX_TURNS || total() > MAX_TOTAL_BYTES)) { turns.splice(0, 2); dropped++; }
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
  turns.dropped = dropped;
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
  for (const pill of $("tool-pills").children) pill.disabled = streaming;
  // While something is typed the empty chat's flower is away (the app's FlowerAway).
  $("empty").classList.toggle("typing", !!input.value);
  checkFlower();
}

// MARK: The flower (flower.js): it opens on the sign-in screen and lives in the empty chat

const flowers = { login: null, life: null, stopBloom: null };

function plantFlowers() {
  const login = document.querySelector("img.login-flower");
  const empty = document.querySelector("img.empty-flower");
  if (!login || !empty) return;
  flowers.login = flowerMark("login-flower");
  login.replaceWith(flowers.login);
  const living = flowerMark("empty-flower");
  empty.replaceWith(living);
  // It rests when it is not seen, while the person types, and while a sheet covers the chat.
  flowers.life = alive(living, () => {
    const holder = $("empty");
    return !document.hidden && !$("chat").hidden && !holder.hidden && !isLeaving(holder) && !holder.classList.contains("typing") && !document.querySelector("dialog[open]");
  });
  watchDialogs(() => { hostToast(); checkFlower(); });
}

function checkFlower() {
  flowers.life?.check();
}

/** The field is as tall as what is typed (to 40% of the screen), and goes from one height to the next on the app's resize spring. */
function autoGrow(animate = true) {
  const input = $("input");
  const from = input.offsetHeight;
  for (const running of input.getAnimations?.() ?? []) running.cancel();
  input.style.height = "auto";
  const to = Math.min(input.scrollHeight, Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.4));
  input.style.height = `${to}px`;
  if (animate && from && Math.abs(to - from) > 1 && !$("chat").hidden) move(input, [{ height: `${from}px` }, { height: `${to}px` }], { ms: 330, curve: "--resize" });
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
  // On a phone the keyboard goes away as the message is sent, and the reply has the screen (as in the app).
  if (matchMedia("(pointer: coarse)").matches) input.blur();
  const message = { role: "user", text };
  if (state.draft.length) {
    message.attachments = state.draft;
    state.draft = [];
    renderTray();
  }
  state.chat.messages.push(message);
  state.chat.updatedAt = Date.now();
  // The bubble rises out of the bar it was written in, and the empty chat's flower goes.
  const sent = messageElement(message);
  sent.classList.add("fresh");
  $("messages").append(sent);
  present($("empty"), false);
  saveChat();
  setLastOpen(state.chat.id);
  renderHistory();
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

/** Stops the reply being written; settles once the relay heard of it (for a kept reply). */
function stop() {
  const run = state.streaming;
  if (!run) return Promise.resolve();
  run.controller.abort();
  // A kept reply goes on at the relay without its connection: it is stopped there too.
  return forgetReply(run);
}

/**
 * The relay lets go of a kept reply: stopped if it is still being written,
 * or never begun if the question hasn't got there yet. Once per reply, with
 * the sign-in it was asked under (signing out clears the tab's first).
 */
function forgetReply(run) {
  if (!run.reply) return Promise.resolve();
  run.forgetting ??= dropReply(run.reply, session.get()?.token ?? run.token);
  return run.forgetting;
}

function dropReply(key, token) {
  const send = () => call(`/v1/replies/${key}`, { method: "DELETE", ...(token ? { token } : {}) });
  return send().then(() => {}, () => {
    // No connection now: once more when there is one (else the relay lets it go by itself, within 40 minutes).
    if (navigator.onLine === false) addEventListener("online", () => { send().catch(() => {}); }, { once: true });
  });
}

function newReplyKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** How long after its last save a reply cut off by a reload is still looked for at the relay (it keeps one 10 minutes after it ended). */
const CUT_REPLY_MS = 40 * 60 * 1000;

/** Resolves once the page is shown and online: Safari runs nothing for a page in the background. */
function whenReachable(signal) {
  return new Promise((resolve, reject) => {
    const ready = () => !document.hidden && navigator.onLine !== false;
    const stopped = () => new DOMException("stopped", "AbortError");
    if (signal.aborted) { reject(stopped()); return; }
    if (ready()) { resolve(); return; }
    const done = () => {
      document.removeEventListener("visibilitychange", check);
      removeEventListener("online", check);
      removeEventListener("pageshow", check);
      signal.removeEventListener("abort", aborted);
    };
    const check = () => { if (ready()) { done(); resolve(); } };
    const aborted = () => { done(); reject(stopped()); };
    document.addEventListener("visibilitychange", check);
    addEventListener("online", check);
    addEventListener("pageshow", check);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("stopped", "AbortError")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    const aborted = () => { clearTimeout(timer); reject(new DOMException("stopped", "AbortError")); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * While this tab writes a kept reply, no other tab picks it up (a copy of
 * this tab's storage, as Safari's 「タブを複製」 makes, would). `waitMs`:
 * how long to wait for it at most (the page before a reload lets go of it
 * a moment after the new one starts); then `work` doesn't run.
 */
function holdingReply(id, work, waitMs = Infinity) {
  if (!navigator.locks?.request) return work();
  const options = Number.isFinite(waitMs) && typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(waitMs) } : {};
  return navigator.locks.request(`fielua-reply-${id}`, options, () => work())
    .catch((error) => { if (!options.signal?.aborted || error !== options.signal.reason) throw error; });
}

/**
 * A reply being written into `message`: its pace, its checkpoints in the
 * history, and its end. `known`: the length of text the message already
 * shows (a reply read again from its start after a reload): until the
 * reply gets that far again, nothing is redrawn.
 */
function beginRun(message, element, chat, known = 0, controller = new AbortController()) {
  const entry = state.views.get(message);
  entry.reply.setAttribute("aria-busy", "true");
  const thinking = h("div", { class: "thinking" }, h("span", { class: "glow", "aria-hidden": "true" }), h("span", { class: "label", text: "" }));
  if (!known) element.append(thinking);
  const pacer = new Pacer();
  const run = {
    controller, message, chat, pacer, entry, thinking, known, shownAt: 0, rendered: -1, lastRender: 0, ended: false, frame: 0, reply: null,
    token: session.get()?.token ?? null,
  };
  state.streaming = run;
  updateComposer();
  renderHistory();
  // What has come so far goes into the history every few seconds (a closed tab keeps it, as 停止しました).
  run.checkpoint = setInterval(() => {
    if (!pacer.text || message.text === pacer.text || pacer.text.length < run.known) return;
    message.text = pacer.text;
    saveChat(chat);
  }, 3000);

  run.render = (force = false) => {
    const now = performance.now();
    if (run.known) {
      // Read again from the start: what the message shows already stays as it is until the reply
      // passes it (ended short of it, it broke off at the relay: finish keeps what was shown),
      // and is never laid out again.
      if (pacer.text.length < run.known) {
        if (run.ended) { run.finish(); return; }
        pacer.shown = pacer.text.length;
        pacer.lastTick = now / 1000;
        run.frame = requestAnimationFrame(() => run.render());
        return;
      }
      if (pacer.shown < run.known) { pacer.shown = run.known; pacer.carry = 0; }
    }
    if (thinking.isConnected && pacer.text.length > 0) {
      // The first words are ready: the light shrinks to nothing, and they come where it was.
      if (!isLeaving(thinking)) dismiss(thinking);
      if (thinking.isConnected && !force) {
        pacer.lastTick = now / 1000;
        run.frame = requestAnimationFrame(() => run.render());
        return;
      }
    }
    const shown = pacer.advance(now / 1000);
    // About 24 steps a second, fewer as a reply grows very long (the app's ReplyPacer.interval).
    const interval = 1000 / 24 + Math.min(pacer.text.length / 16000, 1) * (100 - 1000 / 24);
    if (shown !== run.rendered && (force || now - run.lastRender >= interval || pacer.finished)) {
      const wasPinned = isPinned();
      entry.view.update(pacer.text.slice(0, shown), { live: !pacer.finished, animate: true });
      run.rendered = shown;
      run.lastRender = now;
      if (shown > 0) thinking.remove();
      if (wasPinned && !finger.touching) scrollToEnd(false);
    }
    if (run.ended && pacer.finished) { run.finish(); return; }
    run.frame = requestAnimationFrame(() => run.render());
  };

  run.finish = () => {
    if (run.finished) return;
    run.finished = true;
    cancelAnimationFrame(run.frame);
    clearInterval(run.checkpoint);
    run.unwatch?.();
    // Read again but ended before it got as far as before (it broke off at the relay): what the message showed stays.
    if (pacer.text.length < run.known) pacer.text = message.text;
    // The last chunk drawn once more as finished text (unchanged chunks stay as they are).
    pacer.shown = pacer.text.length;
    entry.view.update(pacer.text, { live: false, animate: true });
    message.text = pacer.text;
    if (message.end === "streaming") message.end = "done";
    message.activity = null;
    for (const file of message.files ?? []) file.madeAt ??= Date.now();
    state.streaming = null;
    finishElement(message, true);
    // Spoken only (the reply itself is not read out letter by letter): it has come.
    const said = $("announce");
    said.textContent = "";
    if (!message.error && message.text && chat === state.chat) requestAnimationFrame(() => { said.textContent = "返信が届きました"; });
    if (message.files?.length) loadFileInfo(message, chat);
    saveChat(chat);
    updateComposer();
    renderHistory();
    if (isPinned(160) && !finger.touching) scrollToEnd(false);
    refreshStatus();
  };

  run.fail = (text, end = "failed") => {
    message.error = text;
    message.end = end;
  };
  return run;
}

/** Asks Claude about the conversation so far and lays its reply out as it comes. */
async function ask() {
  const { model, effort } = choice();
  const turns = contextTurns(state.chat.messages);
  if (!turns.length) return;
  if (turns.some((turn) => bytes(turn.content) > MAX_TURN_BYTES)) { toast("メッセージが長すぎます。新しい会話でお試しください。"); return; }
  const tools = toolsFor();
  const message = { role: "assistant", text: "", model: model.id, effort, end: "streaming", ...(tools ? { search: null, files: [] } : {}), ...(turns.dropped ? { trimmed: turns.dropped } : {}) };
  state.chat.messages.push(message);
  const element = messageElement(message);
  element.classList.add("fresh");
  $("messages").append(element);
  scrollToEnd(true);
  const run = beginRun(message, element, state.chat);
  const { controller, pacer } = run;
  // A reply the relay keeps (when it can): Safari's background no longer ends it. Its key is
  // kept with the message before it is asked, so a reload while Claude thinks picks it up again.
  const key = state.status?.resumable === true ? newReplyKey() : null;
  if (key) {
    run.reply = key;
    message.reply = key;
    saveChat(run.chat);
  }

  let response;
  try {
    response = await call(key ? `/v1/replies/${key}` : "/v1/messages", { method: "POST", body: { messages: turns, model: model.id, effort, ...(tools ? { tools } : {}) }, signal: controller.signal });
  } catch (error) {
    // No answer came (Safari went to the background at once, say): the relay may have the reply all the same.
    // With no connection at all, the question most likely never left: said at once, as before.
    if (key && error?.name !== "AbortError" && navigator.onLine !== false) { await holdingReply(key, () => follow(run, null, error)); return; }
    if (error?.name === "AbortError") message.end = "stopped";
    else run.fail(errorText(0, "network"));
    forgetReply(run);
    delete message.reply;
    run.ended = true;
    pacer.generating = false;
    run.finish();
    return;
  }
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (response.status === 401) {
      clearInterval(run.checkpoint);
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
      if (!hasQuestion(state.chat)) {
        // It was this conversation's first question: its line in the history goes too (the question is back in the composer).
        const id = state.chat.id;
        const whose = archive.ownerTag();
        historySaves.delete(id);
        if (lastOpen() === id) setLastOpen("");
        // Before the lock that follows the sign-out (it waits for this chain); only in that person's history.
        historyWriting = historyWriting.catch(() => {}).then(() => (whose && archive.ownerTag() === whose ? archive.remove(id) : null)).catch(() => {});
        // The question goes again later as a conversation of its own (its old id is marked deleted),
        // and only for this person (see holdChat).
        state.chat = blankChat();
        state.chat.owner = whose;
        sessionStorage.removeItem("fielua.chat");
      }
      signedOut();
      showLogin("main", errorText(401, "unauthorized"));
      return;
    }
    if (controller.signal.aborted) message.end = "stopped";
    else run.fail(errorText(response.status, body.error, body));
    delete message.reply;
    run.ended = true;
    pacer.generating = false;
    run.finish();
    if (body.error === "unavailable") refreshStatus();
    return;
  }
  if (key) await holdingReply(key, () => follow(run, response));
  else await follow(run, response);
}

/**
 * Safari reloaded the page (it may, after a while in the background) while
 * a reply was still coming: the relay still has it, so it is read again
 * from its start into the same message, and on to its end. Only after the
 * history is open (a newer copy from another tab, or a deletion there,
 * wins), and only this tab's own copy.
 */
async function resumeCutReply(unlocked) {
  const chat = state.chat;
  const message = chat.messages[chat.messages.length - 1];
  const key = message?.role === "assistant" ? message.cutReply : null;
  if (!key) return;
  await Promise.resolve(unlocked).catch(() => {});
  const usable = () => state.chat === chat && isLast(message) && !state.streaming && !!session.get() && state.views.has(message);
  if (!usable() || Date.now() - (chat.savedAt ?? 0) > CUT_REPLY_MS) { delete message.cutReply; return; }
  const controller = new AbortController();
  await holdingReply(key, async () => {
    let response = null;
    // As a broken connection is: once the page is back, a few tries, until the relay says it has none.
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await whenReachable(controller.signal); } catch { break; }
      if (!usable()) break;
      try { response = await call(`/v1/replies/${key}`, { signal: controller.signal }); } catch { response = null; }
      if (response?.ok && response.body) break;
      const gone = response && response.status !== 409 && response.status !== 429 && response.status < 500;
      response?.body?.cancel().catch(() => {});
      response = null;
      if (gone) break;
      try { await pause(Math.min(1000 * 2 ** attempt, 8000), controller.signal); } catch { break; }
    }
    delete message.cutReply;
    if (!response || !usable()) {
      response?.body?.cancel().catch(() => {});
      // It stays as it was, stopped; if the relay still writes it, it stops there too.
      dropReply(key, session.get()?.token);
      return;
    }
    const entry = state.views.get(message);
    const known = message.text.length;
    // The search and the files it named come again as it is read; each is taken once.
    Object.assign(message, { end: "streaming", error: undefined, unfinished: false, activity: null, reply: key });
    finishElement(message);
    const run = beginRun(message, entry.element, chat, known, controller);
    run.reply = key;
    await follow(run, response);
  }, 5000);
}

/** Reads a reply's events into its run, to the end; a kept reply over as many connections as it takes. */
async function follow(run, response, unanswered = null) {
  const { controller, message, chat, pacer, thinking } = run;
  run.frame = requestAnimationFrame(() => run.render());
  let sawDone = false;
  // The server tools' blocks by index (their input comes in pieces), and whether text follows one.
  const toolBlocks = new Map();
  let afterTool = false;
  const keepContainer = (id) => {
    if (id && chat.container !== id) { chat.container = id; chat.containerAt = Date.now(); saveChat(chat); }
  };
  const working = (activity) => {
    message.activity = activity;
    renderWork(message);
  };

  // A kept reply: its connection broken (Safari in the background, a lost network), it is asked for
  // again once the page is back, and the events go on where they were.
  const follower = { renew: () => {}, receivedAt: Date.now() };
  const reopen = !run.reply ? null : async (error) => {
    if (controller.signal.aborted) throw error;
    const before = message.activity;
    working({ kind: "reconnect" });
    try {
      for (let attempt = 0; ; attempt++) {
        await whenReachable(controller.signal);
        let again = null;
        try {
          again = await call(`/v1/replies/${run.reply}`, { signal: controller.signal });
        } catch (failure) {
          if (failure?.name === "AbortError") throw failure;
        }
        if (again?.ok && again.body) { follower.receivedAt = Date.now(); return again.body; }
        again?.body?.cancel().catch(() => {});
        // Gone at the relay (or the sign-in ran out): ends as any broken reply does. 409: Anthropic hasn't begun yet.
        if (again && again.status !== 409 && again.status !== 429 && again.status < 500) throw error;
        if (attempt >= 5) throw error;
        await pause(Math.min(1000 * 2 ** attempt, 8000), controller.signal);
      }
    } finally {
      if (message.activity?.kind === "reconnect") working(before);
    }
  };
  if (reopen) {
    // Back after a while away, or nothing for a minute: a new connection, in case the old one died quietly.
    let hiddenAt = document.hidden ? Date.now() : 0;
    const onVisibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt >= 3000) follower.renew();
      hiddenAt = 0;
    };
    const stall = setInterval(() => {
      if (document.hidden || navigator.onLine === false || Date.now() - follower.receivedAt < 60_000) return;
      follower.receivedAt = Date.now();
      follower.renew();
    }, 10_000);
    document.addEventListener("visibilitychange", onVisibility);
    run.unwatch = () => {
      clearInterval(stall);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  let heard = false;
  try {
    // The question got no answer: the reply is looked for at the relay from the start.
    const body = response ? response.body : await reopen(unanswered);
    for await (const event of readEvents(body, reopen, follower)) {
      heard = true;
      if (event.type === "started") { message.served = event.model; keepContainer(event.container); }
      else if (event.type === "thinking") {
        const label = thinking.querySelector(".label");
        if (label && !label.textContent) label.textContent = "考えています";
      } else if (event.type === "textStart") {
        // Text after a search or code starts a paragraph of its own; text between citations runs on.
        if (afterTool && pacer.text && !pacer.text.endsWith("\n")) pacer.text += "\n\n";
        afterTool = false;
        if (message.activity) working(null);
        pacer.text += event.text;
      } else if (event.type === "text") pacer.text += event.text;
      else if (event.type === "toolStart") {
        toolBlocks.set(event.index, { name: event.name, json: "" });
        afterTool = true;
        const kinds = { web_search: "search", web_fetch: "fetch", text_editor_code_execution: "edit" };
        working({ kind: kinds[event.name] ?? "code", query: "" });
      } else if (event.type === "toolInput") {
        const block = toolBlocks.get(event.index);
        if (block) block.json += event.json;
      } else if (event.type === "blockStop") {
        const block = toolBlocks.get(event.index);
        toolBlocks.delete(event.index);
        if (block?.name === "web_search") {
          let query = "";
          try { query = String(JSON.parse(block.json || "{}").query ?? "").trim(); } catch { query = ""; }
          if (query) {
            message.search ??= { queries: [], pages: [], failed: null };
            if (!message.search.queries.includes(query) && message.search.queries.length < 10) message.search.queries.push(query);
            working({ kind: "search", query });
          }
        }
      } else if (event.type === "searchResults") addPages(message, event.pages, false);
      else if (event.type === "searchFailed") { message.search ??= { queries: [], pages: [], failed: null }; message.search.failed = event.code; }
      else if (event.type === "cited") addPages(message, [event.page], true);
      else if (event.type === "files") {
        message.files ??= [];
        for (const id of event.ids) if (!message.files.some((file) => file.id === id) && message.files.length < 20) message.files.push({ id });
      } else if (event.type === "container") keepContainer(event.container);
      else if (event.type === "paused") { keepContainer(event.container); message.end = "paused"; }
      else if (event.type === "refused") message.end = "refused";
      else if (event.type === "cutOff") message.end = "cutOff";
      else if (event.type === "failed") {
        run.fail(event.error === "overloaded_error"
          ? "Claude が混み合っているため、途中で止まりました。"
          : "Claude との接続が切れました。");
      } else if (event.type === "done") { sawDone = true; break; }
    }
    if (!sawDone && !message.error && message.end === "streaming") run.fail("Claude との接続が切れました。");
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      message.end = "stopped";
    } else if (!message.error) {
      // Never reached the relay (or it never began): as a question that couldn't be sent.
      run.fail(unanswered && !heard ? errorText(0, "network") : "Claude との接続が切れました。");
    }
  }
  run.unwatch?.();
  // The page has the reply (or it is over): the relay lets go of it.
  forgetReply(run);
  delete message.reply;
  if (controller.signal.aborted && message.end === "streaming") message.end = "stopped";
  pacer.generating = false;
  run.ended = true;
  // Stopped: what has come shows at once, nothing more is laid out.
  if (message.end === "stopped" || document.hidden) pacer.shown = pacer.text.length;
  if (document.hidden) run.finish();
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

/** A finger on the conversation: the page never moves it from under the finger (Safari would stutter, or drop the gesture). */
const finger = { touching: false };

function wireScroller() {
  const scroller = $("scroller");
  let pinned = true;
  let atEnd = false;
  let from = 0;
  scroller.addEventListener("touchstart", () => { finger.touching = true; atEnd = isPinned(); from = scroller.scrollTop; }, { passive: true });
  const lifted = (event) => {
    finger.touching = event.touches.length > 0;
    // What came under a resting finger is caught up with; a reader who moved up is left there.
    if (!finger.touching && atEnd && state.streaming && scroller.scrollTop >= from - 8) scrollToEnd(false);
  };
  scroller.addEventListener("touchend", lifted, { passive: true });
  scroller.addEventListener("touchcancel", lifted, { passive: true });
  const update = () => {
    pinned = isPinned();
    $("chat").classList.toggle("scrolled", scroller.scrollTop > 4);
    present($("jump"), !isPinned(200));
  };
  scroller.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe($("messages"));
  // What stands under the conversation grew or shrank (more lines typed, attachments, a notice, the keyboard):
  // a conversation that was at its end stays at its end.
  new ResizeObserver(() => { if (pinned) scrollToEnd(false); update(); }).observe(scroller);
  $("jump").addEventListener("click", () => scrollToEnd(true));
  // The top bar and the field lie over the conversation: a wheel turned there turns the conversation.
  const turn = (event) => {
    if (event.ctrlKey || !event.deltaY || event.target.closest(".tray, .attach-menu")) return;
    const field = event.target.closest("textarea");
    if (field && field.scrollHeight > field.clientHeight + 1) return;
    scroller.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
  };
  for (const part of [document.querySelector(".topbar"), document.querySelector(".composer-area")]) part?.addEventListener("wheel", turn, { passive: true });
  // Page Up and Page Down read back from the field, with the caret staying in it.
  $("input").addEventListener("keydown", (event) => {
    if ((event.key !== "PageUp" && event.key !== "PageDown") || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    scroller.scrollBy({ top: (event.key === "PageUp" ? -1 : 1) * scroller.clientHeight * 0.85, behavior: still() ? "auto" : "smooth" });
  });
}

/** iPhone Safari's keyboard: the chat follows the visible area, so the composer stays above it. */
function wireViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const chat = $("chat");
  const update = () => {
    // Zoomed in with two fingers: the visible area is smaller, but no keyboard came.
    if (Math.abs((viewport.scale ?? 1) - 1) > 0.01) return;
    const keyboard = window.innerHeight - viewport.height > 120;
    // The list's search on a phone: the list follows the keyboard, the chat beside it stays where it is (as on the iPhone).
    const listOnly = keyboard && drawer.open && !wide.matches;
    chat.classList.toggle("keyboard", keyboard && !listOnly);
    // What floats over the page (the toast) follows the visible area too.
    document.documentElement.style.setProperty("--vv-top", keyboard ? `${viewport.offsetTop}px` : "0px");
    $("chat-panel").style.height = listOnly ? `${window.innerHeight}px` : "";
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

/** The rows stay while the sheet is open: a choice only moves the check (and the keyboard keeps its place). */
function renderModelSheet() {
  const { model: current, effort: currentEffort } = choice();
  const models = catalog();
  const pick = (change) => { change(); savePrefs(); renderModelSheet(); renderTopbar(); };
  const check = () => h("span", { class: "check", "aria-hidden": "true" });
  const list = $("model-list");
  const rows = models.map((model) => `${model.id}:${model.name}`).join("\n");
  if (list.dataset.rows !== rows) {
    list.dataset.rows = rows;
    list.replaceChildren(...models.map((model) => h("button", {
      type: "button", class: "choice", role: "radio",
      onclick: () => pick(() => { state.prefs.model = model.id; }),
    }, h("span", { class: "body" }, h("span", { class: "title" }, model.name), h("span", { class: "sub" })), check())));
  }
  models.forEach((model, index) => {
    const row = list.children[index];
    const level = model.id === current.id ? currentEffort
      : (model.efforts.includes(state.prefs.efforts[model.id]) ? state.prefs.efforts[model.id] : startEffort(model));
    const sub = model.available === false ? "今は Anthropic で使えません"
      : `推論レベル ${EFFORT[level]?.title ?? level}${model.available === null ? " · 使えるか未確認" : ""}`;
    row.setAttribute("aria-checked", model.id === current.id ? "true" : "false");
    row.disabled = !usable(model);
    const line = row.querySelector(".sub");
    if (line.textContent !== sub) line.textContent = sub;
  });
  const efforts = $("effort-list");
  if (!efforts.children.length) {
    efforts.replaceChildren(...EFFORTS.map((level) => h("button", {
      type: "button", class: "choice", role: "radio",
      onclick: () => pick(() => { state.prefs.efforts[choice().model.id] = level; }),
    }, h("span", { class: "body" }, h("span", { class: "title" }, EFFORT[level].title)), check())));
  }
  EFFORTS.forEach((level, index) => {
    const row = efforts.children[index];
    const offered = current.efforts.includes(level);
    row.setAttribute("aria-checked", level === currentEffort ? "true" : "false");
    row.disabled = !offered;
    // 標準 beside the model's own level, and a line under one it does not take.
    const tag = row.querySelector(".tag");
    if (startEffort(current) !== level) tag?.remove();
    else if (!tag) row.querySelector(".title").append(h("span", { class: "tag", text: "標準" }));
    const line = row.querySelector(".sub");
    if (offered) line?.remove();
    else if (!line) row.querySelector(".body").append(h("span", { class: "sub", text: "このモデルでは使えません" }));
  });
  for (const group of [list, efforts]) oneTabStop(group, ".choice", (row) => row.getAttribute("aria-checked") === "true");
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
      h("p", { text: `${formatTime(credit.setAt)} の残高 ${formatUSD(credit.budgetUSD)} · それ以降に使った分 約 ${formatUSD(credit.spentUSD)}` }),
      state.status?.reason === "paused_billing" ? h("p", { text: "Anthropic でクレジットが切れています。" }) : null));
  } else {
    items.push(h("div", { class: "card" }, h("p", { text: "残りのクレジットはまだ入力されていません。" })));
  }
  if (developer) items.push(creditControls(credit));
  body.replaceChildren(...items);
}

function creditControls(credit) {
  const amount = h("input", { type: "text", inputmode: "decimal", enterkeyhint: "done", placeholder: "例：25.00", "aria-label": "Console に出ている残高（米ドル）" });
  const save = h("button", {
    type: "button", class: "secondary", text: "保存",
    onclick: async () => {
      const value = Number(amount.value.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(value) || value <= 0 || value > 100000) { toast("0 より大きい金額（米ドル）を入れてください"); return; }
      const done = await adminCall("/admin/settings", { method: "POST", body: { creditUSD: Math.round(value * 100) / 100 } });
      if (done) { await refreshStatus(); renderCreditSheet(); toast("残高を保存しました"); }
    },
  });
  enterPresses(amount, save);
  const friends = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "友人にも残りを表示", checked: credit?.friends ? true : null });
  friends.addEventListener("change", async () => {
    const done = await adminCall("/admin/settings", { method: "POST", body: { creditFriends: friends.checked } });
    if (!done) friends.checked = !friends.checked;
  });
  return h("div", { class: "card" },
    h("p", { text: "Console（Billing）の残高（米ドル）" }),
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
        const ok = await confirmDialog({ title: "もう一度パスキーで確認", ok: "確認する" });
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
    case "not_found": return "見つかりませんでした。";
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
    status?.web?.expiresAt ? h("p", { class: "muted", text: `${formatTime(status.web.expiresAt)} までログイン中` }) : null,
    h("div", { class: "row-actions" },
      h("button", { type: "button", class: "secondary", text: "ログアウト", onclick: logout }),
      h("button", { type: "button", class: "secondary danger", text: "登録を解除", onclick: leave }))));
  items.push(h("p", { class: "section-label", text: "送られる内容" }));
  items.push(h("div", { class: "card" },
    h("p", { text: "メッセージと添付は中継サーバー（Cloudflare）を通って Anthropic に送られ、外部 AI の Claude が答えます。" }),
    h("p", { class: "muted", text: "中継サーバーは会話を保存しません。Anthropic は API の利用データを一定期間保持します。" })));
  // Opened just now: what needs no waiting shows at once, and the rest comes in under it.
  const opening = body.dataset.opening === "1";
  delete body.dataset.opening;
  if (opening) body.replaceChildren(...items);
  const rest = [...await historySection()];
  if ((status?.role ?? me?.role) === "developer") rest.push(...await developerSection());
  if (opening) for (const item of rest) item.classList.add("arriving");
  body.replaceChildren(...items, ...rest);
}

/** 設定 › 会話履歴: where it is kept, and deleting it all. */
async function historySection() {
  const section = [h("p", { class: "section-label", text: "会話履歴" })];
  const open = archive.isOpen();
  const count = open ? (await archive.list().catch(() => [])).length : 0;
  const note = h("p", { class: "muted", role: "status" });
  const removeAll = h("button", {
    type: "button", class: "secondary danger", text: "この端末の履歴をすべて削除", disabled: !count,
    onclick: async () => {
      // Said in the card (a toast would sit under this sheet).
      if (state.streaming) { note.textContent = "返信を書き終えると削除できます。"; return; }
      note.textContent = "";
      const ok = await confirmDialog({
        title: `${count}件の会話を削除しますか？`,
        body: ["この端末の会話履歴がすべて消えます。この操作は取り消せません。"],
        ok: "削除", danger: true,
      });
      if (!ok || state.streaming) return;
      historySaves.clear();
      try {
        if (!archive.isOpen()) throw new Error("locked");
        await archive.removeAll();
      } catch {
        note.textContent = "会話履歴を削除できませんでした。";
        return;
      }
      for (const chat of liveChats.values()) chat.messages.forEach((message) => message.attachments?.forEach(release));
      liveChats.clear();
      sessionStorage.removeItem("fielua.chat");
      state.chat.messages.forEach((message) => message.attachments?.forEach(release));
      state.chat = blankChat();
      setLastOpen("");
      clearDraft();
      renderThread();
      updateComposer();
      renderHistory();
      if ($("settings-sheet").open) renderSettings();
      else toast("会話履歴を削除しました。");
    },
  });
  section.push(h("div", { class: "card" },
    open
      ? h("p", { text: "会話はこの端末にだけ、暗号化して残ります。" })
      : h("p", { text: drawer.failed ? "会話履歴を読み込めませんでした。今の会話はタブを閉じると消えます。" : "この端末では会話履歴を保存できません。今の会話はタブを閉じると消えます。" }),
    open ? h("p", { class: "muted", text: "Safari では 7 日ほど開かないと消えることがあります。" }) : null,
    open ? h("p", { class: "muted", text: `${count}件の会話` }) : null,
    open ? h("div", { class: "row-actions" }, removeAll) : null,
    note));
  return section;
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
    paused ? h("div", { class: "row-actions" }, h("button", {
      type: "button", class: "secondary", text: "再開する",
      onclick: async () => { if (await adminCall("/admin/settings", { method: "POST", body: { resume: true } })) { await refreshStatus(); renderSettings(); } },
    })) : null));
  // The credit left.
  section.push(h("div", { class: "card" },
    h("p", { text: adminState.credit ? `クレジットの残り：推定 ${Math.round(adminState.credit.percent)}%（約 ${formatUSD(adminState.credit.remainingUSD)}）` : "クレジットの残りは未入力です。" }),
    h("div", { class: "row-actions" }, h("button", { type: "button", class: "secondary", text: "残高を入力・変更", onclick: () => { closeDialog($("settings-sheet")); openSheet("credit-sheet"); } }))));
  // Friends.
  const friendsSwitch = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "友人の利用", checked: settings.friendsEnabled ? true : null });
  friendsSwitch.addEventListener("change", async () => {
    if (friendsSwitch.checked) {
      const ok = await confirmDialog({
        title: "友人の利用をオンにする",
        body: ["オンにする前に、Anthropic の商用利用規約と利用ポリシー（AI であることの明示、18 歳未満への提供など）を確かめてください。"],
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
    h("div", { class: "switch-row" }, h("span", { text: "友人の利用" }), friendsSwitch)));
  // Invites.
  const name = h("input", { type: "text", maxlength: "40", enterkeyhint: "done", placeholder: "招待する人の名前", "aria-label": "招待する人の名前" });
  const role = h("select", { "aria-label": "役割", class: "role-select" }, h("option", { value: "friend", text: "友人" }), h("option", { value: "developer", text: "開発者" }));
  const made = h("div");
  const make = h("button", {
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
    });
  enterPresses(name, make);
  section.push(h("div", { class: "card" },
    h("div", { class: "inline-field" }, name, role, make),
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
          const ok = await confirmDialog({ title: `${user.name} を削除`, body: ["登録とパスキーの記録が消えます。また使うには新しい招待が必要です。"], ok: "削除", danger: true });
          if (ok && await adminCall(`/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" })) renderSettings();
        },
      })))))));
  return section;
}

async function logout() {
  const token = session.get()?.token;
  // A kept reply is stopped at the relay while the sign-in still counts there.
  const stopped = stop();
  signedOut();
  forgetChat();
  clearDraft();
  if (token) stopped.finally(() => call("/web/logout", { method: "POST", body: {}, token }).catch(() => {}));
  closeSheets();
  showLogin("main", "ログアウトしました。", "note");
}

async function leave() {
  const ok = await confirmDialog({
    title: "登録を解除",
    body: ["登録とパスキーの記録が消え、このアカウントは使えなくなります。この端末の会話履歴も消えます。"],
    ok: "登録を解除", danger: true,
  });
  if (!ok) return;
  // Which database is this person's (asked now if the key didn't come at sign-in), before the key goes.
  if (!archive.isOpen()) await unlockHistory().catch(() => {});
  // A kept reply is stopped at the relay while this person is still registered there.
  await Promise.race([stop(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  try {
    await callJSON("/v1/leave", { method: "POST", body: {} });
  } catch (error) {
    toast(error instanceof RelayError ? errorText(error.status, error.code) : "解除できませんでした");
    return;
  }
  // The relay's key is gone with the registration: this device's history goes too.
  stop();
  historySaves.clear();
  setLastOpen("");
  await archive.destroy();
  signedOut();
  forgetChat();
  clearDraft();
  closeSheets();
  showLogin("main", "登録を解除しました。", "note");
}

// MARK: 会話一覧 (the iPhone app's history)

const drawer = {
  /** null until known; false when this device can't keep a history (an older relay, no IndexedDB). */
  available: null,
  /** The key didn't come (no connection, the relay busy): tried again when the page is back online or in view. */
  failed: false,
  /** On a phone: whether the list is open (the chat slid aside). */
  open: false,
  searching: false,
  query: "",
  /** Each conversation's text for searching, read when a search starts. */
  texts: null,
  /** The row whose menu is open. */
  menuFor: null,
};
const wide = matchMedia("(min-width: 1000px)");
const docked = () => wide.matches && state.prefs.historyDocked !== false;
/** Conversations opened in this tab, as they are on the page (their attachments' data kept for a later question). */
const liveChats = new Map();
const LIVE_CHATS = 6;
const normalize = (text) => String(text ?? "").normalize("NFKC").toLowerCase();
const hasQuestion = (chat) => chat.messages.some((message) => message.role === "user");

const lastOpenKey = () => `fielua.last.${archive.ownerTag()}`;
function lastOpen() {
  try { return localStorage.getItem(lastOpenKey()) ?? ""; } catch { return ""; }
}
function setLastOpen(id) {
  if (!archive.isOpen()) return;
  try { if (id) localStorage.setItem(lastOpenKey(), id); else localStorage.removeItem(lastOpenKey()); } catch { /* private mode */ }
}

let unlocking = null;
/** After sign-in: this person's history unlocked, and the conversation that was open last opened again (once at a time). */
function unlockHistory() {
  if (archive.isOpen() || !session.get()) return Promise.resolve();
  unlocking ??= openHistory().finally(() => { unlocking = null; });
  return unlocking;
}

/** The conversation left in this tab from before a new sign-in (with its unsent text), until the key says whose it is. */
let held = null;
function holdChat() {
  dropHeld();
  if (state.streaming) return;
  const text = $("input").value;
  if (!state.chat.messages.length && !text.trim() && !state.draft.length) return;
  held = { chat: state.chat, text, draft: state.draft };
  state.draft = [];
  renderTray();
  $("input").value = "";
  autoGrow();
  sessionStorage.removeItem("fielua.chat");
  state.chat = blankChat();
}
function dropHeld() {
  if (!held) return;
  held.chat.messages.forEach((message) => message.attachments?.forEach(release));
  held.draft.forEach(release);
  held = null;
}

/** Conversations set aside by チャット while the key was still on its way: they go into the history once it comes. */
const waitingChats = new Map();

/** The key didn't come earlier (no connection): asked again once the page is back. */
function retryHistory() {
  if (drawer.available === null && drawer.failed && session.get() && !$("chat").hidden) unlockHistory();
}

async function openHistory() {
  const token = session.get()?.token;
  try {
    await archive.unlock();
  } catch (error) {
    if (session.get()?.token !== token) return;
    // No connection, or the relay busy for a moment: asked again later. An older relay, or no storage here: not this time.
    const passing = error instanceof RelayError && (error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500);
    drawer.available = passing ? null : false;
    drawer.failed = passing && error.status !== 401;
    if (!passing) { dropHeld(); waitingChats.clear(); }
    if (!(error instanceof RelayError)) console.warn("history", error?.name ?? error?.message ?? "unavailable");
    renderHistory();
    return;
  }
  // Signed out (or someone else signed in) meanwhile: that sign-in asks for its own key.
  if (!archive.isOpen() || !session.get() || session.get().token !== token) return;
  drawer.available = true;
  drawer.failed = false;
  const tag = archive.ownerTag();
  const typed = () => $("input").value.trim() || state.draft.length || state.preparing;
  if (held) {
    // This person's own conversation from before comes back with what they had written; anyone else's
    // (or one that can't be told, from a sign-in whose history never opened) goes.
    const { chat, text, draft } = held;
    held = null;
    if (chat.owner && chat.owner === tag && !state.chat.messages.length && !state.streaming && !typed()) {
      state.chat = chat;
      state.draft = draft;
      renderTray();
      $("input").value = text;
      autoGrow();
      saveChat(chat, { history: false });
      renderThread();
      updateComposer();
      renderTools();
    } else {
      chat.messages.forEach((message) => message.attachments?.forEach(release));
      draft.forEach(release);
    }
  }
  for (const chat of waitingChats.values()) {
    if (chat.owner && chat.owner !== tag) continue;
    remember(chat);
    keepInHistory(chat);
  }
  waitingChats.clear();
  if (state.chat.owner && state.chat.owner !== tag && !state.streaming) {
    // Someone else's conversation, left in this tab when their sign-in lapsed: neither shown to this person nor kept for them.
    forgetChat();
    clearDraft();
    $("input").value = "";
    autoGrow();
    renderThread();
    updateComposer();
    renderTools();
  }
  if (!state.chat.messages.length) {
    const id = lastOpen();
    const saved = id ? await archive.load(id).catch(() => null) : null;
    // Not over what is being written in the new chat meanwhile.
    if (saved && !state.chat.messages.length && !state.streaming && session.get() && !typed()) adopt(state.chat, saved);
  } else if (!state.streaming) {
    // The conversation open in this tab: this tab's copy or the history's, whichever is newer (another tab may have gone on with it).
    const chat = state.chat;
    const stored = await archive.load(chat.id).catch(() => null);
    if (state.chat !== chat || state.streaming || !archive.isOpen()) { renderHistory(); return; }
    const theirs = stored?.savedAt ?? 0;
    const ours = chat.savedAt ?? 0;
    if (!stored && archive.wasDeleted(chat.id)) {
      // Deleted in another tab since: it doesn't come back.
      sessionStorage.removeItem("fielua.chat");
      chat.messages.forEach((message) => message.attachments?.forEach(release));
      state.chat = blankChat();
      renderThread();
      updateComposer();
      renderTools();
    } else if (stored && (theirs > ours || (chat.picturesDropped && theirs === ours))) {
      adopt(chat, stored);
    } else {
      if (stored && chat.picturesDropped) carryPictures(stored, chat);
      delete chat.picturesDropped;
      liveChats.set(chat.id, chat);
      keepInHistory(chat);
      // The tab's copy carries whose it is now (a reload before the next change keeps that).
      saveChat(chat, { history: false });
      setLastOpen(chat.id);
    }
  } else {
    // A reply on its way (asked before the key came): it goes in.
    liveChats.set(state.chat.id, state.chat);
    keepInHistory(state.chat);
    saveChat(state.chat, { history: false });
    setLastOpen(state.chat.id);
  }
  renderHistory();
}

/** The history's copy of a conversation in place of the one on the page; what this tab still holds of its attachments stays. */
function adopt(stale, saved) {
  const chat = restoreChat(saved);
  delete chat.picturesDropped;
  stale.messages.forEach((message, index) => message.attachments?.forEach((attachment, at) => {
    const twin = chat.messages[index]?.attachments?.[at];
    if (stale.id === chat.id && twin && twin.name === attachment.name && twin.kind === attachment.kind) {
      // The history's picture where this tab's copy had to leave it out.
      if (!attachment.thumb && twin.thumb) attachment.thumb = twin.thumb;
      chat.messages[index].attachments[at] = attachment;
    } else release(attachment);
  }));
  if (liveChats.get(stale.id) === stale) liveChats.delete(stale.id);
  liveChats.set(chat.id, chat);
  state.chat = chat;
  saveChat(chat, { history: false });
  renderThread();
  updateComposer();
  renderTools();
  for (const message of chat.messages) if (message.files?.some((file) => !file.name)) loadFileInfo(message, chat);
}

/** The pictures this tab's copy had to leave out (its storage was full), from the history's copy. */
function carryPictures(from, to) {
  to.messages.forEach((message, index) => message.attachments?.forEach((attachment, at) => {
    const twin = from.messages?.[index]?.attachments?.[at];
    if (!attachment.thumb && twin?.thumb && twin.name === attachment.name) attachment.thumb = twin.thumb;
  }));
}

/** Another tab changed this person's history: deleted conversations go from this one too, a newer copy of the open one comes in. */
async function followOtherTab(change) {
  if (change.gone) {
    // 登録を解除 in another tab: this registration is over here too.
    historySaves.clear();
    signedOut();
    forgetChat();
    clearDraft();
    $("input").value = "";
    closeSheets();
    showLogin("main", "登録を解除しました。", "note");
    return;
  }
  drawer.texts = null;
  const open = state.chat;
  for (const [id, chat] of liveChats) {
    if (chat === open || (change.id !== null && change.id !== id)) continue;
    liveChats.delete(id);
    chat.messages.forEach((message) => message.attachments?.forEach(release));
  }
  if (change.deleted) {
    if (change.id === null) historySaves.clear();
    else historySaves.delete(change.id);
  }
  const touched = change.id === null || change.id === open.id;
  // A reply being written here goes on (and is kept); a conversation not yet in the history isn't anyone else's to change.
  if (touched && !state.streaming && hasQuestion(open)) {
    if (change.deleted) {
      historySaves.delete(open.id);
      liveChats.delete(open.id);
      sessionStorage.removeItem("fielua.chat");
      open.messages.forEach((message) => message.attachments?.forEach(release));
      state.chat = blankChat();
      renderThread();
      updateComposer();
      renderTools();
    } else {
      const stored = await archive.load(open.id).catch(() => null);
      // A reply still being written there (saved every 3 s) comes once it is done.
      const writing = stored?.messages?.some((message) => message.end === "streaming") && Date.now() - (stored.savedAt ?? 0) < 30_000;
      if (stored && !writing && state.chat === open && !state.streaming && (stored.savedAt ?? 0) > (open.savedAt ?? 0)) adopt(open, stored);
    }
  }
  renderHistory();
}

/** The session is over: what waits is written, then the history is locked and its list taken off the page. */
function signedOut() {
  session.clear();
  clearTimeout(expiryTimer);
  // A reply on its way stops here; what came of it is kept.
  syncStreaming();
  stop();
  const tag = archive.ownerTag();
  dropHeld();
  for (const chat of waitingChats.values()) chat.messages.forEach((message) => message.attachments?.forEach(release));
  waitingChats.clear();
  unlocking = null;
  // Nothing more is read from now on; the last writes still go, then the key goes.
  archive.retire();
  flushHistory().finally(() => { if (!session.get() && archive.ownerTag() === tag) archive.lock(); });
  for (const chat of liveChats.values()) if (chat !== state.chat) chat.messages.forEach((message) => message.attachments?.forEach(release));
  liveChats.clear();
  drawer.texts = null;
  drawer.available = null;
  drawer.failed = false;
  closeRowMenu();
  hideHistory();
  endSearch();
  $("history-list").replaceChildren();
  delete $("history-list").dataset.shape;
  $("history-empty").hidden = true;
}

function remember(chat) {
  if (!hasQuestion(chat)) return;
  liveChats.delete(chat.id);
  liveChats.set(chat.id, chat);
  while (liveChats.size > LIVE_CHATS) {
    const [oldest, kept] = liveChats.entries().next().value;
    if (kept === state.chat) { liveChats.delete(oldest); liveChats.set(oldest, kept); continue; }
    liveChats.delete(oldest);
    kept.messages.forEach((message) => message.attachments?.forEach(release));
  }
}

/** Switches the page to another conversation (none while a reply is being written). */
function showChat(chat) {
  state.chat = chat;
  clearDraft();
  const input = $("input");
  input.value = "";
  autoGrow();
  saveChat(chat, { history: false });
  renderThread();
  updateComposer();
  renderTools();
  for (const message of chat.messages) if (message.files?.some((file) => !file.name)) loadFileInfo(message, chat);
}

/** 新しいチャット: the conversation so far stays in the history; an empty one is simply kept, with what is being written (as on the iPhone). */
function startNewChat() {
  if (state.streaming) return;
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (!archive.isOpen() && drawer.available === null && session.get()) {
    // The key hasn't come yet (or no connection): the conversation so far waits on the page and goes into the history once it does.
    if (hasQuestion(state.chat)) {
      waitingChats.set(state.chat.id, state.chat);
      showChat(blankChat());
    }
    closeOnPhone();
    renderHistory();
    if (!coarse) $("input").focus();
    unlockHistory();
    return;
  }
  if (!archive.isOpen()) {
    startNewChatWithoutHistory(coarse);
    return;
  }
  if (state.chat.messages.length) {
    remember(state.chat);
    flushHistory();
    showChat(blankChat());
    setLastOpen("");
  }
  closeOnPhone();
  renderHistory();
  if (!coarse) $("input").focus();
}

/** On a phone the list goes once a chat is picked; beside a wide screen's chat it stays. */
function closeOnPhone() {
  if (!wide.matches) setDrawer(false);
}

/** Signed out: the list off the screen, without changing whether a wide screen shows it next time. */
function hideHistory() {
  const chat = $("chat");
  clearTimeout(drawerSettle);
  drawer.open = false;
  chat.classList.remove("docked", "history-shown", "history-animating");
  chat.style.removeProperty("--reveal");
  $("history").inert = true;
  $("chat-panel").inert = false;
  $("history-close").hidden = true;
  $("history-button").setAttribute("aria-expanded", "false");
}

/** Without a history (an older relay, or no storage here): as before, 元に戻す for a few seconds. */
function startNewChatWithoutHistory(coarse) {
  // An empty chat is simply kept, with what is being written.
  if (!state.chat.messages.length) { closeOnPhone(); return; }
  const previous = state.chat;
  sessionStorage.removeItem("fielua.chat");
  state.chat = blankChat();
  clearDraft();
  renderThread();
  updateComposer();
  closeOnPhone();
  if (!coarse) $("input").focus();
  if (!previous.messages.length) return;
  const letGo = setTimeout(() => previous.messages.forEach((message) => message.attachments?.forEach(release)), 7000);
  toast("新しい会話にしました。", {
    label: "元に戻す",
    run: () => {
      clearTimeout(letGo);
      if (state.streaming || state.chat.messages.length || !session.get()) { previous.messages.forEach((message) => message.attachments?.forEach(release)); return; }
      state.chat = previous;
      saveChat();
      renderThread();
      updateComposer();
    },
  });
}

async function openChat(id) {
  closeRowMenu();
  // The open one: back to it (also while its reply is being written).
  if (id === state.chat.id) { closeOnPhone(); return; }
  if (state.streaming) return;
  let chat = liveChats.get(id);
  if (!chat) {
    const saved = await archive.load(id).catch(() => null);
    if (!saved) { toast("この会話を開けませんでした。"); renderHistory(); return; }
    chat = restoreChat(saved);
  }
  if (state.streaming || !session.get()) return;
  remember(state.chat);
  flushHistory();
  remember(chat);
  showChat(chat);
  setLastOpen(chat.id);
  closeOnPhone();
  renderHistory();
  if (!matchMedia("(pointer: coarse)").matches) $("input").focus({ preventScroll: true });
}

async function deleteChat(id, title) {
  closeRowMenu();
  if (state.streaming) return;
  const ok = await confirmDialog({ title: "この会話を削除しますか？", body: [title], ok: "削除", danger: true });
  if (!ok || state.streaming) return;
  historySaves.delete(id);
  try {
    await archive.remove(id);
  } catch {
    toast("この会話を削除できませんでした。");
    return;
  }
  const kept = liveChats.get(id);
  liveChats.delete(id);
  if (kept && kept !== state.chat) kept.messages.forEach((message) => message.attachments?.forEach(release));
  drawer.texts?.delete(id);
  if (lastOpen() === id) setLastOpen("");
  if (id === state.chat.id) {
    // The open one was deleted: a new, empty chat opens (the list stays open).
    sessionStorage.removeItem("fielua.chat");
    state.chat.messages.forEach((message) => message.attachments?.forEach(release));
    showChat(blankChat());
  }
  await renderHistory();
  const next = $("history-list").querySelector(".history-row:not(:disabled)");
  (next ?? $("history-new")).focus({ preventScroll: true });
}

/** Whether the list can be seen now (open on a phone, or beside the chat). */
const historyShown = () => !$("chat").hidden && (docked() || (!wide.matches && $("chat").classList.contains("history-shown")));

let historyTicket = 0;
let historyLatest = Promise.resolve();
/** Draws the list again; the promise settles once the latest drawing is on the page. */
function renderHistory() {
  const ticket = ++historyTicket;
  const pass = drawHistory(ticket).then((drawn) => (drawn ? undefined : historyLatest));
  historyLatest = pass;
  return pass;
}

async function drawHistory(ticket) {
  $("history-new").disabled = !!state.streaming;
  if (!historyShown()) return true;
  const list = $("history-list");
  const empty = $("history-empty");
  if (!archive.isOpen()) {
    list.replaceChildren();
    delete list.dataset.shape;
    empty.hidden = drawer.available === null && !drawer.failed;
    empty.textContent = drawer.failed ? "会話履歴を読み込めませんでした。" : "この端末では会話履歴を保存できません";
    return true;
  }
  let items = await archive.list().catch(() => []);
  if (ticket !== historyTicket) return false;
  // The open conversation as it is now (its save may still be on the way).
  if (hasQuestion(state.chat)) {
    items = items.filter((item) => item.id !== state.chat.id);
    items.push({ id: state.chat.id, title: titleOf(state.chat), updatedAt: state.chat.updatedAt });
    items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  const query = normalize(drawer.query.trim());
  if (query) {
    const texts = await searchTexts();
    if (ticket !== historyTicket) return false;
    items = items.filter((item) => normalize(item.title).includes(query) || texts.get(item.id)?.includes(query));
  }
  const busy = !!state.streaming;
  // Drawn again only when something shows differently; the focused row keeps the focus.
  const shape = JSON.stringify([busy, state.chat.id, items.map((item) => [item.id, item.title])]);
  if (shape !== list.dataset.shape || !list.childElementCount !== !items.length) {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.replaceChildren(...items.map((item) => {
      const current = item.id === state.chat.id;
      const row = h("button", {
        type: "button", class: "history-row", text: item.title, "aria-label": `会話を開く: ${item.title}`,
        "aria-current": current ? "true" : null, disabled: busy && !current, dataset: { id: item.id },
      });
      return h("li", {}, row);
    }));
    list.dataset.shape = shape;
    // Tab stops once in the list (on the open conversation); the arrows walk it.
    oneTabStop(list, ".history-row", (row) => row.getAttribute("aria-current") === "true");
    if (focused) [...list.querySelectorAll(".history-row")].find((row) => row.dataset.id === focused)?.focus({ preventScroll: true });
  }
  empty.hidden = items.length > 0;
  empty.textContent = query ? "見つかりませんでした" : "会話はまだありません";
  return true;
}

/** Every conversation's text (titles and messages, both sides), folded for searching. */
async function searchTexts() {
  if (drawer.texts) return drawer.texts;
  const texts = new Map();
  for (const chat of await archive.loadAll().catch(() => [])) texts.set(chat.id, normalize(chat.messages.map((message) => message.text ?? "").join("\n")));
  for (const chat of liveChats.values()) texts.set(chat.id, normalize(chat.messages.map((message) => message.text ?? "").join("\n")));
  texts.set(state.chat.id, normalize(state.chat.messages.map((message) => message.text ?? "").join("\n")));
  drawer.texts = texts;
  return texts;
}

const drawerWidth = () => $("history").getBoundingClientRect().width || 300;
let drawerSettle = 0;

/** Opens or closes the list on a phone (the chat slides aside, 92 px of it left); on a wide screen, shows it beside the chat or not. */
function setDrawer(open, { animate = true, focus = true, ms = 400 } = {}) {
  const chat = $("chat");
  // How long it takes to settle: 0.4 s from a button, less when a flick has little left to travel.
  chat.style.setProperty("--drawer-ms", `${Math.round(ms)}ms`);
  if (wide.matches) {
    if (state.prefs.historyDocked !== open) {
      state.prefs.historyDocked = open;
      savePrefs();
    }
    applyDock(animate);
    if (open) renderHistory();
    return;
  }
  const wasOpen = drawer.open;
  const history = $("history");
  const hadFocus = history.contains(document.activeElement) || document.activeElement === $("history-close");
  drawer.open = open;
  clearTimeout(drawerSettle);
  if (open) {
    $("input").blur();
    if (!chat.classList.contains("history-shown")) {
      chat.style.setProperty("--reveal", "0");
      chat.classList.add("history-shown");
      void chat.offsetWidth;
    }
  }
  const drawn = open ? renderHistory() : null;
  chat.classList.toggle("history-animating", animate);
  chat.style.setProperty("--reveal", open ? "1" : "0");
  history.inert = !open;
  // Not aria-modal: the chat beside it is inert already, and 会話に戻る (outside the list) stays reachable for VoiceOver.
  history.setAttribute("role", "dialog");
  $("chat-panel").inert = open;
  $("history-close").hidden = !open;
  $("history-button").setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) {
    closeRowMenu();
    endSearch();
    const done = () => { if (!drawer.open) chat.classList.remove("history-shown", "history-animating"); };
    if (animate) drawerSettle = setTimeout(done, still() ? 160 : ms + 20);
    else done();
    if (focus && wasOpen && (hadFocus || document.activeElement === document.body)) $("history-button").focus({ preventScroll: true });
  } else {
    drawerSettle = setTimeout(() => chat.classList.remove("history-animating"), ms + 20);
    if (focus) {
      drawn.then(() => {
        if (!drawer.open || history.contains(document.activeElement)) return;
        const rows = $("history-list");
        (rows.querySelector('[aria-current="true"]') ?? rows.querySelector(".history-row:not(:disabled)") ?? $("history-new")).focus({ preventScroll: true });
      });
    }
  }
}

/** A wide screen: the list beside the chat (no modal); a phone: back to the slide-aside list, closed. */
function applyDock(animate = true) {
  const chat = $("chat");
  const history = $("history");
  const button = $("history-button");
  if (wide.matches) {
    const on = docked();
    drawer.open = false;
    chat.classList.remove("history-shown");
    chat.style.removeProperty("--reveal");
    chat.classList.toggle("history-animating", animate);
    clearTimeout(drawerSettle);
    drawerSettle = setTimeout(() => chat.classList.remove("history-animating"), 420);
    chat.classList.toggle("docked", on);
    history.inert = !on;
    history.setAttribute("role", "complementary");
    history.removeAttribute("aria-modal");
    $("chat-panel").inert = false;
    $("history-close").hidden = true;
    button.setAttribute("aria-label", on ? "会話一覧を閉じる" : "会話一覧を開く");
    button.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) renderHistory();
    else { closeRowMenu(); endSearch(); }
  } else {
    chat.classList.remove("docked");
    button.setAttribute("aria-label", "会話一覧を開く");
    setDrawer(false, { animate: false, focus: false });
  }
}

function startSearch() {
  drawer.searching = true;
  drawer.texts = null;
  $("history-lockup").hidden = true;
  $("history-search").hidden = false;
  const button = $("history-search-button");
  button.classList.add("searching");
  button.setAttribute("aria-label", "検索を閉じる");
  button.setAttribute("aria-expanded", "true");
  $("history-query").focus();
}

function endSearch() {
  if (!drawer.searching && !drawer.query) return;
  drawer.searching = false;
  drawer.query = "";
  const query = $("history-query");
  query.value = "";
  query.blur();
  $("history-search").hidden = true;
  $("history-lockup").hidden = false;
  const button = $("history-search-button");
  button.classList.remove("searching");
  button.setAttribute("aria-label", "会話を検索");
  button.setAttribute("aria-expanded", "false");
  renderHistory();
}

function openRowMenu(row) {
  if (state.streaming) return;
  const menu = $("history-menu");
  const box = $("history").getBoundingClientRect();
  const at = row.getBoundingClientRect();
  drawer.menuFor?.classList.remove("menu-open");
  drawer.menuFor = row;
  // The row it belongs to stays marked while it is open.
  row.classList.add("menu-open");
  present(menu, true);
  const below = at.bottom - box.top + 6;
  const top = below + menu.offsetHeight > box.height - 8 ? at.top - box.top - menu.offsetHeight - 6 : below;
  // It grows out of its row: from its top edge under the row, from its bottom edge above it.
  menu.style.transformOrigin = top === below ? "" : "24px 100%";
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, at.left - box.left)}px`;
  $("history-delete").focus({ preventScroll: true });
}

function closeRowMenu() {
  const menu = $("history-menu");
  if (menu.hidden || isLeaving(menu)) return;
  present(menu, false);
  const row = drawer.menuFor;
  drawer.menuFor = null;
  row?.classList.remove("menu-open");
  if (row?.isConnected && $("history").contains(document.activeElement)) row.focus({ preventScroll: true });
}

function wireHistory() {
  const chat = $("chat");
  const list = $("history-list");
  $("history-button").addEventListener("click", () => setDrawer(wide.matches ? !docked() : true));
  $("history-close").addEventListener("click", () => setDrawer(false));
  $("history-new").addEventListener("click", startNewChat);
  $("history-settings").addEventListener("click", () => openSheet("settings-sheet"));
  $("history-search-button").addEventListener("click", () => (drawer.searching ? endSearch() : startSearch()));
  $("history-query").addEventListener("input", (event) => {
    drawer.query = event.target.value;
    renderHistory();
  });
  $("history-query").addEventListener("keydown", (event) => {
    // (Enter and Escape that belong to a Japanese conversion are the keyboard's own.)
    if (event.isComposing || event.keyCode === 229) return;
    const first = list.querySelector(".history-row:not(:disabled)");
    if (event.key === "Enter") {
      event.preventDefault();
      // With a keyboard, on to what was found; on a phone, the keyboard goes away.
      if (first && !matchMedia("(pointer: coarse)").matches) first.focus(); else event.target.blur();
    } else if (event.key === "ArrowDown" && first) {
      event.preventDefault();
      first.focus();
    }
  });
  walkWithArrows(list, ".history-row");
  $("history-scroll").addEventListener("scroll", () => { closeRowMenu(); if (document.activeElement === $("history-query")) $("history-query").blur(); }, { passive: true });

  // A row: a tap opens it; a long press (or the right button, or the menu key) opens its menu.
  let press = null;
  let pressed = false;
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".history-row");
    if (!row) return;
    if (pressed) { pressed = false; event.preventDefault(); return; }
    openChat(row.dataset.id);
  });
  list.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".history-row");
    if (!row) return;
    event.preventDefault();
    if (!row.disabled) openRowMenu(row);
  });
  list.addEventListener("keydown", (event) => {
    const row = event.target.closest(".history-row");
    if (row && (event.key === "Delete" || event.key === "Backspace") && !row.disabled) {
      event.preventDefault();
      deleteChat(row.dataset.id, row.textContent);
    }
  });
  list.addEventListener("pointerdown", (event) => {
    const row = event.target.closest(".history-row");
    pressed = false;
    if (!row || event.pointerType === "mouse" || row.disabled) return;
    clearTimeout(press?.timer);
    press = { x: event.clientX, y: event.clientY, timer: setTimeout(() => { pressed = true; press = null; openRowMenu(row); }, 500) };
  });
  const cancelPress = (event) => {
    if (!press) return;
    if (event.type === "pointermove" && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) return;
    clearTimeout(press.timer);
    press = null;
  };
  for (const type of ["pointermove", "pointerup", "pointercancel"]) list.addEventListener(type, cancelPress, { passive: true });
  $("history-delete").addEventListener("click", () => {
    const row = drawer.menuFor;
    if (row) deleteChat(row.dataset.id, row.textContent);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!$("history-menu").hidden && !isLeaving($("history-menu")) && !$("history-menu").contains(event.target)) closeRowMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
    if (!$("history-menu").hidden && !isLeaving($("history-menu"))) { event.preventDefault(); closeRowMenu(); return; }
    if (drawer.searching && $("history").contains(document.activeElement)) { event.preventDefault(); endSearch(); $("history-search-button").focus(); return; }
    if (drawer.open) { event.preventDefault(); setDrawer(false); }
  });

  // On a phone, a sideways drag anywhere (not on what scrolls sideways itself) opens and closes the list,
  // following the finger; let go, it goes where the finger was heading (the app's HistoryDrawerPan).
  let drag = null;
  const reveal = () => Number.parseFloat(chat.style.getPropertyValue("--reveal")) || 0;
  chat.addEventListener("pointerdown", (event) => {
    drag = null;
    if (event.pointerType !== "touch" || wide.matches) return;
    if (document.querySelector("dialog[open]") || !$("attach-menu").hidden) return;
    // Not where something scrolls sideways itself (tables, code, a long formula, the attachments), nor in a text field.
    if (event.target.closest(".fl-table-scroll, pre, .fl-math.display, .katex-display, .tray, .tool-pills, textarea, input, .row-menu")) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from: drawer.open ? 1 : 0, active: false, lastX: event.clientX, lastT: event.timeStamp, speed: 0 };
  }, { passive: true });
  chat.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.2 || (drag.from === 0 && dx < 0) || (drag.from === 1 && dx > 0)) { drag = null; return; }
      drag.active = true;
      clearTimeout(drawerSettle);
      closeRowMenu();
      $("input").blur();
      chat.classList.remove("history-animating");
      if (!chat.classList.contains("history-shown")) {
        chat.style.setProperty("--reveal", "0");
        chat.classList.add("history-shown");
        renderHistory();
      }
      try { chat.setPointerCapture(event.pointerId); } catch { /* gone */ }
    }
    const elapsed = event.timeStamp - drag.lastT;
    if (elapsed > 0) drag.speed = 0.7 * ((event.clientX - drag.lastX) / elapsed) + 0.3 * drag.speed;
    drag.lastX = event.clientX;
    drag.lastT = event.timeStamp;
    chat.style.setProperty("--reveal", String(Math.min(1, Math.max(0, drag.from + dx / drawerWidth()))));
  }, { passive: true });
  const letGo = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const ended = drag;
    drag = null;
    if (!ended.active) return;
    // Where it would come to rest in 0.2 s at this speed.
    const projected = reveal() + (event.type === "pointercancel" ? 0 : (ended.speed * 200) / drawerWidth());
    const open = projected > 0.5;
    // It leaves the finger at the finger's speed (2.25: how fast the settling curve starts), so a flick is not braked.
    const left = Math.abs((open ? 1 : 0) - reveal()) * drawerWidth();
    const speed = Math.abs(ended.speed);
    const ms = speed > 0.3 ? Math.min(400, Math.max(160, (2.25 * left) / speed)) : 400;
    if (open !== drawer.open) setDrawer(open, { ms });
    else setDrawer(open, { focus: false, ms });
  };
  chat.addEventListener("pointerup", letGo);
  chat.addEventListener("pointercancel", letGo);

  wide.addEventListener("change", () => { closeRowMenu(); applyDock(false); });
  // Another tab of this page changed the history: this one follows.
  archive.onChange((change) => { followOtherTab(change); });
}

// MARK: Sheets

/**
 * Up, Down, Home and End walk the rows of a list, a menu or a group of
 * choices, as a keyboard expects of them. `choose` also picks the row walked
 * to (a group of radio buttons).
 */
function walkWithArrows(holder, rows, { choose = false } = {}) {
  holder.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const all = [...holder.querySelectorAll(rows)].filter((row) => !row.disabled && !row.hidden);
    const at = all.indexOf(document.activeElement.closest?.(rows));
    if (at < 0 || !all.length) return;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    if (next === all[at]) return;
    next.focus();
    if (choose) next.click();
  });
}

/** Enter in a field that stands beside its button presses that button (not while Japanese is being converted). */
function enterPresses(field, button) {
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!button.disabled) button.click();
  });
}

/** One row of a group takes Tab (the chosen one); the arrows reach the others. */
function oneTabStop(holder, rows, chosen) {
  const all = [...holder.querySelectorAll(rows)];
  const stop = all.find((row) => chosen(row) && !row.disabled) ?? all.find((row) => !row.disabled);
  for (const row of all) row.tabIndex = row === stop ? 0 : -1;
}

function openSheet(id) {
  if (id === "model-sheet") renderModelSheet();
  if (id === "credit-sheet") renderCreditSheet();
  if (id === "settings-sheet") {
    $("settings-body").replaceChildren();
    $("settings-body").dataset.opening = "1";
    $("settings-body").scrollTop = 0;
    renderSettings();
  }
  openDialog($(id));
}

/** Every sheet and alert shut at once, with no motion: the person is signed out, and the sign-in screen shows. */
function closeSheets() {
  for (const dialog of document.querySelectorAll("dialog[open]")) closeDialogNow(dialog);
}

/**
 * On a phone a sheet follows a finger that pulls its head down, and goes if
 * it is let go far enough or fast enough; otherwise it comes back (iOS's sheets).
 */
function wireSheetPull(dialog) {
  const head = dialog.querySelector(".sheet-head");
  const phone = matchMedia("(max-width: 699px)");
  let pull = null;
  head.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || !phone.matches || pull || isLeaving(dialog) || event.target.closest("button")) return;
    pull = { id: event.pointerId, y: event.clientY, by: 0, lastY: event.clientY, lastT: event.timeStamp, speed: 0 };
    for (const running of dialog.getAnimations?.() ?? []) running.finish();
    try { head.setPointerCapture(event.pointerId); } catch { /* the finger is already gone */ }
  });
  head.addEventListener("pointermove", (event) => {
    if (!pull || event.pointerId !== pull.id) return;
    const elapsed = event.timeStamp - pull.lastT;
    if (elapsed > 0) pull.speed = 0.7 * ((event.clientY - pull.lastY) / elapsed) + 0.3 * pull.speed;
    pull.lastY = event.clientY;
    pull.lastT = event.timeStamp;
    pull.by = Math.max(0, event.clientY - pull.y);
    dialog.style.transform = pull.by ? `translateY(${pull.by}px)` : "";
  });
  const letGo = (event) => {
    if (!pull || event.pointerId !== pull.id) return;
    const ended = pull;
    pull = null;
    if (event.type === "pointerup" && ended.by > 0 && (ended.by > dialog.offsetHeight * 0.3 || ended.speed > 0.5)) {
      // Down from where the finger left it.
      closeDialog(dialog).then(() => { dialog.style.transform = ""; });
      return;
    }
    dialog.style.transform = "";
    if (ended.by) move(dialog, [{ transform: `translateY(${ended.by}px)` }, { transform: "none" }], { ms: 360, curve: "--menu-close" });
  };
  head.addEventListener("pointerup", letGo);
  head.addEventListener("pointercancel", letGo);
}

function wireSheets() {
  for (const dialog of document.querySelectorAll("dialog.sheet")) {
    // A press that began inside (text being selected) and ended on the dimmed page is not a tap on it.
    let outside = false;
    dialog.addEventListener("pointerdown", (event) => { outside = event.target === dialog; });
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-close]") || (event.target === dialog && outside)) closeDialog(dialog);
      outside = false;
    });
    // Escape (and Android's back): the sheet goes down as it does for 完了.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(dialog); });
    wireSheetPull(dialog);
  }
  for (const group of [$("model-list"), $("effort-list")]) walkWithArrows(group, ".choice", { choose: true });
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
  // The field made narrower or wider (a window resized, a phone turned): its lines wrap anew, and it is as tall as they are.
  let width = 0;
  new ResizeObserver(([entry]) => {
    const now = Math.round(entry.contentRect.width);
    if (now === width) return;
    const first = !width;
    width = now;
    if (!first) autoGrow(false);
  }).observe(input);
  // A press on the field's rim is a press on the field.
  $("composer").addEventListener("pointerdown", (event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    input.focus();
  });
}

function start() {
  if (RELAY.startsWith("__")) {
    showLogin("main", "このページの組み立てが途中です（中継サーバーのアドレスがありません）。");
    return;
  }
  plantFlowers();
  wireLogin();
  wireComposer();
  wireAttachments();
  wireSheets();
  wireHistory();
  wireScroller();
  wireViewport();
  attachReplyActions($("messages"));
  // With a mouse, a button that is only a symbol says its short name when the pointer rests on it.
  if (matchMedia("(hover: hover)").matches) {
    document.addEventListener("pointerover", (event) => {
      const button = event.target.closest?.("button[aria-label]");
      if (!button || button.textContent.trim()) return;
      const name = button.getAttribute("aria-label");
      if (button.title !== name) button.title = name;
    }, { passive: true });
  }
  addEventListener("online", () => { updateBanner(); retryHistory(); });
  addEventListener("offline", updateBanner);
  // Safari may stop the page in the background: what waits is written first, a reply's text so far with it.
  addEventListener("pagehide", () => { syncStreaming(); flushHistory(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { syncStreaming(); flushHistory(); return; }
    // Text that came while the tab was away shows at once.
    if (state.streaming) state.streaming.pacer.shown = state.streaming.pacer.text.length;
    if ($("chat").hidden) return;
    // The sign-in ran out while the page was away: signed out (the history locked) before anything else.
    if (!session.get()) { expired(); return; }
    refreshStatus();
  });
  const invited = readInviteLink();
  if (session.get() && !invited) {
    // The flower stands for the page until the relay has said who this is.
    $("splash").hidden = false;
    enterChat().catch(() => showLogin("main"));
  } else {
    showLogin(invited ? "invite" : "main");
  }
}

start();
