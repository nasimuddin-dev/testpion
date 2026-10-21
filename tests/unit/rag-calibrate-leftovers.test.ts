/**
 * Calibration follow-ups, the deterministic parts: the numbers of each member of a jury, calibration of the safety and the
 * conversation judges (a label belongs to the whole transcript it was made on), the Markdown report, and the text edit that
 * adds an example to a metric file. No model is called.
 */
import { describe, expect, it } from 'vitest';
import { appendExample, calibrationMarkdown, calibrationReport, collectSamples, hash12, parseCustomMetric, transcriptText, type RagLabel, type TestResult } from '../../packages/core/src/index.js';

const TURNS = [
  { role: 'user', content: 'Hi, I am Ann.' },
  { role: 'assistant', content: 'Hello Ann.' },
  { role: 'user', content: 'What was my name?' },
  { role: 'assistant', content: 'I do not know.' },
];

const juryResult = (record: string, members: boolean[], opts: { score: number; metric?: string; turns?: typeof TURNS } = { score: 0.5 }): TestResult =>
  ({
    id: `eval:${record}`,
    name: record,
    status: 'passed',
    checks: [
      {
        type: opts.metric ?? 'toxicity',
        name: opts.metric ?? 'toxicity',
        passed: true,
        source: 'ai-judge',
        score: opts.score,
        message: 'm',
        metadata: {
          threshold: 0.7,
          judge: { provider: 'a', model: 'm1' },
          promptVersion: 'toxicity-v1',
          panel: { aggregate: 'majority', judges: members.map((passed, i) => ({ provider: `j${i + 1}`, model: 'm', score: passed ? 1 : 0, passed })) },
        },
      },
    ],
    metadata: { rag: { query: `q ${record}`, sample: { answer: `a ${record}` }, ...(opts.turns ? { record: { turns: opts.turns } } : {}) } },
  }) as unknown as TestResult;

async function* stream(rs: TestResult[]) {
  for (const r of rs) yield r;
}

const label = (record: string, metric: string, pass: boolean, extra: Partial<RagLabel> = {}): RagLabel => ({ record, metric, label: pass ? 'pass' : 'fail', run: 'r', resultId: `eval:${record}`, at: '2026-10-21T00:00:00Z', ...extra });

describe('the numbers of each member of a jury', () => {
  it('a jury is one judge for the verdict and three for the numbers: each member against the same labels', async () => {
    // member j1 always agrees with the person, j2 always passes, j3 always fails; the jury (majority) passes when two do
    const rows: Array<[string, boolean, boolean[]]> = [
      ['r1', true, [true, true, false]],
      ['r2', true, [true, true, false]],
      ['r3', false, [false, true, false]],
      ['r4', false, [false, true, false]],
    ];
    const results = rows.map(([rec, , members]) => juryResult(rec, members, { score: members.filter(Boolean).length > 1 ? 1 : 0 }));
    const labels = rows.map(([rec, human]) => label(rec, 'toxicity', human));
    const report = calibrationReport(await collectSamples(stream(results), { labels }));
    const m = report.metrics[0]!;
    const by = Object.fromEntries(m.byJudge.map((j) => [`${j.role}:${j.judge}`, j.agreement]));
    expect(by['member:j1/m']).toMatchObject({ n: 4, accuracy: 1, kappa: 1 });
    expect(by['member:j2/m']).toMatchObject({ n: 4, accuracy: 0.5, tpr: 1, tnr: 0 });
    expect(by['member:j3/m']).toMatchObject({ n: 4, accuracy: 0.5, tpr: 0, tnr: 1 });
    // together: the jury's majority passed r1 and r2 and r4 (j2 and one more), so it agrees with the labels on three of four
    const together = m.byJudge.find((j) => j.role === 'jury')!;
    expect(together.judge).toBe('jury of 3 (majority)');
    expect(together.agreement.n).toBe(4);
    expect(m.group).toBe('safety');
    expect(m.disagreements).toEqual([]);
  });

  it('a disagreement says who on the jury said what', async () => {
    const r = juryResult('r1', [true, true, false], { score: 1 });
    const m = calibrationReport(await collectSamples(stream([r]), { labels: [label('r1', 'toxicity', false)] })).metrics[0]!;
    expect(m.disagreements[0]!.jury).toEqual([
      { judge: 'j1/m', pass: true },
      { judge: 'j2/m', pass: true },
      { judge: 'j3/m', pass: false },
    ]);
  });

  it('a lone judge keeps one row, as before', async () => {
    const lone = juryResult('r1', [true]);
    delete (lone.checks[0]!.metadata as { panel?: unknown }).panel;
    const report = calibrationReport(await collectSamples(stream([lone]), { labels: [label('r1', 'toxicity', true)] }));
    expect(report.metrics[0]!.byJudge.map((j) => j.role)).toEqual(['single']);
  });
});

describe('safety and conversation judges', () => {
  it('an unsafe answer that gets through is called out in the advice for a safety metric', async () => {
    const rs = Array.from({ length: 12 }, (_, i) => juryResult(`r${i}`, [true], { score: 1 }));
    const labels = rs.map((r, i) => label(`r${i}`, 'toxicity', i < 4));
    const m = calibrationReport(await collectSamples(stream(rs), { labels })).metrics[0]!;
    expect(m.verdict).not.toBe('good');
    expect(m.advice).toMatch(/lenient.*an unsafe answer gets through/);
  });

  it('a conversation label belongs to the whole transcript: another conversation makes it stale, and the disagreement shows the turns', async () => {
    const a = juryResult('c1', [true], { score: 1, metric: 'conversation-completeness', turns: TURNS });
    const changed = [...TURNS.slice(0, 3), { role: 'assistant', content: 'Your name is Ann.' }];
    const b = juryResult('c2', [true], { score: 1, metric: 'conversation-completeness', turns: changed });
    const labels = [
      label('c1', 'conversation-completeness', false, { transcriptHash: hash12(transcriptText(TURNS)) }),
      // c2 was labelled on the first conversation: the same record went differently this time
      label('c2', 'conversation-completeness', false, { transcriptHash: hash12(transcriptText(TURNS)) }),
    ];
    const c = await collectSamples(stream([a, b]), { labels });
    expect(c.stale).toBe(1);
    expect(c.samples.map((s) => s.record)).toEqual(['c1']);
    const m = calibrationReport(c).metrics[0]!;
    expect(m.group).toBe('conversation');
    expect(m.disagreements[0]!.conversation?.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('the report as Markdown', () => {
  it('has the numbers, the confusion table, each judge of a jury and the disagreements', async () => {
    const rs = [juryResult('r1', [true, false, false], { score: 0 }), juryResult('r2', [true, true, true], { score: 1 })];
    const labels = [label('r1', 'toxicity', true, { note: 'it is fine' }), label('r2', 'toxicity', true)];
    const md = calibrationMarkdown(calibrationReport(await collectSamples(stream(rs), { labels }), { run: 'run-1', labels: 'set-1', tune: true }));
    expect(md).toMatch(/^# Judge calibration · run-1/);
    expect(md).toContain('labels/set-1.json');
    expect(md).toContain('## toxicity');
    expect(md).toMatch(/\*\*Judge: pass\*\* \| \d+ \| \d+ \(too lenient\) \|/);
    expect(md).toContain('jury member');
    expect(md).toContain('the jury together');
    expect(md).toMatch(/Where the judge and the person disagree \(1\)/);
    expect(md).toContain('Note: it is fine');
    expect(calibrationMarkdown(calibrationReport(await collectSamples(stream([]), { labels: [] })))).toContain('Nothing to compare yet');
  });
});

describe('appending an example to a metric file', () => {
  const entry = JSON.stringify({ name: 'n', expect: 'fail', sample: { question: 'q', answer: 'a "quoted" | pipe: colon' } });
  const base = 'id: demo\nkind: rule\nrules:\n  - type: contains\n    expected: hello\n';

  it('adds the key when there is none, keeps the file’s comments, and the result parses', () => {
    const text = appendExample(`# my metric\n${base}`, entry);
    expect(text.startsWith('# my metric\n')).toBe(true);
    const p = parseCustomMetric(text, { fileId: 'demo' });
    expect(p.problems.filter((x) => x.level === 'error')).toEqual([]);
    expect(p.metric!.examples).toHaveLength(1);
    expect(p.metric!.examples![0]!.sample.answer).toBe('a "quoted" | pipe: colon');
  });

  it('adds to a block list before the next key, to an empty list, and keeps the line endings', () => {
    const one = appendExample(base, entry);
    const two = appendExample(`${one}threshold: 1\n`, entry.replace('"fail"', '"pass"'));
    const p = parseCustomMetric(two, { fileId: 'demo' });
    expect(p.metric!.examples!.map((e) => e.expect)).toEqual(['fail', 'pass']);
    expect(two.indexOf('"pass"')).toBeLessThan(two.indexOf('threshold: 1'));
    const empty = parseCustomMetric(appendExample(`${base}examples: []\n`, entry), { fileId: 'demo' });
    expect(empty.metric!.examples).toHaveLength(1);
    expect(appendExample(base.replace(/\n/g, '\r\n'), entry)).toContain('\r\nexamples:\r\n  - {');
  });

  it('refuses a list written on one line instead of guessing', () => {
    expect(() => appendExample(`${base}examples: [{ expect: pass, sample: { answer: x } }]\n`, entry)).toThrow(/by hand/);
  });
});
