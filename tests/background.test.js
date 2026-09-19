const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const sender = { tab: { id: 7 }, url: 'https://chatgpt.com/c/example' };

function setup({ voiceId = 'shiori', serverUrl = 'http://127.0.0.1:8088', speechRate = 1, fetch }) {
  let listener;
  const data = { voiceId, serverUrl, speechRate };
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { async get() { return data; } } },
    permissions: { async contains() { return true; } }
  };
  vm.runInNewContext(source, {
    chrome, fetch, URL, AbortController, AbortSignal, Uint8Array,
    console: { error() {} }
  });
  return function message(payload) {
    return new Promise(resolve => {
      listener(payload, sender, resolve);
    });
  };
}

test('sends the selected reply and voice to the local speech API', async () => {
  const requests = [];
  const message = setup({
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'server-model' }] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' }
      });
    }
  });
  const result = await message({ action: 'tts', requestId: 'one', payload: '対象の回答' });
  assert.deepEqual(Array.from(result.audioBuffer), [1, 2, 3]);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(requests[1].url, 'http://127.0.0.1:8088/v1/audio/speech');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    model: 'server-model', input: '対象の回答', voice: 'shiori',
    speed: 1, response_format: 'mp3'
  });
});

test('passes the saved speed and speaker embedding voice ID to Irodori', async () => {
  let body;
  const message = setup({
    voiceId: '敷嶋てとら_02',
    speechRate: 1.2,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'irodori-tts' }] }));
      }
      body = JSON.parse(options.body);
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } });
    }
  });
  await message({ action: 'tts', requestId: 'speed', payload: '速度テスト' });
  assert.equal(body.voice, '敷嶋てとら_02');
  assert.equal(body.speed, 1.2);
});

test('reports an unset voice without a network request', async () => {
  const message = setup({
    voiceId: '',
    fetch: () => { throw new Error('unexpected fetch'); }
  });
  assert.equal((await message({ action: 'tts', requestId: 'two', payload: '回答' })).error, 'VOICE_REQUIRED');
});

test('loads voice IDs from the server list', async () => {
  const message = setup({
    fetch: async url => {
      assert.equal(url, 'http://127.0.0.1:8088/v1/audio/voices');
      return new Response(JSON.stringify({
        object: 'list', data: [{ id: 'shiori', object: 'voice' }, { id: 'none', no_ref: true }]
      }));
    }
  });
  const result = await message({ action: 'listVoices' });
  assert.deepEqual(Array.from(result.voices, voice => voice.id), ['shiori', 'none']);
});

test('reports a stopped server as a connection error', async () => {
  const message = setup({
    fetch: async () => { throw new TypeError('connection refused'); }
  });
  assert.equal((await message({ action: 'tts', requestId: 'three', payload: '回答' })).error, 'CONNECTION');
});

test('cancels an in-flight synthesis request', async () => {
  let speechStarted;
  const started = new Promise(resolve => { speechStarted = resolve; });
  const message = setup({
    fetch: async (url, options = {}) => {
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'irodori-tts' }] }));
      }
      speechStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')));
      });
    }
  });
  const synthesis = message({ action: 'tts', requestId: 'four', payload: '長い回答' });
  await started;
  assert.equal((await message({ action: 'cancel', requestId: 'four' })).ok, true);
  assert.equal((await synthesis).error, 'CANCELLED');
});
