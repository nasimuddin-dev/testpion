import { useLibraryTabs } from '../lib/library-tabs';
import { AiAction } from '../components/ai/AiAction';
import { LibraryTabStrip } from '../components/LibraryTabStrip';
import { ItemBreadcrumb } from '../components/ItemBreadcrumb';
import { refMenu } from '../components/RefLink';
import { AlertTriangle, Bookmark, Gauge, KeyRound, Play, Save, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, persisted, promptText, toastError, useApp } from '../store';
import type { Collection, CollectionNode, KeyValue, LatencyStats, ProviderConfig } from '../types';
import { formatBytes, formatCost, formatMs, plural } from '../lib/format';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { VarInput } from '../components/VarInput';
import { FolderList } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { useLibrary } from '../lib/library';
import { useIntent } from '../hooks';
import { Badge, Button, Callout, cx, Empty, Field, Input, Metric, MetricGrid, PageHeader, Select, Split, Tabs, Toggle, Textarea } from '../components/ui';
import { ErrorPanel } from '../components/Results';
import { LoadTimeline, StatusCodes } from '../components/LoadCharts';
import { LoadHistory } from '../components/LoadHistory';
import type { NormalizedError } from '../api';
import { useCollectionTree } from '../lib/collections-store';
import { EnvBadge, EnvSelect } from '../components/EnvSelect';

interface Snapshot {
  elapsedSec: number;
  done: boolean;
  activeVUs: number;
  requests: number;
  errors: number;
  connectionFailures: number;
  errorRate: number;
  throughput: number;
  currentRps: number;
  bytes: number;
  latency: LatencyStats;
  statusCodes: Record<string, number>;
  errorKinds: Record<string, number>;
  ai?: { inputTokens: number; outputTokens: number; totalTokens: number; tokensPerSec: number; costUsd?: number; ttft: LatencyStats; interTokenMsAvg?: number; generation: LatencyStats };
  series: Array<{ t: number; rps: number; p95: number; errors: number; vus: number }>;
  perRequest?: Array<{ name: string; requests: number; errors: number; latency: LatencyStats }>;
  iterations?: number;
  /** A flow target: its runs (how many, failed, how long a run took). */
  iteration?: { count: number; failed: number; latency: LatencyStats };
  http?: { ttfb: LatencyStats; newConnections: number; reused: number; setupMs?: number };
}

/** Folders of a collection (with their path), for picking part of it. */
function foldersOf(c: Collection | undefined): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const walk = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes) if (n.kind === 'folder') (out.push({ id: n.id, name: [...path, n.name].join(' / ') }), walk(n.items, [...path, n.name]));
  };
  walk(c?.items ?? [], []);
  return out;
}

const drafts = persisted('load', {
  kind: 'http' as 'http' | 'llm' | 'collection' | 'grpc' | 'flow',
  /** A flow (test file inside tests/): every virtual user runs it whole. */
  testFile: '',
  grpcTarget: 'localhost:50051',
  grpcMethod: '',
  collectionId: '',
  folderId: '',
  warmUp: true,
  thresholds: '',
  method: 'GET',
  url: '{{baseUrl}}/health',
  headers: [] as KeyValue[],
  body: '',
  provider: '',
  model: '',
  prompt: 'Say hello in one short sentence.',
  vus: 10,
  duration: 15,
  rampUp: 3,
  rampDown: 2,
  rps: '' as string | number,
  think: 0,
  allowRemote: false,
});

export function LoadView() {
  // WF-19: open load tests are tabs (each its own draft; a single click in the list opens a preview tab)
  const tabs = useLibraryTabs('load', drafts);
  const d = tabs.d;
  const setD = tabs.setD;
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [id, setId] = useState<string>();
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<NormalizedError>();
  const [tab, setTab] = useState<'headers' | 'body'>('headers');
  // the target picker needs names and folders: the outline (the backend reads the collection itself)
  const allCollections = useCollectionTree();
  const collections = useMemo(() => allCollections.filter((c) => !(c as { problem?: string }).problem), [allCollections]);
  // flow files (tests/, not suites) for the Test file target
  const [testFiles, setTestFiles] = useState<string[]>([]);
  useEffect(() => {
    if (d.kind !== 'flow') return;
    type TreeNode = { kind: string; path: string; children?: TreeNode[] };
    const flat = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.kind === 'dir' ? flat(n.children ?? []) : /\.(ya?ml|json)$/i.test(n.path) && !/\.suite\.(ya?ml|json)$/i.test(n.path) ? [n.path] : []));
    void call<TreeNode[]>('tests.tree').then((t) => setTestFiles(flat(t)), () => setTestFiles([]));
  }, [d.kind]);
  const [preparing, setPreparing] = useState(false);
  const [prep, setPrep] = useState<{ requests: string[]; unresolved: string[]; warmUp?: { passed: number; failed: number } }>();
  // pass/fail rules, checked when the test finishes
  const [checked, setChecked] = useState<Array<{ expr: string; actual?: number; passed: boolean; percent?: boolean }>>();
  const rules = (d.thresholds ?? '').split(/[,\n]/).map((r: string) => r.trim()).filter(Boolean);
  const rulesRef = useRef<string[]>([]);
  rulesRef.current = rules;
  // the environment it runs against: the shared picker (WF-05), the active one until another is picked
  const activeEnv = useApp((s) => s.environment);
  const [environment, setEnvironment] = useState(activeEnv ?? '');
  useEffect(() => setEnvironment((e) => e || activeEnv || ''), [activeEnv]);
  const env = environment || undefined;
  // the environment the run on screen ran against (its header's badge, whatever is picked since)
  const [ranIn, setRanIn] = useState<{ name?: string }>();
  const idRef = useRef<string | undefined>(undefined);
  idRef.current = id;
  const set = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }));
  // saved load tests (library/load-tests.json): run them again whenever needed
  type Draft = typeof d;
  const saved = useLibrary<Draft>('load-tests');
  const savedId = tabs.active.savedId;
  const current = saved.lib.items.find((i) => i.id === savedId);
  const dirty = !!current && JSON.stringify(current.data) !== JSON.stringify(d);
  const [startWhenReady, setStartWhenReady] = useState(false);
  const openSaved = async (savedItem: string, thenRun = false, preview = false) => {
    const it = await saved.find(savedItem);
    if (!it) return;
    tabs.open(savedItem, { ...drafts.load(), ...it.data }, { preview: preview && !thenRun });
    if (thenRun) setStartWhenReady(true);
  };
  // the Collections explorer / search open a saved load test
  useIntent('load', (p) => p?.savedId && void openSaved(p.savedId));
  const saveLoad = async (asNew = false, folder?: string) => {
    if (current && !asNew) {
      await saved.put({ ...current, data: d });
      useApp.getState().toast(`Saved "${current.name}"`, 'success');
      return;
    }
    const target = d.kind === 'http' ? `${d.method} ${d.url}` : d.kind === 'grpc' ? d.grpcMethod : d.kind === 'llm' ? d.model || 'LLM' : d.kind === 'flow' ? d.testFile || 'Test file' : 'Collection';
    const name = await promptText('Save load test', { message: 'Name', value: `${target} · ${d.vus} users`.slice(0, 60), okLabel: 'Save' });
    if (!name) return;
    tabs.setSaved(await saved.put({ name, folder, data: d }));
  };
  useEffect(() => {
    void call<ProviderConfig[]>('ai.providers').then(setProviders);
    const a = on<{ id: string; snapshot: Snapshot }>('load.snapshot', (p) => {
      if (p.id !== idRef.current) return;
      setSnap(p.snapshot);
      if (p.snapshot.done) {
        useApp.getState().setActivity(p.id);
        setId(undefined);
        if (rulesRef.current.length)
          void call<Array<{ expr: string; actual?: number; passed: boolean; percent?: boolean }>>('load.thresholds', { rules: rulesRef.current, snapshot: p.snapshot }).then(setChecked, (e) => toastError(e));
      }
    });
    const b = on<{ id: string; error: NormalizedError }>('load.error', (p) => {
      if (p.id !== idRef.current) return;
      setError(p.error);
      useApp.getState().setActivity(p.id);
      setId(undefined);
    });
    return () => {
      a();
      b();
    };
  }, []);
  const start = async () => {
    setError(undefined);
    setSnap(undefined);
    setChecked(undefined);
    for (const rule of rules) {
      try {
        await call('load.parseThreshold', { rule });
      } catch (e) {
        toastError(e);
        return;
      }
    }
    if (d.allowRemote && !(await confirmAction({ title: 'Load test a remote host', message: 'You are about to generate load against a host that is not on this computer.', detail: 'Only continue if you own this system or are explicitly authorised to load test it.', confirmLabel: 'Start load test', tone: 'warning' }))) return;
    setPrep(undefined);
    const collectionId = d.collectionId || collections[0]?.id;
    if (d.kind === 'collection' && !collectionId) return setError({ kind: 'ValidationError', message: 'There is no collection to load-test' } as NormalizedError);
    const testFile = d.testFile || testFiles[0];
    if (d.kind === 'flow' && !testFile) return setError({ kind: 'ValidationError', message: 'There is no test file to load-test: add a flow under Tests first' } as NormalizedError);
    setPreparing(d.kind === 'collection');
    try {
      const target =
        d.kind === 'grpc'
          ? { kind: 'grpc', request: { target: d.grpcTarget, method: d.grpcMethod, message: d.body || '{}', metadata: d.headers } }
          : d.kind === 'http'
          ? { kind: 'http', request: { method: d.method, url: d.url, headers: d.headers, body: d.body ? { type: /^\s*[{[]/.test(d.body) ? 'json' : 'text', content: d.body } : undefined } }
          : d.kind === 'llm'
            ? { kind: 'llm', model: { provider: d.provider || providers[0]?.id, name: d.model || undefined }, prompt: d.prompt, stream: true }
            : d.kind === 'flow'
              ? { kind: 'flow', file: testFile }
              : { kind: 'sequence', requests: [] };
      const r = await call<{ id: string; requests?: string[]; unresolved?: string[]; warmUp?: { passed: number; failed: number } }>('load.start', {
        environment: env,
        // for the history: which saved load test, and its pass/fail rules
        savedId: current ? savedId : undefined,
        name: current?.name,
        thresholds: rules.length ? rules : undefined,
        collection: d.kind === 'collection' ? { collectionId, selection: d.folderId ? [d.folderId] : undefined, warmUp: d.warmUp } : undefined,
        config: {
          target,
          virtualUsers: d.vus,
          durationSec: d.duration,
          rampUpSec: d.rampUp,
          rampDownSec: d.rampDown,
          requestsPerSecond: d.rps ? Number(d.rps) : undefined,
          thinkTimeMs: d.think || undefined,
          allowRemoteHosts: d.allowRemote,
        },
      });
      setId(r.id);
      setRanIn({ name: env });
      if (r.requests) setPrep({ requests: r.requests, unresolved: r.unresolved ?? [], warmUp: r.warmUp });
      useApp.getState().setActivity(r.id, `Load test: ${d.vus} VUs`);
    } catch (e) {
      setError(asError(e));
    } finally {
      setPreparing(false);
    }
  };
  useEffect(() => {
    if (!startWhenReady) return;
    setStartWhenReady(false);
    if (!id) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWhenReady, d]);
  const collection = collections.find((c) => c.id === (d.collectionId || collections[0]?.id));
  const s = snap;
  return (
    <Split id="load-sidebar" sidebar initial={18} min={12}>
      <SidebarShell
        id="load"
        panes={[
          {
            id: 'saved',
            label: 'Saved',
            icon: <Bookmark size={13} />,
            render: () => (
              <FolderList
                id="load-saved"
                title="Saved load tests"
                itemNoun="load test"
                addLabel="Save current load test"
                folders={saved.lib.folders}
                selected={savedId}
                onSelect={(savedItem) => void openSaved(savedItem, false, true)}
                onOpen={(savedItem) => void openSaved(savedItem)}
                onAdd={(folder) => void saveLoad(true, folder)}
                ops={saved.ops}
                itemMenu={(savedItem) => [{ label: 'Run', icon: <Play size={13} />, disabled: !!id, onSelect: () => void openSaved(savedItem, true) }]}
                items={saved.lib.items.map((i) => {
                  const target = i.data.kind === 'http' ? `${i.data.method} ${i.data.url}` : i.data.kind;
                  return {
                    id: i.id,
                    name: i.name,
                    folder: i.folder,
                    // the default name is the target itself; don't repeat it underneath
                    subtitle: `${i.name.startsWith(target) ? '' : `${target} · `}${i.data.vus} users · ${i.data.duration}s`,
                    icon: <Gauge size={12} className="text-muted" />,
                  };
                })}
                empty={
                  <Empty title="No saved load tests" actions={[{ label: 'Save this load test', icon: <Save size={13} />, onClick: () => void saveLoad(true) }]}>
                    Save a load test (target, users, duration, thresholds) to run it again whenever you need, and group them in folders.
                  </Empty>
                }
              />
            ),
          },
          { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
        ]}
      />
    <div className="h-full flex flex-col min-w-0">
    <LibraryTabStrip
      label="Open load tests"
      library="load-tests"
      tabs={tabs.tabs}
      active={tabs.active.id}
      titleOf={(t) => saved.lib.items.find((i) => i.id === t.savedId)?.name ?? 'New load test'}
      dirty={dirty}
      onSelect={tabs.select}
      onClose={(ids) => tabs.close(ids, drafts.defaults)}
      onKeep={tabs.keep}
      onNew={() => tabs.newTab(drafts.defaults)}
      newLabel="New load test"
    />
    <div className="flex-1 min-h-0">
    <Split id="load-main" initial={34}>
      <div className="h-full overflow-auto p-3 pt-1 flex flex-col gap-3">
        {/* WF-11: Load tests › folder › load test, like every item view; the header keeps Save */}
        <div className="-mx-3">
          <ItemBreadcrumb
            label="Where this load test is"
            crumbs={[{ label: 'Load tests' }, ...(current?.folder ? [{ label: current.folder }] : [])]}
            name={current ? current.name : 'Not saved yet'}
            dirty={dirty}
            actions={current ? refMenu({ kind: 'saved', library: 'load-tests', itemId: current.id }) : undefined}
          />
        </div>
        <PageHeader
          icon={<Gauge size={18} />}
          title={current ? current.name : 'New load test'}
          subtitle={current ? (dirty ? 'Unsaved changes' : 'Saved load test') : 'Not saved yet'}
          actions={
            <Button size="sm" icon={<Save size={12} />} title={current ? `Save changes to "${current.name}"` : 'Save this load test to run it again later'} onClick={() => void saveLoad()}>
              {current && dirty ? 'Save*' : 'Save'}
            </Button>
          }
        />
        <Field label="Target">
          <Select value={d.kind} onChange={(e) => set({ kind: e.target.value as 'http' | 'llm' | 'collection' | 'grpc' | 'flow' })} aria-label="Target">
            <option value="http">HTTP endpoint</option>
            <option value="collection">Collection</option>
            <option value="flow">Test file (a flow)</option>
            <option value="grpc">gRPC method</option>
            <option value="llm">LLM provider</option>
          </Select>
        </Field>
        {d.kind === 'flow' ? (
          <>
            <Field label="Test file">
              <Select aria-label="Test file" value={d.testFile || testFiles[0] || ''} onChange={(e) => set({ testFile: e.target.value })}>
                {testFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-muted">Every virtual user runs the whole flow again and again: its steps with their dependencies, extracts, checks and blocks, its own variables and cookies. The numbers are per step, and per run of the flow.</p>
          </>
        ) : d.kind === 'collection' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Collection">
                <Select value={collection?.id ?? ''} onChange={(e) => set({ collectionId: e.target.value, folderId: '' })}>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Requests">
                <Select value={d.folderId} onChange={(e) => set({ folderId: e.target.value })}>
                  <option value="">The whole collection</option>
                  {foldersOf(collection).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Toggle checked={d.warmUp} onChange={(warmUp) => set({ warmUp })} label="Run it once first with scripts (for example to log in), then use the variables they set" />
            <p className="text-xs text-muted">Every virtual user sends the HTTP and GraphQL requests in order, again and again. Scripts don't run under load; variables are resolved once, before it starts.</p>
          </>
        ) : d.kind === 'http' || d.kind === 'grpc' ? (
          <>
            {d.kind === 'grpc' ? (
              <div className="flex flex-col gap-2">
                <VarInput className="h-8" value={d.grpcTarget} onChange={(grpcTarget) => set({ grpcTarget })} ariaLabel="gRPC server" placeholder="localhost:50051 or grpcs://host:443" />
                <Input className="mono" value={d.grpcMethod} onChange={(e) => set({ grpcMethod: e.target.value })} aria-label="gRPC method" placeholder="package.Service/Method (unary or server streaming)" />
                <p className="text-xs text-muted">The methods come from the server (reflection). Every virtual user calls the method again and again over one connection.</p>
              </div>
            ) : (
              <div className="flex gap-2">
                <Select className="w-24 mono" value={d.method} onChange={(e) => set({ method: e.target.value })}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
                <VarInput className="flex-1 h-8" value={d.url} onChange={(url) => set({ url })} ariaLabel="Target URL" />
              </div>
            )}
            <div className="border border-line rounded-md">
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'headers', label: d.kind === 'grpc' ? 'Metadata' : 'Headers', badge: d.headers.length },
                  { id: 'body', label: d.kind === 'grpc' ? 'Message' : 'Body' },
                ]}
              />
              {tab === 'headers' ? (
                <div className="p-1">
                  <KeyValueEditor rows={d.headers} onChange={(headers) => set({ headers })} />
                </div>
              ) : (
                <textarea className="w-full min-h-24 mono text-xs p-2 bg-transparent outline-none" value={d.body} onChange={(e) => set({ body: e.target.value })} placeholder='{"example": true}' />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Provider">
                <Select value={d.provider} onChange={(e) => set({ provider: e.target.value })}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model">
                <Input className="mono" value={d.model} onChange={(e) => set({ model: e.target.value })} />
              </Field>
            </div>
            <Field label="Prompt">
              <Textarea className="field min-h-20" value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} />
            </Field>
            <p className="text-xs text-warn">LLM load tests consume real tokens and may incur provider costs.</p>
          </>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Virtual users">
            <Input type="number" min={1} value={d.vus} onChange={(e) => set({ vus: Math.max(1, Number(e.target.value)) })} />
          </Field>
          <Field label="Duration (s)">
            <Input type="number" min={1} value={d.duration} onChange={(e) => set({ duration: Math.max(1, Number(e.target.value)) })} />
          </Field>
          <Field label="Max req/sec">
            <Input type="number" value={d.rps} placeholder="unlimited" onChange={(e) => set({ rps: e.target.value })} />
          </Field>
          <Field label="Ramp-up (s)">
            <Input type="number" min={0} value={d.rampUp} onChange={(e) => set({ rampUp: Number(e.target.value) })} />
          </Field>
          <Field label="Ramp-down (s)">
            <Input type="number" min={0} value={d.rampDown} onChange={(e) => set({ rampDown: Number(e.target.value) })} />
          </Field>
          <Field label="Think time (ms)">
            <Input type="number" min={0} value={d.think} onChange={(e) => set({ think: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Environment">
          <EnvSelect value={env} onChange={(name) => setEnvironment(name ?? '')} />
        </Field>
        <Field label="Pass if" hint="Rules checked at the end, comma separated: p95<500, errors<1%, rps>=50, p99[Get pet]<800 (the same as testpion load --threshold)">
          <Input className="mono" value={d.thresholds ?? ''} placeholder="p95<500, errors<1%" onChange={(e) => set({ thresholds: e.target.value })} />
        </Field>
        <Callout tone="warn" block className="rounded-md p-3 text-sm flex flex-col gap-2">
          <div className="flex items-center gap-2 font-medium text-warn">
            <AlertTriangle size={14} /> Safeguards
          </div>
          <p className="text-xs text-muted">By default only localhost and private-network hosts can be targeted; a load test against an environment marked as production asks first, like every send and run.</p>
          <Toggle checked={d.allowRemote} onChange={(allowRemote) => set({ allowRemote })} label="Allow remote hosts (I am authorised to test the target)" />
        </Callout>
        {id ? (
          <Button variant="danger" icon={<Square size={12} />} onClick={() => void call('load.stop', { id }).catch(toastError)}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" icon={<Play size={13} />} loading={preparing} onClick={start}>
            {preparing ? (d.warmUp ? 'Warming up…' : 'Preparing…') : 'Start load test'}
          </Button>
        )}
      </div>
      <div className="h-full overflow-auto">
        {error && <ErrorPanel error={error} />}
        {s ? (
          <div className="p-3 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Badge tone={s.done ? 'ok' : 'accent'}>{s.done ? 'finished' : 'running'}</Badge>
              {ranIn && <EnvBadge name={ranIn.name} className="text-sm" />}
              <span className="text-sm text-muted">
                {s.elapsedSec}s elapsed · {s.activeVUs} active VUs
              </span>
              {s.done && (
                <AiAction variant="ghost" className="ml-auto" label="Analyze with AI" request={() => {
                    const { series, ...summary } = s;
                    return { task: 'analyze-load', title: 'Load test analysis', context: { config: { virtualUsers: d.vus, durationSec: d.duration, rampUpSec: d.rampUp, target: d.kind }, results: summary, lastSeconds: series.slice(-30) } };
                  }}
                />
              )}
            </div>
            {s.done && checked && (
              <Callout tone={checked.every((c) => c.passed) ? 'ok' : 'bad'} block className="rounded-md p-2 text-sm flex flex-wrap items-center gap-2">
                <span className="font-medium">{checked.every((c) => c.passed) ? 'Passed' : 'Failed'}</span>
                {checked.map((c) => (
                  <Badge key={c.expr} tone={c.passed ? 'ok' : 'bad'} title={`actual ${c.actual ?? 'n/a'}${c.percent ? '%' : ''}`}>
                    {c.passed ? '✓' : '✗'} {c.expr} ({c.actual ?? 'n/a'}
                    {c.percent ? '%' : ''})
                  </Badge>
                ))}
              </Callout>
            )}
            <MetricGrid>
              <Metric label="Requests" value={s.requests.toLocaleString()} />
              <Metric label="Throughput" value={`${s.throughput}/s`} />
              <Metric label="Error rate" value={`${(s.errorRate * 100).toFixed(2)}%`} tone={s.errorRate > 0.01 ? 'bad' : 'ok'} sub={`${s.connectionFailures} connection failures`} />
              <Metric label="p50" value={formatMs(s.latency.p50)} />
              <Metric label="p90" value={formatMs(s.latency.p90)} />
              <Metric label="p95" value={formatMs(s.latency.p95)} />
              <Metric label="p99" value={formatMs(s.latency.p99)} />
              <Metric label="Transferred" value={formatBytes(s.bytes)} />
              {s.http && <Metric label="Server time p50 / p95" value={`${formatMs(s.http.ttfb.p50)} / ${formatMs(s.http.ttfb.p95)}`} sub="time to first byte" />}
              {s.http && (
                <Metric
                  label="Connections"
                  value={`${s.http.newConnections.toLocaleString()} new`}
                  sub={`${s.http.reused.toLocaleString()} reused${s.http.setupMs !== undefined ? ` · set-up ${formatMs(s.http.setupMs)} each` : ''}`}
                  tone={s.requests > 50 && s.http.newConnections > s.requests / 2 ? 'warn' : undefined}
                />
              )}
            </MetricGrid>
            {s.ai && (
              <MetricGrid>
                <Metric label="Tokens / sec" value={s.ai.tokensPerSec} />
                <Metric label="Input tokens" value={s.ai.inputTokens.toLocaleString()} />
                <Metric label="Output tokens" value={s.ai.outputTokens.toLocaleString()} />
                <Metric label="TTFT p50 / p95" value={`${formatMs(s.ai.ttft.p50)} / ${formatMs(s.ai.ttft.p95)}`} />
                <Metric label="Between tokens" value={formatMs(s.ai.interTokenMsAvg)} />
                <Metric label="Generation p50" value={formatMs(s.ai.generation.p50)} />
                <Metric label="Est. cost" value={formatCost(s.ai.costUsd)} />
              </MetricGrid>
            )}
            <LoadTimeline series={s.series} />
            <StatusCodes codes={s.statusCodes} />
            {prep && (prep.unresolved.length > 0 || prep.warmUp) && (
              <div className="text-xs text-muted">
                {prep.warmUp && `Warm-up: ${prep.warmUp.passed} passed${prep.warmUp.failed ? `, ${prep.warmUp.failed} failed` : ''}. `}
                {prep.unresolved.length > 0 && <span className="text-warn">Unresolved variables: {prep.unresolved.join(', ')}.</span>}
              </div>
            )}
            {s.perRequest && (
              <div>
                <div className="text-xs text-muted font-semibold mb-1">
                  {s.iteration
                    ? `Per step · ${plural(s.iteration.count, 'run')} of the flow${s.iteration.failed ? `, ${s.iteration.failed} failed` : ''} · p50 ${formatMs(s.iteration.latency.p50)} / p95 ${formatMs(s.iteration.latency.p95)} a run`
                    : `Per request · ${plural(s.iterations ?? 0, 'pass', 'passes')} through the collection`}
                </div>

                <table className="w-full text-sm">
                  <thead className="text-xs text-muted text-left">
                    <tr>
                      <th className="font-medium py-1">Request</th>
                      <th className="font-medium text-right">Requests</th>
                      <th className="font-medium text-right">Errors</th>
                      <th className="font-medium text-right">p50</th>
                      <th className="font-medium text-right">p95</th>
                      <th className="font-medium text-right">p99</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {s.perRequest.map((p) => (
                      <tr key={p.name} className="border-t border-line">
                        <td className="py-1 pr-2">{p.name}</td>
                        <td className="text-right">{p.requests.toLocaleString()}</td>
                        <td className={cx('text-right', p.errors ? 'text-bad' : '')}>{p.errors.toLocaleString()}</td>
                        <td className="text-right">{formatMs(p.latency.p50)}</td>
                        <td className="text-right">{formatMs(p.latency.p95)}</td>
                        <td className="text-right">{formatMs(p.latency.p99)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {s.done && <LoadHistory savedId={current ? savedId : undefined} />}
          </div>
        ) : (
          !error && (
            <div className="flex flex-col gap-4">
              <Empty icon={<Gauge size={28} />} title="Configure and start a load test">
                Reports throughput, p50/p90/p95/p99 latency, error rate, status distribution and — for LLM targets — tokens/sec, time to first token and cost.
              </Empty>
              <div className="px-3">
                <LoadHistory savedId={current ? savedId : undefined} />
              </div>
            </div>
          )
        )}
      </div>
    </Split>
    </div>
    </div>
    </Split>
  );
}
