// Network access stays in the extension service worker, away from ChatGPT's origin.
const DEFAULT_SERVER = 'http://127.0.0.1:8088';
const activeRequests = new Map();

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

// This is the only TTS generation function; a later SSE implementation can replace it.
async function generateSpeech(text, requestId, tabId) {
  const controller = new AbortController();
  const key = tabId + ':' + requestId;
  for (const [oldKey, oldController] of activeRequests) {
    if (oldKey.startsWith(tabId + ':')) oldController.abort();
  }
  activeRequests.set(key, controller);
  try {
    const { voiceId } = await chrome.storage.local.get('voiceId');
    if (!voiceId) throw new Error('VOICE_REQUIRED');
    const baseUrl = await getServerUrl();
    const model = await getModelId(baseUrl, controller.signal);
    const response = await fetch(baseUrl + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        model,
        input: text,
        voice: voiceId,
        speed: 1.0,
        response_format: 'mp3'
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      console.error('[Irodori] Speech HTTP', response.status, await response.text());
      throw new Error('Speech HTTP ' + response.status);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('audio/')) throw new Error('Unexpected speech response type');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Empty speech response');
    return { audioBuffer: Array.from(bytes), mimeType: contentType.split(';')[0] };
  } finally {
    activeRequests.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return;
  if (message.action === 'cancel') {
    const key = sender.tab?.id + ':' + message.requestId;
    activeRequests.get(key)?.abort();
    sendResponse({ ok: true });
    return;
  }
  if (message.action === 'tts') {
    if (!sender.tab || !sender.url?.startsWith('https://chatgpt.com/') ||
        typeof message.payload !== 'string' || !message.payload.trim() ||
        typeof message.requestId !== 'string') {
      sendResponse({ error: 'GENERATION' });
      return;
    }
    generateSpeech(message.payload, message.requestId, sender.tab.id)
      .then(sendResponse)
      .catch(error => sendResponse(errorResult(error)));
    return true;
  }
  if (message.action === 'checkConnection' || message.action === 'listVoices') {
    const job = message.action === 'checkConnection' ? checkConnection() : listVoices();
    job.then(result => sendResponse(
      message.action === 'listVoices' ? { voices: result } : result
    )).catch(error => sendResponse(errorResult(error)));
    return true;
  }
});
