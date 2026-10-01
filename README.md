# ChatGPT × Irodori v0.4.4

ChatGPT Web の assistant 回答を、ローカルの Irodori-TTS Server で音声に変換して再生する Chrome 拡張です。回答ごとの「🔊 Irodori」で手動再生でき、自動読み上げを ON にすると新しい回答の完成後に再生します。OpenAI API、ElevenLabs、有料 TTS API、Python Bridge は使いません。

v0.4.1では、2026年9月時点のChatGPT Webで使われる`data-markdown-text-style="assistant-message"`と`:assistant` message unitに対応しました。従来の`data-message-author-role="assistant"`等も引き続き検出します。user bubbleと`:user` unitは読み上げボタンの対象外です。ChatGPTのDOMは変更されることがあるため、Developer Consoleの`[Irodori DOM]`診断ログで、旧assistant、新本文root、assistant unit、挿入済みボタンの件数を確認できます。本文やmessage IDはログへ出しません。

v0.4.2では、ユーザーの質問送信を起点に自動読み上げ対象を判定します。長い過去チャットを上へスクロールして後からDOMに現れた古い回答には手動ボタンを付けますが、自動生成しません。現行DOMではuserとassistantが共有する`data-turn-key`を対応付けに使い、回答の固有IDには引き続きassistant message IDを使います。

v0.4.3では、Project/GPT配下の新規チャットでbase routeからconversation URLが割り当てられる際にも、送信中の自動読み上げ対象を維持します。会話ID同士の切替や別baseへの移動は引き続き履歴navigationとして扱います。

v0.4.4では、Enter、送信ボタン、form submitを送信のsignalとして扱います。送信後に新しいuser messageがDOMへ現れた時にだけ自動読み上げのlive generationを開始し、clickとsubmitが続けて発火しても1回の送信として処理します。Shift+EnterやIME変換確定は送信signalにしません。

[Better Chat Voice](https://github.com/G1enB1and/better-chat-voice) を基にした Manifest V3 拡張です。元プロジェクトのライセンスは [LICENSE (MIT).md](LICENSE%20(MIT).md) を参照してください。

## 必要環境

- Google Chrome と ChatGPT アカウント
- [Irodori-TTS Server](https://github.com/Aratako/Irodori-TTS-Server) が起動済みの PC
- Irodori-TTS Server が必要とするモデル、Voice、FFmpeg 等の実行環境

拡張から Server を起動・停止する機能はありません。Server は別途起動してください。標準接続先は `http://127.0.0.1:8088` です。

## Chrome への導入と起動順

1. Irodori-TTS Server を起動します。環境に `start_server.bat` または `start_server_hidden.vbs` がある場合は、その設定に従って起動します。
2. Chrome で `chrome://extensions` を開き、右上の「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を押し、この `chatgpt-irodori-voice` フォルダーを選びます。
4. 拡張の popup で Server URL を確認し、「接続確認」を押します。
5. Voice を選択し、必要なら読み上げ速度と自動読み上げを設定します。
6. `https://chatgpt.com/` を開き、assistant 回答の「🔊 Irodori」を押します。

拡張のファイルを更新した後は `chrome://extensions` で拡張を再読み込みし、ChatGPT のタブも再読み込みしてください。

## 設定

popup には Server URL、接続状態、Voice、Voice 一覧の再読込、読み上げ速度、自動読み上げ ON/OFF を表示します。これらの設定は Chrome Storage に保存されます。

「接続確認」は Server への接続確認後に Voice 一覧も更新します。「Voice一覧を再読込」は、Server 起動後に `voices/` へ Voice を追加したときに使います。現在の Voice が一覧に残っていれば選択を維持し、一覧から消えた場合だけ未選択にします。Voice 一覧が取得できない場合、保存済みの選択は消しません。

Irodori-TTS Server が Voice API で返す ID をそのまま選択できます。`.speaker.safetensors` の Speaker Embedding Voice も通常の Voice と同じように表示、保存、送信します。専用設定はありません。

状態表示は次のとおりです。

| 表示 | 意味 |
| --- | --- |
| 接続OK | Server と Voice API に接続できた |
| Server未接続 | Server に接続できない。起動と URL を確認する |
| 接続OK / Voiceなし | Server は動作中だが Voice 一覧が空 |
| 接続OK / Voice取得失敗 | Server に接続できたが Voice API に失敗した |

### 読み上げ速度

`0.5x`、`0.75x`、`1.0x`、`1.25x`、`1.5x`、`2.0x`、`2.5x` から選べます。初期値は `1.0x` です。旧候補の速度を保存していた場合は、popup を開くと 1.0x に戻ります。Irodori への音声生成リクエストは常に `speed: 1.0` とし、選択した速度はブラウザの `audio.playbackRate` に適用します。ブラウザが対応する場合は `preservesPitch` も有効にします。再生中に popup で速度を変えると現在の音声にも反映されます。

### 自動読み上げ

初期値は OFF です。ON 中の質問送信後に新しいuser messageが現れ、その質問に対応する新しい assistant 回答だけを対象にします。拡張やページの読み込み時に表示済みの過去回答、OFF 中の回答、仮想スクロールで後から表示された過去回答を遡って読み上げることはありません。本文が最後の変更から約1.5秒間安定すると Irodori へ1回送ります。ChatGPT が生成中属性や「生成を中止する」ボタンを表示している間は待機します。これらの情報がない場合も、送信との対応が確認できた回答なら本文の安定で判定します。Voice が未設定の場合は自動送信しません。

複数の回答が続けて完成すると、完成順に音声を生成して再生を待ちます。前の回答のSSE生成が完了してから次の生成を始めます。現在の音声の終了後、または Stop 後に次の音声を再生します。Pause 中は次に進みません。回答ボタンの手動操作は自動再生より優先されます。OFF に戻すと未再生の自動待ち行列と進行中の自動生成を解除します。生成済み音声の再生はそのまま続きます。自動生成した完成音声もページ内メモリに残り、「▶ 再生」で再生成せずに聞き直せます。

左側の履歴などから別のチャットを開いた場合、読み込まれる過去回答は自動読み上げしません。会話切替前の未処理の自動生成・待ち行列を解除し、再生中の音声も停止します。過去回答の読み込みが約1.5秒間落ち着いた後、そのチャットで新たに質問して得た回答は通常どおり自動読み上げできます。通常の新規チャットとProject/GPT配下の新規チャットでURLが割り当てられる場合も、その最初の回答は自動読み上げ対象です。

## 読み上げ

回答ごとの「🔊 Irodori」を押すと、その回答の全文を 1 回のリクエストで Server に送ります。自動読み上げも回答完成後から生成します。Irodori の chunk-level SSE を使い、Server が句読点を基準に分割した最初の WAV chunk が届くと、全文生成完了前に再生を始めます。後続chunkの生成と再生は並行します。ブラウザ側で文章を分割したり、回答ごとに複数回POSTしたりしません。初期設定は `chunk_min_chars: 80`、`first_sentence_chunk_min_chars: 24` です。

生成中の「■ Stop」はSSE通信をキャンセルし、未完成chunkを破棄します。再生中は「⏸ 一時停止」と「■ 停止」を表示します。一時停止中もServerから後続chunkを受け取り、ページメモリに保持します。「▶ 再開」は同じchunkの停止位置から再開します。全chunkの生成完了後の「■ 停止」は再生を先頭へ戻し、生成済みchunkを保持します。chunkの間に後続音声がまだ届いていない場合は待機し、到着すると続きから再生します。

再生終了または停止後は「▶ 再生」と「↻ 再生成」を表示します。「▶ 再生」は保持した音声を先頭から再生し、Server への再リクエストは行いません。「↻ 再生成」は古い音声を破棄して Server に新しく生成を依頼します。別の回答に切り替えると再生中の音声だけが止まり、各回答の生成済み音声は残ります。Voice、Server、回答本文を変更した後に新しい音声が必要な場合は「↻ 再生成」を押してください。

生成済み音声chunkは現在のページのメモリ内だけに保持します。回答が画面から削除されたときや別チャットへ移動したときは破棄し、ページ再読み込みやタブ終了後には復元しません。ファイル、IndexedDB、localStorage への音声保存は行いません。ChatGPT回答の生成途中からの読み上げはまだ行いません。

読み上げ前に、コードブロック、URL、citation や source の操作 UI、コピー等のボタン、非表示要素を可能な範囲で除外します。Markdown の見出し・強調・箇条書き・インラインコードの記号は取り除き、本文や表示用リンク名は残します。段落と見出しの区切りも残します。ChatGPT の DOM 変更によって citation 等の新しい表示形式が現れた場合は、除外しきれないことがあります。

## 接続方式

`content.js` が assistant 回答を取得し、`background.js` の service worker がローカル Irodori-TTS Server に直接 HTTP リクエストを送ります。Server URL を標準接続先以外へ変える場合は、接続確認時に Chrome のホストアクセス許可を求めます。音声データは ChatGPT のページで再生します。

## 制約

- Irodori-TTS Server の起動、Voice とモデルの設定は別途必要です。
- 長文はブラウザ側で文章分割しません。回答全文をIrodoriに送り、音声chunk単位のSSEを受け取ります。
- WAV chunkをページ内に保持するため、長い回答ではメモリ使用量が増えます。HTMLAudioElementのchunk切替で短い隙間が生じる可能性があります。
- Server で独自の認証を有効にした構成には未対応です。
