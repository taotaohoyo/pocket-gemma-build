"""Why Tavily's sign-in page says "We couldn't finish setting up your Tavily
account" in Fielua (2026-11-13, device screenshot at mcp.tavily.com).

No account, key or secret is used and the log is public: client ids and
states are cut short. Prints, as an iPhone browser would see them:

1. mcp.tavily.com's OAuth metadata now (compared with 2026-10-28);
2. a public native client registration with Fielua's redirect;
3. /authorize: status, cookies it sets (names and attributes, never values),
   where it sends the browser, and every hop to Tavily's sign-in page;
4. /auth/callback the way Tavily's sign-in page comes back to it (made-up
   code): with the browser's cookies from step 3, without them (Fielua's
   新規登録 path), with an unknown state, with an error;
5. the callback page's text, scripts and the code around the error message
   in them, to see what "setting up your account" is and when it fails.
"""

import base64
import hashlib
import html
import http.cookiejar
import json
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

MCP = "https://mcp.tavily.com"
RESOURCE = "https://mcp.tavily.com/mcp"
REDIRECT = "fielua://oauth/tavily"
SAFARI = ("Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 "
          "(KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1")
WORDS = ("couldn't finish", "couldn&#x27;t finish", "couldn\\u0027t finish", "setting up your", "Something went wrong",
         "Refresh this page", "set up", "setup", "provision", "api_key", "apiKey", "mcp_auth_default", "/api/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener(jar=None):
    handlers = [NoRedirect]
    if jar is not None:
        handlers.append(urllib.request.HTTPCookieProcessor(jar))
    return urllib.request.build_opener(*handlers)


def call(op, method, url, *, body=None, headers=None, form=None):
    data = None
    hdrs = {"User-Agent": SAFARI, "Accept-Language": "ja-JP,ja;q=0.9"}
    hdrs.update(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with op.open(req, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception as e:  # noqa: BLE001
        return -1, {}, str(e).encode()


def short(value, keep=6):
    value = str(value)
    return value[:keep] + "…" if len(value) > keep else value


def head(title):
    print(f"\n===== {title}", flush=True)


def lower(h):
    return {k.lower(): v for k, v in h.items()}


def cookies(h):
    out = []
    for k, v in h.items():
        if k.lower() != "set-cookie":
            continue
        name = v.split("=", 1)[0]
        attrs = [a.strip() for a in v.split(";")[1:]]
        attrs = [a if not a.lower().startswith("expires") else "Expires=…" for a in attrs]
        out.append(f"{name} [{'; '.join(attrs)}]")
    return out


def describe(url):
    p = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(p.query)
    red = {}
    for k, v in q.items():
        red[k] = short(v[0]) if k in ("client_id", "state", "code_challenge", "code", "nonce") else v[0][:140]
    return f"{p.scheme}://{p.netloc}{p.path}  params={json.dumps(red, ensure_ascii=False)}"


def visible(text, limit=900):
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text))).strip()[:limit]


def show_page(label, status, h, raw, *, dig=False):
    hl = lower(h)
    print(f"  [{label}] {status}  content-type={hl.get('content-type')}  length={len(raw)}")
    if cookies(h):
        print(f"    Set-Cookie: {cookies(h)}")
    if hl.get("location"):
        print(f"    Location: {describe(hl['location'])}")
    text = raw.decode("utf-8", "replace")
    title = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
    if title:
        print(f"    title: {html.unescape(title.group(1).strip())}")
    print(f"    text: {visible(text)}")
    if not dig:
        return text
    scripts = re.findall(r'<script[^>]*src="([^"]+)"', text)
    print(f"    scripts: {scripts[:20]}")
    inline = re.findall(r"<script(?![^>]*src=)[^>]*>(.*?)</script>", text, re.S | re.I)
    for i, body in enumerate(inline):
        body = body.strip()
        if not body:
            continue
        print(f"    inline script {i}: {len(body)} chars: {body[:600]!r}")
        for w in WORDS:
            for m in list(re.finditer(re.escape(w), body))[:3]:
                print(f"      '{w}' at {m.start()}: …{body[max(0, m.start() - 500):m.start() + 500]!r}…")
    forms = re.findall(r"<form[^>]*>", text, re.I)
    if forms:
        print(f"    forms: {forms}")
    for m in re.finditer(r"(fetch\(|XMLHttpRequest|window\.location|location\.(href|replace)|meta http-equiv)", text):
        print(f"    nav/fetch at {m.start()}: …{text[max(0, m.start() - 200):m.start() + 300]!r}…")
    return text


def pkce():
    verifier = secrets.token_urlsafe(64)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def register(meta, redirect=REDIRECT, name="Fielua"):
    payload = {"client_name": name, "redirect_uris": [redirect],
               "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
               "token_endpoint_auth_method": "none", "scope": "openid offline_access", "application_type": "native"}
    status, h, raw = call(opener(), "POST", meta.get("registration_endpoint", MCP + "/register"), body=payload)
    print(f"POST register ({redirect}) -> {status}")
    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        print("  " + raw[:400].decode("utf-8", "replace"))
        return None
    print("  " + json.dumps({k: (short(v) if k in ("client_id", "client_secret", "registration_access_token") else v)
                             for k, v in data.items()}, ensure_ascii=False)[:1200])
    return data.get("client_id")


def authorize_url(meta, client_id, redirect=REDIRECT):
    _, challenge = pkce()
    ours = secrets.token_urlsafe(32)
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect,
              "scope": "openid offline_access", "state": ours, "code_challenge": challenge,
              "code_challenge_method": "S256", "resource": RESOURCE}
    return meta.get("authorization_endpoint", MCP + "/authorize") + "?" + urllib.parse.urlencode(params), ours


def walk(op, url, hops=10, dig_last=True):
    """Follows the browser's hops (with its cookie jar) to the page it shows.
    Returns (last url, page text)."""
    for _ in range(hops):
        status, h, raw = call(op, "GET", url, headers={"Accept": "text/html"})
        loc = lower(h).get("location")
        print(f"  {status}  {describe(url)}")
        if cookies(h):
            print(f"      Set-Cookie: {cookies(h)}")
        if loc and 300 <= status < 400:
            nxt = urllib.parse.urljoin(url, loc)
            if not nxt.startswith("http"):
                print(f"  -> leaves the web: {describe(nxt)}")
                return nxt, ""
            url = nxt
            continue
        text = show_page("final", status, h, raw, dig=dig_last)
        return url, text
    return url, ""


def mcp_state(op, meta, client_id):
    """mcp.tavily.com/authorize once: its own state in the Location to Tavily's sign-in page."""
    url, ours = authorize_url(meta, client_id)
    status, h, raw = call(op, "GET", url, headers={"Accept": "text/html"})
    loc = lower(h).get("location") or ""
    q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
    return status, h, raw, loc, q.get("state", [""])[0], ours


def callback(op, label, params, dig=False):
    url = MCP + "/auth/callback?" + urllib.parse.urlencode(params)
    status, h, raw = call(op, "GET", url, headers={"Accept": "text/html"})
    return show_page(label, status, h, raw, dig=dig)


def assets(text, base):
    """Same-site scripts of the callback page, searched for the message."""
    srcs = re.findall(r'<script[^>]*src="([^"]+)"', text) + re.findall(r'<link[^>]*href="([^"]+\.js)"', text)
    seen = set()
    for src in srcs:
        url = urllib.parse.urljoin(base, src)
        if url in seen or "tavily" not in urllib.parse.urlparse(url).netloc:
            continue
        seen.add(url)
        status, h, raw = call(opener(), "GET", url)
        body = raw.decode("utf-8", "replace")
        hits = [w for w in WORDS if w in body]
        print(f"  asset {url[:120]} -> {status}, {len(body)} chars, words {hits}")
        for w in ("couldn't finish", "setting up your", "Something went wrong", "Refresh this page"):
            for m in list(re.finditer(re.escape(w), body))[:2]:
                print(f"    '{w}' at {m.start()}: …{body[max(0, m.start() - 1500):m.start() + 700]!r}…")


def main():
    head("Discovery")
    status, h, raw = call(opener(), "GET", MCP + "/.well-known/oauth-authorization-server")
    meta = json.loads(raw) if status == 200 else {}
    print(f"oauth-authorization-server -> {status}")
    print(json.dumps(meta, ensure_ascii=False)[:2500])
    for path in ("/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"):
        s, _, r = call(opener(), "GET", MCP + path)
        print(f"{path} -> {s}: {r[:600].decode('utf-8', 'replace')}")

    head("Registration")
    client_id = register(meta)
    if not client_id:
        return 1

    head("ログイン path: the sign-in sheet opens mcp.tavily.com/authorize and follows every hop (one cookie jar)")
    jar = http.cookiejar.CookieJar()
    browser = opener(jar)
    url, _ = authorize_url(meta, client_id)
    walk(browser, url, dig_last=False)
    print(f"  cookies the sheet holds now: {[(c.domain, c.name, c.path, c.secure) for c in jar]}")

    head("Callback with the sheet's cookies (state from that sheet's /authorize), made-up code")
    jar2 = http.cookiejar.CookieJar()
    sheet = opener(jar2)
    status, h, raw, loc, state, ours = mcp_state(sheet, meta, client_id)
    print(f"  /authorize -> {status}; Set-Cookie {cookies(h)}; Location {describe(loc) if loc else visible(raw.decode('utf-8', 'replace'), 300)}")
    print(f"  jar: {[(c.domain, c.name, c.path) for c in jar2]}")
    page = callback(sheet, "with cookies, made-up code", {"code": "not-a-code", "state": state}, dig=True)
    assets(page, MCP + "/auth/callback")

    head("Callback without cookies (新規登録 path: the app fetched /authorize, the sheet opened the sign-in page itself)")
    status, h, raw, loc, state, ours = mcp_state(opener(), meta, client_id)
    callback(opener(), "no cookies, made-up code", {"code": "not-a-code", "state": state})

    head("Callback with an unknown state, and with error=access_denied")
    callback(opener(), "unknown state", {"code": "not-a-code", "state": "not-a-state"})
    status, h, raw, loc, state, ours = mcp_state(opener(), meta, client_id)
    callback(opener(), "access_denied", {"error": "access_denied", "error_description": "User cancelled", "state": state})

    head("Same callback, Tavily's CLI kind of client (http://localhost redirect), made-up code")
    cli = register(meta, redirect="http://localhost:53682/callback", name="Tavily CLI probe")
    if cli:
        status, h, raw, loc, state, ours = mcp_state(opener(), meta, cli)
        callback(opener(), "localhost client, made-up code", {"code": "not-a-code", "state": state})

    head("Other pages on mcp.tavily.com that may say what account setup is")
    for path in ("/", "/auth", "/auth/error", "/auth/setup", "/consent", "/auth/consent"):
        s, hh, r = call(opener(), "GET", MCP + path, headers={"Accept": "text/html"})
        print(f"  GET {path} -> {s} {lower(hh).get('location', '')} :: {visible(r.decode('utf-8', 'replace'), 200)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
