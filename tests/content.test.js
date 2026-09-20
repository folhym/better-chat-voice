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

function playbackFixture() {
  const audioInstances = [];
  const revokedUrls = [];
  const requests = [];
  const cancellations = [];
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
  let stopButton = null;
  const location = { pathname: '/c/conversation-A' };

  function domElement(tagName, children = []) {
    return {
      nodeType: 1, tagName, childNodes: children, className: '',
      style: {}, hidden: false, isConnected: true, textContent: '',
      listeners: {}, parentElement: null, attributes: new Set(),
      matches(selector) {
        return selector.includes('.irodori-action') && this.className === 'irodori-action' ||
          tagName === 'BUTTON' && selector.includes('button');
      },
      querySelector(selector) {
        return selector === '.irodori-action' ?
          this.childNodes.find(child => child.className === 'irodori-action') || null : null;
      },
      hasAttribute(name) { return this.attributes.has(name); },
      getAttribute(name) { return name === 'data-message-id' ? this.id : null; },
      closest(selector) { return this.role === 'assistant' && selector.includes('assistant') ? this : null; },
      append(...items) {
        for (const item of items) {
          item.parentElement = this;
          this.childNodes.push(item);
        }
      },
      appendChild(item) { this.append(item); },
      insertAdjacentElement(_position, item) { this.append(item); },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name) { this.attributes.add(name); },
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    };
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

  const turnA = domElement('DIV', [text('回答A')]);
  const turnB = domElement('DIV', [text('回答B')]);
  turnA.id = 'reply-A';
  turnB.id = 'reply-B';
  turnA.role = turnB.role = 'assistant';
  turnA.textContent = '回答A';
  turnB.textContent = '回答B';
  const turns = [turnA, turnB];
  const context = vm.createContext({
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    document: {
      body: {},
      querySelectorAll: () => turns.filter(turn => turn.isConnected),
      querySelector: () => stopButton,
      createElement: tag => domElement(tag.toUpperCase())
    },
    location,
    window: {
      addEventListener(type, callback) {
        if (type === 'popstate') popstateCallback = callback;
        if (type === 'submit') submitCallback = callback;
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
    Audio: FakeAudio, Blob, Uint8Array,
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
        sendMessage(message, callback) {
          if (message.action === 'tts') {
            requests.push(message);
            if (ttsError) {
              callback({ error: ttsError });
            } else if (deferNext) {
              deferNext = false;
              pendingResponse = callback;
            } else {
              callback({ audioBuffer: [1, 2, 3], mimeType: 'audio/mpeg' });
            }
          } else if (message.action === 'cancel') {
            cancellations.push(message);
            callback({ ok: true });
          }
        }
      }
    },
    console: { error() {}, info() {} }
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
    context, turnA, turnB, audioInstances, revokedUrls, requests, cancellations,
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
    submitNewChatPrompt() {
      submitCallback({ target: { querySelector: () => ({}) } });
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
    addReply(id, value, { streaming = true } = {}) {
      const turn = domElement('DIV', [text(value)]);
      turn.id = id;
      turn.role = 'assistant';
      turn.textContent = value;
      if (streaming) turn.attributes.add('data-message-streaming');
      turns.push(turn);
      vm.runInContext('scan()', context);
      return turn;
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
      turn.childNodes[0].nodeValue = value;
      turn.textContent = value;
      mutationCallback([{ type: 'characterData', target: turn.childNodes[0] }]);
      while (rafCallbacks.length) rafCallbacks.shift()();
    },
    setRate(rate) {
      speechRate = rate;
      storageListener({ speechRate: { newValue: rate } }, 'local');
    },
    deferNext() { deferNext = true; },
    resolvePending() {
      pendingResponse({ audioBuffer: [4, 5, 6], mimeType: 'audio/mpeg' });
      pendingResponse = null;
    }
  };
}

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
  assert.equal(fixture.state(turnA).audio, audio);
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
  assert.equal(fixture.state(turnA).audio, firstA);
  await fixture.primary(turnA);
  assert.equal(fixture.state(turnB).status, 'ready');
  assert.equal(fixture.state(turnB).audio, firstB);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.revokedUrls.length, 0);
  await fixture.primary(turnA);
  await fixture.regenerate(turnA);
  assert.equal(fixture.requests.length, 3);
  assert.notEqual(fixture.state(turnA).audio, firstA);
  assert.equal(firstA.loadCalls, 1);
  assert.equal(fixture.revokedUrls.length, 1);
  assert.equal(fixture.state(turnB).audio, firstB);
  turnA.isConnected = false;
  vm.runInContext('scan()', fixture.context);
  assert.equal(fixture.state(turnA), undefined);
  assert.equal(fixture.revokedUrls.length, 2);
  assert.equal(fixture.state(turnB).audio, firstB);
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
  assert.equal(state.audio, audio);
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

test('auto read waits for completion and stability, then sends exactly once', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const reply = fixture.addReply('reply-C', '新しい回答');
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
  const reply = fixture.addReply('fallback-A', '属性なしの新しい回答', { streaming: false });
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
  const reply = fixture.addReply('fallback-B', '最初の本文', { streaming: false });
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
  const reply = fixture.addReply('fallback-D', '一度だけ読む', { streaming: false });
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
  const reply = fixture.addReply('fallback-stop', 'UI確認', { streaming: false });
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  fixture.clearStopButton();
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);

  const second = fixture.addReply('fallback-hidden', '非表示UI確認', { streaming: false });
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
  const fresh = fixture.addReply('reply-fresh', 'ON後の回答');
  fixture.complete(fresh);
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state(fresh).status, 'playing');
});

test('auto queue synthesizes while playing, then plays in completion order', async () => {
  const fixture = playbackFixture();
  await fixture.flush();
  fixture.setAuto(true);
  const a = fixture.addReply('new-A', '新しいA');
  fixture.complete(a);
  await fixture.advance(1500);
  const b = fixture.addReply('new-B', '新しいB');
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
  const reply = fixture.addReply('new-cached', '手動生成済み');
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
  const a = fixture.addReply('new-A', '新しいA');
  fixture.complete(a);
  await fixture.advance(1500);
  const b = fixture.addReply('new-B', '新しいB');
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
  const a = fixture.addReply('new-A', '新しいA');
  fixture.complete(a);
  await fixture.advance(1500);
  const b = fixture.addReply('new-B', '新しいB');
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
  const noVoice = fixture.addReply('new-no-voice', 'Voiceなし');
  fixture.complete(noVoice);
  await fixture.advance(3000);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.state(noVoice).status, 'idle');
  fixture.setVoice('shiori');
  fixture.setTtsError('CONNECTION');
  const offline = fixture.addReply('new-offline', 'Serverなし');
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
  const fresh = fixture.addReply('fresh-in-B', '新しい回答', { streaming: false });
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
  const first = fixture.addReply('first-new-chat', '最初の新規回答', { streaming: false });
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
  const generating = fixture.addReply('before-navigation', '生成中の回答', { streaming: false });
  await fixture.advance(1500);
  assert.equal(fixture.requests.length, 1);
  fixture.setRoute('/c/conversation-B');
  assert.equal(fixture.cancellations.length, 1);
  fixture.resolvePending();
  await fixture.flush();
  assert.equal(fixture.state(generating).audio, null);
  fixture.removeReply(generating);
  await fixture.advance(1500);

  const fresh = fixture.addReply('new-in-B', 'Bで新しい回答', { streaming: false });
  await fixture.advance(1500);
  const audio = fixture.state(fresh).audio;
  assert.equal(fixture.state(fresh).status, 'playing');
  fixture.setRoute('/c/conversation-C');
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0);
  assert.equal(fixture.state(fresh).status, 'ready');
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
