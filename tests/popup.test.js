const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

function setup({ voiceId = 'shiori', speechRate = 1, voices = [{ id: 'shiori' }], health = true,
  voiceError = false } = {}) {
  const data = { serverUrl: 'http://127.0.0.1:8088', voiceId, speechRate };
  const server = { voices, health, voiceError };
  const elements = {};
  for (const id of ['serverUrl', 'voiceSelect', 'speedSelect', 'status',
    'statusDetail', 'connect', 'reloadVoices']) {
    elements[id] = {
      value: '', textContent: '', dataset: {}, options: [], disabled: false, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren() { this.options = []; },
      add(option) { this.options.push(option); }
    };
  }
  elements.speedSelect.options = ['0.8', '0.9', '1', '1.1', '1.2']
    .map(value => ({ value }));
  const chrome = {
    storage: { local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(key => key in data).map(key => [key, data[key]]));
      },
      async set(values) { Object.assign(data, values); },
      async remove(key) { delete data[key]; }
    } },
    runtime: {
      lastError: null,
      sendMessage({ action }, callback) {
        if (action === 'checkConnection') callback(server.health ? { ok: true } : { error: 'CONNECTION' });
        if (action === 'listVoices') callback(server.voiceError ?
          { error: 'GENERATION' } : { voices: server.voices });
      }
    },
    permissions: { async request() { return true; } }
  };
  const context = vm.createContext({
    chrome, URL,
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    document: { querySelector(selector) { return elements[selector.slice(1)]; } },
    console: { error() {} }
  });
  vm.runInContext(source, context);
  return { data, server, elements, ready: new Promise(resolve => setImmediate(resolve)) };
}

test('reload keeps the selected embedding voice until it disappears', async () => {
  const fixture = setup({
    voiceId: 'embedding',
    voices: [{ id: 'embedding' }, { id: 'shiori' }],
    speechRate: 0.9
  });
  await fixture.ready;
  assert.equal(fixture.elements.status.textContent, '● 接続OK');
  assert.equal(fixture.elements.voiceSelect.value, 'embedding');
  assert.equal(fixture.elements.speedSelect.value, '0.9');
  fixture.server.voices = [{ id: 'shiori' }, { id: 'embedding' }];
  await fixture.elements.reloadVoices.listeners.click();
  assert.equal(fixture.elements.voiceSelect.value, 'embedding');
  fixture.server.voices = [{ id: 'shiori' }];
  await fixture.elements.reloadVoices.listeners.click();
  assert.equal(fixture.elements.voiceSelect.value, '');
  assert.equal(fixture.data.voiceId, undefined);
});

test('popup distinguishes disconnected, no voices, and voice API failure', async () => {
  const disconnected = setup({ health: false });
  await disconnected.ready;
  assert.equal(disconnected.elements.status.textContent, '● Server未接続');
  const empty = setup({ voices: [] });
  await empty.ready;
  assert.equal(empty.elements.status.textContent, '● 接続OK / Voiceなし');
  const failed = setup({ voiceError: true });
  await failed.ready;
  assert.equal(failed.elements.status.textContent, '● 接続OK / Voice取得失敗');
  assert.equal(failed.elements.voiceSelect.value, 'shiori');
  assert.equal(failed.data.voiceId, 'shiori');
});

test('speed selection is persisted', async () => {
  const fixture = setup();
  await fixture.ready;
  fixture.elements.speedSelect.value = '1.2';
  await fixture.elements.speedSelect.listeners.change();
  assert.equal(fixture.data.speechRate, 1.2);
});
