// Optional real-Chrome DOM smoke test. Pass the DevTools port of a temporary
// Chrome launched with this unpacked extension and a chatgpt.com page.
const fs = require('node:fs');
const path = require('node:path');
const port = process.argv[2];
const screenshotPath = process.argv[3];
if (!port) throw new Error('Usage: node tests/chrome-dom-smoke.cjs <devtools-port>');

async function target() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    const page = targets.find(item => item.type === 'page' && item.url.startsWith('https://chatgpt.com/'));
    if (page) return page;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('ChatGPT page target was not found');
}

async function main() {
  const page = await target();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const isolatedContexts = [];
  const exceptions = [];
  let sequence = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated' &&
        message.params.context.auxData?.type === 'isolated') {
      isolatedContexts.push(message.params.context.name || '(unnamed)');
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text);
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error.message));
    else job.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await call('Runtime.evaluate', {
      expression: '({ readyState: document.readyState, url: location.href })',
      returnByValue: true
    });
    if (status.result.value.readyState === 'complete' &&
        status.result.value.url.startsWith('https://chatgpt.com/')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  const fixtureExpression = `(() => {
    document.body.innerHTML = '<main data-turn-key="turn-id">' +
      '<div data-content-search-unit-key="fallback-turn-2:0:user">' +
        '<div data-user-message-bubble="true">ユーザー質問</div></div>' +
      '<div data-content-search-unit-key="fallback-turn-2:2:assistant" ' +
        'data-chatgpt-selection-message-id="assistant-id">' +
        '<div data-markdown-text-style="assistant-message"><p>回答本文</p></div></div>' +
      '</main>';
  })()`;
  await call('Runtime.evaluate', { expression: fixtureExpression });
  await new Promise(resolve => setTimeout(resolve, 750));
  const resultExpression = `(() => {
    const assistant = document.querySelector('[data-content-search-unit-key$=":assistant"]');
    const user = document.querySelector('[data-content-search-unit-key$=":user"]');
    const body = document.querySelector('[data-markdown-text-style="assistant-message"]');
    return {
      assistantActions: assistant.querySelectorAll('.irodori-action').length,
      userActions: user.querySelectorAll('.irodori-action').length,
      actionInsideBody: body.querySelectorAll('.irodori-action').length,
      actionText: assistant.querySelector('.irodori-action')?.textContent || ''
    };
  })()`;
  let result = await call('Runtime.evaluate', { expression: resultExpression, returnByValue: true });
  let mode = 'extension-content-script';
  if (result.result.value.assistantActions === 0 && isolatedContexts.length === 0) {
    // Headless Chrome can stop at an anti-bot interstitial where extension content
    // scripts are not injected. Exercise the exact source in the real DOM engine.
    const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
    await call('Runtime.evaluate', { expression: `(() => {${contentSource}\n})()` });
    await new Promise(resolve => setTimeout(resolve, 750));
    result = await call('Runtime.evaluate', { expression: resultExpression, returnByValue: true });
    mode = 'direct-source-fallback';
  }
  const value = result.result.value;
  if (screenshotPath) {
    await call('Page.enable');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  }
  socket.close();
  console.log(JSON.stringify({ ...value, mode, isolatedContexts, exceptions }));
  if (value.assistantActions !== 1 || value.userActions !== 0 ||
      value.actionInsideBody !== 0 || !value.actionText.includes('Irodori')) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
