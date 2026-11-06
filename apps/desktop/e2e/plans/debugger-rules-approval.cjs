// Debugger rules that change traffic and came with a pull (debugger/rules.json changed outside the app) wait for
// "Allow on this computer": the Rules tab says so; the rule is listed but does not act until allowed; after Allow it acts.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'a-pulled-redirect',
    `main:
      const { join } = require('node:path');
      const { mkdirSync, writeFileSync } = require('node:fs');
      const dir = join(home, 'ws', 'debugger');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'rules.json'), JSON.stringify({ active: 'Default', profiles: { Default: [{ id: 'e2e-redirect', name: 'Send elsewhere', enabled: true, kind: 'redirect', match: { host: 'api.example.test' }, redirect: { host: 'collector.example.test' } }] } }));
      return 'written';`,
    false,
  ],
  [
    'the-rules-tab-says-it-waits',
    `(async () => {
      // the rules file is read again a moment after it changed (a pull while the app runs)
      await __t.sleep(2500);
      const before = await window.aps.invoke('debug.rules');
      await __t.view('Debugger'); await __t.sleep(800);
      const tab = [...document.querySelectorAll('[role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Rules')); if (!tab) return 'NO RULES TAB';
      tab.click(); await __t.sleep(600);
      const callout = await __t.waitFor(() => [...document.querySelectorAll('[data-rules-need-approval]')].find((x) => x.offsetParent), 5000);
      const listed = [...document.querySelectorAll('main *')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Send elsewhere');
      return 'waits: ' + before.needsApproval + ' (' + before.waiting + ') | callout: ' + !!callout + ' | listed: ' + listed;
    })()`,
  ],
  [
    'allow-on-this-computer',
    `(async () => {
      const allow = [...document.querySelectorAll('[data-rules-need-approval] button')].find((b) => b.textContent.trim() === 'Allow on this computer'); if (!allow) return 'NO ALLOW';
      allow.click(); await __t.sleep(800);
      const after = await window.aps.invoke('debug.rules');
      const gone = ![...document.querySelectorAll('[data-rules-need-approval]')].some((x) => x.offsetParent);
      await window.aps.invoke('debug.deleteRule', { id: 'e2e-redirect' });
      return 'allowed: ' + !after.needsApproval + ' | callout gone: ' + gone;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'the-rules-tab-says-it-waits': /^waits: true \(1\) \| callout: true \| listed: true$/,
  'allow-on-this-computer': /^allowed: true \| callout gone: true$/,
});
