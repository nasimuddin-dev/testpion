import { useEffect, useState } from 'react';
import type { CalibrationReport, MetricCalibration } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { Badge, Button, Callout, Modal, Spinner } from '../ui';

const num = (x: number | undefined) => (x === undefined ? '—' : String(x));
const TONE = { good: 'ok', fair: 'warn', poor: 'bad', unknown: 'default' } as const;

function Confusion({ m }: { m: MetricCalibration }) {
  const c = m.agreement.confusion;
  const cell = 'px-3 py-1 text-right tabular-nums border border-line/60';
  return (
    <table className="text-xs border-collapse" data-rag-confusion={m.metric}>
      <thead>
        <tr>
          <th className="px-2 py-1 text-left font-normal text-muted">Judge ↓ · You →</th>
          <th className="px-2 py-1 font-normal text-muted">Pass</th>
          <th className="px-2 py-1 font-normal text-muted">Fail</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th className="px-2 py-1 text-left font-normal text-muted">Pass</th>
          <td className={cell}>{c.tp}</td>
          <td className={cell} title="The judge passed what you failed (too lenient)">
            {c.fp}
          </td>
        </tr>
        <tr>
          <th className="px-2 py-1 text-left font-normal text-muted">Fail</th>
          <td className={cell} title="The judge failed what you passed (too strict)">
            {c.fn}
          </td>
          <td className={cell}>{c.tn}</td>
        </tr>
      </tbody>
    </table>
  );
}

function MetricCard({ m, evaluation, run, onUse, onOpen, onApplied }: { m: MetricCalibration; evaluation?: string; run: string; onUse?(metric: string, t: number): void; onOpen?(resultId: string, metric: string): void; onApplied(): void }) {
  const a = m.agreement;
  const tuned = m.tuning;
  const custom = m.metric.startsWith('custom/');
  const canApply = !!tuned && m.metric !== 'overall' && (custom || !!evaluation);
  const apply = async () => {
    try {
      const r = await call<{ changed: string; threshold: number }>('rag.calibrate.apply', {
        metric: m.metric,
        threshold: tuned!.threshold,
        evaluation,
        calibration: { run, n: a.n, kappa: tuned!.agreement.kappa, tpr: tuned!.agreement.tpr, tnr: tuned!.agreement.tnr },
      });
      useApp.getState().toast(`Pass mark ${r.threshold} saved in ${r.changed}`, 'success');
      onApplied();
    } catch (e) {
      toastError(e);
    }
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
              <th className="text-left font-normal pr-3">Judge model</th>
              <th className="text-right font-normal pr-3">n</th>
              <th className="text-right font-normal pr-3">kappa</th>
              <th className="text-right font-normal">accuracy</th>
            </tr>
          </thead>
          <tbody>
            {m.byJudge.map((j) => (
              <tr key={j.judge}>
                <td className="pr-3 mono">{j.judge}</td>
                <td className="text-right tabular-nums pr-3">{j.agreement.n}</td>
                <td className="text-right tabular-nums pr-3">{num(j.agreement.kappa)}</td>
                <td className="text-right tabular-nums">{num(j.agreement.accuracy)}</td>
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
          <summary className="text-xs text-muted cursor-pointer">Where the judge and you disagree ({m.disagreements.length})</summary>
          <ul className="mt-1 grid gap-1">
            {m.disagreements.map((d) => (
              <li key={`${d.resultId}`} className="text-xs border border-line/60 rounded px-2 py-1">
                <div className="flex items-center gap-2">
                  <Badge tone={d.judge === 'pass' ? 'ok' : 'bad'}>judge {d.judge}</Badge>
                  <Badge tone={d.human === 'pass' ? 'ok' : 'bad'}>you {d.human}</Badge>
                  {d.score !== undefined && <span className="text-muted">score {d.score}</span>}
                  {onOpen && (
                    <button className="ml-auto text-accent hover:underline" onClick={() => onOpen(d.resultId, m.metric)}>
                      Open the sample
                    </button>
                  )}
                </div>
                {d.question && <div className="mt-0.5">Q: {d.question}</div>}
                {d.answer && <div className="text-muted truncate" title={d.answer}>A: {d.answer}</div>}
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

/**
 * Calibrate judge: how well the judge of each metric agrees with the Pass / Fail labels you gave in the sample detail
 * (and with your Good / Bad reviews of whole results). Cohen's kappa rather than raw agreement, a bootstrap interval,
 * the confusion matrix, the numbers per judge model, the samples where you disagree, and the pass mark that would agree
 * most. Statistics over what the run stored: no model is called.
 */
export function RagCalibration({ runId, evaluation, onUseThreshold, onOpenSample, onClose }: { runId: string; evaluation?: string; onUseThreshold?(metric: string, t: number): void; onOpenSample?(resultId: string, metric: string): void; onClose(): void }) {
  const [report, setReport] = useState<CalibrationReport>();
  const [error, setError] = useState<string>();
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    setReport(undefined);
    void call<CalibrationReport>('rag.calibrate', { run: runId, tune: true }).then(
      (r) => live && setReport(r),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [runId, rev]);
  return (
    <Modal title="Calibrate judge" onClose={onClose} width={880} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-3 text-sm" data-rag-calibration>
        {error && <Callout tone="bad">{error}</Callout>}
        {!report && !error && <Spinner />}
        {report && (
          <>
            <div className="text-xs text-muted">
              {report.labelled} labelled sample{report.labelled === 1 ? '' : 's'} of {report.results} in this run · labels in labels/{report.labels}.json
              {report.stale ? ` · ${report.stale} left out because the system answered differently since` : ''}
              {report.missing ? ` · ${report.missing} labels are about records this run does not have` : ''}
            </div>
            {!report.metrics.length && <Callout tone="accent">Nothing to compare yet. Open a sample (click a cell of the matrix) and press Pass or Fail under “Your label” on a metric: 30 or more labels, passes and fails both, make the numbers worth trusting.</Callout>}
            {report.metrics.map((m) => (
              <MetricCard key={m.metric} m={m} evaluation={evaluation} run={runId} onUse={onUseThreshold} onOpen={onOpenSample} onApplied={() => setRev((x) => x + 1)} />
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
