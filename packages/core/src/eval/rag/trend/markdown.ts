/**
 * The regression table of a RAG run against a baseline, as Markdown: ONE function for the pull-request comment of `testpion rag run
 * --baseline … --markdown`, the CI snippet's comment step and the alert of a monitor, so the three say the same thing the same way.
 */
import type { MetricComparison } from '../metric-compare.js';

interface RegressionInfo {
  /** What it was compared with ("run_2026-10-19_ab12", "the previous night"). */
  baseline: string;
  /** The judge that scored this run (`provider/model`). */
  judge?: string;
  /** What the judging cost (USD). */
  costUsd?: number;
  /** The smallest drop that counts. */
  maxDrop?: number;
}

const num = (v: number | undefined) => (v === undefined ? '–' : String(v));
const signed = (v: number | undefined) => (v === undefined ? '–' : `${v > 0 ? '+' : ''}${v}`);

/** A table of every metric that moved (regressions first), or the sentence that nothing did. */
export function regressionMarkdown(c: MetricComparison, i: RegressionInfo): string {
  const moved = c.metrics.filter((m) => m.change !== 'unchanged').sort((a, b) => Number(b.change === 'regressed') - Number(a.change === 'regressed') || a.key.localeCompare(b.key));
  const head = `### Against ${i.baseline}`;
  const facts = [`${c.samples.shared} samples in both`, i.judge ? `judge ${i.judge}` : '', i.costUsd ? `judging cost $${i.costUsd.toFixed(4)}` : '', i.maxDrop !== undefined ? `a drop counts from ${i.maxDrop}` : ''].filter(Boolean).join(' · ');
  if (!moved.length) return `${head}\n\n${facts}\n\n:white_check_mark: No metric moved.\n`;
  const rows = moved.map((m) => `| ${m.change === 'regressed' ? ':x:' : m.change === 'improved' ? ':white_check_mark:' : ':grey_question:'} | ${m.key} | ${num(m.baseline)} | ${num(m.current)} | ${signed(m.delta)} | ${m.ci ? `${m.ci[0]} to ${m.ci[1]}` : '–'} |`);
  return `${head}\n\n${facts}\n\n| | Metric | Before | After | Change | 95% interval |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n${c.regressions.length ? `\n**${c.regressions.length} regression${c.regressions.length === 1 ? '' : 's'}.**\n` : ''}`;
}

/** One line per regression, for an alert: "faithfulness 0.86 to 0.78 (-0.08, interval -0.12 to -0.04)". */
export function regressionLines(c: MetricComparison): string[] {
  return c.regressions.map((m) => `${m.key} ${num(m.baseline)} to ${num(m.current)} (${signed(m.delta)}${m.ci ? `, interval ${m.ci[0]} to ${m.ci[1]}` : ''})`);
}
