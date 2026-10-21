import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { WorkspaceStore, ciCommand, ciConfig, rotateEvaluation, rotatingIndexes, utcDay, validateMonitor, type SavedEvaluation } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-nightly-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Nightly');
const records = Array.from({ length: 40 }, (_, i) => ({ question: `q${i + 1}`, reference: `a${i + 1}` }));
store.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev', name: 'Clinic RAG', data: { type: 'rag', name: 'Clinic RAG', datasetFormat: 'jsonl', dataset: records.map((r) => JSON.stringify(r)).join('\n'), evaluators: [{ type: 'token-f1' }] } as never }] } as never);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the rotating sample', () => {
  it('the same day picks the same records, the next day other ones, and a month covers the dataset', () => {
    const day = utcDay('2026-10-20');
    expect(rotatingIndexes(40, 8, day)).toEqual(rotatingIndexes(40, 8, day));
    expect(rotatingIndexes(40, 8, day)).not.toEqual(rotatingIndexes(40, 8, day + 1));
    const seen = new Set<number>();
    for (let d = 0; d < 5; d++) for (const i of rotatingIndexes(40, 8, day + d)) seen.add(i);
    expect(seen.size).toBe(40);
    expect(rotatingIndexes(5, 8, day)).toEqual([0, 1, 2, 3, 4]);
    expect(rotatingIndexes(0, 3, day)).toEqual([]);
    expect(utcDay('2026-10-20')).toBe(utcDay('2026-10-20T23:59:59Z'));
  });
  it('an evaluation cut to a night keeps each record’s own id, so labels and trends still match it', () => {
    const ev = store.getLibrary<SavedEvaluation>('evaluations').items[0]!.data;
    const a = rotateEvaluation(ev, 8, utcDay('2026-10-20'));
    const rows = a.evaluation.dataset.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; question: string });
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.id).toBe(r.question.slice(1));
    expect(a.evaluation.limit).toBeUndefined();
    expect(a.note).toMatch(/^day \d+: 8 of 40 records$/);
    expect(rotateEvaluation(ev, 8, utcDay('2026-10-21')).evaluation.dataset).not.toBe(a.evaluation.dataset);
  });
});

describe('monitor options of a RAG evaluation', () => {
  const base = { name: 'Nightly', evaluation: 'Clinic RAG', everyMinutes: 1440, enabled: true };
  it('are checked when the monitor is saved', () => {
    expect(() => validateMonitor(store, { ...base, rotate: true, limit: 8, maxCostUsd: 0.5, baseline: 'previous', maxDrop: 0.05 })).not.toThrow();
    expect(() => validateMonitor(store, { ...base, rotate: true })).toThrow(/needs the number of records/);
    expect(() => validateMonitor(store, { ...base, maxCostUsd: -1 })).toThrow(/cost limit/);
    expect(() => validateMonitor(store, { ...base, baseline: 'best', maxDrop: 0 })).toThrow(/largest drop/);
    expect(() => validateMonitor(store, { ...base, baseline: ' ' })).toThrow(/baseline/);
  });
});

describe('the nightly CI templates', () => {
  const o = { ragEvaluation: 'Clinic RAG', ragNightly: '0 3 * * *', ragSample: 25, ragRegression: true, ragMaxDrop: 0.04, ragMin: ['faithfulness=0.8'], ragComment: true };
  it('the command samples with a rotation and compares with the previous results', () => {
    const cmd = ciCommand({ provider: 'github', ...o });
    expect(cmd).toContain('--limit 25 --rotate');
    expect(cmd).toContain('--baseline-results previous/results.jsonl --max-regression 0.04');
    expect(ciCommand({ provider: 'github', ragEvaluation: 'Clinic RAG' })).not.toContain('--rotate');
  });
  it('GitHub: a schedule and a manual start instead of push, and the previous results fetched', () => {
    const c = ciConfig(store, { provider: 'github', ...o });
    const wf = parseYaml(c.content) as { on: Record<string, unknown>; jobs: { testpion: { steps: Array<{ name: string; run?: string }> } } };
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.on.schedule).toEqual([{ cron: '0 3 * * *' }]);
    const names = wf.jobs.testpion.steps.map((s) => s.name);
    expect(names.findIndex((n) => /previous run/.test(n))).toBeGreaterThan(-1);
    expect(names.findIndex((n) => /previous run/.test(n))).toBeLessThan(names.findIndex((n) => /^Run RAG/.test(n)));
    expect(c.content).toContain('gh run download');
    // without the option it is the per-push workflow as before
    expect(Object.keys((parseYaml(ciConfig(store, { provider: 'github', ragEvaluation: 'Clinic RAG' }).content) as { on: object }).on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
  });
  it('GitLab: runs on a pipeline schedule and downloads the last artifact', () => {
    const c = ciConfig(store, { provider: 'gitlab', ...o });
    const doc = parseYaml(c.content) as { 'api-tests': { rules: Array<{ if: string }>; script: string[] } };
    expect(doc['api-tests'].rules[0]!.if).toContain('schedule');
    expect(doc['api-tests'].script.join('\n')).toContain('jobs/artifacts/$CI_DEFAULT_BRANCH/download?job=api-tests');
    expect(c.content).toContain('Pipeline schedules');
  });
  it('Azure: a schedule, no push trigger, and the previous artifact downloaded', () => {
    const c = ciConfig(store, { provider: 'azure', ...o });
    const doc = parseYaml(c.content) as { trigger: string; schedules: Array<{ cron: string; always: boolean }>; steps: Array<{ task?: string }> };
    expect(doc.trigger).toBe('none');
    expect(doc.schedules[0]).toMatchObject({ cron: '0 3 * * *', always: true });
    expect(doc.steps.some((s) => s.task === 'DownloadPipelineArtifact@2')).toBe(true);
  });
  it('Jenkins: a cron trigger, and it says the baseline needs a plugin', () => {
    const c = ciConfig(store, { provider: 'jenkins', ...o });
    expect(c.content).toContain("triggers { cron('0 3 * * *') }");
    expect(c.content).toContain('Copy Artifact plugin');
  });
  it('mistakes are refused: not a cron, a nightly job without an evaluation, a sample under 1', () => {
    expect(() => ciConfig(store, { provider: 'github', ragEvaluation: 'Clinic RAG', ragNightly: 'every night' })).toThrow(/cron expression/);
    expect(() => ciConfig(store, { provider: 'github', tests: ['.'], ragNightly: '0 3 * * *' })).toThrow(/belong to a RAG evaluation/);
    expect(() => ciConfig(store, { provider: 'github', ragEvaluation: 'Clinic RAG', ragSample: 0 })).toThrow(/number of records/);
  });
});
