/**
 * The `metric` kind in the workspace bundle: a custom RAG metric file (metrics/<id>.yaml) goes out and comes back through
 * Export… and Import…, what a bundle may not bring in is refused, and the registry says the kind exports and imports.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KIND_INFO } from '@testpion/shared';
import { WorkspaceStore, applyImport, bundleAdapter, buildBundle, previewImport, readBundle, syncCustomMetrics, type BundleItem } from '../../packages/core/src/index.js';
import { customMetricFileProblem, customMetricReview } from '../../packages/core/src/transfer/metric-file.js';
import { tempDir } from '../helpers.js';

const tmp = tempDir('tp-transfer-metric-', { alias: true });
afterAll(() => tmp.cleanup());
let n = 0;
const fresh = (name: string) => WorkspaceStore.create(join(tmp.dir, `ws-${++n}`), name);
const write = (s: WorkspaceStore, rel: string, text: string) => {
  mkdirSync(join(s.root, rel, '..'), { recursive: true });
  writeFileSync(join(s.root, rel), text);
};

const JUDGE = 'id: polite\nversion: 2\nkind: judge\nname: Polite\ncriteria: The answer is polite and says "please" or "thank you".\nexamples:\n  - { expect: pass, sample: { answer: "Thank you for asking." } }\n';
const SCRIPT = 'id: shout\nkind: script\nscript: |\n  return { score: sample.answer === sample.answer.toUpperCase() ? 1 : 0 };\n';

describe('the metric kind of a bundle', () => {
  it('the registry says it exports and imports, and the adapter lists the metric files (not presets.yaml)', () => {
    expect(KIND_INFO.metric.capabilities.export).toBe(true);
    expect(KIND_INFO.metric.capabilities.import).toBe(true);
    const s = fresh('Source');
    write(s, 'metrics/polite.yaml', JUDGE);
    write(s, 'metrics/shout.yml', SCRIPT);
    write(s, 'metrics/presets.yaml', 'presets: []\n');
    write(s, 'metrics/notes.txt', 'not a metric');
    expect(bundleAdapter('metric').list(s).map((x) => x.id)).toEqual(['metrics/polite.yaml', 'metrics/shout.yml']);
  });

  it('goes out and comes back byte for byte; the importing workspace registers it; the same bundle again changes nothing', () => {
    const src = fresh('Source');
    write(src, 'metrics/polite.yaml', JUDGE);
    const b = buildBundle(src, [{ kind: 'metric', id: 'metrics/polite.yaml' }]);
    expect(b.manifest.items.map((i) => [i.kind, i.id])).toEqual([['metric', 'metrics/polite.yaml']]);
    const dest = fresh('Dest');
    const out = applyImport(dest, readBundle(b.bytes));
    expect(out.created.map((c) => c.id)).toEqual(['metrics/polite.yaml']);
    expect(readFileSync(join(dest.root, 'metrics', 'polite.yaml'), 'utf8')).toBe(JUDGE);
    expect(syncCustomMetrics(dest).registered).toContain('custom/polite');
    const again = applyImport(dest, readBundle(b.bytes));
    expect(again.created).toEqual([]);
    expect(again.skipped.map((x) => x.why ?? '').join(' ')).toMatch(/identical/);
  });

  it('a metric of the same id in the workspace is a conflict with the usual choices (keep both makes metrics/polite-2.yaml)', () => {
    const src = fresh('Source');
    write(src, 'metrics/polite.yaml', JUDGE);
    const b = buildBundle(src, [{ kind: 'metric', id: 'metrics/polite.yaml' }]);
    const dest = fresh('Dest');
    write(dest, 'metrics/polite.yaml', JUDGE.replace('polite and', 'very polite and'));
    expect(previewImport(dest, readBundle(b.bytes)).items[0]).toMatchObject({ kind: 'metric', action: 'conflict', proposed: { id: 'metrics/polite-2.yaml' } });
    const out = applyImport(dest, readBundle(b.bytes), { onConflict: 'keep-both' });
    expect(out.created.map((c) => c.target.id)).toEqual(['metrics/polite-2.yaml']);
    expect(readFileSync(join(dest.root, 'metrics', 'polite.yaml'), 'utf8')).toContain('very polite');
  });

  it('refuses a file that is not a metric of its own id, and says what to look at before a script or a judge metric runs', () => {
    const item = (id: string): BundleItem => ({ kind: 'metric', id, name: id, entry: '', sha256: '', size: 0, mode: 'embed' }) as unknown as BundleItem;
    const check = (id: string, text: string) => bundleAdapter('metric').check(item(id), Buffer.from(text));
    expect(check('metrics/polite.yaml', JUDGE)).toBeUndefined();
    expect(check('metrics/Polite.yaml', JUDGE)).toMatch(/not a metric id/);
    expect(check('metrics/other.yaml', JUDGE)).toMatch(/its id is "polite", the file name says "other"/);
    expect(check('metrics/polite.yaml', 'id: polite\nkind: telepathy\n')).toMatch(/not a kind of metric/);
    expect(check('metrics/polite.yaml', '- a\n- b\n')).toMatch(/is a map/);
    expect(check('metrics/polite.yaml', 'a: [unclosed')).toMatch(/not YAML/);
    expect(check('metrics/polite.txt', JUDGE)).toBeTruthy();
    // a half-written metric is carried and said to be unusable
    expect(customMetricFileProblem('metrics/draft.yaml', Buffer.from('id: draft\nkind: judge\n'))).toBeUndefined();
    expect(customMetricReview('metrics/draft.yaml', Buffer.from('id: draft\nkind: judge\n')).join(' ')).toMatch(/not usable until it is fixed/);
    expect(customMetricReview('metrics/shout.yaml', Buffer.from(SCRIPT)).join(' ')).toMatch(/is a script: it runs when a sample is scored/);
    expect(customMetricReview('metrics/polite.yaml', Buffer.from(JUDGE)).join(' ')).toMatch(/asks a judge model/);
  });

  it('secrets in a metric file are replaced on the way out like in any other file', () => {
    const src = fresh('Source');
    write(src, 'metrics/leaky.yaml', `${JUDGE.replace('id: polite', 'id: leaky')}notes: "key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"\n`);
    const b = buildBundle(src, [{ kind: 'metric', id: 'metrics/leaky.yaml' }]);
    const text = readBundle(b.bytes).files?.get?.('metrics/leaky.yaml')?.toString('utf8') ?? JSON.stringify(readBundle(b.bytes));
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH');
  });
});
