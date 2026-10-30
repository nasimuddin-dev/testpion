import { describe, expect, it } from 'vitest';
import { pickForReview, type TestResult } from '../../packages/core/src/index.js';

/** A-6: which answers of a run are put in front of a person: the failed ones first, the rest spread across the run. */
const r = (n: number, status: TestResult['status']): TestResult => ({ id: `e:${n}`, name: `case ${n}`, type: 'llm', status, checks: [] }) as unknown as TestResult;
const run = (statuses: string): TestResult[] => [...statuses].map((s, i) => r(i + 1, s === 'p' ? 'passed' : s === 'f' ? 'failed' : 'skipped'));
const ids = (list: TestResult[]) => list.map((x) => x.id.slice(2)).join(',');

describe('pickForReview', () => {
  it('takes the failed cases first (up to half), then spreads the passed ones across the run', () => {
    // 20 cases, 8 failed (4, 8, 12, 16, 17, 18, 19, 20): ten to review: five failed, five passed spread out
    const picked = pickForReview(run('pppfpppfpppfpppfffff'), 10);
    expect(picked).toHaveLength(10);
    expect(picked.slice(0, 5).map((x) => x.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed']);
    const passed = picked.slice(5).map((x) => Number(x.id.slice(2)));
    // spread: increasing, from the first third to the last third of the passed ones
    expect(passed).toEqual([...passed].sort((a, b) => a - b));
    expect(passed[0]).toBeLessThan(5);
    expect(passed.at(-1)).toBeGreaterThan(10);
  });

  it('a run with fewer failures than half tops up with passed ones; a run with fewer cases than asked gives them all', () => {
    expect(pickForReview(run('ppfpp'), 10)).toHaveLength(5);
    expect(ids(pickForReview(run('ppfpp'), 10))).toBe('3,1,2,4,5');
    const few = pickForReview(run('pfppppppppp'), 4);
    expect(few[0]!.status).toBe('failed');
    expect(few).toHaveLength(4);
  });

  it('many failures: half of the queue, then the rest are topped up with failures when there are not enough passes', () => {
    const picked = pickForReview(run('ffffffffffp'), 10);
    expect(picked.filter((x) => x.status === 'failed')).toHaveLength(9);
    expect(picked.filter((x) => x.status === 'passed')).toHaveLength(1);
  });

  it('skipped cases are never asked about, and an empty run gives nothing', () => {
    expect(pickForReview(run('sssp'), 5).map((x) => x.status)).toEqual(['passed']);
    expect(pickForReview([], 10)).toEqual([]);
  });
});
