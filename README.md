# ChatGPT × Irodori v0.2

ChatGPT Web の assistant 回答を、ローカルの Irodori-TTS Server で音声に変換して再生する Chrome 拡張です。読み上げたい回答の「🔊 Irodori」を押して使います。OpenAI API、ElevenLabs、有料 TTS API、Python Bridge は使いません。

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
5. Voice を選択し、必要なら読み上げ速度を変更します。
6. `https://chatgpt.com/` を開き、assistant 回答の「🔊 Irodori」を押します。

拡張のファイルを更新した後は `chrome://extensions` で拡張を再読み込みし、ChatGPT のタブも再読み込みしてください。

## 設定

popup には Server URL、接続状態、Voice、Voice 一覧の再読込、読み上げ速度を表示します。Server URL、Voice、速度は Chrome Storage に保存されます。

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

`0.8x`、`0.9x`、`1.0x`、`1.1x`、`1.2x` から選べます。初期値は `1.0x` です。選択値は音声生成時に Irodori-TTS Server の正式な `/v1/audio/speech` の `speed` パラメータとして送ります。ブラウザの `audio.playbackRate` は使いません。Irodori の [API 実装](https://github.com/Aratako/Irodori-TTS-Server/blob/main/src/irodori_openai_tts/app.py)で速度指定を確認しています。

## 読み上げ

回答ごとの「🔊 Irodori」を押すと、その回答の全文を 1 回のリクエストで Server に送ります。再生中または生成中は「■ Stop」を押すと停止します。別の回答を押すと現在の生成・再生を止め、新しい回答に切り替えます。自動読み上げや音声ストリーミングはありません。

読み上げ前に、コードブロック、URL、citation や source の操作 UI、コピー等のボタン、非表示要素を可能な範囲で除外します。Markdown の見出し・強調・箇条書き・インラインコードの記号は取り除き、本文や表示用リンク名は残します。段落と見出しの区切りも残します。ChatGPT の DOM 変更によって citation 等の新しい表示形式が現れた場合は、除外しきれないことがあります。

## 接続方式

`content.js` が assistant 回答を取得し、`background.js` の service worker がローカル Irodori-TTS Server に直接 HTTP リクエストを送ります。Server URL を標準接続先以外へ変える場合は、接続確認時に Chrome のホストアクセス許可を求めます。音声データは ChatGPT のページで再生します。

## 制約

- Irodori-TTS Server の起動、Voice とモデルの設定は別途必要です。
- 長文はブラウザ側で分割しません。生成完了まで再生は始まりません。
- 非常に長い音声では、拡張メッセージを通じた音声データ転送に時間とメモリがかかる可能性があります。
- Server で独自の認証を有効にした構成には未対応です。
