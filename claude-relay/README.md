# Fielua Claude relay

Fielua から Claude（Anthropic の公式 API）を使うための中継サーバーです。Cloudflare Workers で動きます。

- Anthropic の API キーは、このサーバーの「シークレット」にだけ置きます。アプリ、iPhone、GitHub には置きません。
- アプリは端末ごとの利用キー（アクセストークン）で中継に入ります。開発者はいつでも止められます。
- 友人は開発者が作る招待コード（1 回だけ・72 時間で無効）で登録します。友人が Claude を使えるのは、開発者が「友人の利用」をオンにしたときだけです（最初はオフ）。
- Anthropic がクレジット切れ（billing_error）や利用上限を返したら、中継は自分で止まり、開発者が再開するまで Anthropic に何も送りません。追加購入はしません。
- 会話の内容は保存もログもしません。登録情報（名前・役割・利用キーのハッシュ）だけを Durable Object（SQLite）に置きます。

## 使っているもの

| | |
|---|---|
| 選べるモデル | Claude Opus 5.5（`claude-opus-5-5`）、Fable 5.2（`claude-fable-5-2`）、Sonnet 5.5（`claude-sonnet-5-5`）、Haiku 5.5（`claude-haiku-5-5`）。この 4 つ以外は断ります（`src/claude.ts` の `MODELS`）。Fable 5.1（`claude-fable-5-1`）は 5.2 に置き換えたので一覧に出しませんが、5.1 で始めた iPhone のチャットは続けられます |
| 推論レベル | 低・中・高・超高（`low`・`medium`・`high`・`xhigh`）。毎回 `output_config.effort` で明示して送ります。`max` は選べません |
| 選ばなかったとき | `claude-opus-5-5`（`wrangler.toml` の `CLAUDE_MODEL`）を、そのモデルの標準のレベルで |
| 1 回の返事の上限 | 低 16,000・中 32,000・高と超高 64,000 トークン。`CLAUDE_MAX_TOKENS`（64,000）を超えません |
| 考えている間 | 考えの要約が流れてきます（`thinking.display: "summarized"`）。料金は隠したときと同じです |
| 断られたとき | サーバー側のフォールバック（`fallbacks: "default"`）。Haiku 5.5 にはありません |

## 公開する手順

1. Cloudflare のダッシュボードで Workers & Pages › 作成 › リポジトリをインポートし、このリポジトリを選びます。
   - プロジェクト名: `fielua-claude`
   - ルートディレクトリ: `claude-relay`
   - デプロイコマンド: `npx wrangler deploy`（最初から入っています）
2. できた Worker の 設定 › 変数とシークレット で、次の 2 つを「シークレット」として足します。
   - `ANTHROPIC_API_KEY`: Anthropic Console で作った API キー
   - `ADMIN_TOKEN`: Fielua の 設定 › Claude で作る管理キー（32 文字以上）
3. Fielua の 設定 › Claude に、Worker のアドレス（`https://fielua-claude.<あなたのサブドメイン>.workers.dev`）と管理キーを入れて、この iPhone を登録します。

## 確かめ方

```sh
npm ci
npm run check        # 型
npm test             # 経路・認証・招待・停止（Node の SQLite で）
npm run test:local   # Cloudflare の実行環境（workerd）で、本物のキーなしに通しで
```
