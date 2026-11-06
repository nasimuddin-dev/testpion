// Every open comment from Home: Home shows the first five ("Your team is asking"), "All N" opens the full list with the
// same rows and a For you chip that keeps those that mention you.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'seven-comments-and-the-full-list',
    `(async () => {
      const envs = await window.aps.invoke('env.list'); const env = envs.find((e) => !e.problem); if (!env) return 'NO ENVIRONMENT';
      const ref = { kind: 'environment', environmentId: env.id };
      const made = [];
      const first = await window.aps.invoke('comments.add', { ref, text: 'Comment 1' }); made.push(first.id);
      for (let i = 2; i <= 6; i++) made.push((await window.aps.invoke('comments.add', { ref, text: 'Comment ' + i })).id);
      made.push((await window.aps.invoke('comments.add', { ref, text: 'For you, @' + String(first.by).replace(/\\s+/g, '') })).id);
      await __t.view('Home');
      const all = await __t.waitFor(() => document.querySelector('[data-home-comments-all]'), 8000);
      const onHome = document.querySelector('[data-home-comments]')?.getAttribute('data-home-comments');
      if (!all) { for (const id of made) await window.aps.invoke('comments.delete', { ref, id }); return 'NO ALL LINK | on Home: ' + onHome; }
      const label = all.textContent.trim();
      all.click();
      const list = await __t.waitFor(() => document.querySelector('[role=dialog] [data-open-comments]'), 4000);
      const rows = list?.getAttribute('data-open-comments');
      const chip = [...document.querySelectorAll('[role=dialog] [data-filter-chips] button')].find((b) => /^For you/.test(b.textContent.trim()));
      chip?.click(); await __t.sleep(200);
      const forYou = document.querySelector('[role=dialog] [data-open-comments]')?.getAttribute('data-open-comments');
      await __t.esc();
      for (const id of made) await window.aps.invoke('comments.delete', { ref, id });
      return 'on Home: ' + onHome + ' | link: ' + label + ' | rows: ' + rows + ' | for you: ' + forYou;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'seven-comments-and-the-full-list': /^on Home: 5 \| link: All \d+ \| rows: (\d+) \| for you: [1-9]\d*$/,
});
