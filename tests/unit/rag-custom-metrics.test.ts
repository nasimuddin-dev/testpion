/**
 * Custom metrics (planning/rag-testing.md §4d): the formula language, the check of a file, the registration of a
 * workspace's `metrics/` folder in the same registry as the built-in metrics, and the kinds that need no model (rule,
 * formula over deterministic metrics, embedding set, script). The script walls have their own file; the judged kinds are in
 * tests/ai/rag-custom-metric.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ProviderRegistry, VariableScope, WorkspaceStore, compileCustomMetric, customMetrics, evalFormula, getMetric, listMetricFiles, metricCatalogue, parseCustomMetric, parseFormula, readMetricFile, removeMetricFile, resolveMetric, runChecks, runMetricExamples, syncCustomMetrics, validateCustomMetric, writeMetricFile, type CheckContext } from '../../packages/core/src/index.js';
import { customMetricTemplate, CUSTOM_METRIC_KINDS } from '@testpion/shared';
import { tempDir } from '../helpers';

const f = (src: string, refs: Record<string, number | null> = {}) => {
  const p = parseFormula(src);
  expect(p.problems, src).toEqual([]);
  return evalFormula(p.ast!, (n) => refs[n] ?? null);
};

describe('the formula language', () => {
  it('numbers, precedence and parentheses', () => {
    expect(f('1 + 2 * 3')).toBe(7);
    expect(f('(1 + 2) * 3')).toBe(9);
    expect(f('10 / 4 - 1')).toBe(1.5);
    expect(f('-2 + 5')).toBe(3);
    expect(f('2 * -3')).toBe(-6);
    expect(f('.5 + 1e1')).toBe(10.5);
  });

  it('references, with underscores and in backticks', () => {
    expect(f('0.5 * faithfulness + 0.5 * answer_relevance', { faithfulness: 0.8, answer_relevance: 0.6 })).toBeCloseTo(0.7, 9);
    expect(f('`recall@5` * 2', { 'recall@5': 0.25 })).toBe(0.5);
    expect(parseFormula('a_b + `custom/tone`').refs).toEqual(['a_b', 'custom/tone']);
  });

  it('min, max, mean, abs, round, clamp', () => {
    expect(f('min(0.9, 0.7, 0.8)')).toBe(0.7);
    expect(f('max(1, 3)')).toBe(3);
    expect(f('mean(1, 2, 6)')).toBe(3);
    expect(f('abs(-4)')).toBe(4);
    expect(f('round(3.14159, 2)')).toBe(3.14);
    expect(f('clamp(1.4, 0, 1)')).toBe(1);
  });

  it('comparisons, boolean logic, if and gate', () => {
    expect(f('gate(faithfulness >= 0.8, answer_accuracy, 0)', { faithfulness: 0.85, answer_accuracy: 0.9 })).toBe(0.9);
    expect(f('gate(faithfulness >= 0.8, answer_accuracy, 0)', { faithfulness: 0.5, answer_accuracy: 0.9 })).toBe(0);
    expect(f('if(1 == 1 && 2 != 3, 10, 20)')).toBe(10);
    expect(f('if(!(1 > 2) || 0, 1, 2)')).toBe(1);
  });

  it('n/a propagates, unless coalesce says what to use; an && with a known 0 is still 0', () => {
    expect(f('faithfulness + 1', {})).toBeNull();
    expect(f('min(faithfulness, 0.5)', {})).toBeNull();
    expect(f('coalesce(faithfulness, 0.5) + 1', {})).toBe(1.5);
    expect(f('coalesce(a, b, 7)', { b: null })).toBe(7);
    expect(f('0 && faithfulness', {})).toBe(0);
    expect(f('1 || faithfulness', {})).toBe(1);
    expect(f('if(faithfulness > 0.5, 1, 2)', {})).toBeNull();
    expect(f('1 / 0')).toBeNull();
  });

  it('refuses what is not arithmetic: unknown functions, bad syntax, deep nesting, long text', () => {
    expect(parseFormula('eval(1)').problems[0]).toMatch(/not a function/);
    expect(parseFormula('1 +').problems[0]).toMatch(/ends too early/);
    expect(parseFormula('1 2').problems[0]).toMatch(/unexpected/);
    expect(parseFormula('process.exit(1)').problems.length).toBeGreaterThan(0);
    expect(parseFormula('min()').problems[0]).toMatch(/takes 1 to 20/);
    expect(parseFormula('clamp(1)').problems[0]).toMatch(/takes 3/);
    expect(parseFormula('(').problems.length).toBeGreaterThan(0);
    expect(parseFormula('('.repeat(200) + '1' + ')'.repeat(200)).problems[0]).toMatch(/nested too deeply/);
    expect(parseFormula('1+'.repeat(1500) + '1').problems[0]).toMatch(/longer than/);
    expect(parseFormula('').problems[0]).toMatch(/empty/);
    expect(parseFormula('"a"').problems[0]).toMatch(/unexpected/);
  });
});

describe('the check of a file', () => {
  const ok = (over: Record<string, unknown>) => validateCustomMetric({ id: 'tone', kind: 'judge', criteria: 'Polite', ...over }, { fileId: 'tone' });
  const errors = (over: Record<string, unknown>) => ok(over).filter((p) => p.level === 'error').map((p) => p.field ?? p.message);

  it('a valid file of every kind has no error (the editor’s starting files)', () => {
    for (const k of CUSTOM_METRIC_KINDS) {
      const t = customMetricTemplate(k.id, 'sample');
      const p = validateCustomMetric(t, { fileId: 'sample' }).filter((x) => x.level === 'error');
      // the formula template reads two built-in metrics, which exist
      expect(p, k.id).toEqual([]);
    }
  });

  it('ids: the alphabet, the file name, and built-in names are refused', () => {
    expect(errors({ id: 'Bad Id' })).toContain('id');
    expect(validateCustomMetric({ id: 'a', kind: 'judge', criteria: 'x' }, { fileId: 'b' }).some((p) => /must equal the file name/.test(p.message))).toBe(true);
    expect(errors({ id: 'faithfulness' }).length).toBeGreaterThan(0);
    expect(validateCustomMetric({ id: 'faithfulness', kind: 'judge', criteria: 'x' }).some((p) => /built-in/.test(p.message))).toBe(true);
  });

  it('kind and fields: each says what is wrong', () => {
    expect(errors({ kind: 'magic' })).toContain('kind');
    expect(errors({ criteria: '' })).toContain('criteria');
    expect(errors({ scale: [3, 1] })).toContain('scale');
    expect(errors({ scale: 'binary', votes: 2 })).toContain('votes');
    expect(errors({ threshold: 'high' })).toContain('threshold');
    expect(errors({ inputs: ['answer', 'secrets'] })).toContain('inputs');
    expect(errors({ kind: 'checklist', criteria: undefined, items: [] })).toContain('items');
    expect(errors({ kind: 'checklist', criteria: undefined, items: [{ text: 'a', weight: 0 }] })).toContain('items');
    expect(errors({ kind: 'rule', criteria: undefined, rules: [{ type: 'faithfulness' }] })).toContain('rules[0]');
    expect(errors({ kind: 'rule', criteria: undefined, rules: [{ type: 'no-such' }] })).toContain('rules[0]');
    expect(errors({ kind: 'rule', criteria: undefined, rules: [{ type: 'regex', pattern: 'x' }], combine: 'most' })).toContain('combine');
    expect(errors({ kind: 'formula', criteria: undefined, expression: 'nope + 1' })).toContain('expression');
    expect(errors({ kind: 'formula', criteria: undefined, expression: 'tone + 1' })).toContain('expression');
    expect(errors({ kind: 'script', criteria: undefined })).toContain('script');
    expect(errors({ examples: [{ sample: {}, expect: 'maybe' }] })).toContain('examples[0]');
    expect(ok({ typo: 1 }).some((p) => p.level === 'warning' && p.field === 'typo')).toBe(true);
  });

  it('a rule metric is deterministic: a judged or embedding check is refused', () => {
    expect(errors({ kind: 'rule', criteria: undefined, rules: [{ type: 'semantic-similarity' }] })).toContain('rules[0]');
    expect(errors({ kind: 'rule', criteria: undefined, rules: [{ type: 'context-recall' }] })).toContain('rules[0]');
    expect(errors({ kind: 'rule', criteria: undefined, rules: [{ type: 'not-contains', expected: 'x' }, { type: 'length', max: 10 }] })).toEqual([]);
  });

  it('YAML in, a checked metric out; broken YAML and large files are errors', () => {
    expect(parseCustomMetric(stringify({ id: 'tone', kind: 'judge', criteria: 'Polite' }), { fileId: 'tone' }).metric).toMatchObject({ id: 'tone', version: 1 });
    expect(parseCustomMetric('id: [unclosed', {}).problems[0]!.message).toMatch(/Not valid YAML/);
    expect(parseCustomMetric('x'.repeat(200 * 1024), {}).problems[0]!.message).toMatch(/larger than/);
  });

  it('the hash covers what scores, not the words around it', () => {
    const a = compileCustomMetric({ id: 'tone', kind: 'judge', criteria: 'Polite', name: 'A' });
    const b = compileCustomMetric({ id: 'tone', kind: 'judge', criteria: 'Polite', name: 'B', description: 'other', examples: [{ sample: {}, expect: 'pass' }] });
    const c = compileCustomMetric({ id: 'tone', kind: 'judge', criteria: 'Rude' });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

describe('the metrics folder of a workspace', () => {
  const t = tempDir('tp-custom-metrics-');
  let store: WorkspaceStore;
  beforeAll(() => {
    store = WorkspaceStore.create(join(t.dir, 'ws'), 'Custom');
  });
  afterAll(() => {
    syncCustomMetrics(store);
    store.close();
    t.cleanup();
  });

  it('files are listed, read, written and removed by id', () => {
    expect(listMetricFiles(store)).toEqual([]);
    writeMetricFile(store, 'no-guarantees', stringify({ id: 'no-guarantees', kind: 'rule', rules: [{ type: 'not-contains', expected: 'guarantee' }] }));
    expect(listMetricFiles(store).map((x) => x.id)).toEqual(['no-guarantees']);
    expect(readMetricFile(store, 'no-guarantees')!.text).toContain('not-contains');
    expect(() => writeMetricFile(store, '../escape', 'x')).toThrow(/not a metric id/);
    expect(readMetricFile(store, 'nothing')).toBeUndefined();
  });

  it('sync registers the valid files under custom/<id> (and the bare id), and reports the others', () => {
    writeMetricFile(store, 'bad', stringify({ id: 'bad', kind: 'judge' }));
    writeMetricFile(store, 'short-answer', stringify({ id: 'short-answer', version: 3, kind: 'rule', rules: [{ type: 'length', max: 12 }], description: 'At most 12 characters' }));
    const r = syncCustomMetrics(store);
    expect(r.registered.sort()).toEqual(['custom/no-guarantees', 'custom/short-answer']);
    expect(r.files.map((x) => x.id)).toEqual(['bad']);
    expect(r.files[0]!.problems[0]!.message).toMatch(/needs criteria/);
    expect(resolveMetric('custom/short-answer')!.def).toMatchObject({ group: 'custom', kind: 'deterministic', check: 'custom/short-answer', version: 'short-answer-v3', custom: { kind: 'rule', fileVersion: 3, file: 'metrics/short-answer.yaml' } });
    expect(resolveMetric('short-answer')!.def.id).toBe('custom/short-answer');
    expect(customMetrics().map((m) => m.id)).toContain('custom/no-guarantees');
    // the catalogue lists them with the others, in their own group
    expect(metricCatalogue().filter((m) => m.group === 'custom')).toHaveLength(2);
  });

  it('a rule metric runs as a check anywhere: the weighted share, all, any, and the version and hash with the result', async () => {
    writeMetricFile(store, 'weighted', stringify({ id: 'weighted', kind: 'rule', combine: 'weights', rules: [{ type: 'contains', expected: 'hours', weight: 3 }, { type: 'not-contains', expected: 'guarantee', weight: 1 }], threshold: 0.7 }));
    syncCustomMetrics(store);
    const ctx = (text: string): CheckContext => ({ testType: 'rag', body: text, text });
    const [pass] = await runChecks([{ type: 'custom/weighted' }], ctx('Our hours are 8 to 6. No guarantee.'));
    expect(pass).toMatchObject({ score: 0.75, passed: true });
    expect((pass!.metadata as { customMetric: { version: number; hash: string } }).customMetric).toMatchObject({ id: 'custom/weighted', version: 1 });
    const [fail] = await runChecks([{ type: 'weighted' }], ctx('We open early.'));
    expect(fail!.score).toBe(0.25);
    expect(fail!.passed).toBe(false);
    const [all] = await runChecks([{ type: 'custom/no-guarantees' }], ctx('We guarantee a cure.'));
    expect(all!.passed).toBe(false);
  });

  it('a formula reads other metrics (built-in and custom) and n/a propagates', async () => {
    writeMetricFile(store, 'combo', stringify({ id: 'combo', kind: 'formula', expression: '0.5 * token_f1 + 0.5 * short_answer', threshold: 0.7 }));
    writeMetricFile(store, 'guarded', stringify({ id: 'guarded', kind: 'formula', expression: 'coalesce(token_f1, 0.25) * 2' }));
    const r = syncCustomMetrics(store);
    expect(r.files.filter((x) => x.id === 'combo' || x.id === 'guarded')).toEqual([]);
    const ctx: CheckContext = { testType: 'rag', body: '', text: 'opens at 8am', expected: 'opens at 8am' };
    const [c] = await runChecks([{ type: 'custom/combo' }], ctx);
    expect(c).toMatchObject({ score: 1, passed: true });
    expect((c!.metadata as { items: Array<{ text: string; ok: boolean }> }).items.map((i) => i.text)).toEqual(['token_f1', 'short_answer']);
    // token-f1 needs a reference: without one the formula has no value, and says which metric is the reason
    const [n] = await runChecks([{ type: 'custom/combo' }], { testType: 'rag', body: '', text: 'opens' });
    expect((n!.metadata as { na?: string }).na).toMatch(/token_f1 had no score/);
    const [g] = await runChecks([{ type: 'custom/guarded' }], { testType: 'rag', body: '', text: 'opens at 8am' });
    expect(g!.score).toBe(0.5);
  });

  it('a depends-on chain registers in order; a cycle is refused for the files in it', () => {
    writeMetricFile(store, 'cyc-a', stringify({ id: 'cyc-a', kind: 'formula', expression: 'cyc_b + 1' }));
    writeMetricFile(store, 'cyc-b', stringify({ id: 'cyc-b', kind: 'formula', expression: 'cyc_a + 1' }));
    const r = syncCustomMetrics(store);
    const cyc = r.files.filter((x) => x.id.startsWith('cyc-'));
    expect(cyc.map((x) => x.id).sort()).toEqual(['cyc-a', 'cyc-b']);
    expect(cyc[0]!.problems.map((p) => p.message).join()).toMatch(/read each other in a circle/);
    expect(r.registered).not.toContain('custom/cyc-a');
    removeMetricFile(store, 'cyc-a');
    removeMetricFile(store, 'cyc-b');
  });

  it('a removed file leaves the registry (and its check) at the next sync', async () => {
    expect(getMetric('custom/weighted')).toBeDefined();
    expect(removeMetricFile(store, 'weighted')).toBe(true);
    expect(removeMetricFile(store, 'weighted')).toBe(false);
    syncCustomMetrics(store);
    expect(getMetric('custom/weighted')).toBeUndefined();
    expect(resolveMetric('weighted')).toBeUndefined();
    const [r] = await runChecks([{ type: 'custom/weighted' }], { testType: 'rag', body: '', text: 'x' });
    expect(r!.message).toMatch(/unknown check type/);
  });

  it('a name that a built-in metric has is never taken by a custom one', () => {
    writeMetricFile(store, 'rouge', stringify({ id: 'rouge', kind: 'rule', rules: [{ type: 'length', max: 5 }] }));
    const r = syncCustomMetrics(store);
    expect(r.files.find((x) => x.id === 'rouge')!.problems[0]!.message).toMatch(/built-in/);
    expect(resolveMetric('rouge')!.def.id).toBe('rouge');
    removeMetricFile(store, 'rouge');
  });
});

describe('embedding-set metrics (mock embedder) and the examples', () => {
  const providers = () => new ProviderRegistry([], new VariableScope());

  it('closeness to a good answer by embedding; a bad answer fails an example; an unset embedder says so', async () => {
    const c = compileCustomMetric({
      id: 'on-brand',
      kind: 'embedding-set',
      good: ['The clinic opens at 8am on weekdays.'],
      negatives: ['we are closed'],
      embedder: 'mock',
      threshold: 0.9,
      examples: [
        { name: 'same', sample: { answer: 'The clinic opens at 8am on weekdays.' }, expect: 'pass' },
        { name: 'closed', sample: { answer: 'we are closed' }, expect: 'fail' },
      ],
    });
    const rs = await runMetricExamples(c, { providers: providers() });
    expect(rs.map((r) => [r.got, r.ok])).toEqual([['pass', true], ['fail', true]]);
    const noEmbedder = compileCustomMetric({ id: 'x', kind: 'embedding-set', good: ['a'], examples: [{ sample: { answer: 'a' }, expect: 'pass' }] });
    const r = await runMetricExamples(noEmbedder, { providers: providers() });
    // no embedding model is not a verdict: the example has no score, and the message says what to set up
    expect(r[0]).toMatchObject({ got: 'na', ok: false });
    expect(r[0]!.message).toMatch(/needs an embedding model/);
  });

  it('rule examples agree or not, with the reason', async () => {
    const c = compileCustomMetric({
      id: 'short',
      kind: 'rule',
      rules: [{ type: 'length', max: 20, unit: 'chars' }],
      examples: [
        { sample: { answer: 'short one' }, expect: 'pass' },
        { sample: { answer: 'this answer is far too long to pass' }, expect: 'pass' },
      ],
    });
    const rs = await runMetricExamples(c, {});
    expect(rs.map((r) => r.ok)).toEqual([true, false]);
    expect(rs[1]).toMatchObject({ expect: 'pass', got: 'fail' });
  });
});
