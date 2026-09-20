// Better Chat Voice's per-reply button and Audio playback flow, adapted for Irodori.
const audioStates = new Map();
let activeState = null;
let sequence = 0;
let scanScheduled = false;
let autoReadEnabled = false;
let autoSettingsReady = false;
let autoSettingChanged = false;
let autoGeneratingState = null;
const autoQueue = [];
const baselineTurnIds = new Set();
const handledTurnIds = new Set();
const baselineTurns = new WeakSet();
const AUTO_STABLE_MS = 1500;
const NAVIGATION_STABLE_MS = 1500;
const AUTO_DEBUG = true; // Set to false after confirming behavior in Chrome.
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], [data-turn-role="assistant"], [data-message-role="assistant"]';
let routeKey = location.pathname;
let navigationHydrating = false;
let navigationTimer = null;
let navigationSignature = null;
let newChatSubmissionAt = 0;

function autoLog(stage, state) {
  if (AUTO_DEBUG) console.info('[Irodori Auto] ' + stage, turnId(state.turn) || 'unknown');
}

function navigationLog(stage) {
  if (AUTO_DEBUG) console.info('[Irodori Auto] ' + stage);
}

function noteNewChatSubmission(event) {
  if (routeKey !== '/' || !event.target?.querySelector?.(
    'textarea[name="prompt"], #prompt-textarea, [data-testid="composer-text-input"]'
  )) return;
  newChatSubmissionAt = Date.now();
}

const SKIP_SELECTOR = [
  'pre', 'button', '[role="button"]', 'nav', 'aside', 'footer', 'svg', 'script', 'style',
  '[hidden]', '[aria-hidden="true"]', '.sr-only',
  '[data-testid*="citation"]', '[data-testid*="sources"]',
  '[data-testid*="reference"]', 'a[data-testid*="source"]',
  '[data-citation]', '[data-source-chip]',
  '[aria-label^="Citation"]', '[aria-label^="Source"]',
  'sup', '.irodori-action'
].join(',');
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'TR', 'TABLE'
]);

function assistantTurns() {
  // Semantic roles cover desktop and mobile ChatGPT turn wrappers.
  return [...document.querySelectorAll(ASSISTANT_SELECTOR)]
    .filter(turn => !turn.parentElement?.closest(ASSISTANT_SELECTOR));
}

function turnId(turn) {
  return turn.getAttribute?.('data-message-id') || turn.id || null;
}

function isBaseline(turn) {
  const id = turnId(turn);
  return baselineTurns.has(turn) || !!id && baselineTurnIds.has(id);
}

function markTurnBaseline(turn) {
  baselineTurns.add(turn);
  const id = turnId(turn);
  if (id) baselineTurnIds.add(id);
  const state = audioStates.get(turn);
  if (state) {
    state.autoEligible = false;
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
  }
}

function markExistingTurns() {
  for (const turn of assistantTurns()) markTurnBaseline(turn);
}

function messageBody(turn) {
  return turn.querySelector('[data-assistant-markdown], .markdown, .prose, [data-message-content]') || turn;
}

function extractReplyText(root) {
  const chunks = [];
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.matches(SKIP_SELECTOR)) return;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (element.tagName === 'BR') {
      chunks.push('\n');
      return;
    }
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) chunks.push('\n');
    for (const child of element.childNodes) visit(child);
    if (block && element.tagName !== 'LI') chunks.push('\n');
  }
  visit(root);
  return chunks.join('');
}

function sanitizeForSpeech(text) {
  return text
    // ChatGPT usually renders Markdown; this also handles raw Markdown text.
    .replace(/(^|\n)\s*\x60{3}[\s\S]*?\x60{3}(?=\n|$)/g, '\n')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\n)[ \t]{0,3}#{1,6}[ \t]+/g, '$1')
    .replace(/(^|\n)[ \t]*>[ \t]?/g, '$1')
    .replace(/(^|\n)[ \t]*[-*+][ \t]+/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/\x60+([^\x60\n]+)\x60+/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"'\x60「」]+/gi, match => {
      // Preserve sentence punctuation following a URL.
      return match.match(/[.,!?;:、。！？，）)\]]+$/u)?.[0] || '';
    })
    .replace(/(^|\n)[ \t]*[。.,!?！？，]+[ \t]*(?=\n|$)/g, '$1')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PLAYBACK_RATES = new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5]);

function applyPlaybackRate(audio, value) {
  const rate = Number(value);
  audio.playbackRate = PLAYBACK_RATES.has(rate) ? rate : 1;
  if ('preservesPitch' in audio) audio.preservesPitch = true;
}

function setVisible(button, visible) {
  button.hidden = !visible;
  button.style.display = visible ? '' : 'none';
}

function renderState(state) {
  const { button, pauseButton, regenerateButton, status } = state;
  button.textContent = status === 'idle' || status === 'error' ? '🔊 Irodori' :
    status === 'generating' ? '■ Stop' :
    status === 'ready' ? '▶ 再生' : '■ 停止';
  button.setAttribute('aria-label', status === 'idle' || status === 'error' ?
    'Irodori で読み上げ' : status === 'ready' ?
      '生成済み音声を再生' : 'Irodori の読み上げを停止');
  setVisible(pauseButton, status === 'playing' || status === 'paused');
  pauseButton.textContent = status === 'paused' ? '▶ 再開' : '⏸ 一時停止';
  pauseButton.setAttribute('aria-label', status === 'paused' ?
    'Irodori の読み上げを再開' : 'Irodori の読み上げを一時停止');
  setVisible(regenerateButton, status === 'ready');
}

function showStatus(state, message) {
  state.statusElement.textContent = message;
}

function resumeAutoQueueSoon() {
  setTimeout(() => {
    processAutoGeneration();
    pumpAutoPlayback();
  }, 150);
}

function stopState(state, advanceQueue = true) {
  const wasActive = activeState === state;
  if (state.status === 'generating' && state.requestId) {
    chrome.runtime.sendMessage({ action: 'cancel', requestId: state.requestId }, () => {
      void chrome.runtime.lastError;
    });
  }
  if (state.audio && (state.status === 'playing' || state.status === 'paused')) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  state.requestId = null;
  state.status = state.audio ? 'ready' : 'idle';
  if (wasActive) activeState = null;
  if (autoGeneratingState === state) autoGeneratingState = null;
  renderState(state);
  showStatus(state, '');
  if (advanceQueue && wasActive) resumeAutoQueueSoon();
}

function discardAudio(state) {
  if (state.audio) {
    state.audio.onended = null;
    state.audio.onerror = null;
    state.audio.pause();
    state.audio.removeAttribute('src');
    state.audio.load();
    state.audio = null;
  }
  if (state.url) {
    URL.revokeObjectURL(state.url);
    state.url = null;
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function playCached(state, fromStart, autoPlayback = false) {
  if (!state.audio) return;
  if (activeState && activeState !== state) stopState(activeState, false);
  const audio = state.audio;
  activeState = state;
  state.status = 'playing';
  renderState(state);
  showStatus(state, '再生中');
  let speechRate = 1;
  try {
    ({ speechRate = 1 } = await chrome.storage.local.get('speechRate'));
  } catch (error) {
    console.error('[Irodori] Playback speed load failed:', error);
  }
  if (activeState !== state || state.status !== 'playing' || state.audio !== audio) return;
  try {
    applyPlaybackRate(audio, speechRate);
    if (fromStart) audio.currentTime = 0;
    await audio.play();
    if (autoPlayback && activeState === state) autoLog('playing', state);
    processAutoGeneration();
  } catch (error) {
    if (activeState !== state || state.status === 'paused' ||
        error?.name === 'AbortError' && !audio.paused) return;
    console.error('[Irodori] Playback failed:', error);
    stopState(state);
    showStatus(state, '音声を再生できませんでした。');
  }
}

async function generateReply(state, auto = false) {
  const text = sanitizeForSpeech(extractReplyText(messageBody(state.turn)));
  if (!text) {
    if (!auto) showStatus(state, '読み上げる本文がありません。');
    return false;
  }
  if (!auto) {
    if (activeState && activeState !== state) stopState(activeState, false);
    if (autoGeneratingState && autoGeneratingState !== state) {
      stopState(autoGeneratingState, false);
    }
  }
  discardAudio(state);
  const requestId = String(Date.now()) + '-' + ++sequence;
  state.requestId = requestId;
  state.status = 'generating';
  if (!auto) activeState = state;
  renderState(state);
  showStatus(state, auto ? '' : '音声生成中…');
  try {
    const response = await sendMessage({ action: 'tts', requestId, payload: text });
    if (state.requestId !== requestId || !auto && activeState !== state) return false;
    if (response?.error) {
      const message = response.error === 'VOICE_REQUIRED' ? 'Voiceを選択してください。' :
        response.error === 'CONNECTION' ?
          'Irodori-TTS Serverに接続できません。起動を確認してください。' :
          response.error === 'PERMISSION_REQUIRED' ?
            '設定画面でServerへのアクセスを許可してください。' : '音声生成に失敗しました。';
      state.status = 'error';
      state.requestId = null;
      if (activeState === state) activeState = null;
      renderState(state);
      showStatus(state, auto ? '' : message);
      if (!auto) resumeAutoQueueSoon();
      return false;
    }
    if (!Array.isArray(response?.audioBuffer)) throw new Error('No audio data');
    const blob = new Blob([new Uint8Array(response.audioBuffer)], {
      type: response.mimeType || 'audio/mpeg'
    });
    state.url = URL.createObjectURL(blob);
    state.audio = new Audio(state.url);
    const audio = state.audio;
    audio.onended = () => {
      if (state.audio !== audio || activeState !== state) return;
      activeState = null;
      state.status = 'ready';
      renderState(state);
      showStatus(state, '');
      pumpAutoPlayback();
    };
    audio.onerror = () => {
      if (state.audio !== audio) return;
      if (activeState === state) activeState = null;
      discardAudio(state);
      state.status = 'error';
      renderState(state);
      showStatus(state, '音声を再生できませんでした。');
      pumpAutoPlayback();
    };
    state.requestId = null;
    state.status = 'ready';
  } catch (error) {
    if (state.requestId !== requestId || !auto && activeState !== state) return false;
    console.error('[Irodori] Speech generation failed:', error);
    discardAudio(state);
    state.requestId = null;
    state.status = 'error';
    if (activeState === state) activeState = null;
    renderState(state);
    showStatus(state, auto ? '' : '音声生成に失敗しました。');
    if (!auto) resumeAutoQueueSoon();
    return false;
  }
  if (auto) {
    renderState(state);
    showStatus(state, '');
  } else {
    await playCached(state, true);
  }
  return true;
}

function removeQueuedAuto(state) {
  const index = autoQueue.indexOf(state);
  if (index >= 0) autoQueue.splice(index, 1);
}

function pumpAutoPlayback() {
  if (location.pathname !== routeKey) checkRouteChange();
  if (!autoReadEnabled || activeState) return;
  while (autoQueue.length) {
    const state = autoQueue[0];
    if (!state.turn.isConnected || state.status === 'error') {
      autoQueue.shift();
      continue;
    }
    if (state.audio && state.status === 'ready') {
      autoQueue.shift();
      void playCached(state, true, true);
    } else if (state.status === 'idle') {
      processAutoGeneration();
    }
    return;
  }
}

async function processAutoGeneration() {
  if (location.pathname !== routeKey) checkRouteChange();
  if (navigationHydrating) return;
  if (!autoReadEnabled || autoGeneratingState || activeState?.status === 'generating') return;
  const state = autoQueue.find(item => item.status === 'idle' && !item.audio);
  if (!state) return;
  autoGeneratingState = state;
  try {
    const { voiceId } = await chrome.storage.local.get('voiceId');
    if (location.pathname !== routeKey) checkRouteChange();
    if (!autoReadEnabled || navigationHydrating || !autoQueue.includes(state)) return;
    if (!voiceId) {
      removeQueuedAuto(state);
      return;
    }
    autoLog('generating', state);
    const generated = await generateReply(state, true);
    if (!generated && (state.status === 'error' ||
        state.status === 'idle' && activeState?.status !== 'generating')) {
      removeQueuedAuto(state);
    }
  } catch (error) {
    console.error('[Irodori] Auto speech failed:', error);
    removeQueuedAuto(state);
    if (state.status === 'generating') stopState(state, false);
  } finally {
    if (autoGeneratingState === state) autoGeneratingState = null;
    pumpAutoPlayback();
    if (autoReadEnabled) processAutoGeneration();
  }
}

function enqueueAuto(state) {
  state.autoHandled = true;
  const id = turnId(state.turn);
  if (id) handledTurnIds.add(id);
  if (activeState === state && (state.status === 'playing' || state.status === 'paused')) return;
  autoQueue.push(state);
  autoLog('queued', state);
  processAutoGeneration();
  pumpAutoPlayback();
}

function isGeneratingOnPage() {
  const button = document.querySelector?.(
    '[aria-label="生成を中止する"], [aria-label="Stop generating"], [data-testid="stop-button"]'
  );
  if (!button || button.hidden || button.closest?.('[hidden], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(button);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isTurnComplete(turn) {
  return turn.hasAttribute?.('data-message-complete') &&
    !['false', '0'].includes(turn.getAttribute?.('data-message-complete'));
}

function isTurnStreaming(turn) {
  return !isTurnComplete(turn) && turn.hasAttribute?.('data-message-streaming') &&
    !['false', '0'].includes(turn.getAttribute?.('data-message-streaming'));
}

function checkAutoCandidate(state) {
  if (!autoSettingsReady || !autoReadEnabled || navigationHydrating || state.autoHandled ||
      isBaseline(state.turn) || handledTurnIds.has(turnId(state.turn)) ||
      state.status === 'generating') return;
  const turn = state.turn;
  if (!state.autoEligible) {
    state.autoEligible = true;
    autoLog('new candidate', state);
  }
  const body = messageBody(turn);
  const currentText = body?.textContent || '';
  if (currentText !== state.autoText) {
    state.autoText = currentText;
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
  }
  if (!currentText.trim() || isTurnStreaming(turn) ||
      isGeneratingOnPage() && !isTurnComplete(turn)) {
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    return;
  }
  if (state.autoTimer) return;
  if (!state.autoWaitingLogged) {
    autoLog('waiting for stable text', state);
    state.autoWaitingLogged = true;
  }
  state.autoTimer = setTimeout(() => {
    state.autoTimer = null;
    if (location.pathname !== routeKey) {
      checkRouteChange();
      return;
    }
    if (!autoReadEnabled || state.autoHandled || !turn.isConnected ||
        isTurnStreaming(turn) || isGeneratingOnPage() && !isTurnComplete(turn)) return;
    if ((messageBody(turn)?.textContent || '') !== state.autoText) {
      checkAutoCandidate(state);
      return;
    }
    const speechText = sanitizeForSpeech(extractReplyText(messageBody(turn)));
    if (speechText) {
      autoLog('completed', state);
      enqueueAuto(state);
    }
  }, AUTO_STABLE_MS);
}

function clearAutoQueue() {
  autoQueue.length = 0;
  if (autoGeneratingState) stopState(autoGeneratingState, false);
}

function isNewChatRouteAssignment(previousRoute) {
  if (previousRoute !== '/') return false;
  const recentlySubmitted = newChatSubmissionAt > 0 &&
    Date.now() - newChatSubmissionAt < 30000;
  return recentlySubmitted || isGeneratingOnPage() || assistantTurns().some(turn =>
    !isBaseline(turn) && isTurnStreaming(turn)
  ) || [...audioStates.values()].some(state =>
    state.autoEligible && !isBaseline(state.turn)
  );
}

function beginNavigationHydration() {
  navigationHydrating = true;
  navigationSignature = null;
  clearTimeout(navigationTimer);
  navigationTimer = null;
  for (const state of audioStates.values()) {
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    state.autoEligible = false;
  }
  clearAutoQueue();
  if (activeState) stopState(activeState, false);
  markExistingTurns();
  navigationLog('navigation hydration start');
}

function checkRouteChange() {
  const nextRoute = location.pathname;
  if (nextRoute === routeKey) return;
  const previousRoute = routeKey;
  routeKey = nextRoute;
  navigationLog('route changed');
  const newChatAssignment = isNewChatRouteAssignment(previousRoute);
  newChatSubmissionAt = 0;
  if (newChatAssignment) return;
  beginNavigationHydration();
  // The observed '/' route is the blank new-chat landing page, not history.
  if (nextRoute === '/') {
    navigationHydrating = false;
    navigationLog('navigation hydration complete');
  }
}

function updateNavigationHydration(turns) {
  if (!navigationHydrating) return;
  const signature = turns.map(turn =>
    (turnId(turn) || '') + '\u0000' + (messageBody(turn)?.textContent || '')
  ).join('\u0001');
  if (signature === navigationSignature) return;
  navigationSignature = signature;
  clearTimeout(navigationTimer);
  const expectedRoute = routeKey;
  navigationTimer = setTimeout(() => {
    if (routeKey !== expectedRoute) return;
    navigationHydrating = false;
    navigationTimer = null;
    navigationSignature = null;
    navigationLog('navigation hydration complete');
  }, NAVIGATION_STABLE_MS);
}

async function onPrimary(state) {
  removeQueuedAuto(state);
  if (state.status === 'generating' || state.status === 'playing' ||
      state.status === 'paused') {
    stopState(state);
  } else if (state.status === 'ready') {
    await playCached(state, true);
  } else {
    await generateReply(state);
  }
}

async function onPause(state) {
  if (activeState !== state || !state.audio) return;
  if (state.status === 'playing') {
    state.audio.pause();
    state.status = 'paused';
    renderState(state);
    showStatus(state, '一時停止中');
  } else if (state.status === 'paused') {
    await playCached(state, false);
  }
}

async function regenerateReply(state) {
  if (state.status !== 'ready') return;
  removeQueuedAuto(state);
  await generateReply(state);
}

function destroyState(state) {
  removeQueuedAuto(state);
  clearTimeout(state.autoTimer);
  if (activeState === state || state.status === 'generating') stopState(state);
  discardAudio(state);
  audioStates.delete(state.turn);
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.speechRate) {
      for (const state of audioStates.values()) {
        if (state.audio) applyPlaybackRate(state.audio, changes.speechRate.newValue);
      }
    }
    if (changes.autoRead) {
      autoSettingChanged = true;
      // Replies already on screen at the moment of activation are historical.
      markExistingTurns();
      autoReadEnabled = changes.autoRead.newValue === true;
      autoSettingsReady = true;
      if (!autoReadEnabled) clearAutoQueue();
    }
  });
}

function addButton(turn) {
  let state = audioStates.get(turn);
  if (state?.button.isConnected || turn.querySelector('.irodori-action')) return;
  const body = messageBody(turn);
  if (!body) return;
  const action = document.createElement('div');
  action.className = 'irodori-action';
  action.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0;font-size:12px;';
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'padding:5px 9px;border:0;border-radius:6px;background:#10a37f;color:white;cursor:pointer;font-weight:600;';
  const pauseButton = document.createElement('button');
  pauseButton.type = 'button';
  pauseButton.className = 'irodori-pause';
  pauseButton.hidden = true;
  pauseButton.style.cssText = 'padding:5px 9px;border:0;border-radius:6px;background:#253449;color:white;cursor:pointer;font-weight:600;';
  const regenerateButton = document.createElement('button');
  regenerateButton.type = 'button';
  regenerateButton.textContent = '↻ 再生成';
  regenerateButton.setAttribute('aria-label', 'Irodori 音声を再生成');
  regenerateButton.style.cssText = 'padding:5px 9px;border:0;border-radius:6px;background:#253449;color:white;cursor:pointer;font-weight:600;';
  const status = document.createElement('span');
  status.className = 'irodori-status';
  status.setAttribute('role', 'status');
  action.append(pauseButton, button, regenerateButton, status);
  if (state) {
    Object.assign(state, { button, pauseButton, regenerateButton, statusElement: status });
  } else {
    state = {
      turn, button, pauseButton, regenerateButton, statusElement: status,
      status: 'idle', requestId: null, audio: null, url: null,
      autoEligible: false, autoHandled: false, autoTimer: null, autoText: '',
      autoWaitingLogged: false
    };
    audioStates.set(turn, state);
  }
  renderState(state);
  pauseButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void onPause(state);
  });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void onPrimary(state);
  });
  regenerateButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void regenerateReply(state);
  });
  if (body === turn) turn.appendChild(action);
  else body.insertAdjacentElement('afterend', action);
}

function scan() {
  scanScheduled = false;
  checkRouteChange();
  const turns = assistantTurns();
  for (const turn of turns) {
    if (navigationHydrating) {
      if (!isBaseline(turn)) navigationLog('baseline historical turn');
      markTurnBaseline(turn);
    }
    addButton(turn);
    const state = audioStates.get(turn);
    if (state) checkAutoCandidate(state);
  }
  updateNavigationHydration(turns);
  for (const [turn, state] of audioStates) {
    if (!turn.isConnected) destroyState(state);
  }
}

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(scan);
}

const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, {
  childList: true, characterData: true, attributes: true,
  attributeFilter: ['data-message-streaming', 'data-message-complete'], subtree: true
});
window.addEventListener('popstate', scheduleScan);
window.addEventListener('submit', noteNewChatSubmission, true);
markExistingTurns();
scan();
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('autoRead').then(({ autoRead = false }) => {
    if (autoSettingChanged) return;
    autoReadEnabled = autoRead === true;
    autoSettingsReady = true;
    scan();
  }).catch(error => {
    console.error('[Irodori] Auto read setting load failed:', error);
    autoSettingsReady = true;
  });
}
