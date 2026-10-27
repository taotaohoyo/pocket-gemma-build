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
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
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


def follow(url, hops=8):
    """Walks the sign-in redirects (no cookies kept) and prints each hop."""
    for _ in range(hops):
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
        print("    links: " + ", ".join(h_ for h_ in hrefs if "sign" in h_.lower() or "regist" in h_.lower() or "auth" in h_.lower())[:800])
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
    for label, hdrs in (("with session", with_session), ("stateless, like Tavily's CLI", keyless)):
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
            for item in payload.get("results", [])[:3]:
                print(f"    - {item.get('title', '')[:50]} | {item.get('url', '')[:80]} | content {len(item.get('content') or '')} chars | keys={list(item)}")


def main():
    meta = metadata()
    first = None
    for uri in ("fielua://oauth/tavily", "com.fielua.app:/oauth/tavily", "app.pocketgemma.personal:/oauth/tavily",
                "https://fielua.invalid/oauth/tavily"):
        cid = register_and_authorize(meta, uri)
        first = first or (cid, uri) if cid else first
    if first:
        cid, uri = first
        for extra in ({"prompt": "create"}, {"screen_hint": "signup"}, {"prompt": "login"}):
            head(f"authorize with {extra}")
            _, challenge = pkce()
            params = {"response_type": "code", "client_id": cid, "redirect_uri": uri, "scope": "openid offline_access",
                      "state": secrets.token_urlsafe(16), "code_challenge": challenge, "code_challenge_method": "S256",
                      "resource": RESOURCE}
            params.update(extra)
            follow(meta.get("authorization_endpoint", MCP + "/authorize") + "?" + urllib.parse.urlencode(params))
        token_errors(meta, cid, uri)
    mcp()


if __name__ == "__main__":
    sys.exit(main())
