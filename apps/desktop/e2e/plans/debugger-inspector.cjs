// The HTTP Debugger's inspector tabs on a self-test exchange with a query string and a cookie: Params (decoded), Cookies (the
// request's names with the values masked, and the response's), Summary (the same table as the dock) and Error (what to check on a 404). The request side has
// no "Overview" tab any more.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const pane = (side) => document.querySelector('main [data-details-pane="' + side + '"]');
  const tabs = (side) => [...(pane(side)?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.textContent.trim());
  // a tab that does not fit the half-width pane is in the strip's "All tabs" menu (the strip marks it data-overflow)
  const openTab = async (side, name) => {
    const t = [...(pane(side)?.querySelectorAll('[role=tab]') ?? [])].find((x) => x.textContent.trim().startsWith(name));
    if (!t) return false;
    if (!t.hasAttribute('data-overflow')) { await __t.real.click(t); await __t.sleep(300); return true; }
    const more = pane(side)?.querySelector('[aria-label^="All tabs"]');
    if (!more) return false;
    more.click(); await __t.sleep(300);
    const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith(name)), 2000);
    if (!it) return false;
    it.click(); await __t.sleep(300); return true;
  };
`;
const step = stepOf(H);

const steps = [
  step(
    'send-an-exchange-with-a-query-and-a-cookie',
    `await __t.view('Debugger'); await __t.sleep(600);
     if (!(await window.aps.invoke('debug.status')).running) { await (async () => { const arrow = [...document.querySelectorAll('main [data-capture-all] button')].find((b) => b.getAttribute('aria-label') === 'Other ways to start'); if (!arrow) return; arrow.click(); const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /Only a program I point at the proxy/.test(m.textContent)), 3000); if (it) it.click(); })(); await __t.sleep(800); }
     await window.aps.invoke('debug.clear').catch(() => undefined);
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?q=hello%20world&tag=a%26b&flag', headers: { cookie: 'sid=abc123; theme=dark' } });
     const r = await __t.waitFor(() => row('q=hello'), 6000); if (!r) return 'NO ROW';
     r.click(); await __t.sleep(800);
     return 'request tabs: ' + tabs('request').map((t) => t.replace(/\\d+$/, '')).join(',');`,
  ),
  step(
    'params-decoded',
    `if (!(await openTab('request', 'Params'))) return 'NO PARAMS TAB';
     const t = document.querySelector('main [data-inspector-table="query"]'); if (!t) return 'NO TABLE';
     const cells = [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent.trim()).join('='));
     return 'query: ' + cells.join(' | ');`,
  ),
  step(
    'cookies-both-sides',
    `if (!(await openTab('request', 'Cookies'))) return 'NO REQUEST COOKIES';
     const req = [...document.querySelectorAll('main [data-inspector-table="cookies-request"] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent.trim()).join('='));
     const resTab = tabs('response').some((t) => t.startsWith('Cookies'));
     if (resTab) await openTab('response', 'Cookies');
     const empty = !!pane('response')?.textContent.includes('The response sets no cookies');
     return 'request cookies: ' + req.join(' | ') + ' | response cookies tab: ' + resTab + ' | response sets none: ' + empty;`,
  ),
  step(
    'summary-tab-is-the-docks-summary',
    `if (!(await openTab('request', 'Summary'))) return 'NO SUMMARY TAB';
     const groups = [...(pane('request')?.querySelectorAll('[data-summary-group]') ?? [])].map((g) => g.textContent.trim()).join(',');
     const url = pane('request')?.textContent.includes('/health?q=hello');
     const overview = tabs('request').some((t) => t.startsWith('Overview'));
     return 'groups: ' + groups + ' | url: ' + url + ' | overview tab: ' + overview;`,
  ),
  step(
    'error-tab-on-a-404',
    `await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here?x=1' });
     const r = await __t.waitFor(() => row('nothing-here'), 6000); if (!r) return 'NO ROW';
     r.click(); await __t.sleep(800);
     if (!(await openTab('response', 'Error'))) return 'NO ERROR TAB: ' + tabs('response').join(',');
     const e = document.querySelector('main [data-inspector="error"]');
     return 'error says: ' + (e?.textContent.includes('404') ? '404' : 'NO 404') + ' | advice: ' + /path was not found/.test(e?.textContent ?? '');`,
  ),
];

module.exports = withExpect(steps, {
  'send-an-exchange-with-a-query-and-a-cookie': /^request tabs: Header,Content,Raw,JSON,Params,Cookies,Summary,Auth,Hex$/,
  'params-decoded': /^query: q=hello world \| tag=a&b \| flag=$/,
  'cookies-both-sides': /^request cookies: sid=\*\*\* \| theme=\*\*\* \| response cookies tab: (true|false) \| response sets none: (true|false)$/,
  'summary-tab-is-the-docks-summary': /^groups: Main,Connection,Request details,Response details,Timing \| url: true \| overview tab: false$/,
  'error-tab-on-a-404': /^error says: 404 \| advice: true$/,
});
