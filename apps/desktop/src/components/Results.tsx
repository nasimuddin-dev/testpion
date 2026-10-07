import { AlertTriangle, Bot, CheckCircle2, CircleHelp, CircleSlash, KeyRound, Lightbulb, Sparkles, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { NormalizedError } from '../api';
import type { CheckResult } from '../types';
import { useApp } from '../store';
import { Badge, Button, cx } from './ui';

/** Normalised error display: what happened, why, and how to fix it (spec §45). */
export function ErrorPanel({ error, context }: { error: NormalizedError; context?: unknown }) {
  // an AI provider without its key: the way to fix it is one click away (the assistant can't explain it without a key)
  const setup = (error.details as { setup?: { provider?: string } } | undefined)?.setup;
  const ask = () =>
    useApp.getState().set({ assistant: { task: 'explain-error', title: `Explain ${error.kind}`, context: { error, ...((context as object) ?? {}) } } });
  return (
    <div role="alert" className="m-3 rounded-lg border border-bad/40 bg-bad/5 p-4 text-sm">
      <div className="flex items-start gap-2">
        <XCircle size={18} className="text-bad shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone="bad">{error.kind}</Badge>
            <span className="font-semibold break-all">{error.what || error.message}</span>
          </div>
          {error.why && error.why !== error.message && (
            <p className="mt-2">
              <span className="text-muted">Why: </span>
              {error.why}
            </p>
          )}
          {error.suggestions.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center gap-1 text-muted text-xs font-semibold uppercase tracking-wider mb-1">
                <Lightbulb size={12} /> Troubleshooting
              </div>
              <ul className="list-disc ml-5 space-y-0.5">
                {error.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {error.details && !setup && <pre className="mt-3 mono text-xs bg-panel p-2 rounded overflow-auto max-h-40">{JSON.stringify(error.details, null, 2)}</pre>}
          {setup ? (
            <Button
              size="sm"
              variant="primary"
              className="mt-3"
              icon={<KeyRound size={12} />}
              onClick={() => useApp.getState().openIntent('ai', { providerId: setup.provider, tab: 'providers' })}
            >
              Add the key
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="mt-3 -ml-2" icon={<Sparkles size={12} />} onClick={ask}>
              Explain with AI assistant
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SourceBadge({ source }: { source: CheckResult['source'] }) {
  if (source === 'deterministic') return null;
  if (source === 'ai-judge')
    return (
      <Badge tone="judge" title="Model-generated judgement — not deterministic. Verify before relying on it.">
        <Bot size={10} /> AI judge
      </Badge>
    );
  return <Badge title={source === 'heuristic' ? 'Approximate heuristic metric' : 'Embedding-based semantic metric'}>{source}</Badge>;
}

export function CheckList({ checks, compact, actions }: { checks: CheckResult[]; compact?: boolean; actions?(c: CheckResult): ReactNode }) {
  if (!checks.length) return <div className="p-4 text-sm text-muted">No assertions. Add some in the Tests tab.</div>;
  const passed = checks.filter((c) => c.passed).length;
  return (
    <div className="text-sm">
      {!compact && (
        <div className={cx('px-3 py-2 font-medium flex items-center gap-2 border-b border-line', passed === checks.length ? 'text-ok' : 'text-bad')}>
          {passed === checks.length ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
          {passed}/{checks.length} passed
        </div>
      )}
      {checks.map((c, i) => (
        <div key={i} className="px-3 py-1.5 border-b border-line last:border-0 flex items-start gap-2">
          {c.passed ? <CheckCircle2 size={14} className="text-ok mt-0.5 shrink-0" /> : <XCircle size={14} className="text-bad mt-0.5 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium">{c.name}</span>
              <SourceBadge source={c.source} />
              {c.score !== undefined && <Badge tone={c.passed ? 'ok' : 'bad'}>score {c.score}</Badge>}
              {actions?.(c)}
            </div>
            <div className="text-muted break-words">{c.message}</div>
            {c.explanation && (
              <div className="mt-1 text-xs border-l-2 border-judge/50 pl-2 text-muted">
                <span className="text-judge font-medium">Judge reasoning (AI-generated): </span>
                {c.explanation}
              </div>
            )}
            <EvidenceList check={c} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The items a claim-by-claim check judged (claims, documents, statements, entities): what is still to verify first,
 * then what was demonstrated, each with its evidence. A person decides; the list is what they look at.
 */
function EvidenceList({ check }: { check: CheckResult }) {
  const items = (check.metadata?.items as Array<{ text: string; ok: boolean; evidence?: string }> | undefined) ?? [];
  if (!items.length) return null;
  const open = items.filter((i) => !i.ok);
  const done = items.filter((i) => i.ok);
  const row = (i: { text: string; ok: boolean; evidence?: string }, k: number) => (
    <li key={k} className="flex items-start gap-1.5">
      {i.ok ? <CheckCircle2 size={12} className="text-ok mt-0.5 shrink-0" /> : <CircleHelp size={12} className="text-warn mt-0.5 shrink-0" />}
      <span className="min-w-0">
        {i.text}
        {i.evidence && <span className="text-muted"> — {i.evidence}</span>}
      </span>
    </li>
  );
  return (
    <details className="mt-1 text-xs" open={!check.passed}>
      <summary className="cursor-pointer text-muted select-none">
        {open.length ? `${open.length} still to verify, ` : ''}
        {done.length} demonstrated{check.source === 'ai-judge' ? ' (AI-judged — check the evidence)' : ''}
      </summary>
      <ul className="mt-1 space-y-0.5 ml-1">
        {open.map(row)}
        {done.map((i, k) => row(i, open.length + k))}
      </ul>
    </details>
  );
}

export function StatusIcon({ status }: { status: string }) {
  if (status === 'passed') return <CheckCircle2 size={14} className="text-ok" />;
  if (status === 'skipped') return <CircleSlash size={14} className="text-warn" />;
  if (status === 'error') return <AlertTriangle size={14} className="text-bad" />;
  return <XCircle size={14} className="text-bad" />;
}

/** Banner that marks content as AI-generated (spec §34, rule 17). */
export function AiGeneratedNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs px-3 py-1.5 bg-judge/10 text-judge border-b border-judge/30">
      <Sparkles size={12} /> {children ?? 'AI-generated suggestion — verify before use. This is not a test result.'}
    </div>
  );
}
