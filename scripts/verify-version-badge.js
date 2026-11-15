#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../public/js/common.js'), 'utf8');
const marker = '/* Live backend version badge */';
assert(source.includes(marker), 'missing live version badge');
const script = source.slice(source.indexOf(marker));
async function check(version, fails = false) {
  let element;
  const elements = new Map();
  const calls = [];
  const context = {
    document: {
      readyState: 'complete',
      getElementById: (id) => elements.get(id),
      createElement: () => (element = { style: {}, setAttribute() {} }),
      body: { appendChild: (el) => elements.set(el.id, el) }
    },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fails) throw new Error('offline');
      return { ok: true, json: async () => ({ version }) };
    }
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert(element, 'badge not mounted');
  assert.strictEqual(element.textContent, fails ? 'الإصدار غير متاح' : `الإصدار v${version}`);
  assert.strictEqual(calls[0].url, '/api/health');
  assert.strictEqual(calls[0].options.cache, 'no-store');
  assert.strictEqual(element.style.position, 'fixed');
  assert.strictEqual(element.style.left, '12px');
}
(async () => {
  await check('2.4.0');
  await check('2.5.0');
  await check(null, true);
  console.log('LIVE_VERSION_BADGE_TESTS_PASSED');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
