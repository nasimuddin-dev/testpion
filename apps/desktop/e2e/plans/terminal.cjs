// The bottom panel's Terminal: a real shell in the workspace folder with `testpion` on the PATH; typing, a second
// terminal, Kill, the terminals surviving a switch of the bottom tab, Run in terminal from Settings ▸ AI agents, and the
// same palette commands. Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const box = () => document.querySelector('[data-terminal-box]');
  const tabs = () => [...document.querySelectorAll('[data-terminal-strip] [role=tab]')];
  // the shown terminal's text with its scrollback, a line the width wrapped joined back (the rows on screen depend on
  // the panel's size and the length of the prompt: the workspace's path)
  const screen = () => {
    const id = tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tabId;
    const t = (window.__tpTerminals?.(true) ?? []).find((x) => x.id === id);
    return t?.text ?? (box()?.querySelector('.xterm-rows')?.innerText ?? '').replace(/\\u00a0/g, ' ');
  };
  const waitText = (re, ms = 30000) => __t.waitFor(() => re.test(screen()), ms);
  const focusTerm = () => { const t = box()?.querySelector('textarea'); t?.focus(); return !!t; };
  const sessions = () => window.aps.invoke('terminal.list', {});
  /** Wait for the burst's end (at most ms), sampling the active terminal every 10 s: STALLED when its output stopped growing. */
  const burstWatch = async (t0, ms) => {
    const timeline = [];
    let lastSent = -1;
    for (const end = performance.now() + ms; performance.now() < end; ) {
      if (await __t.waitFor(() => /^BURST-DONE\\s*$/m.test(screen()), Math.min(10000, end - performance.now()))) return { done: true, timeline };
      const id = tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tabId;
      const l = (await sessions()).find((x) => x.id === id);
      const stalled = l && !l.detached && l.sent === lastSent && !/^BURST-DONE\\s*$/m.test(screen());
      lastSent = l?.sent ?? -1;
      timeline.push(Math.round((performance.now() - t0) / 1000) + 's:' + (stalled ? 'STALLED ' : '') + 'sent ' + l?.sent + (l?.undrawn ? ' undrawn ' + l.undrawn : '') + (l?.paused ? ' paused' : '') + (l?.detached ? ' detached' : ''));
    }
    return { done: /^BURST-DONE\\s*$/m.test(screen()), timeline };
  };
  const openTab = async () => {
    // a first start after a build can still be loading (no compile cache yet): ask until the panel is there
    for (let i = 0; i < 20 && !document.querySelector('[data-bottom-tab]'); i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true, bubbles: true }));
      await __t.waitFor(() => document.querySelector('[data-bottom-tab]'), 1000);
    }
    document.querySelector('[data-bottom-tab="terminal"]')?.click();
  };
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });
/** Type into the focused terminal like a user (Electron's input events), then Enter unless `enter` is false. */
const type = (name, text, enter = true) => [
  name,
  `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
   // into the terminal shown, whatever has the focus now (a dialog, another view's field)
   await w.webContents.executeJavaScript("document.querySelector('[data-terminal-box] textarea')?.focus()");
   w.webContents.insertText(${JSON.stringify(text)});
   ${enter ? "await new Promise((r) => setTimeout(r, 200)); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });" : ''}
   await new Promise((r) => setTimeout(r, 300)); return 'typed';`,
  false,
];

const steps = [
  s(
    'open-terminal-tab',
    `const caps = (await window.aps.invoke('app.info')).capabilities;
     await openTab();
     const t0 = performance.now();
     const ok = await __t.waitFor(() => box()?.querySelector('.xterm') && tabs().length === 1, 15000);
     // the shell's prompt
     await waitText(/\\S/, 20000);
     const list = await sessions();
     if (!ok) return 'NO TERMINAL: panel ' + document.querySelector('[data-bottom-panel]')?.getAttribute('data-bottom-panel') + ' | dialog ' + !!document.querySelector('[role=dialog]') + ' | box ' + !!box() + ' | sessions ' + list.length + ' | toasts ' + [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' / ') + ' | page: ' + document.body.innerText.replace(/s+/g, ' ').slice(0, 160) + ' | focus ' + document.hasFocus();
     return 'capabilities ' + JSON.stringify(caps) + ' | xterm: ' + !!ok + ' | tabs: ' + tabs().length + ' | shell: ' + list[0]?.shell + ' | cwd is the workspace: ' + (list[0]?.cwd === (await window.aps.invoke('ws.current')).path) + ' | focused: ' + focusTerm();`,
  ),
  type('type-version', 'testpion --version'),
  s(
    'testpion-version',
    `const v = (await window.aps.invoke('app.info')).version; const ok = await waitText(new RegExp('^' + v.replace(/\\./g, '\\\\.') + '\\\\s*$', 'm')); return ok ? 'printed ' + v : 'NOT PRINTED: ' + screen().slice(-300);`,
  ),
  type('type-echo', 'echo hello-from-tp'),
  s(
    'echo-hello',
    `const ok = await waitText(/^hello-from-tp\\s*$/m); const ws = await waitText(/TESTPION|PS |\\$|>/, 2000); return ok ? 'echoed hello-from-tp' : 'NOT ECHOED: ' + screen().slice(-300);`,
  ),
  type('type-workspace-var', process.platform === 'win32' ? 'echo "ws=$env:TESTPION_WORKSPACE"' : 'echo "ws=$TESTPION_WORKSPACE"'),
  s(
    'workspace-env',
    `const p = (await window.aps.invoke('ws.current')).path; const ok = await __t.waitFor(() => screen().replace(/\\s+/g, '').includes(('ws=' + p).replace(/\\s+/g, '')), 15000); return ok ? 'TESTPION_WORKSPACE is the workspace' : 'NOT SET: ' + screen().slice(-300);`,
  ),
  type('type-file-path', 'echo tests/offline.suite.yaml:3'),
  s(
    'find-file-link',
    `await waitText(/^tests\\/offline\\.suite\\.yaml:3\\s*$/m, 15000);
     // the echoed line (not the command line): where its first characters are on screen
     const row = [...box().querySelectorAll('.xterm-rows > div')].find((d) => /^tests\\/offline\\.suite\\.yaml:3\\s*$/.test(d.textContent.replace(/\\u00a0/g, ' ')));
     if (!row) return 'NO ROW';
     const r = row.getBoundingClientRect();
     window.__tpLinkAt = { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) };
     return 'link at ' + JSON.stringify(window.__tpLinkAt);`,
    false,
  ),
  [
    'click-file-link',
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
     const at = await w.webContents.executeJavaScript('window.__tpLinkAt');
     if (!at) return 'NO LINK';
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     w.webContents.sendInputEvent({ type: 'mouseMove', x: at.x - 4, y: at.y });
     await sleep(150);
     w.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
     await sleep(500);
     w.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
     w.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
     await sleep(2500);
     return 'clicked';`,
    false,
  ],
  s(
    'file-link-opens-tests',
    `const tests = await __t.waitFor(() => document.querySelector('nav [aria-label="Tests"][aria-current="page"]'), 8000);
     const fileTab = await __t.waitFor(() => [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.includes('offline.suite.yaml')), 5000);
     return 'Tests view: ' + !!tests + ' | file tab: ' + !!fileTab;`,
  ),
  s(
    'second-session',
    `document.querySelector('[data-terminal-strip] button[aria-label="New terminal"]')?.click();
     await __t.waitFor(() => tabs().length === 2, 15000);
     const active = tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tabId;
     await waitText(/\\S/, 20000);
     return 'tabs: ' + tabs().length + ' | sessions: ' + (await sessions()).length + ' | the new one is active: ' + (active === tabs()[1]?.dataset.tabId);`,
  ),
  s(
    'survives-tab-switch',
    `const before = tabs().map((t) => t.dataset.tabId).join();
     document.querySelector('[data-bottom-tab="console"]')?.click(); await __t.sleep(500);
     const gone = !document.querySelector('[data-terminal-box]');
     document.querySelector('[data-bottom-tab="terminal"]')?.click();
     await __t.waitFor(() => box()?.querySelector('.xterm'), 5000);
     tabs()[0]?.click(); await __t.sleep(500);
     return 'hidden on Console: ' + gone + ' | same terminals after: ' + (tabs().map((t) => t.dataset.tabId).join() === before) + ' | first still shows its output: ' + /hello-from-tp/.test(screen());`,
  ),
  s(
    'kill',
    `document.querySelector('[data-terminal-strip] button[aria-label="Kill terminal"]')?.click();
     await __t.waitFor(() => tabs().length === 1, 5000);
     await __t.sleep(500);
     return 'tabs: ' + tabs().length + ' | sessions: ' + (await sessions()).length;`,
  ),
  s(
    'run-in-terminal',
    `await __t.view('Settings'); await __t.sleep(600); await __t.tab('AI agents'); await __t.sleep(1200);
     const b = [...document.querySelectorAll('main [data-run-in-terminal]')].find((x) => x.offsetParent);
     if (!b) return 'NO BUTTON';
     b.click();
     const ok = await waitText(/claude mcp add testpion -- /, 15000);
     const flat = screen().replace(/\\s+/g, ' ');
     const at = flat.indexOf('claude mcp add testpion');
     return (ok ? 'typed into the terminal: ' : 'NOT TYPED: ') + (at >= 0 ? flat.slice(at, at + 40) : flat.slice(-80)) + ' | the panel shows the Terminal: ' + (document.querySelector('[data-bottom-panel]')?.getAttribute('data-bottom-panel') === 'terminal');`,
  ),
  s(
    'not-run-until-enter',
    `await __t.sleep(1500);
     // the command was typed, not run: no "not recognized" / "command not found" from the shell
     return /not recognized|command not found|CommandNotFound/.test(screen()) ? 'RAN' : 'waits for Enter';`,
  ),
  s(
    'palette-terminal-new',
    `const before = tabs().length;
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await __t.sleep(500);
     const input = document.querySelector('[role=dialog] input'); if (!input) return 'NO INPUT';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'New terminal'); input.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(400);
     input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await __t.sleep(300);
     await __t.waitFor(() => tabs().length === before + 1, 15000);
     return 'terminals: ' + before + ' → ' + tabs().length;`,
  ),
  [
    'memory-before-burst',
    `main:const m = process.memoryUsage(); global.__tpMem = m; return 'main rss ' + Math.round(m.rss / 1048576) + ' MB, heap ' + Math.round(m.heapUsed / 1048576) + ' MB';`,
    false,
  ],
  s('renderer-memory-before', `await __t.sleep(300); window.__tpHeap = performance.memory?.usedJSHeapSize ?? 0; return 'renderer heap ' + Math.round(window.__tpHeap / 1048576) + ' MB';`, false),
  type('type-burst', process.platform === 'win32' ? 'cmd /c type big.txt; echo BURST-DONE' : 'cat big.txt; echo BURST-DONE'),
  s(
    'burst-50mb',
    `// the frames of the window while 50 MB go through the terminal: it must stay responsive (no frame stuck behind the output)
     const gaps = []; let done = false; let last = performance.now();
     const frame = (t) => { gaps.push(t - last); last = t; if (!done) requestAnimationFrame(frame); };
     requestAnimationFrame(frame);
     const t0 = performance.now();
     // a click on the panel's own tab answers while the output flows
     await __t.sleep(1500);
     const c0 = performance.now(); document.querySelector('[data-bottom-tab="logs"]')?.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
     const clickMs = Math.round(performance.now() - c0);
     document.querySelector('[data-bottom-tab="terminal"]')?.click();
     // every 10 s: where the output is and what flow control says; output that stops growing while not done is a stall
     // (how fast it goes depends on the machine: ConPTY's own speed, other programs; it must only never stop)
     const ok = await burstWatch(t0, 120000);
     done = true;
     const secs = ((performance.now() - t0) / 1000).toFixed(1);
     gaps.sort((a, b) => a - b);
     const p = (q) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] ?? 0);
     return (ok.done ? 'done' : 'running') + ' in ' + secs + ' s | frames ' + gaps.length + ' | frame ms p50 ' + p(0.5) + ' p95 ' + p(0.95) + ' max ' + Math.round(gaps.at(-1) ?? 0) + ' | tab switch during burst ' + clickMs + ' ms | ' + ok.timeline.join(' ');`,
  ),
  s(
    'burst-completes',
    `const t0 = performance.now(); const ok = await burstWatch(t0, 170000); return (ok.done ? 'done' : 'NOT DONE') + ' after ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s more | ' + ok.timeline.join(' ');`,
  ),
  s(
    'renderer-memory-after',
    `await __t.sleep(1500); const h = performance.memory?.usedJSHeapSize ?? 0; return 'renderer heap ' + Math.round(h / 1048576) + ' MB (+' + Math.round((h - window.__tpHeap) / 1048576) + ' MB)';`,
    false,
  ),
  [
    'memory-after-burst',
    `main:await new Promise((r) => setTimeout(r, 1500)); const m = process.memoryUsage(); const b = global.__tpMem; return 'main rss ' + Math.round(m.rss / 1048576) + ' MB (+' + Math.round((m.rss - b.rss) / 1048576) + '), heap ' + Math.round(m.heapUsed / 1048576) + ' MB (+' + Math.round((m.heapUsed - b.heapUsed) / 1048576) + ')';`,
    false,
  ],
  [
    'reload-window',
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; global.__tpSessions = (await w.webContents.executeJavaScript("window.aps.invoke('terminal.list', {})")).length; w.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)); return 'reloaded with ' + global.__tpSessions + ' terminals';`,
    false,
  ],
  [
    'reload-restores-terminals',
    `(async () => {
       // the page is new (no test helpers): Ctrl+\` opens the Terminal, which takes the running terminals back
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const wait = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (fn()) return true; return false; };
       // (the reloaded page may still be starting: ask until the Terminal is there)
       for (let i = 0; i < 30 && !document.querySelector('[data-terminal-strip] [role=tab]'); i++) {
         if (!document.querySelector('[data-bottom-tab="terminal"][aria-selected="true"]')) window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\u0060', code: 'Backquote', ctrlKey: true, bubbles: true }));
         await wait(() => document.querySelectorAll('[data-terminal-strip] [role=tab]').length > 0, 1000);
       }
       const text = () => (document.querySelector('[data-terminal-box] .xterm-rows')?.innerText ?? '').replace(/ /g, ' ');
       const back = await wait(() => /BURST-DONE/.test(text()), 10000);
       const tabs = document.querySelectorAll('[data-terminal-strip] [role=tab]').length;
       return 'tabs ' + tabs + ' | sessions ' + (await window.aps.invoke('terminal.list', {})).length + ' | output back: ' + back + (back ? '' : ' | shows: ' + text().replace(/\\s+/g, ' ').slice(-200));
     })()`,
  ],
  [
    'close-all',
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       for (const t of [...document.querySelectorAll('[data-terminal-strip] [role=tab]')]) { t.querySelector('button[aria-label^="Close"]')?.click(); await sleep(200); }
       await sleep(800);
       return 'tabs: ' + document.querySelectorAll('[data-terminal-strip] [role=tab]').length + ' | sessions: ' + (await window.aps.invoke('terminal.list', {})).length;
     })()`,
  ],
  [
    'workspace-switch-ends-terminals',
    `(async () => {
       // terminals belong to their workspace: opening another one ends them, in the backend and in the panel
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const wait = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true; return false; };
       document.querySelector('[data-terminal-strip] button[aria-label="New terminal"]')?.click();
       await wait(() => document.querySelectorAll('[data-terminal-strip] [role=tab]').length === 1, 15000);
       const before = (await window.aps.invoke('terminal.list', {})).length;
       const first = (await window.aps.invoke('ws.current')).name;
       await window.aps.invoke('ws.create', { name: 'Terminal other' });
       await window.aps.invoke('ws.open', { ref: 'Terminal other' });
       await wait(async () => document.querySelectorAll('[data-terminal-strip] [role=tab]').length === 0, 15000);
       const after = (await window.aps.invoke('terminal.list', {})).length;
       const tabs = document.querySelectorAll('[data-terminal-strip] [role=tab]').length;
       // back to the first workspace: it starts with no terminals either (none came back)
       await window.aps.invoke('ws.open', { ref: first });
       await sleep(2000);
       return 'before ' + before + ' | after: sessions ' + after + ', tabs ' + tabs + ' | back: tabs ' + document.querySelectorAll('[data-terminal-strip] [role=tab]').length + ', sessions ' + (await window.aps.invoke('terminal.list', {})).length;
     })()`,
  ],
];

/** 50 MB of numbered lines in the workspace folder, for the burst. */
const prepare = (ws) => {
  const { writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const line = ' the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ\n';
  const lines = [];
  for (let i = 0; i < 500000; i++) lines.push(String(i).padStart(7, '0') + line);
  writeFileSync(join(ws, 'big.txt'), lines.join(''));
};

module.exports = withExpect(
  steps,
  {
    'open-terminal-tab': /capabilities \{"shell":true,"localFiles":true\} \| xterm: true \| tabs: 1 \| shell: \w+ \| cwd is the workspace: true \| focused: true/,
    'testpion-version': /^printed \d+\.\d+\.\d+/,
    'echo-hello': /^echoed hello-from-tp$/,
    'find-file-link': /^link at \{"x":\d+,"y":\d+\}$/,
    'click-file-link': /^clicked$/,
    'file-link-opens-tests': /^Tests view: true \| file tab: true$/,
    'workspace-env': /^TESTPION_WORKSPACE is the workspace$/,
    'second-session': /tabs: 2 \| sessions: 2 \| the new one is active: true/,
    'survives-tab-switch': /hidden on Console: true \| same terminals after: true \| first still shows its output: true/,
    kill: /tabs: 1 \| sessions: 1/,
    'run-in-terminal': /^typed into the terminal: claude mcp add testpion -- .* \| the panel shows the Terminal: true/,
    'not-run-until-enter': /^waits for Enter$/,
    'palette-terminal-new': /terminals: 1 → 2/,
    'burst-50mb': (r) => {
      const m = /^(?:done|running) in [\d.]+ s \| frames \d+ \| frame ms p50 (\d+) p95 (\d+) max (\d+) \| tab switch during burst (\d+) ms/.exec(r);
      if (!m) return 'no measurement';
      if (/STALLED/.test(r)) return 'the output stopped';
      // the window keeps drawing: most frames on time, none stuck for long, a click answers
      return Number(m[2]) <= 50 && Number(m[3]) <= 500 && Number(m[4]) <= 300 ? true : 'the window stalled during the burst';
    },
    'burst-completes': (r) => (/^done/.test(r) && !/STALLED/.test(r) ? true : 'the burst did not finish'),
    'renderer-memory-after': (r) => (Number(/\(\+(-?\d+) MB\)/.exec(r)?.[1] ?? 999) < 100 ? true : 'the renderer kept the output'),
    'memory-after-burst': (r) => (Number(/heap \d+ MB \(\+(-?\d+)\)/.exec(r)?.[1] ?? 999) < 100 ? true : 'the main process kept the output'),
    'reload-restores-terminals': /tabs 2 \| sessions 2 \| output back: true/,
    'close-all': /tabs: 0 \| sessions: 0/,
    'workspace-switch-ends-terminals': /^before 1 \| after: sessions 0, tabs 0 \| back: tabs 0, sessions 0$/,
  },
  { prepare },
);
