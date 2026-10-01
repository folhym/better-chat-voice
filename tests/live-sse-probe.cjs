// Optional live diagnostic: node tests/live-sse-probe.cjs
// Exercises the extension's background protocol against the running local server.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const serverUrl = 'http://127.0.0.1:8088';
const cases = [
  ['short', '本日はよい天気です。散歩に出かけましょう。'],
  ['medium', 'Irodoriの音声を確認します。最初の文が読み上げられたら、次の文へ自然につながるかを確認してください。音声の一時停止と再開も試します。速度を変えても同じ声で聞こえることを確認します。'],
  ['long', '今日は音声合成の動作を確認しています。最初のチャンクが届いたらブラウザで再生を始めます。続くチャンクはサーバーで順番に作られます。'.repeat(5)]
];

async function main() {
  const voiceResult = await (await fetch(serverUrl + '/v1/audio/voices')).json();
  const voice = voiceResult.data.find(item => item.id.endsWith('_02')) ||
    voiceResult.data.find(item => item.id !== 'none');
  if (!voice) throw new Error('No registered reference voice');
  const data = { serverUrl, voiceId: voice.id };
  let connectListener;
  const chrome = {
    runtime: { onMessage: { addListener() {} },
      onConnect: { addListener(callback) { connectListener = callback; } } },
    storage: { local: { async get() { return data; } } },
    permissions: { async contains() { return true; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), {
    chrome, fetch, URL, AbortController, AbortSignal, TextDecoder, Uint8Array, btoa, console
  });
  for (const [name, text] of cases) {
    const start = performance.now();
    let receive;
    let disconnect;
    let first = null;
    let chunks = 0;
    await new Promise((resolve, reject) => {
      const port = {
        name: 'irodori-tts-stream',
        sender: { tab: { id: 7 }, url: 'https://chatgpt.com/c/live-probe' },
        onMessage: { addListener(callback) { receive = callback; } },
        onDisconnect: { addListener(callback) { disconnect = callback; } },
        postMessage(message) {
          if (message.type === 'audio-chunk') {
            if (first === null) first = performance.now();
            chunks++;
          } else if (message.type === 'stream-done') {
            const total = performance.now();
            console.log(JSON.stringify({ case: name, voice: voice.id,
              firstChunkSeconds: Number(((first - start) / 1000).toFixed(2)),
              streamDoneSeconds: Number(((total - start) / 1000).toFixed(2)),
              chunks, expectedChunks: message.chunks }));
            disconnect();
            resolve();
          } else if (message.type === 'stream-error') reject(new Error(name + ': ' + message.error));
        }
      };
      connectListener(port);
      receive({ type: 'start', requestId: name, text });
    });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
