// Mentions in comments for your team: a comment that @mentions you (your git name, else this computer's user name) is
// marked "For you" first under "Your team is asking" on Home, and the @name stands out where the comment is shown.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'a-comment-for-me',
    `(async () => {
      const envs = await window.aps.invoke('env.list'); const env = envs.find((e) => !e.problem); if (!env) return 'NO ENVIRONMENT';
      const ref = { kind: 'environment', environmentId: env.id };
      await window.aps.invoke('comments.add', { ref, text: 'Nothing for anyone here' });
      const c = await window.aps.invoke('comments.add', { ref, text: 'Is the base URL right, @' + me.replace(/\\s+/g, '') + '?' });
      window.__mentionRef = ref; window.__mentionId = c.id;
      const open = await window.aps.invoke('comments.open');
      const mine = open.find((x) => x.id === c.id);
      return 'mentions me: ' + !!mine?.forYou + ' | first: ' + (open.filter((x) => x.forYou)[0]?.id === c.id);
    })()`,
  ],
  [
    'home-says-for-you',
    `(async () => {
      await __t.view('Home'); await __t.sleep(1200);
      const badge = await __t.waitFor(() => document.querySelector('[data-home-comment-for-you]'), 8000);
      const first = document.querySelector('[data-home-comment]');
      await window.aps.invoke('comments.delete', { ref: window.__mentionRef, id: window.__mentionId });
      await window.aps.invoke('comments.delete', { ref: window.__mentionRef, id: window.__otherId });
      return 'badge: ' + !!badge + ' | on the first comment: ' + !!first?.querySelector('[data-home-comment-for-you]');
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'a-comment-for-me': /^mentions me: true \| first: true$/,
  'home-says-for-you': /^badge: true \| on the first comment: true$/,
});
