import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliSync, tempDir } from '../helpers.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';

// `testpion import`: a single file imports as it always did; several files, a folder or a ZIP are previewed (--apply
// imports them); --preview writes nothing and --json says everything; --report writes the compatibility report;
// import-report / import-undo read and take back what an import kept.
const t = tempDir('tp-cli-preview-');
afterAll(() => t.cleanup());
const home = join(t.dir, 'home');
const ws = join(t.dir, 'ws');
WorkspaceStore.create(ws, 'Preview').close();
// (--json answers in the CLI's envelope: { schema_version, command, status, data, … })
const data = (out: string) => JSON.parse(out).data;
const cli = (...args: string[]) => runCliSync(args, { home, cwd: t.dir });
const names = () => {
  const s = WorkspaceStore.open(ws);
  try {
    return s.listCollections().map((c) => c.name).sort();
  } finally {
    s.close();
  }
};

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const collection = (name: string, auth = 'bearer') =>
  JSON.stringify({
    info: { _postman_id: name, name, schema: SCHEMA },
    item: [{ name: 'Secured', request: { method: 'GET', url: 'https://example.test/x', auth: { type: auth, [auth]: [] } }, event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }] }],
  });
const files = {
  a: join(t.dir, 'a.json'),
  b: join(t.dir, 'b.json'),
};
writeFileSync(files.a, collection('Alpha', 'asap'));
writeFileSync(files.b, collection('Beta'));

describe('CLI: import preview', () => {
  it('--preview --json: the plan and the report, nothing written', () => {
    const r = cli('import', files.a, '-w', ws, '--preview', '--json');
    expect(r.status, r.err).toBe(0);
    const out = data(r.out);
    expect(out.preview).toBe(true);
    expect(out.inputs[0].plan.collections[0]).toMatchObject({ name: 'Alpha', requests: 1 });
    expect(out.inputs[0].plan.report.groups.map((g: { code: string }) => g.code)).toContain('AUTH_UNSUPPORTED');
    expect(out.totals).toMatchObject({ collections: 1, requests: 1, errors: 0 });
    expect(names()).toEqual([]);
  });

  it('several files are previewed by default; --apply imports them, with one import id each', () => {
    const p = cli('import', files.a, files.b, '-w', ws);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('Preview of 2 imports: nothing was written');
    expect(p.out).toContain('Add --apply');
    expect(names()).toEqual([]);
    const r = cli('import', files.a, files.b, '-w', ws, '--apply', '--json');
    expect(r.status, r.err).toBe(0);
    const out = data(r.out);
    expect(out.imported).toHaveLength(2);
    expect(out.receipts).toHaveLength(2);
    expect(names()).toEqual(['Alpha', 'Beta']);
    // the reports are kept
    const list = cli('import-report', '-w', ws, '--json');
    expect(data(list.out)).toHaveLength(2);
    const one = cli('import-report', out.receipts[0], '-w', ws, '--markdown');
    expect(one.out).toContain('# Import report');
    // and undone, one after the other
    const u = cli('import-undo', ...out.receipts, '-w', ws);
    expect(u.status, u.err).toBe(0);
    expect(names()).toEqual([]);
  });

  it('one file imports at once and carries its report and import id', () => {
    const reportFile = join(t.dir, 'report.md');
    const r = cli('import', files.b, '-w', ws, '--json', '--report', reportFile);
    expect(r.status, r.err).toBe(0);
    const out = data(r.out);
    expect(out.collection).toBe('Beta');
    expect(out.importId).toMatch(/^imp-/);
    expect(out.report.summary.items).toBe(2);
    expect(out.notes).toBeUndefined();
    expect(readFileSync(reportFile, 'utf8')).toContain('# Import report: Postman');
    const u = cli('import-undo', out.importId, '-w', ws, '--json');
    expect(data(u.out)[0].trashed[0]).toMatchObject({ kind: 'collection', name: 'Beta' });
  });

  it('a folder (Bruno) is previewed, and --apply imports it', () => {
    const dir = join(t.dir, 'bruno-api');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bruno.json'), '{"name":"Bru API","version":"1"}');
    writeFileSync(join(dir, 'List.bru'), 'meta {\n  name: List\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://x.test/list\n  body: none\n  auth: none\n}\n\nsettings {\n  encodeUrl: false\n}\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    const p = cli('import', dir, '-w', ws, '--json');
    const plan = data(p.out);
    expect(plan.preview).toBe(true);
    expect(plan.inputs[0].plan.collections[0]).toMatchObject({ name: 'Bru API', requests: 1 });
    expect(plan.skipped).toEqual([{ path: 'logo.png', why: 'not part of the collection' }]);
    const r = cli('import', dir, '-w', ws, '--apply');
    expect(r.status, r.err).toBe(0);
    expect(names()).toContain('Bru API');
  });

  it('a file that cannot be imported is reported, the others still import', () => {
    const bad = join(t.dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'not a url' } }] } }));
    const r = cli('import', files.b, bad, '-w', ws, '--apply', '--json');
    expect(r.status, r.err).toBe(0);
    const out = data(r.out);
    expect(out.imported.map((i: { error?: unknown }) => !!i.error)).toEqual([false, true]);
  });
});
