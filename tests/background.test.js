const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const sender = { tab: { id: 7 }, url: 'https://chatgpt.com/c/example' };

function setup({ voiceId = 'shiori', serverUrl = 'http://127.0.0.1:8088', fetch }) {
  let messageListener;
  let connectListener;
  const data = { voiceId, serverUrl };
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { messageListener = fn; } },
      onConnect: { addListener(fn) { connectListener = fn; } }
    },
    storage: { local: { async get() { return data; } } },
    permissions: { async contains() { return true; } }
  };
  const context = vm.createContext({ chrome, fetch, URL, AbortController, AbortSignal,
    TextDecoder, Uint8Array, btoa, console: { error() {} } });
  vm.runInContext(source, context);
  return {
    context,
    message(payload) {
      return new Promise(resolve => messageListener(payload, sender, resolve));
    },
    start(text = '対象の回答') {
      let receive;
      let disconnected;
      const messages = [];
      const port = {
        name: 'irodori-tts-stream', sender,
        postMessage(message) { messages.push(message); },
        onMessage: { addListener(callback) { receive = callback; } },
        onDisconnect: { addListener(callback) { disconnected = callback; } },
        disconnect() { disconnected(); }
      };
      connectListener(port);
      receive({ type: 'start', requestId: 'one', text });
      return { messages, disconnect: () => disconnected() };
    }
  };
}

const modelResponse = () => new Response(JSON.stringify({ data: [{ id: 'server-model' }] }));
const event = (name, data, lineEnd = '\n') =>
  `event: ${name}${lineEnd}data: ${JSON.stringify(data)}${lineEnd}${lineEnd}`;
const chunk = (index, audio_base64 = 'AQID') =>
  ({ index, format: 'wav', media_type: 'audio/wav', audio_base64 });
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}

test('requests Irodori SSE WAV at speed 1 with selected embedding voice and chunk parameters', async () => {
  const requests = [];
  const app = setup({ voiceId: '敷嶋てとら_02', fetch: async (url, options = {}) => {
    requests.push({ url, options });
    return url.endsWith('/v1/models') ? modelResponse() : new Response(
      event('audio_chunk', chunk(0)) + event('done', { chunks: 1 }),
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  } });
  const port = app.start();
  await settle();
  assert.equal(requests[1].url, 'http://127.0.0.1:8088/v1/audio/speech');
  assert.equal(requests[1].options.headers.Accept, 'text/event-stream');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    model: 'server-model', input: '対象の回答', voice: '敷嶋てとら_02',
    response_format: 'wav', speed: 1, stream_format: 'sse',
    irodori: { chunking_enabled: true, chunk_min_chars: 80,
      first_sentence_chunk_min_chars: 24 }
  });
  assert.deepEqual(port.messages.map(message => message.type),
    ['stream-start', 'audio-chunk', 'stream-done']);
});

test('parser handles split reads, multiple events, LF and CRLF, duplicates, and done', async () => {
  const content = event('audio_chunk', chunk(0), '\r\n') +
    event('audio_chunk', chunk(0), '\n') +
    event('audio_chunk', chunk(1), '\n') + event('done', { chunks: 2 }, '\r\n');
  let controller;
  const app = setup({ fetch: async url => {
    if (url.endsWith('/v1/models')) return modelResponse();
    return new Response(new ReadableStream({ start(value) { controller = value; } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const port = app.start();
  await settle();
  const parts = [content.slice(0, 12), content.slice(12, 33),
    content.slice(33, 71), content.slice(71)];
  for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
  controller.close();
  await settle();
  assert.deepEqual(port.messages.map(message => message.type),
    ['stream-start', 'audio-chunk', 'audio-chunk', 'stream-done']);
  assert.deepEqual(port.messages.filter(message => message.type === 'audio-chunk')
    .map(message => message.index), [0, 1]);
});

test('port disconnect aborts the in-flight synthesis', async () => {
  let speechSignal;
  const app = setup({ fetch: async (url, options = {}) => {
    if (url.endsWith('/v1/models')) return modelResponse();
    speechSignal = options.signal;
    return new Promise((_resolve, reject) => {
      speechSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  } });
  const port = app.start();
  await settle();
  port.disconnect();
  assert.equal(speechSignal.aborted, true);
});

test('audio response fallback is one chunk and never retries POST', async () => {
  let posts = 0;
  const app = setup({ fetch: async url => {
    if (url.endsWith('/v1/models')) return modelResponse();
    posts++;
    return new Response(new Uint8Array([1, 2, 3, 4, 5]),
      { headers: { 'content-type': 'audio/wav' } });
  } });
  const port = app.start();
  await settle();
  assert.equal(posts, 1);
  assert.equal(port.messages[1].audioBase64, 'AQIDBAU=');
  assert.equal(port.messages[2].chunks, 1);
});

test('malformed JSON and HTTP errors produce one error without another POST', async () => {
  for (const response of [new Response('event: audio_chunk\ndata: {oops}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }), new Response('bad', { status: 500 })]) {
    let posts = 0;
    const app = setup({ fetch: async url => {
      if (url.endsWith('/v1/models')) return modelResponse();
      posts++;
      return response;
    } });
    const port = app.start();
    await settle();
    assert.equal(posts, 1);
    assert.equal(port.messages.at(-1).type, 'stream-error');
  }
});

test('reports an unset voice and a stopped server without crashing', async () => {
  const missing = setup({ voiceId: '', fetch: () => { throw new Error('unexpected'); } });
  const port = missing.start();
  await settle();
  assert.equal(port.messages[0].error, 'VOICE_REQUIRED');
  const offline = setup({ fetch: async () => { throw new TypeError('connection refused'); } });
  const offlinePort = offline.start();
  await settle();
  assert.equal(offlinePort.messages[0].error, 'CONNECTION');
});

test('voice listing remains available through one-shot messaging', async () => {
  const app = setup({ fetch: async url => {
    assert.equal(url, 'http://127.0.0.1:8088/v1/audio/voices');
    return new Response(JSON.stringify({ data: [{ id: 'shiori' }, { id: 'none' }] }));
  } });
  const result = await app.message({ action: 'listVoices' });
  assert.deepEqual(Array.from(result.voices, voice => voice.id), ['shiori', 'none']);
});
