"""What Tavily's official sign-in offers a native iPhone app.

Fielua wants to let people sign up or sign in to Tavily inside the app
(ASWebAuthenticationSession) and search without copying an API key. This
prints, without any account or key:

1. the OAuth metadata of Tavily's remote MCP server (mcp.tavily.com), the
   one Tavily's own CLI signs in with (dynamic client registration, PKCE,
   refresh tokens);
2. whether it registers a public client with an app's own redirect scheme
   (the kind ASWebAuthenticationSession catches) and sends /authorize on to
   a sign-in page, and where that page is;
3. what the MCP endpoint says without a token and with a bad one, and what
   its tavily_search tool takes and returns (in Tavily's keyless mode, the
   same answer a signed-in token gets).

The log is public: client ids are cut short, nothing secret is used.
"""

import base64
import hashlib
import html
import json
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

MCP = "https://mcp.tavily.com"
RESOURCE = "https://mcp.tavily.com/mcp"
UA = "Fielua-probe/1.0"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


plain = urllib.request.build_opener(NoRedirect)
jar = None


def browser():
    """A fresh cookie jar, as a browser keeps one through the sign-in hops."""
    global plain, jar
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    plain = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar))


def call(method, url, *, body=None, headers=None, form=None):
    data = None
    hdrs = {"User-Agent": UA}
    hdrs.update(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with plain.open(req, timeout=30) as r:
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


def show_headers(h, names):
    lower = {k.lower(): v for k, v in h.items()}
    for n in names:
        if n in lower:
            print(f"  {n}: {lower[n]}")


def describe_url(url):
    p = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(p.query)
    redacted = {}
    for k, v in q.items():
        if k in ("client_id", "state", "code_challenge", "code", "nonce"):
            redacted[k] = short(v[0])
        else:
            redacted[k] = v[0][:120]
    return f"{p.scheme}://{p.netloc}{p.path}  params={json.dumps(redacted, ensure_ascii=False)}"


def metadata():
    head("Discovery")
    for path in ("/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp",
                 "/.well-known/oauth-protected-resource", "/.well-known/openid-configuration"):
        status, h, raw = call("GET", MCP + path)
        print(f"GET {path} -> {status}")
        try:
            print(json.dumps(json.loads(raw), indent=1, ensure_ascii=False)[:3000])
        except Exception:  # noqa: BLE001
            print("  " + raw[:300].decode("utf-8", "replace"))
    status, h, raw = call("GET", MCP + "/.well-known/oauth-authorization-server")
    return json.loads(raw) if status == 200 else {}


def pkce():
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def follow(url, hops=8, tweak=None):
    """Walks the sign-in redirects with cookies and prints each hop. `tweak`
    may add parameters to the hop on another host (to see what the sign-in
    page itself honours)."""
    browser()
    for _ in range(hops):
        if tweak and urllib.parse.urlparse(url).netloc == "auth.tavily.com" and urllib.parse.urlparse(url).path == "/authorize":
            url = url + "&" + urllib.parse.urlencode(tweak)
            tweak = None
        status, h, raw = call("GET", url, headers={"Accept": "text/html"})
        loc = {k.lower(): v for k, v in h.items()}.get("location")
        print(f"  {status}  {describe_url(url)}")
        if loc and 300 <= status < 400:
            url = urllib.parse.urljoin(url, loc)
            if not url.startswith("http"):
                print(f"  -> leaves the web: {describe_url(url)}")
                return
            continue
        text = raw.decode("utf-8", "replace")
        title = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
        print(f"  final page title: {html.unescape(title.group(1).strip()) if title else '(none)'}  ({len(text)} chars)")
        for word in ("sign up", "signup", "sign-up", "create account", "create an account", "register",
                     "log in", "login", "sign in", "google", "github", "microsoft", "password", "email"):
            hits = [m.start() for m in re.finditer(re.escape(word), text, re.I)]
            if hits:
                at = hits[0]
                snippet = re.sub(r"\s+", " ", text[max(0, at - 60):at + 60])
                print(f"    '{word}' x{len(hits)}: …{snippet}…")
        hrefs = sorted(set(re.findall(r'href="([^"]+)"', text)))
        print("    links: " + ", ".join(re.sub(r"state=[^&]+", "state=…", h_) for h_ in hrefs if not h_.startswith("https://cdn"))[:900])
        buttons = re.findall(r'<button[^>]*>(.*?)</button>', text, re.S | re.I)
        print("    buttons: " + " | ".join(re.sub(r"<[^>]+>|\s+", " ", b).strip() for b in buttons)[:600])
        inputs = re.findall(r'<input[^>]*name="([^"]+)"', text)
        print("    inputs: " + ", ".join(inputs))
        headings = re.findall(r'<h1[^>]*>(.*?)</h1>|<p[^>]*class="[^"]*(?:subtitle|description)[^"]*"[^>]*>(.*?)</p>', text, re.S | re.I)
        print("    headings: " + " | ".join(re.sub(r"<[^>]+>|\s+", " ", a or b).strip() for a, b in headings)[:400])
        return


def register_and_authorize(meta, redirect_uri, extra=None):
    head(f"Register a public native client with redirect {redirect_uri}")
    reg = meta.get("registration_endpoint", MCP + "/register")
    payload = {"client_name": "Fielua", "redirect_uris": [redirect_uri],
               "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
               "token_endpoint_auth_method": "none", "scope": "openid offline_access", "application_type": "native"}
    status, h, raw = call("POST", reg, body=payload)
    print(f"POST register -> {status}")
    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        print("  " + raw[:400].decode("utf-8", "replace"))
        return None
    shown = {k: (short(v) if k in ("client_id", "client_secret", "registration_access_token") else v) for k, v in data.items()}
    print("  " + json.dumps(shown, ensure_ascii=False)[:1200])
    client_id = data.get("client_id")
    if not client_id:
        return None
    _, challenge = pkce()
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
              "scope": "openid offline_access", "state": secrets.token_urlsafe(16),
              "code_challenge": challenge, "code_challenge_method": "S256", "resource": RESOURCE}
    params.update(extra or {})
    url = meta.get("authorization_endpoint", MCP + "/authorize") + "?" + urllib.parse.urlencode(params)
    print("GET authorize, walking redirects:")
    follow(url)
    return client_id


def token_errors(meta, client_id, redirect_uri):
    head("Token and revocation endpoints with made-up values")
    status, h, raw = call("POST", meta.get("token_endpoint", MCP + "/token"),
                          form={"grant_type": "authorization_code", "code": "not-a-code", "redirect_uri": redirect_uri,
                                "code_verifier": "x" * 64, "client_id": client_id, "resource": RESOURCE})
    print(f"token(bad code) -> {status} {raw[:300].decode('utf-8', 'replace')}")
    status, h, raw = call("POST", meta.get("token_endpoint", MCP + "/token"),
                          form={"grant_type": "refresh_token", "refresh_token": "not-a-token", "client_id": client_id,
                                "resource": RESOURCE})
    print(f"token(bad refresh) -> {status} {raw[:300].decode('utf-8', 'replace')}")
    if meta.get("revocation_endpoint"):
        status, h, raw = call("POST", meta["revocation_endpoint"],
                              form={"token": "not-a-token", "token_type_hint": "refresh_token", "client_id": client_id})
        print(f"revoke(bad token) -> {status} {raw[:300].decode('utf-8', 'replace')}")


def rpc(body, headers):
    hdrs = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    hdrs.update(headers)
    return call("POST", RESOURCE, body=body, headers=hdrs)


def parse_rpc(h, raw):
    ctype = {k.lower(): v for k, v in h.items()}.get("content-type", "")
    text = raw.decode("utf-8", "replace")
    if "text/event-stream" in ctype:
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:])
        return None
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        return None


def mcp():
    head("MCP endpoint without a token, and with a made-up one")
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "Fielua-probe", "version": "1"}}}
    for label, hdrs in (("no token", {}), ("bad token", {"Authorization": "Bearer not-a-token"}),
                        ("bad tvly key", {"Authorization": "Bearer tvly-dev-notakey"})):
        status, h, raw = rpc(init, hdrs)
        print(f"{label}: initialize -> {status}")
        show_headers(h, ["www-authenticate", "content-type", "location"])
        print("  " + raw[:300].decode("utf-8", "replace").replace("\n", " "))
    call_body = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                 "params": {"name": "tavily_search", "arguments": {"query": "東京スカイツリー 高さ", "max_results": 3, "search_depth": "basic"}}}
    status, h, raw = rpc(call_body, {"Authorization": "Bearer not-a-token"})
    print(f"bad token: tools/call -> {status}")
    show_headers(h, ["www-authenticate", "content-type"])

    head("MCP endpoint in keyless mode (same tool a signed-in token reaches)")
    keyless = {"X-Tavily-Access-Mode": "keyless"}
    status, h, raw = rpc(init, keyless)
    print(f"initialize -> {status}")
    show_headers(h, ["content-type", "mcp-session-id"])
    reply = parse_rpc(h, raw)
    print("  " + json.dumps(reply, ensure_ascii=False)[:600])
    session = {k.lower(): v for k, v in h.items()}.get("mcp-session-id")
    with_session = dict(keyless)
    if session:
        with_session["Mcp-Session-Id"] = session
    status, h, raw = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, with_session)
    print(f"tools/list -> {status}")
    reply = parse_rpc(h, raw) or {}
    for tool in (reply.get("result") or {}).get("tools", []):
        props = (tool.get("inputSchema") or {}).get("properties", {})
        print(f"  tool {tool.get('name')}: required={tool.get('inputSchema', {}).get('required')} params={list(props)}")
        if tool.get("name") == "tavily_search":
            for k in ("query", "max_results", "search_depth", "include_raw_content", "topic"):
                if k in props:
                    print(f"    {k}: {json.dumps(props[k], ensure_ascii=False)[:300]}")
            print(f"    outputSchema: {json.dumps(tool.get('outputSchema'), ensure_ascii=False)[:500]}")
    status, h, raw = rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, with_session)
    print(f"notifications/initialized -> {status}")
    own = dict(keyless)
    own["mcp-session-id"] = secrets.token_hex(16)
    for label, hdrs in (("with session", with_session), ("stateless, like Tavily's CLI", keyless),
                        ("own session id, like Tavily's CLI", own)):
        status, h, raw = rpc(call_body, hdrs)
        print(f"tools/call tavily_search ({label}) -> {status}")
        show_headers(h, ["content-type"])
        reply = parse_rpc(h, raw)
        if not reply:
            print("  " + raw[:500].decode("utf-8", "replace"))
            continue
        result = reply.get("result") or {}
        print(f"  result keys={list(result)} isError={result.get('isError')} error={reply.get('error')}")
        structured = result.get("structuredContent")
        content = result.get("content") or []
        print(f"  structuredContent={'yes' if structured else 'no'} content types={[c.get('type') for c in content]}")
        payload = structured
        if not payload and content:
            text = content[0].get("text", "")
            print(f"  content[0].text starts: {text[:200]!r}")
            try:
                payload = json.loads(text)
            except Exception:  # noqa: BLE001
                payload = None
        if isinstance(payload, dict):
            print(f"  payload keys={list(payload)}")
            if "results" not in payload:
                print("  payload: " + json.dumps(payload, ensure_ascii=False)[:1200])
            for item in (payload.get("results") or [])[:3]:
                print(f"    - {item.get('title', '')[:50]} | {item.get('url', '')[:80]} | content {len(item.get('content') or '')} chars | keys={list(item)}")


def rest_keyless():
    head("REST search in keyless mode (comparison)")
    status, h, raw = call("POST", "https://api.tavily.com/search", body={"query": "東京スカイツリー 高さ", "max_results": 3},
                          headers={"X-Tavily-Access-Mode": "keyless"})
    print(f"api.tavily.com/search keyless -> {status}")
    try:
        data = json.loads(raw)
        print(f"  keys={list(data)}")
        if "results" in data:
            for item in data["results"][:3]:
                print(f"    - {item.get('title', '')[:50]} | {item.get('url', '')[:80]} | keys={list(item)}")
        else:
            print("  " + json.dumps(data, ensure_ascii=False)[:800])
    except Exception:  # noqa: BLE001
        print("  " + raw[:300].decode("utf-8", "replace"))


def sign_up_page(meta, redirect_uri="fielua://oauth/tavily"):
    """Can the app's 新規登録 open Tavily's sign-up page itself?

    The app would fetch mcp.tavily.com/authorize itself (no cookies, no
    redirects followed), check that it sends the browser on to
    auth.tavily.com/authorize, add Auth0's documented screen_hint=signup to
    that address, and open it in the sign-in sheet. That works only if
    mcp.tavily.com keeps nothing in a cookie at /authorize (the sheet would
    not have it when Tavily sends the browser back to its callback)."""
    global plain
    head(f"Direct sign-up: register a public native client with redirect {redirect_uri}")
    payload = {"client_name": "Fielua", "redirect_uris": [redirect_uri],
               "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
               "token_endpoint_auth_method": "none", "scope": "openid offline_access", "application_type": "native"}
    status, h, raw = call("POST", meta.get("registration_endpoint", MCP + "/register"), body=payload)
    print(f"POST register -> {status}")
    client_id = json.loads(raw).get("client_id") if status in (200, 201) else None
    if not client_id:
        print("  " + raw[:300].decode("utf-8", "replace"))
        return
    for attempt in (1, 2):
        head(f"Direct sign-up, attempt {attempt}: GET mcp.tavily.com/authorize without cookies or redirects")
        plain = urllib.request.build_opener(NoRedirect)
        _, challenge = pkce()
        state = secrets.token_urlsafe(32)
        params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
                  "scope": "openid offline_access", "state": state, "code_challenge": challenge,
                  "code_challenge_method": "S256", "resource": RESOURCE}
        url = meta.get("authorization_endpoint", MCP + "/authorize") + "?" + urllib.parse.urlencode(params)
        status, h, raw = call("GET", url, headers={"Accept": "text/html"})
        lower = {k.lower(): v for k, v in h.items()}
        print(f"  status {status}")
        set_cookie = [v for k, v in h.items() if k.lower() == "set-cookie"]
        print(f"  Set-Cookie names: {[c.split('=', 1)[0] for c in set_cookie] or 'none'}")
        show_headers(h, ["cache-control", "content-type"])
        loc = lower.get("location")
        if not loc:
            print("  no Location; body: " + raw[:300].decode("utf-8", "replace"))
            continue
        target = urllib.parse.urlparse(loc)
        query = urllib.parse.parse_qs(target.query)
        print(f"  Location: {target.scheme}://{target.netloc}{target.path}")
        print(f"  Location params: {sorted(query)}")
        for name in ("redirect_uri", "response_type", "scope", "prompt", "screen_hint", "audience", "response_mode"):
            if name in query:
                print(f"    {name} = {query[name][0][:120]}")
        for name in ("state", "client_id", "code_challenge", "nonce"):
            if name in query:
                v = query[name][0]
                print(f"    {name}: {len(v)} chars, same as ours: {v == state}")
        if target.netloc != "auth.tavily.com" or target.path != "/authorize":
            print("  NOT auth.tavily.com/authorize: the app would fall back to the plain sign-in")
            continue
        sep = "&" if target.query else "?"
        head(f"Attempt {attempt}: that Location + screen_hint=signup, fresh cookie jar")
        follow(loc + sep + "screen_hint=signup")
        if attempt == 1:
            head(f"Attempt {attempt}: control, the same kind of Location without screen_hint (new transaction)")
            plain = urllib.request.build_opener(NoRedirect)
            _, challenge = pkce()
            params.update(state=secrets.token_urlsafe(32), code_challenge=challenge)
            status, h, raw = call("GET", meta.get("authorization_endpoint", MCP + "/authorize") + "?" + urllib.parse.urlencode(params))
            control = {k.lower(): v for k, v in h.items()}.get("location")
            if control:
                follow(control)
    head("Callback without the cookie jar: what mcp.tavily.com says to a made-up Auth0 return")
    plain = urllib.request.build_opener(NoRedirect)
    for path in ("/callback", "/oauth/callback", "/auth/callback"):
        status, h, raw = call("GET", MCP + path + "?code=not-a-code&state=not-a-state")
        loc = {k.lower(): v for k, v in h.items()}.get("location")
        print(f"  GET {path}?code=…&state=… -> {status} {('Location ' + describe_url(loc)) if loc else raw[:160].decode('utf-8', 'replace')}")


def main():
    status, h, raw = call("GET", MCP + "/.well-known/oauth-authorization-server")
    meta = json.loads(raw) if status == 200 else {}
    print(f"metadata -> {status}; endpoints: {meta.get('authorization_endpoint')}, {meta.get('registration_endpoint')}")
    sign_up_page(meta)


if __name__ == "__main__":
    sys.exit(main())
