import { BookOpen, ChevronLeft, Code2, FlaskConical, Network, Play, Radio, RefreshCw, Save, Square, Wand2, FileCheck2 } from 'lucide-react';
import { AiAction } from '../components/ai/AiAction';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantContext } from '../lib/assistant-context';
import { parse, print } from 'graphql';
import { asError, call, on, type NormalizedError } from '../api';
import { copyQuietly } from '../lib/clipboard';
import { confirmAction, persisted, toastError, useApp } from '../store';
import { useIntent, useSendShortcut, useSaveShortcut } from '../hooks';
import { openRef, reportIfGone } from '../lib/open-ref';
import { setGraphQLSchema } from '../monaco';
import type { AuthConfig, CheckConfig, CheckResult, Collection, HttpRequestSpec, HttpResponseData, KeyValue, SavedGraphQLRequest } from '../types';
import { CodeModal } from '../components/CodeModal';
import { formatMs, uid } from '../lib/format';
import { AssertionEditor } from '../components/AssertionEditor';
import { AuthEditor } from '../components/AuthEditor';
import { CodeEditor } from '../components/CodeEditor';
import { addToFolder, findNode, mapNodes } from '../components/CollectionTree';
import { SaveModal } from './rest/dialogs';
import { useSticky } from '../lib/sticky';
import { useDoc } from '../lib/docs';
import { NEW_TAB_TITLE, tabTitle, useSingleEditorTab } from '../components/EditorTabs';
import { RequestBreadcrumb } from '../components/RequestBreadcrumb';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { ScriptsPanel } from '../components/ScriptsPanel';
import { saveResponseVariable } from '../lib/save-variable';
import { JsonTree, RawView } from '../components/JsonView';
import { JsonTable, tableRowsOf } from '../components/JsonTable';
import { CheckList, ErrorPanel } from '../components/Results';
import { VarInput } from '../components/VarInput';
import { Badge, Bar, Button, cx, Empty, FilterInput, SECTION_LABEL, SectionTitle, Select, Split, statusTone, Tabs, Tooltip, VirtualList } from '../components/ui';
import { ResponseSplit } from '../components/ResponseSplit';
import { saveAsTestFile, saveAsTestMenuItem } from '../lib/save-test';
import { currentCollectionTree, refreshCollections, useCollectionTree } from '../lib/collections-store';
import { useExternalChange } from '../lib/external-change';
import { extensionForMime, jsonLines, jsonMin, jsonPretty, objectsToCsv, outputFileName } from '@testpion/shared';
import { OutputActions, OutputHeader } from '../components/output/OutputFrame';
import type { OutputFormatSpec, OutputSpec } from '../components/output/output-core';

interface SchemaType {
  name: string;
  kind: string;
  description?: string;
  fields?: Array<{ name: string; type: string; description?: string; deprecated?: string; args?: Array<{ name: string; type: string; description?: string }> }>;
  enumValues?: Array<{ name: string; description?: string }>;
  possibleTypes?: string[];
  interfaces?: string[];
}
interface SchemaSummary {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: SchemaType[];
  directives: Array<{ name: string; description?: string; locations: string[] }>;
}

interface Draft {
  endpoint: string;
  query: string;
  variables: string;
  headers: KeyValue[];
  auth?: AuthConfig;
  assertions: CheckConfig[];
  operationName?: string;
  collectionId?: string;
  requestId?: string;
  name: string;
  preRequestScript?: string;
  testScript?: string;
  /** Subscriptions: the connection_init payload (JSON), e.g. { "authorization": "Bearer {{token}}" }. */
  connectionParams?: string;
  /** The saved version this editor holds (gqlSnapshot), to follow it on disk (WF-15); unsaved: undefined. */
  base?: string;
}

/** A saved GraphQL request's fields, compared to tell unsaved edits and a change on disk apart. */
function gqlSnapshot(x: Pick<Draft, 'endpoint' | 'query' | 'variables' | 'headers' | 'auth' | 'operationName' | 'assertions' | 'preRequestScript' | 'testScript'>): string {
  return JSON.stringify([x.endpoint, x.query, x.variables, x.headers ?? [], x.auth ?? null, x.operationName ?? null, x.assertions ?? [], x.preRequestScript || null, x.testScript || null]);
}

interface SubEvent {
  type: 'status' | 'next' | 'error' | 'complete';
  time: number;
  data?: unknown;
  message?: string;
  /** Given as it arrives: the row's key and what the selection names (the list keeps the last 2,000, so a position is not stable). */
  seq?: number;
}
const MAX_SUB_EVENTS = 2000;

const DEFAULT_QUERY = `# Write your query. Ctrl+Space for schema-aware suggestions, Ctrl+Enter to run.
query GetPatient($id: ID!) {
  patient(id: $id) {
    id
    name
  }
}
`;
/** GraphQL variables as editor text: saved requests may keep them as a JSON object. */
/** A saved request as this editor's fields (opening it, or taking the version on disk), with its snapshot as the base. */
function draftOf(collectionId: string, n: SavedGraphQLRequest): Partial<Draft> {
  const f = { endpoint: n.request.endpoint, query: n.request.query, variables: variablesText(n.request.variables), headers: n.request.headers ?? [], auth: n.request.auth, assertions: n.assertions ?? [], collectionId, requestId: n.id, name: n.name, operationName: n.request.operationName, preRequestScript: n.preRequestScript, testScript: n.testScript };
  return { ...f, base: gqlSnapshot(f) };
}

function variablesText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return JSON.stringify(v, null, 2);
}

const store = persisted<Draft>('graphql', { endpoint: '{{graphqlEndpoint}}', query: DEFAULT_QUERY, variables: '{\n  "id": "123"\n}', headers: [], auth: { type: 'inherit' }, assertions: [{ type: 'graphql-no-errors' }], name: NEW_TAB_TITLE.graphql });

export function GraphQLView() {
  // this document's draft (each tab of this editor is its own document)
  const { docId, active } = useDoc();
  const docDrafts = useMemo(() => store.forDoc(docId), [docId]);
  // drafts saved by older versions may hold the variables as an object: the editors need text
  const [d, setD] = useState<Draft>(() => {
    const x = docDrafts.load();
    return { ...x, variables: variablesText(x.variables) };
  });
  const [schema, setSchema] = useState<SchemaSummary>();
  const [sdl, setSdl] = useState<string>();
  const [introspecting, setIntrospecting] = useState(false);
  const [schemaError, setSchemaError] = useState<NormalizedError>();
  const [mockUrl, setMockUrl] = useState<string>();
  useEffect(() => void call<{ url: string } | null>('gql.mock.status').then((r) => setMockUrl(r?.url)), []);
  /** Serve fake data for the introspected schema on localhost, so a front end can work without the real API. */
  const toggleMock = async () => {
    try {
      if (mockUrl) {
        await call('gql.mock.stop');
        setMockUrl(undefined);
        useApp.getState().toast('GraphQL mock stopped', 'success');
        return;
      }
      if (!sdl) return useApp.getState().toast('Introspect the schema first, then mock it', 'error');
      const r = await call<{ url: string }>('gql.mock.start', { sdl });
      setMockUrl(r.url);
      const copied = await copyQuietly(r.url);
      useApp.getState().toast(`GraphQL mock running at ${r.url}${copied ? ' (copied)' : ''}. Every valid query gets fake, correctly typed data.`, 'success');
    } catch (e) {
      useApp.getState().toast(`Couldn't start the mock: ${asError(e).message}`, 'error');
    }
  };
  const [running, setRunning] = useState<string>();
  const [result, setResult] = useState<{ response?: HttpResponseData; errors?: unknown[]; checks?: CheckResult[]; error?: NormalizedError; operationType?: string; scriptLogs?: Array<{ phase: string; message: string }> }>();
  const [sub, setSub] = useState<'variables' | 'headers' | 'auth' | 'scripts' | 'tests' | 'connection'>('variables');
  // a running subscription and its events
  const [subscription, setSubscription] = useState<{ id: string; protocol: string }>();
  const [events, setEvents] = useState<SubEvent[]>();
  const [eventSel, setEventSel] = useState<number>();
  const [resTab, setResTab] = useState<'response' | 'table' | 'raw' | 'tests'>('response');
  const env = useApp((s) => s.environment);
  // "Ask the assistant" includes the operation and its latest result (secrets are hidden by the backend)
  useAssistantContext(
    'graphql',
    useCallback(() => {
      if (!d.endpoint && !String(d.query ?? '').trim()) return undefined;
      const res = result?.response;
      return {
        label: `GraphQL ${d.name || d.operationName || 'operation'} · ${d.endpoint}${res ? ` · ${res.status}` : result?.error ? ' · error' : ''}`,
        context: {
          graphql: { name: d.name, endpoint: d.endpoint, operationName: d.operationName, query: String(d.query ?? '').slice(0, 6000), variables: (typeof d.variables === 'string' ? d.variables : JSON.stringify(d.variables ?? '')).slice(0, 2000), headers: (d.headers ?? []).filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: h.value })) },
          ...(res ? { response: { status: res.status, body: res.bodyPreview.slice(0, 4000), errors: result?.errors?.slice(0, 10) } } : {}),
          ...(result?.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
          ...(sdl ? { schemaExcerpt: sdl.slice(0, 4000) } : {}),
        },
      };
    }, [d, result, sdl]),
    active,
  );
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  useEffect(() => docDrafts.save(d), [d, docDrafts]);

  const operations = useMemo(() => {
    try {
      return parse(d.query).definitions.flatMap((x) => (x.kind === 'OperationDefinition' ? [{ name: x.name?.value, type: x.operation }] : []));
    } catch {
      return [];
    }
  }, [d.query]);

  const introspectNow = async () => {
    setIntrospecting(true);
    setSchemaError(undefined);
    try {
      const r = await call<{ sdl: string; summary: SchemaSummary }>('gql.introspect', { request: { endpoint: d.endpoint, headers: d.headers, auth: d.auth?.type === 'inherit' ? undefined : d.auth }, environment: env });
      setSchema(r.summary);
      setSdl(r.sdl);
      setGraphQLSchema(r.sdl);
      useApp.getState().toast(`Schema loaded: ${r.summary.types.length} types`, 'success');
    } catch (e) {
      setSchemaError(asError(e));
    } finally {
      setIntrospecting(false);
    }
  };

  // schema explorer ▸ Build: a whole operation for a root field (variables with placeholder values)
  const buildOperation = async (field: string) => {
    if (!sdl) return;
    try {
      const op = await call<{ operationName: string; query: string; variables: Record<string, unknown> }>('gql.buildOperation', { sdl, field });
      const current = d.query.trim();
      if (current && current !== op.query.trim() && !(await confirmAction({ title: `Replace the query with ${op.operationName}?`, message: 'The editor has a query already. The built operation and its variables replace it.', confirmLabel: 'Replace' }))) return;
      set({ query: op.query, variables: JSON.stringify(op.variables, null, 2), operationName: op.operationName });
      setSub('variables');
    } catch (e) {
      toastError(e);
    }
  };

  const selectedOp = operations.find((o) => o.name === d.operationName) ?? operations[0];

  // the down arrow of the response (JSON, minified, the raw body, the table) and of a subscription's events
  const outputName = (part: string | undefined, status?: number) => outputFileName({ name: ['graphql', selectedOp?.name || d.name || 'operation', part].filter(Boolean).join('-'), status, ext: '' });
  const responseSpec = useMemo<OutputSpec | undefined>(() => {
    const r = result?.response;
    if (!r) return undefined;
    const spooled = r.payloadPath ? { kind: 'response' as const, payloadPath: r.payloadPath } : undefined;
    const fromSpool = !!spooled && (r.truncated || r.json === undefined);
    const table = tableRowsOf(r.json);
    const formats: OutputFormatSpec[] = [];
    if (r.json !== undefined || (spooled && /json/i.test(r.contentType)))
      formats.push(
        { key: 'json', format: 'json', label: 'JSON (pretty)', default: resTab === 'response', ...(fromSpool ? { source: { ...spooled!, part: 'pretty' as const } } : { build: () => jsonPretty(r.json) }) },
        { key: 'json-min', format: 'json-min', ...(fromSpool ? { source: { ...spooled!, part: 'pretty' as const } } : { build: () => jsonMin(r.json) }) },
      );
    formats.push({ key: 'raw', format: 'raw', label: 'Raw body (as received)', default: resTab === 'raw', fileName: `${outputName(undefined, r.status)}.${extensionForMime(r.contentType)}`, ...(spooled ? { source: { ...spooled, part: 'body' as const } } : { build: () => r.bodyPreview }) });
    if (table) formats.push({ key: 'csv', format: 'csv', label: 'Table as CSV', default: resTab === 'table', build: () => objectsToCsv(table.rows) });
    return { id: 'graphql.response', what: 'GraphQL response', name: outputName(undefined, r.status), environment: env, formats, empty: r.bodyPreview || r.payloadPath ? undefined : 'The response is empty' };
  }, [result, resTab, env, selectedOp?.name, d.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const eventsSpec = useMemo<OutputSpec>(
    () => ({
      id: 'graphql.events',
      what: 'subscription events',
      name: outputName('events'),
      environment: env,
      empty: events?.length ? undefined : 'No events yet',
      formats: [
        { format: 'jsonl', build: () => jsonLines(events ?? []) },
        { format: 'json', build: () => jsonPretty(events ?? []) },
      ],
    }),
    [events, env, selectedOp?.name, d.name], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Code snippets: a GraphQL call is a JSON POST ({{variables}} are resolved by the snippet generator)
  const [showCode, setShowCode] = useState(false);
  const asHttpRequest = (): HttpRequestSpec => {
    const vars = d.variables.trim();
    let variables: string;
    try {
      variables = vars ? JSON.stringify(JSON.parse(vars), null, 2).replace(/\n/g, '\n  ') : '{}';
    } catch {
      variables = vars; // e.g. with {{variables}} that aren't valid JSON yet: kept as typed
    }
    const content = `{\n  "query": ${JSON.stringify(d.query)},\n  "variables": ${variables}${selectedOp?.name && operations.length > 1 ? `,\n  "operationName": ${JSON.stringify(selectedOp.name)}` : ''}\n}`;
    const hasType = d.headers.some((h) => h.enabled !== false && h.key.toLowerCase() === 'content-type');
    return {
      method: 'POST',
      url: d.endpoint,
      headers: [...d.headers, ...(hasType ? [] : [{ key: 'Content-Type', value: 'application/json', enabled: true }])],
      auth: d.auth,
      body: { type: 'json', content },
    };
  };
  const isSubscription = selectedOp?.type === 'subscription';
  useEffect(
    () =>
      on<{ id: string; event: SubEvent }>('gql.subscription', (p) => {
        if (p.id !== subscriptionRef.current) return;
        const event = { ...p.event, seq: ++eventSeq.current };
        setEvents((xs) => (xs && xs.length < MAX_SUB_EVENTS ? [...xs, event] : [...(xs ?? []), event].slice(-MAX_SUB_EVENTS)));
        if (p.event.type === 'complete' || (p.event.type === 'status' && p.event.message === 'Connection closed')) setSubscription(undefined);
      }),
    [],
  );
  const subscriptionRef = useRef<string | undefined>(undefined);
  subscriptionRef.current = subscription?.id;
  const eventSeq = useRef(0);
  const selectedEvent = useMemo(() => (eventSel === undefined ? undefined : events?.find((e) => e.seq === eventSel)), [events, eventSel]);
  const subscribe = async () => {
    setEvents([]);
    setEventSel(undefined);
    setResult(undefined);
    try {
      const r = await call<{ id: string; protocol: string }>('gql.subscribe', {
        request: { endpoint: d.endpoint, query: d.query, variables: d.variables, headers: d.headers, auth: d.auth },
        environment: env,
        collectionId: d.collectionId,
        operationName: d.operationName && operations.some((o) => o.name === d.operationName) ? d.operationName : undefined,
        connectionParams: d.connectionParams,
      });
      setSubscription(r);
    } catch (e) {
      setEvents(undefined);
      setResult({ error: asError(e) });
    }
  };
  const unsubscribe = () => subscription && void call('gql.unsubscribe', { id: subscription.id }).then(() => setSubscription(undefined), toastError);

  const run = async () => {
    if (isSubscription) return subscribe();
    setEvents(undefined);
    const id = uid('gql-');
    setRunning(id);
    useApp.getState().setActivity(id, 'Running GraphQL operation');
    try {
      const opName = d.operationName && operations.some((o) => o.name === d.operationName) ? d.operationName : operations.length > 1 ? operations[0]?.name : undefined;
      const r = await call('gql.send', {
        id,
        request: { endpoint: d.endpoint, query: d.query, variables: d.variables, operationName: opName, headers: d.headers, auth: d.auth?.type === 'inherit' ? undefined : d.auth },
        environment: env,
        collectionId: d.collectionId,
        requestId: d.requestId,
        name: d.name,
        operationName: opName,
        assertions: d.assertions,
        preRequestScript: d.preRequestScript,
        testScript: d.testScript,
      });
      setResult(r);
      if (r.checks?.some((c: CheckResult) => !c.passed)) setResTab('tests');
    } catch (e) {
      setResult({ error: asError(e) });
    } finally {
      setRunning(undefined);
      useApp.getState().setActivity(id);
    }
  };
  useSendShortcut('graphql', () => !running && void run());

  // collections sidebar (like REST): folders, new GraphQL requests, drag and drop, run. The outline: a request opened
  // from it is read from its whole collection
  const collections = useCollectionTree();
  const loadCollections = refreshCollections;
  const saveCollection = async (c: Collection) => {
    await call('col.save', c);
    await loadCollections();
  };
  const [schemaOpen, setSchemaOpen] = useSticky<boolean>('gql:schemaOpen', false);
  const [saving, setSaving] = useState(false);
  const openNode = (c: Collection, n: SavedGraphQLRequest) => {
    useApp.getState().markPlace('graphql', { collectionId: c.id, requestId: n.id });
    setD(draftOf(c.id, n) as Draft);
  };
  // the request changed on disk (a pull, another editor): follow it, or ask when it has unsaved edits (WF-15)
  useExternalChange<SavedGraphQLRequest>({
    kinds: ['collections'],
    items: () => (d.collectionId && d.requestId ? [{ key: d.requestId, label: d.name, base: d.base, dirty: gqlSnapshot(d) !== d.base }] : []),
    read: async () => {
      const c = d.collectionId ? await call<Collection>('col.get', { id: d.collectionId }).catch(() => undefined) : undefined;
      const n = c && d.requestId ? findNode(c.items, d.requestId) : undefined;
      const out = new Map<string, { snapshot: string; value: SavedGraphQLRequest }>();
      if (n?.kind === 'graphql') out.set(n.id, { snapshot: draftOf(c!.id, n).base!, value: n });
      return out;
    },
    take: (_id, n, snapshot) => setD((x) => (x.requestId === n.id ? { ...x, ...draftOf(x.collectionId!, n), base: snapshot } : x)),
    keep: (_id, snapshot) => set({ base: snapshot }),
  });

  useIntent('graphql', async (p) => {
    if (p?.reset) setD({ ...docDrafts.load(), query: DEFAULT_QUERY, collectionId: undefined, requestId: undefined, name: NEW_TAB_TITLE.graphql });
    // a GraphQL query sent earlier (History ▸ Open): what was sent, in its own tab, not saved anywhere yet
    if (p?.request && typeof p.request === 'object') {
      const r = p.request as { endpoint?: string; query?: string; variables?: unknown; headers?: Draft['headers']; auth?: Draft['auth']; operationName?: string };
      setD({ ...docDrafts.load(), endpoint: r.endpoint ?? '', query: r.query ?? '', variables: variablesText(r.variables), headers: r.headers ?? [], auth: r.auth, operationName: r.operationName, collectionId: undefined, requestId: undefined, name: String(p.name ?? NEW_TAB_TITLE.graphql) });
    }
    if (p?.collectionId) {
      const c = await call<Collection>('col.get', { id: p.collectionId }).catch(() => undefined);
      const n = c && (findNode(c.items, p.requestId) as SavedGraphQLRequest | undefined);
      if (n?.kind === 'graphql') openNode(c!, n);
      // an HTTP request opens in its own editor; one that is gone says so
      else if (n) void openRef({ kind: 'request', collectionId: c!.id, requestId: n.id, protocol: 'http' });
      else void reportIfGone({ kind: 'request', collectionId: String(p.collectionId), requestId: String(p.requestId) });
    }
  });

  const save = async () => {
    if (!currentCollectionTree().some((x) => x.id === d.collectionId) || !d.requestId) return setSaving(true);
    return saveTo(d.collectionId!, d.name);
  };
  const saveTo = async (collectionId: string, name: string, folderId?: string) => {
    const c = await call<Collection>('col.get', { id: collectionId }).catch(() => undefined);
    if (!c) return useApp.getState().toast('That collection no longer exists — pick another one', 'error');
    // keep what this view doesn't edit (favorite …) when updating a saved request
    const before = d.requestId ? (findNode(c.items, d.requestId) as SavedGraphQLRequest | undefined) : undefined;
    const node: SavedGraphQLRequest = {
      ...(before?.kind === 'graphql' ? before : {}),
      kind: 'graphql',
      id: d.requestId ?? uid('gql-'),
      name,
      request: { endpoint: d.endpoint, query: d.query, variables: d.variables, headers: d.headers, auth: d.auth, operationName: d.operationName },
      assertions: d.assertions,
      preRequestScript: d.preRequestScript || undefined,
      testScript: d.testScript || undefined,
    };
    const items = d.requestId && findNode(c.items, d.requestId) ? mapNodes(c.items, (n) => (n.id === node.id ? node : n)) : addToFolder(c.items, folderId, node);
    await saveCollection({ ...c, items });
    set({ collectionId: c.id, requestId: node.id, name, base: gqlSnapshot(d) });
    useApp.getState().toast('Saved to collection', 'success');
  };

  useSaveShortcut('graphql', () => void save());

  const prettify = () => {
    try {
      set({ query: print(parse(d.query)) });
    } catch (e) {
      useApp.getState().toast(`Cannot format: ${(e as Error).message}`, 'error');
    }
  };

  // this editor's tab in the shared tab strip
  const saveTest = () => {
    let variables: Record<string, unknown> | undefined;
    try {
      variables = d.variables.trim() ? (JSON.parse(d.variables) as Record<string, unknown>) : undefined;
    } catch (e) {
      // never saved without the variables as if there were none: the file would run another query
      return useApp.getState().toast(`The variables are not valid JSON (${asError(e).message}): fix them, then save the test file`, 'error');
    }
    void saveAsTestFile(d.name || selectedOp?.name || 'GraphQL query', { kind: 'graphql', endpoint: d.endpoint, query: d.query, variables, operationName: operations.length > 1 ? selectedOp?.name : undefined, headers: d.headers, auth: d.auth }, d.assertions);
  };
  const renameTabTo = (name: string) => setD((x) => ({ ...x, name }));
  useSingleEditorTab('graphql', { title: tabTitle(d.name, NEW_TAB_TITLE.graphql), badge: 'GQL', badgeClass: 'kind-graphql', item: d.requestId, onRenameTo: renameTabTo, onSaveAsTest: saveTest });
  return (
    <div className="h-full flex flex-col" data-collection-id={d.collectionId}>
      {/* narrow windows: the secondary buttons show icons only (their tooltips name them), so the endpoint keeps its room */}
      <RequestBreadcrumb collectionId={d.collectionId} requestId={d.requestId} name={tabTitle(d.name, NEW_TAB_TITLE.graphql)} onSave={() => void save()} actions={[saveAsTestMenuItem(saveTest)]} />
      <div className="@container flex items-center gap-2 p-2 border-b border-line shrink-0">
        <Badge tone="accent">{isSubscription ? 'WS' : 'POST'}</Badge>
        <VarInput ariaLabel="GraphQL endpoint" className="flex-1 min-w-40 h-8" value={d.endpoint} onChange={(endpoint) => set({ endpoint })} placeholder="https://api.example.com/graphql" />
        <Button icon={<RefreshCw size={13} className={introspecting ? 'spin' : ''} />} onClick={introspectNow} disabled={introspecting} reason="Still introspecting" title="Introspect the schema (autocomplete, validation, schema explorer)">
          <span className="hidden @[52rem]:inline">Introspect</span>
        </Button>
        <Button icon={<Network size={13} />} variant={schemaOpen ? 'soft' : 'default'} aria-pressed={schemaOpen} title="Show or hide the schema explorer" onClick={() => setSchemaOpen(!schemaOpen)}>
          <span className="hidden @[52rem]:inline">Schema</span>
        </Button>
        <Tooltip content={mockUrl ? `Mock running at ${mockUrl}: click to stop` : sdl ? 'Serve fake data for this schema on localhost' : 'Introspect a schema first'}>
          <Button variant={mockUrl ? 'soft' : 'default'} icon={<FlaskConical size={13} />} onClick={() => void toggleMock()} disabled={!mockUrl && !sdl} reason="Introspect the schema first">
            <span className="hidden @[52rem]:inline">{mockUrl ? 'Mock on' : 'Mock'}</span>
          </Button>
        </Tooltip>
        {operations.length > 1 && (
          <Select aria-label="Operation" value={d.operationName ?? operations[0]?.name ?? ''} onChange={(e) => set({ operationName: e.target.value })}>
            {operations.map((o) => (
              <option key={o.name ?? 'anon'} value={o.name}>
                {o.type} {o.name ?? '(anonymous)'}
              </option>
            ))}
          </Select>
        )}
        {subscription ? (
          <Button variant="danger" icon={<Square size={12} />} onClick={unsubscribe}>
            Stop
          </Button>
        ) : running ? (
          <Button variant="danger" icon={<Square size={12} />} onClick={() => void call('http.cancel', { id: running }).catch(toastError)}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" icon={isSubscription ? <Radio size={13} /> : <Play size={13} />} onClick={run} title={isSubscription ? 'Subscribe over WebSocket (Ctrl+Enter)' : 'Run (Ctrl+Enter)'}>
            {isSubscription ? 'Subscribe' : 'Run'}
          </Button>
        )}
        <Button icon={<Code2 size={13} />} title="The request as code: cURL, fetch, Python and more" onClick={() => setShowCode(true)}>
          <span className="hidden @[52rem]:inline">Code</span>
        </Button>
        <Button
          icon={<FileCheck2 size={13} />}
          title="Save as a YAML test file (tests/graphql) for the Tests view, testpion test and CI"
          onClick={saveTest}
        >
          <span className="hidden @[52rem]:inline">Test</span>
        </Button>
        <Button icon={<Save size={13} />} onClick={save} title="Save to a collection (Ctrl+S)">
          <span className="hidden @[52rem]:inline">Save</span>
        </Button>
      </div>
      {saving && (
        <SaveModal
          collections={collections}
          defaultName={d.requestId ? d.name : d.operationName ?? operations[0]?.name ?? d.name}
          onClose={() => setSaving(false)}
          onSave={(cid, name, folder) => (setSaving(false), void saveTo(cid, name, folder))}
          onCreate={saveCollection}
        />
      )}
      {showCode && <CodeModal request={asHttpRequest()} collectionId={d.collectionId} requestId={d.requestId} onClose={() => setShowCode(false)} />}
      <div className="flex-1 min-h-0">
        <Split id="gql-schema" initial={74} min={40} collapsedSecond={!schemaOpen}>
          <ResponseSplit id="gql-main" initialSide={50}>
            <div className="h-full flex flex-col">
              <Bar className="text-xs text-muted">
                <span className="font-medium text-fg">{d.name}</span>
                {operations[0] && <Badge>{operations[0].type}</Badge>}
                <Button size="sm" variant="ghost" className="ml-auto" icon={<Wand2 size={12} />} onClick={prettify}>
                  Prettify
                </Button>
                <AiAction
                  variant="ghost"
                  label="Generate"
                  request={() => ({
                    task: 'generate-query',
                    title: 'Generate GraphQL query',
                    context: { schemaSdl: sdl?.slice(0, 20000) ?? 'unknown — introspect first', currentQuery: d.query },
                    question: '',
                    apply: { label: 'Use this query', run: (code) => (/^\s*(query|mutation|subscription|fragment|\{)/.test(code) ? set({ query: code }) : 'it has no GraphQL operation') },
                  })}
                />
              </Bar>
              <div className="flex-1 min-h-0">
                <Split id="gql-editor-vars" direction="vertical" initial={65}>
                  <CodeEditor language="graphql" path="query.graphql" value={d.query} onChange={(query) => set({ query })} />
                  <div className="h-full flex flex-col">
                    <Tabs label="Query"
                      value={sub}
                      onChange={setSub}
                      tabs={[
                        { id: 'variables', label: 'Variables' },
                        { id: 'headers', label: 'Headers', badge: d.headers.length },
                        { id: 'auth', label: 'Auth' },
                        { id: 'scripts', label: 'Scripts', badge: (d.preRequestScript?.trim() ? 1 : 0) + (d.testScript?.trim() ? 1 : 0) || undefined },
                        ...(isSubscription ? [{ id: 'connection' as const, label: 'Connection' }] : []),
                        { id: 'tests', label: 'Tests', badge: d.assertions.length },
                      ]}
                    />
                    <div className="flex-1 min-h-0 overflow-auto">
                      {sub === 'variables' && <CodeEditor language="json" value={d.variables} onChange={(variables) => set({ variables })} minimal />}
                      {sub === 'headers' && (
                        <div className="p-2">
                          <KeyValueEditor rows={d.headers} onChange={(headers) => set({ headers })} keyPlaceholder="Header" />
                        </div>
                      )}
                      {sub === 'auth' && <AuthEditor auth={d.auth} onChange={(auth) => set({ auth })} />}
                      {sub === 'connection' && (
                        <div className="h-full flex flex-col">
                          <p className="px-2 py-1.5 text-xs text-muted border-b border-line">Payload of <span className="mono">connection_init</span> (JSON), for servers that read auth there, e.g. {'{ "authorization": "Bearer {{token}}" }'}. The Auth tab is also sent as a handshake header.</p>
                          <div className="flex-1 min-h-0">
                            <CodeEditor language="json" value={d.connectionParams ?? ''} onChange={(connectionParams) => set({ connectionParams })} minimal />
                          </div>
                        </div>
                      )}
                      {sub === 'scripts' && <ScriptsPanel pre={d.preRequestScript ?? ''} post={d.testScript ?? ''} onPre={(v) => set({ preRequestScript: v })} onPost={(v) => set({ testScript: v })} />}
                      {sub === 'tests' && <AssertionEditor checks={d.assertions} onChange={(assertions) => set({ assertions })} groups={['Response', 'Body', 'GraphQL']} />}
                    </div>
                  </div>
                </Split>
              </div>
            </div>
            <div className="h-full flex flex-col min-h-0">
              {events && !result?.error ? (
                <div className="h-full flex flex-col min-h-0">
                  <OutputHeader
                    spec={eventsSpec}
                    left={
                      <>
                        <Badge tone={subscription ? 'ok' : 'default'}>{subscription ? 'subscribed' : 'ended'}</Badge>
                        {subscription?.protocol && <span className="text-xs text-muted mono">{subscription.protocol}</span>}
                        <span className="text-muted">{events.filter((e) => e.type === 'next').length} events</span>
                      </>
                    }
                  />
                  <div className="flex-1 min-h-0" data-output="graphql.events">
                  <Split id="gql-sub-events" direction="vertical" initial={45}>
                    <VirtualList
                      className="h-full"
                      items={events}
                      rowHeight={30}
                      keyOf={(e) => e.seq ?? e.time}
                      name="GraphQLEvents"
                      render={(e) => (
                        <button onClick={() => setEventSel(e.seq)} className={cx('w-full h-full flex items-center gap-2 px-3 text-left text-sm border-b border-line/50 hover:bg-hover', eventSel === e.seq && 'bg-accent-soft')}>
                          <span className="text-xs text-muted tabular-nums shrink-0">{new Date(e.time).toLocaleTimeString()}</span>
                          <Badge tone={e.type === 'next' ? 'accent' : e.type === 'error' ? 'bad' : 'default'}>{e.type}</Badge>
                          <span className="mono text-xs truncate">{e.message ?? JSON.stringify(e.data)}</span>
                        </button>
                      )}
                    />
                    <div className="h-full overflow-auto">{selectedEvent?.data !== undefined ? <JsonTree data={selectedEvent.data} /> : <Empty title="Select an event" />}</div>
                  </Split>
                  </div>
                </div>
              ) : result?.error ? (
                <ErrorPanel error={result.error} context={{ endpoint: d.endpoint, query: d.query }} />
              ) : result?.response ? (
                <>
                  <Bar className="text-sm">
                    <Badge tone={statusTone(result.response.status)}>{result.response.status}</Badge>
                    <span className="text-muted">{formatMs(result.response.durationMs)}</span>
                    {!!result.errors?.length && <Badge tone="bad">{result.errors.length} GraphQL error(s)</Badge>}
                  </Bar>
                  <Tabs label="Response"
                    value={resTab}
                    onChange={setResTab}
                    tabs={[
                      { id: 'response', label: 'Response' },
                      ...(tableRowsOf(result.response.json) ? [{ id: 'table' as const, label: 'Table' }] : []),
                      { id: 'raw', label: 'Raw' },
                      { id: 'tests', label: 'Tests', badge: result.checks?.length },
                    ]}
                    right={responseSpec && <OutputActions spec={responseSpec} />}
                  />
                  <div className="flex-1 min-h-0" data-output="graphql.response">
                    {resTab === 'response' && (result.response.json !== undefined ? <JsonTree data={result.response.json} onAssert={(a) => (set({ assertions: [...d.assertions, a as never] }), useApp.getState().toast(`Added a check on ${a.path} (Tests tab)`, 'success'))} onSaveVariable={(v) => void saveResponseVariable(v, env, d.testScript).then((testScript) => testScript !== undefined && set({ testScript }))} /> : <RawView text={result.response.bodyPreview} />)}
                    {resTab === 'raw' && <RawView text={result.response.bodyPreview} />}
                    {resTab === 'table' && (() => {
                      const t = tableRowsOf(result.response.json);
                      return t ? <JsonTable rows={t.rows} path={t.path} /> : <Empty title="No list of objects in this response" />;
                    })()}
                    {resTab === 'tests' && (
                      <div className="h-full overflow-auto">
                        <CheckList checks={result.checks ?? []} />
                        {!!result.scriptLogs?.length && (
                          <div className="border-t border-line p-3">
                            <div className="text-xs font-medium text-muted mb-1">Script output</div>
                            <pre className="mono text-xs whitespace-pre-wrap break-all">{result.scriptLogs.map((l) => `[${l.phase}] ${l.message}`).join('\n')}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <Empty
                  icon={<Play size={26} />}
                  title="Run the operation to see the response"
                  actions={[{ label: 'Run (Ctrl+Enter)', icon: <Play size={12} />, onClick: () => void run(), disabled: !!running, title: 'Still running' }]}
                >
                  Write a query or a mutation on the left; <b>Introspect</b> reads the endpoint's schema for autocomplete, validation and the schema explorer.
                </Empty>
              )}
            </div>
          </ResponseSplit>
          <div className="h-full flex flex-col min-h-0 bg-panel/50">
            <Bar className={SECTION_LABEL}>
              <Network size={13} /> Schema
              <button className="ml-auto normal-case font-normal text-muted hover:text-fg" onClick={() => setSchemaOpen(false)} aria-label="Hide the schema">
                Hide
              </button>
            </Bar>
            <div className="flex-1 min-h-0">
              <SchemaExplorer schema={schema} error={schemaError} sdl={sdl} onInsert={(f) => set({ query: d.query.replace(/\}\s*$/, `  ${f}\n}\n`) })} onBuild={(f) => void buildOperation(f)} onIntrospect={introspectNow} loading={introspecting} />
            </div>
          </div>
        </Split>
      </div>
    </div>
  );
}

function SchemaExplorer({ schema, error, sdl, onInsert, onBuild, onIntrospect, loading }: { schema?: SchemaSummary; error?: NormalizedError; sdl?: string; onInsert(field: string): void; onBuild(field: string): void; onIntrospect(): void; loading: boolean }) {
  const [filter, setFilter] = useState('');
  const [stack, setStack] = useState<string[]>([]);
  const [showSdl, setShowSdl] = useState(false);
  if (error) return <div className="overflow-auto">{<ErrorPanel error={error} />}</div>;
  if (!schema)
    return (
      <Empty icon={<BookOpen size={24} />} title="No schema loaded" actions={[{ label: 'Introspect schema', icon: <RefreshCw size={13} />, loading, onClick: onIntrospect }]}>
        The server describes its types and fields; the explorer and the editor's completion use them.
      </Empty>
    );
  const current = stack.length ? schema.types.find((t) => t.name === stack[stack.length - 1]) : undefined;
  const roots = [schema.queryType, schema.mutationType, schema.subscriptionType].filter(Boolean) as string[];
  const typeLink = (t: string) => {
    const name = t.replace(/[[\]!]/g, '');
    return (
      <button className="syn-number hover:underline mono" onClick={() => setStack([...stack, name])}>
        {t}
      </button>
    );
  };
  const f = filter.toLowerCase();
  return (
    <div className="h-full flex flex-col text-sm bg-panel/40">
      <div className="p-2 flex gap-1 border-b border-line">
        {stack.length > 0 && (
          <Button size="sm" variant="ghost" icon={<ChevronLeft size={12} />} onClick={() => setStack(stack.slice(0, -1))}>
            Back
          </Button>
        )}
        <FilterInput className="flex-1" placeholder="Search types and fields" label="Search types and fields" value={filter} onChange={setFilter} />
        <Button size="sm" variant="ghost" onClick={() => setShowSdl(!showSdl)}>
          SDL
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {showSdl ? (
          <RawView text={sdl ?? ''} />
        ) : current ? (
          <div className="p-3">
            <div className="flex items-center gap-2">
              <span className="font-semibold mono">{current.name}</span>
              <Badge>{current.kind.toLowerCase().replace('_', ' ')}</Badge>
            </div>
            {current.description && <p className="text-muted mt-1">{current.description}</p>}
            {current.interfaces?.length ? <p className="text-xs mt-1">implements {current.interfaces.map((i) => <span key={i}>{typeLink(i)} </span>)}</p> : null}
            <div className="mt-3 flex flex-col gap-2">
              {current.fields
                ?.filter((x) => !f || x.name.toLowerCase().includes(f))
                .map((x) => (
                  <div key={x.name} className="group">
                    <div className="flex items-start gap-2">
                      <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">
                        <button className={cx('mono syn-key hover:underline', x.deprecated && 'line-through')} title="Insert field" onClick={() => onInsert(x.name)}>
                          {x.name}
                        </button>
                        {x.args?.length ? <span className="text-muted mono text-xs">({x.args.map((a) => `${a.name}: ${a.type}`).join(', ')})</span> : null}
                        <span className="text-muted">:</span> {typeLink(x.type)}
                      </div>
                      {roots.includes(current.name) && (
                        <button
                          className="shrink-0 mt-0.5 opacity-60 group-hover:opacity-100 text-muted hover:text-fg flex items-center gap-1 text-xs"
                          title={`Build a ${current.name === schema.mutationType ? 'mutation' : current.name === schema.subscriptionType ? 'subscription' : 'query'} for ${x.name}: variables for its arguments and a selection of its fields`}
                          aria-label={`Build operation for ${x.name}`}
                          onClick={() => onBuild(`${current.name}.${x.name}`)}
                        >
                          <Wand2 size={12} /> Build
                        </button>
                      )}
                    </div>
                    {x.description && <div className="text-xs text-muted">{x.description}</div>}
                    {x.deprecated && <div className="text-xs text-warn">Deprecated: {x.deprecated}</div>}
                  </div>
                ))}
              {current.enumValues?.map((v) => (
                <div key={v.name} className="mono">
                  {v.name} {v.description && <span className="text-xs text-muted font-sans">— {v.description}</span>}
                </div>
              ))}
              {current.possibleTypes?.length ? <div className="text-xs">Possible types: {current.possibleTypes.map((p) => <span key={p}>{typeLink(p)} </span>)}</div> : null}
            </div>
          </div>
        ) : (
          <div className="py-1">
            <SectionTitle size="sm" className="px-3 py-1">Root types</SectionTitle>
            {roots.map((r) => (
              <button key={r} className="w-full text-left px-3 py-1 hover:bg-hover mono" onClick={() => setStack([r])}>
                {r}
              </button>
            ))}
            <SectionTitle size="sm" className="px-3 py-1 mt-2">All types ({schema.types.length})</SectionTitle>
            {schema.types
              .filter((t) => !roots.includes(t.name) && (!f || t.name.toLowerCase().includes(f) || t.fields?.some((x) => x.name.toLowerCase().includes(f))))
              .map((t) => (
                <button key={t.name} className="w-full text-left px-3 py-1 hover:bg-hover flex items-center gap-2" onClick={() => setStack([t.name])}>
                  <span className="mono">{t.name}</span>
                  <span className="text-2xs text-muted">{t.kind.toLowerCase().replace('_', ' ')}</span>
                </button>
              ))}
            <SectionTitle size="sm" className="px-3 py-1 mt-2">Directives</SectionTitle>
            {schema.directives.map((dr) => (
              <div key={dr.name} className="px-3 py-0.5 mono text-xs" title={dr.description}>
                @{dr.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
