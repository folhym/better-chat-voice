// Better Chat Voice's per-reply button and Audio playback flow, adapted for Irodori.
let activeSession = null;
let sequence = 0;
let scanScheduled = false;

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
  const selector = '[data-message-author-role="assistant"], [data-turn-role="assistant"], [data-message-role="assistant"]';
  return [...document.querySelectorAll(selector)]
    .filter(turn => !turn.parentElement?.closest(selector));
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

function setButton(button, busy) {
  button.textContent = busy ? '■ Stop' : '🔊 Irodori';
  button.setAttribute('aria-label', busy ? 'Irodori の読み上げを停止' : 'Irodori で読み上げ');
}

function showStatus(button, message) {
  const status = button.parentElement?.querySelector('.irodori-status');
  if (status) status.textContent = message;
}

function stopActive() {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  chrome.runtime.sendMessage({ action: 'cancel', requestId: session.requestId }, () => {
    void chrome.runtime.lastError;
  });
  if (session.audio) {
    session.audio.pause();
    session.audio.removeAttribute('src');
    session.audio.load();
  }
  if (session.url) URL.revokeObjectURL(session.url);
  setButton(session.button, false);
  showStatus(session.button, '');
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function readReply(button, turn) {
  if (activeSession?.button === button) {
    stopActive();
    return;
  }
  stopActive();
  const text = sanitizeForSpeech(extractReplyText(messageBody(turn)));
  if (!text) {
    showStatus(button, '読み上げる本文がありません。');
    return;
  }
  const session = { button, requestId: String(Date.now()) + '-' + ++sequence, audio: null, url: null };
  activeSession = session;
  setButton(button, true);
  showStatus(button, '音声生成中…');
  try {
    const response = await sendMessage({ action: 'tts', requestId: session.requestId, payload: text });
    if (activeSession !== session) return;
    if (response?.error) {
      if (response.error === 'VOICE_REQUIRED') {
        showStatus(button, 'Voiceを選択してください。');
      } else if (response.error === 'CONNECTION') {
        showStatus(button, 'Irodori-TTS Serverに接続できません。起動を確認してください。');
      } else if (response.error === 'PERMISSION_REQUIRED') {
        showStatus(button, '設定画面でServerへのアクセスを許可してください。');
      } else {
        showStatus(button, '音声生成に失敗しました。');
      }
      activeSession = null;
      setButton(button, false);
      return;
    }
    if (!Array.isArray(response?.audioBuffer)) throw new Error('No audio data');
    const blob = new Blob([new Uint8Array(response.audioBuffer)], {
      type: response.mimeType || 'audio/mpeg'
    });
    session.url = URL.createObjectURL(blob);
    session.audio = new Audio(session.url);
    session.audio.onended = () => {
      if (activeSession === session) stopActive();
    };
    session.audio.onerror = () => {
      if (activeSession === session) {
        stopActive();
        showStatus(button, '音声を再生できませんでした。');
      }
    };
    showStatus(button, '再生中');
    await session.audio.play();
  } catch (error) {
    if (activeSession !== session) return;
    console.error('[Irodori] Playback or messaging failed:', error);
    stopActive();
    showStatus(button, '音声生成または再生に失敗しました。');
  }
}

function addButton(turn) {
  if (turn.querySelector('.irodori-action')) return;
  const body = messageBody(turn);
  if (!body) return;
  const action = document.createElement('div');
  action.className = 'irodori-action';
  action.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px;';
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'padding:5px 9px;border:0;border-radius:6px;background:#10a37f;color:white;cursor:pointer;font-weight:600;';
  setButton(button, false);
  const status = document.createElement('span');
  status.className = 'irodori-status';
  status.setAttribute('role', 'status');
  action.append(button, status);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    readReply(button, turn);
  });
  if (body === turn) turn.appendChild(action);
  else body.insertAdjacentElement('afterend', action);
}

function scan() {
  scanScheduled = false;
  for (const turn of assistantTurns()) addButton(turn);
}

const observer = new MutationObserver(() => {
  if (activeSession && !activeSession.button.isConnected) stopActive();
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(scan);
});
observer.observe(document.body, { childList: true, subtree: true });
scan();
