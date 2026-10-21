import { useEffect, useState } from 'react';
import type { RunEstimate, SavedEvaluation } from '@testpion/core';
import { call } from '../../api';
import { Field, Input, Select, Toggle } from '../ui';
import { RagEstimateView } from './RagEstimate';

/** The part of a monitor definition these fields edit (MonitorsView owns the rest). */
export interface RagMonitorFieldsValue {
  limit?: number;
  rotate?: boolean;
  maxCostUsd?: number;
  baseline?: string;
  maxDrop?: number;
}

/**
 * The nightly-run fields of a monitor that runs a RAG evaluation: a rotating sample (so a month covers the dataset), the cost
 * limit of one run, the regression gate against an earlier run, and what one run is expected to cost (the engine's estimate,
 * the same component the evaluation's Run dialog uses). Nothing is sent to anyone to show the estimate.
 */
export function RagMonitorFields({ value, onChange, evaluation }: { value: RagMonitorFieldsValue; onChange(v: RagMonitorFieldsValue): void; evaluation?: { type?: string } }) {
  const [estimate, setEstimate] = useState<RunEstimate>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!evaluation) return setEstimate(undefined);
    let live = true;
    // a rotating night scores `limit` records, so the estimate is for that many
    call<{ estimate: RunEstimate }>('rag.estimate', { draft: { ...(evaluation as SavedEvaluation), limit: value.limit } }).then(
      (r) => live && (setEstimate(r.estimate), setFailed(undefined)),
      (e) => live && (setEstimate(undefined), setFailed(e instanceof Error ? e.message : String(e))),
    );
    return () => {
      live = false;
    };
  }, [evaluation, value.limit]);
  const mode = value.baseline === undefined ? 'none' : value.baseline === 'previous' || value.baseline === 'best' ? value.baseline : 'run';
  return (
    <div className="flex flex-col gap-3" data-rag-monitor-fields>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sample" hint="A rotating sample scores a different set of the questions each night (by the date), so a month covers the dataset. Needs the number of questions.">
          <Toggle checked={!!value.rotate} onChange={(v) => onChange({ ...value, rotate: v || undefined })} label="Rotate the sample nightly" />
        </Field>
        <Field label="Cost limit / run" hint="USD: one run stops judging at this much; the rest is n/a, not a failed gate.">
          <Input type="number" min={0} step={0.25} placeholder="no cap" value={value.maxCostUsd ?? ''} onChange={(e) => onChange({ ...value, maxCostUsd: e.target.value ? Math.max(0, Number(e.target.value)) : undefined })} aria-label="Cost limit of one run in USD" data-rag-monitor-maxcost />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Regression gate" hint="Fail when a metric dropped against an earlier run (a paired comparison: one unlucky question does not fail it).">
          <Select
            value={mode}
            onChange={(e) => onChange({ ...value, baseline: e.target.value === 'none' ? undefined : e.target.value === 'run' ? '' : e.target.value, maxDrop: e.target.value === 'none' ? undefined : value.maxDrop })}
            aria-label="Baseline of the regression gate"
            data-rag-monitor-baseline
          >
            <option value="none">No regression gate</option>
            <option value="previous">Against the previous run</option>
            <option value="best">Against the best of the last 30</option>
            <option value="run">Against a run (its id) …</option>
          </Select>
        </Field>
        <Field label="Largest drop allowed" hint="Points of a 0 to 1 score. The default is 0.05.">
          <Input type="number" min={0.01} max={1} step={0.01} placeholder="0.05" disabled={mode === 'none'} value={value.maxDrop ?? ''} onChange={(e) => onChange({ ...value, maxDrop: e.target.value ? Math.min(1, Math.max(0.01, Number(e.target.value))) : undefined })} aria-label="Largest drop allowed" data-rag-monitor-maxdrop />
        </Field>
      </div>
      {mode === 'run' && (
        <Field label="Baseline run">
          <Input value={value.baseline ?? ''} placeholder="run-…" onChange={(e) => onChange({ ...value, baseline: e.target.value.trim() })} aria-label="Baseline run id" />
        </Field>
      )}
      <div className="text-xs text-muted" data-rag-monitor-estimate>
        {estimate ? (
          <>
            One run: <RagEstimateView estimate={estimate} compact />
          </>
        ) : failed ? (
          <span>No estimate yet: {failed}</span>
        ) : evaluation ? (
          'Estimating one run …'
        ) : (
          'Pick an evaluation to see what one run costs.'
        )}
      </div>
    </div>
  );
}
