import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parseQuickQuery, quickOpenRows, type QuickSources } from '../../apps/desktop/src/lib/quick-open';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { runCli, tempDir, cliData } from '../helpers.js';

// WF-01 Quick Open: one palette for items and commands, its mode by the first character (or the mode it opened in).
const opened: string[] = [];
const sources = (over: Partial<QuickSources> = {}): QuickSources => ({
  recent: [{ ref: { kind: 'request', collectionId: 'c', requestId: 'r' }, label: 'List patients' }],
  commands: [{ id: 'new-http', label: 'New HTTP Request', run: () => opened.push('cmd') }],
  here: [{ id: 'insert-snippet', label: 'Insert Snippet…', run: () => undefined }],
  environments: [
    { id: 'dev', name: 'Dev', variables: ['baseUrl', 'token'] },
    { id: 'prd', name: 'Prod', production: true, variables: ['baseUrl'] },
  ],
  active: 'Dev',
  open: (ref) => opened.push(JSON.stringify(ref)),
  switchEnvironment: (n) => opened.push(`env:${n}`),
  setQuery: (q) => opened.push(`q:${q}`),
  noun: (ref) => (ref.kind === 'request' ? 'Request' : ref.kind),
  ...over,
});

describe('Quick Open', () => {
  it('modes by prefix, else the mode it opened in', () => {
    expect(parseQuickQuery('> new')).toEqual({ mode: 'commands', text: 'new' });
    expect(parseQuickQuery('#prod')).toEqual({ mode: 'environments', text: 'prod' });
    expect(parseQuickQuery('@x')).toEqual({ mode: 'here', text: 'x' });
    expect(parseQuickQuery('?')).toEqual({ mode: 'help', text: '' });
    expect(parseQuickQuery('patients')).toEqual({ mode: 'items', text: 'patients' });
    expect(parseQuickQuery('patients', 'commands')).toEqual({ mode: 'commands', text: 'patients' });
  });

  it('nothing typed: the items opened lately; text: the search hits', () => {
    const empty = quickOpenRows('', sources());
    expect(empty.rows.map((r) => [r.label, r.group, r.detail])).toEqual([['List patients', 'Recently opened', 'Request']]);
    empty.rows[0]!.run();
    expect(opened.pop()).toContain('"requestId":"r"');
    expect(quickOpenRows('pat', sources()).empty).toBe('Searching…');
    const found = quickOpenRows('pat', sources({ hits: [{ id: 'h', kind: 'request', title: 'Create patient', ref: { kind: 'request', collectionId: 'c', requestId: 'p' } }] }));
    expect(found.rows.map((r) => r.label)).toEqual(['Create patient']);
  });

  it('# lists environments to switch to and their variables', () => {
    const r = quickOpenRows('#', sources());
    expect(r.rows.filter((x) => x.group === 'Environments').map((x) => [x.label, x.hint])).toEqual([
      ['Dev', 'active'],
      ['Prod  (production)', 'Switch'],
    ]);
    expect(r.rows.filter((x) => x.group === 'Variables').map((x) => `${x.label} ${x.detail}`)).toEqual(['{{baseUrl}} Dev', '{{token}} Dev', '{{baseUrl}} Prod']);
    r.rows[1]!.run();
    expect(opened.pop()).toBe('env:Prod');
  });

  it('> commands, @ the focused editor, ? help reopens in a mode', () => {
    expect(quickOpenRows('>new', sources()).rows.map((r) => r.id)).toEqual(['new-http']);
    expect(quickOpenRows('@', sources()).rows.map((r) => r.id)).toEqual(['insert-snippet']);
    const help = quickOpenRows('?', sources());
    help.rows.find((r) => r.hint === '#')!.run();
    expect(opened.pop()).toBe('q:#');
  });
});

describe('search from agents and the terminal', () => {
  const tmp = tempDir('tp-search-');
  afterAll(() => tmp.cleanup());
  it('testpion search --json answers hits with refs', async () => {
    const root = join(tmp.dir, 'ws');
    const s = WorkspaceStore.create(root, 'S');
    s.saveCollection({
      schemaVersion: '1.0',
      id: 'vet',
      name: 'Vet',
      version: 0,
      updatedAt: '',
      variables: [],
      items: [{ kind: 'http', id: 'r1', name: 'List patients', request: { method: 'GET', url: 'x', headers: [] } }],
    } as never);
    s.close();
    const r = await runCli(['search', 'patients', '-w', root, '--json'], { home: join(tmp.dir, 'home') });
    expect(r.status).toBe(0);
    expect(cliData(r.out)).toContainEqual(expect.objectContaining({ title: 'List patients', ref: expect.objectContaining({ kind: 'request', collectionId: 'vet', requestId: 'r1' }) }));
  }, 60_000);
});
