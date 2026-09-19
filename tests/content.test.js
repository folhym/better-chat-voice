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
