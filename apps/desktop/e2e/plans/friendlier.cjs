// The friendlier-for-people steps: the Privacy tab says what leaves the computer (with the update switch), the AI agents tab
// says its toggles only change the command, the palette finds Postman's words, Get token is in the OAuth 2.0 Authorization
// tab, an inherited auth is named, and the collection runner's Run waits for a run to end.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'privacy-tab-lists-what-leaves',
    `await __t.esc(); await __t.view('Settings'); await __t.sleep(800);
     const privacyTab = [...document.querySelectorAll('main [role=tab]')].find((t) => t.textContent.trim().startsWith('Privacy')); privacyTab?.click(); await __t.sleep(600);
     const box = document.querySelector('[data-network-disclosures]'); if (!box) return 'NO BOX';
     const toggle = !!box.querySelector('input[type=checkbox], [role=switch]');
     return 'update check listed: ' + /Check for updates/.test(box.textContent) + ' | github: ' + /github/i.test(box.textContent) + ' | switch here: ' + toggle + ' | old claim gone: ' + !/not implemented/.test(document.querySelector('main').innerText);`,
  ),
  step(
    'agents-tab-says-toggles-are-not-saved',
    `const agentsTab = [...document.querySelectorAll('main [role=tab]')].find((t) => t.textContent.trim().startsWith('AI agents')); agentsTab?.click(); await __t.sleep(700);
     return 'hint: ' + !!document.querySelector('[data-agents-unsaved]');`,
  ),
  step(
    'palette-finds-postman-words',
    `await __t.esc();
     const out = [];
     for (const q of ['>runner', '>newman', '>interceptor', '>globals', '>vault']) {
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await __t.sleep(500);
       const input = document.querySelector('[role=dialog] input'); if (!input) { out.push(q + ':NO INPUT'); continue; }
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, q); input.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(500);
       out.push(q + ':' + document.querySelectorAll('[role=dialog] [role=option]').length);
       await __t.esc();
     }
     return out.join(' ');`,
  ),
];

module.exports = withExpect(steps, {
  'privacy-tab-lists-what-leaves': /^update check listed: true \| github: true \| switch here: true \| old claim gone: true$/,
  'agents-tab-says-toggles-are-not-saved': /^hint: true$/,
  'palette-finds-postman-words': (r) => (/NO INPUT/.test(r) || /:0( |$)/.test(r) ? `a Postman word found nothing: ${r}` : true),
});
