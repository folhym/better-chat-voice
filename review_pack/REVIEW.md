# chatgpt-irodori-voice v0.4.4 独立レビュー引継ぎ

## ユーザー要求

実ChromeではEnter送信でnative submitが発火せず、青い送信buttonのクリックではclick→submitの順に発火する。既存の`noteNewChatSubmission()`は旧composer selectorを含むformでなければ無視しており、実際の送信後のassistantをhistorical扱いにしていた。Enter、button click、submitを送信signalとして検出し、新しいuser messageのDOM出現を確認してからlive generationを開始する。v0.4.2の仮想スクロール履歴抑止とv0.4.3のroute割当判定を維持する。

## 実装内容

- `content.js`: 旧`USER_SUBMISSION_SELECTORS`必須guardを廃止。`submitter`、送信buttonの`type`プロパティ／属性とaria、composer内editable、Enterの親方向探索を使い、submit/click/keydownから`pendingSubmissionIntent`を作る。Shift+Enter、IME変換確定、repeat、copy/retry/attachment/Stop操作は除外する。
- signal時に既存user要素・turn keyと会話末尾を記録する。`scan()`で新しいuser messageを確認したときだけ`liveGeneration`へ昇格する。intentがない仮想スクロールは従来通りhistorical。click→submitの短時間重複は1cycleにまとめる。user確認がclickとsubmitの間に起きた場合も、後続submitを重複として扱う。
- 新規チャットでuser message確認前にrouteが割り当てられても、v0.4.3と同じroute形状・base比較でpending intentを引き継ぐ。通常の会話切替ではpending/liveを破棄する。DEBUGログはsignal種別、dedupe、user確認、live armを本文・message IDなしで出す。
- assistant/user DOM selector、本文安定判定、SSE、chunk、Voice、Speaker Embedding、Pause／Resume／Stop、cache、playbackRateには変更なし。

## 変更ファイル

- `content.js`: 送信signal・pending intent・user確認・重複抑止
- `tests/content.test.js`: 実機イベント形状を模したfixtureとv0.4.4回帰テスト
- `manifest.json`: version 0.4.4
- `README.md`: 送信検出方式の説明
- `review_pack/REVIEW.md`、`review_pack/changes.diff`: 本資料と差分

作業ツリーには以前の版からの未コミット差分がある。`changes.diff`はGit HEADから現時点までの累積差分であり、v0.4.4レビューは上記4実装ファイルの送信検出箇所を中心に見ること。

## テスト結果

- `node --test tests/*.test.js`: 70/70成功。
- v0.4.4で確認: Enterとbutton clickによる既存chatの新回答、新規chat初回回答、click+submitで1cycle、user確認後に遅れたsubmitのdedupe、submitterなしのcomposer submit、ariaなしのcomposer送信button、`type`属性を省略してプロパティのみ`submit`のbutton、送信signalだけではliveを開かないこと、古いuser/assistantの仮想mount後のfresh回答、Shift+Enter、IME Enter、copy/retry/attachment除外。
- 既存テスト: 仮想スクロール履歴0 POST、Project/GPT・通常route割当、手動読み上げ、SSE、Voice/Speaker Embedding、速度、Pause／Resume／Stop、cache等成功。
- `node --check content.js`、Manifest JSON parse（0.4.4）、`git diff --check -- . ':!review_pack'`: 成功。
- `git apply --reverse --check review_pack/changes.diff`: 成功。

## 既知の問題・未確認事項

- ユーザー提供の実Chromeイベントログを基に修正した。v0.4.4を認証済みChromeで再読み込みし、Enter／button送信からIrodori再生まで通す実機確認は未実施。
- composer構造や送信buttonのtype/ariaが将来変化した場合はsignal検出が外れ、自動読み上げが開始しない可能性がある。手動読み上げは維持される。
- pending intentはuser message確認前に30秒を超えると失効する。通常のChatGPT送信ではuser messageが即時DOMに現れる想定である。

## ChatGPTに重点的にレビューしてほしい点

1. 実ChromeのEnter対象DIVからeditable/composer formへ辿れるか。
2. 実送信buttonのclickとsubmitを1cycleとして扱い、無関係なbuttonやformを誤検出しないか。
3. user bubble確認とroute割当の前後順が変わっても新規チャット初回回答を保持するか。
4. 仮想スクロールで遅れてmountされた古いuser/assistantをlive対象にしないか。
