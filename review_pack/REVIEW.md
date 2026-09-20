# chatgpt-irodori-voice v0.3.2 独立レビュー引継ぎ

## ユーザーの要求と確認済みの現象

ユーザーの実機Chromeで、v0.3.1 の新規回答自動読み上げは動作した。一方、左側の履歴から過去チャットを開くと、SPAで追加された過去assistant回答を新規回答と誤認して音声生成した。過去チャットの表示だけでは読み上げず、そのチャットで後から生成した新規回答と新規チャットの最初の回答は読み上げる。

## v0.3.2 の実装

- `content.js`: `location.pathname` をconversation route keyとして `scan()` の先頭で比較する。`popstate` でもscanを予約する。特定の `/c/` パス形式へ依存しない。2026-09-20 のゲストChatGPTでは、最初の送信時に `/` から `/uc/<id>` へ変化することを実画面で確認した。
- 別会話へ移動したらhydrationを開始する。現在の自動読み上げタイマー・待ち行列・生成中通信を解除し、再生中の旧会話音声も停止する。hydration中に現れたassistant turnはすべてbaselineへ登録する。assistant本文とturn集合が最後の変化から1500ms安定したらhydrationを終了する。
- 新規チャットの空画面 `/` へ移るときは旧会話の自動処理を解除するが、後続の新規回答をbaseline化しない。`/` からconversation URLへの割り当て時、生成中のturn、既存候補、またはcomposerの送信を観測した場合は同一の新規会話として扱う。URL割り当てがassistant DOMの挿入より早い場合も送信イベントで保護する。
- v0.3.1 の属性なしfallback、1500msの本文安定判定、`autoHandled` / 回答IDの二重生成防止、FIFO、手動優先、回答別キャッシュ、速度、Pause / Resume / Stopは維持した。`AUTO_DEBUG` にはroute変更・hydration開始/終了・履歴turnのbaseline化の短いログを追加した。本文は記録しない。
- `manifest.json` を `0.3.2` にし、`README.md` に履歴切替時の動作を追加した。

## 今回変更したファイル

`content.js`、`tests/content.test.js`、`manifest.json`、`README.md`、`review_pack/REVIEW.md`、`review_pack/changes.diff`。

`background.js`、popup、Voice選択、Irodoriへの `speed: 1.0` 送信、ブラウザの `audio.playbackRate` は今回変更していない。

## テスト結果

- `node --test tests/*.test.js`: **38件成功**。過去チャット切替、300ms間隔の履歴turn追加、hydration後の新規回答、A→B→C→A、URL割り当て前後の新規チャット最初の回答、戻る/進む、旧会話の生成キャンセル・再生停止、DOM更新前にrouteが変わる競合を追加検証した。従来の手動再生、Speaker Embedding ID、速度、キャッシュ、FIFO、Pause / Resume / Stop、属性なしfallbackのテストも通過。
- `node --check content.js`、Manifest JSONパース、`git diff --check`: 成功（Windows改行コード警告を除く）。
- `review_pack/changes.diff` の逆適用チェック: 成功。

## 差分の読み方

`changes.diff` は現在のGit HEADと作業ツリーの累積差分で、未コミットのv0.2系・v0.3・v0.3.1も含む。今回の変更箇所は上記のファイルと `content.js` のroute/hydration関数、`tests/content.test.js` のnavigationテストを参照。

## 未確認事項・既知の問題

- ユーザーの実機でv0.3.1の新規回答自動読み上げと過去チャット誤読は確認済み。v0.3.2修正後の履歴切替、新規質問、実Irodori Serverとの結合動作は、この環境では未確認。自動テストはDOM・Audio・Server応答を模擬した。
- 履歴DOMの追加が1500msを超えて中断し、その後さらに古い回答が遅れて現れる表示では、hydration終了後に誤候補となる可能性がある。実機で読み込み間隔の確認が必要。
- 新規チャットの送信を捕捉できないUIで、assistant turnがURL割り当てより後に現れ、生成中UIもない場合は、最初の回答を履歴と誤認する可能性がある。現行ゲスト画面にはcomposerの`submit`イベントと生成中UIがある。

## ChatGPTに重点的にレビューしてほしい点

1. route変更とMutationObserverの発火順序にかかわらず、後から追加される履歴turnがbaseline化されるか。
2. 新規チャット送信後の `/` からconversation URLへの割り当てで、初回回答がbaseline化されないか。
3. route変更時に古い自動タイマー・待ち行列・生成・再生が確実に止まり、次の会話での新規回答を妨げないか。
