const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function text(value) {
  return { nodeType: 3, nodeValue: value };
}

function element(tagName, children = [], options = {}) {
  return {
    nodeType: 1,
    tagName,
    childNodes: children,
    hidden: options.hidden,
    matches(selector) {
      if (options.selector && selector.includes(options.selector)) return true;
      return ['PRE', 'BUTTON'].includes(tagName) && selector.includes(tagName.toLowerCase());
    }
  };
}

test('extracts headings and list text while excluding code, controls, and hidden text', () => {
  const context = vm.createContext({
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    document: { body: {}, querySelectorAll: () => [] },
    location: { pathname: '/' },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame() {},
    getComputedStyle: node => ({
      display: node.hidden ? 'none' : 'block',
      visibility: 'visible'
    })
  });
  vm.runInContext(source, context);
  context.fixture = element('DIV', [
    element('H2', [text('見出し')]),
    element('P', [text('本文です。')]),
    element('PRE', [text('SECRET_CODE')]),
    element('UL', [element('LI', [text('項目A')]), element('LI', [text('項目B')])]),
    element('BUTTON', [text('コピー')]),
    element('DIV', [text('隠しテキスト')], { hidden: true })
  ]);
  const result = vm.runInContext('extractReplyText(fixture)', context);
  assert.match(result, /見出し/);
  assert.match(result, /本文です。/);
  assert.match(result, /項目A/);
  assert.match(result, /項目B/);
  assert.doesNotMatch(result, /SECRET_CODE|コピー|隠しテキスト/);
});

test('keeps readable labels and sections, removing URLs and Markdown syntax', () => {
  const context = vm.createContext({
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    document: { body: {}, querySelectorAll: () => [] },
    location: { pathname: '/' },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  });
  vm.runInContext(source, context);
  context.fixture = element('DIV', [
    element('H2', [text('## Server設定')]),
    element('P', [text('**重要**: '), element('A', [text('公式サイト')]), text('を参照。')]),
    element('P', [text('https://example.com/path?id=123。')]),
    element('UL', [element('LI', [text('- Apple')]), element('LI', [text('- Banana')])]),
    element('SPAN', [text('Sources 1')], { selector: '[data-testid*="citation"]' }),
    element('P', [text('`Irodori-TTS` と [OpenAI公式サイト](https://openai.com/)')])
  ]);
  const result = vm.runInContext('sanitizeForSpeech(extractReplyText(fixture))', context);
  assert.match(result, /Server設定/);
  assert.match(result, /重要: 公式サイトを参照。/);
  assert.match(result, /Apple\nBanana/);
  assert.match(result, /Irodori-TTS と OpenAI公式サイト/);
  assert.doesNotMatch(result, /https?:|example\.com|Sources|\*\*|^##|^- /m);
});

function playbackFixture({ newDom = false } = {}) {
  const audioInstances = [];
  const revokedUrls = [];
  const requests = [];
  const cancellations = [];
  const ports = [];
  let streamManually = false;
  let speechRate = 1;
  let storageListener;
  let deferNext = false;
  let pendingResponse;
  let ttsError = null;
  let autoRead = false;
  let voiceId = 'shiori';
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const rafCallbacks = [];
  let mutationCallback;
  let popstateCallback;
  let submitCallback;
  let clickCallback;
  let keydownCallback;
  let submittedUserKey = null;
  let submittedUserElement = null;
  let submissionSequence = 0;
  let stopButton = null;
  const location = { pathname: '/c/conversation-A' };

  function selectorMatches(node, selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (!value) return false;
      if (value.startsWith('.')) return node.className?.split(/\s+/).includes(value.slice(1));
      const tag = value.match(/^[a-z0-9]+/i)?.[0];
      if (tag && node.tagName !== tag.toUpperCase()) return false;
      const attr = value.match(/\[([^\]=~^$*]+)(\$=|\^=|\*=|=)?(?:"([^"]*)")?\]/);
      if (attr) {
        const actual = node.getAttribute(attr[1]);
        if (actual == null) return false;
        if (!attr[2]) return true;
        if (attr[2] === '=') return actual === attr[3];
        if (attr[2] === '$=') return actual.endsWith(attr[3]);
        if (attr[2] === '^=') return actual.startsWith(attr[3]);
        if (attr[2] === '*=') return actual.includes(attr[3]);
      }
      return !!tag;
    });
  }

  function descendants(node) {
    const result = [];
    for (const child of node.childNodes || []) {
      if (child.nodeType !== 1 || child.isConnected === false) continue;
      result.push(child, ...descendants(child));
    }
    return result;
  }

  function domElement(tagName, children = [], initialAttributes = {}) {
    const attributeValues = new Map(Object.entries(initialAttributes));
    attributeValues.add = name => attributeValues.set(name, '');
    const node = {
      nodeType: 1, tagName, childNodes: children, className: '',
      style: {}, hidden: false, isConnected: true, textContent: '',
      listeners: {}, parentElement: null, attributes: attributeValues,
      matches(selector) {
        return selectorMatches(this, selector);
      },
      querySelector(selector) {
        return descendants(this).find(child => child.matches(selector)) || null;
      },
      querySelectorAll(selector) { return descendants(this).filter(child => child.matches(selector)); },
      hasAttribute(name) { return this.attributes.has(name); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      closest(selector) {
        for (let current = this; current; current = current.parentElement) {
          if (current.matches?.(selector)) return current;
        }
        return null;
      },
      contains(candidate) {
        return candidate === this || descendants(this).includes(candidate);
      },
      compareDocumentPosition(candidate) {
        const ordered = roots.filter(root => root.isConnected)
          .flatMap(root => [root, ...descendants(root)]);
        const before = ordered.indexOf(this);
        const after = ordered.indexOf(candidate);
        return before >= 0 && after > before ? 4 : 0;
      },
      append(...items) {
        for (const item of items) {
          item.parentElement = this;
          this.childNodes.push(item);
        }
      },
      appendChild(item) { this.append(item); },
      insertAdjacentElement(_position, item) {
        if (!this.parentElement) return this.append(item);
        item.parentElement = this.parentElement;
        const index = this.parentElement.childNodes.indexOf(this);
        this.parentElement.childNodes.splice(index + 1, 0, item);
      },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name, value = '') { this.attributes.set(name, String(value)); },
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    };
    for (const child of children) child.parentElement = node;
    return node;
  }

  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.currentTime = 0;
      this.paused = true;
      this.playbackRate = 1;
      this.preservesPitch = false;
      this.playCalls = 0;
      this.loadCalls = 0;
      audioInstances.push(this);
    }
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {
      this.loadCalls++;
      this.currentTime = 0;
    }
  }

  function makeAssistant(id, value, turnKey = 'shared-turn-' + id) {
    if (!newDom) {
      const turn = domElement('DIV', [text(value)], {
        'data-message-author-role': 'assistant', 'data-message-id': id
      });
      turn.id = id;
      turn.textContent = value;
      return turn;
    }
    const body = domElement('DIV', [text(value)], {
      'data-markdown-text-style': 'assistant-message'
    });
    body.textContent = value;
    const turn = domElement('DIV', [body], {
      'data-content-search-unit-key': 'fallback-' + id + ':2:assistant',
      'data-chatgpt-selection-message-id': id,
      'data-turn-key': turnKey
    });
    turn.textContent = value;
    return turn;
  }
  const turnA = makeAssistant('reply-A', '回答A');
  const turnB = makeAssistant('reply-B', '回答B');
  const turns = [turnA, turnB];
  const userBubble = domElement('DIV', [text('ユーザー質問')], {
    'data-user-message-bubble': 'true'
  });
  const userUnit = domElement('DIV', [userBubble], {
    'data-content-search-unit-key': 'fallback-turn-2:0:user',
    'data-turn-key': 'shared-turn-reply-A'
  });
  const enterTarget = domElement('DIV');
  const composerEditable = domElement('DIV', [enterTarget], { contenteditable: 'true' });
  const sendButton = domElement('BUTTON', [], {
    type: 'submit', 'aria-label': '送信'
  });
  const composerForm = domElement('FORM', [composerEditable, sendButton]);
  const roots = newDom ? [userUnit, ...turns] : turns;
  const infoLogs = [];
  const context = vm.createContext({
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
    document: {
      body: {},
      querySelectorAll: selector => roots.filter(root => root.isConnected)
        .flatMap(root => [root, ...descendants(root)])
        .filter(node => node.matches(selector)),
      querySelector: selector => selector.includes('Stop generating') ||
        selector.includes('生成を中止する') || selector.includes('stop-button') ?
          stopButton : roots.filter(root => root.isConnected)
            .flatMap(root => [root, ...descendants(root)])
            .find(node => node.matches(selector)) || null,
      createElement: tag => domElement(tag.toUpperCase())
    },
    location,
    window: {
      addEventListener(type, callback) {
        if (type === 'popstate') popstateCallback = callback;
        if (type === 'submit') submitCallback = callback;
        if (type === 'click') clickCallback = callback;
        if (type === 'keydown') keydownCallback = callback;
      }
    },
    MutationObserver: class { constructor(callback) { mutationCallback = callback; } observe() {} },
    requestAnimationFrame(callback) { rafCallbacks.push(callback); },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { due: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Audio: FakeAudio, Blob, Uint8Array, atob, performance,
    URL: {
      createObjectURL: () => 'blob:test-' + (audioInstances.length + 1),
      revokeObjectURL: url => revokedUrls.push(url)
    },
    chrome: {
      storage: {
        local: { async get() { return { speechRate, autoRead, voiceId }; } },
        onChanged: { addListener(callback) { storageListener = callback; } }
      },
      runtime: {
        lastError: null,
        connect() {
          let listener;
          let disconnectListener;
          let disconnected = false;
          let complete = false;
          let requestId;
          const port = {
            emit(type, extra = {}) {
              if (type === 'stream-done' || type === 'stream-error') complete = true;
              if (!disconnected) listener({ type, requestId, ...extra });
            },
            onMessage: { addListener(callback) { listener = callback; } },
            onDisconnect: { addListener(callback) { disconnectListener = callback; } },
            postMessage(message) {
              requestId = message.requestId;
              requests.push({ ...message, payload: message.text });
              const respond = () => {
                port.emit('stream-start');
                if (ttsError) port.emit('stream-error', { error: ttsError });
                else {
                  port.emit('audio-chunk', { index: 0, mediaType: 'audio/wav',
                    audioBase64: 'AQID' });
                  port.emit('stream-done', { chunks: 1 });
                }
              };
              if (deferNext) {
                deferNext = false;
                pendingResponse = respond;
              } else if (!streamManually) respond();
            },
            disconnect() {
              if (disconnected) return;
              disconnected = true;
              if (!complete) cancellations.push({ action: 'cancel' });
              disconnectListener();
            }
          };
          ports.push(port);
          return port;
        }
      }
    },
    console: { error() {}, info(...parts) { infoLogs.push(parts.join(' ')); } }
  });
  vm.runInContext(source, context);
  context.turnA = turnA;
  context.turnB = turnB;
  const state = turn => {
    context.currentTurn = turn;
    return vm.runInContext('audioStates.get(currentTurn)', context);
  };
  const primary = turn => {
    context.currentTurn = turn;
    return vm.runInContext('onPrimary(audioStates.get(currentTurn))', context);
  };
  const pause = turn => {
    context.currentTurn = turn;
    return vm.runInContext('onPause(audioStates.get(currentTurn))', context);
  };
  const regenerate = turn => {
    context.currentTurn = turn;
    return vm.runInContext('regenerateReply(audioStates.get(currentTurn))', context);
  };
  return {
    context, turnA, turnB, userUnit, userBubble, audioInstances, revokedUrls,
    requests, cancellations, ports, infoLogs,
    state, primary, pause, regenerate,
    async flush() {
      for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve));
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        now = due[1].due;
        timers.delete(due[0]);
        due[1].callback();
        await this.flush();
      }
      now = end;
    },
    setAuto(enabled) {
      autoRead = enabled;
      storageListener({ autoRead: { newValue: enabled } }, 'local');
    },
    setVoice(value) { voiceId = value; },
    setTtsError(value) { ttsError = value; },
    signalSubmission(kind, options = {}) {
      if (kind === 'enter') {
        keydownCallback({
          key: 'Enter', target: enterTarget, shiftKey: !!options.shiftKey,
          isComposing: !!options.isComposing, keyCode: options.keyCode || 13,
          repeat: false
        });
      } else if (kind === 'click') {
        clickCallback({ target: options.button || sendButton });
      } else if (kind === 'submit') {
        submitCallback({ target: composerForm,
          submitter: Object.hasOwn(options, 'submitter') ? options.submitter : sendButton });
      }
    },
    confirmSubmittedUser() {
      submittedUserKey = 'submitted-turn-' + ++submissionSequence;
      const user = newDom ? domElement('DIV', [
        domElement('DIV', [text('新しい質問')], { 'data-user-message-bubble': 'true' })
      ], { 'data-turn-key': submittedUserKey }) : domElement('DIV', [text('新しい質問')], {
        'data-message-author-role': 'user', 'data-message-id': submittedUserKey
      });
      submittedUserElement = user;
      roots.push(user);
      vm.runInContext('scan()', context);
      return user;
    },
    mountHistoricalUser(key) {
      const user = newDom ? domElement('DIV', [
        domElement('DIV', [text('過去の質問')], { 'data-user-message-bubble': 'true' })
      ], { 'data-turn-key': key }) : domElement('DIV', [text('過去の質問')], {
        'data-message-author-role': 'user', 'data-message-id': key
      });
      roots.unshift(user);
      vm.runInContext('scan()', context);
      return user;
    },
    submitPrompt() {
      this.signalSubmission('submit');
      return this.confirmSubmittedUser();
    },
    sendButton,
    composerForm,
    domElement,
    submitNewChatPrompt() { return this.submitPrompt(); },
    cancelChatGeneration() {
      clickCallback({ target: { closest: () => ({}) } });
    },
    setRoute(pathname, { popstate = false } = {}) {
      location.pathname = pathname;
      if (popstate) {
        popstateCallback();
        while (rafCallbacks.length) rafCallbacks.shift()();
      } else {
        vm.runInContext('scan()', context);
      }
    },
    setRouteWithoutScan(pathname) { location.pathname = pathname; },
    removeReply(turn) {
      turn.isConnected = false;
      vm.runInContext('scan()', context);
    },
    setStopButton(hidden = false) {
      stopButton = domElement('BUTTON');
      stopButton.hidden = hidden;
    },
    clearStopButton() {
      stopButton = null;
      mutationCallback([{ type: 'childList', target: {} }]);
      while (rafCallbacks.length) rafCallbacks.shift()();
    },
    addReply(id, value, { streaming = true, turnKey, mountBeforeUser = false } = {}) {
      const turn = makeAssistant(id, value, turnKey || submittedUserKey || undefined);
      if (streaming) turn.attributes.add('data-message-streaming');
      turns.push(turn);
      if (newDom) {
        if (mountBeforeUser && submittedUserElement && roots.includes(submittedUserElement)) {
          roots.splice(roots.indexOf(submittedUserElement), 0, turn);
        } else roots.push(turn);
      }
      vm.runInContext('scan()', context);
      return turn;
    },
    addLiveReply(id, value, options) {
      this.submitPrompt();
      return this.addReply(id, value, options);
    },
    mutation(turn, attributeName) {
      mutationCallback([{ type: 'attributes', target: turn, attributeName }]);
      while (rafCallbacks.length) rafCallbacks.shift()();
    },
    complete(turn) {
      turn.attributes.delete('data-message-streaming');
      turn.attributes.add('data-message-complete');
      this.mutation(turn, 'data-message-complete');
    },
    updateReplyText(turn, value) {
      const body = newDom ? turn.querySelector('[data-markdown-text-style="assistant-message"]') : turn;
      body.childNodes[0].nodeValue = value;
      body.textContent = value;
      turn.textContent = value;
      mutationCallback([{ type: 'characterData', target: body.childNodes[0] }]);
      while (rafCallbacks.length) rafCallbacks.shift()();
    },
    setRate(rate) {
      speechRate = rate;
      storageListener({ speechRate: { newValue: rate } }, 'local');
    },
    deferNext() { deferNext = true; },
    manualStream() { streamManually = true; },
    resolvePending() {
      pendingResponse();
      pendingResponse = null;
    }
  };
}

test('new DOM A-E: detects assistant units once, excludes users, and uses assistant message IDs', () => {
  const fixture = playbackFixture({ newDom: true });
  const duplicateBody = fixture.context.document.createElement('DIV');
  duplicateBody.setAttribute('data-markdown-text-style', 'assistant-message');
  duplicateBody.textContent = '追加Markdown root';
  fixture.turnA.appendChild(duplicateBody);
  vm.runInContext('scan()', fixture.context);
  fixture.context.currentTurn = fixture.turnA;
  assert.equal(vm.runInContext('assistantTurns().length', fixture.context), 2);
  assert.equal(fixture.turnA.querySelectorAll('.irodori-action').length, 1);
  assert.equal(fixture.turnB.querySelectorAll('.irodori-action').length, 1);
  assert.equal(fixture.userUnit.querySelectorAll('.irodori-action').length, 0);
  assert.equal(vm.runInContext('turnId(currentTurn)', fixture.context), 'reply-A');
  assert.notEqual(vm.runInContext('turnId(currentTurn)', fixture.context),
    'shared-turn-reply-A');
  fixture.mutation(fixture.turnA, 'childList');
  assert.equal(fixture.turnA.querySelectorAll('.irodori-action').length, 1);
});

test('search message ID fallback accepts whitespace and commas while selection ID wins', () => {
  const fixture = playbackFixture({ newDom: true });
  const { context, turnA } = fixture;
  for (const [value, expected] of [
    ['UUID1 UUID2', 'UUID2'],
    ['UUID1,UUID2', 'UUID2'],
    ['["UUID1","UUID2","",null]', 'UUID2']
  ]) {
    context.idValue = value;
    assert.equal(vm.runInContext('assistantMessageId(idValue)', context), expected);
  }
  context.currentTurn = turnA;
  turnA.setAttribute('data-chatgpt-search-message-ids', 'UUID1 UUID2');
  assert.equal(vm.runInContext('turnId(currentTurn)', context), 'reply-A');
  turnA.attributes.delete('data-chatgpt-selection-message-id');
  assert.equal(vm.runInContext('turnId(currentTurn)', context), 'UUID2');
});

test('new DOM F: manual reading extracts only the assistant Markdown body', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, '回答A');
  assert.equal(fixture.state(fixture.turnA).status, 'playing');
  const body = fixture.turnA.querySelector('[data-markdown-text-style="assistant-message"]');
  assert.equal(body.querySelector('.irodori-action'), null,
    'the action must remain outside the speech body');
});

test('new DOM G: a newly inserted assistant unit is auto read after stability', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  const fresh = fixture.addLiveReply('new-dom-auto', '新DOMの新規回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, '新DOMの新規回答');
  assert.equal(fixture.state(fresh).status, 'playing');
});

test('new DOM H-I: hydration baselines history and later reads only a fresh assistant unit', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/new-dom-history');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  const historical = fixture.addReply('new-dom-history-1', '過去の新DOM回答', {
    streaming: false
  });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(historical).autoEligible, false);
  const fresh = fixture.addLiveReply('new-dom-fresh', '履歴画面での新規回答', {
    streaming: false
  });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(fresh).status, 'playing');
});

test('new DOM J: SSE cache, pause, resume, Stop, and regeneration remain available', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.primary(fixture.turnA);
  const firstAudio = fixture.state(fixture.turnA).audio;
  firstAudio.currentTime = 7;
  await fixture.pause(fixture.turnA);
  assert.equal(fixture.state(fixture.turnA).status, 'paused');
  await fixture.pause(fixture.turnA);
  assert.equal(firstAudio.currentTime, 7);
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.state(fixture.turnA).status, 'ready');
  assert.equal(fixture.state(fixture.turnA).audioChunks.length, 1);
  await fixture.regenerate(fixture.turnA);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.revokedUrls.length, 1);
});

test('legacy DOM K: legacy semantic assistant selectors still receive one action', () => {
  const fixture = playbackFixture();
  assert.equal(fixture.turnA.querySelectorAll('.irodori-action').length, 1);
  assert.equal(fixture.turnB.querySelectorAll('.irodori-action').length, 1);
  fixture.context.currentTurn = fixture.turnA;
  assert.equal(vm.runInContext('turnId(currentTurn)', fixture.context), 'reply-A');
});

test('completed audio replays from the start at every selected speed without POST', async () => {
  const fixture = playbackFixture();
  const { turnA } = fixture;
  await fixture.primary(turnA);
  const audio = fixture.state(turnA).audio;
  assert.equal(fixture.requests.length, 1);
  assert.equal(audio.playbackRate, 1);
  assert.equal(audio.preservesPitch, true);
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5]) {
    fixture.setRate(rate);
    assert.equal(audio.playbackRate, rate);
    audio.currentTime = 42;
    audio.onended();
    assert.equal(fixture.state(turnA).status, 'ready');
    assert.equal(fixture.state(turnA).button.textContent, '▶ 再生');
    assert.equal(fixture.state(turnA).regenerateButton.hidden, false);
    await fixture.primary(turnA);
    assert.equal(audio.currentTime, 0);
    assert.equal(audio.playbackRate, rate);
    assert.equal(fixture.requests.length, 1);
  }
  assert.equal(fixture.revokedUrls.length, 0);
  assert.equal(audio.playCalls, 8);
  assert.equal(fixture.requests.length, 1);
});

test('pause resumes at the same position and Stop keeps generated audio', async () => {
  const fixture = playbackFixture();
  const { turnA } = fixture;
  await fixture.primary(turnA);
  const audio = fixture.state(turnA).audio;
  audio.currentTime = 18;
  await fixture.pause(turnA);
  assert.equal(fixture.state(turnA).status, 'paused');
  assert.equal(audio.currentTime, 18);
  assert.equal(audio.paused, true);
  await fixture.pause(turnA);
  assert.equal(audio.currentTime, 18);
  assert.equal(audio.playCalls, 2);
  assert.equal(fixture.requests.length, 1);
  await fixture.primary(turnA);
  assert.equal(fixture.state(turnA).status, 'ready');
  assert.equal(audio.currentTime, 0);
  assert.equal(fixture.state(turnA).audioChunks[0].audio, audio);
  assert.equal(fixture.revokedUrls.length, 0);
  await fixture.primary(turnA);
  assert.equal(fixture.state(turnA).audio, audio);
  assert.equal(fixture.requests.length, 1);
});

test('switching answers keeps both caches; only regeneration or DOM removal releases one', async () => {
  const fixture = playbackFixture();
  const { turnA, turnB } = fixture;
  await fixture.primary(turnA);
  const firstA = fixture.state(turnA).audio;
  firstA.currentTime = 10;
  await fixture.primary(turnB);
  const firstB = fixture.state(turnB).audio;
  assert.equal(fixture.state(turnA).status, 'ready');
  assert.equal(firstA.currentTime, 0);
  assert.equal(fixture.state(turnA).audioChunks[0].audio, firstA);
  await fixture.primary(turnA);
  assert.equal(fixture.state(turnB).status, 'ready');
  assert.equal(fixture.state(turnB).audioChunks[0].audio, firstB);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.revokedUrls.length, 0);
  await fixture.primary(turnA);
  await fixture.regenerate(turnA);
  assert.equal(fixture.requests.length, 3);
  assert.notEqual(fixture.state(turnA).audio, firstA);
  assert.equal(firstA.loadCalls, 1);
  assert.equal(fixture.revokedUrls.length, 1);
  assert.equal(fixture.state(turnB).audioChunks[0].audio, firstB);
  turnA.isConnected = false;
  vm.runInContext('scan()', fixture.context);
  assert.equal(fixture.state(turnA), undefined);
  assert.equal(fixture.revokedUrls.length, 2);
  assert.equal(fixture.state(turnB).audioChunks[0].audio, firstB);
});

test('replacing the action UI keeps the answer audio cache', async () => {
  const fixture = playbackFixture();
  await fixture.primary(fixture.turnA);
  const state = fixture.state(fixture.turnA);
  const audio = state.audio;
  audio.onended();
  const oldButton = state.button;
  fixture.turnA.childNodes = fixture.turnA.childNodes.filter(
    child => child.className !== 'irodori-action'
  );
  oldButton.isConnected = false;
  vm.runInContext('scan()', fixture.context);
  assert.equal(fixture.state(fixture.turnA), state);
  assert.equal(state.audioChunks[0].audio, audio);
  assert.notEqual(state.button, oldButton);
  assert.equal(state.button.textContent, '▶ 再生');
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.revokedUrls.length, 0);
});

test('Stop during generation cancels the request and ignores its late response', async () => {
  const fixture = playbackFixture();
  fixture.deferNext();
  const pending = fixture.primary(fixture.turnA);
  assert.equal(fixture.state(fixture.turnA).status, 'generating');
  assert.equal(fixture.state(fixture.turnA).button.textContent, '■ Stop');
  assert.equal(fixture.state(fixture.turnA).pauseButton.hidden, true);
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.cancellations.length, 1);
  assert.equal(fixture.state(fixture.turnA).status, 'idle');
  fixture.resolvePending();
  await pending;
  assert.equal(fixture.state(fixture.turnA).audio, null);
  assert.equal(fixture.audioInstances.length, 0);
});

test('chunk zero plays before done; pause keeps receiving, resume keeps position and next chunk rate', async () => {
  const fixture = playbackFixture();
  fixture.manualStream();
  const pending = fixture.primary(fixture.turnA);
  const port = fixture.ports[0];
  port.emit('audio-chunk', { index: 0, mediaType: 'audio/wav', audioBase64: 'AQID' });
  await fixture.flush();
  const first = fixture.state(fixture.turnA).audio;
  assert.equal(fixture.state(fixture.turnA).generationStatus, 'streaming');
  assert.equal(fixture.state(fixture.turnA).status, 'playing');
  assert.equal(first.playCalls, 1);
  first.currentTime = 12;
  await fixture.pause(fixture.turnA);
  port.emit('audio-chunk', { index: 1, mediaType: 'audio/wav', audioBase64: 'BAUG' });
  const second = fixture.state(fixture.turnA).audioChunks[1].audio;
  assert.equal(second.playCalls, 0);
  assert.equal(fixture.state(fixture.turnA).audioChunks.length, 2);
  fixture.setRate(1.5);
  assert.equal(first.playbackRate, 1.5);
  await fixture.pause(fixture.turnA);
  assert.equal(first.currentTime, 12);
  assert.equal(first.playCalls, 2);
  first.onended();
  await fixture.flush();
  assert.equal(second.playCalls, 1);
  assert.equal(second.playbackRate, 1.5);
  port.emit('stream-done', { chunks: 2 });
  await pending;
  second.onended();
  await fixture.flush();
  assert.equal(fixture.state(fixture.turnA).status, 'ready');
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.requests.length, 1);
  assert.equal(first.playCalls, 3);
});

test('missing next chunk buffers, resumes on arrival, and an unfinished Stop removes every chunk', async () => {
  const fixture = playbackFixture();
  fixture.manualStream();
  const pending = fixture.primary(fixture.turnA);
  const port = fixture.ports[0];
  port.emit('audio-chunk', { index: 0, mediaType: 'audio/wav', audioBase64: 'AQID' });
  await fixture.flush();
  fixture.state(fixture.turnA).audio.onended();
  assert.equal(fixture.state(fixture.turnA).status, 'buffering');
  port.emit('audio-chunk', { index: 1, mediaType: 'audio/wav', audioBase64: 'BAUG' });
  await fixture.flush();
  assert.equal(fixture.state(fixture.turnA).status, 'playing');
  assert.equal(fixture.state(fixture.turnA).metrics.bufferUnderruns, 1);
  assert.equal(fixture.state(fixture.turnA).audioChunks[1].audio.playCalls, 1);
  await fixture.primary(fixture.turnA);
  await pending;
  assert.equal(fixture.state(fixture.turnA).status, 'idle');
  assert.equal(fixture.state(fixture.turnA).audioChunks.length, 0);
  assert.equal(fixture.revokedUrls.length, 2);
  assert.equal(fixture.cancellations.length, 1);
  const nextRequest = fixture.primary(fixture.turnA);
  assert.equal(fixture.requests.length, 2, 'partial audio needs a fresh generation');
  await fixture.primary(fixture.turnA);
  await nextRequest;
});

test('out-of-order arrival still plays chunks in index order', async () => {
  const fixture = playbackFixture();
  fixture.manualStream();
  const pending = fixture.primary(fixture.turnA);
  const port = fixture.ports[0];
  port.emit('audio-chunk', { index: 1, mediaType: 'audio/wav', audioBase64: 'BAUG' });
  assert.equal(fixture.state(fixture.turnA).audioChunks[1].audio.playCalls, 0);
  port.emit('audio-chunk', { index: 0, mediaType: 'audio/wav', audioBase64: 'AQID' });
  await fixture.flush();
  assert.equal(fixture.state(fixture.turnA).audioChunks[0].audio.playCalls, 1);
  port.emit('stream-done', { chunks: 2 });
  await pending;
  fixture.state(fixture.turnA).audio.onended();
  await fixture.flush();
  assert.equal(fixture.state(fixture.turnA).audioChunks[1].audio.playCalls, 1);
});

test('a second auto answer waits for the first SSE request to finish', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.manualStream();
  const first = fixture.addLiveReply('first-stream', '最初の回答', { streaming: false });
  await fixture.advance(1500);
  const second = fixture.addLiveReply('second-stream', '次の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  fixture.ports[0].emit('audio-chunk', {
    index: 0, mediaType: 'audio/wav', audioBase64: 'AQID'
  });
  await fixture.flush();
  assert.equal(fixture.state(first).status, 'playing');
  assert.equal(fixture.requests.length, 1);
  fixture.ports[0].emit('stream-done', { chunks: 1 });
  await fixture.flush();
  assert.equal(fixture.requests.length, 2);
  fixture.ports[1].emit('audio-chunk', {
    index: 0, mediaType: 'audio/wav', audioBase64: 'BAUG'
  });
  fixture.ports[1].emit('stream-done', { chunks: 1 });
  await fixture.flush();
  assert.equal(fixture.state(second).status, 'ready');
  fixture.state(first).audio.onended();
  await fixture.flush();
  assert.equal(fixture.state(second).status, 'playing');
});

test('completed Stop keeps all chunks; regeneration revokes them and creates one new request', async () => {
  const fixture = playbackFixture();
  fixture.manualStream();
  const pending = fixture.primary(fixture.turnA);
  const port = fixture.ports[0];
  port.emit('audio-chunk', { index: 0, mediaType: 'audio/wav', audioBase64: 'AQID' });
  port.emit('audio-chunk', { index: 1, mediaType: 'audio/wav', audioBase64: 'BAUG' });
  port.emit('stream-done', { chunks: 2 });
  await pending;
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.state(fixture.turnA).status, 'ready');
  assert.equal(fixture.state(fixture.turnA).audioChunks.length, 2);
  assert.equal(fixture.revokedUrls.length, 0);
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.requests.length, 1);
  await fixture.primary(fixture.turnA);
  const regenerate = fixture.regenerate(fixture.turnA);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.revokedUrls.length, 2);
  fixture.ports[1].emit('audio-chunk', {
    index: 0, mediaType: 'audio/wav', audioBase64: 'BwgJ'
  });
  fixture.ports[1].emit('stream-done', { chunks: 1 });
  await regenerate;
  assert.equal(fixture.state(fixture.turnA).audioChunks.length, 1);
});

test('partial stream errors discard cache; manual answer switch and route change cancel old streams', async () => {
  const fixture = playbackFixture();
  fixture.manualStream();
  const first = fixture.primary(fixture.turnA);
  fixture.ports[0].emit('audio-chunk', {
    index: 0, mediaType: 'audio/wav', audioBase64: 'AQID'
  });
  fixture.ports[0].emit('stream-error', { error: 'GENERATION' });
  await first;
  assert.equal(fixture.state(fixture.turnA).status, 'error');
  assert.equal(fixture.revokedUrls.length, 1);
  const next = fixture.primary(fixture.turnA);
  fixture.ports[1].emit('audio-chunk', {
    index: 0, mediaType: 'audio/wav', audioBase64: 'AQID'
  });
  await fixture.flush();
  const other = fixture.primary(fixture.turnB);
  await next;
  assert.equal(fixture.state(fixture.turnA).audioChunks.length, 0);
  assert.equal(fixture.cancellations.length, 1);
  fixture.ports[2].emit('audio-chunk', {
    index: 0, mediaType: 'audio/wav', audioBase64: 'AQID'
  });
  fixture.setRoute('/c/conversation-B');
  await other;
  assert.equal(fixture.state(fixture.turnB).audioChunks.length, 0);
  assert.equal(fixture.cancellations.length, 2);
});

test('auto read waits for completion and stability, then sends exactly once', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const reply = fixture.addLiveReply('reply-C', '新しい回答');
  await fixture.advance(5000);
  assert.equal(fixture.requests.length, 0, 'streaming text must not be sent');
  fixture.complete(reply);
  await fixture.advance(1499);
  assert.equal(fixture.requests.length, 0);
  await fixture.advance(1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(reply).status, 'playing');
  assert.equal(fixture.state(reply).autoHandled, true);
  fixture.mutation(reply, 'data-message-complete');
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 1, 'DOM updates must not regenerate');
  assert.equal(fixture.state(fixture.turnA).status, 'idle', 'historical replies stay idle');
});

test('A: a new turn without generation attributes is spoken after 1500ms', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const reply = fixture.addLiveReply('fallback-A', '属性なしの新しい回答', { streaming: false });
  assert.equal(fixture.state(reply).autoEligible, true);
  await fixture.advance(1499);
  assert.equal(fixture.requests.length, 0);
  await fixture.advance(1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(reply).status, 'playing');
});

test('B: each text change resets the fallback stable timer', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const reply = fixture.addLiveReply('fallback-B', '最初の本文', { streaming: false });
  await fixture.advance(600);
  fixture.updateReplyText(reply, '途中の本文');
  await fixture.advance(900);
  assert.equal(fixture.requests.length, 0);
  fixture.updateReplyText(reply, '完成した本文');
  await fixture.advance(1499);
  assert.equal(fixture.requests.length, 0);
  await fixture.advance(1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].payload, '完成した本文');
});

test('C: historical turns without generation attributes remain baseline', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  const old = fixture.addReply('fallback-old', 'OFF中の回答', { streaming: false });
  fixture.setAuto(true);
  await fixture.advance(5000);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(old).autoEligible, false);
  assert.equal(fixture.state(fixture.turnA).autoEligible, false);
});

test('D: later mutations on a fallback turn do not regenerate it', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const reply = fixture.addLiveReply('fallback-D', '一度だけ読む', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  fixture.updateReplyText(reply, '後から変わった表示');
  fixture.mutation(reply, 'data-message-complete');
  await fixture.advance(5000);
  assert.equal(fixture.requests.length, 1);
});

test('a visible Stop generating control delays fallback, but a hidden one does not', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setStopButton();
  const reply = fixture.addLiveReply('fallback-stop', 'UI確認', { streaming: false });
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  fixture.clearStopButton();
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);

  const second = fixture.addLiveReply('fallback-hidden', '非表示UI確認', { streaming: false });
  fixture.setStopButton(true);
  vm.runInContext('scan()', fixture.context);
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.state(second).status, 'ready');
});

test('auto read OFF and OFF to ON leave historical replies untouched', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  const old = fixture.addReply('reply-old', 'OFF中の回答');
  fixture.complete(old);
  await fixture.advance(2000);
  assert.equal(fixture.requests.length, 0);
  fixture.setAuto(true);
  await fixture.advance(2000);
  assert.equal(fixture.requests.length, 0);
  const fresh = fixture.addLiveReply('reply-fresh', 'ON後の回答');
  fixture.complete(fresh);
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(fresh).status, 'playing');
});

test('auto queue synthesizes while playing, then plays in completion order', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const a = fixture.addLiveReply('new-A', '新しいA');
  fixture.complete(a);
  await fixture.advance(1500);
  const b = fixture.addLiveReply('new-B', '新しいB');
  fixture.complete(b);
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.state(a).status, 'playing');
  assert.equal(fixture.state(b).status, 'ready');
  fixture.state(a).audio.onended();
  await fixture.flush();
  assert.equal(fixture.state(b).status, 'playing');
  assert.equal(fixture.requests.length, 2);
  fixture.state(b).audio.onended();
  await fixture.primary(a);
  assert.equal(fixture.requests.length, 2, 'auto audio remains cached for replay');
});

test('auto completion reuses an existing manual cache and applies playback speed', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRate(1.5);
  const reply = fixture.addLiveReply('new-cached', '手動生成済み');
  await fixture.primary(reply);
  const audio = fixture.state(reply).audio;
  await fixture.primary(reply);
  assert.equal(fixture.state(reply).status, 'ready');
  fixture.complete(reply);
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(reply).audio, audio);
  assert.equal(fixture.state(reply).status, 'playing');
  assert.equal(audio.playbackRate, 1.5);
});

test('pause blocks the queue, and Stop advances without replaying the stopped reply', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const a = fixture.addLiveReply('new-A', '新しいA');
  fixture.complete(a);
  await fixture.advance(1500);
  const b = fixture.addLiveReply('new-B', '新しいB');
  fixture.complete(b);
  await fixture.advance(1500);
  await fixture.pause(a);
  assert.equal(fixture.state(a).status, 'paused');
  assert.equal(fixture.state(b).status, 'ready');
  await fixture.advance(2000);
  assert.equal(fixture.state(b).status, 'ready');
  await fixture.primary(a);
  await fixture.advance(150);
  assert.equal(fixture.state(a).status, 'ready');
  assert.equal(fixture.state(b).status, 'playing');
  assert.equal(fixture.requests.length, 2);
});

test('manual playback interrupts auto playback, and OFF drops pending queue', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const a = fixture.addLiveReply('new-A', '新しいA');
  fixture.complete(a);
  await fixture.advance(1500);
  const b = fixture.addLiveReply('new-B', '新しいB');
  fixture.complete(b);
  await fixture.advance(1500);
  await fixture.primary(fixture.turnA);
  assert.equal(fixture.state(a).status, 'ready');
  assert.equal(fixture.state(fixture.turnA).status, 'playing');
  fixture.setAuto(false);
  fixture.state(fixture.turnA).audio.onended();
  await fixture.flush();
  assert.equal(fixture.state(b).status, 'ready');
  assert.equal(fixture.requests.length, 3);
});

test('unset Voice and failed server requests are handled once without auto retry', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setVoice('');
  const noVoice = fixture.addLiveReply('new-no-voice', 'Voiceなし');
  fixture.complete(noVoice);
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(noVoice).status, 'idle');
  fixture.setVoice('shiori');
  fixture.setTtsError('CONNECTION');
  const offline = fixture.addLiveReply('new-offline', 'Serverなし');
  fixture.complete(offline);
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(offline).status, 'error');
  assert.equal(fixture.state(offline).statusElement.textContent, '');
  fixture.mutation(offline, 'data-message-complete');
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 1);
});

test('navigation A: opening an old conversation baselines its assistant turns', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/conversation-B');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  const first = fixture.addReply('history-B-1', '過去回答1', { streaming: false });
  const second = fixture.addReply('history-B-2', '過去回答2', { streaming: false });
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(first).autoEligible, false);
  assert.equal(fixture.state(second).autoEligible, false);
});

test('navigation B: delayed historical turns stay baseline until hydration settles', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/conversation-B');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  const turns = [];
  turns.push(fixture.addReply('history-1', '過去回答1', { streaming: false }));
  await fixture.advance(300);
  turns.push(fixture.addReply('history-2', '過去回答2', { streaming: false }));
  await fixture.advance(300);
  turns.push(fixture.addReply('history-3', '過去回答3', { streaming: false }));
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  for (const turn of turns) assert.equal(fixture.state(turn).autoEligible, false);
});

test('navigation C: a new reply in a hydrated old conversation is auto read', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/conversation-B');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  fixture.addReply('history-B', '過去回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 0);
  const fresh = fixture.addLiveReply('fresh-in-B', '新しい回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(fresh).status, 'playing');
});

test('navigation D: A to B to C to A never speaks loaded history', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  let previous = [fixture.turnA, fixture.turnB];
  for (const [route, id] of [
    ['/c/conversation-B', 'history-B'],
    ['/uc/conversation-C', 'history-C'],
    ['/c/conversation-A', 'history-A']
  ]) {
    fixture.setRoute(route);
    for (const turn of previous) fixture.removeReply(turn);
    previous = [fixture.addReply(id, '保存済み回答', { streaming: false })];
    await fixture.advance(1800);
    assert.equal(fixture.requests.length, 0);
  }
});

test('navigation E: assigning a URL to the first new-chat reply preserves it', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  const first = fixture.addLiveReply('first-new-chat', '最初の新規回答', { streaming: false });
  assert.equal(fixture.state(first).autoEligible, true);
  fixture.setRoute('/uc/new-conversation');
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(first).status, 'playing');
});

test('navigation E: a submitted new chat keeps its first reply when URL changes first', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  fixture.submitNewChatPrompt();
  fixture.setRoute('/uc/assigned-before-reply');
  const first = fixture.addReply('first-after-route', '属性なしの最初の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(first).status, 'playing');
});

test('navigation F: browser back and forward baseline loaded replies', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  let previous = [fixture.turnA, fixture.turnB];
  for (const [route, id] of [
    ['/c/conversation-B', 'back-forward-B'],
    ['/c/conversation-A', 'back-forward-A'],
    ['/c/conversation-B', 'back-forward-B-again']
  ]) {
    fixture.setRoute(route, { popstate: true });
    for (const turn of previous) fixture.removeReply(turn);
    previous = [fixture.addReply(id, '履歴からの回答', { streaming: false })];
    await fixture.advance(1800);
    assert.equal(fixture.requests.length, 0);
  }
});

test('navigation cancels queued synthesis and stops old-conversation playback', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.deferNext();
  const generating = fixture.addLiveReply('before-navigation', '生成中の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  fixture.setRoute('/c/conversation-B');
  assert.equal(fixture.cancellations.length, 1);
  fixture.resolvePending();
  await fixture.flush();
  assert.equal(fixture.state(generating).audio, null);
  fixture.removeReply(generating);
  await fixture.advance(1500);

  const fresh = fixture.addLiveReply('new-in-B', 'Bで新しい回答', { streaming: false });
  await fixture.advance(1500);
  const audio = fixture.state(fresh).audio;
  assert.equal(fixture.state(fresh).status, 'playing');
  fixture.setRoute('/c/conversation-C');
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0);
  assert.equal(fixture.state(fresh).status, 'idle');
});

test('a route change before DOM mutation cancels the pending auto timer', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  fixture.addReply('pending-before-route', '移動前の回答', { streaming: false });
  fixture.setRouteWithoutScan('/c/conversation-B');
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 0);
});

test('v0.4.2 A-C: virtualized history after hydration stays silent and gets one manual action', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/long-history');
  await fixture.advance(1500);
  const old = [1, 2, 3].map(index => fixture.addReply(
    'virtual-' + index, '過去回答' + index, { streaming: false }
  ));
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  for (const turn of old) {
    assert.equal(fixture.state(turn).autoEligible, false);
    assert.equal(turn.querySelectorAll('.irodori-action').length, 1);
    fixture.mutation(turn, 'childList');
    assert.equal(turn.querySelectorAll('.irodori-action').length, 1);
  }
});

test('v0.4.2 B-D: repeated virtual mounts and same-ID remount never create TTS', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/long-history');
  await fixture.advance(1500);
  const batches = [];
  for (const count of [1, 2, 5]) {
    for (let index = 0; index < count; index++) {
      batches.push(fixture.addReply('virtual-batch-' + batches.length,
        '古い回答', { streaming: false }));
    }
    await fixture.advance(1800);
    assert.equal(fixture.requests.length, 0);
  }
  fixture.removeReply(batches[0]);
  const remounted = fixture.addReply('virtual-batch-0', '古い回答', { streaming: false });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(remounted).autoEligible, false);
  assert.equal(remounted.querySelectorAll('.irodori-action').length, 1);
});

test('v0.4.2 E-G: scroll history, submit, match only fresh shared turn, then close gate', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/long-history');
  await fixture.advance(1500);
  const old = fixture.addReply('virtual-before-submit', '古い回答', { streaming: false });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 0);
  fixture.submitPrompt();
  const scrolledDuringGeneration = fixture.addReply('virtual-during-submit', 'さらに古い回答', {
    streaming: false, turnKey: 'historical-key', mountBeforeUser: true
  });
  const appendedHistory = fixture.addReply('virtual-appended-history', '別の古い回答', {
    streaming: false, turnKey: 'another-historical-key'
  });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(scrolledDuringGeneration).autoEligible, false);
  assert.equal(fixture.state(appendedHistory).autoEligible, false);
  const fresh = fixture.addReply('fresh-after-scroll', '新しい回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, '新しい回答');
  assert.equal(fixture.state(fresh).autoHandled, true);
  const later = fixture.addReply('virtual-after-complete', 'さらに過去の回答', {
    streaming: false, turnKey: 'older-key', mountBeforeUser: true
  });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(later).autoEligible, false);
  assert.equal(fixture.state(old).autoEligible, false);
});

test('v0.4.2 H-I: first new-chat reply and two consecutive submissions are each spoken once', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/');
  fixture.submitPrompt();
  fixture.setRoute('/c/assigned-first-chat');
  const first = fixture.addReply('fresh-first', '最初の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(first).autoHandled, true);
  const second = fixture.addLiveReply('fresh-second', '二回目の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.state(second).autoHandled, true);
  assert.deepEqual(fixture.requests.map(request => request.text), ['最初の回答', '二回目の回答']);
});

test('v0.4.2 J-K: historical manual playback works and legacy live order remains supported', async () => {
  const modern = playbackFixture({ newDom: true });
  await modern.flush();
  modern.setAuto(true);
  const old = modern.addReply('manual-history', '手動で読む過去回答', { streaming: false });
  await modern.advance(1800);
  assert.equal(modern.requests.length, 0);
  await modern.primary(old);
  assert.equal(modern.requests.length, 1);
  assert.equal(modern.state(old).status, 'playing');

  const legacy = playbackFixture();
  await legacy.flush();
  legacy.setAuto(true);
  legacy.submitPrompt();
  const fresh = legacy.addReply('legacy-live', '旧DOMの新しい回答', { streaming: false });
  await legacy.advance(1500);
  assert.equal(legacy.requests.length, 1);
  assert.equal(legacy.state(fresh).autoHandled, true);
});

test('v0.4.2: cancelling ChatGPT generation closes the live gate', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.submitPrompt();
  const answer = fixture.addReply('cancelled-reply', '途中の回答');
  fixture.cancelChatGeneration();
  fixture.complete(answer);
  await fixture.advance(2000);
  assert.equal(fixture.requests.length, 0);
});

test('v0.4.3 A: Project base route assignment preserves the first live answer', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/g/project-base');
  fixture.removeReply(fixture.turnA);
  fixture.removeReply(fixture.turnB);
  await fixture.advance(1500);
  fixture.submitPrompt();
  fixture.setRoute('/g/project-base/c/new-id');
  const fresh = fixture.addReply('project-first', 'Projectの最初の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, 'Projectの最初の回答');
  assert.equal(fixture.state(fresh).autoHandled, true);
});

test('v0.4.3 B: changing Project conversations clears a pending live gate', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/g/project-base/c/old-id');
  await fixture.advance(1500);
  fixture.submitPrompt();
  fixture.setRoute('/g/project-base/c/history-id');
  assert.equal(vm.runInContext('liveGeneration', fixture.context), null);
  const old = fixture.addReply('project-history', '過去の回答', { streaming: false });
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(old).autoEligible, false);
});

test('v0.4.3: a different Project base is history navigation even after submit', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/g/project-A');
  await fixture.advance(1500);
  fixture.submitPrompt();
  fixture.setRoute('/g/project-B/c/conversation-id');
  assert.equal(vm.runInContext('liveGeneration', fixture.context), null);
  const old = fixture.addReply('other-project-history', '別Projectの過去回答', {
    streaming: false
  });
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(old).autoEligible, false);
});

test('v0.4.3 C: Project assignment keeps old virtual turns historical', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/g/project-base');
  await fixture.advance(1500);
  fixture.submitPrompt();
  fixture.setRoute('/g/project-base/c/new-id');
  const old = fixture.addReply('project-virtual-old', '仮想スクロールの古い回答', {
    streaming: false, turnKey: 'old-project-turn', mountBeforeUser: true
  });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(old).autoEligible, false);
  const fresh = fixture.addReply('project-actual-new', '新規回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, '新規回答');
  assert.equal(fixture.state(fresh).autoHandled, true);
});

test('v0.4.3 D-E: top-level c and uc assignments remain live', async () => {
  for (const route of ['/c/new-id', '/uc/new-id']) {
    const fixture = playbackFixture({ newDom: true });
    await fixture.flush();
    fixture.setAuto(true);
    fixture.setRoute('/');
    fixture.submitPrompt();
    fixture.setRoute(route);
    const fresh = fixture.addReply('first-' + route, '最初の回答', { streaming: false });
    await fixture.advance(1500);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.state(fresh).autoHandled, true);
  }
});

test('v0.4.4: Enter intent arms only after a new user bubble and reads the fresh reply', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.signalSubmission('enter');
  assert.notEqual(vm.runInContext('pendingSubmissionIntent', fixture.context), null);
  assert.equal(vm.runInContext('liveGeneration', fixture.context), null);
  fixture.mountHistoricalUser('historical-user');
  assert.equal(vm.runInContext('liveGeneration', fixture.context), null);
  const old = fixture.addReply('virtual-before-confirm', '古い回答', {
    streaming: false, turnKey: 'historical-turn'
  });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 0);
  fixture.confirmSubmittedUser();
  assert.notEqual(vm.runInContext('liveGeneration', fixture.context), null);
  const fresh = fixture.addReply('enter-fresh', 'Enter送信の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, 'Enter送信の回答');
  assert.equal(fixture.state(old).autoEligible, false);
  assert.equal(fixture.state(fresh).autoHandled, true);
});

test('v0.4.4: send button click works without native submit', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.signalSubmission('click');
  fixture.confirmSubmittedUser();
  const fresh = fixture.addReply('click-fresh', 'ボタン送信の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(fresh).autoHandled, true);
});

test('v0.4.4: Enter after scrolling history reads only the submitted answer', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.setRoute('/c/older-conversation');
  await fixture.advance(1500);
  const old = fixture.addReply('scrolled-history', '過去回答', { streaming: false });
  await fixture.advance(1800);
  assert.equal(fixture.requests.length, 0);
  fixture.signalSubmission('enter');
  fixture.confirmSubmittedUser();
  const fresh = fixture.addReply('fresh-after-scroll-enter', '今回の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].text, '今回の回答');
  assert.equal(fixture.state(old).autoEligible, false);
  assert.equal(fixture.state(fresh).autoHandled, true);
});

test('v0.4.4: first new-chat answer works for Enter and click plus submit', async () => {
  for (const method of ['enter', 'button']) {
    const fixture = playbackFixture({ newDom: true });
    await fixture.flush();
    fixture.setAuto(true);
    fixture.setRoute('/');
    fixture.signalSubmission(method === 'enter' ? 'enter' : 'click');
    if (method === 'button') fixture.signalSubmission('submit');
    assert.equal(vm.runInContext('liveGenerationSequence', fixture.context), 1);
    fixture.setRoute('/c/new-' + method);
    fixture.confirmSubmittedUser();
    const fresh = fixture.addReply('first-' + method, '最初の回答', { streaming: false });
    await fixture.advance(1500);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.state(fresh).autoHandled, true);
  }
});

test('v0.4.4: click and submit are one intent; submitter-free composer submit is accepted', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.signalSubmission('click');
  fixture.signalSubmission('submit');
  assert.equal(vm.runInContext('liveGenerationSequence', fixture.context), 1);
  assert.ok(fixture.infoLogs.some(line => line.includes('submission signal deduped')));
  fixture.confirmSubmittedUser();
  const fresh = fixture.addReply('one-cycle', '一回だけ', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);

  const fallback = playbackFixture({ newDom: true });
  await fallback.flush();
  fallback.setAuto(true);
  fallback.signalSubmission('submit', { submitter: null });
  assert.notEqual(vm.runInContext('pendingSubmissionIntent', fallback.context), null);

  const unlabeled = playbackFixture({ newDom: true });
  await unlabeled.flush();
  unlabeled.setAuto(true);
  const composerButton = unlabeled.domElement('BUTTON', [], { type: 'submit' });
  unlabeled.composerForm.append(composerButton);
  unlabeled.signalSubmission('click', { button: composerButton });
  assert.notEqual(vm.runInContext('pendingSubmissionIntent', unlabeled.context), null);

  const propertyOnly = playbackFixture({ newDom: true });
  await propertyOnly.flush();
  propertyOnly.setAuto(true);
  const implicitSubmit = propertyOnly.domElement('BUTTON', [], { 'aria-label': '送信' });
  implicitSubmit.type = 'submit';
  propertyOnly.composerForm.append(implicitSubmit);
  propertyOnly.signalSubmission('click', { button: implicitSubmit });
  assert.notEqual(vm.runInContext('pendingSubmissionIntent', propertyOnly.context), null);
});

test('v0.4.4: a late submit after user confirmation does not replace the live cycle', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.signalSubmission('click');
  fixture.confirmSubmittedUser();
  fixture.signalSubmission('submit');
  assert.equal(vm.runInContext('liveGenerationSequence', fixture.context), 1);
  assert.notEqual(vm.runInContext('liveGeneration', fixture.context), null);
  const fresh = fixture.addReply('late-submit', '新しい回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(fresh).autoHandled, true);
});

test('v0.4.4: Shift+Enter, IME Enter, and unrelated buttons do not create intent', async () => {
  const fixture = playbackFixture({ newDom: true });
  await fixture.flush();
  fixture.setAuto(true);
  fixture.signalSubmission('enter', { shiftKey: true });
  fixture.signalSubmission('enter', { isComposing: true });
  fixture.signalSubmission('enter', { keyCode: 229 });
  for (const label of ['コピー', '再試行', '添付']) {
    const button = fixture.domElement('BUTTON', [], { type: 'button', 'aria-label': label });
    fixture.signalSubmission('click', { button });
  }
  const unrelatedSubmit = fixture.domElement('BUTTON', [], {
    type: 'submit', 'aria-label': '再試行'
  });
  fixture.composerForm.append(unrelatedSubmit);
  fixture.signalSubmission('click', { button: unrelatedSubmit });
  fixture.signalSubmission('submit', { submitter: unrelatedSubmit });
  assert.equal(vm.runInContext('pendingSubmissionIntent', fixture.context), null);
  assert.equal(vm.runInContext('liveGeneration', fixture.context), null);
  assert.equal(vm.runInContext('liveGenerationSequence', fixture.context), 0);
});
