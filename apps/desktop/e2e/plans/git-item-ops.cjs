// Everything under Git, release B (planning/git-everything.md): per-item operations in the real app, with real input. An
// MCP server's menu has History in git…, Stage changes and Discard changes…; History lists the versions and Who changed
// what, Restore this version previews and offers Undo; Discard changes… throws away that server only (another server
// changed in the same file stays); a merge conflict in mcp-servers.json resolves field by field; a commit with a typed
// secret in a staged file is refused with the item and the variable, with no "commit anyway"; changes set aside with a name
// come back. Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const row = (id) => document.querySelector('[data-node-id="' + id + '"]');
  const mark = (id) => row(id)?.querySelector('[data-change-mark]');
  const markText = (id) => { const m = mark(id); return m ? m.getAttribute('data-change-mark') : 'none'; };
  const nameOf = () => short(row('mcp:deepwiki')?.querySelector('.truncate')?.textContent);
  const dialogs = () => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].filter((d) => d.offsetParent !== null || d.getClientRects().length);
  const top = () => dialogs().at(-1);
  const btn = (root, text) => [...(root ?? document).querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === text);
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const menuOf = async (id) => {
    const r = await __t.waitFor(() => row(id)?.querySelector('[data-tree-row]'), 4000); if (!r) return undefined;
    r.scrollIntoView({ block: 'center' }); await __t.sleep(200);
    await __t.real.rightClick(r);
    return __t.waitFor(() => document.querySelector('[role=menu]'), 2000);
  };
  const pick = async (id, startsWith) => {
    const menu = await menuOf(id); if (!menu) return 'NO MENU';
    // the git actions are in the Git submenu
    if (/^(History in git|Stage changes|Discard changes)/.test(startsWith)) {
      const g = [...menu.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Git')); if (!g) return 'NO GIT SUBMENU';
      await __t.real.click(g); await __t.sleep(300);
    }
    const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith(startsWith)); if (!item) return 'NO ITEM ' + startsWith;
    await __t.real.click(item); return 'ok';
  };
  const rename = async (to) => {
    if ((await pick('mcp:deepwiki', 'Rename')) !== 'ok') return 'NO RENAME';
    const field = await __t.waitFor(() => row('mcp:deepwiki')?.querySelector('input'), 2000); if (!field) return 'NO INPUT';
    field.focus(); await __t.real.key('a', { ctrl: true }); await __t.real.type(to); await __t.real.key('Enter');
    return 'ok';
  };
  const typeMessage = (text) => { const ta = document.querySelector('textarea[aria-label="Commit message"]'); if (!ta) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; };
  const changeItems = () => vis('main [data-change-item]');
`;
const s = (name, body) => step(name, body, true, { extra: H, short: 400 });
const mainFile = `const { readFileSync, writeFileSync } = require('node:fs'); const file = require('node:path').join(home, 'ws', 'mcp-servers.json'); const doc = () => JSON.parse(readFileSync(file, 'utf8')); const save = (d) => writeFileSync(file, JSON.stringify(d, null, 2) + '\\n');`;
const gitIn = `const { execFileSync } = require('node:child_process'); const cwd = require('node:path').join(home, 'ws'); const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });`;

const steps = [
  s('repo-init', `await window.aps.invoke('git.init', {}); await window.aps.invoke('git.check'); return 'ready';`),
  // the examples hold demo passwords, which the commit's secret scan refuses for good: the base commits are made with git itself
  ['base-commit', `main:\n      ${gitIn}\n      git('add', '-A'); git('commit', '-m', 'Base');\n      return 'committed';`, false],
  s(
    'rename-the-server',
    `await window.aps.invoke('git.stage', { paths: [] }); await __t.sleep(800); // the app reads git again after a commit made outside it
     await __t.requests();
     if ((await rename('DeepWiki docs')) !== 'ok') return 'NO RENAME';
     const m = await __t.waitFor(() => markText('mcp:deepwiki') !== 'none', 10000);
     return 'name: ' + nameOf() + ' | marked: ' + !!m;`,
  ),
  ['commit-the-rename', `main:\n      ${gitIn}\n      git('add', 'mcp-servers.json'); git('commit', '-m', 'Rename the server');\n      return 'committed';`, false],
  s('row-is-clean', `await window.aps.invoke('git.stage', { paths: [] }); const gone = await __t.waitFor(() => markText('mcp:deepwiki') === 'none', 10000); return 'clean: ' + !!gone + ' | name: ' + nameOf();`),
  s(
    'rename-again',
    `if ((await rename('DeepWiki v3')) !== 'ok') return 'NO RENAME';
     const m = await __t.waitFor(() => markText('mcp:deepwiki') !== 'none' && markText('mcp:deepwiki'), 10000);
     return 'name: ' + nameOf() + ' | mark: ' + m;`,
  ),
  s(
    'menu-has-the-git-group',
    `const menu = await menuOf('mcp:deepwiki'); if (!menu) return 'NO MENU';
     const g = [...menu.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Git')); if (!g) return 'NO GIT SUBMENU';
     await __t.real.click(g); await __t.sleep(300);
     const items = [...document.querySelectorAll('[role=menuitem]')].map((m) => ({ t: m.textContent.trim(), off: m.getAttribute('aria-disabled') === 'true' || m.disabled }));
     await __t.esc();
     const get = (p) => items.find((i) => i.t.startsWith(p));
     return 'history: ' + !!get('History in git') + ' | stage: ' + (get('Stage changes') ? 'enabled=' + !get('Stage changes').off : 'MISSING') + ' | discard: ' + (get('Discard changes') ? 'enabled=' + !get('Discard changes').off : 'MISSING');`,
  ),
  s(
    'history-lists-the-versions',
    `if ((await pick('mcp:deepwiki', 'History in git')) !== 'ok') return 'NO ITEM';
     const d = await __t.waitFor(() => top()?.querySelectorAll('[aria-label=Versions] [data-version]').length >= 2 && top(), 8000); if (!d) return 'NO DIALOG: ' + short(top()?.textContent);
     const lis = [...d.querySelectorAll('[aria-label=Versions] [data-version]')];
     return 'versions: ' + lis.length + ' | newest: ' + short(lis[0].textContent, 80) + ' | oldest: ' + short(lis[1].textContent, 80);`,
  ),
  s(
    'who-changed-what',
    `const d = top(); const blameTab = [...d.querySelectorAll('button, [role=radio]')].find((b) => b.textContent.trim() === 'Who changed what'); if (!blameTab) return 'NO TAB';
     await __t.real.click(blameTab);
     const name = await __t.waitFor(() => d.querySelector('[data-blame-field="Name"]'), 8000); if (!name) return 'NO BLAME';
     const transport = d.querySelector('[data-blame-field="Transport"]');
     return 'name: ' + short(name.textContent, 90) + ' | transport: ' + short(transport?.textContent, 90);`,
  ),
  s(
    'restore-previews-and-can-be-undone',
    `const d = top();
     const versions = [...d.querySelectorAll('button, [role=radio]')].find((b) => b.textContent.trim() === 'Versions'); await __t.real.click(versions);
     const second = await __t.waitFor(() => [...d.querySelectorAll('[aria-label=Versions] [data-version]')][1], 4000); if (!second) return 'NO VERSION';
     await __t.real.click(second);
     await __t.waitFor(() => d.querySelector('[data-history-diff] table, [data-history-diff] [data-part]'), 6000);
     await __t.real.click(btn(d, 'Restore this version'));
     const ask = await __t.waitFor(() => dialogs().length > 1 && top(), 6000); if (!ask) return 'NO PREVIEW';
     const preview = short(ask.textContent, 200);
     await __t.real.click(btn(ask, 'Restore'));
     const done = await __t.waitFor(() => toastText(/^Restored/), 8000);
     const restored = await __t.waitFor(() => nameOf() === 'DeepWiki', 8000);
     const undo = [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Undo'); if (!undo) return 'NO UNDO';
     await __t.real.clickSettled(undo);
     const back = await __t.waitFor(() => nameOf() === 'DeepWiki v3', 8000);
     return 'preview names the part: ' + /Name/.test(preview) + ' | toast: ' + !!done + ' | restored to: ' + !!restored + ' | undone: ' + !!back;`,
  ),
  [
    'another-server-changes-too',
    `main:
      ${mainFile}
      const d = doc(); d.servers.push({ id: 'extra', name: 'Extra', transport: 'http', url: 'https://extra.example.com/mcp' }); save(d);
      return 'servers: ' + doc().servers.map((x) => x.id).join(',');`,
    false,
  ],
  s(
    'discard-only-this-server',
    `await __t.waitFor(() => markText('mcp:extra') !== 'none', 15000);
     if ((await pick('mcp:deepwiki', 'Discard changes')) !== 'ok') return 'NO ITEM';
     // the dialog opens first and says what changes a moment later (the plan is read from git): wait for the text, not just the dialog
     const ask = await __t.waitFor(() => top() && /Discard/.test(top().textContent) && /DeepWiki v3/.test(top().textContent) && top(), 8000); if (!ask) return 'NO PREVIEW: ' + short(top()?.textContent, 200);
     const preview = short(ask.textContent, 220);
     await __t.real.click(btn(ask, 'Discard'));
     const done = await __t.waitFor(() => toastText(/^Discarded/), 8000);
     const back = await __t.waitFor(() => nameOf() === 'DeepWiki docs', 8000);
     return 'preview: ' + /DeepWiki v3/.test(preview) + ' | toast: ' + !!done + ' | back to the committed name: ' + !!back + ' | the other server keeps its change: ' + (markText('mcp:extra') !== 'none');`,
  ),
  s(
    'git-view-row-discards-the-new-server',
    `await __t.view('Git');
     const li = await __t.waitFor(() => changeItems().find((i) => /MCP server Extra/.test(short(i.textContent))), 8000); if (!li) return 'NO ROW: ' + changeItems().map((i) => short(i.textContent, 50)).join(' / ');
     const buttons = [...li.querySelectorAll('button')].map((b) => b.textContent.trim());
     await __t.real.click(btn(li, 'Discard'));
     const ask = await __t.waitFor(() => top() && /Discard/.test(top().textContent) && top(), 6000); if (!ask) return 'NO PREVIEW';
     await __t.real.click(btn(ask, 'Discard'));
     const gone = await __t.waitFor(() => !changeItems().some((i) => /MCP server Extra/.test(short(i.textContent))), 10000);
     return 'buttons: ' + buttons.filter((b) => ['Compare', 'History', 'Discard'].includes(b)).join('+') + ' | row gone: ' + !!gone;`,
  ),
  [
    'a-change-to-discard-whole',
    `main:
      ${mainFile}
      const d = doc(); d.servers.find((x) => x.id === 'deepwiki').name = 'DeepWiki whole file'; save(d);
      return 'written';`,
    false,
  ],
  s(
    'whole-file-discard-can-be-undone',
    `await __t.view('Git');
     const file = await __t.waitFor(() => vis('main [data-change-file="mcp-servers.json"]')[0], 10000); if (!file) return 'NO FILE ROW';
     // the file's own Discard (the item's has data-item-discard)
     const discard = [...file.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Discard' && !b.hasAttribute('data-item-discard')); if (!discard) return 'NO FILE DISCARD';
     await __t.real.click(discard);
     const ask = await __t.waitFor(() => top() && /Throw away the changes to mcp-servers\\.json/.test(top().textContent) && top(), 6000); if (!ask) return 'NO CONFIRM';
     const saysUndo = /Undo puts it back/.test(ask.textContent);
     await __t.real.click(btn(ask, 'Discard'));
     const done = await __t.waitFor(() => toastText(/^Discarded the changes to mcp-servers\\.json/), 8000);
     const gone = await __t.waitFor(() => !vis('main [data-change-file="mcp-servers.json"]')[0], 10000);
     const undo = [...document.querySelectorAll('[data-sonner-toast]')].filter((t) => /^Discarded the changes to mcp-servers/.test(t.textContent.trim())).flatMap((t) => [...t.querySelectorAll('button')]).find((b) => b.textContent.trim() === 'Undo'); if (!undo) return 'NO UNDO';
     await __t.real.clickSettled(undo); // the toasts stack spreads out under the pointer: the click is made where the button ends up
     const back = await __t.waitFor(() => vis('main [data-change-file="mcp-servers.json"]')[0], 10000);
     return 'confirm says undo: ' + saysUndo + ' | toast: ' + !!done + ' | change gone: ' + !!gone + ' | change back after Undo: ' + !!back;`,
  ),
  // (the app reads the repository after a change: a call that meets its lock tries again)
  s('whole-file-discard-for-real', `for (let i = 0; i < 5; i++) { try { await window.aps.invoke('git.discard', { files: [{ path: 'mcp-servers.json', state: 'modified', staged: false }] }); break; } catch (e) { if (i === 4) return 'ERR ' + e.message; await __t.sleep(1000); } } await __t.sleep(800); return 'discarded';`),
  [
    'conflicting-branches',
    `main:
      ${mainFile}
      ${gitIn}
      git('add', '-A'); try { git('commit', '-m', 'Settle'); } catch {}
      git('checkout', '-b', 'theirs');
      let d = doc(); d.servers.find((x) => x.id === 'deepwiki').name = 'DeepWiki Theirs'; save(d); git('commit', '-am', 'Theirs renames it');
      git('checkout', 'main');
      d = doc(); d.servers.find((x) => x.id === 'deepwiki').name = 'DeepWiki Ours'; save(d); git('commit', '-am', 'Ours renames it');
      try { git('merge', 'theirs'); } catch {}
      return git('status', '--porcelain').split('\\n').filter((l) => /^UU/.test(l)).join(' ');`,
    false,
  ],
  s(
    'resolve-field-by-field',
    `await __t.view('Git');
     const panel = await __t.waitFor(() => [...document.querySelectorAll('[role=alert]')].find((a) => /Conflicts/.test(a.textContent)), 10000); if (!panel) return 'NO CONFLICTS';
     await __t.real.click(btn(panel, 'Resolve…'));
     const d = await __t.waitFor(() => top() && top().querySelector('[data-conflict-field]') && top(), 8000); if (!d) return 'NO DIALOG: ' + short(top()?.textContent);
     const fields = [...d.querySelectorAll('[data-conflict-field]')].map((f) => f.getAttribute('data-conflict-field'));
     const theirs = [...d.querySelector('[data-conflict-field]').querySelectorAll('button, [role=radio]')].find((b) => b.textContent.trim() === 'Keep theirs'); await __t.real.click(theirs);
     await __t.real.click(btn(d, 'Resolve with these choices'));
     const done = await __t.waitFor(() => toastText(/resolved/), 8000);
     return 'fields: ' + fields.join(',') + ' | resolved: ' + !!done;`,
  ),
  s(
    'resolving-can-be-undone',
    `await __t.sleep(400);
     const undo = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].filter((t) => /resolved/.test(t.textContent)).flatMap((t) => [...t.querySelectorAll('button')]).find((b) => b.textContent.trim() === 'Undo'), 6000); if (!undo) return 'NO UNDO';
     await __t.real.clickSettled(undo);
     const back = await __t.waitFor(() => [...document.querySelectorAll('[role=alert]')].find((a) => /Conflicts/.test(a.textContent)), 10000);
     return 'conflict is back: ' + !!back;`,
  ),
  [
    'the-index-has-the-conflict-again',
    `main:
      ${gitIn}
      return 'unmerged entries: ' + git('ls-files', '-u').trim().split('\\n').filter(Boolean).length;`,
    false,
  ],
  s(
    'no-choice-asks-first',
    `const panel = await __t.waitFor(() => [...document.querySelectorAll('[role=alert]')].find((a) => /Conflicts/.test(a.textContent)), 10000); if (!panel) return 'NO CONFLICTS';
     await __t.real.click(btn(panel, 'Resolve…'));
     const d = await __t.waitFor(() => top() && top().querySelector('[data-conflict-field]') && top(), 8000); if (!d) return 'NO DIALOG';
     const counter = d.querySelector('[data-conflict-count]')?.textContent ?? '';
     await __t.real.click(btn(d, 'Resolve with these choices'));
     const ask = await __t.waitFor(() => dialogs().length > 1 && top(), 6000); if (!ask) return 'NO CONFIRM';
     const titled = /Keep all of mine/.test(ask.textContent);
     await __t.real.click(btn(ask, 'Cancel'));
     await __t.sleep(400);
     // choosing makes the same button go straight through
     const theirs = [...d.querySelector('[data-conflict-field]').querySelectorAll('button, [role=radio]')].find((b) => b.textContent.trim() === 'Keep theirs'); await __t.real.click(theirs);
     await __t.real.click(btn(d, 'Resolve with these choices'));
     const done = await __t.waitFor(() => toastText(/resolved/), 8000);
     return 'counter says nothing chosen: ' + /nothing chosen yet/.test(counter) + ' | asked first: ' + titled + ' | resolved after choosing: ' + !!done;`,
  ),
  [
    'the-file-has-their-name',
    `main:
      ${mainFile}
      ${gitIn}
      const unmerged = git('ls-files', '-u').trim();
      git('commit', '-m', 'Merge theirs');
      return 'name: ' + doc().servers.find((x) => x.id === 'deepwiki').name + ' | unmerged left: ' + (unmerged ? 'yes' : 'no');`,
    false,
  ],
  [
    'a-secret-is-staged',
    `main:
      ${mainFile}
      const d = doc(); d.servers.push({ id: 'authed', name: 'Authed', transport: 'http', url: 'https://authed.example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] }); save(d);
      return 'written';`,
    false,
  ],
  s(
    'commit-is-refused-with-the-item-and-the-variable',
    `await __t.view('Git');
     await __t.waitFor(() => changeItems().some((i) => /MCP server Authed/.test(short(i.textContent))), 10000);
     if (!typeMessage('Add the authed server')) return 'NO INPUT';
     await __t.sleep(300);
     await __t.real.click(btn(document.querySelector('main'), 'Commit'));
     const guard = await __t.waitFor(() => document.querySelector('[data-staged-secrets]'), 8000); if (!guard) return 'NOT BLOCKED';
     const text = short(guard.textContent, 400);
     return 'blocked: ' + /Not committed: 1 secret/.test(text) + ' | names the item: ' + /MCP server Authed/.test(text) + ' | variable: ' + /\\{\\{AUTHED_AUTHORIZATION\\}\\}/.test(text) + ' | commit anyway offered: ' + !!btn(guard, 'Commit anyway…') + ' | value shown: ' + /abcdef0123456789/.test(guard.textContent);`,
  ),
  [
    'fix-by-hand',
    `main:
      ${mainFile}
      const d = doc(); d.servers.find((x) => x.id === 'authed').headers[0].value = '{{AUTHED_AUTHORIZATION}}'; save(d);
      return 'fixed';`,
    false,
  ],
  s(
    'commit-goes-through',
    `await __t.sleep(1200);
     await __t.real.click(btn(document.querySelector('main'), 'Commit'));
     const done = await __t.waitFor(() => toastText(/^Committed/), 10000);
     return done ? 'committed' : 'NOT COMMITTED: ' + short(document.querySelector('[data-staged-secrets]')?.textContent, 200);`,
  ),
  [
    'a-change-to-set-aside',
    `main:
      ${mainFile}
      const d = doc(); d.servers.find((x) => x.id === 'authed').name = 'Authed (draft)'; save(d);
      return 'written';`,
    false,
  ],
  s(
    'set-aside-and-put-back',
    `await __t.waitFor(() => changeItems().some((i) => /MCP server Authed/.test(short(i.textContent))), 10000);
     const set = await __t.waitFor(() => btn(document.querySelector('main'), 'Set changes aside…'), 4000); if (!set) return 'NO BUTTON';
     await __t.real.click(set);
     const ask = await __t.waitFor(() => top()?.querySelector('input, textarea') && top(), 6000); if (!ask) return 'NO PROMPT';
     ask.querySelector('input, textarea').focus(); await __t.real.type('Before the rewrite');
     await __t.real.click(btn(ask, 'Set aside'));
     const listed = await __t.waitFor(() => document.querySelector('[data-stash="Before the rewrite"]'), 8000); if (!listed) return 'NOT LISTED';
     const clean = await __t.waitFor(() => !changeItems().length, 8000);
     await __t.real.click(btn(listed, 'Put back'));
     const back = await __t.waitFor(() => changeItems().some((i) => /MCP server Authed/.test(short(i.textContent))), 10000);
     const gone = await __t.waitFor(() => !document.querySelector('[data-stash="Before the rewrite"]'), 6000);
     return 'listed: true | workspace clean while set aside: ' + !!clean + ' | change back: ' + !!back + ' | entry removed: ' + !!gone;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'repo-init': /^ready$/,
    'base-commit': /^committed$/,
    'rename-the-server': /^name: DeepWiki docs \| marked: true$/,
    'commit-the-rename': /^committed$/,
    'row-is-clean': /^clean: true \| name: DeepWiki docs$/,
    'rename-again': /^name: DeepWiki v3 \| mark: [A-Z]$/,
    'menu-has-the-git-group': /^history: true \| stage: enabled=true \| discard: enabled=true$/,
    'history-lists-the-versions': /^versions: 2 \| newest: .*Rename the server.*Name.* \| oldest: .*Base.*$/,
    'who-changed-what': /^name: .*not committed yet.* \| transport: .*E2E.*Base.*$/,
    'restore-previews-and-can-be-undone': /^preview names the part: true \| toast: true \| restored to: true \| undone: true$/,
    'another-server-changes-too': /^servers: .*extra$/,
    'discard-only-this-server': /^preview: true \| toast: true \| back to the committed name: true \| the other server keeps its change: true$/,
    'git-view-row-discards-the-new-server': /^buttons: Compare\+History\+Discard \| row gone: true$/,
    'conflicting-branches': /^UU mcp-servers\.json$/,
    'resolve-field-by-field': /^fields: item:deepwiki#name \| resolved: true$/,
    'resolving-can-be-undone': /^conflict is back: true$/,
    'the-index-has-the-conflict-again': /^unmerged entries: [1-9]\d*$/,
    'no-choice-asks-first': /^counter says nothing chosen: true \| asked first: true \| resolved after choosing: true$/,
    'a-change-to-discard-whole': /^written$/,
    'whole-file-discard-can-be-undone': /^confirm says undo: true \| toast: true \| change gone: true \| change back after Undo: true$/,
    'whole-file-discard-for-real': /^discarded$/,
    'the-file-has-their-name': /^name: DeepWiki Theirs \| unmerged left: no$/,
    'a-secret-is-staged': /^written$/,
    'commit-is-refused-with-the-item-and-the-variable': /^blocked: true \| names the item: true \| variable: true \| commit anyway offered: false \| value shown: false$/,
    'fix-by-hand': /^fixed$/,
    'commit-goes-through': /^committed$/,
    'a-change-to-set-aside': /^written$/,
    'set-aside-and-put-back': /^listed: true \| workspace clean while set aside: true \| change back: true \| entry removed: true$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
