# Fielua プライバシーポリシー

最終更新：2026年10月22日

Fielua は、AI との会話を iPhone の中だけで処理するアプリです。開発者は、あなたの会話や個人情報を集めません。

## 端末の中だけで扱うもの

- 会話、添付した写真やファイル、設定は、この iPhone の中に保存し、この iPhone の中で処理します。開発者や外部のサーバーには送りません。
- アカウント登録はありません。広告、トラッキング、利用状況の解析も入っていません。

## インターネットにつながるとき

- **AI モデルのダウンロード：** モデルのファイルは Hugging Face（huggingface.co）から読み込みます。このとき Hugging Face には、通常の通信と同じく IP アドレスなどが届きます。扱いは Hugging Face のプライバシーポリシーに従います。
- **返答の中の画像：** AI の返答に画像のリンクがあるときは、あなたがタップしたときだけ、その画像のサーバーから読み込みます。
- **会話のバックアップ：** あなたがオンにして保存先（iCloud Drive など）を選んだときだけ、そのフォルダに会話を書き込みます。保存先での扱いは、そのサービス（iCloud なら Apple）に従います。

## TestFlight でのテスト

TestFlight でテストしているときは、Apple の TestFlight の規約に従い、クラッシュの記録、あなたが送ったフィードバックやスクリーンショット、端末の機種と iOS のバージョンなどが、Apple から開発者に届きます。開発者は、これをアプリの改善にだけ使います。

## お問い合わせ

TestFlight アプリの「ベータ版フィードバックを送信」か、[GitHub の Issues](https://github.com/taotaohoyo/pocket-gemma-build/issues) からご連絡ください。

---

# Fielua Privacy Policy

Last updated: October 22, 2026

Fielua runs its AI conversations entirely on your iPhone. The developer does not collect your conversations or personal information.

- **On your device only:** chats, attached photos and files, and settings are stored and processed on your iPhone and are never sent to the developer or any server. There is no account, no advertising, no tracking and no analytics.
- **Model downloads:** model files are downloaded from Hugging Face (huggingface.co), which receives your IP address as part of the request and handles it under its own privacy policy.
- **Images in replies:** an image linked in an AI reply is loaded from its server only when you tap it.
- **Chat backup:** only if you turn it on and pick a folder (for example in iCloud Drive), the app writes your chats to that folder, where that service's terms apply.
- **TestFlight:** while you test through TestFlight, Apple shares crash reports, any feedback or screenshots you send, and your device model and iOS version with the developer under the TestFlight terms. The developer uses them only to improve the app.
- **Contact:** send feedback from the TestFlight app, or open an issue at https://github.com/taotaohoyo/pocket-gemma-build/issues.
