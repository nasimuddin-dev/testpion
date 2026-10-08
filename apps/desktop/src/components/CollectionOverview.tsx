import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import type { Collection, CollectionNode } from '../types';
import { formatMs, plural, timeAgo } from '../lib/format';
import { BarRow, ChartCard, RecentRuns, StatTile } from './charts';
import { TimeByPhase } from './RunCharts';
import { useApp } from '../store';
import { LinkButton, Badge, cx, statusTone } from './ui';
import { useRpc } from '../lib/use-rpc';

/** From `stats.requests` (summarizeRequestStats in core). */
interface RequestStat {
  requestId: string;
  count: number;
  failed: number;
  lastStatus?: number | string;
  lastAt: string;
  lastOk: boolean;
  medianMs?: number;
  recent?: string[];
}

/** From `col.variableFlow` (collectionVariableFlow in core). */
interface FlowPlace {
  name: string;
  requestId?: string;
  index: number;
  path: string[];
}
interface VariableFlow {
  name: string;
  setBy: FlowPlace[];
  usedBy: FlowPlace[];
  defined: boolean;
  issue?: 'used-before-set' | 'never-set' | 'unused';
}
const ISSUE: Record<NonNullable<VariableFlow['issue']>, string> = { 'used-before-set': 'used before it is set', 'never-set': 'never set', unused: 'set, never used' };

/** Variables set by scripts (the request chain) and variables with a likely mistake: who sets them, who uses them. */
function VariableFlowCard({ collectionId, onOpen }: { collectionId: string; onOpen(requestId: string): void }) {
  const flows = useRpc<VariableFlow[]>('col.variableFlow', { collectionId }, { fallback: [] });
  const rows = (flows ?? []).filter((f) => f.setBy.length || f.issue);
  if (!flows || !rows.length) return null;
  const place = (p: FlowPlace) =>
    p.requestId ? (
      <button key={p.name + p.index} className="text-fg hover:text-accent hover:underline truncate max-w-48" title={[...p.path, p.name].join(' / ')} onClick={() => onOpen(p.requestId!)}>
        {p.name}
      </button>
    ) : (
      <span key={p.name + p.index} className="text-muted truncate max-w-48" title="Collection or folder script (runs for every request inside)">
        {p.name} (scripts)
      </span>
    );
  return (
    <ChartCard title="Variable flow" aside="set by scripts → used by requests, in run order">
      <div className="flex flex-col">
        {rows.map((f) => (
          <div key={f.name} className="flex items-center gap-2 py-1 text-xs min-w-0 border-b border-line/40 last:border-0">
            <span className="mono text-fg w-36 shrink-0 truncate" title={f.name}>{`{{${f.name}}}`}</span>
            <span className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">
              {f.setBy.length ? f.setBy.slice(0, 3).map(place) : <span className="text-muted">{f.defined ? 'environment / collection' : 'nothing sets it'}</span>}
              {f.setBy.length > 3 && <span className="text-muted">+{f.setBy.length - 3}</span>}
              <span className="text-muted">→</span>
              {f.usedBy.length ? (
                <span className="text-muted" title={f.usedBy.map((p) => [...p.path, p.name].join(' / ')).join('\n')}>
                  {plural(f.usedBy.length, 'use')}
                </span>
              ) : (
                <span className="text-muted">no uses</span>
              )}
            </span>
            {f.issue && <Badge tone={f.issue === 'unused' ? 'default' : 'warn'}>{ISSUE[f.issue]}</Badge>}
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

/** The collection's latest runs (Collection Runner and CLI runs are named after it): a pass / fail strip and the last result. */
function RecentCollectionRuns({ name }: { name: string }) {
  const [runs, setRuns] = useState<Array<{ id: string; name: string; startedAt: string; total: number; passed: number; failed: number; errors: number }>>([]);
  useEffect(() => {
    void call<{ items: typeof runs }>('runs.list', { query: name, limit: 50 }).then(
      (r) => setRuns(r.items.filter((x) => x.name === name || x.name.startsWith(`${name} / `) || x.name === `Failed requests of ${name}`).slice(0, 20)),
      () => setRuns([]),
    );
  }, [name]);
  if (!runs.length) return null;
  const last = runs[0]!;
  const bad = last.failed + last.errors;
  return (
    <ChartCard title="Recent runs" aside={<RecentRuns statuses={[...runs].reverse().map((r) => (r.failed + r.errors ? 'failed' : 'passed'))} />}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">Last run</span>
        <span className={bad ? 'text-bad' : 'text-ok'}>
          {last.passed}/{last.total} passed
        </span>
        <span className="text-muted">
          · {timeAgo(last.startedAt)}
          {last.name !== name ? ` · ${last.name.slice(name.length + 3) || last.name}` : ''}
        </span>
        <LinkButton className="ml-auto" icon={<ArrowRight size={12} />} onClick={() => useApp.getState().openIntent('tests', { runId: last.id })}>
          Open run
        </LinkButton>
      </div>
    </ChartCard>
  );
}

type Saved = Exclude<CollectionNode, { kind: 'folder' }>;
interface Row {
  node: Saved;
  path: string[];
  method: string;
  stat?: RequestStat;
}

function walk(nodes: CollectionNode[], path: string[], out: { rows: Row[]; folders: number }) {
  for (const n of nodes) {
    if (n.kind === 'folder') {
      out.folders++;
      walk(n.items, [...path, n.name], out);
    } else out.rows.push({ node: n, path, method: n.kind === 'graphql' ? 'GQL' : n.request.method });
  }
}

const hasChecks = (n: Saved) => !!n.assertions?.length || !!n.testScript?.trim();

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

/**
 * A collection at a glance: how many requests and folders, how many have checks and docs, requests per method,
 * and each request's health from the responses sent in the app (latest status, failures, median time).
 */
export function CollectionOverview({ collection, onOpen, onRun }: { collection: Collection; onOpen(node: Saved): void; onRun?(): void }) {
  /** Which requests the health card lists: the sent ones (with their health), or one group of the others. */
  const [show, setShow] = useState<'sent' | 'unsent' | 'unchecked'>('sent');
  const [all, setAll] = useState(false);
  const stats = useRpc<RequestStat[]>('stats.requests', { collectionId: collection.id }, { fallback: [] }) ?? [];
  const timing = useRpc<Parameters<typeof TimeByPhase>[0]['p'] | null>('stats.collectionTiming', { collectionId: collection.id }, { fallback: null }) ?? null;
  const { rows, folders } = useMemo(() => {
    const out = { rows: [] as Row[], folders: 0 };
    walk(collection.items, [], out);
    const byId = new Map(stats.map((s) => [s.requestId, s]));
    for (const r of out.rows) r.stat = byId.get(r.node.id);
    return out;
  }, [collection.items, stats]);
  const withChecks = rows.filter((r) => hasChecks(r.node)).length;
  const documented = rows.filter((r) => r.node.kind === 'http' && r.node.description?.trim()).length;
  const sent = rows.filter((r) => r.stat);
  const failing = sent.filter((r) => !r.stat!.lastOk);
  const methods = Object.entries(rows.reduce<Record<string, number>>((a, r) => ((a[r.method] = (a[r.method] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
  const maxMethod = Math.max(1, ...methods.map((m) => m[1]));
  // failing first, then slowest; requests never sent last (alphabetical)
  const health = [...rows].sort((a, b) => {
    if (!!a.stat !== !!b.stat) return a.stat ? -1 : 1;
    if (a.stat && b.stat) {
      if (a.stat.lastOk !== b.stat.lastOk) return a.stat.lastOk ? 1 : -1;
      return (b.stat.medianMs ?? 0) - (a.stat.medianMs ?? 0);
    }
    return [...a.path, a.node.name].join('/').localeCompare([...b.path, b.node.name].join('/'));
  });
  const maxMs = Math.max(1, ...rows.map((r) => r.stat?.medianMs ?? 0));
  const kinds = rows.reduce((a, r) => ((a[r.node.kind] = (a[r.node.kind] ?? 0) + 1), a), {} as Record<string, number>);

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Requests"
          value={String(rows.length)}
          sub={[kinds.http && `${kinds.http} REST`, kinds.graphql && `${kinds.graphql} GraphQL`, plural(folders, 'folder')].filter(Boolean).join(' · ')}
        />
        <StatTile
          label="With checks"
          value={pct(withChecks, rows.length)}
          sub={`${withChecks} of ${rows.length} have assertions or tests`}
          tone={!rows.length ? undefined : withChecks === rows.length ? 'ok' : undefined}
        />
        <StatTile label="Documented" value={pct(documented, kinds.http ?? 0)} sub={`${documented} of ${kinds.http ?? 0} REST requests`} />
        <StatTile
          label="Failing now"
          value={sent.length ? String(failing.length) : '—'}
          sub={sent.length ? `latest response of ${plural(sent.length, 'sent request')}` : 'nothing sent from the app yet'}
          tone={!sent.length ? undefined : failing.length ? 'bad' : 'ok'}
        />
      </div>
      <RecentCollectionRuns name={collection.name} />
      {timing && (
        <div className="max-w-2xl">
          <TimeByPhase p={timing} />
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_3fr]">
        <ChartCard title="By method">
          <div className="flex flex-col gap-1.5">
            {methods.map(([m, n]) => (
              <BarRow
                key={m}
                label={m}
                labelClass={cx('mono font-bold w-12 text-[0.68rem]', `method-${m}`)}
                segments={[{ value: n, color: 'var(--accent)' }]}
                of={maxMethod}
                right={n}
                title={plural(n, `${m} request`)}
              />
            ))}
            {!methods.length && <p className="text-xs text-muted">No requests yet.</p>}
          </div>
        </ChartCard>
        <ChartCard title="Request health" aside="from responses sent in the app">
          {(() => {
            const unsent = health.filter((r) => !r.stat);
            const unchecked = health.filter((r) => !hasChecks(r.node));
            const mode = show === 'sent' && !sent.length ? 'none' : show;
            const list = mode === 'sent' ? health.filter((r) => r.stat) : mode === 'unsent' ? unsent : mode === 'unchecked' ? unchecked : [];
            const shown = all ? list : list.slice(0, 100);
            const chip = (id: typeof show, label: string, n: number) => (
              <button
                key={id}
                className={cx('px-2 py-0.5 rounded-full border text-xs', show === id ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:text-fg', !n && 'opacity-50')}
                disabled={!n}
                aria-pressed={show === id}
                onClick={() => (setShow(id), setAll(false))}
              >
                {label} {n}
              </button>
            );
            if (!rows.length) return <p className="text-xs text-muted">Add requests to see how they are doing.</p>;
            return (
              <div className="flex flex-col gap-2" data-request-health={mode}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {chip('sent', 'Sent', sent.length)}
                  {chip('unsent', 'Not sent yet', unsent.length)}
                  {chip('unchecked', 'Without checks', unchecked.length)}
                </div>
                {mode === 'none' && (
                  <div className="text-xs text-muted flex items-center gap-2 flex-wrap py-2">
                    <span>None of the {rows.length} requests has been sent from the app yet: their health (status, time, failures) shows here once they are.</span>
                    {onRun && (
                      <LinkButton icon={<ArrowRight size={12} />} onClick={onRun}>
                        Run the collection
                      </LinkButton>
                    )}
                  </div>
                )}
                {mode === 'unsent' && <p className="text-xs text-muted">Never sent from the app: open one and send it, or run the collection.</p>}
                {mode === 'unchecked' && <p className="text-xs text-muted">No assertions or test script: a response passes whatever it is. Open one and add checks in its Tests tab.</p>}
                <div className="flex flex-col">
                  {shown.map((r) => (
                    <button
                      key={r.node.id}
                      className="flex items-center gap-2 py-1 px-1 -mx-1 rounded text-xs text-left min-w-0 hover:bg-hover"
                      onClick={() => onOpen(r.node)}
                      title={[...r.path, r.node.name].join(' / ')}
                    >
                      <span className={cx('mono font-bold w-12 shrink-0 text-[0.68rem]', `method-${r.method}`)}>{r.method}</span>
                      <span className="truncate flex-1 min-w-0 text-fg">
                        {r.path.length > 0 && <span className="text-muted">{r.path.join(' / ')} / </span>}
                        {r.node.name}
                      </span>
                      {mode === 'sent' && r.stat && (
                        <>
                          {!hasChecks(r.node) && (
                            <span className="text-muted shrink-0" title="No assertions or tests">
                              no checks
                            </span>
                          )}
                          <span className="w-12 shrink-0 hidden md:flex justify-end">
                            <RecentRuns statuses={r.stat.recent ?? []} />
                          </span>
                          <Badge tone={statusTone(r.stat.lastStatus)}>{String(r.stat.lastStatus ?? '—')}</Badge>
                          <span
                            className="w-24 h-1.5 rounded-full bg-hover/60 overflow-hidden shrink-0 hidden sm:block"
                            title={r.stat.medianMs !== undefined ? `median ${formatMs(r.stat.medianMs)}` : undefined}
                          >
                            {r.stat.medianMs !== undefined && <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, (r.stat.medianMs / maxMs) * 100)}%` }} />}
                          </span>
                          <span className="w-14 text-right tabular-nums shrink-0 text-fg">{r.stat.medianMs !== undefined ? formatMs(r.stat.medianMs) : '—'}</span>
                          <span className={cx('w-16 text-right tabular-nums shrink-0', r.stat.failed ? 'text-bad' : 'text-muted')} title={`${r.stat.failed} of ${r.stat.count} responses failed`}>
                            {r.stat.failed}/{r.stat.count}
                          </span>
                          <span className="w-16 text-right text-muted shrink-0">{timeAgo(r.stat.lastAt)}</span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
                {list.length > shown.length && (
                  <LinkButton className="self-start" onClick={() => setAll(true)}>
                    Show all {list.length}
                  </LinkButton>
                )}
              </div>
            );
          })()}
        </ChartCard>
      </div>
      <VariableFlowCard
        collectionId={collection.id}
        onOpen={(id) => {
          const n = rows.find((r) => r.node.id === id)?.node;
          if (n) onOpen(n);
        }}
      />
    </div>
  );
}
