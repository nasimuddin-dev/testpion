// Not part of the suite (the _ prefix): how many RPC calls each view makes when it opens, and how many an edit sets off (the
// `data.changed` fan-out). The calls are counted by method in the main process (the window's `aps:rpc` handler is wrapped by the
// first step); each interaction is three steps: reset, do it, report the total and the six methods called most. A view that reads
// the same thing twice on mount, or a save that reloads lists it did not touch, shows as a count that a change can lower.
//   npm run e2e -w @testpion/desktop -- --only _rpc-chatter
const { withExpect } = require('../lib.cjs');

const HOOK = `main: const { ipcMain } = require('electron'); const m = ipcMain._invokeHandlers;
  if (!globalThis.__rpcCounts) { const orig = m.get('aps:rpc'); globalThis.__rpcCounts = new Map(); m.set('aps:rpc', (e, method, params) => { globalThis.__rpcCounts.set(method, (globalThis.__rpcCounts.get(method) ?? 0) + 1); return orig(e, method, params); }); }
  globalThis.__rpcCounts.clear(); return 'counting';`;
const RESET = `main: await new Promise((r) => setTimeout(r, 800)); globalThis.__rpcCounts.clear(); return 'reset';`;
const REPORT = `main: await new Promise((r) => setTimeout(r, 1200)); const all = [...globalThis.__rpcCounts].sort((a, b) => b[1] - a[1]); return all.reduce((n, [, c]) => n + c, 0) + ' calls: ' + all.slice(0, 6).map(([k, c]) => k + ' ' + c).join(', ');`;

const steps = [['count-rpc', HOOK, false], ['setup', `(async () => { await __t.requests(); return 'ready'; })()`, false]];
/** An interaction: the count of RPC calls it makes. */
const counted = (name, body) => steps.push([`${name}:reset`, RESET, false], [`${name}:do`, `(async () => { ${body} })()`, false], [`${name}:calls`, REPORT, false]);

for (const label of ['Home', 'Tests', 'History', 'Environments', 'Git', 'Monitors', 'Collections', 'Settings']) counted(`open-${label.toLowerCase()}`, `await __t.view(${JSON.stringify(label)}); return ${JSON.stringify(label)};`);
counted('back-to-requests', `await __t.requests(); return 'requests';`);
counted('save-a-collection', `const r = await window.aps.invoke('col.list'); const c = r[0]; if (!c) return 'NO COLLECTION'; await window.aps.invoke('col.save', { ...c, name: c.name }); return 'saved ' + c.name;`);

module.exports = withExpect(steps, {});
