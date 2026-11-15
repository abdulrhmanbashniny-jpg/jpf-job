#!/usr/bin/env node
'use strict';
// Exercise the actual sidebar renderer with synthetic authenticated role contexts.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../public/js/common.js'), 'utf8');
const start = source.indexOf('function renderAdminSidebar(');
const end = source.indexOf('let _arrivalTimer', start);
assert(start >= 0 && end > start);
(async () => {
  for (const role of ['super_admin', 'hr_coordinator', 'committee_member']) {
    const aside = { innerHTML: '' };
    const context = {
      document: {
        getElementById: () => ({ replaceWith() {} }),
        createElement: () => aside
      },
      getCurrentUser: async () => ({ role, full_name: 'Synthetic', username: 'fixture' }),
      escapeHtml: (value) => String(value || ''),
      window: { dispatchEvent() {} },
      CustomEvent: class {},
      startLobbyArrivalPolling() {}
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + ';renderAdminSidebar("comparison");', context);
    await new Promise((resolve) => setImmediate(resolve));
    assert(aside.innerHTML.includes('href="Compare.dc.html"'), `${role}: missing comparison entry`);
    assert(!aside.innerHTML.includes('href="OfferLetter.dc.html"'), `${role}: candidate-less offer-studio link`);
    assert(aside.innerHTML.includes('Scheduler.dc.html'), `${role}: existing scheduler missing`);
  }
  console.log('VERIFY_V25_NAV_ROLES_PASSED');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
