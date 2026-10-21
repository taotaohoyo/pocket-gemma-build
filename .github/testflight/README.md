# TestFlight へのアップロード

`testflight.yml` は、作業ブランチの PocketGemma-source.zip をビルドし、有料チームで署名して TestFlight（内部テスターだけ）に上げます。署名の鍵は GitHub の Environment `testflight` にだけ置き、公開リポジトリにも Releases にも Actions の成果物にも出しません。

## 流れ

1. **archive ジョブ（鍵なし）**
   - `set-bundle-id.py` が、このジョブのチェックアウトの中だけで、Bundle ID を有料チームの App ID に変えます。アプリは `BUNDLE_ID`（`com.fielua.app`）、Live Activity の拡張は `com.fielua.app.activity` です。PocketGemma-source.zip は `app.pocketgemma.personal` のままなので、SideInstaller と AltStore 用の署名なしビルドは変わりません。
   - 指定したブランチを、署名なしで `xcodebuild archive` します。アーカイブのアプリと拡張が新しい ID になっていることを確かめます。
   - `finish-archive.sh` が、`scripts/build-ios.sh` と同じランタイムの記録とライセンスを入れます。そのうえで、App Store 用のプライバシーマニフェスト（`PrivacyInfo.xcprivacy`）を入れ、ソースの `check-ipa.py` で確かめます。
   - 署名なしのアーカイブを、1日だけの成果物として次のジョブに渡します。中身は、今までの署名なし IPA と同じ種類のものです。
2. **upload ジョブ（Environment `testflight`、承認が要る）**
   - このワークフローがあるブランチ（main）の `.github/testflight` のスクリプトだけを使います。ビルドしたブランチのコードは、鍵と同じジョブでは動かしません。
   - アーカイブの SHA-256 を確かめます。
   - `sign-archive.sh` が、アプリと Live Activity 拡張を、それぞれの識別子の権限で ad hoc 署名します。アプリには、`memory_entitlements` で選んだメモリの権限も付けます。拡張には付けません。署名のあと、`check-export.py --adhoc` で中身を確かめます。
   - `export-upload.sh` が、App Store Connect の API キーで、有料チームのクラウド管理の配布証明書を使って書き出します。書き出しは2回です。
     1. ランナーの上に IPA を作り、`check-export.py` で確かめてから消します。
     2. 確かめが通ったときだけ、同じアーカイブと同じ設定で、TestFlight に直接上げます（`testFlightInternalTestingOnly`）。
   - `check-export.py` が確かめること（アプリと拡張のそれぞれ）
     - App ID（`application-identifier`）とチームが、Bundle ID と Team ID に合っている。
     - メモリの権限が、選んだとおりにアプリだけに付いている。拡張には付いていない。デバッグ用の Increased Debugging Memory Limit はどこにも付いていない。
     - 埋め込まれたプロファイルが、そのチームの App Store 用（端末の一覧なし、TestFlight 可、期限内）である。
     - 署名に入った権限が、すべてプロファイルで許されている。選んだメモリの権限を、プロファイルが許している。
     - 配布用の証明書で署名され、`codesign --verify --deep --strict` が通る。
   - ジョブのログは公開されます。そのため、出すのは `redact-log.py` で絞り、名前とメールを伏せた行だけです。署名した IPA、プロファイル、ログ全体は、ランナーの外に出しません。

## 最初に一度だけ設定すること

### Apple Developer と App Store Connect

1. Developer サイトの Identifiers で、Explicit の App ID を2つ登録します。
   - アプリ：`com.fielua.app`（ワークフローの `BUNDLE_ID`）
   - Live Activity の拡張：`com.fielua.app.activity`
   - アプリの App ID では、Extended Virtual Address Space と Increased Memory Limit をオンにします（`memory_entitlements` の既定 `eva+iml` に要ります）。拡張の App ID ではオンにしません。
2. App Store Connect で、新規 App を作ります。Bundle ID は `com.fielua.app` にします。名前は App Store 全体で重ならないものにします（今は Fielua）。iPhone のホーム画面の名前は、アプリの設定どおり「Pocket AI」です。
3. TestFlight の内部テスターのグループを作り、自分を入れます。
4. App Store Connect の「ユーザとアクセス」から「統合」、「App Store Connect API」を開きます。チームキーを **Admin** のアクセスで作ります。
   - クラウド管理の配布証明書を API キーで使うには、Admin が要ります。
   - .p8 は一度しかダウンロードできません。

### GitHub（Settings の Environments）

1. `testflight` という名前の Environment を作ります。
2. Required reviewers に自分（taotaohoyo）を入れます。「Prevent self-review」はオフのままにします（実行は Claude が自分のアカウントで始めるため）。
3. Deployment branches and tags で「Selected branches and tags」を選び、`main` だけにします。
4. Environment secrets に、次を入れます。リポジトリの Secrets には入れません。

| 名前 | 中身 |
|---|---|
| `APPLE_TEAM_ID` | 有料チームの Team ID（10文字） |
| `ASC_KEY_ID` | API キーの キー ID |
| `ASC_ISSUER_ID` | API キーの 発行者 ID |
| `ASC_KEY_P8` | .p8 ファイルの中身全体（`-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----` まで） |
| `APPLE_TEAM_NAME` | 任意。メンバーシップに出る自分の名前。ログに出たときに GitHub が伏せます |

## 実行のしかた

1. Actions の「Upload a build to TestFlight」を、main で手動実行します。
   - `source_ref` には、ビルドするブランチかコミットを入れます。
   - `memory_entitlements` は、ふだんは `eva+iml` のままにします。片方だけの効き目を比べるときは `eva` か `iml`、付けない版は `none` にします。選んだ権限が App ID でオンになっていないと、書き出しか確かめで止まり、何も上がりません。
2. archive ジョブが終わると、upload ジョブが承認待ちになります。「Review deployments」で `testflight` を承認します。
3. App Store Connect の処理が終わると、TestFlight アプリに出ます。

## メモリの権限について

- **Extended Virtual Addressing**（`com.apple.developer.kernel.extended-virtual-addressing`）
  - iOS 14 から。アプリが使えるアドレス空間を広げます。
  - 有料の Apple Developer Program（と Enterprise）だけで使えます。無料の Apple ID では使えません。
- **Increased Memory Limit**（`com.apple.developer.kernel.increased-memory-limit`）
  - iOS 15 から。アプリが使えるメモリの上限を上げてよい、とシステムに伝えます。
  - Apple の説明では、上がるのは一部の機種だけです。実際に使える量は `os_proc_available_memory` で確かめます。増えなくても正しく動くようにしておく必要があります。
- **Increased Debugging Memory Limit** はデバッグ用で、配布するビルドには入りません。このワークフローでは付けません。
- TestFlight と App Store では、Apple がアプリを署名し直して配ります。権限は、上げたビルドの署名とプロファイルに入っているものが使われます。このワークフローは、上げる前の署名を確かめます。実機で効いているかは、アプリの「画像の最小再現テスト」で、アドレス空間の広さ・最大の連続した空き・`os_proc_available_memory` を、権限のないアプリと比べて確かめます。

## 注意

- App ID を変えるときは、`testflight.yml` の `BUNDLE_ID` を変えます。拡張は、いつも `<BUNDLE_ID>.activity` です。どちらの App ID も、Developer サイトと App Store Connect に先に作っておきます。

- TestFlight は、同じ版の同じビルド番号を2回受け付けません。上げるたびに、新しいビルド番号（project.yml の `CURRENT_PROJECT_VERSION`）が要ります。
- 鍵を差し替えるときは、App Store Connect で古いキーを取り消し、Environment の Secrets を入れ直します。
- 書き込める人はワークフローを変えられます。鍵を守っているのは、Environment の承認と、main だけという制限です。
- プライバシーマニフェストは、いくつかのスレッドが PocketGemma-source.zip を編集している間は、ここに置いています。落ち着いたら、ソースの `PocketGemma/` に移します。
