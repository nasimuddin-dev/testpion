// A request whose host is a variable without a value ({{baseurl}} where the environment has baseUrl, or nothing): it is
// not sent; the error names the variable, the one it likely meant, and offers to add it to the current environment
// (a new row, ready for its value), a guide to variables, and the assistant.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const ALERT = `vis('main [role=alert]').find((a) => /has no value/.test(a.textContent))`;

const steps = [
  step(
    'send-with-a-missing-host',
    `await __t.requests();
     const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500);
     vis('[role=menuitem]').find((x) => x.textContent.trim().startsWith('HTTP request'))?.click(); await __t.sleep(1200);
     const url = vis('main input[aria-label="Request URL"]')[0]; if (!url) return 'NO INPUT url';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, '{{baseurl}}/users'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     button('Send')?.click();
     const a = await __t.waitFor(() => ${ALERT}, 10000);
     const buttons = [...a.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
     await __t.sleep(500);
     const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).filter((t) => /Unresolved variables/.test(t)).length;
     return 'error: ' + short(a.querySelector('.font-semibold')?.textContent) + ' | buttons: ' + buttons.join(' / ') + ' | extra toasts: ' + toasts;`,
  ),
  step(
    'add-it-to-the-environment',
    `const add = [...(${ALERT})?.querySelectorAll('button') ?? []].find((b) => /^Add baseurl to |^Open the globals$/.test(b.textContent.trim()));
     if (!add) return 'NO BUTTON add';
     const label = add.textContent.trim(); add.click();
     const row = await __t.waitFor(() => vis('main input').find((i) => i.value === 'baseurl'), 8000).catch(() => undefined);
     return 'clicked: ' + label + ' | row for baseurl: ' + (row ? 'yes' : 'no');`,
  ),
];

module.exports = withExpect(steps, {
  'send-with-a-missing-host': /^error: \{\{baseurl\}\} has no value \| buttons: (Add baseurl to .+|Open the globals) \/ How variables work \/ Explain with AI assistant \| extra toasts: 0$/,
  'add-it-to-the-environment': /^clicked: (Add baseurl to .+ \| row for baseurl: yes|Open the globals \| row for baseurl: no)$/,
});
