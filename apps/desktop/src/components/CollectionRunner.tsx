import { Database, FileSpreadsheet, History, ListChecks, Play, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call, on } from '../api';
import { promptText, useApp } from '../store';
import type { Collection, CollectionNode, Library } from '../types';
import { timeAgo, plural } from '../lib/format';
import { RunPanel } from './RunPanel';
import { RunsOverview, type RunRow } from './RunsOverview';
import { hasNativeDialogs, pickTextFile } from '../lib/files';
import { LinkButton, Badge, Button, cx, Empty, Field, Input, Modal, Select, Split, Toggle } from './ui';

interface RunnableRequest {
  id: string;
  name: string;
  method: string;
  path: string[];
  kind: 'http' | 'graphql' | 'grpc' | 'websocket';
}

interface DataFile {
  path: string;
  name: string;
  count: number;
  columns: string[];
  preview: Array<Record<string, unknown>>;
  /** A SQLite database: its tables and the query whose rows are the iterations. */
  tables?: string[];
  query?: string;
}


function flatten(nodes: CollectionNode[], path: string[] = [], scope?: string, inScope = !scope): RunnableRequest[] {
  return nodes.flatMap((n) => {
    if (n.kind === 'folder') return flatten(n.items, [...path, n.name], scope, inScope || n.id === scope);
    if (!inScope && n.id !== scope) return [];
    return [{ id: n.id, name: n.name, method: n.kind === 'http' ? n.request.method : 'GQL', path, kind: n.kind }];
  });
}

function findName(nodes: CollectionNode[], id: string): string | undefined {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    if (n.kind === 'folder') {
      const r = findName(n.items, id);
      if (r) return r;
    }
  }
  return undefined;
}

/**
 * Postman-style Collection Runner: pick requests, iterations, a CSV/JSON data file and a delay, then run
 * them in order. Variables set by scripts carry over between requests; `pm.execution.setNextRequest`
 * changes the order.
 */
export function CollectionRunner({ collection, folderId, onFolderChange }: { collection: Collection; folderId?: string; onFolderChange(id?: string): void }) {
  const envs = useApp((s) => s.workspace?.environments ?? []);
  const activeEnv = useApp((s) => s.environment);
  const [environment, setEnvironment] = useState(activeEnv ?? '');
  // the collection's gRPC calls and connections run after its requests (not in a folder run)
  const [realtime, setRealtime] = useState<RunnableRequest[]>([]);
  useEffect(() => {
    let live = true;
    const kinds = [
      ['grpc', 'gRPC'],
      ['websocket', 'WS'],
    ] as const;
    void Promise.all(kinds.map(([kind]) => call<Library<{ mode?: string }>>('lib.get', { kind }).catch(() => ({ folders: [], items: [] }) as Library<{ mode?: string }>))).then((libs) => {
      if (!live) return;
      setRealtime(
        libs.flatMap((lib, i) =>
          lib.items
            .filter((it) => it.collectionId === collection.id)
            .sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name))
            .map((it) => ({ id: it.id, name: it.name, path: it.folder ? [it.folder] : [], kind: kinds[i]![0], method: kinds[i]![0] === 'websocket' && it.data?.mode === 'kafka' ? 'KAFKA' : kinds[i]![0] === 'websocket' && it.data?.mode === 'mqtt' ? 'MQTT' : kinds[i]![0] === 'websocket' && it.data?.mode === 'socketio' ? 'SIO' : kinds[i]![1] })),
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [collection.id]);
  const requests = useMemo(() => [...flatten(collection.items, [], folderId), ...(folderId ? [] : realtime)], [collection.items, folderId, realtime]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [iterations, setIterations] = useState('');
  const [delay, setDelay] = useState('0');
  const [data, setData] = useState<DataFile>();
  const [dataOpen, setDataOpen] = useState(false);
  const [keepValues, setKeepValues] = useState(true);
  const [bail, setBail] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [starting, setStarting] = useState(false);

  const folders = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [];
    const walk = (nodes: CollectionNode[], depth: number) => {
      for (const n of nodes) if (n.kind === 'folder') (out.push({ id: n.id, label: `${'  '.repeat(depth)}${n.name}` }), walk(n.items, depth + 1));
    };
    walk(collection.items, 0);
    return out;
  }, [collection.items]);

  const loadRuns = useCallback(async () => {
    const r = await call<{ items: RunRow[] }>('runs.list', { query: collection.name, limit: 30 });
    setRuns(r.items.filter((x) => x.name === collection.name || x.name.startsWith(`${collection.name} / `)));
  }, [collection.name]);
  useEffect(() => {
    void loadRuns();
    setRunId(undefined);
    setUnchecked(new Set());
  }, [collection.id, loadRuns]);
  useEffect(() => setUnchecked(new Set()), [folderId]);
  useEffect(() => setEnvironment((e) => e || activeEnv || ''), [activeEnv]);

  const selected = requests.filter((r) => !unchecked.has(r.id));
  const iterCount = Math.max(1, Number(iterations) || data?.count || 1);

  const start = async () => {
    setStarting(true);
    try {
      // an unchanged selection is sent as the folder (or nothing) so the run is named after it
      const selection = selected.length === requests.length ? (folderId ? [folderId] : undefined) : selected.map((r) => r.id);
      const r = await call<{ runId: string }>('col.run', {
        collectionId: collection.id,
        selection,
        environment: environment || undefined,
        iterations: Number(iterations) || undefined,
        dataPath: data?.path,
        dataQuery: data?.tables ? data.query : undefined,
        delayMs: Math.max(0, Number(delay) || 0),
        bail,
        keepVariableValues: keepValues,
      });
      setRunId(r.runId);
      setTimeout(() => void loadRuns(), 500);
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  // the query of a SQLite data file, applied (re-previewed) on Enter or with the button
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(data?.query ?? ''), [data?.path, data?.query]);
  const applyQuery = async (q = query) => {
    if (!data) return;
    try {
      setData(await call<DataFile>('col.previewDataFile', { path: data.path, query: q, environment: environment || undefined }));
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    }
  };

  // data files already in the workspace (datasets/), offered next to the file picker
  const [datasets, setDatasets] = useState<Array<{ path: string; name: string }>>([]);
  useEffect(() => {
    const load = () => void call<Array<{ path: string; name: string }>>('datasets.list').then(setDatasets, () => setDatasets([]));
    load();
    return on<{ kind?: string; method?: string }>('data.changed', (p) => (p?.kind === 'datasets' || p?.method === 'ws.open') && load());
  }, []);

  const pickData = async () => {
    try {
      let d: DataFile | null;
      if (hasNativeDialogs()) d = await call<DataFile | null>('col.pickDataFile');
      else {
        // browser / cloud: upload the file into the workspace
        const f = await pickTextFile('.csv,.json,.jsonl');
        d = f ? await call<DataFile>('col.uploadDataFile', { name: f.name, text: f.text }) : null;
      }
      if (d) {
        setData(d);
        setIterations('');
      }
    } catch (e) {
      useApp.getState().toast(`Could not read the data file: ${asError(e).message}`, 'error');
    }
  };

  return (
    <>
    <Split id="collection-runner" initial={34} min={24}>
      <div className="h-full flex flex-col min-h-0 bg-panel/40">
        <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Run">
              <Select value={folderId ?? ''} onChange={(e) => onFolderChange(e.target.value || undefined)}>
                <option value="">Whole collection</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Environment">
              <Select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                <option value="">No environment</option>
                {envs.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Iterations" hint={data ? `Defaults to ${data.count} (one per data row)` : undefined}>
              <Input type="number" min={1} placeholder={String(data?.count ?? 1)} value={iterations} onChange={(e) => setIterations(e.target.value)} />
            </Field>
            <Field label="Delay (ms)" hint="Pause between requests">
              <Input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} />
            </Field>
          </div>

          <Field label="Data" hint="CSV, JSON, a SQLite database or a PostgreSQL / MySQL database (with a query). Each row becomes one iteration: use {{column}} in requests or pm.iterationData.get('column') in scripts.">
            {data ? (
              <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
                <FileSpreadsheet size={14} className="text-muted shrink-0" />
                <button className="truncate text-accent hover:underline text-left" onClick={() => setDataOpen(true)} title="Preview">
                  {data.name}
                </button>
                <Badge>{plural(data.count, 'row')}</Badge>
                <button aria-label="Remove data file" className="ml-auto text-muted hover:text-fg" onClick={() => setData(undefined)}>
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <Button icon={<FileSpreadsheet size={13} />} onClick={pickData}>
                  Select file
                </Button>
                <Button
                  icon={<Database size={13} />}
                  title="Rows of a PostgreSQL or MySQL query as the iterations"
                  onClick={async () => {
                    const url = await promptText('Database', {
                      message: 'postgres://user:{{dbPassword}}@host:5432/db or mysql://…, with the password in a secret variable; or env:NAME for an environment variable that holds the URL.',
                      placeholder: 'postgres://app:{{dbPassword}}@localhost:5432/shop',
                      okLabel: 'Connect',
                    });
                    if (!url?.trim()) return;
                    try {
                      setData(await call<DataFile>('col.previewDataFile', { path: url.trim(), environment: environment || undefined }));
                      setIterations('');
                    } catch (e) {
                      useApp.getState().toast(asError(e).message, 'error');
                    }
                  }}
                >
                  Database…
                </Button>
                {datasets.length > 0 && (
                  <Select
                    className="h-8 min-h-8 py-0 text-sm max-w-56"
                    aria-label="Use a workspace dataset"
                    value=""
                    onChange={async (e) => {
                      const ds = datasets.find((d) => d.path === e.target.value);
                      if (!ds) return;
                      try {
                        setData(await call<DataFile>('col.previewDataFile', { path: ds.path }));
                        setIterations('');
                      } catch (err) {
                        useApp.getState().toast(`Could not read the data file: ${asError(err).message}`, 'error');
                      }
                    }}
                  >
                    <option value="">or a workspace dataset…</option>
                    {datasets.map((d) => (
                      <option key={d.path} value={d.path}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )}
            {data?.tables && (
              <div className="mt-2 flex flex-col gap-1.5">
                <textarea
                  aria-label="SQL query for the data"
                  className="w-full min-h-16 rounded-md border border-line bg-bg px-2 py-1.5 mono text-xs outline-none focus:border-accent"
                  placeholder="SELECT * FROM users"
                  value={query}
                  spellCheck={false}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void applyQuery();
                    }
                  }}
                />
                <div className="flex items-center gap-1 flex-wrap text-xs">
                  <Button size="sm" onClick={() => void applyQuery()} disabled={query.trim() === (data.query ?? '').trim()}>
                    Apply query
                  </Button>
                  {data.tables.length > 0 && <span className="text-muted ml-1">Tables:</span>}
                  {data.tables.map((t) => (
                    <button key={t} className="mono px-1.5 rounded bg-panel2 hover:text-accent" title={`SELECT * FROM ${t}`} onClick={() => void applyQuery(`SELECT * FROM "${t.replace(/"/g, '""')}"`)}>
                      {t}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted">Read-only: one SELECT (or WITH … SELECT). Ctrl+Enter applies it.</p>
              </div>
            )}
          </Field>

          <div className="flex flex-col gap-2">
            <Toggle checked={keepValues} onChange={setKeepValues} label="Keep variable values" />
            <p className="text-xs text-muted -mt-1 pl-9">Values set with pm.environment.set() etc. are saved as current values after the run.</p>
            <Toggle checked={bail} onChange={setBail} label="Stop on first failure" />
          </div>

          <div className="flex flex-col min-h-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted py-1">
              <ListChecks size={13} />
              Requests
              <Badge>
                {selected.length}/{requests.length}
              </Badge>
              <LinkButton className="ml-auto font-normal" onClick={() => setUnchecked(new Set())}>
                Select all
              </LinkButton>
              <LinkButton className="font-normal" onClick={() => setUnchecked(new Set(requests.map((r) => r.id)))}>
                Deselect all
              </LinkButton>
            </div>
            <div className="rounded-md border border-line divide-y divide-line/60">
              {requests.map((r) => (
                <label key={r.id} className="flex items-center gap-2 px-2 h-7 text-sm cursor-pointer hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={!unchecked.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(unchecked);
                      if (e.target.checked) next.delete(r.id);
                      else next.add(r.id);
                      setUnchecked(next);
                    }}
                  />
                  <span className={cx('mono method-badge text-[0.64rem] font-bold w-10 shrink-0', r.kind === 'http' ? `method-${r.method}` : r.kind === 'grpc' ? 'text-[#2ea99e]' : r.kind === 'websocket' ? 'text-[#d97706]' : 'text-[#e535ab]')}>{r.method.slice(0, 5)}</span>
                  <span className="truncate">{r.name}</span>
                  {r.path.length > 0 && <span className="ml-auto text-xs text-muted truncate max-w-[45%]">{r.path.join(' / ')}</span>}
                </label>
              ))}
              {!requests.length && <div className="p-3 text-sm text-muted">No requests in this {folderId ? 'folder' : 'collection'}.</div>}
            </div>
          </div>
        </div>
        <div className="border-t border-line p-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button variant="primary" className="min-w-0 max-w-full" icon={<Play size={13} />} loading={starting} disabled={!selected.length} onClick={start}>
            <span className="truncate">Run {folderId ? findName(collection.items, folderId) : collection.name}</span>
          </Button>
          <span className="text-xs text-muted whitespace-nowrap">
            {selected.length} request{selected.length === 1 ? '' : 's'} × {iterCount} iteration{iterCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="h-full flex flex-col min-h-0 min-w-0">
        <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm">
          <History size={13} className="text-muted" />
          <Select className="h-7 max-w-80" value={runId ?? ''} onChange={(e) => setRunId(e.target.value || undefined)} aria-label="Previous runs">
            <option value="">{runs.length ? 'Previous runs…' : 'No runs yet'}</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {timeAgo(r.startedAt)} · {r.passed}/{r.total} passed{r.environment ? ` · ${r.environment}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1 min-h-0">
          {runId ? (
            <RunPanel
              key={runId}
              runId={runId}
              expectedTotal={selected.length * iterCount}
              onRerunFailed={(id) =>
                void call<{ runId: string }>('col.rerunFailed', { runId: id, collectionId: collection.id, environment: environment || undefined }).then(
                  (r) => {
                    setRunId(r.runId);
                    setTimeout(() => void loadRuns(), 500);
                  },
                  (e) => useApp.getState().toast(asError(e).message, 'error'),
                )
              }
            />
          ) : runs.length ? (
            // earlier runs of this collection: pass rate and duration, click one to open it
            <RunsOverview runs={runs} onSelect={setRunId} hint="Click a bar or point, or pick a run above, to see its results. Run the collection again with the button on the left." />
          ) : (
            <Empty icon={<Play size={26} />} title="Run this collection">
              Requests run one at a time, in order. Variables set by scripts carry over to later requests, and <span className="mono">pm.execution.setNextRequest()</span> changes the order. Results, traces and reports are saved with the run.
            </Empty>
          )}
        </div>
      </div>
    </Split>

      {dataOpen && data && (
        <Modal title={`${data.name} — ${plural(data.count, 'row')}`} onClose={() => setDataOpen(false)} width={760}>
          <div className="overflow-auto max-h-[60vh]">
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left text-muted">
                  <th className="px-2 py-1">Iteration</th>
                  {data.columns.map((c) => (
                    <th key={c} className="px-2 py-1 mono">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.preview.map((row, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="px-2 py-1 text-muted">{i + 1}</td>
                    {data.columns.map((c) => (
                      <td key={c} className="px-2 py-1 mono truncate max-w-48">
                        {typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {data.count > data.preview.length && <p className="text-xs text-muted p-2">Showing the first {data.preview.length} rows.</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
