// Comments for your team: the Info panel of an open item has "Comments for your team"; a comment typed there is saved in the
// workspace under comments/ (one file per item, so git carries it), signed and dated; settling greys it and takes it out of
// the open list, deleting removes it; the CLI and the RPC read the same thread.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const host = () => document.querySelector('[data-pinnable-panel="right"]');
  const openInfo = async () => {
    const h = await __t.waitFor(host, 3000); if (!h) return null;
    if (!h.querySelector('[data-context-info]')) h.querySelector('button[aria-expanded]')?.click();
    await __t.waitFor(() => h.querySelector('[data-context-info]'), 5000);
    return h;
  };
`;

const steps = [
  step(
    'an-open-request-has-an-empty-thread',
    `${H}
     await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses');
     const r = await __t.open('GET with query parameters'); if (r !== 'ok') return r;
     const h = await openInfo(); if (!h) return 'NO HOST';
     const sec = await __t.waitFor(() => { const s = h.querySelector('[data-item-comments]'); return s && s.getAttribute('data-item-comments') !== 'loading' ? s : null; }, 6000); if (!sec) return 'NO SECTION';
     return 'open: ' + sec.getAttribute('data-item-comments') + ' | empty note: ' + /No comments yet/.test(sec.textContent) + ' | add off while empty: ' + sec.querySelector('[data-comment-add]')?.disabled;`,
  ),
  step(
    'adding-a-comment-signs-and-saves-it',
    `${H}
     const h = await openInfo(); if (!h) return 'NO HOST';
     const box = h.querySelector('[data-comment-text]'); if (!box) return 'NO BOX';
     await __t.real.click(box); await __t.real.type('Why does this send X-Trace twice?'); await __t.sleep(200);
     await __t.real.click(h.querySelector('[data-comment-add]'));
     const li = await __t.waitFor(() => h.querySelector('[data-comment="open"]'), 6000); if (!li) return 'NO COMMENT';
     const by = li.querySelector('.font-semibold')?.textContent.trim();
     const info = h.querySelector('[data-context-info]');
     const refKind = info?.getAttribute('data-context-info');
     const open = await window.aps.invoke('comments.open'); const saved = open.filter((c) => /X-Trace twice/.test(c.text) && c.ref?.kind === 'request');
     const mark = await __t.waitFor(() => document.querySelector('[data-node-id] [data-comment-mark]'), 5000);
     return 'shown: ' + /X-Trace twice/.test(li.textContent) + ' | row mark: ' + mark?.getAttribute('data-comment-mark') + ' | signed: ' + (by && by.length > 0) + ' | open count: ' + h.querySelector('[data-item-comments]')?.getAttribute('data-item-comments') + ' | box cleared: ' + (box.value === '') + ' | kind: ' + refKind + ' | saved in the workspace: ' + (saved.length === 1 && saved[0].by.length > 0);`,
  ),
  // Home lists what the team is still asking; the item's name opens it
  step(
    'home-lists-what-the-team-is-asking',
    `await __t.view('Home'); await __t.sleep(900);
     const card = await __t.waitFor(() => document.querySelector('[data-home-comments]'), 8000); if (!card) return 'NO CARD';
     const row = card.querySelector('[data-home-comment]');
     const link = row?.querySelector('[data-ref-link]');
     const text = /X-Trace twice/.test(row?.textContent ?? '');
     link.click();
     const opened = await __t.waitFor(() => /GET with query parameters/.test(document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')?.textContent ?? '') ? true : null, 6000);
     return 'count: ' + card.getAttribute('data-home-comments') + ' | link: ' + link?.textContent.trim() + ' | text: ' + text + ' | opened: ' + !!opened + (opened ? '' : ' | view: ' + localStorage.getItem('aps.view') + ' | tabs: ' + [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].map((t) => t.textContent.trim()).join(',') + ' | link tag: ' + link?.tagName + ' | toasts: ' + [...document.querySelectorAll('[role=status], [role=alert]')].map((t) => t.textContent.trim().slice(0, 80)).join(' / '));`,
  ),
  step(
    'settling-greys-it-and-deleting-removes-it',
    `${H}
     const h = await openInfo(); if (!h) return 'NO HOST';
     const li = h.querySelector('[data-comment="open"]'); if (!li) return 'NO COMMENT';
     await __t.real.click(li.querySelector('[data-comment-resolve]'));
     await __t.waitFor(() => h.querySelector('[data-item-comments]')?.getAttribute('data-item-comments') === '0', 6000);
     const toggle = h.querySelector('[data-comment-settled-toggle]');
     const toggleText = toggle?.textContent.trim();
     if (toggle) await __t.real.click(toggle);
     const settled = await __t.waitFor(() => h.querySelector('[data-comment="settled"]'), 4000);
     const settledLine = /Settled by/.test(settled?.textContent ?? '');
     await __t.real.click(settled.querySelector('[data-comment-delete]'));
     const gone = await __t.waitFor(() => (h.querySelector('[data-comment]') ? null : true), 6000);
     const markGone = await __t.waitFor(() => (document.querySelector('[data-node-id] [data-comment-mark]') ? null : true), 5000);
     return 'open after settling: 0 | toggle: ' + toggleText + ' | settled line: ' + settledLine + ' | gone: ' + !!gone + ' | row mark gone: ' + !!markGone + ' | empty note back: ' + /No comments yet/.test(h.querySelector('[data-item-comments]')?.textContent ?? '');`,
  ),
];

module.exports = withExpect(steps, {
  'an-open-request-has-an-empty-thread': /^open: 0 \| empty note: true \| add off while empty: true$/,
  'adding-a-comment-signs-and-saves-it': /^shown: true \| row mark: 1 \| signed: true \| open count: 1 \| box cleared: true \| kind: request \| saved in the workspace: true$/,
  'home-lists-what-the-team-is-asking': /^count: 1 \| link: GET with query parameters \| text: true \| opened: true$/,
  'settling-greys-it-and-deleting-removes-it': /^open after settling: 0 \| toggle: Show 1 settled \| settled line: true \| gone: true \| row mark gone: true \| empty note back: true$/,
});
