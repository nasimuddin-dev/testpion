/**
 * The calibration report as a file a person can keep, attach to a pull request or hand to a reviewer (the output surface
 * `rag.calibration`): Markdown, with the numbers of each metric, the numbers of each judge (and of each member of a jury),
 * the confusion table, the pass mark that would agree most and where the judge and the person disagree. The same data as the
 * JSON of the report; nothing is computed here.
 */
import type { CalibrationReport, MetricCalibration } from './report.js';

const n = (x: number | undefined) => (x === undefined ? '—' : String(x));
const cell = (s: string | undefined, max = 160) => (s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, max);

function metricSection(m: MetricCalibration): string[] {
  const a = m.agreement;
  const c = a.confusion;
  const out = [`## ${m.metric}`, '', `**${m.verdict === 'unknown' ? 'Kappa is not defined' : `${m.verdict} agreement`}** · ${a.n} labelled · from ${m.source === 'review' ? 'good/bad reviews' : m.source === 'mixed' ? 'labels and reviews' : 'labels'}${m.group ? ` · ${m.group}` : ''}${m.threshold !== undefined ? ` · pass mark ${m.direction === 'lower' ? '≤' : '≥'} ${m.threshold}` : ''}`, ''];
  out.push('| Measure | Value | 95% interval |', '| --- | --- | --- |');
  out.push(`| Cohen’s kappa | ${n(a.kappa)} | ${m.interval.kappa ? m.interval.kappa.join(' to ') : cell(a.kappaNote)} |`);
  out.push(`| Accuracy | ${n(a.accuracy)} | ${m.interval.accuracy ? m.interval.accuracy.join(' to ') : ''} |`);
  out.push(`| TPR (you passed, the judge passed) | ${n(a.tpr)} | |`, `| TNR (you failed, the judge failed) | ${n(a.tnr)} | |`, `| Precision | ${n(a.precision)} | |`, '');
  out.push('| | You: pass | You: fail |', '| --- | --- | --- |', `| **Judge: pass** | ${c.tp} | ${c.fp} (too lenient) |`, `| **Judge: fail** | ${c.fn} (too strict) | ${c.tn} |`, '');
  out.push(m.advice, '');
  if (m.byJudge.length > 1 || m.byJudge.some((j) => j.role === 'member')) {
    out.push('| Judge | | n | kappa | accuracy | TPR | TNR |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const j of m.byJudge) out.push(`| ${cell(j.judge)} | ${j.role === 'member' ? 'jury member' : j.role === 'jury' ? 'the jury together' : ''} | ${j.agreement.n} | ${n(j.agreement.kappa)} | ${n(j.agreement.accuracy)} | ${n(j.agreement.tpr)} | ${n(j.agreement.tnr)} |`);
    out.push('');
  }
  if (m.tuning) out.push(`**Pass mark that agrees most:** ${m.tuning.threshold} (kappa ${n(m.tuning.agreement.kappa)}${m.tuning.gain !== undefined ? `, ${m.tuning.gain >= 0 ? '+' : ''}${m.tuning.gain}` : ''}).${m.tuning.warning ? ` ${m.tuning.warning}` : ''}`, '');
  if (m.disagreements.length) {
    out.push(`### Where the judge and the person disagree (${m.disagreements.length})`, '');
    for (const d of m.disagreements) {
      out.push(`- **${d.record}**: judge ${d.judge}, person ${d.human}${d.score !== undefined ? ` (score ${d.score})` : ''}`);
      if (d.question) out.push(`  - Question: ${cell(d.question, 300)}`);
      if (d.conversation?.length) out.push(`  - Conversation: ${cell(d.conversation.map((t) => `${t.role}: ${t.content}`).join(' / '), 400)}`);
      else if (d.answer) out.push(`  - Answer: ${cell(d.answer, 300)}`);
      if (d.jury?.length) out.push(`  - Jury: ${d.jury.map((j) => `${cell(j.judge, 60)} ${j.pass ? 'pass' : 'fail'}`).join(', ')}`);
      if (d.reason) out.push(`  - The judge said: ${cell(d.reason, 300)}`);
      if (d.note) out.push(`  - Note: ${cell(d.note, 300)}`);
    }
    out.push('');
  }
  return out;
}

export function calibrationMarkdown(r: CalibrationReport): string {
  const head = [`# Judge calibration${r.run ? ` · ${r.run}` : ''}`, '', `${r.labelled} labelled sample${r.labelled === 1 ? '' : 's'} of ${r.results} in the run${r.labels ? ` · labels: labels/${r.labels}.json` : ''}${r.stale ? ` · ${r.stale} left out (the system answered differently since)` : ''}${r.missing ? ` · ${r.missing} labels are about records this run does not have` : ''}.`, ''];
  if (!r.metrics.length) return [...head, 'Nothing to compare yet: label some results pass or fail first.', ''].join('\n');
  return [...head, ...r.metrics.flatMap(metricSection)].join('\n');
}
