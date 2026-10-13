# ARC · iPhone独立版

Cloudflare Workers Free + SQLite Durable Object + 新規の本人用Slackアプリで動く独立PWAです。既存のGitHub Pages版やChatGPT/Sitesの認証情報は使いません。

## 作成した機能

- SlackのユーザーEvents APIで、本人のメンション・DM・関連スレッドの返信、編集、削除を受信。
- 携帯を閉じている間もサーバーが受信。画面表示中は本人の一覧を約1分間隔で更新。
- 日本語の依頼文から対応・返答待ち・完了の候補、期限、原文リンクを整理。明確な本人のスレッド返信で状態を更新。
- 最初に選んだ最大3会話の直近7日を各15件、関連スレッド1件を補完。多い履歴は一部取得と表示。
- 本人だけがログイン可能。閲覧・履歴取得の権限のみで、Slackへの投稿は行わない。
- 保存内容の消去、端末ログアウト、接続解除。

これはルールによる候補整理です。ChatGPT並みの意味理解ではありません。スレッドでないDMの完了返信や曖昧な依頼は自動で結び付けず、原文と手動の状態変更で確認します。導入前の全履歴を一括取得する機能はありません。

## 保存と認証

Cloudflareの本人専用ストレージへ、タスクを生む依頼と関連返信の本文先頭1500文字・投稿者ID・会話/投稿/スレッドIDを最大7日・160件保存。最大40候補を表示します。本人のSlackアクセストークンはAES-GCMで暗号化してサーバーに保存し、ブラウザーへ返しません。iPhoneには私的なSlackデータをlocalStorage/Service Workerへ保存しません。

セッションはSecure/HttpOnly/SameSite=Lax cookieの暗号化された乱数IDと、サーバーに保存するハッシュで認証。OAuth stateは10分、一度限り。本人・ワークスペース・Slack app IDを固定許可リストと照合。再接続時は旧端末セッションを無効化します。署名検証した失効通知やAPIの失効応答で認証情報と保存内容を消去します。

## 配信前に本人が行う操作

1. [Cloudflare無料アカウント](https://dash.cloudflare.com/sign-up)を本人が作成。Workers Freeを使用し、有料プランは選ばない。
2. 新しいSlack内部アプリを本人のワークスペースに作成。既存のChatGPT/Slack連携のトークンを流用しない。管理者によるアプリ許可が必要な場合は、その承認を得る。
3. Cloudflareへ新しい本人の認証でログインし、このフォルダーを`wrangler deploy`。SQLite DOは`exports`設定により作成される。
4. Worker SettingsのVariables and Secretsへ`.env.example`に記した値を設定。Client Secret、Signing Secret、32ランダムバイトの暗号鍵はSecretとして入力し、チャット・公開ソース・ログへ貼らない。
5. 実際のHTTPSホストをmanifest例の2箇所へ反映し、SlackのOAuth Redirect URLと署名付きEvents Request URLを設定。URL検証のchallengeはSigning Secretを設定すれば応答できる。
6. SafariでARCの実URLを開く→Slackで本人として接続→会話を選び初回履歴を取得→共有→ホーム画面に追加。

Slack manifestのひな形には架空のホストが入っています。実URLが決まるまでそのまま登録しません。

## 開発と検証

```text
npm install
npm test
npx wrangler login --device --browser=false --use-keyring
npx wrangler deploy
```

現時点では配信・Slackアプリの作成・実機検証は未実施です。ローカルテストは架空データだけを使用しています。`node scripts/preview.mjs`は新しい独立版の画面確認専用で、実サービスに接続しません。

無料枠は超過すると処理が止まるため、費用を勝手に発生させない構成です。Cloudflare実環境のCPU・イベントACK速度とiPhoneでのOAuth動作は配信時に検証します。

## 公式仕様

- [Cloudflare DO無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite DO作成・配信](https://developers.cloudflare.com/durable-objects/get-started/)
- [Slack Events API](https://docs.slack.dev/apis/events-api/)
- [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
- [Slack署名検証](https://docs.slack.dev/authentication/verifying-requests-from-slack/)

一般公開ソースにSlack本文・本人ID・トークン・会社情報を含めません。公開GitHub Pagesへこのサーバー版の私的データを置くことはしません。
