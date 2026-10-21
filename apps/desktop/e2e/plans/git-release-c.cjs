// Everything under Git, release C (planning/git-everything.md): Fix git setup (a banner offers it, the dialog previews every step
// before anything is written, Fix applies them, Undo puts the files back), the readable-diff driver in plain `git diff`, kind
// filter chips in the Git view, staging one item of a file by its own click, a big dataset offered Git LFS or "by reference",
// Share session from the Debugger, the staged secret scan's Allow… (with a reason, committed) and its one-click Fix, and a
// starter CODEOWNERS. Real input for every click and every typed word; the outside changes (files, git) are made as another
// program would. Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const dialogs = () => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].filter((d) => d.offsetParent !== null || d.getClientRects().length);
  const top = () => dialogs().at(-1);
  const btn = (root, text) => [...(root ?? document).querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim().startsWith(text));
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const typeMessage = (text) => { const ta = document.querySelector('textarea[aria-label="Commit message"]'); if (!ta) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; };
  // a real click needs the element on screen: the Git view is longer than the window
  const press = async (el) => { el.scrollIntoView({ block: 'center' }); await __t.sleep(200); await __t.real.click(el); };
  const changeItems = () => vis('main [data-change-item]');
  const itemRow = (re) => changeItems().find((i) => re.test(short(i.textContent)));
  const askText = async (what, text, okLabel) => {
    const ask = await __t.waitFor(() => top()?.querySelector('input, textarea') && top(), 6000); if (!ask) return 'NO PROMPT ' + what;
    ask.querySelector('input, textarea').focus(); await __t.real.type(text);
    await __t.real.click(btn(ask, okLabel)); return 'ok';
  };
`;
const s = (name, body) => step(name, body, true, { extra: H, short: 400 });
const inWs = `const { execFileSync } = require('node:child_process'); const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs'); const path = require('node:path'); const ws = path.join(home, 'ws'); const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' }); const servers = () => JSON.parse(readFileSync(path.join(ws, 'mcp-servers.json'), 'utf8')); const saveServers = (d) => writeFileSync(path.join(ws, 'mcp-servers.json'), JSON.stringify(d, null, 2) + '\\n');`;

const steps = [
  s('repo-init', `await window.aps.invoke('git.init', {}); return 'ready';`),
  // an older workspace: the attributes of the version before release C (no diff driver), a base commit made with git itself
  // (the examples hold demo passwords, which the commit's secret scan refuses for good)
  [
    'an-older-workspace',
    `main:
      ${inWs}
      writeFileSync(path.join(ws, '.gitattributes'), '# TestPion: the same line endings on Windows, macOS and Linux\\n* text=auto eol=lf\\n*.png binary\\n*.jpg binary\\n*.sqlite binary\\ncollections/*.json merge=testpion\\n');
      const env = path.join(ws, 'environments', 'public.json'); const e = JSON.parse(readFileSync(env, 'utf8'));
      writeFileSync(env, JSON.stringify({ variables: e.variables, name: e.name, id: e.id, color: e.color }, null, 4).replace(/\\n/g, '\\r\\n'));
      git('add', '-A'); git('commit', '-m', 'Base');
      return 'committed | diff driver in attributes: ' + /diff=testpion/.test(readFileSync(path.join(ws, '.gitattributes'), 'utf8'));`,
    false,
  ],
  s(
    'the-git-view-offers-the-fix',
    `await window.aps.invoke('git.stage', { paths: [] }); await __t.view('Git');
     const banner = await __t.waitFor(() => document.querySelector('[data-fix-banner]'), 15000); if (!banner) return 'NO BANNER';
     return 'banner: ' + short(banner.textContent, 160);`,
  ),
  s(
    'the-dialog-previews-every-step',
    `const banner = document.querySelector('[data-fix-banner]');
     await __t.real.click(btn(banner, 'Fix git setup'));
     const d = await __t.waitFor(() => top()?.querySelector('[data-fix-dialog]') && top(), 8000); if (!d) return 'NO DIALOG';
     const steps = [...d.querySelectorAll('[data-fix-step]')].map((x) => x.getAttribute('data-fix-step') + ':' + x.getAttribute('data-fix-state'));
     const rewritten = d.querySelector('[data-fix-rewritten]')?.textContent ?? '';
     return 'steps: ' + steps.join(',') + ' | files to rewrite: ' + /(\\d+) files? will be rewritten/.exec(rewritten)?.[1] + ' | apply: ' + short(d.querySelector('[data-fix-apply]')?.textContent, 40);`,
  ),
  [
    'nothing-is-written-before-fix',
    `main:
      ${inWs}
      return 'attributes: ' + (/diff=testpion/.test(readFileSync(path.join(ws, '.gitattributes'), 'utf8')) ? 'CHANGED' : 'unchanged') + ' | environment CRLF: ' + /\\r\\n/.test(readFileSync(path.join(ws, 'environments', 'public.json'), 'utf8')) + ' | config: ' + (() => { try { return git('config', '--local', '--get', 'diff.testpion.textconv').trim() || 'none'; } catch { return 'none'; } })();`,
    false,
  ],
  s(
    'fix-applies-and-says-so',
    `const d = top(); await __t.real.click(d.querySelector('[data-fix-apply]'));
     const done = await __t.waitFor(() => [...top().querySelectorAll('[data-fix-step][data-fix-state=todo]')].length && [...top().querySelectorAll('[data-fix-step]')].some((x) => /Done/.test(x.textContent)) && top(), 20000); if (!done) return 'NOT APPLIED: ' + short(top()?.textContent, 200);
     const toast = await __t.waitFor(() => toastText(/Fixed git setup/), 6000);
     return 'done steps: ' + [...top().querySelectorAll('[data-fix-step]')].filter((x) => /Done/.test(x.textContent)).length + ' | toast: ' + !!toast + ' | undo offered: ' + !!btn(top(), 'Undo');`,
  ),
  [
    'the-files-are-in-the-stable-format',
    `main:
      ${inWs}
      const attrs = readFileSync(path.join(ws, '.gitattributes'), 'utf8'); const env = readFileSync(path.join(ws, 'environments', 'public.json'), 'utf8');
      return 'diff driver line: ' + /collections\\/\\*\\.json merge=testpion diff=testpion/.test(attrs) + ' | environment LF: ' + !/\\r\\n/.test(env) + ' | key order: ' + Object.keys(JSON.parse(env)).slice(0, 3).join(',') + ' | merge driver: ' + git('config', '--local', '--get', 'merge.testpion.driver').trim().length + ' | textconv: ' + /--textconv/.test(git('config', '--local', '--get', 'diff.testpion.textconv'));`,
    false,
  ],
  s(
    'undo-puts-the-files-back',
    `await __t.real.click(btn(top(), 'Undo'));
     const toast = await __t.waitFor(() => toastText(/Put back as it was/), 8000);
     await __t.sleep(500);
     return 'toast: ' + !!toast;`,
  ),
  [
    'the-old-files-are-back',
    `main:
      ${inWs}
      return 'diff driver line: ' + /diff=testpion/.test(readFileSync(path.join(ws, '.gitattributes'), 'utf8')) + ' | environment CRLF again: ' + /\\r\\n/.test(readFileSync(path.join(ws, 'environments', 'public.json'), 'utf8'));`,
    false,
  ],
  s(
    'fix-again-and-the-banner-goes',
    `await __t.view('Git'); await __t.sleep(500);
     const banner = await __t.waitFor(() => document.querySelector('[data-fix-banner]'), 15000); if (!banner) return 'NO BANNER';
     await __t.real.click(btn(banner, 'Fix git setup'));
     const d = await __t.waitFor(() => top()?.querySelector('[data-fix-apply]') && !top().querySelector('[data-fix-apply]').disabled && top(), 8000); if (!d) return 'NO DIALOG';
     await __t.real.click(d.querySelector('[data-fix-apply]'));
     await __t.waitFor(() => [...top().querySelectorAll('[data-fix-step]')].some((x) => /Done/.test(x.textContent)), 20000);
     await __t.real.click(btn(top(), 'Close'));
     const gone = await __t.waitFor(() => !document.querySelector('[data-fix-banner]'), 20000);
     return 'banner gone: ' + !!gone;`,
  ),
  // the tidy commit the dialog suggests (the examples hold demo passwords, which the app's commit refuses for good: made with git itself)
  [
    'commit-the-stable-files',
    `main:
      ${inWs}
      git('add', '-A'); git('commit', '-m', 'TestPion: stable files');
      return 'committed | left: ' + git('status', '--porcelain').trim().length;`,
    false,
  ],
  [
    'stage-and-diff-are-readable',
    `main:
      ${inWs}
      const d = servers(); d.servers.find((x) => x.id === 'deepwiki').url = 'https://mcp.deepwiki.com/v2'; saveServers(d);
      const diff = execFileSync('git', ['diff', '--no-color', '--', 'mcp-servers.json'], { cwd: ws, encoding: 'utf8', timeout: 60000 });
      return 'hunk names the item: ' + /@@ .* @@ MCP servers ▸ DeepWiki \\[MCP server deepwiki\\]/.test(diff) + ' | only the changed item: ' + !/Petstore MCP/.test(diff.split('\\n').filter((l) => /^[+-]/.test(l)).join('\\n'));`,
    false,
  ],
  [
    'two-kinds-changed-outside',
    `main:
      ${inWs}
      const f = path.join(ws, 'datasets', 'intents.jsonl'); writeFileSync(f, readFileSync(f, 'utf8').trimEnd() + '\\n{"input":"extra","expected":"x"}\\n');
      const d = servers(); d.servers.find((x) => x.id === 'petstore-mcp').name = 'Petstore MCP v2'; saveServers(d);
      return 'written';`,
    false,
  ],
  s(
    'kind-chips-filter-the-changes',
    `await __t.view('Git');
     await __t.waitFor(() => changeItems().some((i) => /Dataset/.test(short(i.textContent))) && changeItems().some((i) => /MCP server/.test(short(i.textContent))), 15000);
     const chips = vis('[data-filter-chips] button').map((b) => short(b.textContent, 30));
     const chip = vis('[data-filter-chips] button').find((b) => /^MCP server/.test(b.textContent.trim())); if (!chip) return 'NO CHIP: ' + chips.join(' / ');
     await __t.real.click(chip);
     const only = await __t.waitFor(() => changeItems().length && changeItems().every((i) => /MCP server/.test(short(i.textContent))), 6000);
     const all = vis('[data-filter-chips] button').find((b) => b.textContent.trim() === 'All'); await __t.real.click(all);
     const back = await __t.waitFor(() => changeItems().some((i) => /Dataset/.test(short(i.textContent))), 6000);
     return 'chips: ' + chips.join(' / ') + ' | only MCP servers: ' + !!only + ' | all again: ' + !!back;`,
  ),
  s(
    'stage-one-item-of-a-file',
    `const row = await __t.waitFor(() => itemRow(/MCP server DeepWiki/), 8000); if (!row) return 'NO ROW';
     await __t.real.click(row.querySelector('[data-item-stage]'));
     const staged = await __t.waitFor(() => itemRow(/MCP server DeepWiki/)?.hasAttribute('data-item-staged'), 8000);
     const other = itemRow(/MCP server Petstore/);
     const partly = vis('main [data-change-file="mcp-servers.json"]')[0]?.textContent.includes('partly staged');
     return 'deepwiki staged: ' + !!staged + ' | petstore staged: ' + other?.hasAttribute('data-item-staged') + ' | file badge: ' + (partly ? 'partly staged' : short(vis('main [data-change-file="mcp-servers.json"]')[0]?.textContent, 80));`,
  ),
  [
    'only-that-item-is-in-the-index',
    `main:
      ${inWs}
      const staged = JSON.parse(git('show', ':mcp-servers.json')).servers; const work = servers().servers;
      return 'index deepwiki url: ' + staged.find((x) => x.id === 'deepwiki').url + ' | index petstore name: ' + staged.find((x) => x.id === 'petstore-mcp').name + ' | working petstore name: ' + work.find((x) => x.id === 'petstore-mcp').name;`,
    false,
  ],
  s(
    'commit-takes-just-the-staged-item',
    `if (!typeMessage('DeepWiki v2')) return 'NO INPUT';
     await __t.sleep(300);
     await press(btn(document.querySelector('main'), 'Commit'));
     const done = await __t.waitFor(() => toastText(/^Committed/), 12000);
     return done ? 'committed' : 'NOT COMMITTED: ' + short(document.querySelector('[data-staged-secrets]')?.textContent, 200);`,
  ),
  [
    'the-other-change-is-still-waiting',
    `main:
      ${inWs}
      const committed = JSON.parse(git('show', 'HEAD:mcp-servers.json')).servers;
      return 'HEAD deepwiki: ' + committed.find((x) => x.id === 'deepwiki').url + ' | HEAD petstore: ' + committed.find((x) => x.id === 'petstore-mcp').name + ' | still changed: ' + /mcp-servers.json/.test(git('status', '--porcelain'));`,
    false,
  ],
  // a big dataset (52 MB), made outside the app
  [
    'a-big-dataset',
    `main:
      ${inWs}
      const f = path.join(ws, 'datasets', 'big-data.csv'); const line = 'id,name,notes\\n'; const row = '1,Ada,' + 'x'.repeat(90) + '\\n';
      const parts = [line]; let size = line.length; while (size < 52 * 1048576) { parts.push(row.repeat(10000)); size += row.length * 10000; }
      writeFileSync(f, parts.join(''));
      return Math.round(size / 1048576) + ' MB';`,
    false,
  ],
  s(
    'git-view-offers-lfs-or-a-reference',
    `const offer = await __t.waitFor(() => document.querySelector('[data-large-offer]'), 20000); if (!offer) return 'NO OFFER';
     const row = offer.querySelector('[data-large-file="datasets/big-data.csv"]'); if (!row) return 'NO ROW';
     return 'offer: ' + short(offer.querySelector('.font-medium')?.textContent, 80) + ' | buttons: ' + [...row.querySelectorAll('button')].map((b) => b.textContent.trim()).join('+');`,
  ),
  s(
    'track-by-reference-with-a-preview',
    `const row = document.querySelector('[data-large-file="datasets/big-data.csv"]');
     await press(row.querySelector('[data-large-reference]'));
     if ((await askText('source', 's3://team-data/big-data.csv', 'Continue')) !== 'ok') return 'NO PROMPT';
     const ask = await __t.waitFor(() => top() && /Track .* by reference/.test(top().textContent) && top(), 15000); if (!ask) return 'NO PREVIEW: ' + short(top()?.textContent, 200);
     const preview = short(ask.textContent, 360);
     await __t.real.click(btn(ask, 'Track by reference'));
     const toast = await __t.waitFor(() => toastText(/tracked by reference/), 20000);
     const gone = await __t.waitFor(() => !document.querySelector('[data-large-offer]'), 15000);
     return 'preview names the files: ' + (/big-data\\.csv\\.ref/.test(preview) && /\\.gitignore/.test(preview)) + ' | toast: ' + !!toast + ' | offer gone: ' + !!gone;`,
  ),
  [
    'the-reference-is-written',
    `main:
      ${inWs}
      const ref = JSON.parse(readFileSync(path.join(ws, 'datasets', 'big-data.csv.ref'), 'utf8'));
      return 'ref: ' + ref.name + ' ' + ref.bytes + ' bytes sha256 ' + (ref.sha256.length) + ' source ' + ref.source + ' | ignored: ' + (git('check-ignore', 'datasets/big-data.csv').trim() === 'datasets/big-data.csv') + ' | data still on disk: ' + existsSync(path.join(ws, 'datasets', 'big-data.csv'));`,
    false,
  ],
  // a saved Debugger session with a token that capture did not mask
  [
    'a-saved-debugger-session',
    `main:
      ${inWs}
      mkdirSync(path.join(ws, 'debugger'), { recursive: true });
      const har = { log: { version: '1.2', creator: { name: 'TestPion', version: '0' }, entries: [{ startedDateTime: '2026-01-01T00:00:00.000Z', time: 5, request: { method: 'GET', url: 'https://api.example.com/x', httpVersion: 'HTTP/1.1', headers: [{ name: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }, { name: 'Accept', value: 'application/json' }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 }, response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: 'application/json' }, redirectURL: '', headersSize: -1, bodySize: 0 }, cache: {}, timings: { send: 0, wait: 5, receive: 0 } }] } };
      writeFileSync(path.join(ws, 'debugger', 'e2e capture.har'), JSON.stringify(har, null, 2));
      return 'saved';`,
    false,
  ],
  s('share-preview-answers', `const r = await window.aps.invoke('git.shareSession', { name: 'e2e capture', dryRun: true }); return 'to: ' + r.to + ' | masked: ' + r.masked + ' | applied: ' + r.applied;`),
  s(
    'share-session-from-the-debugger',
    `await __t.view('Debugger'); await __t.sleep(800);
     const trigger = await __t.waitFor(() => vis('button').find((b) => /Save, open, import and export sessions/.test(b.getAttribute('title') ?? '')), 8000); if (!trigger) return 'NO BUTTON';
     await __t.real.click(trigger);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Share e2e capture with the team…'), 4000); if (!item) return 'NO MENU';
     await __t.real.click(item);
     const ask = await __t.waitFor(() => top() && /Share session/.test(top().textContent) && top(), 6000); if (!ask) return 'NO PREVIEW: toasts ' + [...document.querySelectorAll('[data-sonner-toast]')].map((t) => short(t.textContent, 100)).join(' / ') + ' | dialog ' + short(top()?.textContent, 100);
     const preview = short(ask.textContent, 300);
     await __t.real.click(btn(ask, 'Share'));
     const toast = await __t.waitFor(() => toastText(/^Shared e2e capture/), 8000);
     return 'preview: ' + /debugger\\/shared\\/e2e capture\\.har/.test(preview) + ' | masked more: ' + /had not masked/.test(preview) + ' | toast: ' + !!toast;`,
  ),
  [
    'the-copy-is-masked-and-tracked',
    `main:
      ${inWs}
      const copy = readFileSync(path.join(ws, 'debugger', 'shared', 'e2e capture.har'), 'utf8'); const orig = readFileSync(path.join(ws, 'debugger', 'e2e capture.har'), 'utf8');
      const st = git('status', '--porcelain', '--untracked-files=all');
      return 'copy has the token: ' + /abcdef0123456789/.test(copy) + ' | original has it: ' + /abcdef0123456789/.test(orig) + ' | shared copy in git status: ' + /debugger\\/shared\\/e2e capture\\.har/.test(st) + ' | session ignored: ' + !/\\?\\? debugger\\/e2e capture\\.har/.test(st);`,
    false,
  ],
  // the secret scan: a typed token is allowed, with a reason
  [
    'a-token-in-a-new-server',
    `main:
      ${inWs}
      const d = servers(); d.servers.push({ id: 'authed', name: 'Authed', transport: 'http', url: 'https://authed.example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] }); saveServers(d);
      return 'written';`,
    false,
  ],
  s(
    'commit-is-refused-and-allow-is-offered',
    `await __t.view('Git');
     await __t.waitFor(() => itemRow(/MCP server Authed/), 15000);
     if (!typeMessage('Add the authed server')) return 'NO INPUT';
     await __t.sleep(300);
     await press(btn(document.querySelector('main'), 'Commit'));
     const guard = await __t.waitFor(() => document.querySelector('[data-staged-secrets]'), 10000); if (!guard) return 'NOT BLOCKED';
     return 'blocked: ' + /Not committed/.test(guard.textContent) + ' | allow: ' + !!guard.querySelector('[data-secret-allow]') + ' | fix all: ' + !!guard.querySelector('[data-secrets-fix]');`,
  ),
  s(
    'allow-needs-a-reason-and-lets-it-through',
    `const guard = document.querySelector('[data-staged-secrets]');
     await press(guard.querySelector('[data-secret-allow]'));
     if ((await askText('reason', 'a public test key from the docs', 'Allow')) !== 'ok') return 'NO PROMPT';
     const gone = await __t.waitFor(() => !document.querySelector('[data-staged-secrets]'), 12000);
     await press(btn(document.querySelector('main'), 'Commit'));
     const done = await __t.waitFor(() => toastText(/^Committed/), 15000);
     return 'panel gone: ' + !!gone + ' | committed: ' + !!done;`,
  ),
  [
    'the-allowlist-is-committed-without-the-value',
    `main:
      ${inWs}
      const f = path.join(ws, '.testpion', 'secrets-allow.json'); const text = readFileSync(f, 'utf8'); const tracked = git('ls-files', '.testpion/secrets-allow.json').trim();
      return 'entries: ' + JSON.parse(text).allow.length + ' | reason: ' + /public test key/.test(text) + ' | has the value: ' + /abcdef0123456789/.test(text) + ' | committed: ' + (tracked === '.testpion/secrets-allow.json');`,
    false,
  ],
  // the one-click fix for an MCP server
  [
    'another-token',
    `main:
      ${inWs}
      const d = servers(); d.servers.push({ id: 'authed2', name: 'Authed two', transport: 'http', url: 'https://authed2.example.com/mcp', headers: [{ key: 'X-Api-Key', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] }); saveServers(d);
      return 'written';`,
    false,
  ],
  s(
    'fix-all-moves-it-to-a-secret-variable',
    `await __t.waitFor(() => itemRow(/MCP server Authed two/), 15000);
     if (!typeMessage('Add authed two')) return 'NO INPUT';
     await __t.sleep(300);
     await press(btn(document.querySelector('main'), 'Commit'));
     const guard = await __t.waitFor(() => document.querySelector('[data-staged-secrets]'), 10000); if (!guard) return 'NOT BLOCKED';
     await press(guard.querySelector('[data-secrets-fix]'));
     const toast = await __t.waitFor(() => toastText(/moved to secret variables|Choose the environment/), 12000);
     return 'toast: ' + short(toast, 140);`,
  ),
  [
    'the-file-has-a-variable-not-the-value',
    `main:
      ${inWs}
      const h = servers().servers.find((x) => x.id === 'authed2').headers[0].value;
      return 'header: ' + (/^\\{\\{\\w+\\}\\}$/.test(h) ? 'variable' : 'VALUE ' + h) + ' | token in file: ' + /ghp_abcdefghij/.test(readFileSync(path.join(ws, 'mcp-servers.json'), 'utf8'));`,
    false,
  ],
  s(
    'commit-goes-through-after-the-fix',
    `// the fix also made a secret variable in the environment file, whose demo passwords the commit refuses: stage just the server's file
     const file = await __t.waitFor(() => document.querySelector('[data-change-file="mcp-servers.json"]'), 8000); if (!file) return 'NO ROW';
     await press([...file.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stage'));
     await __t.sleep(1000);
     await press(btn(document.querySelector('main'), 'Commit'));
     const done = await __t.waitFor(() => toastText(/^Committed/), 15000);
     return done ? 'committed' : 'NOT COMMITTED: ' + short(document.querySelector('[data-staged-secrets]')?.textContent, 200);`,
  ),
  // CODEOWNERS
  s(
    'codeowners-from-the-git-menu',
    `await __t.view('Git');
     const more = await __t.waitFor(() => vis('[aria-label="More actions"]')[0], 6000); if (!more) return 'NO BUTTON';
     await __t.real.click(more);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Create CODEOWNERS')), 4000); if (!item) return 'NO MENU';
     await __t.real.click(item);
     const d = await __t.waitFor(() => top()?.querySelector('[data-codeowners]') && top(), 8000); if (!d) return 'NO DIALOG';
     const input = d.querySelector('input'); input.focus(); await __t.real.type('@acme/platform');
     await __t.waitFor(() => /@acme\\/platform/.test(d.querySelector('pre')?.textContent ?? ''), 6000);
     const text = d.querySelector('pre').textContent;
     await __t.real.click(d.querySelector('[data-codeowners-write]'));
     const toast = await __t.waitFor(() => toastText(/Wrote/), 8000);
     return 'lines: ' + (/\\/environments\\/\\s+@acme\\/platform/.test(text) && /\\/mcp-servers\\.json\\s+@acme\\/platform/.test(text)) + ' | toast: ' + !!toast;`,
  ),
  [
    'codeowners-is-in-the-repository',
    `main:
      ${inWs}
      const f = path.join(ws, '.github', 'CODEOWNERS'); return 'exists: ' + existsSync(f) + ' | owner: ' + /@acme\\/platform/.test(readFileSync(f, 'utf8'));`,
    false,
  ],
];

module.exports = withExpect(
  steps,
  {
    'repo-init': /^ready$/,
    'an-older-workspace': /^committed \| diff driver in attributes: false$/,
    'the-git-view-offers-the-fix': /^banner: Git setup is not complete: \d+ things? to fix/,
    'the-dialog-previews-every-step': /^steps: .*gitattributes:todo.*(merge-driver:todo).*diff-driver:todo.* \| files to rewrite: \d+ \| apply: Fix \d+ things?$|^steps: .*gitattributes:todo.*stable-format:todo/,
    'nothing-is-written-before-fix': /^attributes: unchanged \| environment CRLF: true \| config: none$/,
    'fix-applies-and-says-so': /^done steps: [1-9]\d* \| toast: true \| undo offered: true$/,
    'the-files-are-in-the-stable-format': /^diff driver line: true \| environment LF: true \| key order: id,name,color \| merge driver: [1-9]\d* \| textconv: true$/,
    'undo-puts-the-files-back': /^toast: true$/,
    'the-old-files-are-back': /^diff driver line: false \| environment CRLF again: true$/,
    'fix-again-and-the-banner-goes': /^banner gone: true$/,
    'commit-the-stable-files': /^committed \| left: 0$/,
    'stage-and-diff-are-readable': /^hunk names the item: true \| only the changed item: true$/,
    'two-kinds-changed-outside': /^written$/,
    'kind-chips-filter-the-changes': /^chips: All \/ .*Dataset.* \| only MCP servers: true \| all again: true$/,
    'stage-one-item-of-a-file': /^deepwiki staged: true \| petstore staged: false \| file badge: partly staged$/,
    'only-that-item-is-in-the-index': /^index deepwiki url: https:\/\/mcp\.deepwiki\.com\/v2 \| index petstore name: Petstore MCP \| working petstore name: Petstore MCP v2$/,
    'commit-takes-just-the-staged-item': /^committed$/,
    'the-other-change-is-still-waiting': /^HEAD deepwiki: https:\/\/mcp\.deepwiki\.com\/v2 \| HEAD petstore: Petstore MCP \| still changed: true$/,
    'a-big-dataset': /^5\d MB$/,
    'git-view-offers-lfs-or-a-reference': /^offer: 1 big file is over the limit for plain git \| buttons: Move to large-file storage \(Git LFS\)…\+Keep out of git, share by link…$/,
    'track-by-reference-with-a-preview': /^preview names the files: true \| toast: true \| offer gone: true$/,
    'the-reference-is-written': /^ref: big-data\.csv \d+ bytes sha256 64 source s3:\/\/team-data\/big-data\.csv \| ignored: true \| data still on disk: true$/,
    'a-saved-debugger-session': /^saved$/,
    'share-preview-answers': /^to: debugger\/shared\/e2e capture\.har \| masked: true \| applied: false$/,
    'share-session-from-the-debugger': /^preview: true \| masked more: true \| toast: true$/,
    'the-copy-is-masked-and-tracked': /^copy has the token: false \| original has it: true \| shared copy in git status: true \| session ignored: true$/,
    'a-token-in-a-new-server': /^written$/,
    'commit-is-refused-and-allow-is-offered': /^blocked: true \| allow: true \| fix all: true$/,
    'allow-needs-a-reason-and-lets-it-through': /^panel gone: true \| committed: true$/,
    'the-allowlist-is-committed-without-the-value': /^entries: 1 \| reason: true \| has the value: false \| committed: true$/,
    'another-token': /^written$/,
    'fix-all-moves-it-to-a-secret-variable': /^toast: .*moved to secret variables/,
    'the-file-has-a-variable-not-the-value': /^header: variable \| token in file: false$/,
    'commit-goes-through-after-the-fix': /^committed$/,
    'codeowners-from-the-git-menu': /^lines: true \| toast: true$/,
    'codeowners-is-in-the-repository': /^exists: true \| owner: true$/,
  },
);
