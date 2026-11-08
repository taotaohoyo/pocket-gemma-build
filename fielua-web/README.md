# Fielua for the web

https://suelira.com/chat/ に置く、Fielua の Web 版です。iPhone の Safari と PC のブラウザで、Anthropic の Claude と話せます。使えるのは開発者と、開発者が招待した人だけです。

- ページは静的なファイルだけです（HTML・JavaScript・CSS・画像・フォント）。さくらのレンタルサーバーの `chat/` フォルダーにそのまま置きます。PHP もデータベースも使いません。
- Claude とは、このリポジトリの中継サーバー（`../claude-relay/`、Cloudflare Workers）を通して話します。Anthropic の API キーは中継サーバーのシークレットにだけあり、ページには一切入りません。
- ログインはパスキー（Face ID、Touch ID、Windows Hello など）です。中継サーバーが検証し、12 時間だけ使えるセッションをこのタブの中（sessionStorage）にだけ置きます。Cookie は使いません。
- Markdown は iPhone の Fielua と同じ規則で表示します（`src/mdsource.js` は PocketCore の MarkdownSource、`src/highlight.js` は SyntaxHighlighter、`src/stream.js` の Pacer は ReplyPacer の移植）。表示は markdown-it、無害化は DOMPurify、数式は KaTeX です。
- 写真・動画・ファイルを添付できます（`src/attach.js`、入力欄の ＋）。写真は長い辺 1568 ピクセルの JPEG にして位置情報などを消し、動画は音声なしの静止画数枚（長さに応じて 3〜8 場面）にします。PDF とテキスト（UTF-8 と Shift_JIS）はそのまま送ります。1 回に送れる量は中継サーバーが `/v1/status` の `attachments.bytes` で知らせます（無料プランでは約 2.2 MB）。添付の中身はページの中だけにあり、タブの保存領域には小さな絵と名前だけを置きます。
- ページの Content Security Policy は、自分のファイルの読み込み（添付は `blob:` と `data:`）と、中継サーバーへの通信だけを許します。

## 作り方

```sh
npm ci
RELAY_URL=https://fielua-claude.<サブドメイン>.workers.dev node build.mjs
```

`dist/chat/` に置くファイル一式、`dist/fielua-web-chat.zip`、`dist/SHA256SUMS.txt` ができます。中継サーバーのアドレスは秘密ではありません。スクリプトとページの CSP に書き込まれます。作るときに、キーのような文字列が入っていないかも確かめます。

## 置き方

`dist/chat/` の中身を、サーバーの `www/suelira.com/chat/` に全部置きます（`.htaccess` も。Mac の Finder では ⌘⇧. で見えます）。サイトのトップの `index.html`、`.htaccess`、`assets/` には触れません。`chat/.htaccess` は、このフォルダーだけのヘッダー（CSP、フレーム禁止、キャッシュ）を決めます。

中継サーバー側は `../claude-relay/wrangler.toml` の `WEB_ORIGINS`（このページの置き場所）と `WEB_RP_ID`（パスキーのドメイン、`suelira.com`）で Web 版を受け付けます。

## 確かめ方

```sh
node test/markdown-check.mjs   # iPhone の Markdown のテスト 49 件と、Web 版のもの
node test/e2e.mjs              # Chromium で通しで（中継サーバーを wrangler dev で、Anthropic は代役）
```

`test/e2e.mjs` は、本物の中継サーバーのコードを手元の Cloudflare 実行環境（workerd）で動かし、仮想の認証器でパスキーを作り、Anthropic の代わりの小さなサーバーと話します。本物の Anthropic には何も送りません。
