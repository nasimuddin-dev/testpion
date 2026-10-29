// The shared AI foundations in the window: an AI button's "What will be sent…" (the exact payload, the privacy level,
// sections, masks, token estimate), Send from it opening the assistant, a cap refusing a call with Set up AI, the AI
// settings (models per task, Local only, limits) and the AI usage view counting the calls. Offline demo model only.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepWith } = require('../lib.cjs');

const step = stepWith({});
const panel = `document.querySelector('aside[aria-label="AI assistant"]')`;
const dialog = `document.querySelector('[data-ai-preview]')`;

const steps = [
  step(
    'error-has-ai-action',
    `await __t.requests();
     await __t.newTab('HTTP request');
     const url = vis('main input[aria-label="Request URL"]')[0]; if (!url) return 'NO INPUT url';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, 'http://127.0.0.1:1/orders?access_token=abcdef123456&page=2');
     url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     button('Send')?.click();
     const alert = await __t.waitFor(() => vis('main [role=alert]')[0], 15000); if (!alert) return 'NO ERROR PANEL';
     const ai = alert.querySelector('[data-ai-action]');
     return 'action: ' + short(ai?.textContent, 40) + ' | preview button: ' + !!alert.querySelector('[data-ai-preview-open]');`,
  ),
  step(
    'what-will-be-sent',
    `const alert = vis('main [role=alert]')[0];
     await __t.real.click(alert.querySelector('[data-ai-preview-open]'));
     const d = await __t.waitFor(() => ${dialog}?.querySelector('[data-ai-estimate]') && ${dialog}, 10000); if (!d) return 'NO DIALOG';
     const user = [...d.querySelectorAll('details')].find((x) => /^user/.test(x.querySelector('summary')?.textContent ?? ''))?.textContent ?? '';
     return 'model: ' + short(d.querySelector('[data-ai-model]')?.textContent, 80)
       + ' | sections: ' + [...d.querySelectorAll('tbody td.mono')].map((t) => t.textContent).join(',')
       + ' | masked: ' + short(d.querySelector('[data-ai-masked]')?.textContent, 60)
       + ' | token in payload: ' + user.includes('abcdef123456') + ' | page kept: ' + user.includes('page=2');`,
  ),
  step(
    'privacy-level',
    `const d = ${dialog}; if (!d) return 'NO DIALOG';
     const before = short(d.querySelector('[data-ai-estimate]')?.textContent, 40);
     [...d.querySelectorAll('[role=radio]')].find((r) => r.textContent.trim() === 'Names only')?.click();
     await __t.waitFor(() => ${dialog}?.querySelector('[role=radio][aria-checked=true]')?.textContent.trim() === 'Names only' && ${dialog}.querySelector('[data-ai-estimate]') && ${dialog}.querySelector('[data-ai-estimate]').textContent.slice(0, 40) !== before, 8000);
     const user = [...${dialog}.querySelectorAll('details')].find((x) => /^user/.test(x.querySelector('summary')?.textContent ?? ''))?.textContent ?? '';
     return 'checked: ' + ${dialog}.querySelector('[role=radio][aria-checked=true]')?.textContent.trim() + ' | host in payload: ' + user.includes('127.0.0.1:1');`,
  ),
  step(
    'send-opens-assistant',
    `${dialog}.closest('[role=dialog]').querySelector('[data-ai-send]').click();
     const p = await __t.waitFor(() => ${panel}?.querySelector('[data-turn=assistant] [data-answer-model]') && ${panel}, 15000); if (!p) return 'NO ANSWER';
     const text = short(p.querySelector('[data-turn=assistant] .markdown')?.innerText, 400);
     p.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(400);
     return 'answered by: ' + short(p.querySelector('[data-answer-model]')?.textContent, 40) + ' | names only: ' + !text.includes('127.0.0.1:1');`,
  ),
  step(
    'cap-refuses',
    `const s = await window.aps.invoke('settings.get');
     await window.aps.invoke('settings.save', { ...s, ai: { ...(s.ai ?? {}), maxTokensPerCall: 50 } });
     const alert = vis('main [role=alert]')[0]; alert.querySelector('[data-ai-action]').click();
     const setup = await __t.waitFor(() => ${panel}?.querySelector('[data-ai-setup]'), 10000);
     const text = short(setup?.textContent, 400);
     await window.aps.invoke('settings.save', s);
     ${panel}?.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(300);
     return text || 'NO REFUSAL';`,
  ),
  step(
    'settings-panel',
    `await __t.view('Settings');
     [...document.querySelectorAll('main [role=tab]')].find((t) => t.textContent.trim() === 'AI assistant')?.click(); await __t.sleep(600);
     const p = vis('[data-ai-settings]')[0]; if (!p) return 'NO PANEL';
     return short(p.innerText, 1500);`,
  ),
  step(
    'usage-view',
    `await __t.view('AI Lab'); await __t.sleep(600);
     tab('Models and keys')?.click(); await __t.sleep(500);
     [...document.querySelectorAll('[data-models-and-keys] [role=radio]')].find((x) => x.textContent.trim() === 'Usage')?.click();
     const u = await __t.waitFor(() => vis('[data-ai-feature-usage]')[0]?.querySelector('table') && vis('[data-ai-feature-usage]')[0], 8000); if (!u) return 'NO USAGE: ' + short(vis('main')[0]?.innerText, 200);
     return short(u.innerText, 300);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'error-has-ai-action': /^action: Explain with AI assistant \| preview button: true$/,
    // the token in the query string is masked; the rest of the URL is kept
    'what-will-be-sent': /^model: Offline demo model · demo.*stays on this computer.* \| sections: error.* \| masked: Masked \d+: .*query-credential.* \| token in payload: false \| page kept: true$/,
    'privacy-level': /^checked: Names only \| host in payload: false$/,
    'send-opens-assistant': /^answered by: Offline demo model · demo \| names only: true$/,
    'cap-refuses': /^Over an AI limit.*over the cap of 50 per call\. Nothing was sent\..*Change the limits$/,
    'settings-panel': /Models per task.*Small tasks.*Large tasks.*Local only.*What is sent by default.*Limits.*Tokens per call/s,
    'usage-view': /AI features.*Calls today.*[1-9].*explain-error.*App/s,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' } },
);
