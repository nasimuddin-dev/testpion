import { plural } from '../../lib/format';
import { useState } from 'react';
import type { MetricCalibration } from '@testpion/core';
import { call } from '../../api';
import { useApp, attempt } from '../../store';
import { Badge, Button, Callout } from '../ui';

/**
 * How well an AI reviewer agrees with a person, for one check (AU-23): Cohen's kappa, accuracy, the counts of too lenient and
 * too strict, the numbers per reviewer model, the pass mark that would agree most and the answers where they disagree. ONE card for
 * both places that show it: the calibration report of a bot with sources' run, and "Trust the AI reviewer" in the Checks tab of a
 * prompt evaluation. (Moved out of RagCalibration.)
 */
const num = (x: number | undefined) => (x === undefined ? '—' : String(x));
const TONE = { good: 'ok', fair: 'warn', poor: 'bad', unknown: 'default' } as const;

function Confusion({ m }: { m: MetricCalibration }) {
  const c = m.agreement.confusion;
  const cell = 'px-3 py-1 text-right tabular-nums border border-line/60';
  return (
    <table className="text-xs border-collapse" data-rag-confusion={m.metric}>
      <thead>
        <tr>
          <th className="px-2 py-1 text-left font-normal text-muted">AI reviewer ↓ · You →</th>
          <th className="px-2 py-1 font-normal text-muted">Pass</th>
          <th className="px-2 py-1 font-normal text-muted">Fail</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th className="px-2 py-1 text-left font-normal text-muted">Pass</th>
          <td className={cell}>{c.tp}</td>
          <td className={cell} title="The AI reviewer passed what you failed (too lenient)">
            {c.fp}
          </td>
        </tr>
        <tr>
          <th className="px-2 py-1 text-left font-normal text-muted">Fail</th>
          <td className={cell} title="The AI reviewer failed what you passed (too strict)">
            {c.fn}
          </td>
          <td className={cell}>{c.tn}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function AgreementCard({ m, evaluation, run, onUse, onOpen, onApplied }: { m: MetricCalibration; evaluation?: string; run: string; onUse?(metric: string, t: number): void; onOpen?(resultId: string, metric: string): void; onApplied(): void }) {
  const a = m.agreement;
  const tuned = m.tuning;
  const custom = m.metric.startsWith('custom/');
  const [made, setMade] = useState<string[]>([]);
  /** "Make an example of this": the sample you labelled becomes an example of the metric's file, with your verdict as what the metric must say. */
  const makeExample = async (resultId: string, expect: 'pass' | 'fail') => {
    await attempt(async () => {
      const r = await call<{ file: string; examples: number }>('rag.calibrate.example', { metric: m.metric, run, result: resultId, expect });
      setMade((x) => [...x, resultId]);
      useApp.getState().toast(`Added to ${r.file} (${plural(r.examples, 'example')})`, 'success');
    });
  };
  const canApply = !!tuned && m.metric !== 'overall' && (custom || !!evaluation);
  const apply = async () => {
    await attempt(async () => {
      const r = await call<{ changed: string; threshold: number }>('rag.calibrate.apply', {
        metric: m.metric,
        threshold: tuned!.threshold,
        evaluation,
        calibration: { run, n: a.n, kappa: tuned!.agreement.kappa, tpr: tuned!.agreement.tpr, tnr: tuned!.agreement.tnr },
      });
      useApp.getState().toast(`Pass mark ${r.threshold} saved in ${r.changed}`, 'success');
      onApplied();
    });
  };
  return (
    <section className="border border-line rounded-lg p-3 grid gap-2" data-rag-calibration-metric={m.metric}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{m.metric}</span>
        <Badge tone={TONE[m.verdict]}>{m.verdict === 'unknown' ? 'kappa not defined' : `${m.verdict} agreement`}</Badge>
        <span className="text-xs text-muted">
          {a.n} labelled · from {m.source === 'review' ? 'your Good/Bad reviews' : m.source === 'mixed' ? 'labels and reviews' : 'your labels'}
          {m.threshold !== undefined ? ` · pass mark ${m.direction === 'lower' ? '≤' : '≥'} ${m.threshold}` : ''}
        </span>
      </div>
      <div className="flex gap-6 flex-wrap items-start">
        <table className="text-xs" data-rag-calibration-numbers>
          <tbody>
            {(
              [
                ['Cohen’s kappa', num(a.kappa), m.interval.kappa ? `95% ${m.interval.kappa.join(' to ')}` : (a.kappaNote ?? '')],
                ['Accuracy', num(a.accuracy), m.interval.accuracy ? `95% ${m.interval.accuracy.join(' to ')}` : ''],
                ['TPR (you passed, judge passed)', num(a.tpr), ''],
                ['TNR (you failed, judge failed)', num(a.tnr), ''],
                ['Precision', num(a.precision), ''],
              ] as const
            ).map(([k, v, note]) => (
              <tr key={k}>
                <th className="text-left font-normal text-muted pr-3 py-0.5">{k}</th>
                <td className="tabular-nums pr-3">{v}</td>
                <td className="text-muted">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Confusion m={m} />
      </div>
      <div className="text-sm">{m.advice}</div>
      {m.byJudge.length > 1 && (
        <table className="text-xs" data-rag-calibration-judges>
          <thead>
            <tr className="text-muted">
              <th className="text-left font-normal pr-3">AI reviewer model</th>
              <th className="text-right font-normal pr-3">n</th>
              <th className="text-right font-normal pr-3">kappa</th>
              <th className="text-right font-normal pr-3">accuracy</th>
              <th className="text-right font-normal pr-3">TPR</th>
              <th className="text-right font-normal">TNR</th>
            </tr>
          </thead>
          <tbody>
            {m.byJudge.map((j) => (
              <tr key={`${j.role}-${j.judge}`} data-rag-judge-role={j.role}>
                <td className="pr-3 mono">
                  {j.judge}
                  {j.role === 'member' && <span className="text-muted"> · jury member</span>}
                  {j.role === 'jury' && <span className="text-muted"> · together</span>}
                </td>
                <td className="text-right tabular-nums pr-3">{j.agreement.n}</td>
                <td className="text-right tabular-nums pr-3">{num(j.agreement.kappa)}</td>
                <td className="text-right tabular-nums pr-3">{num(j.agreement.accuracy)}</td>
                <td className="text-right tabular-nums pr-3">{num(j.agreement.tpr)}</td>
                <td className="text-right tabular-nums">{num(j.agreement.tnr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tuned && (
        <Callout tone={tuned.warning ? 'warn' : 'accent'} data-rag-tuned={m.metric}>
          Best pass mark for your labels: <b>{tuned.threshold}</b> (kappa {num(tuned.agreement.kappa)}
          {tuned.gain !== undefined ? `, ${tuned.gain >= 0 ? '+' : ''}${tuned.gain} against ${tuned.current?.threshold}` : ''}). {tuned.warning}
          <span className="inline-flex gap-2 ml-2">
            {onUse && (
              <Button size="sm" onClick={() => onUse(m.metric, tuned.threshold)} data-rag-use-threshold={m.metric}>
                Try it in the matrix
              </Button>
            )}
            {canApply && (
              <Button size="sm" variant="primary" onClick={() => void apply()} title={custom ? 'Writes threshold: and calibration: into the metric file' : `Sets the evaluator’s pass mark in the saved evaluation “${evaluation}”`} data-rag-apply-threshold={m.metric}>
                {custom ? 'Save in the metric file' : 'Save in the evaluation'}
              </Button>
            )}
          </span>
        </Callout>
      )}
      {m.disagreements.length > 0 && (
        <details open data-rag-disagreements={m.metric}>
          <summary className="text-xs text-muted cursor-pointer">Where the AI reviewer and you disagree ({m.disagreements.length})</summary>
          <ul className="mt-1 grid gap-1">
            {m.disagreements.map((d) => (
              <li key={`${d.resultId}`} className="text-xs border border-line/60 rounded px-2 py-1">
                <div className="flex items-center gap-2">
                  <Badge tone={d.judge === 'pass' ? 'ok' : 'bad'}>AI reviewer {d.judge}</Badge>
                  <Badge tone={d.human === 'pass' ? 'ok' : 'bad'}>you {d.human}</Badge>
                  {d.score !== undefined && <span className="text-muted">score {d.score}</span>}
                  {custom && (
                    <Button size="sm" className="ml-auto" disabled={made.includes(d.resultId)} reason="Added as an example already" onClick={() => void makeExample(d.resultId, d.human)} title={`Adds this sample to the examples of the metric file, so the metric must say “${d.human}” for it from now on`} data-rag-make-example={d.resultId}>
                      {made.includes(d.resultId) ? 'Example added' : 'Make an example of this'}
                    </Button>
                  )}
                  {onOpen && (
                    <button className={custom ? 'text-accent hover:underline' : 'ml-auto text-accent hover:underline'} onClick={() => onOpen(d.resultId, m.metric)}>
                      Open the sample
                    </button>
                  )}
                </div>
                {d.question && <div className="mt-0.5">Q: {d.question}</div>}
                {d.conversation && (
                  <div className="text-muted" data-rag-disagreement-conversation>
                    {d.conversation.slice(-4).map((t, i) => (
                      <div key={i} className="truncate" title={t.content}>
                        {t.role}: {t.content}
                      </div>
                    ))}
                  </div>
                )}
                {d.jury && (
                  <div className="text-muted" data-rag-disagreement-jury>
                    Jury: {d.jury.map((j) => `${j.judge} ${j.pass ? 'pass' : 'fail'}`).join(', ')}
                  </div>
                )}
                {!d.conversation && d.answer && <div className="text-muted truncate" title={d.answer}>A: {d.answer}</div>}
                {d.reason && <div className="text-muted">{d.reason}</div>}
                {d.note && <div>Your note: {d.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

