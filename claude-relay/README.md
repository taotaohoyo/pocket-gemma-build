# Fielua Claude relay

Fielua から Claude（Anthropic の公式 API）を使うための中継サーバーです。Cloudflare Workers で動きます。

- Anthropic の API キーは、このサーバーの「シークレット」にだけ置きます。アプリ、iPhone、GitHub には置きません。
- アプリは端末ごとの利用キー（アクセストークン）で中継に入ります。開発者はいつでも止められます。
- 友人は開発者が作る招待コード（1 回だけ・72 時間で無効）で登録します。友人が Claude を使えるのは、開発者が「友人の利用」をオンにしたときだけです（最初はオフ）。
- Anthropic がクレジット切れ（billing_error）や利用上限を返したら、中継は自分で止まり、開発者が再開するまで Anthropic に何も送りません。追加購入はしません。
- 会話の内容は保存もログもしません（Web 版の返事をメモリーに一時的に預かるのは下の「接続が切れたとき」だけ）。登録情報（名前・役割・利用キーのハッシュ）だけを Durable Object（SQLite）に置きます。Web 版の人には「履歴の鍵」（ランダム 32 バイト、`GET /v1/history-key`、Web のセッションだけ）も置きます。ブラウザはこの鍵で、その端末の中だけにある会話履歴を暗号化します。鍵は本人の削除（登録の解除を含む）で消えます。

## 使っているもの

| | |
|---|---|
| 選べるモデル | Claude Opus 5.5（`claude-opus-5-5`）、Fable 5.1（`claude-fable-5-1`）、Sonnet 5.5（`claude-sonnet-5-5`）、Haiku 5.5（`claude-haiku-5-5`）。この 4 つ以外は断ります（`src/claude.ts` の `MODELS`） |
| 推論レベル | 低・中・高・超高（`low`・`medium`・`high`・`xhigh`）。毎回 `output_config.effort` で明示して送ります。`max` は選べません |
| 選ばなかったとき | `claude-opus-5-5`（`wrangler.toml` の `CLAUDE_MODEL`）を、そのモデルの標準のレベルで |
| 1 回の返事の上限 | 低 16,000・中 32,000・高と超高 64,000 トークン。`CLAUDE_MAX_TOKENS`（64,000）を超えません |
| 考えている間 | 考えの要約が流れてきます（`thinking.display: "summarized"`）。料金は隠したときと同じです |
| 断られたとき | サーバー側のフォールバック（`fallbacks: "default"`）。Haiku 5.5 にはありません |

「Fielua の最上級」は Claude Opus 5.5・超高のことで、Fielua の中での位置づけです（Anthropic の分類ではありません）。

## 公開する手順

1. Cloudflare のダッシュボードで Workers & Pages › 作成 › リポジトリをインポートし、このリポジトリを選びます。
   - プロジェクト名: `fielua-claude`
   - ルートディレクトリ: `claude-relay`
   - デプロイコマンド: `npx wrangler deploy`（最初から入っています）
   - 詳細設定の「パス」は `/claude-relay`。プレビュービルドと Cloudflare Access はオフ、ビルド用の変数は空のまま
   - 作る画面にブランチの欄はなく、最初は `main` から作るので一度失敗します。設定 › ビルド で本番のブランチを中継サーバーのあるブランチに変え、そのブランチに変更を送るとビルドされます
2. できた Worker の 設定 › 変数とシークレット で、次の 2 つを「シークレット」として足します。
   - `ANTHROPIC_API_KEY`: Anthropic Console で作った API キー
   - `ADMIN_TOKEN`: Fielua の 設定 › Claude、または Web 版の「開発者の初期設定」で作る管理キー（32 文字以上）
3. Fielua の 設定 › Claude に、Worker のアドレス（`https://fielua-claude.<あなたのサブドメイン>.workers.dev`）と管理キーを入れて、この iPhone を登録します。

## Web 版（https://suelira.com/chat/）

同じ中継サーバーが、Fielua の Web 版（`../fielua-web/`）も受け付けます。

- ブラウザから呼べるのは `wrangler.toml` の `WEB_ORIGINS`（`https://suelira.com`、`https://www.suelira.com`）のページだけです（CORS）。空にすると Web 版は止まります。
- Web 版のログインはパスキーです（`/web/passkey/…`、RP ID は `WEB_RP_ID` の `suelira.com`、ユーザー確認つき）。中継サーバーが署名を確かめ、12 時間のセッション（`fws_`、ハッシュだけを保存）を渡します。開発者の操作は、ログインから 15 分を過ぎるともう一度パスキーを求めます。
- iPhone がなくても、Web の「開発者の初期設定」で管理キー（`ADMIN_TOKEN`）を一度入れて、開発者として登録できます。
- 写真（JPEG・PNG・GIF・WebP）、PDF、テキストファイルを、本人の発言に付けて送れます（`src/turns.ts`）。中継サーバーは先頭のバイトで種類を確かめ、Anthropic への本文に base64 をそのまま差し込みます（作り直さないので CPU をほとんど使いません）。1 回に送れる量は `ATTACHMENT_MB`（無料プランの 10 ms に収まる 3 が標準。Workers Paid なら 20 まで上げられます）。
- ウェブ検索とファイル作成は、ページが `tools` で頼んだときだけ付けます（`toolParams`）。検索は 1 回の返事で 5 回まで（$10 / 1,000 回、推定クレジットにも入れます）。ファイル作成はコード実行と Anthropic の PDF・Word・Excel・PowerPoint スキルです。返事が作ったファイルとコンテナーは、中継サーバーが流れの中から ID を読んで本人に結び付け、`GET /v1/files/:id`（名前と大きさ）と `/content`（ダウンロード、いつも `application/octet-stream` の添付として）を本人にだけ返します。ほかの人のものは 404 です。
- 接続が切れたとき（iPhone の Safari は、裏に回したページの通信を止めます）: Web 版は返事を `POST /v1/replies/:key` で頼みます。`key` はページが頼む前に決める乱数（16 進 32 文字）で、中継サーバーはその人の ID と組み合わせて返事の Durable Object（`Reply`、`src/reply.ts`）を決めます。返事はページの接続が切れても作られ続けます（思考もやり直しません）。ページは戻ったら `GET /v1/replies/:key` で、返事をはじめのバイトからもう一度受け取り、まだ来ていない続きもそのまま受け取ります（Anthropic が答え始める前は 409）。受け取り終えたら、または停止したら `DELETE /v1/replies/:key`（停止なら Anthropic への問い合わせも止まります。頼む前に届いた停止なら、その返事は頼まれません）。本人のものだけで、ほかの人には同じ key でも 404 です。
  - 返事はメモリーにだけ置き、ストレージやログには書きません。`DELETE` ですぐ、受け取られなくても返事が終わってから 10 分、始まってから 30 分で消えます。その間は 5 分ごとに自分でタイマーを掛け直し、メモリーから外されないようにします（Cloudflare は 1 つの処理を始まりから 15 分までしか数えないため）。
  - CPU は返事の長さによらずほとんど使いません（流れを分けるのも集めるのも実行環境が行います）。Durable Object の時間は、無料枠（1 日 13,000 GB 秒、1 つ 128 MB なら約 29 時間分）から、返事を作っている間と、受け取られなかった返事の 10 分を使います。
  - iPhone アプリは今まで通り `POST /v1/messages` です（接続が切れると止まります）。
- 残りのクレジットは推定です。開発者が Console の残高を入れ、その後の返事の使用量に公開料金をかけて引きます（Anthropic に残高を読む API はありません）。

## 確かめ方

```sh
npm ci
npm run check        # 型
npm test             # 経路・認証・招待・停止（Node の SQLite で）
npm run test:local   # Cloudflare の実行環境（workerd）で、本物のキーなしに通しで
```
