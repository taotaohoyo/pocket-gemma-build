// Talking to Fielua's relay (claude-relay/), the only place that holds the
// Anthropic API key. The page holds a web session token, in this tab's
// sessionStorage only, for 12 hours at most; it works only from this
// site's own address. Nothing here sets or reads a cookie.

/* global __RELAY_URL__ */
export const RELAY = __RELAY_URL__;

const SESSION_KEY = "fielua.session";

export const session = {
  get() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
      if (!value || typeof value.token !== "string" || !/^fws_[A-Za-z0-9_-]{43}$/.test(value.token)) return null;
      if (typeof value.expiresAt === "number" && value.expiresAt <= Date.now()) return null;
      return value;
    } catch {
      return null;
    }
  },
  set(value) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      token: value.session, expiresAt: value.expiresAt, name: value.name, role: value.role, signedInAt: Date.now(),
    }));
  },
  clear() {
    sessionStorage.removeItem(SESSION_KEY);
  },
};

export class RelayError extends Error {
  constructor(status, code, body = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * A request to the relay. `token` overrides the session (the admin key on
 * the first setup, never stored). Throws RelayError: status 0 for no
 * connection; AbortError when `signal` ends it.
 */
export async function call(path, { method = "GET", body, token, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const bearer = token ?? session.get()?.token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let response;
  try {
    response = await fetch(RELAY + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new RelayError(0, "network");
  }
  return response;
}

/** JSON from the relay, or a RelayError with its code. */
export async function callJSON(path, options) {
  const response = await call(path, options);
  let value = null;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  if (!response.ok) throw new RelayError(response.status, value?.error ?? "unexpected", value ?? {});
  return value;
}
