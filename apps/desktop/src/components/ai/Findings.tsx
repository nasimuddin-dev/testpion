import { Lightbulb } from 'lucide-react';
import type { ProposalFinding } from '@testpion/core';
import { RefLink } from '../RefLink';
import { Badge } from '../ui';
import { plural } from '../../lib/format';

/** The kinds of contract-drift findings: they count responses, not failures. */
const DRIFT = new Set(['drift', 'spec-outdated', 'api-bug', 'test-stale', 'intended']);

/** What a finding's kind is called (a triage cause, a flaky pattern). */
const KIND: Record<string, string> = {
  'api-regression': 'API regression',
  'stale-test': 'Test is stale',
  auth: 'Auth',
  environment: 'Environment',
  'test-data': 'Test data',
  flaky: 'Flaky',
  timing: 'Timing',
  ordering: 'Ordering',
  'shared-state': 'Shared state',
  'time-dependent': 'Time-dependent',
  'external-dependency': 'External dependency',
  'rate-limit': 'Rate limit',
  'data-collision': 'Data collision',
  unknown: 'Unclear',
  'spec-outdated': 'Document outdated',
  'api-bug': 'API bug',
  intended: 'Intended',
  drift: 'Drift',
};
const TONE: Record<string, 'bad' | 'warn' | 'accent' | 'default'> = { 'api-bug': 'bad', 'spec-outdated': 'accent', drift: 'warn', 'api-regression': 'bad', auth: 'warn', environment: 'warn', 'stale-test': 'accent', flaky: 'warn', timing: 'warn' };

/**
 * What an AI analysis found (AI-2 causes of failures, AI-5 why a test is flaky): one block per finding — its kind, how
 * many results it explains, the model's confidence, the explanation and the evidence, each fact linking what it is
 * about (a result of the run, the last passing run). The proposal review shows it above the items that fix it.
 */
export function Findings({ findings, fixes }: { findings: ProposalFinding[]; fixes?: Record<string, number> }) {
  if (!findings.length) return null;
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label="Findings" data-findings>
      {findings.map((f) => (
        <li key={f.id} className="rounded-lg border border-line bg-panel/60 px-3 py-2 grid grid-cols-[minmax(0,1fr)] gap-1 min-w-0" data-finding={f.id} data-finding-kind={f.kind}>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <Lightbulb size={13} className="text-accent shrink-0" />
            <span className="font-medium min-w-0 break-words">{f.title}</span>
            <Badge tone={TONE[f.kind] ?? 'default'}>{KIND[f.kind] ?? f.kind}</Badge>
            {f.count !== undefined && <span className="text-xs text-muted">{plural(f.count, DRIFT.has(f.kind) ? 'response' : 'failure')}</span>}
            {typeof f.confidence === 'number' && (
              <span className="text-xs text-muted" title="The model's own confidence">
                {Math.round(f.confidence * 100)}% sure
              </span>
            )}
            {fixes && <span className="ml-auto text-xs text-muted">{fixes[f.id] ? `${fixes[f.id]} proposed ${fixes[f.id] === 1 ? 'change' : 'changes'}` : 'no change to the tests'}</span>}
          </div>
          {f.explanation && <p className="text-sm text-muted whitespace-pre-wrap break-words">{f.explanation}</p>}
          {f.evidence.length > 0 && (
            <ul className="text-xs text-muted list-disc ml-5 grid grid-cols-[minmax(0,1fr)] gap-0.5 break-words" aria-label="Evidence">
              {f.evidence.slice(0, 8).map((e, i) => (
                <li key={i} className="min-w-0">
                  {e.text}
                  {e.ref && (
                    <>
                      {' '}
                      <RefLink to={e.ref} className="text-accent" />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
