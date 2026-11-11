// The conversations this device keeps (the iPhone app's 履歴): in this
// browser's IndexedDB only, never on the relay or anywhere else.
//
// Each record is encrypted (AES-GCM, a fresh IV every time it is written)
// with a key the relay gives this person once they have signed in
// (GET /v1/history-key). So the history can be read here only while signed
// in: not by someone else using this browser later, and not by another page
// of suelira.com that doesn't hold this tab's session. The key stays in this
// page's memory; it is never written anywhere on the device.
//
// Each person who signs in here has a database of their own, named after a
// hash of their key. The list ("meta": title and times) and the
// conversations ("chats") are kept apart, so the list opens without
// decrypting every conversation.
//
// Safari can lose a database's connection while the page is in the
// background ("Connection to Indexed Database server lost"): each operation
// opens it again once and retries.
//
// Other tabs of this page hear of each change (BroadcastChannel): a changed
// or deleted conversation, everything deleted, or the database gone with the
// registration (that tab then locks too).

import { callJSON } from "./api.js";
import { fromBase64url } from "./passkey.js";

const VERSION = 1;
const STORES = ["meta", "chats"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let key = null;
let owner = "";
/** Signed out, the last writes still on their way: nothing can be read any more. */
let closing = false;
let db = null;
let opening = null;
/** Bumped at every lock, so work begun for someone who signed out ends there. */
let generation = 0;
const listeners = new Set();
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("fielua-history") : null;
channel?.addEventListener("message", (event) => {
  const data = event.data;
  if (!key || data?.owner !== owner) return;
  // 登録を解除 in another tab: the database is gone, and the key with it here too.
  if (data.gone) lock();
  const change = { id: typeof data.id === "string" ? data.id : null, deleted: data.deleted === true, gone: data.gone === true };
  for (const listener of listeners) listener(change);
});

const locked = () => new DOMException("The history is locked.", "InvalidStateError");

/** Whether the history can be read and written now (signed in, key in hand). */
export const isOpen = () => !!key && !closing;

/** A short name for this person's history on this device (a hash of the key, nothing else). */
export const ownerTag = () => owner;

/**
 * Calls `listener({ id, deleted, gone })` when another tab of this page
 * changed this person's history: `id` null for all of it, `gone` when the
 * database went with the registration (the history is locked by then).
 */
export function onChange(listener) {
  listeners.add(listener);
}

/**
 * Gets the signed-in person's key from the relay and opens their database.
 * Always asks the relay, so a key still held from someone before is never
 * reused for whoever signed in now. Resolves to true when the history works
 * here; throws when it can't (an older relay without the key answers 404,
 * no connection, some private modes have no IndexedDB).
 */
export async function unlock() {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) throw new Error("unsupported");
  const started = generation;
  const { key: raw } = await callJSON("/v1/history-key");
  const bytes = fromBase64url(String(raw ?? ""));
  if (bytes.length !== 32) throw new Error("bad_key");
  const label = encoder.encode("fielua-history-owner-v1:");
  const named = new Uint8Array(label.length + bytes.length);
  named.set(label);
  named.set(bytes, label.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", named));
  const imported = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  bytes.fill(0);
  named.fill(0);
  if (started !== generation) return false;
  const tag = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (key && tag === owner) {
    // The same person again (signed out a moment ago): their open database goes on.
    closing = false;
  } else {
    if (key) lock();
    key = imported;
    owner = tag;
  }
  try {
    await database();
  } catch (error) {
    lock();
    throw error;
  }
  return true;
}

/** Signed out: nothing more is read from now on; what was already on its way is still written, then lock(). */
export function retire() {
  if (key) closing = true;
}

/** Forgets the key (sign-out): the history stays on the device, unreadable until the next sign-in. */
export function lock() {
  generation++;
  key = null;
  owner = "";
  closing = false;
  opening = null;
  try { db?.close(); } catch { /* closed */ }
  db = null;
}

/** How long IndexedDB may take to answer. Safari has left a request unanswered before (a page back from the background):
 *  waited for for ever, a pressed conversation would simply never open. Past this it counts as failed, and is tried once more. */
const ANSWER_MS = 8000;
const unanswered = () => new DOMException("IndexedDB did not answer.", "UnknownError");

function database() {
  if (!owner) return Promise.reject(locked());
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  const name = `fielua-history-${owner}`;
  const started = generation;
  const pending = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(name, VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const opened = request.result;
      for (const store of STORES) if (!opened.objectStoreNames.contains(store)) opened.createObjectStore(store, { keyPath: "id" });
    };
    let given = false;
    const late = setTimeout(() => { given = true; reject(unanswered()); }, ANSWER_MS);
    request.onsuccess = () => {
      clearTimeout(late);
      const opened = request.result;
      if (given) { opened.close(); return; }
      if (started !== generation) {
        opened.close();
        reject(locked());
        return;
      }
      // Another tab with a newer version, or Safari dropping the connection: open again next time.
      // Another tab deleting it (登録を解除): never again here, or the open would make it anew.
      opened.onversionchange = (event) => {
        opened.close();
        if (db === opened) db = null;
        if (event.newVersion === null && owner && name === `fielua-history-${owner}`) {
          // The message from that tab may come after this (or not at all, once locked): the page hears it here too.
          lock();
          for (const listener of listeners) listener({ id: null, deleted: false, gone: true });
        }
      };
      opened.onclose = () => { if (db === opened) db = null; };
      db = opened;
      resolve(opened);
    };
    request.onerror = () => { clearTimeout(late); reject(request.error ?? new DOMException("IndexedDB failed.", "UnknownError")); };
    request.onblocked = () => { clearTimeout(late); reject(new DOMException("Another tab holds the history.", "InvalidStateError")); };
  });
  opening = pending;
  pending.then(() => { if (opening === pending) opening = null; }, () => { if (opening === pending) opening = null; });
  return pending;
}

/** One transaction; `work(tx)` only queues IndexedDB requests (nothing awaited inside), its last result comes back. */
async function transact(mode, stores, work) {
  const started = generation;
  for (let attempt = 0; ; attempt++) {
    if (started !== generation) throw locked();
    try {
      const opened = await database();
      return await new Promise((resolve, reject) => {
        const tx = opened.transaction(stores, mode);
        let result;
        const late = setTimeout(() => { reject(unanswered()); try { tx.abort(); } catch { /* over */ } }, ANSWER_MS);
        const request = work(tx);
        if (request) request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => { clearTimeout(late); resolve(result); };
        // The failed request's own error (the transaction's is set only later, when it aborts): QuotaExceededError stays one.
        tx.onerror = (event) => { clearTimeout(late); reject(event.target?.error ?? tx.error ?? new DOMException("IndexedDB failed.", "UnknownError")); };
        tx.onabort = () => { clearTimeout(late); reject(tx.error ?? new DOMException("IndexedDB stopped.", "AbortError")); };
      });
    } catch (error) {
      if (attempt === 0 && (error?.name === "UnknownError" || error?.name === "InvalidStateError") && started === generation) {
        try { db?.close(); } catch { /* closed */ }
        db = null;
        continue;
      }
      throw error;
    }
  }
}

const context = (store, id) => encoder.encode(`fielua-history-v1:${store}:${id}`);

async function seal(store, id, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context(store, id) }, key, encoder.encode(JSON.stringify(value)));
  return { id, iv, data: new Uint8Array(data) };
}

/** A record's contents, or null when it can't be read (another key, or changed). */
async function unseal(store, record, using = key) {
  if (!record || typeof record.id !== "string" || !using) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv, additionalData: context(store, record.id) }, using, record.data);
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}

// Deleted conversations' ids (random, nothing of their content), in this device's localStorage for this
// person: a tab that still holds one in its own storage must not bring it back on a reload. A save takes
// its id off again. Cleared by the browser together with the history, so an evicted history is not mistaken for this.
const graveKey = () => `fielua.deleted.${owner}`;
function graves() {
  try {
    const value = JSON.parse(localStorage.getItem(graveKey()) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function keepGraves(map) {
  try {
    const kept = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 500);
    if (kept.length) localStorage.setItem(graveKey(), JSON.stringify(Object.fromEntries(kept)));
    else localStorage.removeItem(graveKey());
  } catch { /* private mode */ }
}
function bury(ids) {
  if (!owner || !ids.length) return;
  const map = graves();
  for (const id of ids) map[id] = Date.now();
  keepGraves(map);
}
function unbury(id) {
  if (!owner) return;
  const map = graves();
  if (!Object.hasOwn(map, id)) return;
  delete map[id];
  keepGraves(map);
}

/** Whether a conversation was deleted on this device (in any tab) and not written since. */
export const wasDeleted = (id) => !!owner && Object.hasOwn(graves(), id);

function announce(id, extra = {}) {
  try { channel?.postMessage({ owner, id, ...extra }); } catch { /* closed */ }
}

/** Reading: only while signed in (not while the last writes of a sign-out go). */
function reading() {
  if (!isOpen()) throw locked();
  return key;
}

/** The conversations, newest question first: { id, title, createdAt, updatedAt }. */
export async function list() {
  const using = reading();
  const records = await transact("readonly", ["meta"], (tx) => tx.objectStore("meta").getAll());
  const items = await Promise.all((records ?? []).map((record) => unseal("meta", record, using)));
  return items
    .filter((item) => item && typeof item.id === "string" && typeof item.title === "string")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** One conversation as it was saved, or null. */
export async function load(id) {
  const using = reading();
  const record = await transact("readonly", ["chats"], (tx) => tx.objectStore("chats").get(id));
  const chat = await unseal("chats", record, using);
  return chat && chat.id === id && Array.isArray(chat.messages) ? chat : null;
}

/** Every conversation (for searching their text). */
export async function loadAll() {
  const using = reading();
  const records = await transact("readonly", ["chats"], (tx) => tx.objectStore("chats").getAll());
  const chats = await Promise.all((records ?? []).map((record) => unseal("chats", record, using)));
  return chats.filter((chat) => chat && typeof chat.id === "string" && Array.isArray(chat.messages));
}

/**
 * Writes a conversation (already made plain: no attachment data) and its
 * line in the list, together. `whose` is the owner it was queued for: once
 * someone else's key is here, it is not written.
 */
export async function save(chat, meta, whose = owner) {
  if (!key || !whose || whose !== owner) return false;
  const started = generation;
  // Encrypted first: a transaction ends by itself while anything else is awaited.
  const [line, body] = await Promise.all([seal("meta", chat.id, { ...meta, id: chat.id }), seal("chats", chat.id, chat)]);
  if (started !== generation) return false;
  await transact("readwrite", STORES, (tx) => {
    tx.objectStore("meta").put(line);
    tx.objectStore("chats").put(body);
  });
  unbury(chat.id);
  announce(chat.id);
  return true;
}

export async function remove(id) {
  await transact("readwrite", STORES, (tx) => {
    tx.objectStore("meta").delete(id);
    tx.objectStore("chats").delete(id);
  });
  bury([id]);
  announce(id, { deleted: true });
}

/** Every conversation of this person's on this device, gone. */
export async function removeAll() {
  const ids = await transact("readwrite", STORES, (tx) => {
    const keys = tx.objectStore("meta").getAllKeys();
    tx.objectStore("meta").clear();
    tx.objectStore("chats").clear();
    return keys;
  });
  bury((ids ?? []).filter((id) => typeof id === "string"));
  announce(null, { deleted: true });
}

/** 登録を解除: this person's database itself goes, and the key with it. */
export async function destroy() {
  // Only a key the relay gave the person signed in now (not one still held from before a sign-out).
  const name = isOpen() ? `fielua-history-${owner}` : "";
  if (name) {
    announce(null, { gone: true });
    try { localStorage.removeItem(graveKey()); } catch { /* private mode */ }
  }
  lock();
  if (!name) return;
  await new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

let persistAsked = false;
/** Asks the browser to keep this site's data (Chrome may say yes; Safari keeps it for Home Screen apps only). */
export function keep() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}
