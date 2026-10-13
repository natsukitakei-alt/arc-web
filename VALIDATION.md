# 検証記録 — ARC Web

2026-10-13 (Asia/Tokyo)

- 今回の静的検査：ai-worker.js、app.js、core.mjs、sw.js、preview.cjsをBabel parserで構文確認。HTMLの37個のIDは重複なし。ローカル参照先とstandalone manifestを確認。ソースの実行は行っていません。
- 以前の検証：主要ローカル処理6件とWebLLM worker契約モック12件は成功。7件目のquery付きdynamic importは停止し未完了。Windowsブラウザーで画面・メモ保存・リマインダー表示を確認。最新スクリーンショットは1280×720。修正後の390×844再確認は未完了です。
- AI変更：ONNX版はGPU読み込みに失敗し、CPU切替の読み込み中にブラウザーが停止したため、WebLLM 0.2.86のMLC版Qwen2.5 0.5Bへ変更。約300〜400MB・対応GPU必須。変更後の実モデル推論は未確認です。
- 未確認：iPhone実機、実モデルでの回答、音声入力・読み上げ・写真OCRの実動。ブラウザー制御がタイムアウトしており、追加の実機相当検証は完了していません。
- 公開：Sitesの非公開プロジェクトIDは保存済み。ソース送信用の端末入力が自動承認レビューに却下され、Git push・バージョン保存・公開はすべて未完了。作成時のexpected_urlは公開成功を意味しません。
