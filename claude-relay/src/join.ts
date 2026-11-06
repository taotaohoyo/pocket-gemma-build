// The page an invite link opens (https://<relay>/join#XXXX-XXXX-XXXX-XXXX).
// The code is after the #, so it never reaches the relay or any log: the
// page's own script reads it and offers to open Fielua with it, where the
// person confirms before anything is registered.

export function joinPage(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Fielua の招待</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px; background: #f7f3ea; color: #2b2a26; }
  @media (prefers-color-scheme: dark) { body { background: #1d1c1a; color: #eeeae2; } .note { color: #a9a49a; } }
  main { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  a.open { display: block; text-align: center; padding: 14px; border-radius: 14px; background: #f2c94c; color: #2b2a26; text-decoration: none; font-weight: 600; margin: 24px 0; }
  code { font-size: 20px; letter-spacing: 1px; }
  .note { color: #6b665c; font-size: 15px; }
</style>
</head>
<body>
<main>
  <h1>Fielua で Claude を使う招待</h1>
  <p>Fielua から Claude（Anthropic の外部 AI）を使えるようにする招待です。</p>
  <a class="open" id="open" href="#">Fielua で開く</a>
  <p class="note">開けないときは、Fielua の 設定 › Claude で次のコードを入力してください。</p>
  <p><code id="code">（コードがありません）</code></p>
  <p class="note">コードは一度だけ使えて、72 時間で無効になります。ほかの人に見せないでください。</p>
</main>
<script nonce="${nonce}">
  const code = decodeURIComponent(location.hash.slice(1)).replace(/[^0-9A-Za-z-]/g, "").slice(0, 24);
  if (code) {
    document.getElementById("code").textContent = code;
    document.getElementById("open").href = "fielua://claude?server=" + encodeURIComponent(location.origin) + "&code=" + encodeURIComponent(code);
  }
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
