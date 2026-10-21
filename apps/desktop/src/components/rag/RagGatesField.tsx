import { useEffect, useState } from 'react';
import { gatesText, parseGatesText } from '../../lib/gates-text';
import { Input } from '../ui';

/**
 * The gates of a RAG evaluation: the lowest mean each metric may have in a run. They are saved with the evaluation;
 * `testpion rag run`, a monitor of the evaluation and the CI step fail a run under one (a `--min` flag or the monitor's own
 * gate for the same metric wins). The same words as the monitor's field and as `--min`. Folded like the judge options beside
 * it, so the form keeps its height for the metric picker below.
 */
export function RagGatesField({ gates, onChange }: { gates?: Record<string, number>; onChange(gates: Record<string, number> | undefined): void }) {
  const [text, setText] = useState(gatesText(gates));
  // a different evaluation, or the gates changed elsewhere (an authored one): show them
  useEffect(() => setText((t) => (JSON.stringify(parseGatesText(t) ?? null) === JSON.stringify(gates ?? {}) ? t : gatesText(gates))), [gates]);
  const parsed = parseGatesText(text);
  const set = Object.keys(gates ?? {}).length;
  return (
    <details className="text-xs rounded-lg border border-line px-2 py-1" data-rag-gates-details open={set > 0 || undefined}>
      <summary className="cursor-pointer text-muted select-none">Gates{set ? ` · ${set} set` : ''}</summary>
      <div className="grid gap-1 mt-2 pb-1">
        <Input
          className="h-7 min-h-7 text-xs"
          value={text}
          placeholder="faithfulness=0.8, recall@5=0.9"
          aria-label="Gates"
          aria-invalid={parsed === undefined}
          data-rag-gates
          onChange={(e) => {
            setText(e.target.value);
            const p = parseGatesText(e.target.value);
            if (p) onChange(Object.keys(p).length ? p : undefined);
          }}
        />
        <div className="text-muted">A run fails when the mean of a metric is under its minimum. The command line, a monitor of this evaluation and CI use them.</div>
        {parsed === undefined && <div className="text-bad">Write each gate as metric=minimum, separated by commas.</div>}
      </div>
    </details>
  );
}
