# Fielua for the web

https://suelira.com/chat/ に置く、Fielua の Web 版です。iPhone の Safari と PC のブラウザで、Anthropic の Claude と話せます。使えるのは開発者と、開発者が招待した人だけです。

- ページは静的なファイルだけです（HTML・JavaScript・CSS・画像・フォント）。さくらのレンタルサーバーの `chat/` フォルダーにそのまま置きます。PHP もデータベースも使いません。
- Claude とは、このリポジトリの中継サーバー（`../claude-relay/`、Cloudflare Workers）を通して話します。Anthropic の API キーは中継サーバーのシークレットにだけあり、ページには一切入りません。
- ログインはパスキー（Face ID、Touch ID、Windows Hello など）です。中継サーバーが検証し、12 時間だけ使えるセッションをこのタブの中（sessionStorage）にだけ置きます。Cookie は使いません。
- Markdown は iPhone の Fielua と同じ規則で表示します（`src/mdsource.js` は PocketCore の MarkdownSource、`src/highlight.js` は SyntaxHighlighter、`src/stream.js` の Pacer は ReplyPacer の移植）。表示は markdown-it、無害化は DOMPurify、数式は KaTeX です。
- 写真・動画・ファイルを添付できます（`src/attach.js`、入力欄の ＋）。写真は長い辺 1568 ピクセルの JPEG にして位置情報などを消し、動画は音声なしの静止画数枚（長さに応じて 3〜8 場面）にします。PDF とテキスト（UTF-8 と Shift_JIS）はそのまま送ります。1 回に送れる量は中継サーバーが `/v1/status` の `attachments.bytes` で知らせます（無料プランでは約 2.2 MB）。添付の中身はページの中だけにあり、タブの保存領域には小さな絵と名前だけを置きます。
- ＋メニューで「ウェブ検索」と「ファイル作成」をオンにできます（オンの間は入力欄に印）。検索した語と、返事が引用したページ（情報源）を返事に添えます。Claude が作ったファイルは返事の下に並び、「保存」で中継サーバーから受け取ります（30 日ほど）。ファイルは本人のものだけ受け取れ、HTML や SVG などは中身が動かない形で保存します。
- 会話履歴（`src/history.js`、左上の一覧ボタン）は iPhone の Fielua の履歴と同じ形です。携帯では会話が横へずれて下から一覧が出て、PC の広い画面では一覧が会話の横に並びます。履歴はこの端末のブラウザの IndexedDB にだけ置き、中継サーバーには送りません。1 件ずつ AES-GCM で暗号化します。鍵はログインのあと中継サーバーから受け取る本人用の鍵（`GET /v1/history-key`）で、ページのメモリーにだけ置きます。そのため、ログインしていないと読めません。ログインの期限（12 時間）が来ると、ページが自分でログアウトし、鍵を手放します。同じ人がタブを 2 つ開いているときは、片方での追加や削除がもう片方にも届き、古い写しで上書きしません（会話ごとの版 `savedAt` で新しい方を選びます）。登録を解除すると、鍵もこの端末のデータベースも消えます。Safari は 7 日ほど使わないサイトのデータを消すことがあります（ホーム画面に追加した場合を除く）。
- 返事の途中で接続が切れても続きます（iPhone の Safari は、裏に回したページの通信を止めます）。ページは返事ごとに鍵（ランダムな 32 桁の 16 進数）を先に決めて会話と一緒に残し、`POST /v1/replies/:key` で頼みます。中継サーバーはページの接続が切れても返事を作り続けます（思考もやり直しません）。ページは戻ったとき（画面に出て、オンライン）に `GET /v1/replies/:key` でつなぎ直し、受け取り済みの分を飛ばして続きを並べます（その間は「つなぎ直しています…」。Anthropic がまだ答え始めていなければ 409 で、少し待って聞き直します）。頼んだ直後に答えが来ないまま切れたときも、同じ鍵で受け取りに行くので、二度は頼みません。3 秒以上裏にいたとき、または 1 分何も来ないときも、念のため新しい接続に替えます。Safari がページを読み込み直したときも、書きかけの返事を同じ場所で受け取り直します（そのタブのものだけ。ほかのタブが受け取っている返事は Web Locks で取りません）。受け取り終えたら、または停止を押したら `DELETE /v1/replies/:key` で中継サーバーに知らせます（停止なら Anthropic への問い合わせも止まります。`DELETE` が先に着いたら、その返事は頼まれません）。オフラインで送ったときは今まで通りすぐ「接続できません」と出します。中継サーバーが古いと（`/v1/status` の `resumable` がない）、今まで通り `POST /v1/messages` です。
- 動きは iPhone の Fielua のばねと同じです。`tools/springs.mjs` が、アプリのばね（ChatMotion.swift、FlowerMark.swift）を CSS の `linear()` の曲線と長さにして出し、それを `src/styles.css` の「MARK: Motion」に置いています。出るときだけでなく、消えるときにも動きます（`src/motion.js`：`.leaving` や `.closing` の動きが終わってから `hidden` や `close()`）。花（`src/flower.js`）は、`assets/flower.png` をアプリの花びらの形（5 枚）で切り抜いて重ねたもので、ログインの画面で開き、空のチャットでゆっくり呼吸します。「視差効果を減らす」では、どれも動かずに出ます。新しい動きは、その場かぎりの秒数ではなく、`motion.js` とこのトークンで作ります。
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

動きを目で確かめるときは、`STUDIO=<フォルダー> node test/e2e.mjs` です（チェックの代わりに `test/studio.mjs` が動き、iPhone と PC、ライトとダークの画面と、動きのコマ送りの画像をそのフォルダーに置きます。`STUDIO_ONLY=strip` でコマ送りだけ）。

`test/e2e.mjs` は、本物の中継サーバーのコードを手元の Cloudflare 実行環境（workerd）で動かし、仮想の認証器でパスキーを作り、Anthropic の代わりの小さなサーバーと話します。本物の Anthropic には何も送りません。
