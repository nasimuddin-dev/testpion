import { Bot, FileCode2, FilePlus2, FileSpreadsheet, History, KeyRound, Layers, Play, Save, ShieldCheck, Workflow } from 'lucide-react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, promptText, toastError, useApp, attempt } from '../store';
import { useIntent, useSaveShortcut } from '../hooks';
import { useExternalChange } from '../lib/external-change';
import { touchesFiles, type DataChangedEvent } from '../lib/data-changed';
import { LABEL } from '../lib/vocabulary';
import { noteClosedTabs } from '../lib/closed-tabs';
import { ItemBreadcrumb, type Crumb } from '../components/ItemBreadcrumb';
import { plural, timeAgo } from '../lib/format';
import { StatusIcon } from '../components/Results';
import { CodeEditor } from '../components/CodeEditor';
import type { OnMount } from '@monaco-editor/react';
import { RunsOverview, type RunRow } from '../components/RunsOverview';
import { RunPanel } from '../components/RunPanel';
import { ExposeFlowDialog } from '../components/ExposeFlowDialog';
import { RunWithDataDialog } from '../components/RunWithDataDialog';
import { ScaleRunPanel } from '../components/FlowScaleGrids';
import { SidebarShell } from '../components/SidebarShell';
import { focusRow, treeKeys } from '../components/TreeParts';
import { TreeRowShell } from '../components/TreeRowShell';
import { useAreaMenu } from '../components/AreaMenu';
import { useTreeOpen } from '../lib/tree-state';
import { deleteWithUndo } from '../lib/undo-delete';
import { openItemMenu } from '../lib/item-menu';
import type { NodeMenuCtx } from '../lib/node-menu';
import { copyText } from '../lib/clipboard';
import { FlowDiagram } from '../components/FlowDiagram';
import { FlowDesigner, type DesignerFlow, type FlowEditAnswer, type FlowRunRequest } from '../components/FlowDesigner';
import { stepLine, type FlowStep } from '@testpion/shared';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { finishSave, type SaveResult } from '../lib/files';
import { saveRunReport } from '../components/output/run-specs';
import { dataLanguageOf } from '../data-languages';
import { Badge, Bar, Button, Empty, FilterInput, IconButton, Input, SectionTitle, Spinner, Split, VirtualList } from '../components/ui';
import { NoOpenItems } from '../components/LibraryTabStrip';
import { DocTabStrip } from '../components/DocTabStrip';
import { RunList } from './TestsRunsList';
import { NoTestFiles, TestFileBadge, TestFileTree, type TestNode, type TestsHost } from './TestsTreeRows';

type Node = TestNode;

/** The node of a path in the tests tree (a file or a folder), or undefined when the tree does not hold it (yet). */
function findNode(nodes: Node[], path: string): Node | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const inside = n.children && path.startsWith(`${n.path}/`) ? findNode(n.children, path) : undefined;
    if (inside) return inside;
  }
  return undefined;
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
  flow: `name: New flow
tests: []
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
  // which folders of the tree are open: the workspace's tree state (lib/tree-state), kept across restarts
  const [open, setOpen] = useTreeOpen('tests');
  // every file opens in its own tab (like requests): `file` is the one on screen, the others keep their edits here
  const [file, setFile] = useState<string>();
  // the live text of the file on screen is not view state (every keystroke would re-render the whole view, tree and
  // tabs included): the editor keeps it, `contentRef` mirrors it, and the view knows only whether it differs from
  // what is saved (`dirty`); `editorValue` is what the view last put into the editor (a file shown, an outside change)
  const contentRef = useRef('');
  const [editorValue, setEditorValue] = useState('');
  const [saved, setSavedState] = useState('');
  const savedRef = useRef('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const isDirty = () => contentRef.current !== savedRef.current;
  const syncDirty = () => {
    const d = isDirty();
    if (d !== dirtyRef.current) {
      dirtyRef.current = d;
      setDirty(d);
    }
  };
  /** The saved text of the file on screen (after a save, after keeping one's own edits over an outside change). */
  const setSaved = (text: string) => {
    savedRef.current = text;
    setSavedState(text);
    syncDirty();
  };
  /** The editor shows this text (a file opened or shown, a change from the designer or from outside): both texts. */
  const showText = (content: string, savedText: string) => {
    contentRef.current = content;
    setEditorValue(content);
    // the same text as the editor was last given, with edits typed since: the editor would keep the edits
    const model = editorRef.current?.getModel();
    if (model && !model.isDisposed() && model.getValue() !== content) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
    setSaved(savedText);
  };
  /** What the editor holds now, for the buffers. */
  const current = () => ({ content: contentRef.current, saved: savedRef.current });
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const buffers = useRef<Record<string, { content: string; saved: string }>>({});
  const [preview, setPreview] = useState<{ tests: Array<{ id?: string; name: string; type: string; tags?: string[] }>; suite?: { name: string; tests: string[] } } | { error: string }>();
  const [runId, setRunId] = useState<string>();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [tab, setTab] = useState<'editor' | 'run' | 'flow'>('editor');
  // the Runs tab is a tab like the files: there once something opened it (a run, Run all tests), closable like them
  const [runsOpen, setRunsOpen] = useState(false);
  useEffect(() => {
    if (tab === 'run') setRunsOpen(true);
  }, [tab]);
  // the file whose expose: block (the flow as an MCP tool) is being edited
  const [exposing, setExposing] = useState<string>();
  // Run with data… / in environments: the dialog's file, and the data run or matrix the Runs tab shows
  const [scaling, setScaling] = useState<{ file: string; initial: 'data' | 'matrix' }>();
  const [scaleId, setScaleId] = useState<string>();
  // a test run picked anywhere replaces it
  useEffect(() => setScaleId(undefined), [runId]);
  /** The dialog runs the file as saved: pending edits are saved first. */
  const openScaling = async (path: string, initial: 'data' | 'matrix') => {
    if (file && isDirty()) await save();
    setScaling({ file: path, initial });
  };
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
  // test files written by anyone — this window (tests.write), an AI agent, a generator, git, another editor: the tree
  // shows them (every write to the workspace's files is a data.changed naming its kinds, lib/data-changed.ts)
  useEffect(() => on<DataChangedEvent>('data.changed', (e) => void (touchesFiles(e, ['tests']) && loadTree())), [loadTree]);

  /** Show an open file's tab (the one on screen keeps its edits for when it comes back). */
  const show = (path: string | undefined) => {
    // the file on screen: only its Editor tab (reloading its buffer would drop what was typed since it was stored)
    if (path && path === file) return setTab('editor');
    // the live text of the file being left is kept, always
    if (file && openFilesRef.current.includes(file)) buffers.current[file] = current();
    const b = path ? buffers.current[path] : undefined;
    setFile(path);
    showText(b?.content ?? '', b?.saved ?? '');
    setTab('editor');
    if (path) call('tests.preview', { path }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
    else setPreview(undefined);
  };
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const fileRef = useRef(file);
  fileRef.current = file;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // the file as a flow (the Flow tab): its steps with the latest run's result of each; a run that finishes recolours it
  const [flow, setFlow] = useState<DesignerFlow | { error: string }>();
  const envRef = useRef<string | undefined>(undefined);
  envRef.current = env;
  const [flowSel, setFlowSel] = useState<string>();
  // the result the run panel selects (a node of the flow)
  const [focusResult, setFocusResult] = useState<string>();
  // a step a link asked for, selected on the designer's canvas (n: each ask, even of the same step)
  const [focusStep, setFocusStep] = useState<{ id: string; n: number }>();
  const flowSeq = useRef(0);
  const loadFlow = useCallback((path: string) => {
    const n = ++flowSeq.current;
    // with each step as written (the designer's inspector) and the variables the environment defines (unresolved marks)
    // the editor's unsaved text, when it has some: the canvas shows what the editor shows (an edit saves it first)
    const live = path === fileRef.current && contentRef.current !== savedRef.current ? { text: contentRef.current } : {};
    call<DesignerFlow>('tests.flow', { file: path, raw: true, environment: envRef.current, ...live }).then(
      (f) => n === flowSeq.current && setFlow(f),
      (e) => n === flowSeq.current && setFlow({ error: asError(e).message }),
    );
  }, []);
  // another file: its own flow (the designer of a file stays mounted across tab switches: view, selection, panels kept)
  useEffect(() => {
    setFlow(undefined);
    setFlowSel(undefined);
  }, [file]);
  useEffect(() => {
    if (tab === 'flow' && file) loadFlow(file);
  }, [tab, file, loadFlow]);
  useEffect(() => on<{ runId: string }>('run.finished', () => void (fileRef.current && loadFlow(fileRef.current))), [loadFlow]);
  /** A node of the flow: the editor at the step's `name:` line; its result is selected in the run panel when a run exists. */
  const revealLine = useRef<number | undefined>(undefined);
  // the one editor of the view (and Monaco, for the open files' models): set when it mounts
  const editorRef = useRef<Parameters<OnMount>[0]>(undefined);
  const monacoRef = useRef<Parameters<OnMount>[1]>(undefined);
  /** The model of an open file (the editor keeps one per file, by its path), if it was shown. */
  const modelOf = (path: string) => {
    const m = monacoRef.current;
    const model = m?.editor.getModel(m.Uri.parse(`tests/${path}`));
    return model && !model.isDisposed() ? model : undefined;
  };
  /** The editor at the line a flow node asked for (openStep), once the Editor tab shows. */
  // each line asked for (openStep): the editor moves there even when the Editor tab already shows the file
  const [revealAsk, setRevealAsk] = useState(0);
  const reveal = () => {
    const ed = editorRef.current;
    const l = revealLine.current;
    if (!ed || !l) return;
    revealLine.current = undefined;
    ed.revealLineInCenter(l);
    ed.setPosition({ lineNumber: l, column: 1 });
    ed.focus();
  };
  // back on the Editor tab (the editor stayed mounted, hidden): its size again, then the line asked for. A child's
  // effects run first, so the editor already shows this file's model (with its cursor, scroll and folding)
  useEffect(() => {
    // every tab closed: the editor went with the last one (a new one mounts for the next file)
    if (!file) editorRef.current = undefined;
    if (tab !== 'editor' || !editorRef.current) return;
    editorRef.current.layout();
    reveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, file, revealAsk]);
  // a closed (or renamed) file's model goes: the editor keeps one per open file
  const modelPaths = useRef<string[]>([]);
  useEffect(() => {
    for (const p of modelPaths.current) {
      if (openFiles.includes(p)) continue;
      const model = modelOf(p);
      if (model && model !== editorRef.current?.getModel()) model.dispose();
    }
    modelPaths.current = openFiles;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles]);
  const openStep = (s: FlowStep) => {
    setFlowSel(s.id);
    revealLine.current = stepLine(contentRef.current, s.name) ?? s.line;
    setRevealAsk((n) => n + 1);
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
    if (file) buffers.current[file] = current();
    buffers.current[path] = { content: text, saved: text };
    setOpenFiles((o) => (o.includes(path) ? o : [...o, path]));
    openFilesRef.current = [...openFilesRef.current, path];
    show(path);
  };
  /** Close a file's tab (asks first when it has unsaved changes); the next tab comes on screen. */
  const closeFile = async (path: string, ask = true) => {
    // the file on screen now (several closes in a row each change it: the state of this render would be stale)
    const active = fileRef.current;
    const b = path === active ? current() : buffers.current[path];
    if (ask && b && b.content !== b.saved && !(await confirmAction({ title: 'Unsaved changes', message: `tests/${path} has unsaved changes.`, detail: 'Close it and discard them? Save with Ctrl+S to keep them.', confirmLabel: 'Discard changes', danger: true }))) return;
    // Ctrl+Shift+T opens it again
    noteClosedTabs([{ ref: { kind: 'test', path }, label: path.split('/').pop() ?? path }]);
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
      showText(nb?.content ?? '', nb?.saved ?? '');
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
    const content = contentRef.current;
    await call('tests.write', { path: file, content });
    setSaved(content);
    call('tests.preview', { path: file }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
    void loadTree();
  };
  /**
   * Run files; the flow designer runs its file (or part of it, a replay, a debug run: `flow`, through tests.flowRun with
   * the file's pins) and stays on the Flow tab (`stay`).
   */
  const run = async (paths: string[], name?: string, o: { ids?: string[]; stay?: boolean; flow?: FlowRunRequest } = {}): Promise<string | undefined> => {
    if (file && isDirty()) await save();
    try {
      const r = o.flow
        ? await call<{ runId: string }>('tests.flowRun', { file: paths[0], environment: env, concurrency: opts.concurrency, retries: opts.retries, ...o.flow })
        : await call<{ runId: string }>('tests.run', {
            paths,
            name,
            environment: env,
            concurrency: opts.concurrency,
            retries: opts.retries,
            // the designer runs what it shows: the sidebar's name and tag filters are for the tree's runs
            grep: o.stay ? undefined : opts.grep || undefined,
            tags: o.stay ? undefined : opts.tags ? opts.tags.split(',').map((s) => s.trim()) : undefined,
            ids: o.ids,
          });
      setRunId(r.runId);
      if (!o.stay) setTab('run');
      setTimeout(loadRuns, 500);
      return r.runId;
    } catch (e) {
      toastError(e);
      return undefined;
    }
  };
  /** The flow designer saved an edit: the editor, the parsed tests and the flow show the new text. */
  const flowEdited = (r: FlowEditAnswer) => {
    // the tab's buffer too: showing the file's tab again reads it
    if (buffers.current[r.file]) buffers.current[r.file] = { content: r.text, saved: r.text };
    // a file not on screen keeps its model (and its undo) for when it comes back: the edit goes into it as one undo step
    // (the file on screen gets it through its value, the same way)
    const model = fileRef.current === r.file ? undefined : modelOf(r.file);
    if (model && model.getValue() !== r.text) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: r.text }], () => null);
    if (fileRef.current === r.file) {
      showText(r.text, r.text);
      setFlow(r.flow);
      call('tests.preview', { path: r.file }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
    }
  };
  const newFile = async (kind: string, folder?: string) => {
    const suggested = kind === 'suite' ? 'regression.suite.yaml' : kind === 'flow' ? 'rest/new-flow.yaml' : `${kind === 'http' ? 'rest' : kind === 'llm' ? 'ai' : kind === 'mqtt' || kind === 'kafka' ? 'websocket' : kind}/new-test.yaml`;
    const name = await promptText('New test file', { message: 'File path inside tests/ (e.g. rest/health.yaml)', okLabel: 'Create', value: folder ? `${folder}/${suggested.split('/').pop()}` : suggested });
    if (!name) return;
    await call('tests.write', { path: name, content: TEMPLATES[kind] });
    await loadTree();
    await openFile(name);
    // a new flow opens in the designer
    if (kind === 'flow') setTab('flow');
  };

  useIntent('tests', async (p) => {
    // a test named only by its id (a flaky test, an attention item, a test-case link): its file and step first
    let path: string | undefined = p?.path;
    let step: string | undefined = p?.step;
    if (!path && p?.testId) {
      const at = await call<{ path: string; id: string } | null>('tests.locate', { testId: p.testId }).catch(() => null);
      if (at) ({ path, id: step } = at);
      else useApp.getState().toast(`No test "${p.testId}" in tests/ any more (renamed or deleted)`, 'warning');
    }
    // a flow made elsewhere (recorded in the Debugger): the tree lists it, the designer opens it
    if (path && p?.flow) await loadTree();
    if (path) await openFile(path);
    if (path && p?.flow) setTab('flow');
    // a step of the file: selected on the canvas (a flow), else the editor at its line
    if (path && step) {
      const f = await call<{ steps: FlowStep[] }>('tests.flow', { file: path }).catch(() => undefined);
      const s = f?.steps.find((x) => x.id === step || x.name === step);
      if (s && p?.flow) setFocusStep({ id: s.id, n: Date.now() });
      else if (s) openStep(s);
    }
    // a line of the file (a problem, a search hit): the editor at it; the step it is in is selected on the canvas too
    const line = Number(p?.line);
    if (path && !step && line > 0) {
      revealLine.current = line;
      setRevealAsk((n) => n + 1);
      setTab('editor');
      const f = await call<{ steps: FlowStep[] }>('tests.flow', { file: path }).catch(() => undefined);
      const s = (f?.steps ?? []).filter((x) => x.line !== undefined && x.line <= line).sort((a, b) => b.line! - a.line!)[0];
      if (s) {
        setFlowSel(s.id);
        setFocusStep({ id: s.id, n: Date.now() });
      }
    }
    if (p?.runId) {
      setRunId(p.runId);
      // one result of the run (by its test's id)
      if (p.resultId) setFocusResult(p.resultId);
      setTab('run');
    }
    if (p?.runAll) void run([], 'All tests');
    if (p?.runCurrent && file) void run([file], file);
    if (p?.exportLatest) {
      const latest = runs[0];
      if (latest) void saveRunReport({ id: latest.id, name: latest.name });
      else useApp.getState().toast('No runs to export yet');
    }
  });

  useSaveShortcut('tests', () => void save());

  /** Rerun failed (the run panel's button, a run's menu): only the tests that failed or errored, as a new run. */
  const rerunFailed = (id: string) =>
    void call<{ runId: string }>('tests.rerunFailed', { runId: id, environment: env, concurrency: opts.concurrency, retries: opts.retries }).then(
      (r) => {
        setRunId(r.runId);
        setTab('run');
        setTimeout(loadRuns, 500);
      },
      (e) => toastError(e),
    );

  // open test files follow their file on disk (WF-15): a pull, a branch switch, another window or the CLI changed it.
  // Without unsaved edits the editor (and the Flow tab) shows the new version; with them, Keep mine / Take the new version.
  useExternalChange<string>({
    kinds: ['tests'],
    items: () =>
      openFilesRef.current.map((p) => {
        const b = p === fileRef.current ? { content: contentRef.current, saved: savedRef.current } : buffers.current[p];
        return { key: p, label: `tests/${p}`, base: b?.saved, dirty: !!b && b.content !== b.saved };
      }),
    read: async (keys) => {
      const out = new Map<string, { snapshot: string; value: string }>();
      for (const k of keys) {
        const text = await call<string>('tests.read', { path: k }).catch(() => undefined);
        if (text !== undefined) out.set(k, { snapshot: text, value: text });
      }
      return out;
    },
    take: (key, text) => {
      if (key === fileRef.current) {
        showText(text, text);
        if (tabRef.current === 'flow') loadFlow(key);
        call('tests.preview', { path: key }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
      } else buffers.current[key] = { content: text, saved: text };
    },
    keep: (key, snapshot) => {
      if (key === fileRef.current) setSaved(snapshot);
      else if (buffers.current[key]) buffers.current[key] = { ...buffers.current[key]!, saved: snapshot };
    },
  });

  /** Move a test file to another path inside tests/ (a rename, or a move to another folder); its tab follows. */
  const movePath = async (path: string, to: string) => {
    await attempt(async () => {
      await call('tests.write', { path: to, content: await call<string>('tests.read', { path }) });
      await call('tests.delete', { path });
      renameOpen(path, to);
      await loadTree();
    });
  };
  /** Rename or move a test file from its tab (its path inside tests/: a path can move it, which a name can't). */
  const renameFile = async (path: string) => {
    const to = (await promptText('Rename test file', { message: 'File path inside tests/', value: path, okLabel: 'Rename' }))?.trim();
    if (to && to !== path) await movePath(path, to);
  };
  /** The test file being renamed in place in the tree (F2, or Rename in its menu). */
  const [renamingPath, setRenamingPath] = useState<string>();
  const finishRename = async (n: Node, name?: string) => {
    setRenamingPath(undefined);
    const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/') + 1) : '';
    const to = name?.trim().replace(/^\/+/, '');
    if (to && to !== n.name) {
      await movePath(n.path, `${dir}${to}`);
      focusRow(`tests:${dir}${to}`);
    } else focusRow(`tests:${n.path}`);
  };
  const duplicateFile = async (path: string) => {
    const to = path.replace(/(\.suite)?\.(ya?ml|json)$/i, (m) => ` copy${m}`);
    await call('tests.write', { path: to, content: await call<string>('tests.read', { path }) });
    await loadTree();
  };
  /**
   * Delete a test file or a folder at once, with Undo (the files' text is kept until the message goes); a folder of more
   * files than an undo should hold asks first instead.
   */
  const deletePath = async (n: Node) => {
    const dir = n.kind === 'dir';
    const files: string[] = [];
    const walk = (x: Node) => (x.kind === 'file' ? files.push(x.path) : (x.children ?? []).forEach(walk));
    walk(n);
    if (files.length > 200 && !(await confirmAction({ title: 'Delete the folder', message: `Delete tests/${n.path} and the ${files.length} files in it? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    let kept: Array<{ path: string; content: string }> = [];
    await deleteWithUndo({
      kind: dir ? 'folder' : 'test',
      name: n.path,
      note: dir ? `${plural(files.length, 'file')} went with it` : undefined,
      focus: dir ? `tests:dir:${n.path}` : `tests:${n.path}`,
      run: async () => {
        kept = files.length <= 200 ? await Promise.all(files.map(async (path) => ({ path, content: await call<string>('tests.read', { path }) }))) : [];
        await call('tests.delete', { path: n.path });
        for (const p of openFilesRef.current.filter((p) => p === n.path || p.startsWith(`${n.path}/`))) await closeFile(p, false);
        await loadTree();
      },
      undo:
        files.length <= 200
        ? async () => {
            for (const f of kept) await call('tests.write', f);
            await loadTree();
          }
        : undefined,
    });
  };
  /** Expose as MCP tool…: the dialog writes the file, so the editor's pending edits go first; afterwards the editor shows the file as written. */
  const exposeFile = async (path: string) => {
    if (file === path && isDirty()) await save();
    setExposing(path);
  };
  const exposed = async (path: string) => {
    const text = await call<string>('tests.read', { path });
    if (file === path) showText(text, text);
    else if (buffers.current[path] && buffers.current[path]!.content === buffers.current[path]!.saved) buffers.current[path] = { content: text, saved: text };
    if (file === path) call('tests.preview', { path }).then(setPreview, (e) => setPreview({ error: asError(e).message }));
    // the designer's Start node and Deploy panel show what the file is exposed as
    if (file === path && tab === 'flow') loadFlow(path);
  };
  /** Export as Arazzo…: the flow as an Arazzo 1.0 workflow, saved with a dialog (or downloaded); what did not fit is said in a toast. */
  const exportArazzo = async (path: string) => {
    await attempt(async () => {
      const r = await call<{ notes: string[]; saved: SaveResult }>('tests.exportArazzo', { path, save: true });
      finishSave(r.saved, 'Arazzo workflow');
      if ((r.saved?.path || r.saved?.download) && r.notes.length) useApp.getState().toast(`Arazzo: ${r.notes.slice(0, 3).join('; ')}${r.notes.length > 3 ? ` (+${r.notes.length - 3} more)` : ''}`, 'warning');
    });
  };
  /** Every folder path under (and including) a folder of the tree: its Expand all and Collapse all. */
  const dirsUnder = (n: Node): string[] => (n.kind === 'dir' ? [n.path, ...(n.children ?? []).flatMap(dirsUnder)] : []);
  const setDirs = (paths: string[], to: boolean) => setOpen((o) => ({ ...o, ...Object.fromEntries(paths.map((p) => [p, to])) }));
  const isTestFile = (name: string) => /\.(ya?ml|json)$/.test(name);
  /** A test file's menu (lib/node-menu.ts builds it: the same groups as every other row). */
  const fileMenu = (n: Node): NodeMenuCtx => {
    const test = isTestFile(n.name);
    const suite = /\.suite\./.test(n.name);
    return {
      ref: { kind: 'test', path: n.path },
      name: n.name,
      on: {
        open: () => void openFile(n.path),
        revealFile: () => void call('workspace.revealFile', { path: `tests/${n.path}` }).catch(toastError),
        ...(test ? { run: () => void run([n.path], n.path) } : {}),
        ...(test && !suite ? { runWithData: () => void openScaling(n.path, 'data'), runInEnvironments: () => void openScaling(n.path, 'matrix'), exportArazzo: () => void exportArazzo(n.path) } : {}),
        copyPath: () => void copyText(`tests/${n.path}`, 'the path'),
        ...(test ? { copyCli: () => void copyText(`testpion test "tests/${n.path}"`, 'the command') } : {}),
        ...(test ? { monitor: () => useApp.getState().openIntent('monitors', { create: { testFile: n.path } }), ci: () => useApp.getState().set({ ci: { tests: [n.path] } }), exposeMcp: () => void exposeFile(n.path) } : {}),
        rename: () => setRenamingPath(n.path),
        duplicate: () => void duplicateFile(n.path),
        delete: () => void deletePath(n),
      },
    };
  };
  /** Rename or move a folder of test files (its path inside tests/): every file goes to the new path; never onto another folder. */
  const renameFolder = async (n: Node) => {
    const to = (await promptText('Rename folder', { message: 'Folder path inside tests/', value: n.path, okLabel: 'Rename' }))?.trim().replace(/^\/+|\/+$/g, '');
    if (!to || to === n.path) return;
    const taken = (nodes: Node[]): boolean => nodes.some((x) => x.path === to || taken(x.children ?? []));
    if (taken(tree)) return void useApp.getState().toast(`tests/${to} exists already`, 'warning');
    const files: string[] = [];
    const walk = (x: Node) => (x.kind === 'file' ? files.push(x.path) : (x.children ?? []).forEach(walk));
    walk(n);
    await attempt(async () => {
      // the files first, then the old folder: a failure in between leaves a copy, never a loss
      for (const p of files) await call('tests.write', { path: `${to}${p.slice(n.path.length)}`, content: await call<string>('tests.read', { path: p }) });
      await call('tests.delete', { path: n.path });
      for (const p of files) renameOpen(p, `${to}${p.slice(n.path.length)}`);
      setOpen((o) => ({ ...o, [to]: o[n.path] ?? true }));
      await loadTree();
    });
  };
  /** A folder's menu: new test file here, expand or collapse it, run it, run it in CI, rename it, delete it (Undo). */
  const folderMenu = (n: Node): NodeMenuCtx => ({
    name: n.name,
    folder: n.path,
    create: [{ label: 'New test file here', icon: <FilePlus2 size={14} />, onSelect: () => void newFile('http', n.path) }],
    on: {
      expandAll: () => setDirs(dirsUnder(n), true),
      collapseAll: () => setDirs(dirsUnder(n), false),
      run: () => void run([n.path], n.path),
      ci: () => useApp.getState().set({ ci: { tests: [n.path] } }),
      rename: () => void renameFolder(n),
      delete: () => void deletePath(n),
    },
  });
  /** The tree's header (and its blank area): every kind of new test file, expand or collapse everything, Run in CI. */
  const testsMenu = (): NodeMenuCtx => ({
    create: (
      [
        ['http', 'New HTTP test'],
        ['graphql', 'New GraphQL test'],
        ['grpc', 'New gRPC test'],
        ['websocket', 'New WebSocket test'],
        ['mqtt', 'New MQTT test'],
        ['kafka', 'New Kafka test'],
        ['mcp', 'New MCP test'],
        ['llm', 'New AI test'],
        ['flow', 'New flow (designer)'],
        ['suite', 'New suite'],
      ] as const
    ).map(([kind, label]) => ({ label, icon: kind === 'suite' ? <Layers size={14} /> : kind === 'flow' ? <Workflow size={14} /> : <FilePlus2 size={14} />, onSelect: () => void newFile(kind) })),
    on: {
      expandAll: () => setDirs(tree.flatMap(dirsUnder), true),
      collapseAll: () => setDirs(tree.flatMap(dirsUnder), false),
      ci: () => useApp.getState().set({ ci: {} }),
    },
  });
  const testsArea = useAreaMenu('section:test', testsMenu, 'Tests');
  // what the tree's rows call, through one ref that is always current (the tree and its rows are memoized)
  const host = useRef<TestsHost>(null!);
  host.current = {
    openFile: (path) => void openFile(path),
    run: (paths, name) => void run(paths, name),
    toggle: (path) => setOpen((o) => ({ ...o, [path]: !(o[path] ?? true) })),
    fileMenu,
    folderMenu,
    isTestFile,
    finishRename: (n, name) => void finishRename(n, name),
  };

  return (
    <>
    <Split id="tests-main" initial={22} min={14}>
      <SidebarShell
        id="tests"
        // the Runs pane opens the Runs tab (the overview): the runs are reachable before any run is picked
        onChange={(p) => p === 'runs' && setTab('run')}
        panes={[
          {
            id: 'tests',
            label: 'Tests',
            icon: <ShieldCheck size={13} />,
            render: () => (
              <>
                {/* the keyboard moves through the header and the tree as one list (↑ from the first file reaches the header) */}
                <div className="flex-1 min-h-0 flex flex-col" onKeyDown={treeKeys}>
                <TreeRowShell kind="section:test" nodeId="tests:section" label="Tests" header ctx={testsMenu} className="mx-0 pl-3 shrink-0">
                  <span className="text-xs font-semibold truncate">Tests</span>
                </TreeRowShell>
                {tree.length > 0 && (
                  <div className="px-2 pb-2">
                    <FilterInput className="w-full" placeholder="Filter test files" label="Filter test files" value={treeFilter} onChange={setTreeFilter} />
                  </div>
                )}
                {testsArea.menu}
                <div className="flex-1 overflow-auto" onContextMenu={testsArea.onContextMenu}>
                  {tree.length ? <TestFileTree tree={tree} filter={tf} open={open} file={file} renaming={renamingPath} host={host} /> : <NoTestFiles onNew={() => void newFile('http')} />}
                  {/* a blank strip after the last file, always there to right-click (the tree's menu), as in the explorer */}
                  <div className="min-h-16" aria-hidden />
                </div>
                </div>
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
                  <Button variant="primary" icon={<Play size={13} />} onClick={() => run([], 'All tests')} data-tour="run-all">
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
                  onRerunFailed={rerunFailed}
                  onRunAll={() => void run([], 'All tests')}
                />
              </div>
            ),
          },
        ]}
      />
      <div className="h-full flex flex-col min-w-0">
        {!openFiles.length && !runsOpen ? (
          <NoOpenItems icon={FileCode2} title="No open test files" newLabel="New test file" onNew={() => void newFile('http')}>
            Pick a file on the left to edit it and preview its tests; <b>Run all tests</b> below the list runs every file with the active environment.
          </NoOpenItems>
        ) : (
        <DocTabStrip<string>
          label="Open test files"
          activeId={tab === 'run' ? 'run' : tab === 'flow' ? 'flow' : `file:${file}`}
          onSelect={({ id }) => (id === 'run' ? setTab('run') : id === 'flow' ? setTab('flow') : show(id.slice(5)))}
          onClose={async (_ids, closing) => {
            // one at a time: each asks about its unsaved changes
            for (const t of closing) {
              if (t.id !== 'run') await closeFile(t.data!);
              else {
                setRunsOpen(false);
                setTab('editor');
              }
            }
          }}
          onRename={(t) => void renameFile(t.data!)}
          extraItems={({ id, data: p }) =>
            id === 'run'
              ? []
              : [
                  { label: LABEL.run, icon: <Play size={13} />, onSelect: () => void run([p!], p!) },
                  { label: 'Expose as MCP tool…', icon: <Bot size={13} />, disabled: !/\.(ya?ml|json)$/.test(p!), reason: 'Only a YAML or JSON test file', onSelect: () => void exposeFile(p!) },
                  { label: 'Run with data…', icon: <FileSpreadsheet size={13} />, disabled: !/\.(ya?ml|json)$/.test(p!) || /\.suite\./.test(p!), reason: 'Only a YAML or JSON test file, not a suite', onSelect: () => void openScaling(p!, 'data') },
                  { label: LABEL.runInEnvironments, icon: <Layers size={13} />, disabled: !/\.(ya?ml|json)$/.test(p!) || /\.suite\./.test(p!), reason: 'Only a YAML or JSON test file, not a suite', onSelect: () => void openScaling(p!, 'matrix') },
                ]
          }
          tabs={[
            ...openFiles.map((p) => ({
              id: `file:${p}`,
              title: p.split('/').pop() ?? p,
              tooltip: `tests/${p}`,
              badge: <TestFileBadge path={p} />,
              dirty: p === file ? dirty : buffers.current[p] ? buffers.current[p]!.content !== buffers.current[p]!.saved : false,
              rename: 'dialog' as const,
              data: p,
            })),
            // the file's flow: part of the file, it goes with it
            ...(file ? [{ id: 'flow', title: 'Flow', closable: false }] : []),
            ...(runsOpen ? [{ id: 'run', title: 'Runs', count: runs.length }] : []),
          ]}
          actions={
            tab !== 'run' &&
            file && (
              <>
                <Button size="sm" icon={<Save size={12} />} onClick={save} disabled={!dirty} reason="Nothing changed yet">
                  Save
                </Button>
                <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => run([file], file)}>
                  Run
                </Button>
                {/\.(ya?ml|json)$/.test(file) && !/\.suite\./.test(file) && (
                  <IconButton label="Run with data or in environments…" data-run-with-data-open onClick={() => void openScaling(file, 'data')}>
                    <FileSpreadsheet />
                  </IconButton>
                )}
                {/* Delete… (with Undo, like the tree's) is in the file's ⋯ on the breadcrumb below, the same menu as its row */}
              </>
            )
          }
        />
        )}
        {/* where the file lives: Tests › folder › file (› the step chosen on the canvas) */}
        {file && tab !== 'run' && (() => {
          const parts = file.split('/');
          const step = tab === 'flow' && flowSel && flow && !('error' in flow) ? flow.steps.find((s) => s.id === flowSel) : undefined;
          const crumbs: Crumb[] = [{ label: 'Tests', view: 'tests' }, ...parts.slice(0, -1).map((label) => ({ label })), ...(step ? [{ label: parts[parts.length - 1]!, ref: { kind: 'test' as const, path: file } }] : [])];
          // the file's ⋯: its menu as its row in the tree has it (run, copy, rename, Delete… with Undo), built by lib/node-menu.ts
          const node = findNode(tree, file) ?? { kind: 'file' as const, name: parts[parts.length - 1]!, path: file };
          return <ItemBreadcrumb crumbs={crumbs} name={step ? step.name : parts[parts.length - 1]!} dirty={dirty} actions={openItemMenu('test', { ...fileMenu(node), ref: { kind: 'test', path: file } })} />;
        })()}
        <div className="flex-1 min-h-0">
          {/* ONE editor for every open file (a model each, the editor swaps them): it stays mounted, hidden, while the
              Flow or Runs tab shows — creating a Monaco editor on every open and every return to the Editor tab took 200-400 ms */}
          {file && (
            <div className="h-full" style={tab === 'editor' ? undefined : { display: 'none' }}>
                <Split id="tests-editor" initial={65}>
                  <CodeEditor
                    language={dataLanguageOf(file)}
                    path={`tests/${file}`}
                    value={editorValue}
                    // each keystroke: the mirror and, when it flips, whether the file has unsaved changes (nothing else re-renders)
                    onChange={(v) => {
                      contentRef.current = v;
                      syncDirty();
                    }}
                    onMount={(ed, monaco) => {
                      editorRef.current = ed;
                      monacoRef.current = monaco;
                      reveal();
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
                      // only the rows on screen (a 500-step file had 500 rows to lay out on every return to the Editor tab)
                      <VirtualList
                        scrollParent
                        items={preview?.tests ?? []}
                        rowHeight={29}
                        render={(t) => (
                          <div className="h-full px-3 flex items-center gap-2 border-b border-line/50">
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
                        )}
                      />
                    )}
                    <p className="p-3 text-xs text-muted">
                      Test files are plain YAML/JSON in the workspace <span className="mono">tests/</span> folder — commit them to git and run them in CI with <span className="mono">testpion test</span>.
                    </p>
                  </div>
                </Split>
            </div>
          )}
          {/* the flow designer of the open file, like the editor: mounted once, hidden while another tab shows, so its view,
              selection, History panel and search survive a switch to the Editor and back */}
          {file && flow && !('error' in flow) && /\.(ya?ml|json)$/i.test(file) && !/\.suite\.(ya?ml|json)$/i.test(file) && (
            <div className="h-full" style={tab === 'flow' ? undefined : { display: 'none' }}>
                <FlowDesigner
                  key={file}
                  file={file}
                  flow={flow}
                  onEdited={flowEdited}
                  beforeEdit={async () => {
                    if (isDirty()) await save();
                  }}
                  onRun={(o) => run([file], undefined, { stay: true, flow: o ?? {} })}
                  onOpenStep={openStep}
                  onExpose={() => void exposeFile(file)}
                  focusStep={focusStep}
                  savedText={saved}
                  onStepChange={setFlowSel}
                  onOpenResult={(s, id) => {
                    setRunId(id);
                    setFocusResult(s.name);
                    setTab('run');
                  }}
                />
            </div>
          )}
          {tab === 'editor' ? null : tab === 'flow' ? (
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
            ) : /\.(ya?ml|json)$/i.test(file) && !/\.suite\.(ya?ml|json)$/i.test(file) ? (
              // a test file: the flow designer (a suite names other files: it stays a read-only diagram)
              // drawn below, outside the tabs: it stays mounted (hidden) while the Editor or Runs tab shows
              null
            ) : !flow.steps.length ? (
              <Empty icon={<Workflow size={28} />} title="No steps in this file">
                A flow is a test file whose tests chain with <span className="mono">dependsOn</span> and <span className="mono">extract</span>; a suite names other files — open one of them to see its flow.
              </Empty>
            ) : (
              <FlowDiagram steps={flow.steps} selected={flowSel} onSelect={openStep} onOpenResult={flow.run ? openStepResult : undefined} />
            )
          ) : scaleId ? (
            <div className="h-full flex flex-col min-h-0">
              <Bar className="text-xs">
                <button className="text-accent hover:underline" onClick={() => setScaleId(undefined)}>
                  ← Test runs
                </button>
                <span className="text-muted">Data runs and environment matrices</span>
              </Bar>
              <div className="flex-1 min-h-0">
                <ScaleRunPanel id={scaleId} onSelect={setScaleId} />
              </div>
            </div>
          ) : runId ? (
            <Split id="tests-runs" initial={22} min={12}>
              <RunList runs={runs} active={runId} onSelect={setRunId} onOverview={() => setRunId(undefined)} onRerunFailed={rerunFailed} onRunAll={() => void run([], 'All tests')} />
              <RunPanel
                key={runId}
                runId={runId}
                focusName={focusResult}
                onRerunFailed={rerunFailed}
              />
            </Split>
          ) : (
            <Split id="tests-runs" initial={22} min={12}>
              <RunList runs={runs} active={runId} onSelect={setRunId} onRerunFailed={rerunFailed} onRunAll={() => void run([], 'All tests')} />
              <RunsOverview flaky runs={runs} onSelect={setRunId} onRun={{ label: 'Run all tests', run: () => void run([], 'All tests') }} />
            </Split>
          )}
        </div>
      </div>
    </Split>
    {exposing && <ExposeFlowDialog path={exposing} onClose={() => setExposing(undefined)} onChanged={() => void exposed(exposing).catch(toastError)} />}
    {scaling && (
      <RunWithDataDialog
        file={scaling.file}
        initial={scaling.initial}
        onClose={() => setScaling(undefined)}
        onStarted={(s) => {
          setScaleId(s.id);
          setTab('run');
        }}
      />
    )}
    </>
  );
}
