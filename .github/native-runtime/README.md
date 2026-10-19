# ネイティブランタイムの保管と取得

実機ビルドが使う LiteRT-LM ネイティブランタイム（PocketGemma-NativeRuntime.zip）は、GitHub Releases に保管したものを使います。Actions の成果物は7日で消えるため、ビルドは run ID ではなく `release.json` に書いたリリースとSHA-256で取得します。

## ビルドでの取得

- `build-device-candidate.yml`、`check-runtime-smoke.yml`、`build-ios.yml` は、`native_run_id` を空にすると `release.json` のリリースから取得し、サイズとSHA-256を確かめます。その後の `native_artifact.py` による6バイナリの検査は従来どおりです。
- 以前の run ID（38802464425）を渡しても、同じリリースから取得します。
- 新しく作り直したランタイムを試すときは、`rebuild-ios-runtime.yml` の run ID を渡します。その成果物（7日）を使います。
- `verify-native-candidate.yml` は新しい候補を確かめるためのものなので、run ID で取得したままです。

## 新しいランタイムを採用する手順

1. NativeRuntime-source.zip の `native_artifact.py` の BUILD_ID と、`configure-app.py` が確かめる buildID を新しい値にしてから `rebuild-ios-runtime.yml` を実行します。リリースのタグは `native-runtime-<BUILD_ID>` で、同じタグには上書きしません。
2. その run ID を `native_run_id` に渡して実機ビルドなどで確かめます。
3. 成果物が消える7日以内に、「Preserve native runtime in a release」をその run ID で手動実行します。成果物のdigestとビルドログの記録を照合し、秘密情報を検査して下書きリリースを作り、全ファイルを取得し直して照合します。
4. 生成された `release.json`（リリースにも入っています）を `.github/native-runtime/release.json` にコミットします。
5. 同じワークフローを publish にチェックして実行すると、プレリリースとして公開します（「最新版」にはしません）。秘密情報が見つかった場合は公開しません。

## 確認と移行

- リリースのファイルは `sha256sum -c PocketGemma-NativeRuntime.zip.sha256` で確かめられます。`manifest.json` に各バイナリと全ファイルのSHA-256、元の run とコミットがあります。
- 取得は Python 標準ライブラリとリポジトリを読めるトークンだけで動くので、Private にしてもそのまま使えます。セルフホストの Mac では `GH_TOKEN` を設定して `python3 .github/native-runtime/runtime_release.py fetch build/native-artifact` を実行します。
- Actions のトークンは workflows 権限を持てず、ワークフローが main と違うコミットにはタグを作れません。そのためタグは main に置き、ビルド元のコミットは `release.json` に記録しています。
