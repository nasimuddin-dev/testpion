// Pinnable side panels (as in Visual Studio): the request Scripts tab's Snippets unpin into a tab on the edge and slide
// over the editor on hover / click; inserting a snippet closes it; Ctrl+Shift+I picks a snippet by name; the pin is
// remembered; a narrow Scripts tab shows Pre-request / Post-response as tabs; the Debugger's dock unpins and pins too.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const openRow = async (name) => { await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses'); const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)); if (!r) return false; r.click(); await __t.sleep(1200); return true; };
  const subTab = async (label) => { [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith(label))?.click(); await __t.sleep(900); };
  const panel = (id = 'scripts.snippets') => vis('main [data-pinnable-panel="' + id + '"]')[0];
  const state = (id) => { const p = panel(id); return p ? 'pinned=' + p.getAttribute('data-pinned') + ' open=' + p.getAttribute('data-open') : 'NO PANEL'; };
  const pinButton = (id) => panel(id)?.querySelector('[data-pin-toggle]');
  const edgeTab = (id) => panel(id)?.querySelector('button[aria-expanded]');
  const editorBox = () => vis('main [data-script-editor]')[0];
  const editorWidth = () => Math.round(editorBox()?.getBoundingClientRect().width ?? 0);
  const editor = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
  const layout = () => vis('main [data-scripts-layout]')[0]?.getAttribute('data-scripts-layout');
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const pickLayout = async (label) => { const b = document.querySelector('[aria-label^="Response layout"]'); if (!b) return; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(400); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.includes(label))?.click(); await __t.sleep(900); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];
/** Real keys, sent to the window by Electron (so the app menu's accelerators see them too). */
const keys = (name, keyCode, modifiers) => [
  name,
  `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
   w.webContents.sendInputEvent({ type: 'keyDown', keyCode: '${keyCode}', modifiers: ${JSON.stringify(modifiers)} });
   w.webContents.sendInputEvent({ type: 'keyUp', keyCode: '${keyCode}', modifiers: ${JSON.stringify(modifiers)} });
   await new Promise((r) => setTimeout(r, 900)); return 'sent';`,
  false,
];
const resize = (name, width) => [
  name,
  `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(${width}, 900); await new Promise((r) => setTimeout(r, 1500)); return 'width ' + w.getContentSize()[0];`,
  false,
];

const steps = [
  step(
    'scripts-tab-pinned',
    `if (!(await openRow('POST a JSON body'))) return 'NO ROW'; await pickLayout('Response below'); await subTab('Scripts'); await __t.sleep(800);
     const help = vis('main [data-scripts-help]')[0];
     const described = help ? document.getElementById(help.getAttribute('aria-describedby'))?.textContent.trim().slice(0, 30) : '';
     return state() + ' | layout: ' + layout() + ' | help icon: ' + (help?.getAttribute('aria-label') ?? 'none') + ' | described: ' + described;`,
  ),
  step(
    'unpin-widens-the-editor',
    `const before = editorWidth(); pinButton()?.click(); await __t.sleep(700);
     const after = editorWidth();
     return state() + ' | wider by ' + (after - before > 150 ? '>150' : after - before) + ' | tab: ' + edgeTab()?.getAttribute('aria-expanded') + ' | stored: ' + localStorage.getItem('aps.pinnable.scripts.snippets.pinned');`,
  ),
  step(
    'hover-opens-overlay',
    `const t = edgeTab(); if (!t) return 'NO TAB'; const w0 = editorWidth();
     // (the real mouse pointer may move over the window meanwhile: hover once more if it did not open)
     t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
     await __t.sleep(100); const early = panel().getAttribute('data-open');
     const opened = () => panel().getAttribute('data-open') === 'true';
     if (!(await __t.waitFor(opened, 1000))) (t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })), await __t.waitFor(opened, 1000));
     await __t.sleep(200);
     return 'after 100 ms open=' + early + ' | ' + state() + ' | expanded: ' + t.getAttribute('aria-expanded') + ' | no layout shift: ' + (editorWidth() === w0) + ' | snippets shown: ' + (vis('main [data-snippets] button').length > 5);`,
  ),
  step(
    'insert-closes-overlay',
    `const ed = editor(); if (!ed) return 'NO EDITOR'; ed.setValue(''); await __t.sleep(300);
     const b = vis('main [data-snippets] button').find((x) => x.textContent.includes('Status code: Code is 200')); if (!b) return 'NO SNIPPET';
     b.focus(); b.click(); await __t.sleep(700);
     return state() + ' | editor has tp.test: ' + editor().getValue().includes('tp.test("Status code is 200"') + ' | focus on tab: ' + (document.activeElement === edgeTab());`,
  ),
  step(
    'click-opens-esc-closes',
    `edgeTab().click(); await __t.sleep(400); const opened = state();
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400);
     const afterEsc = state();
     edgeTab().click(); await __t.sleep(400);
     document.querySelector('main [data-script-editor]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); await __t.sleep(400);
     return 'click: ' + opened + ' | Esc: ' + afterEsc + ' | click outside: ' + state();`,
  ),
  step(
    'focus-the-editor',
    `const ed = editor(); ed.setValue('// checks\\n'); const m = ed.getModel(); ed.setPosition(m.getPositionAt(m.getValueLength())); ed.focus(); await __t.sleep(300);
     return 'focused: ' + ed.hasTextFocus();`,
    false,
  ),
  keys('ctrl-shift-i', 'I', ['control', 'shift']),
  step(
    'quick-pick-inserts',
    `const dlg = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Insert snippet"]'), 2000); if (!dlg) return 'NO QUICK PICK';
     const input = dlg.querySelector('input'); setVal(input, 'status'); await __t.sleep(300);
     const first = dlg.querySelector('[role=option][aria-selected=true]')?.textContent.trim();
     input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await __t.sleep(700);
     const v = editor().getValue();
     return 'first: ' + first + ' | closed: ' + !document.querySelector('[role=dialog][aria-label="Insert snippet"]') + ' | inserted after the comment: ' + v.startsWith('// checks\\ntp.test("Status code is 200"') + ' | editor focused: ' + editor().hasTextFocus();`,
  ),
  keys('ctrl-shift-i-again', 'I', ['control', 'shift']),
  step(
    'esc-returns-to-editor',
    `const dlg = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Insert snippet"]'), 2000); if (!dlg) return 'NO QUICK PICK';
     dlg.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(500);
     return 'closed: ' + !document.querySelector('[role=dialog][aria-label="Insert snippet"]') + ' | editor focused: ' + editor().hasTextFocus();`,
  ),
  step(
    'palette-offers-insert-snippet',
    `editor().focus(); await __t.sleep(200);
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
     const dlg = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Command palette"]'), 2000); if (!dlg) return 'NO PALETTE';
     const first = dlg.querySelector('[role=option]')?.textContent.trim();
     dlg.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400);
     return 'first command: ' + first;`,
  ),
  step(
    'pin-persists',
    `pinButton()?.click(); await __t.sleep(500); const now = state();
     await __t.view('Debugger'); await __t.sleep(500);
     if (!(await openRow('POST a JSON body'))) return 'NO ROW'; await subTab('Scripts'); await __t.sleep(800);
     return 'pinned: ' + now + ' | after the view came back: ' + state() + ' | stored: ' + localStorage.getItem('aps.pinnable.scripts.snippets.pinned');`,
  ),
  resize('narrow-window', 760),
  step(
    'narrow-shows-tabs',
    `await __t.sleep(500); return 'layout: ' + layout() + ' | tabs: ' + vis('main [role=tab]').map((t) => t.textContent.trim()).filter((t) => /^(Pre-request|Post-response)/.test(t)).join(',') + ' | packages: ' + !!vis('main button').find((b) => b.textContent.trim() === 'Packages…');`,
  ),
  resize('wide-window', 1440),
  step('wide-shows-column', `await __t.sleep(500); const r = 'layout: ' + layout(); await pickLayout('Auto'); return r;`),
  step(
    'debugger-dock-unpins',
    `await __t.view('Debugger'); await __t.sleep(800);
     const rail = (l) => document.querySelector('[data-tool-rail] button[aria-label="' + l + '"]');
     if (!panel('debugger.dock')) rail('Summary')?.click(); await __t.sleep(400);
     const id = 'debugger.dock'; const pinned = state(id);
     pinButton(id)?.click(); await __t.sleep(500); const unpinned = state(id);
     rail('Timeline')?.click(); await __t.sleep(500);
     const revealed = state(id) + ' dock=' + document.querySelector('main [data-dock]')?.getAttribute('data-dock');
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400); const esc = state(id);
     rail('Timeline')?.click(); await __t.sleep(500); const again = state(id);
     pinButton(id)?.click(); await __t.sleep(500);
     return 'start: ' + pinned + ' | unpinned: ' + unpinned + ' | rail: ' + revealed + ' | Esc: ' + esc + ' | rail again: ' + again + ' | pinned: ' + state(id);`,
  ),
];

module.exports = withExpect(steps, {
  'scripts-tab-pinned': /^pinned=true open=true \| layout: column \| help icon: About scripts \| described: Runs after the response/,
  'unpin-widens-the-editor': /^pinned=false open=false \| wider by >150 \| tab: false \| stored: 0$/,
  'hover-opens-overlay': /^after 100 ms open=false \| pinned=false open=true \| expanded: true \| no layout shift: true \| snippets shown: true$/,
  'insert-closes-overlay': /^pinned=false open=false \| editor has tp\.test: true \| focus on tab: true$/,
  'click-opens-esc-closes': /^click: pinned=false open=true \| Esc: pinned=false open=false \| click outside: pinned=false open=false$/,
  'focus-the-editor': /^focused: true$/,
  'quick-pick-inserts': /^first: Status code: Code is 200.* \| closed: true \| inserted after the comment: true \| editor focused: true$/,
  'esc-returns-to-editor': /^closed: true \| editor focused: true$/,
  'palette-offers-insert-snippet': /^first command: Insert Snippet…/,
  'pin-persists': /^pinned: pinned=true open=true \| after the view came back: pinned=true open=true \| stored: 1$/,
  'narrow-shows-tabs': /^layout: tabs \| tabs: Pre-request,Post-response \| packages: true$/,
  'wide-shows-column': /^layout: column$/,
  'debugger-dock-unpins':
    /^start: pinned=true open=true \| unpinned: pinned=false open=false \| rail: pinned=false open=true dock=timeline \| Esc: pinned=false open=false \| rail again: pinned=false open=true \| pinned: pinned=true open=true$/,
});
