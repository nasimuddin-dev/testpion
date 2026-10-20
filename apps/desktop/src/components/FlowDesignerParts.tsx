/**
 * The flow designer's side parts: the hover card of a step (its last result), the inspector of the selected step, and
 * the picker that adds steps from a collection, and the blocks a flow is built from. The canvas and the toolbar are in
 * FlowDesigner.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Bot, CheckCheck, Code2, Columns2, Cpu, Eraser, FolderInput, GitBranch, Globe, Hourglass, LogOut, Radio, Repeat, ScrollText, Share2, Sparkles, Timer, Variable, Workflow } from 'lucide-react';
import { setDragBlock } from '../lib/drag-ref';
import type { PaletteCommand } from './Shell';
import type { FlowStep } from '@testpion/shared';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { useCollectionTree } from '../lib/collections-store';
import { formatMs } from '../lib/format';
import { prettyBody } from '../lib/pretty';
import type { AuthConfig, CheckConfig, Collection, CollectionNode, KeyValue, TestResult } from '../types';
import { AssertionEditor } from './AssertionEditor';
import { AuthEditor } from './AuthEditor';
import { CodeBlock } from './CodeBlock';
import { CodeEditor } from './CodeEditor';
import { asMap, asRows, asText, BlockFields, RunControlFields, useCommitted } from './FlowBlockFields';
import { ControlBlockFields, GroupFields, UntilFields } from './FlowControlFields';
import { KeyValueEditor } from './KeyValueEditor';
import { VarInput } from './VarInput';
import { Badge, Button, cx, Field, Input, LinkButton, Modal, SectionTitle, Select, statusTone, Textarea } from './ui';

/* ------------------------------------------------------------------ the hover card */

/** The results read for hover cards, by run and step (a finished run's results do not change). */
const previews = new Map<string, TestResult | null>();

/** A step's last result on hover: its status, time, the request line and the first lines of the response (pretty). */
export function StepPreview({ step, result, runId }: { step: FlowStep; result?: TestResult; runId?: string }) {
  const key = runId ? `${runId}|${step.id}` : '';
  const [read, setRead] = useState<TestResult | null | undefined>(() => (key ? previews.get(key) : undefined));
  useEffect(() => {
    if (result || !key || previews.has(key)) return;
    let alive = true;
    call<{ items: TestResult[] } | TestResult[]>('runs.results', { runId, query: step.name, limit: 50 }).then(
      (page) => {
        const items = Array.isArray(page) ? page : page.items;
        const r = items.find((x) => x.id === step.id) ?? null;
        previews.set(key, r);
        if (alive) setRead(r);
      },
      () => alive && setRead(null),
    );
    return () => {
      alive = false;
    };
  }, [key, result, runId, step.id, step.name]);
  const r = result ?? read ?? undefined;
  if (!runId || (read === null && !result))
    return (
      <div className="p-3 text-xs text-muted" data-flow-preview-empty>
        <div className="font-medium text-fg mb-1 truncate">{step.name}</div>
        Not run yet: Run flow, then hover again to see its response.
      </div>
    );
  if (!r)
    return (
      <div className="p-3 text-xs text-muted">
        <div className="font-medium text-fg mb-1 truncate">{step.name}</div>
        Reading the last result…
      </div>
    );
  const code = r.checks.find((c) => c.type === 'status')?.actual;
  const body = r.output ? prettyBody(r.output).split('\n').slice(0, 14).join('\n') : '';
  return (
    <div className="text-xs" data-flow-preview-result={r.status}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="font-medium text-fg truncate flex-1">{step.name}</span>
        <Badge tone={statusTone(r.status)}>{r.status}</Badge>
        {code !== undefined && <Badge tone={statusTone(Number(code))}>{String(code)}</Badge>}
        <span className="text-muted tabular-nums">{formatMs(r.durationMs)}</span>
      </div>
      {r.input && <div className="px-3 pt-2 mono text-muted truncate">{r.input}</div>}
      {r.error && <div className="px-3 pt-2 text-bad line-clamp-2">{r.error.message}</div>}
      {body ? (
        <CodeBlock className="mono text-[11px] whitespace-pre-wrap break-all m-0 px-3 py-2 max-h-56 overflow-hidden" text={body} data-flow-preview-body />
      ) : (
        <div className="px-3 py-2 text-muted">No response body.</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the inspector */

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

export function StepInspector({
  file,
  step,
  raw,
  steps,
  lastRunId,
  update,
  actions,
  inheritedAuth,
}: {
  file: string;
  step: FlowStep;
  raw?: Record<string, unknown>;
  /** The auth the step inherits from the file's `defaults:` (tests.flow `inheritedAuth`), when it has none of its own. */
  inheritedAuth?: { auth: Record<string, unknown>; from: string };
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
  // a step without auth of its own runs with the file's `defaults: auth:` (inherited): "Inherit from defaults" shows it;
  // its own "No auth" then overrides it (written as auth: { type: none }), and Inherit removes the step's auth again
  const ownAuth = (req.auth ?? r.auth) as AuthConfig | undefined;
  const [auth, setAuth] = useCommitted<AuthConfig | undefined>(ownAuth, (a) =>
    update({ auth: !a || a.type === 'inherit' || (a.type === 'none' && !inheritedAuth) ? null : a }),
  );
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
            <AuthEditor
              auth={auth ?? { type: inheritedAuth ? 'inherit' : 'none' }}
              onChange={setAuth}
              allowInherit={false}
              inherited={inheritedAuth ? { auth: inheritedAuth.auth as unknown as AuthConfig, from: inheritedAuth.from } : undefined}
            />
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
      ) : ['condition', 'script', 'flow', 'log'].includes(step.type) ? (
        <BlockFields file={file} step={step} raw={r} steps={steps} update={update} />
      ) : ['set', 'assert'].includes(step.type) ? (
        <ControlBlockFields step={step} raw={r} update={update} />
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
          <UntilFields step={step} raw={r} update={update} />
          {!['delay', 'condition', 'log', 'set', 'assert'].includes(step.type) && (
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
          {step.type === 'assert' && (
            <div data-inspector-assertions>
              <SectionTitle>Checks</SectionTitle>
              <AssertionEditor checks={checks} onChange={setChecks} />
            </div>
          )}
          <RunControlFields step={step} raw={r} steps={steps} update={update} />
          <GroupFields step={step} steps={steps} update={update} />
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
export function CollectionPicker({ onPick, onClose }: { onPick(collection: string, item: string): void; onClose(): void }) {
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

/* ------------------------------------------------------------------ the blocks */

/** A block of the picker: what it adds (a step as written), its group and a line saying what it does. */
export interface PaletteBlock {
  type: string;
  label: string;
  group: 'Requests' | 'Logic' | 'Data' | 'Flow';
  detail: string;
  icon: ReactNode;
  step: Record<string, unknown>;
}

const i = (I: typeof Globe) => <I size={16} />;

/** The blocks a flow is built from (the block picker, the command palette's Add step: …). */
export const PALETTE: PaletteBlock[] = [
  {
    type: 'http',
    label: 'HTTP request',
    group: 'Requests',
    detail: 'Call a REST endpoint',
    icon: i(Globe),
    step: { name: 'HTTP request', type: 'http', method: 'GET', url: '{{baseUrl}}/', assertions: [{ type: 'status', expected: 200 }] },
  },
  {
    type: 'graphql',
    label: 'GraphQL',
    group: 'Requests',
    detail: 'Run a query or a mutation',
    icon: i(Share2),
    step: { name: 'GraphQL query', type: 'graphql', endpoint: '{{graphqlEndpoint}}', query: 'query {\n  __typename\n}\n', assertions: [{ type: 'graphql-no-errors' }] },
  },
  {
    type: 'grpc',
    label: 'gRPC call',
    group: 'Requests',
    detail: 'Call a method of a gRPC service',
    icon: i(Cpu),
    step: { name: 'gRPC call', type: 'grpc', target: '{{grpcTarget}}', method: 'package.Service/Method', message: {}, assertions: [{ type: 'grpc-status', expected: 'OK' }] },
  },
  {
    type: 'websocket',
    label: 'WebSocket',
    group: 'Requests',
    detail: 'Send messages, check what comes back',
    icon: i(Radio),
    step: { name: 'WebSocket', type: 'websocket', url: '{{wsUrl}}', send: ['hello'], waitMs: 1500, assertions: [{ type: 'length', path: '$.received', min: 1 }] },
  },
  {
    type: 'mcp',
    label: 'MCP tool call',
    group: 'Requests',
    detail: 'Call a tool of an MCP server',
    icon: i(Bot),
    step: { name: 'MCP tool call', type: 'mcp', server: 'my-server', tool: 'my_tool', arguments: {} },
  },
  {
    type: 'llm',
    label: 'LLM prompt',
    group: 'Requests',
    detail: 'Ask a model; check its answer',
    icon: i(Sparkles),
    step: { name: 'LLM prompt', type: 'llm', model: 'mock', prompt: 'Answer in one word: {{question}}' },
  },
  {
    type: 'condition',
    label: 'Condition (if / else)',
    group: 'Logic',
    detail: 'Branch on an expression: a true and a false output',
    icon: i(GitBranch),
    step: { name: 'Condition', type: 'condition', if: 'status == 200' },
  },
  {
    type: 'foreach',
    label: 'For each (loop)',
    group: 'Logic',
    detail: 'Run a request once per row of a list or dataset',
    icon: i(Repeat),
    step: { name: 'For each', type: 'http', method: 'GET', url: '{{baseUrl}}/items/{{id}}', forEach: [{ id: 1 }, { id: 2 }, { id: 3 }], assertions: [{ type: 'status', expected: 200 }] },
  },
  {
    type: 'wait',
    label: 'Wait until (poll)',
    group: 'Logic',
    detail: 'Repeat a request until a condition holds',
    icon: i(Timer),
    step: {
      name: 'Wait until',
      type: 'http',
      method: 'GET',
      url: '{{baseUrl}}/jobs/{{jobId}}',
      until: { if: "$.status == 'done'", every: '2s', timeout: '60s' },
      assertions: [{ type: 'status', expected: 200 }],
    },
  },
  { type: 'delay', label: 'Delay', group: 'Logic', detail: 'Pause the flow for a while', icon: i(Hourglass), step: { name: 'Wait', type: 'delay', ms: 1000 } },
  {
    type: 'finally',
    label: 'Finally (clean-up)',
    group: 'Logic',
    detail: 'Runs after every other step, whatever happened',
    icon: i(Eraser),
    step: { name: 'Clean up', type: 'http', method: 'DELETE', url: '{{baseUrl}}/', finally: true },
  },
  {
    type: 'set',
    label: 'Set variable',
    group: 'Data',
    detail: 'Keep values for the run, the environment …',
    icon: i(Variable),
    step: { name: 'Set variable', type: 'set', set: { value: '{{value}}' }, scope: 'run' },
  },
  {
    type: 'script',
    label: 'Script',
    group: 'Data',
    detail: 'Compute or reshape values with tp.*',
    icon: i(Code2),
    step: { name: 'Script', type: 'script', script: "tp.variables.set('value', 42);\n" },
  },
  {
    type: 'assert',
    label: 'Assert',
    group: 'Data',
    detail: 'Check the previous response or the variables',
    icon: i(CheckCheck),
    step: { name: 'Assert', type: 'assert', assertions: [{ type: 'status', expected: 200 }] },
  },
  { type: 'log', label: 'Log', group: 'Data', detail: 'Show a value in the run results', icon: i(ScrollText), step: { name: 'Log', type: 'log', message: 'Value: {{value}}' } },
  { type: 'flow', label: 'Sub-flow', group: 'Flow', detail: 'Run another flow file as one step', icon: i(Workflow), step: { name: 'Sub-flow', type: 'flow', file: 'other-flow.yaml' } },
];

/** A first step that runs as it is: a public API, a value extracted, a check (the empty flow's API example). */
export const API_EXAMPLE: Record<string, unknown> = {
  name: 'Get a todo',
  type: 'http',
  method: 'GET',
  url: 'https://jsonplaceholder.typicode.com/todos/1',
  extract: { todoTitle: '$.title' },
  assertions: [
    { type: 'status', expected: 200 },
    { type: 'equals', path: '$.id', expected: 1 },
  ],
};

/* ------------------------------------------------------------------ the block picker and the palette */

/** What the block picker (the command palette at a port) lists: the blocks by group, saved requests, other flows, more. */
export function blockPickerCommands(o: {
  collections: Collection[];
  subflows: string[];
  add(step: Record<string, unknown>): void;
  addSaved(collection: string, item: string): void;
  addParallel(): void;
  output(): void;
  fromCollection(): void;
  generate?(): void;
}): PaletteCommand[] {
  const saved: PaletteCommand[] = [];
  for (const c of o.collections.filter((x) => !x.problem)) {
    const walk = (nodes: CollectionNode[], path: string) => {
      for (const n of nodes) {
        if (saved.length >= 400) return;
        if (n.kind === 'folder') walk(n.items, `${path} / ${n.name}`);
        else
          saved.push({
            id: `saved:${c.id}:${n.id}`,
            label: n.name,
            group: 'Saved requests',
            detail: `${path}${n.kind === 'http' ? ` · ${n.request.method} ${n.request.url}` : ''}`,
            icon: <FolderInput size={16} />,
            run: () => o.addSaved(c.id, n.id),
          });
      }
    };
    walk(c.items, c.name);
  }
  const list: PaletteCommand[] = [
    ...PALETTE.map((p) => ({ id: `block:${p.type}`, label: p.label, group: p.group, detail: p.detail, icon: p.icon, run: () => o.add(p.step) })),
    { id: 'block:parallel', label: 'Parallel group', group: 'Logic', detail: 'Two requests in a frame that may run at the same time', icon: <Columns2 size={16} />, run: o.addParallel },
    { id: 'block:output', label: 'Flow output…', group: 'Data', detail: 'What the flow returns (sub-flows, MCP tools, webhooks)', icon: <LogOut size={16} />, run: o.output },
    ...saved,
    ...o.subflows.map((f) => ({ id: `subflow:${f}`, label: f, group: 'Sub-flows', detail: 'Run this flow file as one step', icon: <Workflow size={16} />, run: () => o.add({ name: f.split('/').pop()!.replace(/\.[^.]+$/, ''), type: 'flow', file: f }) })),
    { id: 'more:collection', label: 'From a collection…', group: 'More', detail: 'A folder of saved requests, chained', icon: <FolderInput size={16} />, run: o.fromCollection },
    ...(o.generate ? [{ id: 'more:ai', label: 'Generate the flow with AI…', group: 'More', detail: 'Describe the flow; review the YAML', icon: <Sparkles size={16} />, run: o.generate }] : []),
  ];
  // the blocks' groups in their order (a command of a group may be written apart from the others)
  const rank = ['Requests', 'Logic', 'Data', 'Flow', 'Saved requests', 'Sub-flows', 'More'];
  return list
    .map((c, k) => [c, k] as const)
    .sort((a, b) => rank.indexOf(a[0].group ?? '') - rank.indexOf(b[0].group ?? '') || a[1] - b[1])
    .map(([c]) => c);
}

/**
 * The canvas's block palette (a pinnable side panel): the same blocks as the picker, by group, searchable. Drag a block
 * onto the canvas (after a step, into a connection, on a branch, or anywhere), or click it to add it after the selection.
 */
export function BlockPalette({ onAdd }: { onAdd(block: PaletteBlock): void }) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = PALETTE.filter((p) => words.every((w) => `${p.label} ${p.detail} ${p.group}`.toLowerCase().includes(w)));
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-flow-palette>
      <div className="p-2 border-b border-line">
        <Input className="h-7 min-h-7 text-sm" placeholder="Search blocks" aria-label="Search blocks" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto py-1">
        {shown.map((p, i) => (
          <div key={p.type}>
            {p.group !== shown[i - 1]?.group && <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{p.group}</div>}
            <button
              draggable
              data-flow-palette-block={p.type}
              title={`${p.detail}: drag onto the canvas, or click to add it after the selected step`}
              onDragStart={(e) => setDragBlock(e, p.type, p.label)}
              onClick={() => onAdd(p)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-hover cursor-grab active:cursor-grabbing"
            >
              <span className="text-muted shrink-0 [&_svg]:w-4 [&_svg]:h-4">{p.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm truncate">{p.label}</span>
                <span className="block text-xs text-muted truncate">{p.detail}</span>
              </span>
            </button>
          </div>
        ))}
        {!shown.length && <p className="px-3 py-4 text-xs text-muted">No matching blocks</p>}
      </div>
      <div className="border-t border-line p-2 text-xs text-muted grid gap-1">
        <span>Drag saved requests, folders, History entries and Debugger exchanges onto the canvas too.</span>
        <LinkButton icon={<FolderInput size={12} />} onClick={() => useApp.getState().set({ explorerInTests: true })} data-flow-show-explorer>
          Show the collections (Ctrl+B)
        </LinkButton>
      </div>
    </div>
  );
}
