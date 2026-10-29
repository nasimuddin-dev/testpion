import { Check, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TrustCase, TrustState } from '@testpion/core';
import { call } from '../../api';
import { toastError } from '../../store';
import { Badge, Button, Callout, Select, Spinner } from '../ui';
import { AgreementCard } from './AgreementCard';

/** One answer to grade: what was asked, what the model answered, and your pass or fail. The AI reviewer's verdict is not shown. */
function TrustRow({ n, c, busy, onGrade }: { n: number; c: TrustCase; busy: boolean; onGrade(v: 'pass' | 'fail' | null): void }) {
  const set = (v: 'pass' | 'fail') => onGrade(c.yours === v ? null : v);
  return (
    <li className="rounded-lg border border-line px-2.5 py-2 flex flex-col gap-1" data-trust-case={c.resultId} data-trust-yours={c.yours ?? 'none'}>
      <div className="flex items-start gap-2">
        <span className="text-xs text-muted w-5 shrink-0 pt-0.5">{n}.</span>
        <div className="min-w-0 flex-1 text-sm">
          {c.input && (
            <div className="truncate" title={c.input}>
              <span className="text-muted">Asked: </span>
              {c.input}
            </div>
          )}
          <div className="break-words" title={c.reply}>
            <span className="text-muted">Answered: </span>
            <code className="mono">{c.reply || '(empty)'}</code>
          </div>
          {c.rule && (
            <div className="text-xs text-muted">
              The rule: {c.rule}
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant={c.yours === 'pass' ? 'primary' : 'default'} icon={<Check size={12} />} disabled={busy} reason="Saving your verdict" onClick={() => set('pass')} aria-pressed={c.yours === 'pass'} data-trust-pass>
            Good
          </Button>
          <Button size="sm" variant={c.yours === 'fail' ? 'primary' : 'default'} icon={<X size={12} />} disabled={busy} reason="Saving your verdict" onClick={() => set('fail')} aria-pressed={c.yours === 'fail'} data-trust-fail>
            Bad
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * "Trust the AI reviewer" (AU-23): ten answers of the last run, each good or bad by YOU; the AI reviewer's verdict stays hidden
 * until you have graded them all, then the card says how often it agreed (a sentence, the counts, Cohen's kappa, the answers where
 * you disagree). Shown only when the evaluation has a check that an AI reviewer grades. The grading is the engine's
 * (`eval.trust`, `testpion eval trust`, the `eval_trust_reviewer` tool); your verdicts are the labels `rag label` keeps.
 */
export function TrustReviewer({ runId, evaluation }: { /** The run to take answers from: the one open in the results. */ runId?: string; evaluation?: string }) {
  const [s, setS] = useState<TrustState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [metric, setMetric] = useState<string>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!runId || !open) return;
    let live = true;
    setError(undefined);
    call<TrustState>('eval.trust', { run: runId, ...(metric ? { metric } : {}) }).then(
      (r) => live && setS(r),
      (e) => live && setError((e as { message?: string }).message ?? String(e)),
    );
    return () => {
      live = false;
    };
  }, [runId, open, metric]);
  const grade = async (c: TrustCase, verdict: 'pass' | 'fail' | null) => {
    if (!runId) return;
    setBusy(true);
    try {
      setS(await call<TrustState>('eval.trust', { run: runId, metric: s?.metric, label: { result: c.resultId, verdict } }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="mx-3 mb-3 rounded-lg border border-line px-3 py-2 text-sm" data-trust-reviewer onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer select-none flex items-center gap-2">
        <ShieldCheck size={14} className="text-muted" />
        <span className="font-medium">Trust the AI reviewer</span>
        <span className="text-xs text-muted">Grade 10 answers yourself and see how often the AI reviewer agrees.</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {!runId && (
          <div className="flex items-center gap-2" data-trust-norun>
            <Button size="sm" disabled reason="Run this evaluation first: the answers you grade come from a run">
              Grade 10 answers
            </Button>
            <span className="text-xs text-muted">Run the evaluation once, then come back.</span>
          </div>
        )}
        {runId && !s && !error && <Spinner />}
        {error && <Callout tone="bad">{error}</Callout>}
        {s && !s.metrics.length && <Callout tone="accent">{s.summary}</Callout>}
        {s && s.metrics.length > 0 && (
          <>
            {s.metrics.length > 1 && (
              <Select value={s.metric} onChange={(e) => setMetric(e.target.value)} aria-label="AI reviewer check" className="w-56">
                {s.metrics.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            )}
            <div className="flex items-center gap-2 flex-wrap" data-trust-summary data-trust-done={s.done ? 'true' : 'false'}>
              <Badge tone={s.done ? 'ok' : 'default'}>
                {s.graded} of {Math.min(s.target, s.cases.length)} graded
              </Badge>
              <span data-trust-sentence>{s.summary}</span>
            </div>
            {s.done && s.report && <AgreementCard m={s.report} evaluation={evaluation} run={s.run} onApplied={() => setMetric((m) => m)} />}
            <ul className="flex flex-col gap-1.5" data-trust-cases>
              {s.cases.map((c, i) => (
                <TrustRow key={c.resultId} n={i + 1} c={c} busy={busy} onGrade={(v) => void grade(c, v)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}
