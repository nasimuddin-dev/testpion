import { Bot, CheckCheck, FileText, FlaskConical, GitCompareArrows, ShieldCheck, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, on } from '../../api';
import { useApp, toastError } from '../../store';
import { timeAgo } from '../../lib/format';
import { useLibrary } from '../../lib/library';
import type { ProviderConfig } from '../../types';
import { LABEL } from '../../lib/vocabulary';
import { Button, Empty, LinkButton, SectionTitle } from '../../components/ui';
import { RunMiniBar, type RunRow } from '../../components/RunsOverview';

type Tab = 'playground' | 'compare' | 'rag' | 'providers' | 'usage' | 'start';

function StartCard({ id, icon, title, children, action, reason, time }: { id: string; icon: ReactNode; title: string; children: ReactNode; action: ReactNode; reason?: string; time?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3 flex flex-col gap-2 min-w-0" data-start-card={id}>
      <div className="flex items-center gap-2">
        <span className="grid place-items-center h-8 w-8 rounded-lg bg-accent-soft text-accent shrink-0">{icon}</span>
        <h3 className="font-semibold text-sm leading-tight">{title}</h3>
      </div>
      <p className="text-sm text-muted leading-snug flex-1">{children}</p>
      {reason && <p className="text-xs text-muted">{reason}</p>}
      <div className="flex items-center gap-2">
        {action}
        {time && <span className="text-xs text-muted">{time}</span>}
      </div>
    </div>
  );
}

/**
 * The first page of AI Lab (AU-9): "What do you want to check?" as cards by task, the sample that works with no key, and the
 * latest runs of your evaluations with how many passed. Every card goes to the place that does the job; nothing here holds logic.
 */
export function Start({ providers, onTab }: { providers?: ProviderConfig[]; onTab(t: Tab): void }) {
  const evaluations = useLibrary<{ type?: string }>('evaluations');
  const [runs, setRuns] = useState<RunRow[]>([]);
  useEffect(() => {
    const load = () => void call('runs.list', { limit: 60 }).then((r) => setRuns(r.items), toastError);
    load();
    return on('run.finished', load);
  }, []);
  const saved = evaluations.lib.items;
  const byName = useMemo(() => new Map(saved.map((i) => [i.name, i])), [saved]);
  const recent = useMemo(() => runs.filter((r) => byName.has(r.name)).slice(0, 6), [runs, byName]);
  const promptEvaluation = saved.find((i) => i.data.type !== 'rag');
  const open = (payload: Record<string, unknown>) => useApp.getState().openIntent('evaluations', payload);
  const hasRealModel = !!providers?.some((p) => p.kind !== 'mock');
  return (
    <div className="h-full overflow-auto" data-ai-start>
      <div className="max-w-5xl mx-auto p-5 flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold mr-auto">What do you want to check?</h2>
          <Button icon={<FlaskConical size={14} />} onClick={() => open({ sample: true })} title="Ten example messages on the offline demo model: no key, no network, a result in a few seconds" data-start-sample>
            Try the sample (offline)
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <StartCard
            id="correct"
            icon={<CheckCheck size={16} />}
            title="Answers are correct"
            time="About 2 minutes"
            action={
              <Button size="sm" variant="primary" onClick={() => open({ wizard: true })} data-start-go="correct">
                Start
              </Button>
            }
          >
            Test a prompt or chatbot on many cases, and see how many pass.
          </StartCard>
          <StartCard
            id="better"
            icon={<GitCompareArrows size={16} />}
            title="Which is better?"
            action={
              <Button size="sm" onClick={() => onTab('compare')} data-start-go="better">
                Start
              </Button>
            }
          >
            Two models on the same input: the fastest and the cheapest are marked.
          </StartCard>
          <StartCard
            id="documents"
            icon={<FileText size={16} />}
            title="Answers come from my documents"
            action={
              <Button size="sm" onClick={() => onTab('rag')} data-start-go="documents">
                Start
              </Button>
            }
          >
            A bot with sources: are its answers backed by the documents it found, and are those the right documents?
          </StartCard>
          <StartCard
            id="worse"
            icon={<ShieldCheck size={16} />}
            title="Nothing got worse"
            reason={promptEvaluation ? undefined : 'Save an evaluation first (Answers are correct), then come back.'}
            action={
              <Button size="sm" onClick={() => useApp.getState().set({ ci: { evaluation: promptEvaluation!.name } })} disabled={!promptEvaluation} reason="Save an evaluation first: the pipeline runs it by name" data-start-go="worse">
                {LABEL.runInCi}
              </Button>
            }
          >
            Run an evaluation on every push and fail the build when a case got worse than the last good run.
          </StartCard>
          <StartCard
            id="agent"
            icon={<Wrench size={16} />}
            title="An agent uses tools"
            action={
              <Button size="sm" onClick={() => open({ wizard: true, kind: 'agent' })} data-start-go="agent">
                Start
              </Button>
            }
          >
            Right tools, right arguments: list the tools each task should call, and the ones it must never call.
          </StartCard>
          <StartCard
            id="models"
            icon={<Bot size={16} />}
            title="Models and keys"
            action={
              <Button size="sm" onClick={() => onTab('providers')} data-start-go="models">
                Open
              </Button>
            }
          >
            Connect the models your prompts run on, set a price, and see what you have used.
          </StartCard>
        </div>
        {!hasRealModel && providers && (
          <div className="text-sm text-muted" data-start-offline>
            No model connected? The sample and “Use the offline demo model” need none: its answers come from rules.{' '}
            <LinkButton icon={null} onClick={() => onTab('providers')}>
              Connect a real model
            </LinkButton>
          </div>
        )}
        <div>
          <SectionTitle>Recent</SectionTitle>
          {recent.length === 0 ? (
            <div className="h-48 border border-dashed border-line rounded-xl overflow-hidden" data-start-recent="empty">
              <Empty title="No runs yet" actions={[{ label: 'Try the sample (offline)', icon: <FlaskConical size={13} />, onClick: () => open({ sample: true }) }]}>
                The runs of your evaluations appear here with how many passed.
              </Empty>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-line rounded-xl border border-line" data-start-recent="list">
              {recent.map((r) => {
                const item = byName.get(r.name)!;
                const bad = r.failed + r.errors > 0;
                return (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-start-run={r.id}>
                    <span className="font-medium truncate min-w-0 flex-1">{r.name}</span>
                    {r.total ? (
                      <>
                        <RunMiniBar r={r} />
                        <span className={bad ? 'text-bad' : 'text-ok'}>
                          {r.passed} of {r.total} passed
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">Running …</span>
                    )}
                    <span className="text-xs text-muted w-20 text-right">{timeAgo(r.startedAt)}</span>
                    <Button size="sm" onClick={() => open({ savedId: item.id, runId: r.id })}>
                      Open
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
