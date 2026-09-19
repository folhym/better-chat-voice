const DEFAULT_SERVER = 'http://127.0.0.1:8088';
const serverInput = document.querySelector('#serverUrl');
const voiceSelect = document.querySelector('#voiceSelect');
const speedSelect = document.querySelector('#speedSelect');
const status = document.querySelector('#status');
const statusDetail = document.querySelector('#statusDetail');
const connectButton = document.querySelector('#connect');
const reloadButton = document.querySelector('#reloadVoices');

function normalizeServerUrl(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Invalid server URL');
  }
  return url;
}

function sendMessage(action) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function setStatus(state, label, detail = '') {
  status.dataset.state = state;
  status.textContent = '● ' + label;
  statusDetail.textContent = detail;
}

function setBusy(busy) {
  connectButton.disabled = busy;
  reloadButton.disabled = busy;
}

async function refreshVoices() {
  const { voiceId = '' } = await chrome.storage.local.get('voiceId');
  const response = await sendMessage('listVoices');
  if (response?.error || !Array.isArray(response?.voices)) {
    throw new Error(response?.error || 'Invalid voice list');
  }
  voiceSelect.replaceChildren();
  voiceSelect.add(new Option('Voiceを選択してください', ''));
  for (const voice of response.voices) {
    voiceSelect.add(new Option(voice.name || voice.id, voice.id));
  }
  const stillAvailable = voiceId &&
    [...voiceSelect.options].some(option => option.value === voiceId);
  voiceSelect.value = stillAvailable ? voiceId : '';
  if (voiceId && !stillAvailable) await chrome.storage.local.remove('voiceId');
  return { count: response.voices.length, selected: !!voiceSelect.value };
}

function showVoiceState({ count, selected }) {
  if (count === 0) {
    setStatus('warning', '接続OK / Voiceなし',
      'Irodori-TTS Serverのvoices設定を確認してください。');
  } else {
    setStatus('ok', '接続OK', selected ? '' : 'Voiceを選択してください。');
  }
}

async function checkConnectionAndVoices() {
  try {
    const response = await sendMessage('checkConnection');
    if (!response?.ok) throw new Error(response?.error || 'Connection failed');
  } catch (error) {
    console.error('[Irodori] Connection check failed:', error);
    setStatus('error', 'Server未接続',
      'Irodori-TTS Serverが起動しているか確認してください。');
    return;
  }
  try {
    showVoiceState(await refreshVoices());
  } catch (error) {
    console.error('[Irodori] Voice list failed:', error);
    setStatus('warning', '接続OK / Voice取得失敗');
  }
}

async function loadSettings() {
  const { serverUrl = DEFAULT_SERVER, voiceId = '', speechRate = 1 } =
    await chrome.storage.local.get(['serverUrl', 'voiceId', 'speechRate']);
  serverInput.value = serverUrl;
  if (voiceId) {
    voiceSelect.add(new Option(voiceId + '（保存済み）', voiceId));
    voiceSelect.value = voiceId;
  }
  const rate = String(speechRate);
  speedSelect.value = [...speedSelect.options].some(option => option.value === rate) ? rate : '1';
  if (speedSelect.value !== rate) await chrome.storage.local.set({ speechRate: 1 });
  await checkConnectionAndVoices();
}

voiceSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ voiceId: voiceSelect.value });
  if (status.dataset.state === 'ok') {
    statusDetail.textContent = voiceSelect.value ? 'Voiceを保存しました。' : 'Voiceを選択してください。';
  }
});

speedSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ speechRate: Number(speedSelect.value) });
});

reloadButton.addEventListener('click', async () => {
  const { serverUrl = DEFAULT_SERVER } = await chrome.storage.local.get('serverUrl');
  let enteredUrl;
  try {
    enteredUrl = normalizeServerUrl(serverInput.value).origin;
  } catch {
    statusDetail.textContent = 'Server URLを確認してください。';
    return;
  }
  if (enteredUrl !== serverUrl) {
    statusDetail.textContent = 'URL変更後は接続確認を押してください。';
    return;
  }
  setBusy(true);
  try {
    showVoiceState(await refreshVoices());
  } catch (error) {
    console.error('[Irodori] Voice reload failed:', error);
    // A failed Voice API may mean either a stopped server or just a Voice failure.
    try {
      const health = await sendMessage('checkConnection');
      if (!health?.ok) throw new Error(health?.error || 'Connection failed');
      setStatus('warning', '接続OK / Voice取得失敗');
    } catch (healthError) {
      console.error('[Irodori] Connection check failed:', healthError);
      setStatus('error', 'Server未接続',
        'Irodori-TTS Serverが起動しているか確認してください。');
    }
  } finally {
    setBusy(false);
  }
});

connectButton.addEventListener('click', async () => {
  let url;
  try {
    url = normalizeServerUrl(serverInput.value);
  } catch {
    statusDetail.textContent = 'Server URLを確認してください。';
    return;
  }
  const isDefaultHost = url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!isDefaultHost) {
    try {
      const granted = await chrome.permissions.request({
        origins: [url.protocol + '//' + url.hostname + '/*']
      });
      if (!granted) {
        statusDetail.textContent = 'Serverへのアクセス許可が必要です。';
        return;
      }
    } catch (error) {
      console.error('[Irodori] Permission request failed:', error);
      statusDetail.textContent = 'Serverへのアクセス許可が必要です。';
      return;
    }
  }
  setBusy(true);
  try {
    const { serverUrl: previousUrl = DEFAULT_SERVER } =
      await chrome.storage.local.get('serverUrl');
    const changed = previousUrl !== url.origin;
    await chrome.storage.local.set({ serverUrl: url.origin });
    if (changed) {
      await chrome.storage.local.remove('voiceId');
      voiceSelect.replaceChildren();
      voiceSelect.add(new Option('Voiceを選択してください', ''));
    }
    serverInput.value = url.origin;
    await checkConnectionAndVoices();
  } catch (error) {
    console.error('[Irodori] Server settings failed:', error);
    setStatus('error', 'Server未接続',
      'Irodori-TTS Serverが起動しているか確認してください。');
  } finally {
    setBusy(false);
  }
});

loadSettings();
