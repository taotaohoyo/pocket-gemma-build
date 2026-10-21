# TestFlight へのアップロード

`testflight.yml` は、作業ブランチの PocketGemma-source.zip をビルドし、有料チームで署名して TestFlight（内部テスターだけ）に上げます。署名の鍵は GitHub の Environment `testflight` にだけ置き、公開リポジトリにも Releases にも Actions の成果物にも出しません。

## 流れ

1. **archive ジョブ（鍵なし）**
   - 指定したブランチを、署名なしで `xcodebuild archive` します。
   - `finish-archive.sh` が、`scripts/build-ios.sh` と同じランタイムの記録とライセンスを入れます。そのうえで、App Store 用のプライバシーマニフェスト（`PrivacyInfo.xcprivacy`）を入れ、ソースの `check-ipa.py` で確かめます。
   - 署名なしのアーカイブを、1日だけの成果物として次のジョブに渡します。中身は、今までの署名なし IPA と同じ種類のものです。
2. **upload ジョブ（Environment `testflight`、承認が要る）**
   - このワークフローがあるブランチ（main）の `.github/testflight` のスクリプトだけを使います。ビルドしたブランチのコードは、鍵と同じジョブでは動かしません。
   - アーカイブの SHA-256 を確かめます。
   - `sign-archive.sh` が、アプリと Live Activity 拡張を、それぞれの識別子の権限で ad hoc 署名します。`address_space` を選んだときは、アプリに Extended Virtual Addressing と Increased Memory Limit も付けます。
   - `export-upload.sh` が、App Store Connect の API キーで、有料チームのクラウド管理の配布証明書を使って書き出し、TestFlight に上げます（`testFlightInternalTestingOnly`）。
   - ジョブのログは公開されます。そのため、出すのは `redact-log.py` で絞り、名前とメールを伏せた行だけです。署名した IPA、プロファイル、ログ全体は、ランナーの外に出しません。

## 最初に一度だけ設定すること

### Apple Developer と App Store Connect

1. Developer サイトの Identifiers で、Explicit の App ID を2つ登録します。
   - アプリ：`app.pocketgemma.personal`
   - Live Activity の拡張：`app.pocketgemma.personal.activity`
   - アドレス空間の試験をするときは、アプリの App ID で Extended Virtual Address Space と Increased Memory Limit をオンにします。
2. App Store Connect で、新規 App を作ります。Bundle ID は `app.pocketgemma.personal` にします。名前は App Store 全体で重ならないものにします。
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
   - `address_space` は、アドレス空間の試験版のときだけオンにします。
2. archive ジョブが終わると、upload ジョブが承認待ちになります。「Review deployments」で `testflight` を承認します。
3. App Store Connect の処理が終わると、TestFlight アプリに出ます。

## 注意

- TestFlight は、同じ版の同じビルド番号を2回受け付けません。上げるたびに、新しいビルド番号（project.yml の `CURRENT_PROJECT_VERSION`）が要ります。
- 鍵を差し替えるときは、App Store Connect で古いキーを取り消し、Environment の Secrets を入れ直します。
- 書き込める人はワークフローを変えられます。鍵を守っているのは、Environment の承認と、main だけという制限です。
- プライバシーマニフェストは、いくつかのスレッドが PocketGemma-source.zip を編集している間は、ここに置いています。落ち着いたら、ソースの `PocketGemma/` に移します。
