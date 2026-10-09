import { ClipboardPaste, Copy, CopyPlus, FileCode2, FolderInput, LayoutGrid, Play, Plus, Redo2, Sparkles, StepForward, Trash2, Undo2, Workflow } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flowGraph, type FlowStep } from '@testpion/shared';
import { asError, call, on } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { useCollectionTree } from '../lib/collections-store';
import type { AuthConfig, CheckConfig, CollectionNode, KeyValue, TestResult } from '../types';
import { AssertionEditor } from './AssertionEditor';
import { AuthEditor } from './AuthEditor';
import { CodeEditor } from './CodeEditor';
import { FlowDiagram, type FlowSelection } from './FlowDiagram';
import { KeyValueEditor } from './KeyValueEditor';
import { VarInput } from './VarInput';
import { Badge, Button, cx, Empty, Field, Input, LinkButton, Menu, Modal, SectionTitle, Select, Split, Textarea, type MenuItem } from './ui';

/** A test file as a flow, as the tests.flow RPC reads it for the designer (with each step as written). */
export interface DesignerFlow {
  steps: FlowStep[];
  run?: { runId: string };
  raw?: Record<string, Record<string, unknown>>;
}

/** What tests.flowEdit answers: the text before (undo) and after (the editor), and the flow read again. */
export interface FlowEditAnswer {
  file: string;
  before: string;
  text: string;
  added: string[];
  flow: DesignerFlow;
}

type Op = Record<string, unknown> & { op: string };

/** The steps a new flow starts from (the palette). */
const PALETTE: Array<{ type: string; label: string; step: Record<string, unknown> }> = [
  { type: 'http', label: 'HTTP request', step: { name: 'HTTP request', type: 'http', method: 'GET', url: '{{baseUrl}}/', assertions: [{ type: 'status', expected: 200 }] } },
  {
    type: 'graphql',
    label: 'GraphQL',
    step: { name: 'GraphQL query', type: 'graphql', endpoint: '{{graphqlEndpoint}}', query: 'query {\n  __typename\n}\n', assertions: [{ type: 'graphql-no-errors' }] },
  },
  {
    type: 'grpc',
    label: 'gRPC call',
    step: { name: 'gRPC call', type: 'grpc', target: '{{grpcTarget}}', method: 'package.Service/Method', message: {}, assertions: [{ type: 'grpc-status', expected: 'OK' }] },
  },
  {
    type: 'websocket',
    label: 'WebSocket',
    step: { name: 'WebSocket', type: 'websocket', url: '{{wsUrl}}', send: ['hello'], waitMs: 1500, assertions: [{ type: 'length', path: '$.received', min: 1 }] },
  },
  { type: 'mcp', label: 'MCP tool call', step: { name: 'MCP tool call', type: 'mcp', server: 'my-server', tool: 'my_tool', arguments: {} } },
  { type: 'llm', label: 'LLM prompt', step: { name: 'LLM prompt', type: 'llm', model: 'mock', prompt: 'Answer in one word: {{question}}' } },
  { type: 'delay', label: 'Delay', step: { name: 'Wait', type: 'delay', ms: 1000 } },
];

/** Undo and redo per file: texts of the file before each canvas change (kept while the app runs, across tab switches). */
const history = new Map<string, { undo: string[]; redo: string[] }>();
const historyOf = (file: string) => history.get(file) ?? history.set(file, { undo: [], redo: [] }).get(file)!;
/** Copied steps (Ctrl+C on the canvas), pasted into this or another flow with Ctrl+V. */
let copied: { file: string; ids: string[] } | undefined;
const GAP_X = 284;

/**
 * The flow designer: a test file's steps on an editable FlowDiagram, with a toolbar (Add step, Auto-arrange, Undo,
 * Redo, Run flow, Run step, Fit) and an inspector for the selected step (its request with the request view's editors,
 * what it extracts, its checks with the AssertionEditor, what it waits for). Every change is one tests.flowEdit call
 * that edits the YAML and saves it: the file stays the one source of truth, the Editor tab shows the same text.
 */
export function FlowDesigner({
  file,
  flow,
  onEdited,
  beforeEdit,
  onRun,
  onOpenStep,
  onOpenResult,
}: {
  /** The test file inside tests/. */
  file: string;
  flow: DesignerFlow;
  /** An edit was saved: the editor and the flow show the new text. */
  onEdited(r: FlowEditAnswer): void;
  /** Before an edit: the editor's unsaved changes are saved first. */
  beforeEdit(): Promise<void>;
  /** Run the file (or only these steps); answers the run's id. */
  onRun(ids?: string[]): Promise<string | undefined>;
  /** Show the step in the editor (double-click, Open in editor). */
  onOpenStep(step: FlowStep): void;
  /** Show a step's result of a run in the Runs tab. */
  onOpenResult(step: FlowStep, runId: string): void;
}) {
  const env = useApp((s) => s.environment);
  const [sel, setSel] = useState<FlowSelection>({ steps: [] });
  const [busy, setBusy] = useState(false);
  // bumped by undo and redo: the inspector's fields take the restored values
  const [version, setVersion] = useState(0);
  const [, rerender] = useState(0);
  const [picking, setPicking] = useState(false);
  const canvasAt = useRef<[number, number] | undefined>(undefined);
  const h = historyOf(file);

  // a run started here lights the steps up as their results come in
  const [liveRun, setLiveRun] = useState<string>();
  const [live, setLive] = useState<Record<string, { status: string; durationMs?: number }>>({});
  useEffect(() => {
    if (!liveRun) return;
    return on<Array<{ type: string; runId: string; id?: string; result?: TestResult }>>('run.events', (evs) => {
      const mine = evs.filter((e) => e.runId === liveRun);
      if (!mine.length) return;
      setLive((l) => {
        const next = { ...l };
        for (const e of mine) {
          if (e.type === 'test-start' && e.id) next[e.id] = { status: 'running' };
          if (e.type === 'test-end' && e.result) next[e.result.id] = { status: e.result.status, durationMs: e.result.durationMs };
        }
        return next;
      });
    });
  }, [liveRun]);
  // the finished run read back with the flow: its results are the steps' own now
  useEffect(() => {
    if (liveRun && flow.run?.runId === liveRun) setLiveRun(undefined);
  }, [flow.run?.runId, liveRun]);
  const steps = useMemo(() => (liveRun ? flow.steps.map((s) => ({ ...s, status: live[s.id]?.status, durationMs: live[s.id]?.durationMs })) : flow.steps), [flow.steps, liveRun, live]);
  const graph = useMemo(() => flowGraph(flow.steps), [flow.steps]);
  const hasLayout = flow.steps.some((s) => s.position);
  const ids = new Set(flow.steps.map((s) => s.id));
  // a selection of steps that are gone (removed, renamed) is dropped
  const selSteps = sel.steps.filter((id) => ids.has(id));
  const one = selSteps.length === 1 ? flow.steps.find((s) => s.id === selSteps[0]) : undefined;

  const apply = useCallback(
    async (op: Op, opts: { select?: boolean; restoring?: 'undo' | 'redo' } = {}): Promise<FlowEditAnswer | undefined> => {
      setBusy(true);
      try {
        await beforeEdit();
        const r = await call<FlowEditAnswer>('tests.flowEdit', { file, op, environment: env });
        if (r.before !== r.text) {
          if (opts.restoring === 'undo') h.redo.push(r.before);
          else {
            h.undo.push(r.before);
            if (h.undo.length > 100) h.undo.shift();
            if (!opts.restoring) h.redo.length = 0;
          }
        }
        if (opts.restoring) setVersion((v) => v + 1);
        onEdited(r);
        if (opts.select && r.added.length) setSel({ steps: r.added });
        rerender((n) => n + 1);
        return r;
      } catch (e) {
        toastError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [beforeEdit, env, file, h, onEdited],
  );
  const undo = () => {
    const text = h.undo.pop();
    if (text !== undefined) void apply({ op: 'replace', text }, { restoring: 'undo' });
  };
  const redo = () => {
    const text = h.redo.pop();
    if (text !== undefined) void apply({ op: 'replace', text }, { restoring: 'redo' });
  };

  /** Where a new step goes: after the selected one, or where the canvas was clicked (only when the file has a layout). */
  const placeNew = (): { after?: string; at?: [number, number] } => {
    const after = one?.id;
    if (!hasLayout) return { after };
    const n = after ? graph.nodes.find((x) => x.id === after) : undefined;
    if (n) return { after, at: [n.x + GAP_X, n.y] };
    if (canvasAt.current) return { at: canvasAt.current };
    return { at: [graph.nodes.reduce((m, x) => Math.max(m, x.x + x.w), 0) + 64, 0] };
  };
  const addStep = (step: Record<string, unknown>) => void apply({ op: 'addStep', step, ...placeNew() }, { select: true });
  const addFromCollection = async (collection: string, item: string) => {
    setPicking(false);
    await apply({ op: 'addFromCollection', collection, items: [item], chain: true, ...placeNew() }, { select: true });
  };
  const generate = async () => {
    const job = await promptText('Generate a flow with AI', {
      message: 'What should the flow do? One or two sentences.',
      placeholder: 'e.g. log in, create an order with the token, read it back, cancel it',
      okLabel: 'Generate',
      detail: flow.steps.length
        ? 'The assistant writes the whole file; you review it before it replaces this one (Undo brings it back).'
        : 'The assistant writes the steps as YAML; you review them before they are saved.',
    });
    if (!job) return;
    useApp.getState().set({
      assistant: {
        task: 'design-flow',
        title: 'Design a flow',
        context: { file: `tests/${file}`, environment: env, steps: flow.steps.map(({ id, name, type, method, url, extract, dependsOn }) => ({ id, name, type, method, url, extract, dependsOn })) },
        question: job,
        apply: {
          label: 'Review and use this flow',
          run: async (code) => {
            const problems = await call<Array<{ severity: string; message: string; line: number }>>('tests.lint', { content: code, path: file }).catch((e) => [
              { severity: 'error', message: asError(e).message, line: 1 },
            ]);
            const errors = problems.filter((p) => p.severity === 'error');
            if (errors.length) return `it is not a test file the runner can load: ${errors.map((p) => `line ${p.line}: ${p.message}`).join('; ')}`;
            if (
              !(await confirmAction({
                title: 'Replace the flow',
                message: `Replace tests/${file} with the AI-generated flow?`,
                detail: 'Read the YAML in the assistant first. Undo in the Flow tab brings the current file back.',
                confirmLabel: 'Replace',
              }))
            )
              return 'not used';
            const r = await apply({ op: 'replace', text: code });
            return r ? { done: 'AI-generated flow saved: check each step, then Run flow' } : 'it could not be saved';
          },
        },
      },
    });
  };

  const remove = () => {
    if (sel.edge) void apply({ op: 'disconnect', from: sel.edge.from, to: sel.edge.to }).then((r) => r && setSel({ steps: [] }));
    else if (selSteps.length) void apply({ op: 'removeStep', id: selSteps }).then((r) => r && setSel({ steps: [] }));
  };
  const move = (positions: Record<string, [number, number]>) => {
    // the first move of a flow without a layout keeps every other step where the automatic layout drew it
    const all: Record<string, [number, number]> = hasLayout ? {} : Object.fromEntries(graph.nodes.map((n) => [n.id, [Math.round(n.x), Math.round(n.y)] as [number, number]]));
    void apply({ op: 'setLayout', positions: { ...all, ...positions } });
  };
  /** Run a step with the steps it waits for (and theirs). */
  const withDependencies = (id: string): string[] => {
    const byId = new Map(flow.steps.map((s) => [s.id, s]));
    const out = new Set<string>();
    const walk = (x: string) => {
      if (out.has(x) || !byId.has(x)) return;
      out.add(x);
      for (const d of byId.get(x)!.dependsOn ?? []) walk(d);
    };
    walk(id);
    return flow.steps.filter((s) => out.has(s.id)).map((s) => s.id);
  };
  const run = async (only?: string[]) => {
    const id = await onRun(only);
    if (!id) return;
    setLive({});
    setLiveRun(id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable], .monaco-editor')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
    else if (k === 'd' && selSteps.length) void apply({ op: 'duplicateStep', id: selSteps }, { select: true });
    else if (k === 'c' && selSteps.length) {
      copied = { file, ids: selSteps };
      useApp.getState().toast(`${selSteps.length} step${selSteps.length === 1 ? '' : 's'} copied: Ctrl+V pastes them into this or another flow`);
    } else if (k === 'v' && copied) void apply({ op: 'pasteSteps', from: copied.file, ids: copied.ids, ...placeNew() }, { select: true });
    else return;
    e.preventDefault();
  };

  const addItems: MenuItem[] = [
    ...PALETTE.map((p) => ({ label: p.label, icon: <Plus size={14} />, onSelect: () => addStep(p.step) })),
    { label: 'From a collection…', icon: <FolderInput size={14} />, separator: true, onSelect: () => setPicking(true) },
    { label: 'Generate the flow with AI…', icon: <Sparkles size={14} />, onSelect: () => void generate() },
  ];
  const toolbar: ReactNode = (
    <>
      <Menu
        align="start"
        width={230}
        items={addItems}
        trigger={
          <Button size="sm" variant="primary" icon={<Plus size={12} />} data-flow-add title={one ? `Add a step after "${one.name}" (it waits for it)` : 'Add a step to the flow'}>
            Add step
          </Button>
        }
      />
      <Button
        size="sm"
        icon={<LayoutGrid size={12} />}
        onClick={() => void apply({ op: 'setLayout', positions: null })}
        disabled={!hasLayout || busy}
        title="Lay the steps out in columns again (forget where they were dragged)"
      >
        Auto-arrange
      </Button>
      <Button size="sm" icon={<Undo2 size={12} />} onClick={undo} disabled={!h.undo.length || busy} title="Undo the last change (Ctrl+Z)" data-flow-undo>
        Undo
      </Button>
      <Button size="sm" icon={<Redo2 size={12} />} onClick={redo} disabled={!h.redo.length || busy} title="Redo (Ctrl+Y)" data-flow-redo>
        Redo
      </Button>
      <span className="w-px h-5 bg-line mx-1" />
      <Button size="sm" icon={<Play size={12} />} onClick={() => void run()} disabled={!flow.steps.length} title="Run every step of the flow; the steps light up as they finish" data-flow-run>
        Run flow
      </Button>
      <Button
        size="sm"
        icon={<StepForward size={12} />}
        onClick={() => one && void run(withDependencies(one.id))}
        disabled={!one}
        title={one ? `Run "${one.name}" with the steps it waits for` : 'Select a step to run it with the steps it waits for'}
      >
        Run step
      </Button>
    </>
  );

  if (!flow.steps.length)
    return (
      <div className="h-full flex flex-col" data-flow-designer>
        <Empty
          icon={<Workflow size={28} />}
          title="Design a flow"
          actions={[
            { label: 'Add a step', icon: <Plus size={12} />, onClick: () => addStep(PALETTE[0]!.step) },
            { label: 'Create from a collection', icon: <FolderInput size={12} />, onClick: () => setPicking(true), primary: false },
            { label: 'Generate with AI', icon: <Sparkles size={12} />, onClick: () => void generate(), primary: false },
          ]}
        >
          A flow is steps that run in order: each can wait for others (<span className="mono">dependsOn</span>) and use the values they extract as <span className="mono">{'{{variables}}'}</span>. Add
          a first step, take a folder of requests from a collection (chained, ids and tokens extracted), or describe the flow and let the assistant write it.
        </Empty>
        {picking && <CollectionPicker onPick={(c, item) => void addFromCollection(c, item)} onClose={() => setPicking(false)} />}
      </div>
    );

  return (
    <div className="h-full min-h-0" data-flow-designer onKeyDown={onKeyDown}>
      <Split id="flow-designer" initial={68} min={30}>
        <FlowDiagram
          editable
          fitKey={file}
          steps={steps}
          selection={{ steps: selSteps, edge: sel.edge }}
          onSelectionChange={setSel}
          onConnect={(from, to) => void apply({ op: 'connect', from, to })}
          onMove={move}
          onDelete={remove}
          onCanvasClick={(at) => (canvasAt.current = at)}
          onOpen={onOpenStep}
          onOpenResult={(s) => {
            const runId = liveRun ?? flow.run?.runId;
            if (runId) onOpenResult(s, runId);
          }}
          toolbar={toolbar}
        />
        <div className="h-full overflow-auto text-sm" data-flow-inspector>
          {one ? (
            <StepInspector
              key={`${one.id}:${version}`}
              step={one}
              raw={flow.raw?.[one.id]}
              steps={flow.steps}
              lastRunId={liveRun ?? flow.run?.runId}
              update={(set) => apply({ op: 'updateStep', id: one.id, set })}
              actions={
                <>
                  <Button size="sm" icon={<StepForward size={12} />} onClick={() => void run(withDependencies(one.id))}>
                    Run step
                  </Button>
                  <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => onOpenStep(one)} title="Show the step in the YAML editor">
                    Open in editor
                  </Button>
                  <Button size="sm" icon={<CopyPlus size={12} />} onClick={() => void apply({ op: 'duplicateStep', id: one.id }, { select: true })} title="Ctrl+D">
                    Duplicate
                  </Button>
                  <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={remove} title="Delete">
                    Delete step
                  </Button>
                </>
              }
            />
          ) : selSteps.length > 1 ? (
            <div className="p-3 grid gap-3">
              <SectionTitle>{selSteps.length} steps selected</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" icon={<CopyPlus size={12} />} onClick={() => void apply({ op: 'duplicateStep', id: selSteps }, { select: true })}>
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  icon={<Copy size={12} />}
                  onClick={() => {
                    copied = { file, ids: selSteps };
                    useApp.getState().toast(`${selSteps.length} steps copied: Ctrl+V pastes them into this or another flow`);
                  }}
                >
                  Copy
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={remove}>
                  Delete steps
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-3 grid gap-2 text-xs text-muted">
              <SectionTitle>Flow</SectionTitle>
              <p>
                {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}, {graph.edges.length} connection{graph.edges.length === 1 ? '' : 's'}.{' '}
                {sel.edge ? (
                  <>
                    <b className="text-fg">{sel.edge.to}</b> waits for <b className="text-fg">{sel.edge.from}</b>: Delete removes the connection.
                  </>
                ) : (
                  'Select a step to edit it.'
                )}
              </p>
              <ul className="list-disc ml-4 grid gap-1">
                <li>Drag the dot on a step's right edge onto another step: that step then waits for it and can use what it extracts.</li>
                <li>Drag steps to arrange them; Shift+click selects several; Delete removes the selection; Ctrl+Z undoes.</li>
                <li>Ctrl+C / Ctrl+V copy steps between flows; Ctrl+D duplicates.</li>
                <li>
                  A <span className="text-warn font-bold">!</span> marks a step that reads a variable no earlier step extracts and the environment does not define.
                </li>
              </ul>
              {copied && (
                <LinkButton icon={<ClipboardPaste size={12} />} onClick={() => void apply({ op: 'pasteSteps', from: copied!.file, ids: copied!.ids, ...placeNew() }, { select: true })}>
                  Paste {copied.ids.length} copied step{copied.ids.length === 1 ? '' : 's'}
                </LinkButton>
              )}
            </div>
          )}
        </div>
      </Split>
      {picking && <CollectionPicker onPick={(c, item) => void addFromCollection(c, item)} onClose={() => setPicking(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ the inspector */

/** A value edited here and saved a moment after the last change (and when the inspector closes). */
function useCommitted<T>(initial: T, commit: (v: T) => unknown, ms = 600): [T, (v: T) => void, () => void] {
  const [value, setValue] = useState(initial);
  const pending = useRef<{ v: T; t: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.t);
    pending.current = undefined;
    void commitRef.current(p.v);
  }, []);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      if (pending.current) clearTimeout(pending.current.t);
      pending.current = { v, t: setTimeout(flush, ms) };
    },
    [flush, ms],
  );
  useEffect(() => flush, [flush]);
  return [value, set, flush];
}

const asRows = (v: unknown): KeyValue[] =>
  Array.isArray(v)
    ? v.map((x) =>
        x && typeof x === 'object' ? { key: String((x as KeyValue).key ?? ''), value: String((x as KeyValue).value ?? ''), enabled: (x as KeyValue).enabled !== false } : { key: String(x), value: '' },
      )
    : v && typeof v === 'object'
      ? Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }))
      : [];
const asMap = (rows: KeyValue[]): Record<string, string> | null => {
  const on = rows.filter((r) => r.key && r.enabled !== false);
  return on.length ? Object.fromEntries(on.map((r) => [r.key, r.value])) : null;
};
const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : undefined);

/** Text fields of the other step types (what the inspector edits; the rest is in the YAML). */
const FIELDS: Record<string, Array<[key: string, label: string, kind: 'line' | 'text']>> = {
  graphql: [
    ['endpoint', 'Endpoint', 'line'],
    ['query', 'Query', 'text'],
  ],
  grpc: [
    ['target', 'Target (host:port)', 'line'],
    ['method', 'Method (package.Service/Method)', 'line'],
  ],
  websocket: [['url', 'URL', 'line']],
  mcp: [
    ['server', 'Server', 'line'],
    ['tool', 'Tool', 'line'],
  ],
  llm: [
    ['model', 'Model (provider/name)', 'line'],
    ['prompt', 'Prompt', 'text'],
  ],
  rag: [['question', 'Question', 'text']],
  agent: [['input', 'Task', 'text']],
};

function StepInspector({
  step,
  raw,
  steps,
  lastRunId,
  update,
  actions,
}: {
  step: FlowStep;
  raw?: Record<string, unknown>;
  steps: FlowStep[];
  lastRunId?: string;
  update(set: Record<string, unknown>): Promise<unknown>;
  actions: ReactNode;
}) {
  const r = raw ?? {};
  const req = (r.request && typeof r.request === 'object' && !Array.isArray(r.request) ? r.request : r) as Record<string, unknown>;
  const [name, setName] = useState(step.name);
  const [url, setUrl] = useState(asText(req.url) ?? '');
  const [headers, setHeaders] = useCommitted<KeyValue[]>(asRows(req.headers), (rows) => update({ headers: asMap(rows) }));
  const [extract, setExtract] = useCommitted<KeyValue[]>(asRows(r.extract), (rows) => update({ extract: asMap(rows) }));
  const checksKey = r.checks && !r.assertions ? 'checks' : 'assertions';
  const [checks, setChecks] = useCommitted<CheckConfig[]>(Array.isArray(r[checksKey]) ? (r[checksKey] as CheckConfig[]) : [], (c) => update({ [checksKey]: c.length ? c : null }));
  const [auth, setAuth] = useCommitted<AuthConfig | undefined>(req.auth as AuthConfig | undefined, (a) => update({ auth: a && a.type !== 'none' ? a : null }));
  const body0 =
    req.json !== undefined
      ? { type: 'json', content: JSON.stringify(req.json, null, 2) }
      : typeof req.body === 'string'
        ? { type: 'text', content: req.body }
        : (req.body as { type?: string; content?: string } | undefined);
  const [body, setBody] = useCommitted<{ type: string; content: string }>({ type: body0?.type ?? 'none', content: body0?.content ?? '' }, (b) =>
    update({ body: b.type === 'none' ? null : { type: b.type, content: b.content } }),
  );
  const editableBody = !body0 || ['none', 'json', 'text', 'xml', 'html'].includes(body0.type ?? '');
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries((FIELDS[step.type] ?? []).map(([k]) => [k, asText(r[k]) ?? ''])));
  const [paths, setPaths] = useState<string[]>();
  const [waitMs, setWaitMs] = useState(String(r.ms ?? r.duration ?? ''));
  const commitWait = () => {
    const n = Number(waitMs);
    if (waitMs.trim() === '' || !Number.isFinite(n) || n < 0 || n > 600_000) return toastError(new Error('A delay waits 0 to 600000 ms (ten minutes)'));
    if (n !== r.ms) void update({ ms: n, ...(r.duration !== undefined ? { duration: null } : {}) });
  };
  const others = steps.filter((s) => s.id !== step.id);
  const waits = new Set(step.dependsOn ?? []);
  const commitName = () => name.trim() && name.trim() !== step.name && void update({ name: name.trim() });
  const commitUrl = () => url !== (asText(req.url) ?? '') && void update({ url });

  /** JSONPaths of the scalar values of the step's latest response, for an extract. */
  const pickPaths = async () => {
    if (!lastRunId) return setPaths([]);
    try {
      const page = await call<{ items: TestResult[] } | TestResult[]>('runs.results', { runId: lastRunId, query: step.name, limit: 50 });
      const items = Array.isArray(page) ? page : page.items;
      const res = items.find((x) => x.id === step.id) ?? items.find((x) => x.name === step.name);
      let body: unknown;
      try {
        body = res?.output ? JSON.parse(res.output) : undefined;
      } catch {
        body = undefined;
      }
      const out: string[] = [];
      const walk = (v: unknown, p: string, depth: number) => {
        if (out.length >= 40 || depth > 3) return;
        if (Array.isArray(v)) v.slice(0, 2).forEach((x, i) => walk(x, `${p}[${i}]`, depth + 1));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, /^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}['${k}']`, depth + 1);
        else if (p !== '$') out.push(p);
      };
      walk(body, '$', 0);
      setPaths(out);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="grid gap-3 p-3" data-step-inspector={step.id}>
      <div className="flex items-center gap-2">
        <Badge>{step.type}</Badge>
        <span className="mono text-xs text-muted truncate" title="The step's id: what dependsOn names">
          {step.id}
        </span>
      </div>
      <Field label="Name">
        <Input aria-label="Step name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && commitName()} />
      </Field>
      <div className="flex flex-wrap gap-1.5">{actions}</div>
      {step.unresolved?.length ? (
        <p className="text-xs text-warn" data-inspector-unresolved>
          Reads {step.unresolved.map((v) => `{{${v}}}`).join(', ')}, which no earlier step extracts and the environment does not define: connect the step that extracts it, or add it to the
          environment.
        </p>
      ) : null}
      {!raw ? (
        <p className="text-xs text-muted">Edit this step in the YAML (Open in editor): the file is not a plain list of steps.</p>
      ) : step.type === 'http' ? (
        <>
          <SectionTitle>Request</SectionTitle>
          <div className="flex gap-1.5 items-center" onBlur={commitUrl}>
            <Select aria-label="Method" value={String(req.method ?? 'GET').toUpperCase()} onChange={(e) => void update({ method: e.target.value })} className="w-24">
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
            <VarInput className="flex-1 min-w-0" ariaLabel="URL" value={url} onChange={setUrl} onEnter={commitUrl} placeholder="{{baseUrl}}/path" />
          </div>
          <Field label="Headers">
            <KeyValueEditor rows={headers} onChange={setHeaders} keyPlaceholder="Header" />
          </Field>
          <Field label="Authorization">
            <AuthEditor auth={auth ?? { type: 'none' }} onChange={setAuth} allowInherit={false} />
          </Field>
          {editableBody ? (
            <Field label="Body">
              <div className="grid gap-1.5">
                <Select aria-label="Body type" value={body.type} onChange={(e) => setBody({ ...body, type: e.target.value })} className="w-32">
                  {['none', 'json', 'text', 'xml'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                {body.type !== 'none' && (
                  <div className="h-40 border border-line rounded-md overflow-hidden">
                    <CodeEditor value={body.content} onChange={(c) => setBody({ ...body, content: c })} language={body.type === 'json' ? 'json' : body.type === 'xml' ? 'xml' : 'plaintext'} minimal />
                  </div>
                )}
              </div>
            </Field>
          ) : (
            <p className="text-xs text-muted">A {body0?.type} body: edit it in the YAML.</p>
          )}
        </>
      ) : step.type === 'delay' ? (
        <>
          <SectionTitle>Delay</SectionTitle>
          <Field label="Wait (ms)">
            <Input
              type="number"
              min={0}
              max={600000}
              step={100}
              aria-label="Wait (ms)"
              data-inspector-wait
              value={waitMs}
              onChange={(e) => setWaitMs(e.target.value)}
              onBlur={commitWait}
              onKeyDown={(e) => e.key === 'Enter' && commitWait()}
            />
          </Field>
          <p className="text-xs text-muted">The flow pauses here; never longer than the step's timeout, and Stop ends the wait at once.</p>
        </>
      ) : FIELDS[step.type] ? (
        <>
          <SectionTitle>{step.type}</SectionTitle>
          {FIELDS[step.type]!.map(([k, label, kind]) =>
            asText(r[k]) === undefined ? (
              <p key={k} className="text-xs text-muted">
                {label}: written as a map; edit it in the YAML.
              </p>
            ) : (
              <Field key={k} label={label}>
                {kind === 'line' ? (
                  <Input value={fields[k] ?? ''} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} onBlur={() => fields[k] !== asText(r[k]) && void update({ [k]: fields[k] })} />
                ) : (
                  <Textarea
                    autoGrow
                    maxRows={14}
                    className="mono text-xs"
                    value={fields[k] ?? ''}
                    onChange={(e) => setFields({ ...fields, [k]: e.target.value })}
                    onBlur={() => fields[k] !== asText(r[k]) && void update({ [k]: fields[k] })}
                  />
                )}
              </Field>
            ),
          )}
        </>
      ) : null}
      {raw && (
        <>
          {step.type !== 'delay' && (
            <>
              <SectionTitle
                right={
                  <LinkButton onClick={() => void pickPaths()} title={lastRunId ? "Values of the step's latest response, to extract" : 'Run the flow first: the latest response offers its values'}>
                    Pick from the last response
                  </LinkButton>
                }
              >
                Extract
              </SectionTitle>
              <div data-inspector-extract>
                <KeyValueEditor rows={extract} onChange={setExtract} keyPlaceholder="Variable" valuePlaceholder="$.json.path" />
              </div>
              {paths && (
                <div className="flex flex-wrap gap-1" data-inspector-paths>
                  {paths.length ? (
                    paths.map((p) => (
                      <button
                        key={p}
                        className="mono text-xs px-1.5 py-0.5 rounded border border-line hover:bg-hover"
                        onClick={() => {
                          const key = (/[.[']?([A-Za-z_$][\w$]*)'?\]?$/.exec(p)?.[1] ?? 'value').replace(/^\$/, '');
                          setExtract([...extract.filter((x) => x.key), { key, value: p }]);
                        }}
                      >
                        {p}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-muted">{lastRunId ? 'The latest response has no JSON values to pick.' : 'Run the flow first.'}</span>
                  )}
                </div>
              )}
              <SectionTitle>Checks</SectionTitle>
              <AssertionEditor checks={checks} onChange={setChecks} />
            </>
          )}
          <SectionTitle>Waits for</SectionTitle>
          {others.length ? (
            <div className="grid gap-1" data-inspector-waits>
              {others.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={waits.has(s.id)} onChange={(e) => void update({ dependsOn: e.target.checked ? [...waits, s.id] : [...waits].filter((x) => x !== s.id) })} />
                  <span className="truncate">{s.name}</span>
                  <span className="mono text-muted truncate">{s.id}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No other steps yet.</p>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ steps from a collection */

/** Pick saved requests: one request, or a folder's requests in order (each waiting for the one before it). */
function CollectionPicker({ onPick, onClose }: { onPick(collection: string, item: string): void; onClose(): void }) {
  const cols = useCollectionTree().filter((c) => !c.problem);
  const [id, setId] = useState<string>();
  const col = cols.find((c) => c.id === id) ?? cols[0];
  const count = (nodes: CollectionNode[]): number => nodes.reduce((n, x) => n + (x.kind === 'folder' ? count(x.items) : 1), 0);
  const rows = (nodes: CollectionNode[], depth: number): ReactNode[] =>
    nodes.flatMap((n) =>
      n.kind === 'folder'
        ? [
            <div key={n.id} className="flex items-center gap-2 py-1 border-b border-line/50" style={{ paddingLeft: depth * 14 }}>
              <span className="font-medium truncate flex-1">{n.name}</span>
              <Button size="sm" onClick={() => onPick(col!.id, n.id)} disabled={!count(n.items)} data-pick-folder={n.name}>
                Add {count(n.items)} chained
              </Button>
            </div>,
            ...rows(n.items, depth + 1),
          ]
        : [
            <button
              key={n.id}
              className={cx('w-full flex items-center gap-2 py-1 text-left hover:bg-hover rounded')}
              style={{ paddingLeft: depth * 14 + 4 }}
              onClick={() => onPick(col!.id, n.id)}
              data-pick-request={n.name}
            >
              {n.kind === 'http' ? (
                <span className={`mono text-xs w-14 shrink-0 method-${n.request.method}`}>{n.request.method}</span>
              ) : (
                <span className="mono text-xs w-14 shrink-0 text-muted">GQL</span>
              )}
              <span className="truncate">{n.name}</span>
            </button>,
          ],
    );
  return (
    <Modal title="Add steps from a collection" onClose={onClose} width={620}>
      {!cols.length ? (
        <p className="text-sm text-muted">No collections in this workspace yet.</p>
      ) : (
        <div className="grid gap-3 text-sm" data-collection-picker>
          <Select aria-label="Collection" value={col?.id} onChange={(e) => setId(e.target.value)}>
            {cols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted">A request becomes one step; a folder adds its requests in order, each waiting for the one before it, with ids and tokens from saved examples extracted.</p>
          <div className="max-h-[50vh] overflow-auto">{col && rows(col.items, 0)}</div>
        </div>
      )}
    </Modal>
  );
}
