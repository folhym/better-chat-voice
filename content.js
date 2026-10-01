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
const COMPOSER_EDITABLE_SELECTOR =
  '[contenteditable="true"], [role="textbox"], textarea';
const COMPOSER_CONTAINER_SELECTOR = 'form, [data-testid*="composer"]';
const SUBMISSION_DEDUPE_MS = 800;
const SUBMISSION_CONFIRM_MS = 30000;
const STOP_GENERATING_SELECTOR =
  '[aria-label="生成を中止する"], [aria-label="Stop generating"], [data-testid="stop-button"]';
const AUTO_DEBUG = true; // Set to false after confirming behavior in Chrome.
const SELECTORS = {
  legacyAssistant: [
    '[data-message-author-role="assistant"]',
    '[data-turn-role="assistant"]',
    '[data-message-role="assistant"]'
  ].join(','),
  assistantBody: '[data-markdown-text-style="assistant-message"]',
  assistantUnit: [
    '[data-content-search-unit-key$=":assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]'
  ].join(','),
  structuralTurn: [
    'article[data-testid^="conversation-turn"]',
    '[data-testid*="conversation-turn"]'
  ].join(','),
  userBubble: '[data-user-message-bubble="true"]',
  legacyUser: '[data-message-author-role="user"], [data-turn-role="user"], [data-message-role="user"]',
  action: '.irodori-action'
};
let routeKey = location.pathname;
let navigationHydrating = false;
let navigationTimer = null;
let navigationSignature = null;
let domDiagnosticSignature = '';
let liveGeneration = null;
let pendingSubmissionIntent = null;
let liveGenerationSequence = 0;

function autoLog(stage, state) {
  if (AUTO_DEBUG) console.info('[Irodori Auto] ' + stage);
}

function navigationLog(stage) {
  if (AUTO_DEBUG) console.info('[Irodori Auto] ' + stage);
}

function isSendButton(button) {
  if (!button?.matches?.('button') ||
      (button.type !== 'submit' && button.getAttribute?.('type') !== 'submit') ||
      button.matches?.(STOP_GENERATING_SELECTOR)) return false;
  const label = button.getAttribute?.('aria-label') || '';
  if (/送信|^send\b/i.test(label)) return true;
  if (/コピー|copy|再試行|retry|添付|attach|cancel|停止|stop/i.test(label)) return false;
  return !!button.closest?.(COMPOSER_CONTAINER_SELECTOR)?.querySelector?.(
    COMPOSER_EDITABLE_SELECTOR
  );
}

function hasComposerSendButton(container) {
  return !!container?.querySelectorAll &&
    [...container.querySelectorAll('button')].some(isSendButton);
}

function noteSubmissionSignal(kind) {
  navigationLog('submission signal: ' + kind);
  const now = Date.now();
  if (pendingSubmissionIntent?.routeKey === routeKey &&
      now - pendingSubmissionIntent.submittedAt < SUBMISSION_DEDUPE_MS) {
    pendingSubmissionIntent.signalKinds.add(kind);
    navigationLog('submission signal deduped');
    return;
  }
  if (kind === 'submit' && liveGeneration?.routeKey === routeKey &&
      now - liveGeneration.submittedAt < SUBMISSION_DEDUPE_MS &&
      (liveGeneration.signalKinds.has('click') ||
        liveGeneration.signalKinds.has('enter'))) {
    liveGeneration.signalKinds.add(kind);
    navigationLog('submission signal deduped');
    return;
  }
  clearLiveGeneration();
  const users = userMessages();
  pendingSubmissionIntent = {
    token: ++liveGenerationSequence,
    routeKey,
    submittedAt: now,
    signalKinds: new Set([kind]),
    knownUsers: new Set(users),
    knownUserKeys: new Set(users.map(userTurnKey).filter(Boolean)),
    lastConversationNode: [...document.querySelectorAll([
      SELECTORS.legacyAssistant, SELECTORS.assistantBody,
      SELECTORS.userBubble, SELECTORS.legacyUser
    ].join(','))].at(-1) || null
  };
  scheduleScan();
}

function noteSubmission(event) {
  if (event.submitter) {
    if (!isSendButton(event.submitter)) return;
  } else {
    const form = event.target;
    if (!form?.querySelector?.(COMPOSER_EDITABLE_SELECTOR) ||
        !hasComposerSendButton(form)) return;
  }
  noteSubmissionSignal('submit');
}

function noteComposerEnter(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing ||
      event.keyCode === 229 || event.repeat) return;
  const editable = event.target?.closest?.(COMPOSER_EDITABLE_SELECTOR);
  if (!editable) return;
  const container = editable.closest?.(COMPOSER_CONTAINER_SELECTOR);
  if (!hasComposerSendButton(container)) return;
  noteSubmissionSignal('enter');
}

function clearLiveGeneration() {
  if (!liveGeneration) return;
  const token = liveGeneration.token;
  liveGeneration = null;
  for (const state of audioStates.values()) {
    if (state.liveToken !== token) continue;
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    state.autoEligible = false;
    state.liveToken = null;
  }
}

function noteGenerationCancel(event) {
  if (event.target?.closest?.(STOP_GENERATING_SELECTOR)) {
    pendingSubmissionIntent = null;
    clearLiveGeneration();
    return;
  }
  const button = event.target?.closest?.('button');
  if (isSendButton(button)) noteSubmissionSignal('click');
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
  const turns = new Set();
  for (const turn of document.querySelectorAll(SELECTORS.legacyAssistant)) {
    if (!turn.parentElement?.closest(SELECTORS.legacyAssistant) && !isUserUnit(turn)) {
      turns.add(turn);
    }
  }
  for (const body of document.querySelectorAll(SELECTORS.assistantBody)) {
    if (body.closest?.(SELECTORS.userBubble)) continue;
    const unit = body.closest?.(SELECTORS.assistantUnit) ||
      body.closest?.('[data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]') ||
      body.closest?.(SELECTORS.structuralTurn) || body;
    if (!isUserUnit(unit)) turns.add(unit);
  }
  return [...turns];
}

function userMessages() {
  return [...new Set([...document.querySelectorAll(
    SELECTORS.userBubble + ',' + SELECTORS.legacyUser
  )].map(user => user.closest?.('[data-turn-key]') ||
    user.closest?.(SELECTORS.legacyUser) || user))];
}

function userTurnKey(user) {
  return user?.closest?.('[data-turn-key]')?.getAttribute('data-turn-key') || null;
}

function isAfter(reference, candidate) {
  return !!reference?.isConnected && !!candidate?.compareDocumentPosition &&
    !!(reference.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function syncSubmittedUser() {
  const generation = pendingSubmissionIntent;
  if (!generation) return;
  if (Date.now() - generation.submittedAt >= SUBMISSION_CONFIRM_MS) {
    pendingSubmissionIntent = null;
    return;
  }
  for (const user of userMessages()) {
    const key = userTurnKey(user);
    if (generation.knownUsers.has(user) || key && generation.knownUserKeys.has(key)) continue;
    if (generation.lastConversationNode?.isConnected &&
        !isAfter(generation.lastConversationNode, user)) continue;
    liveGeneration = {
      ...generation,
      userElement: user,
      userTurnKey: key,
      candidateAssistantId: null,
      candidateTurn: null
    };
    pendingSubmissionIntent = null;
    navigationLog('user message confirmed');
    navigationLog('live generation armed');
    return;
  }
}

function matchesLiveAssistant(turn) {
  const generation = liveGeneration;
  if (!generation || generation.routeKey !== routeKey) return false;
  const id = turnId(turn);
  if (generation.candidateTurn) return turn === generation.candidateTurn ||
    !!id && id === generation.candidateAssistantId;
  const assistantKey = turn.closest?.('[data-turn-key]')?.getAttribute('data-turn-key');
  if (generation.userTurnKey && assistantKey) {
    if (generation.userTurnKey !== assistantKey) return false;
  } else if (!generation.userElement || !isAfter(generation.userElement, turn)) {
    // A legacy reply without a mounted user needs an explicit live stream signal.
    if (!isTurnStreaming(turn) || generation.lastConversationNode?.isConnected &&
        !isAfter(generation.lastConversationNode, turn)) return false;
  }
  generation.candidateAssistantId = id;
  generation.candidateTurn = turn;
  navigationLog('live assistant matched');
  return true;
}

function isUserUnit(element) {
  if (!element) return true;
  if (element.matches?.(SELECTORS.userBubble) || element.closest?.(SELECTORS.userBubble)) return true;
  return ['data-content-search-unit-key', 'data-chatgpt-search-unit-key']
    .some(name => element.getAttribute?.(name)?.endsWith(':user'));
}

function ownOrDescendantAttribute(turn, name) {
  const own = turn.getAttribute?.(name);
  if (own) return own;
  return turn.querySelector?.('[' + name + ']')?.getAttribute?.(name) || null;
}

function assistantMessageId(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return [...parsed].reverse().find(item =>
      typeof item === 'string' && item) || null;
    if (typeof parsed === 'string' && parsed) return parsed;
  } catch (_) { /* Some builds expose one ID or whitespace/comma-separated IDs. */ }
  return value.split(/[\s,]+/).filter(Boolean).at(-1) || null;
}

function turnId(turn) {
  return ownOrDescendantAttribute(turn, 'data-chatgpt-selection-message-id') ||
    assistantMessageId(ownOrDescendantAttribute(turn, 'data-chatgpt-search-message-ids')) ||
    turn.getAttribute?.('data-content-search-unit-key') ||
    turn.getAttribute?.('data-chatgpt-search-unit-key') ||
    turn.getAttribute?.('data-message-id') || turn.id || null;
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
  if (turn.matches?.(SELECTORS.assistantBody)) return turn;
  return turn.querySelector(SELECTORS.assistantBody) ||
    turn.querySelector('[data-assistant-markdown], .markdown, .prose, [data-message-content]') || turn;
}

function logDomDiagnostics(turns) {
  if (!AUTO_DEBUG) return;
  const legacyCount = document.querySelectorAll(SELECTORS.legacyAssistant).length;
  const bodies = [...document.querySelectorAll(SELECTORS.assistantBody)];
  const units = new Set(bodies.map(body => body.closest?.(SELECTORS.assistantUnit)).filter(Boolean));
  const actions = document.querySelectorAll(SELECTORS.action).length;
  const signature = [legacyCount, bodies.length, units.size, turns.length, actions].join(':');
  if (signature === domDiagnosticSignature) return;
  domDiagnosticSignature = signature;
  console.info('[Irodori DOM]', {
    legacyAssistants: legacyCount,
    newAssistantBodies: bodies.length,
    assistantUnits: units.size,
    detectedTurns: turns.length,
    irodoriActions: actions
  });
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
  const { button, pauseButton, regenerateButton } = state;
  const status = state.status = state.playbackStatus === 'playing' ||
    state.playbackStatus === 'paused' || state.playbackStatus === 'buffering' ?
      state.playbackStatus : state.generationStatus === 'streaming' ? 'generating' :
        state.generationStatus === 'error' ? 'error' :
          state.generationStatus === 'complete' ? 'ready' : 'idle';
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

function sseNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function logSseSummary(state) {
  const m = state.metrics;
  if (!AUTO_DEBUG || !m || m.reported || state.generationStatus !== 'complete') return;
  m.reported = true;
  const seconds = value => value == null ? '—' : ((value - m.requestStart) / 1000).toFixed(2) + 's';
  console.info('[Irodori SSE]', {
    firstChunk: seconds(m.firstChunk), firstPlayback: seconds(m.firstPlayback),
    generationComplete: seconds(m.streamDone), chunks: state.audioChunks.length,
    bufferUnderruns: m.bufferUnderruns
  });
}

function closeStream(state) {
  const port = state.port;
  state.port = null;
  state.requestId = null;
  if (port) port.disconnect();
}

function stopState(state, advanceQueue = true) {
  const wasActive = activeState === state;
  const incomplete = state.generationStatus === 'streaming';
  if (incomplete) closeStream(state);
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  state.audio = null;
  state.nextChunkIndex = 0;
  state.playbackStatus = 'idle';
  state.playToken++;
  if (incomplete) {
    discardAudio(state);
    state.generationStatus = 'idle';
  } else logSseSummary(state);
  if (wasActive) activeState = null;
  if (autoGeneratingState === state) autoGeneratingState = null;
  renderState(state);
  showStatus(state, '');
  if (advanceQueue && wasActive) resumeAutoQueueSoon();
}

function discardAudio(state) {
  for (const chunk of state.audioChunks) {
    if (!chunk) continue;
    const audio = chunk.audio;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(chunk.url);
  }
  state.audioChunks = [];
  state.audio = null;
  state.nextChunkIndex = 0;
}

function finishPlayback(state) {
  if (activeState === state) activeState = null;
  state.audio = null;
  state.nextChunkIndex = 0;
  state.playbackStatus = 'ended';
  renderState(state);
  showStatus(state, '');
  logSseSummary(state);
  pumpAutoPlayback();
}

async function playNextChunk(state, fromStart, autoPlayback = false) {
  if (activeState !== state || state.playbackStatus !== 'playing') return;
  const chunk = state.audioChunks[state.nextChunkIndex];
  if (!chunk) {
    if (state.generationStatus === 'complete') finishPlayback(state);
    else {
      state.playbackStatus = 'buffering';
      renderState(state);
      showStatus(state, '次の音声を待機中…');
    }
    return;
  }
  const audio = chunk.audio;
  state.audio = audio;
  const token = state.playToken;
  let speechRate = 1;
  try {
    ({ speechRate = 1 } = await chrome.storage.local.get('speechRate'));
  } catch (error) {
    console.error('[Irodori] Playback speed load failed:', error);
  }
  if (activeState !== state || state.playbackStatus !== 'playing' ||
      state.audio !== audio || token !== state.playToken) return;
  try {
    applyPlaybackRate(audio, speechRate);
    if (fromStart) audio.currentTime = 0;
    await audio.play();
    if (activeState !== state || state.playbackStatus !== 'playing' ||
        state.audio !== audio || token !== state.playToken) return;
    if (!state.metrics.firstPlayback) state.metrics.firstPlayback = sseNow();
    chunk.playStart = sseNow();
    if (autoPlayback && activeState === state) autoLog('playing', state);
    processAutoGeneration();
  } catch (error) {
    if (activeState !== state || state.playbackStatus === 'paused' ||
        error?.name === 'AbortError' && !audio.paused) return;
    console.error('[Irodori] Playback failed:', error);
    failStream(state, '音声を再生できませんでした。');
  }
}

async function playCached(state, fromStart, autoPlayback = false) {
  if (!state.audioChunks[0]) return;
  if (activeState && activeState !== state) stopState(activeState, false);
  activeState = state;
  if (fromStart) state.nextChunkIndex = 0;
  state.playbackStatus = 'playing';
  state.playToken++;
  renderState(state);
  showStatus(state, '再生中');
  await playNextChunk(state, fromStart, autoPlayback);
}

function failStream(state, message) {
  closeStream(state);
  discardAudio(state);
  state.generationStatus = 'error';
  state.playbackStatus = 'idle';
  state.playToken++;
  if (activeState === state) activeState = null;
  renderState(state);
  showStatus(state, message);
  resumeAutoQueueSoon();
}

function receiveChunk(state, message) {
  const { index, mediaType, audioBase64 } = message;
  if (!Number.isSafeInteger(index) || index < 0 || state.audioChunks[index] ||
      typeof mediaType !== 'string' || !mediaType.startsWith('audio/') ||
      typeof audioBase64 !== 'string' || !audioBase64) throw new Error('Invalid audio chunk');
  const binary = atob(audioBase64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const audio = new Audio(url);
  const chunk = { index, url, mediaType, audio, received: sseNow() };
  state.audioChunks[index] = chunk;
  if (!state.metrics.firstChunk) state.metrics.firstChunk = chunk.received;
  audio.onended = () => {
    if (state.audio !== audio || activeState !== state ||
        state.playbackStatus !== 'playing') return;
    chunk.playEnd = sseNow();
    state.audio = null;
    state.nextChunkIndex = index + 1;
    void playNextChunk(state, true);
  };
  audio.onerror = () => {
    if (state.generationStatus === 'idle' || state.generationStatus === 'error') return;
    failStream(state, '音声を再生できませんでした。');
  };
  if (state.playbackStatus === 'buffering' && state.nextChunkIndex === index) {
    state.metrics.bufferUnderruns++;
    state.playbackStatus = 'playing';
    renderState(state);
    void playNextChunk(state, true);
  } else if ((!activeState || activeState === state) && state.playbackStatus === 'idle' &&
      (state.autoRequest ? autoQueue[0] === state && autoReadEnabled : index === 0)) {
    if (state.autoRequest) autoQueue.shift();
    void playCached(state, true, state.autoRequest);
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
    if (autoGeneratingState && autoGeneratingState !== state) stopState(autoGeneratingState, false);
    activeState = state;
  }
  discardAudio(state);
  state.generationStatus = 'streaming';
  state.playbackStatus = 'idle';
  state.autoRequest = auto;
  const requestId = String(Date.now()) + '-' + ++sequence;
  state.requestId = requestId;
  state.metrics = { requestStart: sseNow(), firstChunk: null, firstPlayback: null,
    streamDone: null, bufferUnderruns: 0, reported: false };
  renderState(state);
  showStatus(state, auto ? '' : '音声生成中…');
  return new Promise(resolve => {
    const port = chrome.runtime.connect({ name: 'irodori-tts-stream' });
    state.port = port;
    let settled = false;
    function settle(success) {
      if (settled) return;
      settled = true;
      resolve(success);
    }
    port.onMessage.addListener(message => {
      if (state.requestId !== requestId || message.requestId !== requestId) return;
      try {
        if (message.type === 'audio-chunk') receiveChunk(state, message);
        else if (message.type === 'stream-done') {
          if (!Number.isSafeInteger(message.chunks) || message.chunks < 1 ||
              state.audioChunks.length !== message.chunks ||
              Array.from({ length: message.chunks }, (_, index) =>
                state.audioChunks[index]).some(chunk => !chunk)) {
            throw new Error('Incomplete audio stream');
          }
          state.generationStatus = 'complete';
          state.metrics.streamDone = sseNow();
          settle(true);
          closeStream(state);
          if (state.playbackStatus === 'buffering') finishPlayback(state);
          else renderState(state);
          if (auto) pumpAutoPlayback();
        } else if (message.type === 'stream-error') {
          const uiMessage = message.error === 'VOICE_REQUIRED' ? 'Voiceを選択してください。' :
            message.error === 'CONNECTION' ?
              'Irodori-TTS Serverに接続できません。起動を確認してください。' :
              message.error === 'PERMISSION_REQUIRED' ?
                '設定画面でServerへのアクセスを許可してください。' : '音声生成に失敗しました。';
          failStream(state, auto ? '' : uiMessage);
          settle(false);
        }
      } catch (error) {
        console.error('[Irodori] Speech stream failed:', error);
        failStream(state, auto ? '' : '音声生成に失敗しました。');
        settle(false);
      }
    });
    port.onDisconnect.addListener(() => {
      if (state.requestId === requestId) {
        failStream(state, auto ? '' : '音声生成に失敗しました。');
      }
      settle(false);
    });
    try { port.postMessage({ type: 'start', requestId, text }); }
    catch (error) {
      console.error('[Irodori] Port start failed:', error);
      failStream(state, auto ? '' : '音声生成に失敗しました。');
      settle(false);
    }
  });
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
    if (state.audioChunks[0] && state.playbackStatus !== 'playing' &&
        state.playbackStatus !== 'paused' && state.playbackStatus !== 'buffering') {
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
  const state = autoQueue.find(item => item.generationStatus === 'idle' && !item.audioChunks.length);
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
  clearLiveGeneration();
  if (activeState === state && (state.status === 'playing' || state.status === 'paused')) return;
  autoQueue.push(state);
  autoLog('queued', state);
  processAutoGeneration();
  pumpAutoPlayback();
}

function isGeneratingOnPage() {
  const button = document.querySelector?.(STOP_GENERATING_SELECTOR);
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
      state.status === 'generating' || !liveGeneration ||
      state.liveToken !== liveGeneration.token) return;
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
        !liveGeneration || state.liveToken !== liveGeneration.token ||
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

function conversationRoute(pathname) {
  const match = pathname.match(/^(.*)\/(?:c|uc)\/[^/]+\/?$/);
  return match ? { base: match[1] || '/', conversation: true } :
    { base: pathname.replace(/\/+$/, '') || '/', conversation: false };
}

function isNewChatRouteAssignment(previousRoute, nextRoute) {
  const submission = liveGeneration || pendingSubmissionIntent;
  if (!submission || submission.routeKey !== previousRoute ||
      Date.now() - submission.submittedAt >= SUBMISSION_CONFIRM_MS) return false;
  const previous = conversationRoute(previousRoute);
  const next = conversationRoute(nextRoute);
  return !previous.conversation && next.conversation && previous.base === next.base;
}

function beginNavigationHydration() {
  pendingSubmissionIntent = null;
  clearLiveGeneration();
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
  for (const state of audioStates.values()) {
    if (state.generationStatus === 'streaming') stopState(state, false);
    discardAudio(state);
    state.generationStatus = 'idle';
    state.playbackStatus = 'idle';
    renderState(state);
  }
  markExistingTurns();
  navigationLog('navigation hydration start');
}

function checkRouteChange() {
  const nextRoute = location.pathname;
  if (nextRoute === routeKey) return;
  const previousRoute = routeKey;
  routeKey = nextRoute;
  const newChatAssignment = isNewChatRouteAssignment(previousRoute, nextRoute);
  if (newChatAssignment) {
    navigationLog('new conversation route assignment');
    if (liveGeneration) liveGeneration.routeKey = nextRoute;
    if (pendingSubmissionIntent) pendingSubmissionIntent.routeKey = nextRoute;
    return;
  }
  navigationLog(nextRoute === '/' ? 'route changed' : 'history navigation');
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
      state.status === 'paused' || state.status === 'buffering') {
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
    state.playbackStatus = 'paused';
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
  if (activeState === state || state.generationStatus === 'streaming') stopState(state);
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
      pendingSubmissionIntent = null;
      clearLiveGeneration();
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
  if (state?.button.isConnected || turn.querySelector(SELECTORS.action)) return;
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
      status: 'idle', generationStatus: 'idle', playbackStatus: 'idle',
      requestId: null, port: null, audio: null, audioChunks: [],
      nextChunkIndex: 0, playToken: 0, metrics: null, autoRequest: false,
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
  syncSubmittedUser();
  let newlyHistorical = 0;
  for (const turn of turns) {
    if (navigationHydrating) {
      if (!isBaseline(turn)) navigationLog('baseline historical turn');
      markTurnBaseline(turn);
    }
    addButton(turn);
    const state = audioStates.get(turn);
    if (state && !isBaseline(turn) && !state.autoEligible && !state.autoHandled &&
        (!autoSettingsReady || !autoReadEnabled || navigationHydrating ||
          !matchesLiveAssistant(turn))) {
      markTurnBaseline(turn);
      if (!navigationHydrating) newlyHistorical++;
    } else if (state && !state.autoEligible && !isBaseline(turn) && liveGeneration) {
      state.liveToken = liveGeneration.token;
    }
    if (state) checkAutoCandidate(state);
  }
  if (newlyHistorical) navigationLog('historical virtualized turn');
  updateNavigationHydration(turns);
  for (const [turn, state] of audioStates) {
    if (!turn.isConnected) destroyState(state);
  }
  logDomDiagnostics(turns);
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
window.addEventListener('submit', noteSubmission, true);
window.addEventListener('keydown', noteComposerEnter, true);
window.addEventListener('click', noteGenerationCancel, true);
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
