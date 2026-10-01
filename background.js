// Network access stays in the extension service worker, away from ChatGPT's origin.
const DEFAULT_SERVER = 'http://127.0.0.1:8088';
const activeRequests = new Map();
const SSE_RESPONSE_FORMAT = 'wav';
const SSE_CHUNK_MIN_CHARS = 80;
const SSE_FIRST_CHUNK_MIN_CHARS = 24;

function normalizeServerUrl(value) {
  const url = new URL(value || DEFAULT_SERVER);
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Invalid server URL');
  }
  return url.origin;
}

function errorResult(error) {
  console.error('[Irodori] Request failed:', error);
  if (error?.name === 'AbortError') return { error: 'CANCELLED' };
  if (error?.message === 'VOICE_REQUIRED') return { error: 'VOICE_REQUIRED' };
  if (error?.message === 'PERMISSION_REQUIRED') return { error: 'PERMISSION_REQUIRED' };
  if (error?.name === 'TypeError') return { error: 'CONNECTION' };
  return { error: 'GENERATION' };
}

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  const baseUrl = normalizeServerUrl(serverUrl);
  const url = new URL(baseUrl);
  const allowed = await chrome.permissions.contains({
    origins: [url.protocol + '//' + url.hostname + '/*']
  });
  if (!allowed) throw new Error('PERMISSION_REQUIRED');
  return baseUrl;
}

async function fetchJson(baseUrl, path, signal) {
  const response = await fetch(baseUrl + path, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status);
  return response.json();
}

async function listVoices() {
  const baseUrl = await getServerUrl();
  const result = await fetchJson(baseUrl, '/v1/audio/voices', AbortSignal.timeout(10000));
  const rows = Array.isArray(result.data) ? result.data :
    Array.isArray(result.voices) ? result.voices : [];
  return rows
    .filter(item => typeof item?.id === 'string' && item.id.length > 0)
    .map(item => ({ id: item.id, name: item.name || item.id }));
}

async function checkConnection() {
  const baseUrl = await getServerUrl();
  await fetchJson(baseUrl, '/health', AbortSignal.timeout(10000));
  return { ok: true };
}

async function getModelId(baseUrl, signal) {
  const result = await fetchJson(baseUrl, '/v1/models', signal);
  const model = result.data?.find(item => typeof item?.id === 'string' && item.id);
  if (!model) throw new Error('No model returned by Irodori');
  return model.id;
}

// Keep partial UTF-8, line and event boundaries independent of network reads.
function createSseParser(onEvent) {
  let buffer = '';
  let eventName = '';
  let data = [];
  function dispatch() {
    if (data.length) onEvent(eventName || 'message', data.join('\n'));
    eventName = '';
    data = [];
  }
  function line(value) {
    if (!value) return dispatch();
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') eventName = content;
    if (field === 'data') data.push(content);
  }
  return {
    push(text) {
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let value = buffer.slice(0, newline);
        if (value.endsWith('\r')) value = value.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        line(value);
      }
    },
    finish() {
      if (buffer) line(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      dispatch();
    }
  };
}

function encodeBase64(bytes) {
  // The block size is divisible by three, so only the final block needs padding.
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 24576) {
    const block = bytes.subarray(offset, offset + 24576);
    let binary = '';
    for (const byte of block) binary += String.fromCharCode(byte);
    result += btoa(binary);
  }
  return result;
}

async function streamSpeech(port, message, controller) {
  const { requestId, text } = message;
  const { voiceId } = await chrome.storage.local.get('voiceId');
  if (!voiceId) throw new Error('VOICE_REQUIRED');
  const baseUrl = await getServerUrl();
  const model = await getModelId(baseUrl, controller.signal);
  if (controller.signal.aborted) return;
  const response = await fetch(baseUrl + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({
      model, input: text, voice: voiceId, response_format: SSE_RESPONSE_FORMAT,
      speed: 1.0, stream_format: 'sse',
      irodori: {
        chunking_enabled: true,
        chunk_min_chars: SSE_CHUNK_MIN_CHARS,
        first_sentence_chunk_min_chars: SSE_FIRST_CHUNK_MIN_CHARS
      }
    }),
    signal: controller.signal
  });
  if (!response.ok) {
    console.error('[Irodori] Speech HTTP', response.status, await response.text());
    throw new Error('Speech HTTP ' + response.status);
  }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  port.postMessage({ type: 'stream-start', requestId });
  if (contentType.startsWith('audio/')) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || controller.signal.aborted) throw new Error('Empty speech response');
    port.postMessage({ type: 'audio-chunk', requestId, index: 0,
      mediaType: contentType, audioBase64: encodeBase64(bytes) });
    port.postMessage({ type: 'stream-done', requestId, chunks: 1 });
    return;
  }
  if (contentType !== 'text/event-stream' || !response.body) {
    throw new Error('Unexpected speech response type');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seen = new Set();
  let done = false;
  const parser = createSseParser((event, raw) => {
    if (event !== 'audio_chunk' && event !== 'done') return;
    const data = JSON.parse(raw);
    if (event === 'audio_chunk') {
      if (!Number.isSafeInteger(data.index) || data.index < 0 ||
          typeof data.audio_base64 !== 'string' || !data.audio_base64 ||
          typeof data.media_type !== 'string' || !data.media_type.startsWith('audio/')) {
        throw new Error('Invalid audio chunk');
      }
      if (seen.has(data.index)) return;
      seen.add(data.index);
      port.postMessage({ type: 'audio-chunk', requestId, index: data.index,
        mediaType: data.media_type, audioBase64: data.audio_base64 });
    } else {
      if (!Number.isSafeInteger(data.chunks) || data.chunks < 1 ||
          seen.size !== data.chunks ||
          [...seen].some(index => index >= data.chunks)) throw new Error('Incomplete SSE stream');
      done = true;
      port.postMessage({ type: 'stream-done', requestId, chunks: data.chunks });
    }
  });
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      parser.push(decoder.decode(part.value, { stream: true }));
    }
    if (!done) {
      parser.push(decoder.decode());
      parser.finish();
    }
    if (!done) throw new Error('SSE stream ended before done');
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'irodori-tts-stream') return;
  const tabId = port.sender?.tab?.id;
  const validSender = tabId != null && port.sender?.url?.startsWith('https://chatgpt.com/');
  let started = false;
  let key = null;
  let controller = null;
  port.onDisconnect.addListener(() => {
    controller?.abort();
    if (key && activeRequests.get(key) === controller) activeRequests.delete(key);
  });
  port.onMessage.addListener(message => {
    if (started || !validSender || message?.type !== 'start' ||
        typeof message.requestId !== 'string' ||
        typeof message.text !== 'string' || !message.text.trim()) {
      port.disconnect();
      return;
    }
    started = true;
    key = tabId + ':' + message.requestId;
    controller = new AbortController();
    for (const [oldKey, oldController] of activeRequests) {
      if (oldKey.startsWith(tabId + ':')) oldController.abort();
    }
    activeRequests.set(key, controller);
    streamSpeech(port, message, controller).catch(error => {
      if (controller.signal.aborted) return;
      const result = errorResult(error);
      try { port.postMessage({ type: 'stream-error', requestId: message.requestId,
        error: result.error }); } catch (_) { /* Content script has gone away. */ }
    }).finally(() => {
      if (activeRequests.get(key) === controller) activeRequests.delete(key);
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return;
  if (message.action === 'checkConnection' || message.action === 'listVoices') {
    const job = message.action === 'checkConnection' ? checkConnection() : listVoices();
    job.then(result => sendResponse(
      message.action === 'listVoices' ? { voices: result } : result
    )).catch(error => sendResponse(errorResult(error)));
    return true;
  }
});
