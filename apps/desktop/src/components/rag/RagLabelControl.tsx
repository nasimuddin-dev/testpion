import { Check, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { RagLabel } from '@testpion/core';
import { call } from '../../api';
import { attempt } from '../../store';
import { cx } from '../ui';

/**
 * "Your label" for one metric of one sample: Pass or Fail, the person's own verdict that the judge is calibrated against
 * (Calibrate judge in the matrix). Pressing the active one again removes the label. The label belongs to the dataset record,
 * so it also counts for later runs of the same dataset while the system gives the same answer.
 */
export function RagLabelControl({ runId, resultId, metric, onChanged }: { runId: string; resultId: string; metric: string; onChanged?(): void }) {
  const [mine, setMine] = useState<RagLabel['label']>();
  const load = useCallback(() => {
    void call<{ items: RagLabel[] }>('rag.label.list', { run: runId, result: resultId }).then(
      (r) => setMine(r.items.find((l) => l.metric === metric)?.label),
      () => setMine(undefined),
    );
  }, [runId, resultId, metric]);
  useEffect(load, [load]);
  const set = async (label: 'pass' | 'fail') => {
    await attempt(async () => {
      if (mine === label) await call('rag.label.clear', { run: runId, result: resultId, metric });
      else await call('rag.label.set', { run: runId, result: resultId, metric, label });
      setMine(mine === label ? undefined : label);
      onChanged?.();
    });
  };
  const btn = (label: 'pass' | 'fail') => (
    <button
      type="button"
      aria-pressed={mine === label}
      className={cx('inline-flex items-center gap-0.5 px-1.5 h-5 rounded border text-xs', mine === label ? (label === 'pass' ? 'bg-ok/20 border-ok text-ok' : 'bg-bad/20 border-bad text-bad') : 'border-line text-muted hover:bg-hover')}
      title={mine === label ? 'Remove your label' : `Your verdict: this answer ${label === 'pass' ? 'is good' : 'is bad'} on ${metric}`}
      onClick={() => void set(label)}
      data-rag-label={`${metric}|${label}`}
    >
      {label === 'pass' ? <Check size={11} /> : <X size={11} />} {label === 'pass' ? 'Pass' : 'Fail'}
    </button>
  );
  return (
    <span className="inline-flex items-center gap-1" data-rag-label-control={metric}>
      <span className="text-xs text-muted">Your label</span>
      {btn('pass')}
      {btn('fail')}
    </span>
  );
}
