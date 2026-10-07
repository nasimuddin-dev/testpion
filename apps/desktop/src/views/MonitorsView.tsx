import { RecentRuns } from '../components/charts';
import { AlarmClock, ExternalLink, Sparkles, Folder, KeyRound, ListX, Pause, Pencil, Play, Plus, SquareX, Trash2, X } from 'lucide-react';
import { SidebarShell } from '../components/SidebarShell';
import { MonitorCharts } from '../components/MonitorCharts';
import { MonitorRequests } from '../components/MonitorRequests';
import { FolderList, type FolderListOps } from '../components/FolderList';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call, on } from '../api';
import type { MonitorResult } from '../lib/monitor-alerts';
import { useIntent } from '../hooks';
import { confirmAction, useApp } from '../store';
import type { Collection, CollectionNode, Library } from '../types';
import { formatMs, timeAgo } from '../lib/format';
import { Badge, Button, cx, Empty, Field, Input, Metric, Menu, MetricGrid, ModalOrPanel, PageHeader, Select, Split, Toggle, Tooltip } from '../components/ui';

interface MonitorDraft {
  id?: string;
  name: string;
  collectionId: string;
  selection?: string[];
  environment?: string;
  everyMinutes: number;
  enabled: boolean;
  iterations?: number;
  bail?: boolean;
  webhook?: string;
  /** Fail runs whose p95 response time is over this (ms). */
  maxP95Ms?: number;
  minCertDays?: number;
  folder?: string;
}

interface MonitorRow extends MonitorDraft {
  id: string;
  schedule: string;
  lastResult?: MonitorResult;
  /** Statuses of the latest runs, oldest first. */
  recent?: string[];
  /** Share of the last 7 days' runs that passed. */
  uptime7d?: number;
  nextRunAt?: string;
  due: boolean;
  running: boolean;
}

const UNITS = [
  { id: 'm', label: 'minutes', f: 1 },
  { id: 'h', label: 'hours', f: 60 },
  { id: 'd', label: 'days', f: 1440 },
] as const;

const tone = (s?: MonitorResult['status']) => (s === 'passed' ? 'ok' : s ? 'bad' : 'default');
const statusLabel = (r?: MonitorResult) => (!r ? 'Never ran' : r.status === 'passed' ? 'Passed' : r.status === 'failed' ? (r.reason && !(r.failed + r.errors) ? (r.reason.startsWith('p95') ? 'Too slow' : 'Attention') : 'Failed') : 'Could not run');

export function MonitorsView() {
  const [rows, setRows] = useState<MonitorRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string>();
  const [resultsById, setResultsById] = useState<Record<string, MonitorResult[]>>({});
  const [collections, setCollections] = useState<Collection[]>([]);
  const [editing, setEditing] = useState<MonitorDraft>();
  const [busy, setBusy] = useState<string[]>([]);
  // monitors open in tabs, like requests (several can be open and running at once); remembered
  const [openIds, setOpenIds] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('aps.monitorTabs') ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('aps.monitorTabs', JSON.stringify(openIds));
    } catch {
      /* storage unavailable */
    }
  }, [openIds]);
  /** Open a monitor in its tab (or bring its tab forward). */
  const openTab = (id: string) => {
    setEditing(undefined);
    setOpenIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    setSel(id);
  };
  const closeTabs = (ids: string[]) => {
    const rest = openIds.filter((x) => !ids.includes(x));
    setOpenIds(rest);
    if (sel && ids.includes(sel)) {
      const i = openIds.indexOf(sel);
      setSel(rest[Math.min(i, rest.length - 1)]);
    }
  };
  const toast = useApp((s) => s.toast);

  // folders of the list (empty ones included) live in the workspace library "monitors"
  const [folders, setFolders] = useState<string[]>([]);
  const load = useCallback(async () => {
    const [list, cols, lib] = await Promise.all([call<MonitorRow[]>('monitor.list'), call<Collection[]>('col.list'), call<Library<unknown>>('lib.get', { kind: 'monitors' }).catch(() => ({ folders: [], items: [] }))]);
    setRows(list);
    setFolders(lib.folders);
    setCollections(cols);
    setLoaded(true);
    // deleted monitors leave their tabs
    setOpenIds((ids) => ids.filter((id) => list.some((m) => m.id === id)));
    setSel((s) => (s && list.some((m) => m.id === s) ? s : list[0]?.id));
  }, []);
  const loadResults = useCallback(async (id?: string) => {
    if (!id) return;
    const list = await call<MonitorResult[]>('monitor.results', { id, limit: 100 });
    setResultsById((r) => ({ ...r, [id]: list }));
  }, []);

  useEffect(() => void load(), [load]);
  // monitors saved elsewhere (the sidebar, the CLI, an AI agent through MCP) show up here
  useEffect(() => on('data.changed', () => void load()), [load]);
  useEffect(() => void loadResults(sel), [sel, loadResults]);
  // scheduled runs finish in the background: refresh the list and the open monitor
  useEffect(() => {
    const offResult = on<{ result: MonitorResult }>('monitor.result', ({ result }) => {
      void load();
      // every open tab keeps its runs up to date, not only the one on screen
      if (openIds.includes(result.monitorId) || result.monitorId === sel) void loadResults(result.monitorId);
    });
    const offStart = on('monitor.started', () => void load());
    return () => (offResult(), offStart());
  }, [load, loadResults, sel, openIds]);
  // the monitor on screen always has a tab
  useEffect(() => {
    if (sel && !openIds.includes(sel)) setOpenIds((ids) => (ids.includes(sel) ? ids : [...ids, sel]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  // "next run in …" stays current
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useIntent(
    'monitors',
    (p?: { create?: { collectionId: string; selection?: string[] }; monitorId?: string }) => {
      if (p?.monitorId) openTab(p.monitorId);
      if (p?.create) setEditing({ name: '', collectionId: p.create.collectionId, selection: p.create.selection, everyMinutes: 15, enabled: true, environment: useApp.getState().environment });
    },
    'monitors',
  );

  const current = rows.find((m) => m.id === sel);
  const colName = (id: string) => collections.find((c) => c.id === id)?.name ?? 'missing collection';

  const run = async (m: MonitorRow) => {
    setBusy((b) => [...b, m.id]);
    try {
      const r = await call<MonitorResult>('monitor.run', { id: m.id });
      toast(`${m.name}: ${statusLabel(r).toLowerCase()} (${r.passed}/${r.total})`, r.status === 'passed' ? 'success' : 'error');
    } catch (e) {
      toast(asError(e).message, 'error');
    } finally {
      setBusy((b) => b.filter((x) => x !== m.id));
      await load();
      await loadResults(m.id);
    }
  };
  const save = async (d: MonitorDraft) => {
    const saved = await call<MonitorRow>('monitor.save', { monitor: d });
    setEditing(undefined);
    await load();
    setSel(saved.id);
  };
  const toggle = async (m: MonitorRow) => {
    try {
      await call('monitor.save', { monitor: { ...m, enabled: !m.enabled } });
    } catch (e) {
      toast(asError(e).message, 'error');
    }
    await load();
  };
  const remove = async (m: MonitorRow) => {
    if (!(await confirmAction({ title: 'Delete monitor', message: `Delete "${m.name}"?`, detail: 'Its past runs stay in the Tests view.', confirmLabel: 'Delete', danger: true }))) return;
    await call('monitor.delete', { id: m.id });
    await load();
  };

  const newDraft = (): MonitorDraft => ({ name: '', collectionId: collections[0]?.id ?? '', everyMinutes: 15, enabled: true, environment: useApp.getState().environment });
  /** Change the monitors library directly (folders): monitors keep their data, only folders change. */
  const editLibrary = async (fn: (lib: Library<unknown>) => Library<unknown>) => {
    const lib = await call<Library<unknown>>('lib.get', { kind: 'monitors' });
    await call('lib.save', { kind: 'monitors', library: fn(lib) });
    await load();
  };
  const update = async (id: string, change: Partial<MonitorDraft>) => {
    const m = rows.find((x) => x.id === id);
    if (!m) return;
    try {
      await call('monitor.save', { monitor: { ...m, ...change } });
      await load();
    } catch (e) {
      toast(asError(e).message, 'error');
    }
  };
  const monitorOps: FolderListOps = {
    renameItem: (id, name) => update(id, { name }),
    moveItem: (id, folder) => update(id, { folder }),
    deleteItem: async (id) => {
      await call('monitor.delete', { id });
      await load();
    },
    duplicateItem: async (id) => {
      const m = rows.find((x) => x.id === id);
      if (!m) return;
      const { id: _id, lastResult: _r, running: _x, schedule: _s, nextRunAt: _n, due: _d, ...data } = m;
      const copy = await call<MonitorRow>('monitor.save', { monitor: { ...data, name: `${m.name} copy` } });
      await load();
      setSel(copy.id);
    },
    setFolders: (next) => editLibrary((lib) => ({ ...lib, folders: next })),
    renameFolder: (from, to) => editLibrary((lib) => ({ ...lib, folders: lib.folders.map((f) => (f === from ? to : f)), items: lib.items.map((i) => (i.folder === from ? { ...i, folder: to } : i)) })),
    deleteFolder: (name) => editLibrary((lib) => ({ ...lib, folders: lib.folders.filter((f) => f !== name), items: lib.items.map((i) => (i.folder === name ? { ...i, folder: undefined } : i)) })),
  };
  return (
    <Split id="monitors" sidebar initial={20} min={12}>
      <SidebarShell
        id="monitors"
        panes={[
          {
            id: 'monitors',
            label: 'Monitors',
            icon: <AlarmClock size={13} />,
            render: () => (
              <FolderList
                id="monitors"
                title="Monitors"
                itemNoun="monitor"
                addLabel={collections.length ? 'New monitor' : 'Create a collection first'}
                folders={folders}
                selected={editing ? undefined : sel}
                onSelect={openTab}
                onAdd={(folder) => collections.length && setEditing({ ...newDraft(), ...(folder ? { folder } : {}) })}
                items={rows.map((m) => ({
                  id: m.id,
                  name: m.name,
                  folder: m.folder,
                  icon: <span className={cx('block w-2 h-2 rounded-full', m.running ? 'bg-accent animate-pulse' : !m.lastResult ? 'bg-muted/50' : m.lastResult.status === 'passed' ? 'bg-ok' : 'bg-bad')} />,
                  badge: m.enabled ? <RecentRuns statuses={m.recent ?? []} /> : <Badge>paused</Badge>,
                  subtitle: `${colName(m.collectionId)}${m.enabled ? ` · ${m.schedule}` : ''}${m.uptime7d !== undefined ? ` · ${m.uptime7d}% (7 days)` : ''}${m.lastResult ? ` · ${timeAgo(m.lastResult.startedAt)}` : ''}`,
                }))}
                itemMenu={(id) => {
                  const m = rows.find((x) => x.id === id)!;
                  return [
                    { label: 'Open in tab', icon: <ExternalLink size={14} />, onSelect: () => openTab(id) },
                    { label: 'Edit', icon: <Pencil size={14} />, onSelect: () => (openTab(id), setEditing(m)) },
                    { label: 'Run now', icon: <Play size={14} />, disabled: busy.includes(id) || m.running, onSelect: () => void run(m) },
                    { label: m.enabled ? 'Pause' : 'Resume', icon: <AlarmClock size={14} />, onSelect: () => void toggle(m) },
                  ];
                }}
                ops={monitorOps}
                empty={
                  <Empty
                    icon={<AlarmClock size={24} />}
                    title="No monitors yet"
                    actions={
                      collections.length
                        ? [{ label: 'New monitor', icon: <Plus size={12} />, onClick: () => setEditing(newDraft()) }]
                        : [{ label: 'Create a collection first', onClick: () => useApp.getState().setView('collections'), primary: false }]
                    }
                  >
                    A monitor runs a collection (or some of its folders) on a schedule, in an environment you choose, and tells you when it starts failing: here, in the status bar, and by webhook or e-mail.
                  </Empty>
                }
              />
            ),
          },
          { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
        ]}
      />
      <div className="h-full min-h-0 flex flex-col">
        <MonitorTabs
          tabs={openIds.map((id) => rows.find((m) => m.id === id)).filter((m): m is MonitorRow => !!m)}
          active={editing && !editing.id ? undefined : sel}
          busy={busy}
          extra={editing && !editing.id ? 'New monitor' : undefined}
          onSelect={(id) => {
            setEditing(undefined);
            setSel(id);
          }}
          onClose={(ids) => closeTabs(ids)}
          onRun={(m) => void run(m)}
          onCancelNew={() => setEditing(undefined)}
        />
        <div className="flex-1 min-h-0 overflow-auto">
        {/* a monitor is created and edited here, like any item in its editor, not in a dialog */}
        {editing ? (
          <MonitorEditor key={editing.id ?? 'new'} draft={editing} collections={collections} onCancel={() => setEditing(undefined)} onSave={save} />
        ) : current ? (
          <MonitorDetail
            m={current}
            results={resultsById[current.id] ?? []}
            collectionName={colName(current.collectionId)}
            folderNames={names(collections.find((c) => c.id === current.collectionId), current.selection)}
            busy={busy.includes(current.id) || current.running}
            onRun={() => void run(current)}
            onEdit={() => setEditing(current)}
            onToggle={() => void toggle(current)}
            onDelete={() => void remove(current)}
          />
        ) : (
          loaded &&
          (rows.length > 0 ? (
            <Empty title="Select a monitor" />
          ) : (
            <Empty
              icon={<AlarmClock size={24} />}
              title="Run collections on a schedule"
              action={
                <Button variant="primary" icon={<Plus size={13} />} disabled={!collections.length} onClick={() => setEditing({ name: '', collectionId: collections[0]?.id ?? '', everyMinutes: 15, enabled: true, environment: useApp.getState().environment })}>
                  New monitor
                </Button>
              }
            >
              {collections.length ? 'A monitor runs a collection, or some of its folders, every few minutes while TestPion is open, and tells you when it starts failing. From the terminal: testpion monitor.' : 'Create a collection first: a monitor runs a collection on a schedule.'}
            </Empty>
          ))
        )}
        </div>
      </div>
    </Split>
  );
}

/** Names of selected folders / requests (for the header). */
function names(c: Collection | undefined, ids?: string[]): string[] {
  if (!c || !ids?.length) return [];
  const all: CollectionNode[] = [];
  const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
  walk(c.items);
  return ids.map((id) => all.find((n) => n.id === id)?.name ?? id);
}

function MonitorDetail(p: {
  m: MonitorRow;
  results: MonitorResult[];
  collectionName: string;
  folderNames: string[];
  busy: boolean;
  onRun(): void;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}) {
  const { m, results } = p;
  const last = results[0];
  const stats = useMemo(() => {
    const done = results.filter((r) => r.status !== 'error' || r.total === 0);
    const passed = results.filter((r) => r.status === 'passed').length;
    const ms = results.map((r) => r.durationMs).sort((a, b) => a - b);
    return { uptime: results.length ? Math.round((passed / results.length) * 1000) / 10 : undefined, median: ms[Math.max(0, Math.ceil(ms.length / 2) - 1)], count: done.length };
  }, [results]);
  const next = m.enabled && m.nextRunAt ? Date.parse(m.nextRunAt) - Date.now() : undefined;
  return (
    <div className="p-4 flex flex-col gap-4 max-w-6xl">
      <PageHeader
        icon={<AlarmClock size={18} />}
        title={m.name}
        subtitle={
          <>
            {p.collectionName}
            {p.folderNames.length > 0 && ` › ${p.folderNames.join(', ')}`}
            {m.environment && ` · ${m.environment}`} · {m.schedule}
          </>
        }
        actions={
          <>
            <Button size="sm" variant="primary" icon={<Play size={14} />} loading={p.busy} onClick={p.onRun}>
              Run now
            </Button>
            {last && last.status !== 'passed' && (
              <Button
                size="sm"
                icon={<Sparkles size={14} />}
                title="Ask the AI assistant what is wrong and what to do (the monitor's results, reasons and per-request numbers are sent; no bodies or secrets)"
                onClick={() =>
                  void call('monitor.requests', { id: m.id, runs: 20 }).then(
                    (requests) =>
                      useApp.getState().set({
                        assistant: {
                          task: 'explain-monitor',
                          title: `Why "${m.name}" is failing`,
                          context: {
                            monitor: { name: m.name, schedule: m.schedule, environment: m.environment, maxP95Ms: m.maxP95Ms, minCertDays: m.minCertDays },
                            latestResults: results.slice(0, 15).map((r) => ({ when: r.startedAt, status: r.status, passed: r.passed, total: r.total, p95Ms: r.p95Ms, certDaysLeft: r.certDaysLeft, reason: r.reason, error: r.error })),
                            requests,
                          },
                        },
                      }),
                    () => undefined,
                  )
                }
              >
                Explain with AI
              </Button>
            )}
            <Tooltip content={m.enabled ? 'Pause the schedule' : 'Resume the schedule'}>
              <Button size="sm" icon={m.enabled ? <Pause size={14} /> : <AlarmClock size={14} />} onClick={p.onToggle}>
                {m.enabled ? 'Pause' : 'Resume'}
              </Button>
            </Tooltip>
            <Button size="sm" icon={<Pencil size={14} />} onClick={p.onEdit}>
              Edit
            </Button>
          </>
        }
        menuLabel="More monitor actions"
        menu={[{ label: 'Delete monitor', icon: <Trash2 size={14} />, danger: true, onSelect: p.onDelete }]}
      />

      <MetricGrid compact>
        <Metric label="Last result" value={statusLabel(last)} tone={last ? (last.status === 'passed' ? 'ok' : 'bad') : undefined} sub={last ? (last.reason ?? timeAgo(last.startedAt)) : undefined} />
        <Metric label="Success rate" value={stats.uptime === undefined ? '—' : `${stats.uptime}%`} tone={stats.uptime === undefined ? undefined : stats.uptime === 100 ? 'ok' : stats.uptime >= 90 ? 'warn' : 'bad'} sub={results.length === 1 ? 'the last run' : `last ${results.length} runs`} />
        <Metric label="Median run time" value={stats.median === undefined ? '—' : formatMs(stats.median)} />
        <Metric label="Median response" value={!last?.p50Ms || !last.passed ? '—' : formatMs(last.p50Ms)} sub="last run's requests" />
        {last?.certDaysLeft !== undefined && <Metric label="Certificate" value={last.certDaysLeft < 0 ? 'Expired' : `${last.certDaysLeft} days`} tone={last.certDaysLeft < (m.minCertDays ?? 14) ? 'bad' : last.certDaysLeft < 30 ? 'warn' : 'ok'} sub="left on the first to expire" />}
        <Metric label="Next run" value={!m.enabled ? 'Paused' : next === undefined ? '—' : next <= 0 ? 'Due now' : `in ${formatWait(next)}`} sub={m.enabled ? 'while TestPion is open' : undefined} />
      </MetricGrid>

      {/* charts: availability, run time, requests per run (hover any of them for the run) */}
      <MonitorCharts runs={results} p95Limit={m.maxP95Ms} monitorId={m.id} />
      <MonitorRequests monitorId={m.id} refresh={results[0]?.runId} />

      <div>
        <div className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Runs</div>
        {results.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted text-left">
                <th className="font-normal py-1">When</th>
                <th className="font-normal">Result</th>
                <th className="font-normal text-right">Requests</th>
                <th className="font-normal text-right">Time</th>
                <th className="font-normal pl-4">Started by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.runId} className="border-t border-line/60">
                  <td className="py-1.5 whitespace-nowrap" title={new Date(r.startedAt).toLocaleString()}>
                    {timeAgo(r.startedAt)}
                  </td>
                  <td>
                    <Badge tone={tone(r.status)}>{statusLabel(r)}</Badge>
                    {(r.error || r.reason) && <span className="text-xs text-bad ml-2">{r.error ?? r.reason}</span>}
                  </td>
                  <td className="text-right tabular-nums">{r.total ? `${r.passed}/${r.total}` : '—'}</td>
                  <td className="text-right tabular-nums">{formatMs(r.durationMs)}</td>
                  <td className="pl-4 text-muted">{r.trigger === 'schedule' ? 'schedule' : 'you'}</td>
                  <td className="text-right">
                    {r.total > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => useApp.getState().openIntent('tests', { runId: r.runId })}>
                        Open run
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-muted">No runs yet. {m.enabled ? 'It runs when it is due while TestPion is open, or click Run now.' : 'Resume it, or click Run now.'}</div>
        )}
      </div>
      <p className="text-xs text-muted">
        Monitors run while the app is open. To run them on a server or in CI, use <code>testpion monitor start</code> or <code>testpion monitor run --due</code> from cron.
      </p>
    </div>
  );
}

function formatWait(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${Math.round(h / 24)} d`;
}


function MonitorEditor({ draft, collections, onCancel, onSave }: { draft: MonitorDraft; collections: Collection[]; onCancel(): void; onSave(d: MonitorDraft): Promise<void> }) {
  const environments = useApp((s) => s.workspace?.environments ?? []);
  const unit0 = draft.everyMinutes % 1440 === 0 ? UNITS[2] : draft.everyMinutes % 60 === 0 ? UNITS[1] : UNITS[0];
  const [d, setD] = useState<MonitorDraft>(draft);
  const [every, setEvery] = useState(String(draft.everyMinutes / unit0.f));
  const [unit, setUnit] = useState<string>(unit0.id);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // File ▸ New ▸ Monitor opens the editor before the collections have loaded
  useEffect(() => {
    if (!d.collectionId && collections[0]) setD((x) => ({ ...x, collectionId: collections[0]!.id }));
  }, [collections, d.collectionId]);
  const col = collections.find((c) => c.id === d.collectionId);
  // what the monitor's recent runs measured, to help choose a response time limit
  const [recentP95, setRecentP95] = useState<number[]>([]);
  const monitorId = (draft as { id?: string }).id;
  useEffect(() => {
    if (!monitorId) return;
    void call<MonitorResult[]>('monitor.results', { id: monitorId, limit: 20 }).then(
      (r) => setRecentP95(r.map((x) => x.p95Ms).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)),
      () => setRecentP95([]),
    );
  }, [monitorId]);
  const [realtime, setRealtime] = useState<Array<{ id: string; label: string; depth: number; folder: boolean }>>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(
      (['grpc', 'websocket'] as const).map((kind) =>
        call<Library<unknown>>('lib.get', { kind }).then(
          (lib) => lib.items.filter((i) => i.collectionId === d.collectionId).map((i) => ({ id: i.id, label: `${kind === 'grpc' ? 'gRPC' : 'WebSocket'} · ${i.name}`, depth: 0, folder: false })),
          () => [],
        ),
      ),
    ).then((lists) => live && setRealtime(lists.flat()));
    return () => {
      live = false;
    };
  }, [d.collectionId]);
  const folders = useMemo(() => {
    const out: Array<{ id: string; label: string; depth: number; folder: boolean }> = [];
    const walk = (nodes: CollectionNode[], depth: number) =>
      nodes.forEach((n) => {
        out.push({ id: n.id, label: n.name, depth, folder: n.kind === 'folder' });
        if (n.kind === 'folder') walk(n.items, depth + 1);
      });
    if (col) walk(col.items, 0);
    // then its gRPC calls and connections, which a monitor runs too
    for (const r of realtime) out.push(r);
    return out;
  }, [col, realtime]);
  const minutes = Math.round(Number(every) * (UNITS.find((u) => u.id === unit)?.f ?? 1));
  const submit = async () => {
    setError(undefined);
    if (!d.name.trim()) return setError('Give the monitor a name.');
    if (!(minutes >= 1 && minutes <= 10080)) return setError('A monitor runs every 1 minute to 7 days.');
    setSaving(true);
    try {
      await onSave({ ...d, name: d.name.trim(), everyMinutes: minutes, selection: d.selection?.length ? d.selection : undefined, environment: d.environment || undefined });
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setSaving(false);
    }
  };
  const sel = new Set(d.selection ?? []);
  return (
    <ModalOrPanel
      inline
      title={draft.id ? `Edit monitor · ${draft.name}` : 'New monitor'}
      onClose={onCancel}
      width={560}
      footer={
        <>
          {error && <span className="text-sm text-bad mr-auto">{error}</span>}
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {draft.id ? 'Save' : 'Create monitor'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input autoFocus value={d.name} placeholder="e.g. API health" onChange={(e) => setD({ ...d, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Collection">
            <Select value={d.collectionId} onChange={(e) => setD({ ...d, collectionId: e.target.value, selection: undefined })}>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Environment">
            <Select value={d.environment ?? ''} onChange={(e) => setD({ ...d, environment: e.target.value || undefined })}>
              <option value="">No environment</option>
              {environments.map((e) => (
                <option key={e.id} value={e.name}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Run every" hint="From 1 minute to 7 days. The first run starts as soon as it's saved.">
          <div className="flex gap-2">
            <Input type="number" min={1} className="w-24" value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Interval" />
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
              {UNITS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="What to run" hint={sel.size ? `${sel.size} selected` : 'Nothing selected runs the whole collection.'}>
          <div className="max-h-44 overflow-auto rounded-md border border-line p-1">
            {folders.map((f) => (
              <label key={f.id} className={cx('flex items-center gap-2 pr-2 py-0.5 text-sm hover:bg-hover rounded cursor-pointer', f.folder && 'font-medium')} style={{ paddingLeft: 8 + f.depth * 18 }}>
                <input
                  type="checkbox"
                  checked={sel.has(f.id)}
                  onChange={(e) => {
                    const next = new Set(sel);
                    if (e.target.checked) next.add(f.id);
                    else next.delete(f.id);
                    setD({ ...d, selection: [...next] });
                  }}
                />
                {f.folder && <Folder size={14} className="text-muted shrink-0" />}
                <span className="truncate">{f.label}</span>
              </label>
            ))}
            {!folders.length && <div className="text-sm text-muted p-2">This collection is empty.</div>}
          </div>
        </Field>
        <div className="flex items-center gap-6">
          <Toggle checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Enabled" />
          <Toggle checked={!!d.bail} onChange={(v) => setD({ ...d, bail: v || undefined })} label="Stop at the first failure" />
        </div>
        <Field label="Response time limit (optional)" hint="A run fails when the p95 response time of its requests is over this, even when every check passes (and alerts like any failure).">
          <div className="flex items-center gap-2 max-w-xs">
            <Input type="number" min={1} placeholder="e.g. 800" value={d.maxP95Ms ?? ''} onChange={(e) => setD({ ...d, maxP95Ms: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} aria-label="p95 response time limit in milliseconds" />
            <span className="text-sm text-muted shrink-0">ms (p95)</span>
          </div>
          {recentP95.length > 0 && (
            <p className="text-xs text-muted mt-1">
              The last {recentP95.length === 1 ? 'run' : `${recentP95.length} runs`} measured p95 {recentP95.length === 1 ? formatMs(recentP95[0]!) : `${formatMs(recentP95[Math.floor((recentP95.length - 1) / 2)]!)} (median), ${formatMs(recentP95[recentP95.length - 1]!)} at worst`}.
            </p>
          )}
        </Field>
        <Field label="Certificate warning (optional)" hint="A run fails when the TLS certificate of a host it calls expires within this many days, so you hear about it before clients do.">
          <div className="flex items-center gap-2 max-w-xs">
            <Input type="number" min={1} max={365} placeholder="e.g. 14" value={d.minCertDays ?? ''} onChange={(e) => setD({ ...d, minCertDays: e.target.value ? Math.min(365, Math.max(1, Math.round(Number(e.target.value)))) : undefined })} aria-label="Certificate warning in days" />
            <span className="text-sm text-muted shrink-0">days</span>
          </div>
        </Field>
        <Field label="Alert webhook (optional)" hint="Posted when the monitor starts failing or passes again: a Slack, Teams or Discord incoming webhook, or any URL. {{variables}} of the environment work, so the URL can be a secret.">
          <div className="flex gap-2">
            <Input className="mono flex-1" placeholder="https://hooks.slack.com/services/…  or  {{alertWebhook}}" value={d.webhook ?? ''} onChange={(e) => setD({ ...d, webhook: e.target.value || undefined })} aria-label="Alert webhook" />
            <Button
              disabled={!d.webhook?.trim()}
              onClick={() =>
                void call('monitor.testWebhook', { webhook: d.webhook, environment: d.environment, name: (d as { name?: string }).name }).then(
                  () => useApp.getState().toast('Test alert sent', 'success'),
                  (e) => useApp.getState().toast(asError(e).message, 'error'),
                )
              }
            >
              Send test alert
            </Button>
          </div>
        </Field>
      </div>
    </ModalOrPanel>
  );
}

/** Open monitors as tabs, like the request editors' tabs: middle-click or ✕ closes, right-click for more. */
function MonitorTabs({ tabs, active, busy, extra, onSelect, onClose, onRun, onCancelNew }: { tabs: MonitorRow[]; active?: string; busy: string[]; extra?: string; onSelect(id: string): void; onClose(ids: string[]): void; onRun(m: MonitorRow): void; onCancelNew(): void }) {
  const [menuFor, setMenuFor] = useState<string>();
  if (!tabs.length && !extra) return null;
  const tabClass = (on: boolean) =>
    cx(
      'group relative flex items-center gap-1.5 h-9 px-3 border-r border-line text-sm cursor-pointer shrink-0 w-[190px]',
      on ? 'bg-bg text-fg after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-[image:var(--brand-gradient)]' : 'text-muted hover:bg-hover hover:text-fg',
    );
  return (
    <div role="tablist" aria-label="Open monitors" className="flex items-end h-9 border-b border-line bg-panel/40 shrink-0 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((m) => {
        const running = busy.includes(m.id) || m.running;
        return (
          <div
            key={m.id}
            role="tab"
            aria-selected={m.id === active}
            title={m.name}
            className={tabClass(m.id === active)}
            onClick={() => onSelect(m.id)}
            onAuxClick={(e) => e.button === 1 && onClose([m.id])}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(m.id);
            }}
          >
            <span className={cx('w-2 h-2 rounded-full shrink-0', running ? 'bg-accent animate-pulse' : !m.lastResult ? 'bg-muted/50' : m.lastResult.status === 'passed' ? 'bg-ok' : 'bg-bad')} />
            <span className="truncate flex-1 min-w-0">{m.name}</span>
            <button aria-label={`Close ${m.name}`} className={cx('shrink-0 rounded p-0.5 hover:text-fg hover:bg-hover', m.id === active ? 'opacity-60' : 'opacity-0 group-hover:opacity-100')} onClick={(e) => (e.stopPropagation(), onClose([m.id]))}>
              <X size={12} />
            </button>
            {menuFor === m.id && (
              <Menu
                open
                onOpenChange={(o) => !o && setMenuFor(undefined)}
                align="start"
                width={210}
                trigger={<span aria-hidden className="absolute left-2 bottom-0 w-0 h-0" />}
                items={[
                  { label: 'Run now', icon: <Play size={13} />, disabled: running, onSelect: () => onRun(m) },
                  { label: 'Close tab', icon: <X size={13} />, separator: true, shortcut: 'Middle-click', onSelect: () => onClose([m.id]) },
                  { label: 'Close other tabs', icon: <SquareX size={13} />, disabled: tabs.length < 2, onSelect: () => onClose(tabs.filter((t) => t.id !== m.id).map((t) => t.id)) },
                  { label: 'Close all tabs', icon: <ListX size={13} />, onSelect: () => onClose(tabs.map((t) => t.id)) },
                ]}
              />
            )}
          </div>
        );
      })}
      {extra && (
        <div role="tab" aria-selected className={tabClass(true)}>
          <span className="w-2 h-2 rounded-full shrink-0 bg-muted/50" />
          <span className="truncate flex-1 min-w-0">{extra}</span>
          <button aria-label="Cancel the new monitor" className="shrink-0 rounded p-0.5 opacity-60 hover:text-fg hover:bg-hover" onClick={onCancelNew}>
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
