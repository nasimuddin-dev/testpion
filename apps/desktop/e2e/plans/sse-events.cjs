// A server-sent event stream's Events tab: the list and the selected event are split by a divider that is dragged
// like every other split (and remembered); an event's JSON data shows as a tree.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const DETAIL = `document.querySelector('main [data-sse-event]')`;
const height = (el) => `Math.round(${el}?.getBoundingClientRect().height ?? 0)`;

const steps = [
  step(
    'stream-and-pick-an-event',
    `await __t.requests();
     const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500);
     vis('[role=menuitem]').find((x) => x.textContent.trim().startsWith('HTTP request'))?.click(); await __t.sleep(1200);
     const url = vis('main input[aria-label="Request URL"]')[0];
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, 'http://127.0.0.1:4010/events?count=5'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     button('Send')?.click();
     // the stream sends five events and ends; the finished response keeps them
     await __t.waitFor(() => vis('main button').filter((b) => b.textContent.includes('tick')).length >= 5 && !button('Stop'), 20000);
     await __t.sleep(1000);
     const row = vis('main button').filter((b) => b.textContent.includes('tick')).pop();
     row.click(); await __t.sleep(500);
     const d = ${DETAIL};
     return 'detail: ' + !!d + ' | tree: ' + /"n"/.test(d?.textContent ?? '') + ' | height: ' + ${height(DETAIL)};`,
  ),
  step(
    'drag-the-divider',
    `const d = ${DETAIL}; const before = ${height(DETAIL)};
     const sep = d.parentElement.previousElementSibling; // the Split's separator sits between the two panes
     if (sep?.getAttribute('role') !== 'separator') return 'NO SEPARATOR';
     const r = sep.getBoundingClientRect(); const x = r.left + r.width / 2;
     sep.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: r.top, pointerType: 'mouse' }));
     window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: r.top - 150, pointerType: 'mouse' }));
     window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: r.top - 150, pointerType: 'mouse' }));
     await __t.sleep(300);
     const after = ${height(DETAIL)};
     return 'taller by: ' + (after - before > 100 ? 'over 100 px' : after - before + ' px') + ' | remembered: ' + !!localStorage.getItem('aps.split.sse-events');`,
  ),
  step(
    'a-pick-made-while-streaming-stays',
    `button('Send')?.click();
     // 30 events, one every 200 ms: pick the first while the stream runs, then wait for its end
     const url = vis('main input[aria-label="Request URL"]')[0];
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, 'http://127.0.0.1:4010/events?count=30'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     button('Send')?.click();
     const first = await __t.waitFor(() => button('Stop') && vis('main button').find((b) => b.textContent.includes('tick')), 10000);
     first.click(); await __t.sleep(300);
     const during = !!${DETAIL};
     await __t.waitFor(() => !button('Stop'), 20000); await __t.sleep(800);
     return 'while streaming: ' + during + ' | after it ended: ' + !!${DETAIL};`,
  ),
];

module.exports = withExpect(steps, {
  'stream-and-pick-an-event': /^detail: true \| tree: true \| height: [1-9]\d+$/,
  'drag-the-divider': /^taller by: over 100 px \| remembered: true$/,
  'a-pick-made-while-streaming-stays': /^while streaming: true \| after it ended: true$/,
});
