import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// scripted repositories spawn many git processes: slow machines (CI, parallel runs) need room
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MemorySecretStore,
  Redactor,
  addressOf,
  allowSalt,
  allowSecret,
  attributesText,
  changeKind,
  checkReferences,
  commitVerdict,
  describeFile,
  disallowSecret,
  findLargeFiles,
  fixGitSetup,
  fixStagedFiles,
  gitChangesByItem,
  gitSetupTextconv,
  gitStatus,
  ignoreText,
  itemHistory,
  largeLevel,
  listSharedSessions,
  planCodeowners,
  readSecretsAllow,
  runGit,
  scanFileText,
  secretFingerprint,
  scanStagedSecrets,
  shareSession,
  stageItem,
  textconvText,
  trackByReference,
  trackWithLfs,
  undoJournal,
  unshareSession,
  writeCodeowners,
  gitStage,
  GITIGNORE_LINES,
  canonicalText,
} from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * Release C of "Everything under Git": Fix git setup (preview, apply, idempotent, undo), the readable-diff driver, big files
 * (LFS and by reference), Share session, CODEOWNERS, the allowlist and the one-click fix of the staged secret scan, and staging
 * one item by its index blob. Scripted repositories, no network.
 */

const servers = (rows: Array<Record<string, unknown>>) => JSON.stringify({ schemaVersion: '1.0', servers: rows }, null, 2) + '\n';
const weather = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
const search = (url: string, extra: Record<string, unknown> = {}) => ({ id: 'search', name: 'Search', transport: 'http', url, ...extra });
const files = (url: string) => ({ id: 'files', name: 'Files', transport: 'http', url });

describe('.gitignore and .gitattributes text', () => {
  it('adds only what is missing, never twice, and keeps what the user wrote', () => {
    expect(ignoreText('')).toContain('runs/');
    const mine = '# mine\nnode_modules/\n' + GITIGNORE_LINES.join('\n') + '\n';
    expect(ignoreText(mine)).toBeUndefined();
    expect(ignoreText('node_modules/\n')).toMatch(/^node_modules\/\n\n# TestPion/);
  });

  it('gives a pattern the attributes it lacks on its own line, and leaves another value the user chose', () => {
    const old = '* text=auto eol=lf\ncollections/*.json merge=testpion\nenvironments/*.json merge=other\n';
    const next = attributesText(old)!;
    expect(next).toContain('collections/*.json merge=testpion diff=testpion\n');
    // one line per pattern: no second collections line
    expect(next.match(/^collections\/\*\.json/gm)).toHaveLength(1);
    // the user's merge driver stays; the diff driver is added beside it
    expect(next).toContain('environments/*.json merge=other diff=testpion\n');
    expect(attributesText(next)).toBeUndefined();
    // a user's own eol stays theirs
    expect(attributesText('* text=auto eol=crlf\n')).toContain('* text=auto eol=crlf\n');
    expect(attributesText('* text=auto eol=crlf\n')).not.toContain('eol=lf');
  });
});

describe('Fix git setup', () => {
  let r: TestRepo;
  beforeAll(async () => {
    r = await makeRepo();
    // an older workspace: collection with its save counter, an environment in another key order and CRLF, libraries with timestamps
    r.write('collections/api.json', JSON.stringify({ items: [], name: 'Kinds API', id: 'api', version: 7, updatedAt: '2026-02-02T00:00:00.000Z', schemaVersion: '1.0', variables: [] }, null, 4));
    r.write('environments/staging.json', '{\r\n  "variables": [],\r\n  "name": "Staging",\r\n  "id": "staging"\r\n}\r\n');
    r.write('library/ai-prompts.json', JSON.stringify({ items: [{ updatedAt: 'x', name: 'P', id: 'p1', data: { text: 'hi' } }], folders: [], schemaVersion: '1.0' }));
    r.write('tests/rest/a.yaml', 'name: a\r\ntests: []');
    // the ignore and attribute files of an older version: no diff driver, no capture-session line
    r.write('.gitignore', 'runs/\ntraces/\n');
    r.write('.gitattributes', '* text=auto eol=lf\ncollections/*.json merge=testpion\n');
    await r.commit('an old workspace');
  });
  afterAll(() => r.cleanup());

  const state = () =>
    ['collections/api.json', 'environments/staging.json', 'library/ai-prompts.json', 'tests/rest/a.yaml', '.gitignore', '.gitattributes'].map((f) =>
      existsSync(join(r.ws, f)) ? readFileSync(join(r.ws, f), 'utf8') : null,
    );

  it('a dry run lists every step and changes nothing', async () => {
    const before = state();
    const plan = await fixGitSetup(r.store, { dryRun: true, mergeDriverCommand: 'testpion merge-driver', textconvCommand: 'testpion git textconv' });
    expect(plan).toMatchObject({ dryRun: true, applied: false, changed: true, inRepository: true });
    expect(plan.steps.map((s) => s.id)).toEqual(expect.arrayContaining(['gitignore', 'gitattributes', 'stable-format', 'merge-driver', 'diff-driver']));
    expect(plan.rewritten.map((x) => x.file)).toEqual(expect.arrayContaining(['collections/api.json', 'environments/staging.json', 'library/ai-prompts.json', 'tests/rest/a.yaml']));
    // the CRLF-only file is told apart from the one whose keys move
    expect(plan.rewritten.find((x) => x.file === 'tests/rest/a.yaml')!.reason).toBe('line-endings');
    expect(plan.rewritten.find((x) => x.file === 'environments/staging.json')!.reason).toBe('stable-format');
    expect(state()).toEqual(before);
    expect((await runGit(r.ws, ['config', '--local', '--get', 'merge.testpion.driver']).catch(() => '')).trim()).toBe('');
  });

  it('applies once, registers the drivers, reports what it changed, and is idempotent', async () => {
    const res = await fixGitSetup(r.store, { mergeDriverCommand: 'testpion merge-driver', textconvCommand: 'testpion git textconv' });
    expect(res).toMatchObject({ applied: true, changed: true });
    expect(res.undoId).toBeTruthy();
    expect(readFileSync(join(r.ws, 'collections/api.json'), 'utf8')).toBe(JSON.stringify({ schemaVersion: '1.0', id: 'api', name: 'Kinds API', variables: [], items: [] }, null, 2) + '\n');
    expect(readFileSync(join(r.ws, 'environments/staging.json'), 'utf8')).toBe('{\n  "id": "staging",\n  "name": "Staging",\n  "variables": []\n}\n');
    expect(readFileSync(join(r.ws, 'library/ai-prompts.json'), 'utf8')).not.toContain('updatedAt');
    expect(readFileSync(join(r.ws, 'tests/rest/a.yaml'), 'utf8')).toBe('name: a\ntests: []\n');
    expect(readFileSync(join(r.ws, '.gitattributes'), 'utf8')).toContain('collections/*.json merge=testpion diff=testpion');
    expect((await runGit(r.ws, ['config', '--local', '--get', 'merge.testpion.driver'])).trim()).toBe('testpion merge-driver %O %A %B %P');
    expect((await runGit(r.ws, ['config', '--local', '--get', 'diff.testpion.textconv'])).trim()).toBe('testpion git textconv');
    // the version moved to the local meta, not lost
    expect(r.store.getCollection('api').id).toBe('api');
    const again = await fixGitSetup(r.store, { mergeDriverCommand: 'testpion merge-driver', textconvCommand: 'testpion git textconv' });
    expect(again).toMatchObject({ applied: false, changed: false });
    expect(again.rewritten).toEqual([]);
    expect(again.steps.filter((s) => s.state === 'todo')).toEqual([]);
  });

  it('Undo puts every file back as it was (bytes), and a second fix repeats it', async () => {
    const after = state();
    const second = await fixGitSetup(r.store, { dryRun: true });
    expect(second.changed).toBe(false);
    const { listJournal } = await import('../../packages/core/src/index.js');
    const entry = listJournal(r.ws).find((e) => e.op === 'fix-setup')!;
    expect(entry.files.map((f) => f.file)).toEqual(expect.arrayContaining(['.gitignore', '.gitattributes', 'collections/api.json']));
    undoJournal(r.ws, entry.id);
    expect(readFileSync(join(r.ws, 'environments/staging.json'), 'utf8')).toBe('{\r\n  "variables": [],\r\n  "name": "Staging",\r\n  "id": "staging"\r\n}\r\n');
    expect(state()).not.toEqual(after);
    const redo = await fixGitSetup(r.store, {});
    expect(redo.applied).toBe(true);
    expect(state()).toEqual(after);
  });

  it('works when the workspace is a folder of a bigger repository, and reports tracked files that should be ignored', async () => {
    const inner = await makeRepo({ inFolder: true });
    try {
      // a result file somebody committed before the ignore rules were there
      inner.write('runs/r1/results.jsonl', '{}\n');
      await inner.git('add', '-f', '.');
      await inner.git('commit', '-m', 'tracked results');
      const plan = await fixGitSetup(inner.store, { dryRun: true });
      const untrack = plan.steps.find((s) => s.id === 'untrack');
      expect(untrack?.state).toBe('advice');
      expect(untrack?.detail.join('\n')).toContain('runs/r1/results.jsonl');
      const fixed = await fixGitSetup(inner.store, { untrack: true });
      expect(fixed.applied).toBe(true);
      expect((await inner.git('ls-files', '--', 'runs')).trim()).toBe('');
      // the file stays on disk, and nothing outside the workspace folder was written
      expect(existsSync(join(inner.ws, 'runs/r1/results.jsonl'))).toBe(true);
      expect(existsSync(join(inner.repo, '.gitignore'))).toBe(false);
      expect(existsSync(join(inner.ws, '.gitignore'))).toBe(true);
    } finally {
      inner.cleanup();
    }
  });

  it('outside a repository the files are written and the rest says what is missing', async () => {
    const bare = await makeRepo();
    try {
      // not a repository: remove .git
      const { rmSync } = await import('node:fs');
      rmSync(join(bare.repo, '.git'), { recursive: true, force: true });
      const res = await fixGitSetup(bare.store, { mergeDriverCommand: 'x merge-driver', textconvCommand: 'x git textconv' });
      expect(res).toMatchObject({ applied: true, inRepository: false });
      expect(res.steps.find((s) => s.id === 'repository')?.state).toBe('advice');
      expect(res.steps.some((s) => s.id === 'merge-driver')).toBe(false);
      expect(existsSync(join(bare.ws, '.gitattributes'))).toBe(true);
    } finally {
      bare.cleanup();
    }
  });
});

describe('the readable-diff driver', () => {
  it('prints a collection, an environment, MCP servers and a library item by item', () => {
    const col = JSON.stringify({
      id: 'api',
      name: 'API',
      items: [{ kind: 'folder', id: 'f', name: 'Pets', items: [{ kind: 'http', id: 'r1', name: 'List', request: { method: 'GET', url: '/pets' } }] }],
    });
    const t = textconvText(col)!;
    expect(t).toContain('== API [collection api] ==');
    expect(t).toContain('== API ▸ Pets [folder f] ==');
    expect(t).toContain('== API ▸ Pets ▸ List [http r1] ==');
    expect(t).toContain('"url": "/pets"');
    expect(textconvText(servers([weather]))!).toContain('== MCP servers ▸ Weather mock [MCP server weather] ==');
    expect(textconvText(JSON.stringify({ id: 'e', name: 'Staging', variables: [{ key: 'a', value: '1' }] }))!).toContain('== Staging ▸ a [variable] ==');
    expect(textconvText(JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'p', name: 'Greeting', data: {} }] }))!).toContain('== Saved items ▸ Greeting [saved item p] ==');
    // anything else is printed as it is by the caller
    expect(textconvText('name: a\ntests: []\n')).toBeUndefined();
    expect(textconvText('{"foo": 1}')).toBeUndefined();
  });

  it("git diff shows the item that changed under its own heading; the app's own diff stays plain", async () => {
    const r = await makeRepo();
    try {
      r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1'), files('https://f.example.com/v1')]));
      r.write('.gitattributes', 'mcp-servers.json diff=testpion\n');
      await r.commit('servers');
      // a driver script: git hands it a temp file with no path
      const script = join(r.repo, '..', `textconv-${Date.now()}.mjs`);
      const dist = join(__dirname, '..', '..', 'packages', 'core', 'dist', 'index.js').replace(/\\/g, '/');
      writeFileSync(script, `import { textconvFile } from 'file:///${dist.replace(/^\//, '')}';\nprocess.stdout.write(textconvFile(process.argv[2]));\n`);
      await gitSetupTextconv(r.ws, `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`);
      r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1'), files('https://f.example.com/v2')]));
      const diff = await r.git('diff', '--no-color');
      // the hunk is named by the item it is in
      expect(diff).toMatch(/@@ .* @@ MCP servers ▸ Files \[MCP server files\]/);
      expect(diff).toContain('-  "url": "https://f.example.com/v1"');
      expect(diff).toContain('+  "url": "https://f.example.com/v2"');
      // only the changed item is in the hunk
      expect(diff).not.toContain('Weather mock');
      // the app's own file diff asks for the plain one
      const { gitDiff } = await import('../../packages/core/src/index.js');
      const plain = await gitDiff(r.ws, 'mcp-servers.json');
      expect(plain).toContain('-      "url": "https://f.example.com/v1"');
      expect(plain).not.toContain('==');
    } finally {
      r.cleanup();
    }
  });
});

describe('big files', () => {
  it('the policy: warn at 5 MB, LFS offered at 50 MB, refused at 100 MB', () => {
    expect(largeLevel(1024)).toBeUndefined();
    expect(largeLevel(6 * 1048576)).toBe('warn');
    expect(largeLevel(60 * 1048576)).toBe('lfs');
    expect(largeLevel(120 * 1048576)).toBe('refuse');
  });

  it('lists big files, tracks one by reference (a .ref with the checksum, the data git-ignored), and checks it', async () => {
    const r = await makeRepo();
    try {
      await runGit(r.ws, ['config', 'user.name', 'T']);
      r.write('.gitignore', 'runs/\n');
      mkdirSync(join(r.ws, 'datasets'), { recursive: true });
      writeFileSync(join(r.ws, 'datasets', 'big data.csv'), 'id,name\n' + '1,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'.repeat(110_000));
      await r.commit('with a big dataset');
      const list = await findLargeFiles(r.ws);
      expect(list.map((l) => l.file)).toEqual(['datasets/big data.csv']);
      expect(list[0]!.level).toBe('warn');
      const plan = await trackByReference(r.ws, 'datasets/big data.csv', { dryRun: true, source: 's3://team/big data.csv' });
      expect(plan).toMatchObject({ applied: false, mode: 'reference', untrack: true });
      expect(existsSync(join(r.ws, 'datasets', 'big data.csv.ref'))).toBe(false);
      const res = await trackByReference(r.ws, 'datasets/big data.csv', { source: 's3://team/big data.csv' });
      expect(res.applied).toBe(true);
      expect(res.undoId).toBeTruthy();
      const ref = JSON.parse(readFileSync(join(r.ws, 'datasets', 'big data.csv.ref'), 'utf8'));
      expect(ref).toMatchObject({ schemaVersion: '1.0', name: 'big data.csv', source: 's3://team/big data.csv' });
      expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
      // the data file is out of git and ignored (a name with a space), the reference is the new file
      expect((await r.git('ls-files', '--', 'datasets/big data.csv')).trim()).toBe('');
      expect(readFileSync(join(r.ws, '.gitignore'), 'utf8')).toContain('datasets/big data.csv');
      const st = await gitStatus(r.ws);
      expect(st.files.map((f) => f.path)).toEqual(expect.arrayContaining(['datasets/big data.csv.ref']));
      // it leaves git (a staged deletion) and is no longer untracked: the data stays on disk
      expect(st.files.find((f) => f.path === 'datasets/big data.csv')).toMatchObject({ state: 'deleted', staged: true });
      expect(existsSync(join(r.ws, 'datasets', 'big data.csv'))).toBe(true);
      // no longer offered (it is ignored now)
      expect(await findLargeFiles(r.ws)).toEqual([]);
      expect((await checkReferences(r.ws)).map((c) => c.state)).toEqual(['ok']);
      writeFileSync(join(r.ws, 'datasets', 'big data.csv'), readFileSync(join(r.ws, 'datasets', 'big data.csv'), 'utf8').replace('aaaa', 'bbbb'));
      expect((await checkReferences(r.ws)).map((c) => c.state)).toEqual(['different']);
      writeFileSync(join(r.ws, 'datasets', 'gone.csv.ref'), JSON.stringify({ schemaVersion: '1.0', name: 'gone.csv', bytes: 3, sha256: 'a'.repeat(64), source: 'https://x/gone.csv' }));
      const states = Object.fromEntries((await checkReferences(r.ws)).map((c) => [c.file, c.state]));
      expect(states['datasets/gone.csv']).toBe('missing');
    } finally {
      r.cleanup();
    }
  });

  it('a file name with a line break or another control character never reaches .gitattributes or .gitignore', async () => {
    const r = await makeRepo();
    try {
      for (const name of ['datasets/x\n* filter=y', 'datasets/x\r\n* -text', 'datasets/a\u0000b', 'datasets/tab\tname', 'datasets/x y', 'datasets/del\u007fx']) {
        await expect(trackWithLfs(r.ws, name, { dryRun: true }), JSON.stringify(name)).rejects.toThrow(/control character/);
        await expect(trackByReference(r.ws, name, { dryRun: true }), JSON.stringify(name)).rejects.toThrow(/control character/);
      }
      expect(readFileSync(join(r.ws, '.gitattributes'), 'utf8')).not.toContain('filter=y');
    } finally {
      r.cleanup();
    }
  });

  it('Git LFS: says clearly when it is not installed, else writes the rule', async () => {
    const r = await makeRepo();
    try {
      mkdirSync(join(r.ws, 'datasets'), { recursive: true });
      writeFileSync(join(r.ws, 'datasets', 'huge.csv'), 'a,b\n1,2\n');
      const lfs = await runGit(r.ws, ['lfs', 'version']).then(
        () => true,
        () => false,
      );
      if (!lfs) {
        await expect(trackWithLfs(r.ws, 'datasets/huge.csv')).rejects.toThrow(/Git LFS is not installed/);
        return;
      }
      const dry = await trackWithLfs(r.ws, 'datasets/huge.csv', { dryRun: true });
      expect(dry.applied).toBe(false);
      const res = await trackWithLfs(r.ws, 'datasets/huge.csv');
      expect(readFileSync(join(r.ws, '.gitattributes'), 'utf8')).toContain('datasets/huge.csv filter=lfs diff=lfs merge=lfs -text');
      expect(res.undoId).toBeTruthy();
      // twice is the same
      await trackWithLfs(r.ws, 'datasets/huge.csv');
      expect(readFileSync(join(r.ws, '.gitattributes'), 'utf8').match(/datasets\/huge\.csv/g)).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  });

  it('a file outside the workspace, or one that is not there, is refused', async () => {
    const r = await makeRepo();
    try {
      await expect(trackByReference(r.ws, '../outside.csv')).rejects.toThrow(/outside|Not a path/);
      await expect(trackByReference(r.ws, 'datasets/none.csv')).rejects.toThrow(/not a file/);
    } finally {
      r.cleanup();
    }
  });
});

describe('Share session', () => {
  it('copies a saved session, masked once more, to the tracked folder; the session itself stays ignored', async () => {
    const r = await makeRepo();
    try {
      r.write('.gitignore', 'debugger/*.har\n');
      const har = {
        log: {
          version: '1.2',
          creator: { name: 'TestPion', version: '0' },
          entries: [
            {
              request: {
                method: 'GET',
                url: 'https://api.example.com/x',
                headers: [
                  { name: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' },
                  { name: 'Accept', value: 'application/json' },
                ],
              },
              response: { status: 200 },
            },
          ],
        },
      };
      r.write('debugger/checkout bug.har', JSON.stringify(har, null, 2));
      const redactor = new Redactor();
      const dry = shareSession(r.store, 'checkout bug', { redactor, dryRun: true });
      expect(dry).toMatchObject({ applied: false, entries: 1, masked: true, to: 'debugger/shared/checkout bug.har' });
      expect(existsSync(join(r.ws, 'debugger', 'shared'))).toBe(false);
      const res = shareSession(r.store, 'checkout bug', { redactor });
      expect(res.applied).toBe(true);
      const copy = readFileSync(join(r.ws, 'debugger', 'shared', 'checkout bug.har'), 'utf8');
      expect(copy).not.toContain('abcdef0123456789abcdef0123456789');
      expect(copy).toContain('application/json');
      // the original is untouched
      expect(readFileSync(join(r.ws, 'debugger', 'checkout bug.har'), 'utf8')).toContain('abcdef0123456789abcdef0123456789');
      const st = await gitStatus(r.ws);
      expect(st.files.map((f) => f.path)).toContain('debugger/shared/checkout bug.har');
      expect(st.files.map((f) => f.path)).not.toContain('debugger/checkout bug.har');
      expect(listSharedSessions(r.store).map((s) => s.name)).toEqual(['checkout bug']);
      undoJournal(r.ws, res.undoId);
      expect(existsSync(join(r.ws, 'debugger', 'shared', 'checkout bug.har'))).toBe(false);
      shareSession(r.store, 'checkout bug', { redactor });
      expect(unshareSession(r.store, 'checkout bug').removed).toBe(true);
      expect(unshareSession(r.store, 'checkout bug').removed).toBe(false);
      expect(() => shareSession(r.store, 'nope', { redactor })).toThrow(/no saved session/);
      expect(() => shareSession(r.store, '../x', { redactor })).toThrow();
    } finally {
      r.cleanup();
    }
  });

  it('the watcher ignores capture sessions but reports shared ones', () => {
    expect(changeKind('debugger/morning.har')).toBeUndefined();
    expect(changeKind('debugger/shared/morning.har')).toBeDefined();
    expect(changeKind('debugger/rules.json')).toBe('other');
    // datasets are their own kind (they were reported as test files)
    expect(changeKind('datasets/users.csv')).toBe('datasets');
  });
});

describe('CODEOWNERS', () => {
  it('lists the kind folders the workspace has, as comments until an owner is given, and never overwrites', async () => {
    const r = await makeRepo();
    try {
      const plan = await planCodeowners(r.ws);
      expect(plan.lines.map((l) => l.pattern)).toEqual(expect.arrayContaining(['/environments/', '/mcp-servers.json', '/providers.json', '/collections/', '/tests/']));
      expect(plan.text).toContain('# /environments/');
      expect(plan.text).toContain('@your-org/team');
      const owned = await planCodeowners(r.ws, { owner: '@acme/platform' });
      expect(owned.text).toMatch(/^\/environments\/\s+@acme\/platform$/m);
      const res = await writeCodeowners(r.ws, { owner: '@acme/platform' });
      expect(res.written).toBe(true);
      const file = join(r.repo, '.github', 'CODEOWNERS');
      const text = readFileSync(file, 'utf8');
      const again = await writeCodeowners(r.ws, { owner: '@other/team' });
      expect(again).toMatchObject({ written: false });
      expect(again.reason).toMatch(/never overwritten/);
      expect(readFileSync(file, 'utf8')).toBe(text);
    } finally {
      r.cleanup();
    }
  });

  it('in a folder of a bigger repository the patterns carry the folder and nothing is written outside the workspace', async () => {
    const r = await makeRepo({ inFolder: true });
    try {
      const res = await writeCodeowners(r.ws, { owner: '@acme/platform' });
      expect(res.written).toBe(false);
      expect(res.reason).toMatch(/outside the workspace/);
      expect(res.lines[0]!.pattern.startsWith('/apps/tests/')).toBe(true);
      expect(existsSync(join(r.repo, '.github'))).toBe(false);
    } finally {
      r.cleanup();
    }
  });
});

describe('the allowlist and the one-click fix of the staged secret scan', () => {
  let r: TestRepo;
  beforeAll(async () => {
    r = await makeRepo();
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1')]));
    await r.commit('servers');
  });
  afterAll(() => r.cleanup());

  const KEY = 'Bearer abcdef0123456789abcdef0123456789abcd';
  it('a typed header is found with a fingerprint that is not the value; a reviewed allow-entry lets that value through, only there', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1', { headers: [{ key: 'Authorization', value: KEY, enabled: true }] })]));
    await gitStage(r.ws, ['mcp-servers.json']);
    const scan = await scanStagedSecrets(r.ws);
    expect(scan.blocking).toHaveLength(1);
    const f = scan.blocking[0]!;
    expect(f.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(scan)).not.toContain('abcdef0123456789');
    expect(commitVerdict(scan)).toMatchObject({ allowed: false, reason: 'blocked' });
    expect(() => allowSecret(r.ws, f, ' ')).toThrow(/why/);
    const res = allowSecret(r.ws, f, 'public test key from the docs');
    expect(res.applied).toBe(true);
    const file = readFileSync(join(r.ws, '.testpion', 'secrets-allow.json'), 'utf8');
    expect(file).not.toContain('abcdef0123456789');
    expect(file).toContain('public test key from the docs');
    // salted: the same value in the same place does not give the plain sha256 an offline table could hold, and the salt travels with the entries
    const salt = (JSON.parse(file) as { salt?: string }).salt;
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(f.hash).not.toBe(secretFingerprint(f.file, f.item, f.field, KEY.slice('Bearer '.length)));
    expect(f.hash).not.toBe(secretFingerprint(f.file, f.item, f.field, KEY));
    expect(secretFingerprint('a', 'b', 'c', 'v', salt)).not.toBe(secretFingerprint('a', 'b', 'c', 'v', 'f'.repeat(32)));
    expect(secretFingerprint('a', 'b', 'c', 'v', salt)).toMatch(/^[0-9a-f]{32}$/);
    const after = await scanStagedSecrets(r.ws);
    expect(after.blocking).toEqual([]);
    expect(after.allowed).toHaveLength(1);
    expect(commitVerdict(after)).toEqual({ allowed: true });
    // the same entry twice is one entry
    expect(allowSecret(r.ws, f, 'again').applied).toBe(false);
    expect(readSecretsAllow(r.ws).entries).toHaveLength(1);
    // another value in the same place is found again
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1', { headers: [{ key: 'Authorization', value: 'Bearer zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', enabled: true }] })]));
    await gitStage(r.ws, ['mcp-servers.json']);
    expect((await scanStagedSecrets(r.ws)).blocking).toHaveLength(1);
    // and the entry can be taken out again
    expect(disallowSecret(r.ws, f.hash).removed).toBe(1);
    expect(readSecretsAllow(r.ws).entries).toEqual([]);
  });

  it('an allowlist of an earlier version (entries, no salt) keeps working with its unsalted fingerprints', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1', { headers: [{ key: 'Authorization', value: KEY, enabled: true }] })]));
    await gitStage(r.ws, ['mcp-servers.json']);
    expect(allowSalt(r.ws)).toMatch(/^[0-9a-f]{32}$/);
    const f = (await scanStagedSecrets(r.ws)).blocking[0]!;
    // the same finding under the old scheme (no salt): what an earlier version stored
    const old = scanFileText(f.file, readFileSync(join(r.ws, f.file), 'utf8'))[0]!;
    expect(old.hash).not.toBe(f.hash);
    writeFileSync(join(r.ws, '.testpion', 'secrets-allow.json'), JSON.stringify({ schemaVersion: '1.0', allow: [{ file: f.file, item: f.item, field: f.field, hash: old.hash, reason: 'from an earlier version' }] }));
    expect(allowSalt(r.ws)).toBeUndefined();
    const scan = await scanStagedSecrets(r.ws);
    expect(scan.blocking).toEqual([]);
    expect(scan.allowed).toHaveLength(1);
    writeFileSync(join(r.ws, '.testpion', 'secrets-allow.json'), JSON.stringify({ schemaVersion: '1.0', allow: [] }));
  });

  it('an unreadable allowlist allows nothing and says so', async () => {
    writeFileSync(join(r.ws, '.testpion', 'secrets-allow.json'), '{ nope');
    const scan = await scanStagedSecrets(r.ws);
    expect(scan.allowProblem).toMatch(/not valid JSON/);
    expect(scan.blocking).toHaveLength(1);
    writeFileSync(join(r.ws, '.testpion', 'secrets-allow.json'), JSON.stringify({ schemaVersion: '1.0', allow: [] }));
  });

  it('the fix moves MCP header values, a provider key and a test file token to secret variables, stages nothing by itself, and Undo restores the files', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1', { headers: [{ key: 'Authorization', value: KEY, enabled: true }] })]));
    r.write(
      'providers.json',
      JSON.stringify({ schemaVersion: '1.0', providers: [{ id: 'demo', name: 'Demo', kind: 'openai', apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' }] }, null, 2) + '\n',
    );
    r.write('tests/rest/pay.yaml', 'name: pay\ntests:\n  - name: p\n    request:\n      url: https://x/y\n      headers:\n        X-Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    await gitStage(r.ws, ['mcp-servers.json', 'providers.json', 'tests/rest/pay.yaml']);
    const scan = await scanStagedSecrets(r.ws);
    const found = [...scan.blocking, ...scan.confirm].map((f) => f.file);
    expect(found).toEqual(expect.arrayContaining(['mcp-servers.json', 'providers.json', 'tests/rest/pay.yaml']));
    const env = r.store.listEnvironments()[0]!;
    const secrets = new MemorySecretStore();
    const plan = await fixStagedFiles(r.store, secrets, { files: [...new Set(found)], environmentId: env.id, dryRun: true });
    expect(plan.applied).toBe(false);
    expect(plan.fixed.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(r.ws, 'mcp-servers.json'), 'utf8')).toContain('abcdef0123456789');
    const res = await fixStagedFiles(r.store, secrets, { files: [...new Set(found)], environmentId: env.id });
    expect(res.applied).toBe(true);
    for (const f of ['mcp-servers.json', 'providers.json', 'tests/rest/pay.yaml']) expect(readFileSync(join(r.ws, f), 'utf8'), f).not.toMatch(/abcdef0123456789|sk-proj-abcdefghij/);
    expect(readFileSync(join(r.ws, 'mcp-servers.json'), 'utf8')).toMatch(/Bearer \{\{\w+\}\}/);
    expect(readFileSync(join(r.ws, 'providers.json'), 'utf8')).toContain('{{$secret.provider.demo.apiKey}}');
    // the values are in the secret store, as secret variables of the environment (blank in the file)
    const latest = r.store.listEnvironments().find((e) => e.id === env.id)!;
    const added = latest.variables.filter((v) => res.variables.includes(v.key));
    expect(added.length).toBe(res.variables.length);
    expect(added.every((v) => v.secret && v.value === '')).toBe(true);
    expect(await secrets.get(`provider.demo.apiKey`)).toBe('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH');
    expect(await secrets.get(`env.${env.id}.${res.variables[0]}`)).toBeTruthy();
    // the fixed files are scanned clean
    await gitStage(r.ws, ['mcp-servers.json', 'providers.json', 'tests/rest/pay.yaml']);
    const clean = await scanStagedSecrets(r.ws);
    expect([...clean.blocking, ...clean.confirm]).toEqual([]);
    undoJournal(r.ws, res.undoId);
    expect(readFileSync(join(r.ws, 'mcp-servers.json'), 'utf8')).toContain('abcdef0123456789');
  });

  it('a dataset is not "fixed" (it holds data); an allowed value is left in the file', async () => {
    r.write('datasets/people.csv', 'id,password\n1,hunter2hunter2\n');
    const env = r.store.listEnvironments()[0]!;
    const res = await fixStagedFiles(r.store, new MemorySecretStore(), { files: ['datasets/people.csv'], environmentId: env.id });
    expect(res.applied).toBe(false);
    expect(res.skipped[0]!.reason).toMatch(/holds data/);
    expect(readFileSync(join(r.ws, 'datasets/people.csv'), 'utf8')).toContain('hunter2hunter2');
  });
});

describe('staging one item by its index blob', () => {
  let r: TestRepo;
  beforeAll(async () => {
    r = await makeRepo();
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1'), files('https://f.example.com/v1')]));
    await r.commit('three servers');
  });
  afterAll(() => r.cleanup());

  const indexServers = async () => (JSON.parse(await r.git('show', ':mcp-servers.json')) as { servers: Array<{ id: string; url?: string }> }).servers;

  it("stages only that item's change: the index holds it, the working file keeps the other change unstaged", async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v2')]));
    const dry = await stageItem(r.ws, addressOf('mcp-servers.json', 'search'), { dryRun: true });
    expect(dry).toMatchObject({ applied: false, partial: true });
    expect((await indexServers()).find((s) => s.id === 'search')!.url).toBe('https://s.example.com/v1');
    const res = await stageItem(r.ws, addressOf('mcp-servers.json', 'search'));
    expect(res).toMatchObject({ applied: true, partial: true, alsoStages: [], leftUnstaged: ['MCP server Files'] });
    expect(res.message).toMatch(/Staged MCP server Search only/);
    const idx = await indexServers();
    expect(idx.find((s) => s.id === 'search')!.url).toBe('https://s.example.com/v2');
    expect(idx.find((s) => s.id === 'files')!.url).toBe('https://f.example.com/v1');
    // the Git view's rows say which item is staged and which is not
    const rows = (await gitChangesByItem(r.ws)).items.filter((i) => i.file === 'mcp-servers.json');
    expect(rows.map((i) => `${i.title} ${i.staged}`).sort()).toEqual(['MCP server Files false', 'MCP server Search true']);
    // a commit takes just that
    await r.git('commit', '-m', 'search v2');
    expect((await r.git('show', 'HEAD:mcp-servers.json')).includes('f.example.com/v2')).toBe(false);
    // the other change is still waiting in the working folder
    const st = await gitStatus(r.ws);
    expect(st.files.map((f) => f.path)).toEqual(['mcp-servers.json']);
    expect(r.read('mcp-servers.json')).toContain('f.example.com/v2');
  });

  it('unstages one item the same way, and an item that was added or removed stages exactly', async () => {
    const staged = await stageItem(r.ws, addressOf('mcp-servers.json', 'files'));
    expect(staged.partial).toBe(true);
    expect((await indexServers()).find((s) => s.id === 'files')!.url).toBe('https://f.example.com/v2');
    const un = await stageItem(r.ws, addressOf('mcp-servers.json', 'files'), { unstage: true });
    expect(un.partial).toBe(true);
    expect((await indexServers()).find((s) => s.id === 'files')!.url).toBe('https://f.example.com/v1');
    // a new server and a removed one
    r.write('mcp-servers.json', servers([search('https://s.example.com/v2'), files('https://f.example.com/v2'), { id: 'extra', name: 'Extra', transport: 'http', url: 'https://e.example.com' }]));
    await stageItem(r.ws, addressOf('mcp-servers.json', 'extra'));
    expect((await indexServers()).map((s) => s.id)).toEqual(['weather', 'search', 'files', 'extra']);
    await stageItem(r.ws, addressOf('mcp-servers.json', 'weather'));
    expect((await indexServers()).map((s) => s.id)).toEqual(['search', 'files', 'extra']);
    // the history of an item reads the same after the partial commit
    await r.git('commit', '-m', 'extra, no weather');
    expect((await itemHistory(r.ws, addressOf('mcp-servers.json', 'extra'))).versions).toHaveLength(1);
  });

  it('a request of a collection stages alone, with its folder neighbours left; a whole-file item stages whole', async () => {
    // the fixture's file is in an older form: staging one request of it stages the file whole (it would stage the reformatting too)
    const older = JSON.parse(r.read('collections/api.json'));
    older.items[0].items[0].request.url = '{{baseUrl}}/older';
    r.write('collections/api.json', JSON.stringify(older, null, 2) + '\n');
    const whole = await stageItem(r.ws, addressOf('collections/api.json', 'r1'), { dryRun: true });
    expect(whole.partial).toBeUndefined();
    expect(whole.message).toMatch(/Would stage collections\/api\.json/);
    await r.git('checkout', '--', 'collections/api.json');
    r.write('collections/api.json', canonicalText('collections/api.json', r.read('collections/api.json'))!);
    await r.commit('stable collection');
    const col = JSON.parse(r.read('collections/api.json'));
    col.items[0].items[0].request.url = '{{baseUrl}}/pets?x=1';
    col.items[0].items[1].request.url = '{{baseUrl}}/soap?y=2';
    r.write('collections/api.json', JSON.stringify(col, null, 2) + '\n');
    const res = await stageItem(r.ws, addressOf('collections/api.json', 'r1'));
    expect(res.partial).toBe(true);
    const idx = JSON.parse(await r.git('show', ':collections/api.json'));
    expect(idx.items[0].items[0].request.url).toBe('{{baseUrl}}/pets?x=1');
    expect(idx.items[0].items[1].request.url).toBe('{{baseUrl}}/soap');
    // an environment is one item: the file
    r.edit('environments/staging.json', (t) => t.replace('"variables": [', '"variables": [{"key":"zz","value":"1","enabled":true},'));
    const env = await stageItem(r.ws, addressOf('environments/staging.json'));
    expect(env.partial).toBeUndefined();
    expect(env.message).toMatch(/Staged environments\/staging\.json/);
  });
});

describe('git history of a plain word', () => {
  it('is an error that says what to name, not an empty list', async () => {
    const r = await makeRepo();
    try {
      await expect(itemHistory(r.ws, addressOf('hello'))).rejects.toThrow(/not an item or a file of the workspace/);
      await expect(itemHistory(r.ws, addressOf('mcp-servers.json', 'nothing'))).rejects.toThrow(/no item nothing/);
      // a file that exists but was never committed is an empty history, not an error
      r.write('tests/new.yaml', 'name: n\n');
      expect((await itemHistory(r.ws, addressOf('tests/new.yaml'))).versions).toEqual([]);
    } finally {
      r.cleanup();
    }
  });
});

describe('the folder libraries mark their folders', () => {
  it("a folder made or removed, and a definition moved into one, are changes of that kind's list", () => {
    const before = JSON.stringify({ schemaVersion: '1.0', folders: ['Public'], items: [{ id: 'specs/a.yaml', name: 'a', folder: 'Public' }] });
    const after = JSON.stringify({ schemaVersion: '1.0', folders: ['Private'], items: [{ id: 'specs/a.yaml', name: 'a', folder: 'Private' }] });
    const c = describeFile('library/spec-folders.json', before, after, 'changed');
    expect(c.map((x) => `${x.change} ${x.title}`).sort()).toEqual(['added API definition folder Private', 'changed API definition specs/a.yaml', 'removed API definition folder Public']);
    const moved = c.find((x) => x.itemId === 'specs/a.yaml')!;
    expect(moved.details).toEqual(['moved to folder Private']);
    expect(moved.containers).toEqual(['folder|spec|Public', 'folder|spec|Private']);
    expect(moved.ref).toEqual({ kind: 'spec', path: 'specs/a.yaml' });
    const mcp = describeFile('library/mcp-folders.json', JSON.stringify({ folders: ['A'], items: [] }), JSON.stringify({ folders: ['A', 'B'], items: [] }), 'changed');
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({ change: 'added', title: 'MCP server folder B', kindId: 'mcp-server', containers: ['folder|mcp-server|B'] });
  });
});
