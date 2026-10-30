import { BookOpenCheck, Database, FlaskConical, Layers, Ruler } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, on } from '../../api';
import { attempt, toastError, useApp } from '../../store';
import { timeAgo } from '../../lib/format';
import { useLibrary } from '../../lib/library';
import { Button, Empty, SectionTitle } from '../../components/ui';
import { RunMiniBar, type RunRow } from '../../components/RunsOverview';
import type { RagTab } from '../../components/rag/RagTabs';

function StartCard({ id, icon, title, children, action }: { id: string; icon: ReactNode; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3 flex flex-col gap-2 min-w-0" data-start-card={id}>
      <div className="flex items-center gap-2">
        <span className="grid place-items-center h-8 w-8 rounded-lg bg-accent-soft text-accent shrink-0">{icon}</span>
        <h3 className="font-semibold text-sm leading-tight">{title}</h3>
      </div>
      <p className="text-sm text-muted leading-snug flex-1">{children}</p>
      <div className="flex items-center gap-2">{action}</div>
    </div>
  );
}

/**
 * The first page of RAG bots (R-1): the three steps as cards (connect a bot, build the questions, check the
 * answers), a fourth for your own measures, and the latest runs of your bot evaluations with how many passed. Every card
 * goes to the place that does the job; nothing here holds logic.
 */
export function RagStart({ onTab, onConnect }: { onTab(t: Exclude<RagTab, 'checks'>): void; onConnect(): void }) {
  const evaluations = useLibrary<{ type?: string }>('evaluations');
  const targets = useLibrary<{ name?: string }>('rag-targets');
  const [runs, setRuns] = useState<RunRow[]>([]);
  useEffect(() => {
    const load = () => void call('runs.list', { limit: 60 }).then((r) => setRuns(r.items), toastError);
    load();
    return on('run.finished', load);
  }, []);
  const bots = evaluations.lib.items.filter((i) => i.data.type === 'rag');
  const byName = useMemo(() => new Map(bots.map((i) => [i.name, i])), [bots]);
  const recent = useMemo(() => runs.filter((r) => byName.has(r.name)).slice(0, 6), [runs, byName]);
  const checks = (payload: Record<string, unknown> = {}) => useApp.getState().openIntent('evaluations', { host: 'rag', ...payload });
  /** Try the sample (R-2): an offline bot with four documents, six questions and the offline demo model as the reviewer; the report opens when the run starts. */
  const trySample = () =>
    attempt(async () => {
      const r = await call<{ runId: string; evaluation: string }>('rag.trySample');
      checks({ savedId: r.evaluation, runId: r.runId });
    });
  const connected = targets.lib.items.length;
  return (
    <div className="h-full overflow-auto" data-rag-start>
      <div className="max-w-5xl mx-auto p-5 flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold mr-auto">Is your bot's answer backed by the right documents?</h2>
          <Button icon={<FlaskConical size={14} />} onClick={() => void trySample()} title="An offline bot with four clinic documents, six questions and the offline demo model as the reviewer: no key, no network, a result in a few seconds" data-rag-start-sample>
            Try the sample (offline)
          </Button>
          <Button onClick={() => checks()} title="The evaluations of your bots and their runs" data-rag-start-checks>
            Open Checks
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <StartCard
            id="connect"
            icon={<Database size={16} />}
            title={connected ? `1 · Your bots (${connected})` : '1 · Connect a bot'}
            action={
              <Button size="sm" variant={connected ? undefined : 'primary'} onClick={connected ? () => onTab('bots') : onConnect} data-start-go="connect">
                {connected ? 'Open' : 'Connect'}
              </Button>
            }
          >
            Send it one question, click its answer and the documents it retrieved in the response: that is the whole set-up. Any protocol.
          </StartCard>
          <StartCard
            id="questions"
            icon={<Layers size={16} />}
            title="2 · Build the questions"
            action={
              <Button size="sm" onClick={() => onTab('questions')} data-start-go="questions">
                Open
              </Button>
            }
          >
            Write them, generate them from your documents with AI, or take them from real calls. The right documents of each question make retrieval measurable for free.
          </StartCard>
          <StartCard
            id="check"
            icon={<BookOpenCheck size={16} />}
            title="3 · Check the answers"
            action={
              <Button size="sm" variant={connected ? 'primary' : undefined} onClick={() => checks({ wizard: true, kind: 'bot' })} data-start-go="check">
                Start
              </Button>
            }
          >
            Two goals: every statement is backed by the sources, and the right documents are found. Five measures by default; 134 under More.
          </StartCard>
          <StartCard
            id="metrics"
            icon={<Ruler size={16} />}
            title="Your own measure"
            action={
              <Button size="sm" onClick={() => onTab('metrics')} data-start-go="metrics">
                Open
              </Button>
            }
          >
            A rule, a checklist, a formula over other measures, or a criterion an AI reviewer decides; try it on examples, then use it like any other.
          </StartCard>
        </div>
        <div>
          <SectionTitle>Recent</SectionTitle>
          {recent.length === 0 ? (
            <div className="h-48 border border-dashed border-line rounded-xl overflow-hidden" data-rag-start-recent="empty">
              <Empty title="No runs yet" actions={[{ label: 'Try the sample (offline)', icon: <FlaskConical size={13} />, onClick: () => void trySample() }]}>
                The runs of your bot evaluations appear here with how many questions passed. The sample needs no key and no server.
              </Empty>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-line rounded-xl border border-line" data-rag-start-recent="list">
              {recent.map((r) => {
                const item = byName.get(r.name)!;
                const bad = r.failed + r.errors > 0;
                return (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-rag-start-run={r.id}>
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
                    <Button size="sm" onClick={() => checks({ savedId: item.id, runId: r.id })}>
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
