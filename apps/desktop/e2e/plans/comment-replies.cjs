// Replies in a comment thread: a comment's Reply puts the box in reply mode ("Replying to …"), the answer is shown under
// the comment it answers; settling the comment settles its reply; deleting it deletes both.
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
    'reply-to-a-comment',
    `${H}
     await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses');
     const r = await __t.open('POST a JSON body'); if (r !== 'ok') return r;
     const h = await openInfo(); if (!h) return 'NO HOST';
     const sec = await __t.waitFor(() => { const x = h.querySelector('[data-item-comments]'); return x && x.getAttribute('data-item-comments') !== 'loading' ? x : null; }, 6000); if (!sec) return 'NO SECTION';
     const box = await __t.waitFor(() => h.querySelector('[data-comment-text]'), 6000); if (!box) return 'NO BOX';
     await __t.real.click(box); await __t.real.type('Who owns this endpoint?'); await __t.real.click(h.querySelector('[data-comment-add]'));
     const first = await __t.waitFor(() => h.querySelector('[data-comment="open"]'), 6000); if (!first) return 'NO COMMENT';
     const reply = first.querySelector('[data-comment-reply-button]'); if (!reply) return 'NO REPLY BUTTON';
     reply.click();
     const replying = await __t.waitFor(() => h.querySelector('[data-comment-replying]'), 3000);
     await __t.real.click(h.querySelector('[data-comment-text]')); await __t.real.type('Payments does.'); await __t.real.click(h.querySelector('[data-comment-add]'));
     const under = await __t.waitFor(() => h.querySelector('[data-comment-reply]'), 6000);
     return 'replying shown: ' + !!replying + ' | under it: ' + /Payments does/.test(under?.textContent ?? '') + ' | reply mode off: ' + !h.querySelector('[data-comment-replying]');`,
  ),
  step(
    'settle-and-delete-take-the-reply',
    `${H}
     const h = await openInfo(); if (!h) return 'NO HOST';
     const first = h.querySelector('[data-comment="open"]'); if (!first) return 'NO COMMENT';
     first.querySelector('[data-comment-resolve]').click();
     const settled = await __t.waitFor(() => h.querySelectorAll('[data-comment="open"]').length === 0, 6000);
     const open = (await window.aps.invoke('comments.open')).filter((c) => /Who owns this endpoint|Payments does/.test(c.text)).length;
     const toggle = h.querySelector('[data-comment-settled-toggle]'); toggle?.click(); await __t.sleep(300);
     const del = await __t.waitFor(() => h.querySelector('[data-comment="settled"] [data-comment-delete]'), 3000); if (!del) return 'NO DELETE';
     del.click();
     const gone = await __t.waitFor(() => !h.querySelector('[data-comment-reply]'), 6000);
     return 'all settled: ' + !!settled + ' | open after settling: ' + open + ' | reply gone with it: ' + !!gone;`,
  ),
];

module.exports = withExpect(steps, {
  'reply-to-a-comment': /^replying shown: true \| under it: true \| reply mode off: true$/,
  'settle-and-delete-take-the-reply': /^all settled: true \| open after settling: 0 \| reply gone with it: true$/,
});
