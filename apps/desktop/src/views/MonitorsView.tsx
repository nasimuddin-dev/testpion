import { RecentRuns } from '../components/charts';
import { AiAction } from '../components/ai/AiAction';
import { AlarmClock, Folder, KeyRound, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { DocTabStrip } from '../components/DocTabStrip';
import { noteClosedTabs } from '../lib/closed-tabs';
import { LABEL } from '../lib/vocabulary';
import { ItemBreadcrumb } from '../components/ItemBreadcrumb';
import { refMenu } from '../components/RefLink';
import { SidebarShell } from '../components/SidebarShell';
import { MonitorCharts } from '../components/MonitorCharts';
import { MonitorRequests } from '../components/MonitorRequests';
import { FolderList, type FolderListOps } from '../components/FolderList';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import type { MonitorResult } from '../lib/monitor-alerts';
import { useIntent } from '../hooks';
import { toastError, useApp } from '../store';
import { deleteWithUndo } from '../lib/undo-delete';
import { restoreFolder } from '../components/FolderList';
import { openRef } from '../lib/open-ref';
import type { Collection, CollectionNode, Library } from '../types';
import { formatMs, timeAgo } from '../lib/format';
import { Badge, Button, cx, Empty, Field, Input, Metric, MetricGrid, ModalOrPanel, PageHeader, Select, Split, Toggle, Tooltip } from '../components/ui';
import { useCollectionTree } from '../lib/collections-store';
import { useLibrary } from '../lib/library';
import { VarInput } from '../components/VarInput';
import { useExternalChange } from '../lib/external-change';
import { EnvBadge, EnvSelect } from '../components/EnvSelect';
import { OutputActions } from '../components/output/OutputFrame';
import type { OutputSpec } from '../components/output/output-core';
import { outputFileName, COLLECTION_CALL_LIBRARIES } from '@testpion/shared';

/** The tab of a monitor being created (not saved yet, so no id). */
const NEW_TAB = 'new';

interface MonitorDraft {
  id?: string;
  name: string;
  /** The collection it runs ('' when it runs a test file). */
  collectionId: string;
  selection?: string[];
  /** Or a test file / flow under tests/ (the collection is then ''). */
  testFile?: string;
  /** Or a saved RAG evaluation (its id or name): scored, and failed by its gates. */
  evaluation?: string;
  limit?: number;
  gates?: Record<string, number>;
  judgeSample?: number;
  judgeBudgetUsdPerDay?: number;
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
  const collections = useCollectionTree();
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
    const [list, lib] = await Promise.all([call<MonitorRow[]>('monitor.list'), call<Library<unknown>>('lib.get', { kind: 'monitors' }).catch(() => ({ folders: [], items: [] }))]);
    setRows(list);
    setFolders(lib.folders);
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
    // create: { collectionId } (a collection's ▸ Monitor…) or { testFile } (a flow's Deploy ▸ Schedule): the editor opens prefilled
    (p?: { create?: { collectionId?: string; selection?: string[]; testFile?: string }; monitorId?: string }) => {
      if (p?.monitorId) openTab(p.monitorId);
      if (p?.create) {
        const testFile = p.create.testFile || undefined;
        const name = testFile ? testFile.replace(/^.*\//, '').replace(/\.(ya?ml|json)$/i, '') : '';
        setEditing({ name, collectionId: testFile ? '' : (p.create.collectionId ?? ''), selection: testFile ? undefined : p.create.selection, testFile, everyMinutes: 15, enabled: true, environment: useApp.getState().environment });
      }
    },
    'monitors',
  );

  const current = rows.find((m) => m.id === sel);
  const colName = (id: string) => collections.find((c) => c.id === id)?.name ?? 'missing collection';
  /** What a monitor runs, as lists show it: its collection, or tests/<file>. */
  const targetName = (m: MonitorDraft) => (m.testFile ? `tests/${m.testFile}` : colName(m.collectionId));

  const run = async (m: MonitorRow) => {
    setBusy((b) => [...b, m.id]);
    try {
      const r = await call<MonitorResult>('monitor.run', { id: m.id });
      toast(`${m.name}: ${statusLabel(r).toLowerCase()} (${r.passed}/${r.total})`, r.status === 'passed' ? 'success' : 'error');
    } catch (e) {
      toastError(e);
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
      toastError(e);
    }
    await load();
  };
  /** At once, with Undo in the message (the same as the list's Delete). */
  const remove = (m: MonitorRow) => deleteWithUndo({ kind: 'monitor', name: m.name, run: () => monitorOps.deleteItem(m.id), note: 'Its past runs stay in the Tests view' });

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
      toastError(e);
    }
  };
  const monitorOps: FolderListOps = {
    renameItem: (id, name) => update(id, { name }),
    moveItem: (id, folder) => update(id, { folder }),
    deleteItem: async (id) => {
      const m = rows.find((x) => x.id === id);
      await call('monitor.delete', { id });
      await load();
      // the undo saves the monitor again under its id (its settings, folder and schedule); its past runs never went
      return async () => {
        if (!m) return;
        const { lastResult: _r, running: _x, schedule: _s, nextRunAt: _n, due: _d, ...data } = m;
        await call('monitor.save', { monitor: data });
        await load();
      };
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
    deleteFolder: async (name) => {
      const was = new Set<string>();
      let at = -1;
      await editLibrary((lib) => ((at = lib.folders.indexOf(name)), { ...lib, folders: lib.folders.filter((f) => f !== name), items: lib.items.map((i) => (i.folder === name ? (was.add(i.id), { ...i, folder: undefined }) : i)) }));
      return () => editLibrary((lib) => ({ ...lib, folders: restoreFolder(lib.folders, name, at), items: lib.items.map((i) => (was.has(i.id) && !i.folder ? { ...i, folder: name } : i)) }));
    },
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
                kind="monitor"
                title="Monitors"
                itemNoun="monitor"
                addLabel={collections.length ? 'New monitor' : 'Create a collection first'}
                folders={folders}
                selected={editing ? undefined : sel}
                onSelect={openTab}
                onAdd={(folder) => setEditing({ ...newDraft(), ...(folder ? { folder } : {}) })}
                items={rows.map((m) => ({
                  id: m.id,
                  name: m.name,
                  folder: m.folder,
                  icon: <span className={cx('block w-2 h-2 rounded-full', m.running ? 'bg-accent animate-pulse' : !m.lastResult ? 'bg-muted/50' : m.lastResult.status === 'passed' ? 'bg-ok' : 'bg-bad')} />,
                  badge: m.enabled ? <RecentRuns statuses={m.recent ?? []} /> : <Badge>paused</Badge>,
                  subtitle: `${targetName(m)}${m.enabled ? ` · ${m.schedule}` : ''}${m.uptime7d !== undefined ? ` · ${m.uptime7d}% (7 days)` : ''}${m.lastResult ? ` · ${timeAgo(m.lastResult.startedAt)}` : ''}`,
                }))}
                itemActions={(id) => {
                  const m = rows.find((x) => x.id === id)!;
                  return {
                    on: { edit: () => (openTab(id), setEditing(m)), run: () => void run(m), ...(m.enabled ? { pause: () => void toggle(m) } : { resume: () => void toggle(m) }) },
                    disabled: busy.includes(id) || m.running ? { run: 'It is running now' } : {},
                  };
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
        {(openIds.length > 0 || (editing && !editing.id)) && (
          <DocTabStrip<MonitorRow>
            label="Open monitors"
            activeId={editing && !editing.id ? NEW_TAB : sel}
            tabs={[
              ...openIds
                .map((id) => rows.find((m) => m.id === id))
                .filter((m): m is MonitorRow => !!m)
                .map((m) => {
                  const running = busy.includes(m.id) || m.running;
                  return {
                    id: m.id,
                    title: m.name,
                    badge: <span className={cx('w-2 h-2 rounded-full shrink-0', running ? 'bg-accent animate-pulse' : !m.lastResult ? 'bg-muted/50' : m.lastResult.status === 'passed' ? 'bg-ok' : 'bg-bad')} />,
                    rename: 'inline' as const,
                    data: m,
                  };
                }),
              // the monitor being created: its tab closes by cancelling
              ...(editing && !editing.id ? [{ id: NEW_TAB, title: 'New monitor', badge: <span className="w-2 h-2 rounded-full shrink-0 bg-muted/50" /> }] : []),
            ]}
            onSelect={({ id }) => {
              if (id === NEW_TAB) return;
              setEditing(undefined);
              setSel(id);
            }}
            onClose={(ids, closing) => {
              if (ids.includes(NEW_TAB)) setEditing(undefined);
              // a closed monitor's tab can be reopened (Ctrl+Shift+T)
              noteClosedTabs(closing.map((t) => (t.data ? { ref: { kind: 'monitor', monitorId: t.data.id }, label: t.data.name } : undefined)));
              closeTabs(ids.filter((id) => id !== NEW_TAB));
            }}
            onRename={(t, name) => name && name !== t.title && void update(t.id, { name })}
            extraItems={({ id, data: m }) => [{ label: LABEL.runNow, icon: <Play size={13} />, disabled: !m || busy.includes(id) || m.running, onSelect: () => m && void run(m) }]}
          />
        )}
        <div className="flex-1 min-h-0 overflow-auto">
        {/* a monitor is created and edited here, like any item in its editor, not in a dialog */}
        {editing ? (
          <MonitorEditor key={editing.id ?? 'new'} draft={editing} collections={collections} onCancel={() => setEditing(undefined)} onSave={save} />
        ) : current ? (
          <MonitorDetail
            m={current}
            results={resultsById[current.id] ?? []}
            collectionName={targetName(current)}
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
            <Empty title="Select a monitor" actions={[{ label: 'New monitor', icon: <Plus size={13} />, onClick: () => setEditing(newDraft()) }]}>
              Its uptime, response times and runs show here.
            </Empty>
          ) : (
            <Empty
              icon={<AlarmClock size={24} />}
              title="Run collections and flows on a schedule"
              actions={[{ label: 'New monitor', icon: <Plus size={13} />, onClick: () => setEditing({ name: '', collectionId: collections[0]?.id ?? '', everyMinutes: 15, enabled: true, environment: useApp.getState().environment }) }]}
            >
              A monitor runs a collection (or some of its folders) or a test file / flow every few minutes while TestPion is open, and tells you when it starts failing. From the terminal: testpion monitor.
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
  // the monitor's runs as the backend keeps them (the newest 100), not only the page on screen
  const runsSpec = useMemo<OutputSpec>(() => {
    const source = { kind: 'monitor-runs' as const, monitor: m.id, limit: 100 };
    return {
      id: 'monitor.runs',
      what: 'monitor runs',
      name: outputFileName({ name: `monitor-${m.name}`, ext: '' }),
      formats: [
        { format: 'csv', label: 'Runs (CSV)', source, default: true },
        { format: 'json', label: 'Runs (JSON)', source },
      ],
      empty: results.length ? undefined : 'No runs yet',
    };
  }, [m.id, m.name, results.length]);
  const last = results[0];
  const stats = useMemo(() => {
    const done = results.filter((r) => r.status !== 'error' || r.total === 0);
    const passed = results.filter((r) => r.status === 'passed').length;
    const ms = results.map((r) => r.durationMs).sort((a, b) => a - b);
    return { uptime: results.length ? Math.round((passed / results.length) * 1000) / 10 : undefined, median: ms[Math.max(0, Math.ceil(ms.length / 2) - 1)], count: done.length };
  }, [results]);
  const next = m.enabled && m.nextRunAt ? Date.parse(m.nextRunAt) - Date.now() : undefined;
  return (
    <div className="p-4 pt-1 flex flex-col gap-4 max-w-6xl">
      {/* WF-11: the same line as every item view; the large header keeps its actions */}
      <div className="-mx-3">
        <ItemBreadcrumb label="Where this monitor is" crumbs={[{ label: 'Monitors', view: 'monitors' }]} name={m.name} actions={refMenu({ kind: 'monitor', monitorId: m.id })} />
      </div>
      <PageHeader
        icon={<AlarmClock size={18} />}
        title={m.name}
        subtitle={
          <>
            {p.collectionName}
            {p.folderNames.length > 0 && ` › ${p.folderNames.join(', ')}`}
            {' · '}
            <EnvBadge name={m.environment} /> · {m.schedule}
          </>
        }
        actions={
          <>
            <Button size="sm" variant="primary" icon={<Play size={14} />} loading={p.busy} onClick={p.onRun}>
              Run now
            </Button>
            {last && last.status !== 'passed' && (
              <AiAction hint="Ask the AI assistant what is wrong and what to do (the monitor's results, reasons and per-request numbers are sent; no bodies or secrets)" label="Explain with AI" request={async () => ({
                task: 'explain-monitor',
                title: `Why "${m.name}" is failing`,
                context: {
                  monitor: { name: m.name, schedule: m.schedule, environment: m.environment, maxP95Ms: m.maxP95Ms, minCertDays: m.minCertDays },
                  latestResults: results.slice(0, 15).map((r) => ({ when: r.startedAt, status: r.status, passed: r.passed, total: r.total, p95Ms: r.p95Ms, certDaysLeft: r.certDaysLeft, reason: r.reason, error: r.error })),
                  requests: await call('monitor.requests', { id: m.id, runs: 20 }).catch(() => undefined),
                },
              })} />
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

      <div data-output="monitor.runs">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-muted uppercase tracking-wide">Runs</span>
          <OutputActions spec={runsSpec} />
        </div>
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
                      <Button size="sm" variant="ghost" onClick={() => void openRef({ kind: 'run', runId: r.runId })}>
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


/** The test files and suites of the workspace (paths inside tests/), for a monitor that runs one. */
function useTestFiles(): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    type Node = { path: string; kind: 'dir' | 'file'; children?: Node[] };
    const flat = (nodes: Node[]): string[] => nodes.flatMap((n) => (n.kind === 'dir' ? flat(n.children ?? []) : /\.(ya?ml|json)$/i.test(n.path) ? [n.path] : []));
    void call<Node[]>('tests.tree').then((t) => setFiles(flat(t)), () => setFiles([]));
  }, []);
  return files;
}

/** What a monitor's definition is, to tell unsaved edits from a change on disk (its results and status left out). */
function monitorSnapshot(m: Partial<MonitorDraft>): string {
  const x = m as Record<string, unknown>;
  return JSON.stringify(['name', 'folder', 'collectionId', 'selection', 'testFile', 'evaluation', 'limit', 'gates', 'judgeSample', 'judgeBudgetUsdPerDay', 'environment', 'everyMinutes', 'enabled', 'iterations', 'bail', 'webhook', 'maxP95Ms', 'minCertDays'].map((k) => x[k] ?? null));
}

function MonitorEditor({ draft, collections, onCancel, onSave }: { draft: MonitorDraft; collections: Collection[]; onCancel(): void; onSave(d: MonitorDraft): Promise<void> }) {
  const unit0 = draft.everyMinutes % 1440 === 0 ? UNITS[2] : draft.everyMinutes % 60 === 0 ? UNITS[1] : UNITS[0];
  const [d, setD] = useState<MonitorDraft>(draft);
  const [every, setEvery] = useState(String(draft.everyMinutes / unit0.f));
  const [unit, setUnit] = useState<string>(unit0.id);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // what it runs: a collection (and some of its folders) or a test file / flow under tests/
  const [target, setTarget] = useState<'collection' | 'file' | 'evaluation'>(draft.evaluation ? 'evaluation' : draft.testFile ? 'file' : 'collection');
  const testFiles = useTestFiles();
  const evaluations = useLibrary<{ type?: string }>('evaluations');
  const ragEvaluations = evaluations.lib.items.filter((i) => i.data.type === 'rag');
  // the gates as the person writes them: metric=minimum, comma separated (the same names as `testpion rag run --min`)
  const [gatesText, setGatesText] = useState(Object.entries(draft.gates ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
  // the monitor changed on disk (a pull, the CLI, an agent): follow it, or ask when the form has edits (WF-15)
  const unitF = (UNITS.find((u) => u.id === unit) ?? UNITS[0]).f;
  const base = useRef(monitorSnapshot(draft));
  useExternalChange<MonitorDraft>({
    kinds: ['library'],
    items: () => (d.id ? [{ key: d.id, label: d.name || draft.name, base: base.current, dirty: monitorSnapshot({ ...d, everyMinutes: Number(every) * unitF }) !== base.current }] : []),
    read: async (keys) => {
      const m = (await call<MonitorDraft[]>('monitor.list')).find((x) => x.id === keys[0]);
      return new Map(m ? [[keys[0]!, { snapshot: monitorSnapshot(m), value: m }]] : []);
    },
    take: (_id, m, snapshot) => {
      base.current = snapshot;
      const u = m.everyMinutes % 1440 === 0 ? UNITS[2] : m.everyMinutes % 60 === 0 ? UNITS[1] : UNITS[0];
      setD(m);
      setUnit(u.id);
      setEvery(String(m.everyMinutes / u.f));
      setTarget(m.evaluation ? 'evaluation' : m.testFile ? 'file' : 'collection');
      setGatesText(Object.entries(m.gates ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
    },
    keep: (_id, snapshot) => void (base.current = snapshot),
  });
  // File ▸ New ▸ Monitor opens the editor before the collections have loaded
  useEffect(() => {
    if (target === 'collection' && !d.collectionId && collections[0]) setD((x) => ({ ...x, collectionId: collections[0]!.id }));
  }, [collections, d.collectionId, target]);
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
      COLLECTION_CALL_LIBRARIES.map((kind) =>
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
    if (target === 'file' && !d.testFile) return setError('Pick the test file to run.');
    if (target === 'collection' && !d.collectionId) return setError('Pick the collection to run.');
    if (target === 'evaluation' && !d.evaluation) return setError('Pick the RAG evaluation to run.');
    const gates: Record<string, number> = {};
    for (const part of gatesText.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
      const m = /^([\w.@:-]+)\s*[=:]\s*(\d*\.?\d+)$/.exec(part);
      if (!m) return setError(`A gate reads metric=minimum, e.g. faithfulness=0.8 (got "${part}")`);
      gates[m[1]!] = Number(m[2]);
    }
    // one target: the others are cleared
    const none = { evaluation: undefined, limit: undefined, gates: undefined, judgeSample: undefined, judgeBudgetUsdPerDay: undefined };
    const what =
      target === 'evaluation'
        ? { collectionId: '', selection: undefined, testFile: undefined, ...(Object.keys(gates).length ? { gates } : { gates: undefined }) }
        : target === 'file'
          ? { ...none, collectionId: '', selection: undefined, testFile: d.testFile }
          : { ...none, testFile: undefined, selection: d.selection?.length ? d.selection : undefined };
    setSaving(true);
    try {
      await onSave({ ...d, ...what, name: d.name.trim(), everyMinutes: minutes, environment: d.environment || undefined });
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
        <Field label="Runs">
          <Select value={target} onChange={(e) => setTarget(e.target.value as 'collection' | 'file')} aria-label="What the monitor runs">
            <option value="collection">A collection</option>
            <option value="file">A test file or flow</option>
            <option value="evaluation">A RAG evaluation</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {target === 'collection' ? (
            <Field label="Collection">
              <Select value={d.collectionId} onChange={(e) => setD({ ...d, collectionId: e.target.value, selection: undefined })}>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : target === 'evaluation' ? (
            <Field label="RAG evaluation">
              <Select value={d.evaluation ?? ''} onChange={(e) => setD({ ...d, evaluation: e.target.value || undefined })} aria-label="RAG evaluation">
                <option value="">Pick a saved RAG evaluation…</option>
                {ragEvaluations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Test file">
              <Select value={d.testFile ?? ''} onChange={(e) => setD({ ...d, testFile: e.target.value || undefined })} aria-label="Test file">
                <option value="">Pick a file of tests/…</option>
                {[...new Set([...(d.testFile ? [d.testFile] : []), ...testFiles])].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Environment">
            <EnvSelect value={d.environment} onChange={(environment) => setD({ ...d, environment })} />
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
        {target === 'evaluation' && (
          <>
            <Field label="Gates (optional)" hint="The run fails when the mean of a metric is under its minimum: faithfulness=0.8, context-recall=0.7. Without gates a run fails when a sample fails. The reason names the metric.">
              <Input value={gatesText} placeholder="faithfulness=0.8, context-recall=0.7" onChange={(e) => setGatesText(e.target.value)} aria-label="Gates" />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Questions" hint="Only the first n records.">
                <Input type="number" min={1} placeholder="all" value={d.limit ?? ''} onChange={(e) => setD({ ...d, limit: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} aria-label="Number of questions" />
              </Field>
              <Field label="Judged share" hint="0 to 1: the share of samples that get the judged metrics. The free ones always run.">
                <Input type="number" min={0.01} max={1} step={0.05} placeholder="1" value={d.judgeSample ?? ''} onChange={(e) => setD({ ...d, judgeSample: e.target.value ? Math.min(1, Math.max(0.01, Number(e.target.value))) : undefined })} aria-label="Share of samples judged" />
              </Field>
              <Field label="Judge budget / day" hint="USD: judging stops for the day at this much; the rest is n/a.">
                <Input type="number" min={0} step={0.5} placeholder="no cap" value={d.judgeBudgetUsdPerDay ?? ''} onChange={(e) => setD({ ...d, judgeBudgetUsdPerDay: e.target.value ? Math.max(0, Number(e.target.value)) : undefined })} aria-label="Daily judge budget in USD" />
              </Field>
            </div>
          </>
        )}
        {target === 'collection' && (
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
        )}
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
            <VarInput className="flex-1" placeholder="https://hooks.slack.com/services/…  or  {{alertWebhook}}" value={d.webhook ?? ''} onChange={(webhook) => setD({ ...d, webhook: webhook || undefined })} ariaLabel="Alert webhook" />
            <Button
              disabled={!d.webhook?.trim()}
              onClick={() =>
                void call('monitor.testWebhook', { webhook: d.webhook, environment: d.environment, name: (d as { name?: string }).name }).then(
                  () => useApp.getState().toast('Test alert sent', 'success'),
                  (e) => toastError(e),
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
