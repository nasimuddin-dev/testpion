import { BarChart3, Bot, ChevronDown, ChevronRight, CopyPlus, FileCode2, FilePlus2, Folder, History, KeyRound, Layers, Pencil, Play, Save, ShieldCheck, Trash2, Workflow } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { useIntent, useSaveShortcut } from '../hooks';
import { timeAgo } from '../lib/format';
import { StatusIcon } from '../components/Results';
import { CodeEditor } from '../components/CodeEditor';
import { RunMiniBar, RunsOverview, type RunRow } from '../components/RunsOverview';
import { RunPanel } from '../components/RunPanel';
import { ExposeFlowDialog } from '../components/ExposeFlowDialog';
import { SidebarShell } from '../components/SidebarShell';
import { KindBadge, RowMenu, TEST_KINDS, TreeHeader, treeKeys } from '../components/TreeParts';
import { FlowDiagram } from '../components/FlowDiagram';
import { stepLine, type FlowStep } from '@testpion/shared';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { finishSave, type SaveResult } from '../lib/files';
import { dataLanguageOf } from '../data-languages';
import { Badge, Button, cx, Empty, IconButton, Input, rowActionClass, SectionTitle, Spinner, Split, Tabs, type MenuItem } from '../components/ui';

interface Node {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: Node[];
}

const TEMPLATES: Record<string, string> = {
  http: `name: Health check
type: http
method: GET
url: "{{baseUrl}}/health"
assertions:
  - type: status
    expected: 200
  - type: latency
    max: 1000
`,
  graphql: `name: Get patient
type: graphql
endpoint: "{{graphqlEndpoint}}"
query: |
  query GetPatient($id: ID!) {
    patient(id: $id) { id name }
  }
variables:
  id: "123"
assertions:
  - type: graphql-no-errors
  - type: exists
    path: $.data.patient.id
`,
  grpc: `name: Say hello
type: grpc
target: "{{grpcHost}}"          # host:port, or grpcs://host:port for TLS
method: hello.HelloService/SayHello
message: { greeting: TestPion }
protos: []                      # empty: ask the server (reflection)
assertions:
  - type: grpc-status
    expected: OK
`,
  websocket: `name: Echo server replies
type: websocket                  # socketio for Socket.IO, mqtt for MQTT, kafka for Kafka
url: "{{wsUrl}}"
send:
  - hello
  - { type: ping }
waitMs: 1500
assertions:
  - type: equals
    path: $.received[0]
    expected: hello
`,
  mqtt: `name: A command is acknowledged
type: mqtt
url: "{{mqttBroker}}"            # mqtt://, mqtts://, ws:// or wss://
subscribe: [clinic/7/acks]
send:
  - { topic: clinic/7/commands, payload: { action: recheck }, qos: 1 }
waitMs: 1500
assertions:
  - type: equals
    path: $.received[0].topic
    expected: clinic/7/acks
`,
  kafka: `name: An order is confirmed
type: kafka
url: "{{kafkaBrokers}}"          # kafka://host:9092 (several: comma separated; kafkas:// for TLS)
subscribe:
  - { topic: order-confirmations, fromBeginning: false }
send:
  - { topic: orders, key: order-42, value: { id: 42, total: 19.9 }, headers: { source: testpion } }
waitMs: 3000
assertions:
  - type: equals
    path: $.received[0].key
    expected: order-42
`,
  mcp: `name: Search customer tool
type: mcp
server: customer-mcp
tool: search_customer
arguments:
  customer_id: "123"
assertions:
  - type: status
    expected: success
  - type: equals
    path: $.customer.id
    expected: "123"
`,
  llm: `name: Intent classification
type: llm
model:
  provider: mock
  temperature: 0
input:
  message: I need to cancel my appointment
prompt: |
  Classify the customer intent as JSON {"intent": "..."}.
  {{message}}
responseFormat:
  type: json
evaluators:
  - type: json-schema
  - type: exact-match
    path: $.intent
    expected: cancellation
limits:
  latency_ms: 3000
`,
  suite: `name: Regression
tests:
  - rest
  - ai
concurrency: 4
retries: 1
`,
};

export function TestsView() {
  const [tree, setTree] = useState<Node[]>([]);
  // filter the tree by file or folder path (matching folders stay open)
  const [treeFilter, setTreeFilter] = useState('');
  const tf = treeFilter.trim().toLowerCase();
  const filterTree = (nodes: Node[]): Node[] =>
    !tf ? nodes : nodes.flatMap((n) => (n.kind === 'dir' ? ((c) => (c.length ? [{ ...n, children: c }] : []))(filterTree(n.children ?? [])) : n.path.toLowerCase().includes(tf) ? [n] : []));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // every file opens in its own tab (like requests): `file` is the one on screen, the others keep their edits here
  const [file, setFile] = useState<string>();
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const buffers = useRef<Record<string, { content: string; saved: string }>>({});
  const [preview, setPreview] = useState<{ tests: Array<{ id?: string; name: string; type: string; tags?: string[] }>; suite?: { name: string; tests: string[] } } | { error: string }>();
  const [runId, setRunId] = useState<string>();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [tab, setTab] = useState<'editor' | 'run' | 'flow'>('editor');
  // the file whose expose: block (the flow as an MCP tool) is being edited
  const [exposing, setExposing] = useState<string>();
  // the latest result of each test in the previewed file
  const [latest, setLatest] = useState<Record<string, { status: string; runId: string; startedAt: string }>>({});
  useEffect(() => {
    const names = preview && !('error' in preview) && !preview.suite ? preview.tests.map((t) => t.name) : [];
    if (!names.length) return setLatest({});
    void call<typeof latest>('runs.latestResults', { names }).then(setLatest, () => setLatest({}));
  }, [preview]);
  const [opts, setOpts] = useState({ concurrency: 4, retries: 0, grep: '', tags: '' });
  const env = useApp((s) => s.environment);

  const loadTree = useCallback(() => call<Node[]>('tests.tree').then(setTree), []);
  const loadRuns = useCallback(() => call('runs.list', { limit: 50 }).then((r) => setRuns(r.items)), []);
  useEffect(() => {
    void loadTree();
    void loadRuns();
  }, [loadTree, loadRuns]);
  // test files changed outside the app (git pull, another editor): the tree shows them
  useEffect(() => on<{ kinds: string[] }>('workspace.changedOnDisk', (p) => void (p.kinds.includes('tests') && loadTree())), [loadTree]);

  /** Show an open file's tab (the one on screen keeps its edits for when it comes back). */
  const show = (path: string | undefined) => {
    if (file && file !== path && openFilesRef.current.includes(file)) buffers.current[file] = { content, saved };
    const b = path ? buffers.current[path] : undefined;
    setFile(path);
    setContent(b?.content ?? '');
    setSaved(b?.saved ?? '');
    setTab('editor');
    if (path) call('tests.preview', { path }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
    else setPreview(undefined);
  };
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const fileRef = useRef(file);
  fileRef.current = file;
  // the file as a flow (the Flow tab): its steps with the latest run's result of each; a run that finishes recolours it
  const [flow, setFlow] = useState<{ steps: FlowStep[]; run?: { runId: string } } | { error: string }>();
  const [flowSel, setFlowSel] = useState<string>();
  // the result the run panel selects (a node of the flow)
  const [focusResult, setFocusResult] = useState<string>();
  const flowSeq = useRef(0);
  const loadFlow = useCallback((path: string) => {
    const n = ++flowSeq.current;
    call<{ steps: FlowStep[]; run?: { runId: string } }>('tests.flow', { file: path }).then(
      (f) => n === flowSeq.current && setFlow(f),
      (e) => n === flowSeq.current && setFlow({ error: asError(e).message }),
    );
  }, []);
  useEffect(() => {
    setFlow(undefined);
    setFlowSel(undefined);
    if (tab === 'flow' && file) loadFlow(file);
  }, [tab, file, loadFlow]);
  useEffect(() => on<{ runId: string }>('run.finished', () => void (fileRef.current && loadFlow(fileRef.current))), [loadFlow]);
  /** A node of the flow: the editor at the step's `name:` line; its result is selected in the run panel when a run exists. */
  const revealLine = useRef<number | undefined>(undefined);
  const openStep = (s: FlowStep) => {
    setFlowSel(s.id);
    revealLine.current = stepLine(content, s.name) ?? s.line;
    if (flow && !('error' in flow) && flow.run) {
      setRunId(flow.run.runId);
      setFocusResult(s.name);
    }
    setTab('editor');
  };
  const openStepResult = (s: FlowStep) => {
    if (!flow || 'error' in flow || !flow.run) return;
    setRunId(flow.run.runId);
    setFocusResult(s.name);
    setTab('run');
  };
  const openFile = async (path: string) => {
    if (openFilesRef.current.includes(path)) return path === file ? setTab('editor') : show(path);
    const text = await call<string>('tests.read', { path });
    if (file) buffers.current[file] = { content, saved };
    buffers.current[path] = { content: text, saved: text };
    setOpenFiles((o) => (o.includes(path) ? o : [...o, path]));
    openFilesRef.current = [...openFilesRef.current, path];
    show(path);
  };
  /** Close a file's tab (asks first when it has unsaved changes); the next tab comes on screen. */
  const closeFile = async (path: string, ask = true) => {
    // the file on screen now (several closes in a row each change it: the state of this render would be stale)
    const active = fileRef.current;
    const b = path === active ? { content, saved } : buffers.current[path];
    if (ask && b && b.content !== b.saved && !(await confirmAction({ title: 'Unsaved changes', message: `tests/${path} has unsaved changes.`, detail: 'Close it and discard them? Save with Ctrl+S to keep them.', confirmLabel: 'Discard changes', danger: true }))) return;
    const i = openFilesRef.current.indexOf(path);
    const rest = openFilesRef.current.filter((p) => p !== path);
    delete buffers.current[path];
    setOpenFiles(rest);
    openFilesRef.current = rest;
    if (path === active) {
      const next = rest[Math.min(i, rest.length - 1)];
      const nb = next ? buffers.current[next] : undefined;
      fileRef.current = next;
      setFile(next);
      setContent(nb?.content ?? '');
      setSaved(nb?.saved ?? '');
      if (next) call('tests.preview', { path: next }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
      else setPreview(undefined);
    }
  };
  /** A file was renamed or moved: its tab follows. */
  const renameOpen = (from: string, to: string) => {
    if (!openFilesRef.current.includes(from)) return;
    if (buffers.current[from]) buffers.current[to] = buffers.current[from]!;
    delete buffers.current[from];
    const next = openFilesRef.current.map((p) => (p === from ? to : p));
    setOpenFiles(next);
    openFilesRef.current = next;
    if (file === from) setFile(to);
  };
  const save = async () => {
    if (!file) return;
    await call('tests.write', { path: file, content });
    setSaved(content);
    call('tests.preview', { path: file }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
    void loadTree();
  };
  const run = async (paths: string[], name?: string) => {
    if (file && content !== saved) await save();
    try {
      const r = await call<{ runId: string }>('tests.run', {
        paths,
        name,
        environment: env,
        concurrency: opts.concurrency,
        retries: opts.retries,
        grep: opts.grep || undefined,
        tags: opts.tags ? opts.tags.split(',').map((s) => s.trim()) : undefined,
      });
      setRunId(r.runId);
      setTab('run');
      setTimeout(loadRuns, 500);
    } catch (e) {
      toastError(e);
    }
  };
  const newFile = async (kind: string) => {
    const name = await promptText('New test file', { message: 'File path inside tests/ (e.g. rest/health.yaml)', okLabel: 'Create', value: kind === 'suite' ? 'regression.suite.yaml' : `${kind === 'http' ? 'rest' : kind === 'llm' ? 'ai' : kind === 'mqtt' || kind === 'kafka' ? 'websocket' : kind}/new-test.yaml` });
    if (!name) return;
    await call('tests.write', { path: name, content: TEMPLATES[kind] });
    await loadTree();
    await openFile(name);
  };

  useIntent('tests', async (p) => {
    if (p?.path) await openFile(p.path);
    if (p?.runId) {
      setRunId(p.runId);
      setTab('run');
    }
    if (p?.runAll) void run([], 'All tests');
    if (p?.runCurrent && file) void run([file], file);
    if (p?.exportLatest) {
      const latest = runs[0];
      if (latest) void call<SaveResult>('runs.exportReport', { runId: latest.id, format: 'html' }).then((r) => finishSave(r, 'Report'));
      else useApp.getState().toast('No runs to export yet');
    }
  });

  useSaveShortcut('tests', () => void save());

  /** Rename or move a test file (its path inside tests/). */
  const renameFile = async (path: string) => {
    const to = (await promptText('Rename test file', { message: 'File path inside tests/', value: path, okLabel: 'Rename' }))?.trim();
    if (!to || to === path) return;
    try {
      await call('tests.write', { path: to, content: await call<string>('tests.read', { path }) });
      await call('tests.delete', { path });
      renameOpen(path, to);
      await loadTree();
    } catch (e) {
      toastError(e);
    }
  };
  const duplicateFile = async (path: string) => {
    const to = path.replace(/(\.suite)?\.(ya?ml|json)$/i, (m) => ` copy${m}`);
    await call('tests.write', { path: to, content: await call<string>('tests.read', { path }) });
    await loadTree();
  };
  const deletePath = async (n: Node) => {
    const dir = n.kind === 'dir';
    if (!(await confirmAction({ title: dir ? 'Delete folder' : 'Delete test file', message: `Delete tests/${n.path}${dir ? ' and every file in it' : ''}?`, confirmLabel: 'Delete', danger: true }))) return;
    await call('tests.delete', { path: n.path });
    for (const p of openFilesRef.current.filter((p) => p === n.path || p.startsWith(`${n.path}/`))) await closeFile(p, false);
    await loadTree();
  };
  /** Expose as MCP tool…: the dialog writes the file, so the editor's pending edits go first; afterwards the editor shows the file as written. */
  const exposeFile = async (path: string) => {
    if (file === path && content !== saved) await save();
    setExposing(path);
  };
  const exposed = async (path: string) => {
    const text = await call<string>('tests.read', { path });
    if (file === path) {
      setContent(text);
      setSaved(text);
    } else if (buffers.current[path] && buffers.current[path]!.content === buffers.current[path]!.saved) buffers.current[path] = { content: text, saved: text };
    if (file === path) call('tests.preview', { path }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
  };
  const nodeMenu = (n: Node): MenuItem[] =>
    n.kind === 'dir'
      ? [
          { label: 'Run folder', icon: <Play size={14} />, onSelect: () => void run([n.path], n.path) },
          { label: 'Delete folder', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void deletePath(n) },
        ]
      : [
          { label: 'Open', icon: <FileCode2 size={14} />, onSelect: () => void openFile(n.path) },
          ...(/\.(ya?ml|json)$/.test(n.name) ? [{ label: 'Run', icon: <Play size={14} />, onSelect: () => void run([n.path], n.path) }] : []),
          ...(/\.(ya?ml|json)$/.test(n.name) ? [{ label: 'Expose as MCP tool…', icon: <Bot size={14} />, onSelect: () => void exposeFile(n.path) }] : []),
          { label: 'Rename', icon: <Pencil size={14} />, separator: true, onSelect: () => void renameFile(n.path) },
          { label: 'Duplicate', icon: <CopyPlus size={14} />, onSelect: () => void duplicateFile(n.path) },
          { label: 'Delete', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void deletePath(n) },
        ];

  const renderTree = (nodes: Node[], depth = 0): React.ReactNode =>
    nodes.map((n) =>
      n.kind === 'dir' ? (
        <div key={n.path}>
          <TestTreeRow
            depth={depth}
            label={n.name}
            icon={<Folder size={13} className="text-muted shrink-0" />}
            expanded={!!tf || (open[n.path] ?? true)}
            onClick={() => setOpen({ ...open, [n.path]: !(open[n.path] ?? true) })}
            onRun={() => void run([n.path], n.path)}
            menu={nodeMenu(n)}
          />
          {(tf || (open[n.path] ?? true)) && renderTree(n.children ?? [], depth + 1)}
        </div>
      ) : (
        <TestTreeRow
          key={n.path}
          depth={depth}
          label={n.name}
          active={file === n.path}
          icon={<TestFileBadge path={n.path} />}
          onClick={() => void openFile(n.path)}
          onRun={/\.(ya?ml|json)$/.test(n.name) ? () => void run([n.path], n.path) : undefined}
          menu={nodeMenu(n)}
          onRename={() => void renameFile(n.path)}
        />
      ),
    );

  return (
    <>
    <Split id="tests-main" initial={22} min={14}>
      <SidebarShell
        id="tests"
        panes={[
          {
            id: 'tests',
            label: 'Tests',
            icon: <ShieldCheck size={13} />,
            render: () => (
              <>
                <TreeHeader
                  title="Tests"
                  addLabel="New test file"
                  addItems={(
                    [
                      ['http', 'New HTTP test'],
                      ['graphql', 'New GraphQL test'],
                      ['grpc', 'New gRPC test'],
                      ['websocket', 'New WebSocket test'],
                      ['mqtt', 'New MQTT test'],
                      ['kafka', 'New Kafka test'],
                      ['mcp', 'New MCP test'],
                      ['llm', 'New AI test'],
                      ['suite', 'New suite'],
                    ] as const
                  ).map(([kind, label], i) => ({ label, icon: kind === 'suite' ? <Layers size={14} /> : <FilePlus2 size={14} />, separator: i === 7, onSelect: () => void newFile(kind) }))}
                  menu={[{ label: 'Run in CI…', icon: <Workflow size={14} />, onSelect: () => useApp.getState().set({ ci: {} }) }]}
                />
                {tree.length > 0 && (
                  <div className="px-2 pb-2">
                    <Input className="w-full h-7 min-h-7 text-sm" placeholder="Filter test files" aria-label="Filter test files" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} />
                  </div>
                )}
                <div className="flex-1 overflow-auto" onKeyDown={treeKeys}>{tree.length ? (tf && !filterTree(tree).length ? <p className="px-3 py-4 text-sm text-muted text-center">No test files match this filter.</p> : renderTree(filterTree(tree))) : <NoTestFiles onNew={() => void newFile('http')} />}</div>
                <div className="border-t border-line p-2 flex flex-col gap-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-muted">Workers</span>
                      <Input type="number" min={1} value={opts.concurrency} onChange={(e) => setOpts({ ...opts, concurrency: Math.max(1, Number(e.target.value)) })} />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-muted">Retries</span>
                      <Input type="number" min={0} value={opts.retries} onChange={(e) => setOpts({ ...opts, retries: Math.max(0, Number(e.target.value)) })} />
                    </label>
                    <Input className="text-xs" placeholder="grep name" value={opts.grep} onChange={(e) => setOpts({ ...opts, grep: e.target.value })} />
                    <Input className="text-xs" placeholder="tags" value={opts.tags} onChange={(e) => setOpts({ ...opts, tags: e.target.value })} />
                  </div>
                  <Button variant="primary" icon={<Play size={13} />} onClick={() => run([], 'All tests')}>
                    Run all tests
                  </Button>
                </div>
              </>
            ),
          },
          { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
          {
            id: 'runs',
            label: 'Runs',
            icon: <History size={13} />,
            render: () => (
              <div className="flex-1 min-h-0 flex flex-col">
                <RunList
                  runs={runs}
                  active={runId}
                  onSelect={(id) => {
                    setRunId(id);
                    setTab('run');
                  }}
                />
              </div>
            ),
          },
        ]}
      />
      <div className="h-full flex flex-col min-w-0">
        <Tabs<string>
          value={tab === 'run' ? 'run' : tab === 'flow' ? 'flow' : file ? `file:${file}` : 'editor'}
          onChange={(id) => (id === 'run' ? setTab('run') : id === 'flow' ? setTab('flow') : id === 'editor' ? setTab('editor') : show(id.slice(5)))}
          tabs={[
            ...(openFiles.length
              ? openFiles.map((p) => {
                  const dirty = p === file ? content !== saved : buffers.current[p] ? buffers.current[p]!.content !== buffers.current[p]!.saved : false;
                  return {
                    id: `file:${p}`,
                    title: `tests/${p}`,
                    label: (
                      <span className="flex items-center gap-1.5">
                        <TestFileBadge path={p} />
                        {p.split('/').pop()}
                        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-label="unsaved changes" />}
                      </span>
                    ),
                    onClose: () => void closeFile(p),
                  };
                })
              : [{ id: 'editor', label: 'Editor' }]),
            ...(file ? [{ id: 'flow', label: 'Flow' }] : []),
            { id: 'run', label: 'Runs', badge: runs.length },
          ]}
          right={
            tab !== 'run' &&
            file && (
              <>
                <Button size="sm" icon={<Save size={12} />} onClick={save} disabled={content === saved}>
                  Save
                </Button>
                <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => run([file], file)}>
                  Run
                </Button>
                <IconButton
                  label="Delete file"
                  onClick={async () => {
                    if (!(await confirmAction({ title: 'Delete test file', message: `Delete tests/${file}?`, detail: 'This cannot be undone (unless the workspace is in git).', confirmLabel: 'Delete file', danger: true }))) return;
                    await call('tests.delete', { path: file });
                    await closeFile(file, false);
                    void loadTree();
                  }}
                >
                  <Trash2 size={13} />
                </IconButton>
              </>
            )
          }
        />
        <div className="flex-1 min-h-0">
          {tab === 'editor' ? (
            file ? (
              <Split id="tests-editor" initial={65}>
                <CodeEditor
                  language={dataLanguageOf(file)}
                  path={`tests/${file}`}
                  value={content}
                  onChange={setContent}
                  onMount={(ed) => {
                    const l = revealLine.current;
                    if (!l) return;
                    revealLine.current = undefined;
                    ed.revealLineInCenter(l);
                    ed.setPosition({ lineNumber: l, column: 1 });
                    ed.focus();
                  }}
                />
                <div className="h-full overflow-auto text-sm">
                  <SectionTitle>Parsed tests</SectionTitle>
                  {preview && 'error' in preview ? (
                    <div className="px-3 text-bad text-xs">{preview.error}</div>
                  ) : preview?.suite ? (
                    <div className="px-3">
                      <Badge tone="judge">suite</Badge> <b>{preview.suite.name}</b>
                      <ul className="mt-2 list-disc ml-5 text-xs mono">
                        {preview.suite.tests.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    preview?.tests.map((t, i) => (
                      <div key={i} className="px-3 py-1 flex items-center gap-2 border-b border-line/50">
                        <Badge>{t.type}</Badge>
                        <span className="truncate">{t.name}</span>
                        {t.tags?.map((g) => (
                          <Badge key={g} tone="accent">
                            {g}
                          </Badge>
                        ))}
                        {latest[t.name] && (
                          <button
                            className="ml-auto flex items-center gap-1.5 text-xs text-muted hover:text-fg shrink-0"
                            title={`Latest result: ${latest[t.name]!.status} · ${new Date(latest[t.name]!.startedAt).toLocaleString()} (open the run)`}
                            onClick={() => {
                              setRunId(latest[t.name]!.runId);
                              setTab('run');
                            }}
                          >
                            <StatusIcon status={latest[t.name]!.status} />
                            {timeAgo(latest[t.name]!.startedAt)}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                  <p className="p-3 text-xs text-muted">
                    Test files are plain YAML/JSON in the workspace <span className="mono">tests/</span> folder — commit them to git and run them in CI with <span className="mono">testpion test</span>.
                  </p>
                </div>
              </Split>
            ) : (
              <Empty
                icon={<FileCode2 size={28} />}
                title="Select a test file"
                actions={[{ label: 'New test file', icon: <FilePlus2 size={12} />, onClick: () => void newFile('http'), primary: false }]}
              >
                Pick a file on the left to edit it and preview its tests; <b>Run all tests</b> below the list runs every file with the active environment.
              </Empty>
            )
          ) : tab === 'flow' ? (
            !file ? (
              <Empty icon={<Workflow size={28} />} title="Select a test file">
                Open a test file to see its steps as a flow.
              </Empty>
            ) : !flow ? (
              <div className="p-4">
                <Spinner />
              </div>
            ) : 'error' in flow ? (
              <Empty icon={<Workflow size={28} />} title="This file cannot be read as a flow">
                {flow.error}
              </Empty>
            ) : !flow.steps.length ? (
              <Empty icon={<Workflow size={28} />} title="No steps in this file">
                A flow is a test file whose tests chain with <span className="mono">dependsOn</span> and <span className="mono">extract</span>; a suite names other files — open one of them to see its flow.
              </Empty>
            ) : (
              <FlowDiagram steps={flow.steps} selected={flowSel} onSelect={openStep} onOpenResult={flow.run ? openStepResult : undefined} />
            )
          ) : runId ? (
            <Split id="tests-runs" initial={22} min={12}>
              <RunList runs={runs} active={runId} onSelect={setRunId} onOverview={() => setRunId(undefined)} />
              <RunPanel
                key={runId}
                runId={runId}
                focusName={focusResult}
                onRerunFailed={(id) =>
                  void call<{ runId: string }>('tests.rerunFailed', { runId: id, environment: env, concurrency: opts.concurrency, retries: opts.retries }).then(
                    (r) => {
                      setRunId(r.runId);
                      setTimeout(loadRuns, 500);
                    },
                    (e) => toastError(e),
                  )
                }
              />
            </Split>
          ) : (
            <Split id="tests-runs" initial={22} min={12}>
              <RunList runs={runs} active={runId} onSelect={setRunId} />
              <RunsOverview flaky runs={runs} onSelect={setRunId} />
            </Split>
          )}
        </div>
      </div>
    </Split>
    {exposing && <ExposeFlowDialog path={exposing} onClose={() => setExposing(undefined)} onChanged={() => void exposed(exposing).catch(toastError)} />}
    </>
  );
}

function RunList({ runs, active, onSelect, onOverview }: { runs: RunRow[]; active?: string; onSelect(id: string): void; onOverview?(): void }) {
  // filter by name / environment, and only the runs where something failed
  const [query, setQuery] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const q = query.toLowerCase();
  const shown = runs.filter((r) => (!failedOnly || r.failed + r.errors > 0) && (!q || `${r.name} ${r.environment ?? ''}`.toLowerCase().includes(q)));
  return (
    <div className="h-full flex flex-col min-h-0">
      {onOverview && (
        <button className="flex items-center gap-1.5 px-3 py-1.5 border-b border-line text-xs text-accent hover:bg-hover text-left" onClick={onOverview}>
          <BarChart3 size={12} /> Overview of all runs
        </button>
      )}
      {runs.length > 3 && (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line">
          <Input className="h-7 min-h-7 text-sm flex-1 min-w-0" placeholder="Filter runs" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter runs" />
          <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed
          </label>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {shown.map((r) => (
          <button key={r.id} onClick={() => onSelect(r.id)} className={cx('w-full text-left px-3 py-2 border-b border-line/60', active === r.id ? 'bg-accent/10' : 'hover:bg-hover')}>
            <div className="text-sm truncate">{r.name}</div>
            <RunMiniBar r={r} />
            <div className="text-xs text-muted flex gap-2">
              <span className={r.failed + r.errors ? 'text-bad' : 'text-ok'}>
                {r.passed}/{r.total}
              </span>
              {r.environment && <span>{r.environment}</span>}
              <span className="ml-auto">{timeAgo(r.startedAt)}</span>
            </div>
          </button>
        ))}
        {!runs.length && <div className="p-3 text-sm text-muted">No runs yet</div>}
        {runs.length > 0 && !shown.length && <div className="p-3 text-sm text-muted">No runs match</div>}
      </div>
    </div>
  );
}

function TestFileBadge({ path }: { path: string }) {
  if (/\.suite\.ya?ml$/i.test(path)) return <KindBadge text="SUITE" cls="text-judge" />;
  const kind = TEST_KINDS[path.split('/')[0]!.toLowerCase()];
  if (kind && path.includes('/')) return <KindBadge text={kind[0]} cls={kind[1]} />;
  return <KindBadge text={/\.json$/i.test(path) ? 'JSON' : /\.csv$/i.test(path) ? 'CSV' : 'YAML'} cls="text-muted" />;
}

/** A row of the test file tree, like the collection tree's: folder (chevron) or file, ▶ run and ⋯ (also on right-click). */
/** F2 renames a file: its path, in a dialog (a path can move it to another folder, which an in-place name can't). */
function TestTreeRow({ depth, label, icon, expanded, active, onClick, onRun, menu, onRename }: { depth: number; label: string; icon: React.ReactNode; expanded?: boolean; active?: boolean; onClick(): void; onRun?(): void; menu: MenuItem[]; onRename?(): void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cx('group flex items-center gap-0.5 h-8 text-sm rounded-md mx-1 pr-1 transition-colors', active ? 'bg-accent-soft text-fg' : 'hover:bg-hover', menuOpen && !active && 'bg-hover')}
      style={{ paddingLeft: (expanded === undefined ? 22 : 6) + depth * 12 }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'F2' && onRename) {
            e.preventDefault();
            onRename();
          }
        }}
        aria-expanded={expanded}
        data-tree-row
        title={onRename ? 'F2 renames' : undefined}
      >
        {expanded !== undefined && (expanded ? <ChevronDown size={13} className="text-muted shrink-0 -mr-0.5" /> : <ChevronRight size={13} className="text-muted shrink-0 -mr-0.5" />)}
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {onRun && (
        <IconButton label={`Run ${label}`} className={rowActionClass()} onClick={onRun}>
          <Play size={12} />
        </IconButton>
      )}
      <RowMenu label={label} items={menu} open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  );
}

/** The Tests view before any test file: what a test is, and the ways to get one. */
function NoTestFiles({ onNew }: { onNew(): void }) {
  return (
    <Empty
      title="No test files"
      actions={[
        { label: 'New test file', icon: <FilePlus2 size={12} />, onClick: onNew },
        { label: 'Generate from an API definition', icon: <Workflow size={12} />, onClick: () => useApp.getState().openIntent('apidef', {}) },
      ]}
    >
      A test is a YAML file in tests/: a request (HTTP, GraphQL, gRPC, WebSocket, MCP or AI) and its checks, or a whole flow. Create one, generate a first suite from an API definition, or save one from a request tab, the MCP view or AI Lab.
    </Empty>
  );
}

