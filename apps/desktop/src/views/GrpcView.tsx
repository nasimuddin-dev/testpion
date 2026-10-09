import { ArrivalSpark } from '../components/charts';
import { FileCode2, Plus, RefreshCw, Save, ScanSearch, Send, Sparkles, Square, Terminal, Trash2, Waypoints, FileCheck2, Bookmark, History, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantContext } from '../lib/assistant-context';
import { asError, call, on } from '../api';
import { persisted, toastError, useApp } from '../store';
import { FolderList } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { NEW_TAB_TITLE, useSingleEditorTab } from '../components/EditorTabs';
import { RequestBreadcrumb } from '../components/RequestBreadcrumb';
import { EnvironmentsPane, HistoryPane } from '../components/SidebarPanes';
import { useLibrary } from '../lib/library';
import { useSaveInCollection } from '../lib/save-in-collection';
import { useCollections } from '../lib/collections-store';
import { useIntent, useSaveShortcut } from '../hooks';
import type { KeyValue } from '../types';
import { CodeEditor } from '../components/CodeEditor';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { JsonTree } from '../components/JsonView';
import { VarInput } from '../components/VarInput';
import { Badge, Button, cx, Empty, Field, IconButton, Input, Split, Tabs, VirtualList } from '../components/ui';
import { ResponseSplit } from '../components/ResponseSplit';
import { pickTextFile } from '../lib/files';
import { useSticky } from '../lib/sticky';
import { useDoc } from '../lib/docs';
import { plural } from '../lib/format';
import { saveAsTestFile } from '../lib/save-test';
import { copyText } from '../lib/clipboard';

interface ProtoFile {
  name: string;
  text: string;
}
interface MethodInfo {
  name: string;
  service: string;
  method: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  example: unknown;
  requestSchema?: Record<string, unknown>;
}
interface GrpcResult {
  code: number;
  codeName: string;
  details: string;
  response?: unknown;
  messages?: Array<{ data: unknown; atMs: number }>;
  metadata: Array<[string, string]>;
  trailers: Array<[string, string]>;
  durationMs: number;
  method: string;
  target: string;
  streamStopped?: boolean;
  unresolved?: string[];
}

const drafts = persisted('grpc', {
  target: 'localhost:50051',
  method: '',
  message: '{}',
  metadata: [] as KeyValue[],
  protoFiles: [] as ProtoFile[],
  tls: false,
  timeoutMs: 30000,
  /** Public certificates (PEM or {{variables}}); the private key is never saved here. */
  ca: undefined as string | undefined,
  cert: undefined as string | undefined,
  /** Descriptors from server reflection (used instead of the proto files while set). */
  descriptorSet: undefined as string | undefined,
  reflectedFrom: undefined as string | undefined,
  /** A {{variable}} holding the client key (the key itself is never stored in the draft). */
  keyRef: undefined as string | undefined,
});

const kind = (m: MethodInfo) => (m.clientStreaming && m.serverStreaming ? 'bidi stream' : m.clientStreaming ? 'client stream' : m.serverStreaming ? 'server stream' : 'unary');

/** gRPC client: pick a method from .proto files, send a message (or a list, for client streams), see the response live. */
export function GrpcView() {
  // this document's draft (each tab of this editor is its own document)
  const { docId, active } = useDoc();
  const docDrafts = useMemo(() => drafts.forDoc(docId), [docId]);
  const [d, setD] = useState(docDrafts.load);
  const [methods, setMethods] = useState<MethodInfo[]>([]);
  const [protoError, setProtoError] = useState<string>();
  const [tab, setTab] = useState<'message' | 'metadata' | 'protos' | 'settings'>(() => (docDrafts.load().protoFiles.length ? 'message' : 'protos'));
  const [resTab, setResTab] = useState<'response' | 'metadata' | 'trailers'>('response');
  const [sending, setSending] = useState<string>();
  const [live, setLive] = useState<Array<{ data: unknown; atMs: number }>>([]);
  const [result, setResult] = useState<GrpcResult>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<number>();
  const [editing, setEditing] = useState<number>();
  const [reflecting, setReflecting] = useState(false);
  // saved requests (address, method, message, metadata, service definition, settings) with folders;
  // the client private key is never part of them
  type Saved = Omit<typeof d, 'keyRef'> & { keyRef?: string };
  const saved = useLibrary<Saved>('grpc');
  const [savedId, setSavedId] = useSticky<string | undefined>(`grpc:saved:${docId ?? 'main'}`, undefined, { persist: true });
  const currentSaved = saved.lib.items.find((i) => i.id === savedId);
  // New ▸ gRPC in a collection: the call is saved into that collection
  const [collectionId, setCollectionId] = useSticky<string | undefined>(`grpc:collection:${docId ?? 'main'}`, undefined);
  // descriptors fetched by reflection aren't an edit (a saved request without protos reflects when opened)
  const comparable = (x: Partial<typeof d>) => JSON.stringify({ ...x, descriptorSet: undefined, reflectedFrom: undefined });
  const saveDialog = useSaveInCollection(saved.lib.items, 'Save gRPC call');
  // the calls of a collection in the trash are hidden (they come back with it)
  const liveCollections = new Set(useCollections().map((c) => c.id));
  const savedDirty = !!currentSaved && comparable(currentSaved.data) !== comparable(d);
  const openSaved = async (id: string) => {
    const it = await saved.find(id);
    if (!it) return;
    setSavedId(id);
    // the previous request's protos / reflected descriptors must not carry over to this one
    const clean = { ...docDrafts.load(), protoFiles: [] as ProtoFile[], descriptorSet: undefined, reflectedFrom: undefined };
    const next = { ...clean, ...it.data };
    setD(next);
    setResult(undefined);
    setError(undefined);
    // saved without .proto files: describe the service through server reflection straight away
    if (!next.protoFiles.length && !next.descriptorSet && next.target) void reflect(next, true);
  };
  const saveRequest = async (asNew = false, folder?: string) => {
    if (currentSaved && !asNew) {
      await saved.put({ ...currentSaved, data: d });
      useApp.getState().toast(`Saved "${currentSaved.name}"`, 'success');
      return;
    }
    // every saved request belongs to a collection: the same dialog as a REST request's asks which (and its folder)
    const to = await saveDialog.ask({ name: tabTitle || d.method.split('/').pop() || 'gRPC request', collectionId, folder });
    if (!to) return;
    setCollectionId(to.collectionId);
    setSavedId(await saved.put({ name: to.name, folder: to.folder, collectionId: to.collectionId, data: d }));
  };
  // Ctrl+S saves this tab's call (asks for a name the first time)
  useSaveShortcut('grpc', () => void saveRequest());
  // History → open: fill in the address, method, message and metadata
  useIntent('grpc', (p) => {
    if (p?.collectionId && !p.savedId) setCollectionId(p.collectionId as string);
    if (p?.savedId) return openSaved(p.savedId);
    const r = p?.request as { target?: string; method?: string; message?: string; metadata?: KeyValue[] } | undefined;
    if (!r) return;
    setSavedId(undefined);
    setD((cur) => ({ ...cur, target: r.target ?? cur.target, method: r.method ?? cur.method, message: r.message || cur.message, metadata: r.metadata ?? cur.metadata }));
  });
  // a pasted private key stays in memory; a {{variable}} reference may be kept with the draft
  const [keyText, setKeyText] = useSticky(`grpc:key:${docId ?? 'main'}`, docDrafts.load().keyRef ?? '');
  useEffect(() => set({ keyRef: /^\s*\{\{[^}]+\}\}\s*$/.test(keyText) ? keyText.trim() : undefined }), [keyText]); // eslint-disable-line react-hooks/exhaustive-deps
  const tlsOptions = d.ca?.trim() || d.cert?.trim() || keyText.trim() ? { ca: d.ca, cert: d.cert, key: keyText } : undefined;
  const env = useApp((s) => s.environment);
  // "Ask the assistant" includes the call and its latest result (secrets are hidden by the backend)
  useAssistantContext(
    'grpc',
    useCallback(() => {
      if (!d.target && !d.method) return undefined;
      return {
        label: `gRPC ${d.method.split('/').pop() || '(no method)'} · ${d.target}${result ? ` · ${result.codeName}` : error ? ' · error' : ''}`,
        context: {
          grpc: { target: d.target, method: d.method, message: d.message.slice(0, 4000), metadata: d.metadata, tls: d.tls, protoFiles: d.protoFiles.map((f) => f.name) },
          ...(result ? { result: { code: result.code, codeName: result.codeName, details: result.details, response: result.response, trailers: result.trailers.slice(0, 20), durationMs: result.durationMs } } : {}),
          ...(error ? { error } : {}),
          ...(protoError ? { protoError } : {}),
        },
      };
    }, [d, result, error, protoError]),
    active,
  );
  const sendingRef = useRef<string | undefined>(undefined);
  sendingRef.current = sending;
  useEffect(() => docDrafts.save(d), [d, docDrafts]);

  // methods follow the proto files (or the reflected descriptors)
  useEffect(() => {
    if (!d.protoFiles.length && !d.descriptorSet) {
      setMethods([]);
      setProtoError(undefined);
      return;
    }
    const t = setTimeout(() => {
      call<MethodInfo[]>('grpc.describe', d.descriptorSet ? { descriptorSet: d.descriptorSet } : { protoFiles: d.protoFiles })
        .then((m) => {
          setMethods(m);
          setProtoError(undefined);
          setD((cur) => (cur.method && m.some((x) => x.name === cur.method) ? cur : { ...cur, method: m[0]?.name ?? '' }));
        })
        .catch((e) => setProtoError(asError(e).message));
    }, 300);
    return () => clearTimeout(t);
  }, [d.protoFiles, d.descriptorSet]);

  useEffect(
    () =>
      on<Array<{ id: string; data: unknown; atMs: number }>>('grpc.messages', (items) => {
        const mine = items.filter((i) => i.id === sendingRef.current);
        if (mine.length) setLive((l) => [...l, ...mine.map(({ data, atMs }) => ({ data, atMs }))]);
      }),
    [],
  );

  const current = methods.find((m) => m.name === d.method);
  const set = (patch: Partial<typeof d>) => setD((cur) => ({ ...cur, ...patch }));
  const useExample = () => current && set({ message: JSON.stringify(current.clientStreaming ? [current.example] : current.example, null, 2) });

  const addProto = async () => {
    const f = await pickTextFile('.proto');
    if (!f) return;
    set({ protoFiles: [...d.protoFiles.filter((p) => p.name !== f.name), { name: f.name, text: f.text }] });
    setTab('protos');
  };

  /** Ask the server for its services (gRPC server reflection) instead of using proto files. */
  const reflect = async (from: typeof d = d, quiet = false) => {
    setReflecting(true);
    try {
      const r = await call<{ services: string[]; descriptorSet: string; methods: MethodInfo[] }>('grpc.reflect', { target: from.target, tls: from.tls || undefined, tlsOptions, metadata: from.metadata, environment: env });
      // keep the method the request was saved with (functional update: the draft may have changed meanwhile)
      setD((cur) => (cur.target === from.target ? { ...cur, descriptorSet: r.descriptorSet, reflectedFrom: from.target } : cur));
      if (!quiet) useApp.getState().toast(`Server reflection: ${r.services.length} services, ${r.methods.length} methods`, 'success');
      setTab('message');
    } catch (e) {
      toastError(e);
    } finally {
      setReflecting(false);
    }
  };

  const send = async () => {
    if (!current) return;
    const id = `grpc-${Date.now().toString(36)}`;
    setSending(id);
    setLive([]);
    setError(undefined);
    setSelected(undefined);
    try {
      const r = await call<GrpcResult>('grpc.send', { id, target: d.target, method: d.method, message: d.message, metadata: d.metadata, ...(d.descriptorSet ? { descriptorSet: d.descriptorSet } : { protoFiles: d.protoFiles }), tls: d.tls || undefined, tlsOptions, timeoutMs: d.timeoutMs, environment: env });
      setResult(r);
      setResTab('response');
      if (r.unresolved?.length) useApp.getState().toast(`Unresolved variables: ${r.unresolved.join(', ')}`, 'error');
    } catch (e) {
      setResult(undefined);
      setError(asError(e).message);
    } finally {
      setSending(undefined);
    }
  };
  const stop = () => sending && call('grpc.cancel', { id: sending });

  const streamRows = sending ? live : (result?.messages ?? []);
  const selectedData = selected !== undefined ? streamRows[selected]?.data : undefined;
  const statusTone = result ? (result.code === 0 ? 'ok' : result.streamStopped ? 'warn' : 'bad') : 'default';
  const example = useMemo(() => (current ? JSON.stringify(current.example) : ''), [current]);

  // this editor's tab in the shared tab strip
  const saveTest = () => {
    let message: unknown = d.message;
    try {
      message = JSON.parse(d.message);
    } catch {
      /* kept as text */
    }
    void saveAsTestFile(`${d.method.split('/').pop() ?? 'gRPC call'} works`, { kind: 'grpc', target: d.target, method: d.method, message, metadata: d.metadata, tls: d.tls });
  };
  const [tabTitle, setTabTitle] = useSticky<string | undefined>(`grpc:title:${docId ?? 'main'}`, undefined, { persist: true });
  // a new tab is "New gRPC request" (the save dialog suggests the method's name)
  const title = currentSaved?.name ?? tabTitle ?? NEW_TAB_TITLE.grpc;
  // a saved call is renamed in the workspace; a new tab just gets the title
  const renameTabTo = async (name: string) => (currentSaved ? saved.put({ ...currentSaved, name }) : setTabTitle(name));
  useSingleEditorTab('grpc', { title, badge: 'gRPC', badgeClass: 'text-[#2ea99e]', item: savedId, onRenameTo: renameTabTo, onSaveAsTest: d.method ? saveTest : undefined });
  return (
    <Split id="grpc-saved" sidebar collapsed initial={18} min={12}>
    <SidebarShell
      id="grpc"
      panes={[
        {
          id: 'saved',
          label: 'Saved',
          icon: <Bookmark size={13} />,
          render: () => (
            <FolderList
              id="grpc-saved"
              title="Saved requests"
              itemNoun="request"
              addLabel="Save current request"
              folders={saved.lib.folders}
              selected={savedId}
              onSelect={openSaved}
              onAdd={(folder) => void saveRequest(true, folder)}
              ops={saved.ops}
              items={saved.lib.items.filter((i) => !i.collectionId || liveCollections.has(i.collectionId)).map((i) => ({ id: i.id, name: i.name, folder: i.folder, subtitle: i.data.method || i.data.target, icon: <Waypoints size={12} className="text-muted" /> }))}
              empty={
                <Empty title="No saved requests">
                  Save a request (address, method, message, metadata and its .proto files or reflection) to call it again later, and group requests in folders.
                </Empty>
              }
            />
          ),
        },
        { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
        { id: 'history', label: 'History', icon: <History size={13} />, render: () => <HistoryPane kind="grpc" noun="gRPC calls you make" /> },
      ]}
    />
    <div className="h-full flex flex-col min-w-0">
      <RequestBreadcrumb collectionId={currentSaved?.collectionId ?? collectionId} folder={currentSaved?.folder} name={title} onSave={() => void saveRequest()} />
      <div className="flex items-center gap-2 p-2 border-b border-line">
        <VarInput
          ariaLabel="gRPC server"
          className="w-72 h-8"
          value={d.target}
          onChange={(target) => set({ target })}
          placeholder="localhost:50051, grpcs://…, or paste a grpcurl command"
          onPasteText={(text) => {
            if (!/^\s*grpcurl(\.exe)?\s/.test(text)) return false;
            void call<{ target: string; method?: string; message?: string; metadata: Array<{ key: string; value: string }>; tls: boolean; protoFiles: string[]; timeoutMs?: number }>('grpc.parseGrpcurl', { text }).then(
              (g) => {
                set({ target: g.target, tls: g.tls, ...(g.method ? { method: g.method } : {}), ...(g.message ? { message: g.message } : {}), metadata: g.metadata.map((m) => ({ ...m, enabled: true })), ...(g.timeoutMs ? { timeoutMs: g.timeoutMs } : {}) });
                useApp.getState().toast(g.protoFiles.length ? `Filled in from grpcurl. Load the proto files it uses: ${g.protoFiles.join(', ')}` : 'Filled in from grpcurl (the methods come from server reflection)', 'success');
              },
              (e) => toastError(e),
            );
            return true;
          }}
        />
        <select className="field h-8 flex-1 min-w-0 mono text-xs" aria-label="Method" value={d.method} onChange={(e) => set({ method: e.target.value })} disabled={!methods.length}>
          {!methods.length && <option value="">Add a .proto file or use server reflection to choose a method</option>}
          {methods.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} ({kind(m)})
            </option>
          ))}
        </select>
        {sending ? (
          <Button variant="danger" icon={<Square size={12} />} onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" icon={<Send size={13} />} disabled={!current} onClick={() => void send()}>
            Invoke
          </Button>
        )}
        <Button
          icon={<Terminal size={13} />}
          disabled={!d.method}
          title="Copy the call as a grpcurl command ({{variables}} resolved)"
          onClick={() =>
            void call<string>('grpc.grpcurl', { target: d.target, method: d.method, message: d.message, metadata: d.metadata, tls: d.tls, protoFiles: d.descriptorSet ? [] : d.protoFiles.map((f) => f.name), timeoutMs: d.timeoutMs, environment: env })
              .then((cmd) => copyText(cmd, 'as grpcurl'), (e) => toastError(e))
          }
        >
          grpcurl
        </Button>
        <Button
          icon={<FileCheck2 size={13} />}
          disabled={!d.method}
          title="Save as a YAML test file (tests/grpc, using server reflection) for the Tests view, testpion test and CI"
          onClick={saveTest}
        >
          Test
        </Button>
        <Button icon={<Save size={13} />} title={currentSaved ? `Save changes to "${currentSaved.name}"` : 'Save this request'} onClick={() => void saveRequest()}>
          {savedDirty ? 'Save*' : 'Save'}
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        <ResponseSplit id="grpc-main" initialSide={45}>
          <div className="h-full flex flex-col min-h-0">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'message', label: current?.clientStreaming ? 'Messages' : 'Message' },
                { id: 'metadata', label: 'Metadata', badge: d.metadata.length },
                { id: 'protos', label: d.descriptorSet ? 'Service definition' : 'Proto files', badge: d.descriptorSet ? undefined : d.protoFiles.length },
                { id: 'settings', label: 'Settings' },
              ]}
            />
            {tab === 'message' && (
              <>
                <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-xs text-muted shrink-0">
                  {current ? (
                    <span className="truncate mono">
                      {current.requestType} → {current.responseType}
                    </span>
                  ) : (
                    <span>Choose a method</span>
                  )}
                  {current?.clientStreaming && <span>· a JSON list, one item per message</span>}
                  <Button size="sm" variant="ghost" className="ml-auto" icon={<Sparkles size={12} />} disabled={!current} title={example} onClick={useExample}>
                    Example
                  </Button>
                </div>
                <div className="flex-1 min-h-0">
                  <CodeEditor language="json" value={d.message} onChange={(message) => set({ message })} path={`grpc-message/${d.method || 'none'}.json`} jsonSchema={current?.requestSchema} />
                </div>
              </>
            )}
            {tab === 'metadata' && (
              <div className="p-2">
                <KeyValueEditor rows={d.metadata} onChange={(metadata) => set({ metadata })} keyPlaceholder="Key (e.g. authorization)" />
                <p className="text-xs text-muted mt-2">Values support {'{{variables}}'}; keep tokens in secret environment variables.</p>
              </div>
            )}
            {tab === 'protos' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center gap-2 px-3 min-h-10 py-1.5 border-b border-line shrink-0 text-sm">
                  <ScanSearch size={14} className="text-muted shrink-0" />
                  {d.descriptorSet ? (
                    <>
                      <span className="truncate">
                        Using <b>server reflection</b> from <span className="mono">{d.reflectedFrom}</span>
                      </span>
                      <Button size="sm" variant="ghost" className="ml-auto" icon={<RefreshCw size={12} />} loading={reflecting} onClick={() => void reflect()}>
                        Refresh
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => set({ descriptorSet: undefined, reflectedFrom: undefined })}>
                        Use proto files
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-muted">No proto files? If the server offers reflection, it can describe itself.</span>
                      <Button size="sm" className="ml-auto" icon={<ScanSearch size={12} />} loading={reflecting} disabled={!d.target.trim()} onClick={() => void reflect()}>
                        Use server reflection
                      </Button>
                    </>
                  )}
                </div>
                <div className={cx('flex items-center gap-2 px-3 h-10 border-b border-line shrink-0', d.descriptorSet && 'opacity-50 pointer-events-none')}>
                  <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => void addProto()}>
                    Add .proto file
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => (set({ protoFiles: [...d.protoFiles, { name: `service${d.protoFiles.length || ''}.proto`, text: 'syntax = "proto3";\n\npackage example.v1;\n' }] }), setEditing(d.protoFiles.length))}>
                    New
                  </Button>
                  <span className="text-xs text-muted ml-auto">{methods.length} methods</span>
                </div>
                {protoError && <div className="px-3 py-2 text-xs text-bad border-b border-line">{protoError}</div>}
                {d.descriptorSet ? (
                  <div className="p-3 text-sm text-muted flex flex-col gap-1 overflow-auto">
                    {[...new Set(methods.map((m) => m.service))].map((svc) => (
                      <div key={svc}>
                        <div className="mono text-fg">{svc}</div>
                        {methods
                          .filter((m) => m.service === svc)
                          .map((m) => (
                            <div key={m.name} className="pl-4 mono text-xs">
                              {m.method} <span className="text-muted">({kind(m)})</span>
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                ) : !d.protoFiles.length ? (
                  <Empty icon={<Waypoints size={26} />} title="Describe the service with .proto files">
                    Add the service's .proto file and the files it imports. Imports are matched by path, so name each file as the import statement does (e.g. <span className="mono">vet/v1/common.proto</span>). Google's well-known types are built in.
                  </Empty>
                ) : (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="shrink-0 max-h-40 overflow-auto border-b border-line">
                      {d.protoFiles.map((f, i) => (
                        <div key={i} className={cx('group flex items-center gap-2 px-3 h-8 text-sm cursor-pointer hover:bg-hover', editing === i && 'bg-accent-soft')} onClick={() => setEditing(i)}>
                          <FileCode2 size={13} className="text-muted shrink-0" />
                          <Input className="h-6 min-h-6 mono text-xs flex-1" value={f.name} aria-label="Import path" onChange={(e) => set({ protoFiles: d.protoFiles.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)) })} />
                          <IconButton label="Remove file" className="opacity-0 group-hover:opacity-100" onClick={(e) => (e.stopPropagation(), set({ protoFiles: d.protoFiles.filter((_, j) => j !== i) }), setEditing(undefined))}>
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                    <div className="flex-1 min-h-0">
                      {editing !== undefined && d.protoFiles[editing] ? (
                        <CodeEditor language="proto" path={`proto-${editing}`} value={d.protoFiles[editing]!.text} onChange={(text) => set({ protoFiles: d.protoFiles.map((p, j) => (j === editing ? { ...p, text } : p)) })} />
                      ) : (
                        <Empty title="Select a file to view or edit it" />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {tab === 'settings' && (
              <div className="p-3 flex flex-col gap-3 max-w-md">
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={d.tls} onChange={(e) => set({ tls: e.target.checked })} /> Use TLS (also on with a grpcs:// address)
                </label>
                <Field label="Deadline (ms)">
                  <Input type="number" value={d.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) || 30000 })} />
                </Field>
                <div className="text-sm font-medium mt-2">Certificates</div>
                <p className="text-xs text-muted -mt-2">For servers with a private CA, or that require a client certificate (mutual TLS). PEM text, or a {'{{variable}}'} that holds it. Setting any of them turns TLS on.</p>
                {(
                  [
                    ['ca', 'CA certificate', 'Trusted CA (default: the system CAs)'],
                    ['cert', 'Client certificate', 'For mutual TLS'],
                  ] as const
                ).map(([k, label, hint]) => (
                  <Field key={k} label={label} hint={hint}>
                    <div className="flex gap-2">
                      <textarea className="field mono text-xs min-h-16 flex-1" placeholder="-----BEGIN CERTIFICATE-----" value={d[k] ?? ''} onChange={(e) => set({ [k]: e.target.value } as Partial<typeof d>)} />
                      <Button size="sm" onClick={() => void pickTextFile('.pem,.crt,.cer').then((f) => f && set({ [k]: f.text } as Partial<typeof d>))}>
                        Load…
                      </Button>
                    </div>
                  </Field>
                ))}
                <Field label="Client private key" hint="Not saved with the draft (it's a secret): keep it in a secret environment variable and enter {{clientKey}}, or paste it for this session only.">
                  <div className="flex gap-2">
                    <textarea className="field mono text-xs min-h-16 flex-1" placeholder="{{clientKey}} or -----BEGIN PRIVATE KEY-----" value={keyText} onChange={(e) => setKeyText(e.target.value)} />
                    <Button size="sm" onClick={() => void pickTextFile('.pem,.key').then((f) => f && setKeyText(f.text))}>
                      Load…
                    </Button>
                  </div>
                </Field>
              </div>
            )}
          </div>
          <div className="h-full flex flex-col min-h-0">
            {error ? (
              <div className="p-4 text-sm">
                <div className="text-bad font-medium mb-1">The call failed</div>
                <div className="text-muted">{error}</div>
              </div>
            ) : !result && !sending ? (
              <Empty icon={<Waypoints size={28} />} title="Invoke a method to see the response">
                Unary, server-streaming, client-streaming and bidirectional methods are supported. Streamed responses appear as they arrive.
              </Empty>
            ) : (
              <>
                <div className="flex items-center gap-3 px-3 h-9 border-b border-line text-sm shrink-0">
                  {sending ? (
                    <>
                      <Badge tone="accent">{live.length ? `receiving · ${live.length}` : 'calling…'}</Badge>
                      <ArrivalSpark times={live.map((m) => m.atMs)} />
                    </>
                  ) : (
                    result && (
                      <>
                        <Badge tone={statusTone}>
                          {result.code} {result.codeName}
                        </Badge>
                        <span className="text-muted">
                          Time <span className="text-fg tabular-nums">{Math.round(result.durationMs)} ms</span>
                        </span>
                        {result.messages && <span className="text-muted">{plural(result.messages.length, 'message')}</span>}
                        {result.messages && <ArrivalSpark times={result.messages.map((m) => m.atMs)} />}
                        {result.details && <span className="text-muted truncate">{result.details}</span>}
                      </>
                    )
                  )}
                </div>
                <Tabs
                  value={resTab}
                  onChange={setResTab}
                  tabs={[
                    { id: 'response', label: current?.serverStreaming ? 'Messages' : 'Response' },
                    { id: 'metadata', label: 'Metadata', badge: result?.metadata.length },
                    { id: 'trailers', label: 'Trailers', badge: result?.trailers.length },
                  ]}
                />
                <div className="flex-1 min-h-0 flex flex-col">
                  {resTab === 'response' &&
                    (streamRows.length || current?.serverStreaming ? (
                      <Split id="grpc-stream" direction="vertical" initial={55}>
                        <VirtualList
                          className="h-full"
                          items={streamRows}
                          rowHeight={28}
                          scrollToIndex={sending ? streamRows.length - 1 : undefined}
                          render={(m, i) => (
                            <button type="button" onClick={() => setSelected(i)} className={cx('w-full h-full flex items-center gap-3 px-3 text-xs border-b border-line/60 text-left hover:bg-hover', i === selected && 'bg-accent-soft')}>
                              <span className="tabular-nums text-muted w-16 shrink-0">{(m.atMs / 1000).toFixed(2)} s</span>
                              <span className="truncate mono">{JSON.stringify(m.data)}</span>
                            </button>
                          )}
                        />
                        <div className="h-full overflow-auto">{selectedData !== undefined ? <JsonTree data={selectedData} /> : <Empty title="Select a message" />}</div>
                      </Split>
                    ) : result?.response !== undefined ? (
                      <div className="flex-1 overflow-auto">
                        <JsonTree data={result.response} />
                      </div>
                    ) : (
                      <Empty title={result && result.code !== 0 ? `${result.codeName}: ${result.details || 'no details'}` : 'No response message'} />
                    ))}
                  {resTab !== 'response' && result && (
                    <div className="overflow-auto">
                      {(resTab === 'metadata' ? result.metadata : result.trailers).map(([k, v], i) => (
                        <div key={i} className="grid grid-cols-[200px_1fr] gap-3 px-3 py-1.5 text-xs border-b border-line/60">
                          <span className="mono text-muted truncate">{k}</span>
                          <span className="mono break-all">{v}</span>
                        </div>
                      ))}
                      {!(resTab === 'metadata' ? result.metadata : result.trailers).length && <Empty title={`No ${resTab}`} />}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </ResponseSplit>
      </div>
      {saveDialog.modal}
    </div>
    </Split>
  );
}
