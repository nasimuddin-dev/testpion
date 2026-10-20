import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { tempDir } from '../helpers.js';

// B-08a: the GitHub Action's job summary carries the run's report and triage.md.
const root = join(__dirname, '../..');
const script = join(root, 'scripts', 'job-summary.mjs');
const REPORT = '# TestPion report\n\n3 tests, 1 failed\n';
const TRIAGE = '## Triage\n\n1 failure of run r1 (x) in 1 group · grouped by TestPion (no model).\n';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function summaryOf(files: Record<string, string>): string {
  const t = tempDir('tp-job-summary-');
  cleanups.push(t.cleanup);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(t.dir, name), text);
  const out = join(t.dir, 'step-summary.md');
  const r = spawnSync(process.execPath, [script, t.dir], { env: { ...process.env, GITHUB_STEP_SUMMARY: out }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  try {
    return readFileSync(out, 'utf8');
  } catch {
    return '';
  }
}

describe('scripts/job-summary.mjs', () => {
  it('writes the report and then the triage text into $GITHUB_STEP_SUMMARY', () => {
    const s = summaryOf({ 'report.md': REPORT, 'triage.md': TRIAGE });
    expect(s).toContain('3 tests, 1 failed');
    expect(s).toContain('grouped by TestPion');
    expect(s.indexOf('3 tests')).toBeLessThan(s.indexOf('## Triage'));
  });

  it('shows the triage once when the report already ends with its AI section (CRLF reports too)', () => {
    const ai = '## Triage (AI)\n\nThe token expired.\n';
    const s = summaryOf({ 'report.md': `${REPORT}\n${ai}`.replace(/\n/g, '\r\n'), 'triage.md': ai });
    expect(s.match(/The token expired\./g)).toHaveLength(1);
    expect(s).toContain('3 tests, 1 failed');
  });

  it('is empty for a run with neither file, and the report alone without a triage', () => {
    expect(summaryOf({})).toBe('');
    expect(summaryOf({ 'report.md': REPORT }).trim()).toBe(REPORT.trim());
  });

  it('is a step of the action that always runs, with a triage input that adds --triage to every run line', () => {
    const text = readFileSync(join(root, 'action.yml'), 'utf8');
    const action = parseYaml(text) as { inputs: Record<string, unknown>; runs: { steps: Array<{ name?: string; if?: string; run?: string }> } };
    expect(action.inputs.triage).toBeTruthy();
    const step = action.runs.steps.find((s) => s.run?.includes('job-summary.mjs'));
    expect(step?.if).toBe('always()');
    expect(text.match(/\$TRIAGE/g)?.length).toBe(3);
    expect(text.match(/junit html markdown/g)?.length).toBe(3);
  });
});
