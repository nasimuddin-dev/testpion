import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { TryCheckResult } from '@testpion/core';
import { formatCost, plural } from '../../lib/format';
import type { CheckConfig } from '../../types';
import { CHECK_DEFS } from '../../lib/check-defs';
import { Badge, Button, Input, Spinner } from '../ui';

interface Pick {
  id: string;
  /** The check this row adds. */
  make(): CheckConfig;
  title: string;
  /** The one field the row asks for once it is ticked. */
  field?: { key: 'path' | 'expected' | 'criteria'; label: string; placeholder: string };
}

/**
 * The common ways to say "this answer is good", in plain words, each with the sentence that says what it decides (the same
 * sentence as beside every check, lib/check-defs.ts). Ticking a row adds that check; the rest of the 45 are under More checks.
 */
const PICKS: Pick[] = [
  { id: 'exact-match', title: 'Matches the expected answer exactly', make: () => ({ type: 'exact-match', expected: '{{expected}}' }), field: { key: 'path', label: 'Where in the reply (optional)', placeholder: '$.intent for JSON, empty for the whole reply' } },
  { id: 'contains', title: 'Contains a word or phrase', make: () => ({ type: 'contains', expected: '{{expected}}', ignoreCase: true }), field: { key: 'expected', label: 'The text it must include', placeholder: '{{expected}} is the expected answer of each case' } },
  { id: 'regex', title: 'Matches a pattern', make: () => ({ type: 'regex', expected: '^\\w+' }), field: { key: 'expected', label: 'The pattern (regular expression)', placeholder: '^(cancellation|refill)$' } },
  { id: 'is-json', title: 'Is valid JSON', make: () => ({ type: 'is-json' }) },
  { id: 'similarity', title: 'Similar meaning to the expected answer', make: () => ({ type: 'similarity', expected: '{{expected}}', threshold: 0.8, method: 'lexical' }) },
  { id: 'llm-judge', title: 'Graded by an AI reviewer', make: () => ({ type: 'llm-judge', criteria: 'The reply is polite and does not promise a refund.', threshold: 0.7 }), field: { key: 'criteria', label: 'The grading rule, in a sentence', placeholder: 'The reply is polite and does not promise a refund.' } },
];
const sentence = (type: string) => CHECK_DEFS.find((d) => d.type === type)?.what ?? '';

type Tried = { check: CheckConfig; case: number; running?: boolean; ask?: TryCheckResult; result?: TryCheckResult; error?: string };

/**
 * "What is a good answer?" (AU-11): tick what applies, and for each tick press Try to see it on one case: the reply, passed
 * or failed, and why. A check of fixed rules costs nothing on the offline demo model; a call to a paid model, and any AI
 * reviewer, show their cost first and send only when you say so.
 */
export function GoodAnswerPicker({
  evaluators,
  onChange,
  cases,
  onTry,
}: {
  evaluators: CheckConfig[];
  onChange(next: CheckConfig[]): void;
  /** How many test cases the evaluation has. */
  cases: number;
  /** Try one check on one case: `dryRun` only says what it would cost. */
  onTry(check: CheckConfig, caseNumber: number, dryRun: boolean): Promise<TryCheckResult>;
}) {
  const [tried, setTried] = useState<Record<string, Tried>>({});
  const [caseNo, setCaseNo] = useState(1);
  const indexOf = (p: Pick) => evaluators.findIndex((e) => e.type === p.id);
  const toggle = (p: Pick, on: boolean) => {
    const i = indexOf(p);
    if (on && i < 0) onChange([...evaluators, p.make()]);
    if (!on && i >= 0) onChange(evaluators.filter((_e, j) => j !== i));
  };
  const setField = (i: number, key: string, v: string) => onChange(evaluators.map((e, j) => (j === i ? { ...e, [key]: v } : e)));
  const update = (id: string, t: Partial<Tried>) => setTried((m) => ({ ...m, [id]: { ...m[id]!, ...t } }));

  const run = async (p: Pick, check: CheckConfig, confirmed: boolean) => {
    const base: Tried = { check, case: caseNo, running: true };
    setTried((m) => ({ ...m, [p.id]: base }));
    try {
      if (!confirmed) {
        const plan = await onTry(check, caseNo, true);
        // a free check (fixed rules on a model on this computer) runs at once; anything that spends asks first
        if (!plan.estimate.free) return update(p.id, { running: false, ask: plan });
      }
      update(p.id, { running: false, ask: undefined, result: await onTry(check, caseNo, false) });
    } catch (e) {
      update(p.id, { running: false, error: (e as { message?: string }).message ?? String(e) });
    }
  };

  return (
    <div className="px-3 pt-3 pb-1 flex flex-col gap-1.5" data-good-answer>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">What is a good answer?</span>
        <span className="text-xs text-muted">Tick what applies. Press Try to see a check on one case.</span>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted">
          Try on case
          <Input type="number" min={1} max={Math.max(1, cases)} className="h-6 min-h-6 w-16 text-xs" value={caseNo} onChange={(e) => setCaseNo(Math.max(1, Math.min(Math.max(1, cases), Number(e.target.value) || 1)))} aria-label="Case to try" />
        </label>
      </div>
      {PICKS.map((p) => {
        const i = indexOf(p);
        const on = i >= 0;
        const check = on ? evaluators[i]! : p.make();
        const t = tried[p.id];
        return (
          <div key={p.id} className="rounded-lg border border-line px-2.5 py-1.5" data-pick={p.id} data-picked={on ? 'true' : 'false'}>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={on} onChange={(e) => toggle(p, e.target.checked)} aria-label={p.title} />
                {p.title}
              </label>
              {p.id === 'llm-judge' && <Badge tone="judge">AI reviewer</Badge>}
              {on && (
                <Button
                  size="sm"
                  className="ml-auto"
                  icon={t?.running ? <Spinner size={12} /> : <FlaskConical size={12} />}
                  onClick={() => void run(p, check, false)}
                  disabled={cases === 0 || t?.running}
                  reason={cases === 0 ? 'There are no test cases to try it on: add one first' : 'Trying it'}
                  data-pick-try
                >
                  Try on case {caseNo}
                </Button>
              )}
            </div>
            <div className="text-xs text-muted pl-6" data-pick-what>
              {sentence(p.id)}
            </div>
            {on && p.field && (
              <div className="pl-6 mt-1">
                <Input
                  className="h-7 min-h-7 mono text-xs"
                  value={String(check[p.field.key] ?? '')}
                  placeholder={p.field.placeholder}
                  onChange={(e) => setField(i, p.field!.key, e.target.value)}
                  aria-label={p.field.label}
                />
              </div>
            )}
            {t?.ask && (
              <div className="pl-6 mt-1 flex flex-wrap items-center gap-2 text-xs" data-pick-ask>
                <span>
                  This sends case {t.ask.caseNumber} to the model{t.ask.estimate.costUsd !== undefined ? `: about ${formatCost(t.ask.estimate.costUsd)}` : ', and the model has no price, so the cost is not known'} ({plural(t.ask.estimate.calls, 'call')}).
                </span>
                <Button size="sm" variant="primary" onClick={() => void run(p, t.check, true)} data-pick-send>
                  Send
                </Button>
                <Button size="sm" onClick={() => update(p.id, { ask: undefined })}>
                  Cancel
                </Button>
              </div>
            )}
            {t?.error && <div className="pl-6 mt-1 text-xs text-bad">{t.error}</div>}
            {t?.result && (
              <div className="pl-6 mt-1 text-xs flex flex-col gap-0.5" data-pick-result={t.result.error ? 'error' : t.result.passed ? 'passed' : 'failed'}>
                {!t.result.error && (
                  <div>
                    <span className="text-muted">Case {t.result.caseNumber} reply: </span>
                    <code className="mono break-all">{t.result.reply || '(empty)'}</code>
                  </div>
                )}
                <div className={t.result.error ? 'text-bad' : t.result.passed ? 'text-ok' : 'text-bad'}>
                  {t.result.error ? `Error: ${t.result.error}` : `${t.result.passed ? 'Passed' : 'Failed'}${t.result.reason ? `: ${t.result.reason}` : ''}`}
                  {t.result.costUsd ? <span className="text-muted"> · cost {formatCost(t.result.costUsd)}</span> : null}
                  {t.result.estimate.free && t.result.estimate.offline ? <span className="text-muted"> · offline demo model, free</span> : null}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
