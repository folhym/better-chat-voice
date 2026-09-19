# v0.2 独立レビュー引継ぎ

## ユーザーの要求

動作確認済みの v0.1 手動読み上げ、Speaker Embedding Voice、Stop、回答切り替えを維持し、Voice 再読込、接続・Voice 状態の表示、読み上げ速度、URL・citation UI・Markdown 記号等の読み上げ前除去を追加する。自動読み上げ、SSE、Bridge、有料 API は追加しない。

## ベースと実際に確認した API

- Better Chat Voice の Git 履歴を保持。基点は `702280fe63c55b030803e95d18e9381297079171`。v0.1 の変更は未コミットで、今回の変更はその上に加えた。
- 2026-09-19 に起動中のローカル Irodori-TTS Server を読み取りで確認。`GET /health` は HTTP 200、`GET /v1/audio/voices` は `none` と Speaker Embedding Voice 3 件を返した。`GET /openapi.json` の `SpeechRequest.speed` は数値、既定値 1.0、範囲 0.25～4.0。
- Irodori 公式 [README](https://github.com/Aratako/Irodori-TTS-Server/blob/main/README.md) と [app.py](https://github.com/Aratako/Irodori-TTS-Server/blob/main/src/irodori_openai_tts/app.py) でも `/v1/audio/speech` の `speed` と Voice API を確認した。速度はブラウザの `playbackRate` ではなく、Server への正式パラメータとして送る。
- v0.1 の Chrome 実機読み上げおよび Speaker Embedding Voice の動作はユーザーの報告に基づく。今回 v0.2 の Chrome 実機操作は未実施。

## 実装内容と主な変更箇所

- `popup.js` / `popup.html` / `styles.css`: 接続確認成功時に Voice 一覧を更新。専用の「Voice一覧を再読込」を追加。既存 Voice が一覧にあれば維持、一覧から消えた場合だけ保存値を削除。Voice API 失敗時には保存済み Voice を残す。接続不可、Voice なし、Voice API 失敗を区別して表示。速度選択を保存。
- `background.js`: 保存した `speechRate` を `POST /v1/audio/speech` の `speed` に渡す。不正な保存値は 1.0 に戻す。Voice ID は通常 Voice と Speaker Embedding で同じ扱い。
- `content.js`: 本文抽出に citation/source UI の除外対象を追加。`sanitizeForSpeech` を独立関数として追加し、URL、Markdown の見出し・強調・箇条書き記号、余分な空白を整理する。表示リンク名、見出し・箇条書き本文、段落境界を残す。コードブロック除外も維持。
- `manifest.json`: バージョンを 0.2.0 に更新。
- `README.md` / `PRIVACY.md`: v0.2 の操作と保存項目を記載。
- 再生・停止・回答切り替えのセッション管理ロジックは変更していない。

## 変更・追加・削除ファイル

変更: `PRIVACY.md`、`README.md`、`background.js`、`content.js`、`manifest.json`、`popup.html`、`popup.js`、`styles.css`、`tests/background.test.js`、`tests/content.test.js`。

追加: `tests/popup.test.js`。

削除: なし。

`changes.diff` は今回の v0.2 差分。v0.1 開始時の `review_pack/changes.diff` を Better Chat Voice の HEAD に適用して v0.1 の一時ベースを再現し、現行ファイルとの差分を Git で生成した。一時ベースは削除済み。

## 実施したテストと結果

- `node --test tests/*.test.js`: 11 件成功。TTS request の `speed`、Speaker Embedding ID 維持、Voice 一覧更新と選択維持・削除、接続状態の区別、速度保存、URL・Markdown・citation UI の抽出除外、v0.1 の停止・エラー処理等をテスト。
- `node --check background.js`、`content.js`、`popup.js`: 成功。
- Manifest JSON のパース: 成功。
- `git diff --check`: エラーなし。改行コードに関する Git の警告のみ。
- 起動中 Server の `/health`、`/v1/audio/voices`、`/openapi.json`: 読み取り成功。Speaker Embedding Voice が API 一覧に含まれることを確認。
- `changes.diff`: 作成した v0.1 一時ベースに対して `git apply --reverse --check` 成功。

## 維持した v0.1 機能

assistant 回答ごとの手動ボタン、ローカル Server への直接 POST、Voice ID の送信、Speaker Embedding Voice、コードブロック除外、Stop、生成中キャンセル、別回答への切り替え、単一再生、外部有料 API を使わない構成。実機での維持確認はユーザーによる v0.1 動作確認と今回の自動テストの範囲に限る。

## 未確認事項・既知の問題

- v0.2 を Chrome に再読み込みした後の popup 表示、Voice 再読込、速度変更による実音声、Stop と別回答切り替えの実機再確認は未実施。
- 実音声を生成して速度を比較する POST テストは、自動承認レビューの利用制限によって拒否され、実行されていない。この結果を成功扱いしていない。
- ChatGPT Web の citation/source DOM は表示形式が変わるため、将来の新しい UI を完全には除外できない。本文として記述された「Sources」等は意図的に消さない。
- 長文音声は v0.1 と同じく拡張メッセージでバイト配列として転送するため、メモリや service worker 実行制限の影響を受ける可能性がある。
- Server の独自 Bearer 認証には未対応。
- UI スクリーンショットは保存していない。前回確認時、利用環境のブラウザ URL ポリシーがローカル popup HTML の表示を拒否したため。v0.2 の popup は Chrome に読み込んで目視確認する必要がある。

## ChatGPT に重点的にレビューしてほしい点

1. Voice 一覧の成功・失敗・空配列時に、保存済み Voice の維持・削除と状態表示が妥当か。
2. `sanitizeForSpeech` が URL と citation UI を除外しつつ、意味のある本文、リンク名、見出し、箇条書きを維持するか。
3. Irodori `speed` の型・範囲と既存の Speaker Embedding Voice の送信に回帰がないか。
4. v0.2 の Chrome 実機で接続確認、Voice 再読込、速度の聴感、Stop、回答切り替えが機能するか。
