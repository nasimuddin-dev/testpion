#!/usr/bin/env node
/**
 * The GitHub Action's job summary (action.yml): `node scripts/job-summary.mjs <reports folder>` appends the run's
 * Markdown report and — when `--triage` made one — triage.md to $GITHUB_STEP_SUMMARY (stdout without it).
 *
 * The report already ends with the "Triage" section when a model answered (appendTriageToReports); triage.md holds the
 * same text and, with no model, the grouping alone — so the report is cut at that section and triage.md is added once.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The summary text for a reports folder ('' when it holds neither file). */
export function jobSummary(dir) {
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trimEnd() : '');
  let report = read('report.md');
  const at = report.search(/^## Triage( \(AI\))?\s*$/m);
  if (at >= 0) report = report.slice(0, at).trimEnd();
  const triage = read('triage.md');
  return [report, triage].filter(Boolean).join('\n\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = jobSummary(process.argv[2] ?? 'test-results');
  if (text) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    else process.stdout.write(`${text}\n`);
  }
}
