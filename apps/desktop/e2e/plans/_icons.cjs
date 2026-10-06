// Audit (not part of the suite: the leading underscore): every view, and the buttons that show text without an icon.
// Owner (2026-10-06): "use proper icon everywhere its possible". Run: npm run e2e -- --only _icons
const { withExpect } = require('../lib.cjs');

const VIEWS = ['Home', 'Collections', 'Debugger', 'Tests', 'Monitors', 'Load', 'AI Lab', 'Evaluations', 'Environments', 'History', 'Traces', 'Git', 'Settings'];
const steps = [
  [
    'buttons-without-icons',
    `(async () => {
      const out = [];
      for (const v of ${JSON.stringify(VIEWS)}) {
        try { await __t.view(v); } catch { out.push(v + ': (could not open)'); continue; }
        await __t.sleep(900);
        // every tab of the view too
        const tabs = [...document.querySelectorAll('main [role=tab]')].filter((t) => t.getClientRects().length).slice(0, 8);
        for (const t of [null, ...tabs]) {
          if (t) { t.click(); await __t.sleep(400); }
          for (const b of document.querySelectorAll('main button, aside button, header button')) {
            if (!b.getClientRects().length) continue;
            const text = b.textContent.replace(/\\s+/g, ' ').trim();
            if (!text || b.querySelector('svg, img')) continue;
            if (b.getAttribute('role') === 'tab' || b.closest('[role=tablist]') || b.closest('[data-tree-row]') || b.closest('[role=row]')) continue;
            if (/^\\d+$/.test(text) || text.length > 40) continue;
            out.push(v + (t ? ' / ' + t.textContent.trim().slice(0, 20) : '') + ': ' + text);
          }
        }
      }
      return [...new Set(out)].join(' ;; ') || 'none';
    })()`,
  ],
];

module.exports = withExpect(steps, { 'buttons-without-icons': /^none$/ });
