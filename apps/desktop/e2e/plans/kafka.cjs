// Kafka in the WebSocket editor: switch the protocol to Kafka, read the demo broker's clinic.events from the beginning,
// connect, see its three events with keys and partition@offset, produce one with a key and read it back.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  // a button, not a tab with the same label (the Produce tab and the Produce button)
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label && b.getAttribute('role') !== 'tab');
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const rows = () => vis('main .monaco-list-row, main button').filter((b) => /clinic\\.events|appointments/.test(b.textContent) && /p0@/.test(b.textContent));
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'switch-to-kafka',
    `await __t.newTab('WebSocket'); await __t.sleep(500);
     button('Kafka')?.click(); await __t.sleep(400);
     const url = vis('main input[aria-label="Kafka brokers"]')[0];
     if (!url) return 'NO BROKERS FIELD';
     setInput(url, 'kafka://127.0.0.1:4017'); await __t.sleep(200);
     vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Topics'))?.click(); await __t.sleep(400);
     const topic = vis('main input[aria-label="Topic to read"]')[0];
     setInput(topic, 'clinic.events'); await __t.sleep(100);
     button('Add')?.click(); await __t.sleep(300);
     return 'reads: ' + vis('main [data-kafka-read]').map((r) => r.getAttribute('data-kafka-read')).join(',');`,
  ),
  step(
    'connect-and-read-from-the-beginning',
    `button('Connect')?.click();
     await __t.waitFor(() => rows().length >= 3, 15000);
     const r = rows().map((b) => b.textContent);
     return 'events: ' + r.length + ' | first: ' + (/clinic\\.events · p0@0/.test(r[0] ?? '') && /key pet-1/.test(r[0] ?? ''));`,
  ),
  step(
    'produce-and-read-back',
    `vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Topics'))?.click(); await __t.sleep(300);
     setInput(vis('main input[aria-label="Topic to read"]')[0], 'appointments');
     button('Read')?.click(); await __t.sleep(2500);
     vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Produce'))?.click(); await __t.sleep(300);
     setInput(vis('main input[aria-label="Topic"]')[0], 'appointments');
     setInput(vis('main input[aria-label="Key"]')[0], 'pet-9');
     await __t.sleep(200);
     button('Produce')?.click();
     const back = await __t.waitFor(() => vis('main button').find((b) => /appointments · p0@/.test(b.textContent) && /key pet-9/.test(b.textContent) && b.querySelector('.text-ok, svg')), 10000);
     button('Disconnect')?.click(); await __t.sleep(500);
     return 'read back: ' + !!back;`,
  ),
];

module.exports = withExpect(steps, {
  'switch-to-kafka': /^reads: clinic\.events$/,
  'connect-and-read-from-the-beginning': /^events: [3-9]\d* \| first: true$/,
  'produce-and-read-back': /^read back: true$/,
});
