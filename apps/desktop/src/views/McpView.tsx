import { ArrowDownLeft, ArrowUpRight, Braces, CircleDot, Copy, MoreHorizontal, Pencil, Plug, Plus, Radio, Save, Trash2, Unplug, History, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantContext } from '../lib/assistant-context';
import { asError, call, on, type NormalizedError } from '../api';
import { ask, confirmAction, persisted, toastError, useApp } from '../store';
import { useDoc, useDocs } from '../lib/docs';
import { useIntent, useSaveShortcut } from '../hooks';
import type { KeyValue, McpServerConfig } from '../types';
import { formatMs, uid, plural } from '../lib/format';
import { CodeEditor } from '../components/CodeEditor';
import { JsonTree } from '../components/JsonView';
import { useSticky } from '../lib/sticky';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { ErrorPanel } from '../components/Results';
import { FolderList, type FolderListOps } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { closeTabsFor, NEW_TAB_TITLE, useSingleEditorTab } from '../components/EditorTabs';
import { EnvironmentsPane, HistoryPane } from '../components/SidebarPanes';
import { McpUsage } from '../components/McpUsage';
import { Button, cx, Empty, Field, IconButton, Input, Menu, SectionTitle, Select, Split, Tabs, VirtualList, Textarea } from '../components/ui';
import { PromptsPanel, ResourcesPanel, type Discovery } from '../components/mcp/McpPanels';
import { splitCommandLine, joinCommandLine } from '../lib/command-line';
import { ToolsPanel } from '../components/mcp/ToolsPanel';
import { ToolsetEditor, type ToolsetEditorHandle } from '../components/mcp/ToolsetEditor';

interface McpEvent {
  id: string;
  timestamp: number;
  direction: 'outgoing' | 'incoming' | 'local';
  method: string;
  kind: string;
  rpcId?: string | number;
  request?: unknown;
  response?: unknown;
  error?: unknown;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

type Tab = 'tools' | 'calls' | 'resources' | 'prompts' | 'usage' | 'trace' | 'info' | 'settings';

/** Merge event lists by id — the connect snapshot and the live stream overlap. */
function mergeEvents(a: McpEvent[], b: McpEvent[]): McpEvent[] {
  const seen = new Set(a.map((e) => e.id));
  const out = [...a];
  for (const e of b) if (!seen.has(e.id)) (seen.add(e.id), out.push(e));
  return out.sort((x, y) => x.timestamp - y.timestamp).slice(-5000);
}

/** Which server each MCP tab shows (each tab is its own document). */
const tabServer = persisted<{ serverId?: string }>('mcp', {});

export function McpView() {
  const { docId, active } = useDoc();
  const docState = useMemo(() => tabServer.forDoc(docId), [docId]);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => docState.load().serverId);
  useEffect(() => docState.save({ serverId: selected }), [selected, docState]);
  // a server being added: edited inline like any request, saved with Save (or on Connect)
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [discovery, setDiscovery] = useState<Record<string, Discovery>>({});
  const [events, setEvents] = useState<Record<string, McpEvent[]>>({});
  const [connecting, setConnecting] = useState<string>();
  const [connError, setConnError] = useState<NormalizedError>();
  const [tab, setTab] = useSticky<Tab>(`mcp:tab:${docId ?? 'main'}`, 'tools');
  const env = useApp((s) => s.environment);
  const load = useCallback(async () => {
    const s = await call<McpServerConfig[]>('mcp.servers');
    setServers(s);
    setSelected((cur) => cur ?? s[0]?.id);
    useApp.getState().set({ mcpConnected: s.filter((x) => x.connected).length });
  }, []);
  useEffect(() => {
    void load();
    return on<Array<{ serverId: string; event: McpEvent }>>('mcp.events', (items) =>
      setEvents((ev) => {
        const next = { ...ev };
        for (const it of items) next[it.serverId] = mergeEvents(next[it.serverId] ?? [], [it.event]);
        return next;
      }),
    );
  }, [load]);
  const addServer = (folder?: string) => {
    setDraft({ id: uid('mcp-'), name: NEW_TAB_TITLE.mcp, transport: 'stdio', command: 'node', args: [], ...(folder ? { folder } : {}) });
    setTab('settings');
  };
  const selectServer = (id: string) => {
    setDraft(null);
    setSelected(id);
  };
  useIntent('mcp', (p) => {
    if (p?.serverId) selectServer(p.serverId);
    if (p?.addServer) addServer();
    if (p?.tab) setTab(p.tab as Tab);
    if (p?.serverId && p.connect) void connect(p.serverId as string);
  });

  const server = servers.find((s) => s.id === selected);
  const disc = !draft && selected ? discovery[selected] : undefined;
  // "Ask the assistant" includes the server and what it offers (secrets are hidden by the backend)
  useAssistantContext(
    'mcp',
    useCallback(() => {
      if (!server) return undefined;
      return {
        label: `MCP ${server.name}${disc ? ` · ${disc.tools.length} tools` : connError ? ' · error' : ''}`,
        context: {
          mcpServer: { name: server.name, transport: server.transport, ...('url' in server ? { url: server.url } : {}), ...('command' in server ? { command: server.command } : {}) },
          ...(disc ? { serverInfo: disc.serverInfo, instructions: disc.instructions?.slice(0, 2000), tools: disc.tools.slice(0, 60).map((t) => ({ name: t.name, description: t.description?.slice(0, 200) })), resources: disc.resources.slice(0, 30).map((r) => r.uri), prompts: disc.prompts.map((p) => p.name) } : {}),
          ...(connError ? { error: { kind: connError.kind, message: connError.message } } : {}),
        },
      };
    }, [server, disc, connError]),
    active,
  );
  // the server on screen: the one being added, or the selected one; `form` holds its edits until saved
  const current = draft ?? server;
  const savedJson = !draft && server ? JSON.stringify(configOf(server)) : '';
  const [form, setForm] = useState<McpServerConfig | undefined>(current && configOf(current));
  useEffect(() => {
    setForm(current ? configOf(current) : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, savedJson]);
  const dirty = !!draft || (!!form && JSON.stringify(form) !== savedJson);

  /** Connect; a stdio server not yet allowed on this computer shows its command line first (Run once / Always). */
  const connectWithTrust = async (id: string, env: string | undefined): Promise<{ discovery: Discovery; events: McpEvent[] }> => {
    try {
      return await call('mcp.connect', { serverId: id, environment: env });
    } catch (e) {
      const err = asError(e);
      const d = err.details as { needsTrust?: boolean; line?: string } | undefined;
      if (!d?.needsTrust) throw e;
      const choice = await ask({
        title: 'Run this program?',
        message: `This workspace starts a program on your computer:`,
        detail: `${d.line}

It runs with your permissions. Allow it only if you know where this workspace comes from and what the program does.`,
        tone: 'question',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'once', label: 'Run once' },
          { id: 'always', label: 'Always for this workspace', variant: 'primary' },
        ],
        cancelId: 'cancel',
      });
      if (choice === 'cancel') throw new Error('Not connected: the program was not allowed to run.');
      return await call('mcp.connect', { serverId: id, environment: env, trust: choice });
    }
  };
  const connect = async (id: string) => {
    setConnecting(id);
    setConnError(undefined);
    setEvents((e) => ({ ...e, [id]: [] }));
    try {
      const r = await connectWithTrust(id, env);
      setDiscovery((d) => ({ ...d, [id]: r.discovery }));
      setEvents((e) => ({ ...e, [id]: mergeEvents(e[id] ?? [], r.events) }));
      setTab('tools');
    } catch (e) {
      setConnError(asError(e));
      setTab('trace');
    } finally {
      setConnecting(undefined);
      void load();
    }
  };
  const disconnect = async (id: string) => {
    await call('mcp.disconnect', { serverId: id });
    setDiscovery((d) => {
      const n = { ...d };
      delete n[id];
      return n;
    });
    void load();
  };
  /** Record the connected server (tools, resources, prompts and the calls made so far) as a mock server. */
  const saveMock = async (id: string) => {
    try {
      const r = await call<{ path: string; tools: number; calls: number; resources: number }>('mcp.mock.save', { serverId: id, addServer: true });
      useApp.getState().toast(`Saved ${r.path}: ${plural(r.tools, 'tool')}, ${plural(r.calls, 'recorded call')}. Added as a mock server.`, 'success');
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  // folders of the server list (empty folders included) live in the workspace library "mcp"
  const [folders, setFolders] = useState<string[]>([]);
  useEffect(() => {
    void call<{ folders: string[] }>('lib.get', { kind: 'mcp' }).then((l) => setFolders(l.folders), () => undefined);
  }, []);
  const saveFolders = async (next: string[]) => {
    setFolders(next);
    await call('lib.save', { kind: 'mcp', library: { folders: next, items: [] } });
  };
  const serverOps: FolderListOps = {
    renameItem: (id, name) => saveServers(servers.map((s) => (s.id === id ? { ...s, name } : s))),
    moveItem: (id, folder) => saveServers(servers.map((s) => (s.id === id ? { ...s, folder } : s))),
    deleteItem: async (id) => {
      closeTabsFor([id]);
      if (servers.find((s) => s.id === id)?.connected) await disconnect(id);
      await saveServers(servers.filter((s) => s.id !== id));
    },
    duplicateItem: (id) => {
      const s = servers.find((x) => x.id === id);
      if (s) return saveServers([...servers, { ...s, id: uid('mcp-'), name: `${s.name} copy` }]);
    },
    setFolders: saveFolders,
    renameFolder: async (from, to) => {
      await saveFolders(folders.map((f) => (f === from ? to : f)));
      await saveServers(servers.map((s) => (s.folder === from ? { ...s, folder: to } : s)));
    },
    deleteFolder: async (name) => {
      await saveFolders(folders.filter((f) => f !== name));
      await saveServers(servers.map((s) => (s.folder === name ? { ...s, folder: undefined } : s)));
    },
  };
  const saveServers = async (list: McpServerConfig[]) => {
    await call('mcp.saveServers', { servers: list.map(({ connected: _c, ...s }) => s) });
    await load();
  };
  /** Save the server on screen (new or edited); returns its id. */
  const saveForm = async (quiet = false): Promise<string | undefined> => {
    if (!form) return undefined;
    if (!form.name.trim()) {
      useApp.getState().toast('Give the server a name first', 'error');
      setTab('settings');
      return undefined;
    }
    try {
      const exists = servers.some((x) => x.id === form.id);
      await saveServers(exists ? servers.map((x) => (x.id === form.id ? form : x)) : [...servers, form]);
      setDraft(null);
      setSelected(form.id);
      if (!quiet) useApp.getState().toast(`Saved "${form.name}"`, 'success');
      return form.id;
    } catch (e) {
      toastError(e);
      return undefined;
    }
  };
  /** Connect the server on screen, saving it first when it's new or changed. */
  const connectCurrent = async () => {
    const id = dirty ? await saveForm(true) : current?.id;
    if (id) await connect(id);
  };
  const removeCurrent = async () => {
    if (!current) return;
    // discarding a new server closes its tab
    if (draft) return docId ? useDocs.getState().close('mcp', docId) : setDraft(null);
    if (!(await confirmAction({ title: 'Remove MCP server', message: `Remove the MCP server "${current.name}"?`, detail: 'Saved tests that call it will fail until you add it again.', confirmLabel: 'Remove server', danger: true }))) return;
    if (server?.connected) await disconnect(current.id);
    closeTabsFor([current.id]);
    await saveServers(servers.filter((s) => s.id !== current.id));
    setSelected(undefined);
  };
  // a mock server's Tools tab edits its toolset file: Ctrl+S saves that when it has changes, else the server
  const toolset = useRef<ToolsetEditorHandle>(null);
  useSaveShortcut('mcp', () => (tab === 'tools' && toolset.current?.dirty ? void toolset.current.save() : void saveForm()));

  // this editor's tab in the shared tab strip (while a server is selected)
  useSingleEditorTab(
    'mcp',
    current && form
      ? {
          title: form.name || NEW_TAB_TITLE.mcp,
          badge: 'MCP',
          badgeClass: 'text-accent',
          dirty,
          item: draft ? undefined : current.id,
          // a new server just gets the name; a saved one is renamed in the workspace
          onRenameTo: (name: string) => (draft ? setForm({ ...form, name }) : serverOps.renameItem(current.id, name)),
          onDuplicate: draft ? undefined : () => void serverOps.duplicateItem?.(current.id),
        }
      : undefined,
  );
  return (
    <>
    <Split id="mcp-servers" sidebar collapsed initial={20} min={14}>
      <SidebarShell
        id="mcp"
        panes={[
          {
            id: 'saved',
            label: 'Servers',
            icon: <Plug size={13} />,
            render: () => (
              <FolderList
                id="mcp-servers"
                title="MCP servers"
                itemNoun="server"
                addLabel="Add MCP server"
                folders={folders}
                selected={draft ? undefined : selected}
                onSelect={selectServer}
                onAdd={(folder) => addServer(folder)}
                items={servers.map((s) => ({
                  id: s.id,
                  name: s.name,
                  folder: s.folder,
                  icon: <CircleDot size={10} className={s.connected ? 'text-ok' : 'text-muted'} />,
                  subtitle: serverSummary(s),
                }))}
                itemMenu={(id) => {
                  const s = servers.find((x) => x.id === id)!;
                  return [
                    { label: 'Settings', icon: <Pencil size={14} />, onSelect: () => (selectServer(id), setTab('settings')) },
                    s.connected ? { label: 'Disconnect', icon: <Unplug size={14} />, onSelect: () => void disconnect(id) } : { label: 'Connect', icon: <Plug size={14} />, onSelect: () => (selectServer(id), void connect(id)) },
                  ];
                }}
                ops={serverOps}
                empty={
                  <Empty
                    title="No MCP servers"
                    actions={[{ label: 'Add server', icon: <Plus size={12} />, onClick: () => addServer() }]}
                  >
                    An MCP server is what an AI agent calls. Add one (a local command over stdio, Streamable HTTP, legacy SSE, or a mock definition), connect, and call its tools with generated forms; a call becomes a test with Save as test.
                  </Empty>
                }
              />
            ),
          },
          { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
          { id: 'history', label: 'History', icon: <History size={13} />, render: () => <HistoryPane kind="mcp" noun="MCP tool calls you make" /> },
        ]}
      />
      <div className="h-full flex flex-col min-w-0">
        {current && form ? (
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0">
              <Select className="w-44 shrink-0" aria-label="Transport" value={form.transport} onChange={(e) => setForm(withTransport(form, e.target.value as McpServerConfig['transport']))}>
                {TRANSPORTS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
              <TargetInput s={form} onChange={setForm} />
              {server?.connected && !draft ? (
                <Button variant="primary" icon={<Unplug size={14} />} onClick={() => disconnect(current.id)}>
                  Disconnect
                </Button>
              ) : (
                <Button variant="primary" icon={<Plug size={14} />} loading={connecting === current.id} onClick={() => void connectCurrent()} title={dirty ? 'Save and connect' : 'Connect'}>
                  Connect
                </Button>
              )}
              <Button icon={<Save size={14} />} onClick={() => void saveForm()} title="Save (Ctrl+S)">
                Save
              </Button>
              <Menu
                width={230}
                trigger={
                  <IconButton label="More server actions">
                    <MoreHorizontal size={15} />
                  </IconButton>
                }
                items={[
                  { label: 'Ping', icon: <Radio size={14} />, disabled: !server?.connected || !!draft, onSelect: () => void call<number>('mcp.ping', { serverId: current.id }).then((ms) => useApp.getState().toast(`Ping ${ms} ms`)) },
                  { label: 'Save as mock', icon: <Copy size={14} />, disabled: !server?.connected || !!draft || form.transport === 'mock', onSelect: () => void saveMock(current.id) },
                  { label: draft ? 'Discard' : 'Remove server…', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void removeCurrent() },
                ]}
              />
            </div>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                // a mock server designs its tools (the toolset); calling them with the inspector is a second tab once connected
                ...(form.transport === 'mock' ? [{ id: 'tools' as const, label: 'Tools', badge: undefined }, ...(disc ? [{ id: 'calls' as const, label: 'Call tools', badge: disc.tools.length }] : [])] : [{ id: 'tools' as const, label: 'Tools', badge: disc?.tools.length }]),
                { id: 'resources', label: 'Resources', badge: disc ? disc.resources.length + disc.resourceTemplates.length : undefined },
                { id: 'prompts', label: 'Prompts', badge: disc?.prompts.length },
                ...(draft ? [] : [{ id: 'usage' as const, label: 'Usage' }]),
                { id: 'trace', label: 'Protocol trace', badge: draft ? undefined : events[current.id]?.length },
                { id: 'info', label: 'Server info' },
                { id: 'settings', label: 'Settings' },
              ]}
            />
            <div className="flex-1 min-h-0">
              {connError && tab !== 'trace' && tab !== 'settings' && tab !== 'usage' && <ErrorPanel error={connError} context={{ server }} />}
              {tab === 'settings' ? (
                <ServerSettings s={form} onChange={setForm} folders={folders} />
              ) : tab === 'usage' ? (
                <McpUsage serverId={current.id} />
              ) : tab === 'trace' ? (
                <McpTrace events={draft ? [] : events[current.id] ?? []} error={connError} />
              ) : tab === 'tools' && form.transport === 'mock' ? (
                <ToolsetEditor ref={toolset} key={form.mockFile} file={form.mockFile} serverName={form.name} connected={!!server?.connected && !draft} />
              ) : !disc ? (
                !connError && (
                  <Empty
                    icon={<Plug size={26} />}
                    title="Not connected"
                    actions={[{ label: 'Connect', icon: <Plug size={12} />, onClick: () => void connect(current.id) }]}
                  >
                    Connect to discover the server's tools, resources and prompts. Every JSON-RPC message is kept in the protocol trace.
                  </Empty>
                )
              ) : tab === 'tools' || tab === 'calls' ? (
                <ToolsPanel serverId={current.id} tools={disc.tools} />
              ) : tab === 'resources' ? (
                <ResourcesPanel serverId={current.id} disc={disc} />
              ) : tab === 'prompts' ? (
                <PromptsPanel serverId={current.id} prompts={disc.prompts} />
              ) : (
                <div className="h-full">
                  <JsonTree data={{ serverInfo: disc.serverInfo, capabilities: disc.capabilities, instructions: disc.instructions }} />
                </div>
              )}
            </div>
          </>
        ) : (
          <Empty
            icon={<Plug size={28} />}
            title="Select or add an MCP server"
            actions={[{ label: 'Add server', icon: <Plus size={14} />, onClick: () => addServer() }]}
          >
            A local command (stdio), Streamable HTTP, legacy SSE or a mock definition.
          </Empty>
        )}
      </div>
    </Split>
    </>
  );
}

function serverSummary(s: McpServerConfig): string {
  if (s.transport === 'stdio') return `${s.command} ${(s.args ?? []).join(' ')}`;
  if (s.transport === 'mock') return `mock · ${s.mockFile}`;
  return s.url;
}

/** A server's saved configuration (without its live connection state). */
function configOf(s: McpServerConfig & { connected?: boolean }): McpServerConfig {
  const { connected: _c, ...config } = s;
  return config as McpServerConfig;
}

const TRANSPORTS: Array<[McpServerConfig['transport'], string]> = [
  ['stdio', 'stdio (local)'],
  ['streamable-http', 'Streamable HTTP'],
  ['sse', 'SSE (legacy)'],
  ['mock', 'Mock'],
];

/** Switch transport, keeping the name and folder. */
function withTransport(s: McpServerConfig, t: McpServerConfig['transport']): McpServerConfig {
  if (t === s.transport) return s;
  const base = { id: s.id, name: s.name, folder: s.folder };
  return t === 'stdio' ? { ...base, transport: 'stdio', command: 'node', args: [] } : t === 'mock' ? { ...base, transport: 'mock', mockFile: 'mocks/server.mcp-mock.yaml' } : { ...base, transport: t, url: 'http://127.0.0.1:3000/mcp', headers: [] };
}


/** The request bar's target: the command line (stdio), the URL (HTTP, SSE) or the mock file. */
function TargetInput({ s, onChange }: { s: McpServerConfig; onChange(s: McpServerConfig): void }) {
  const cmd = s.transport === 'stdio' ? [s.command, ...(s.args ?? [])] : [];
  const [text, setText] = useState(() => joinCommandLine(cmd));
  // edits made elsewhere (Settings, another server) replace the text; typing keeps it as typed
  const key = JSON.stringify(cmd);
  useEffect(() => {
    if (JSON.stringify(splitCommandLine(text)) !== key) setText(joinCommandLine(cmd));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const cls = 'mono flex-1 min-w-0';
  if (s.transport === 'stdio')
    return (
      <Input
        className={cls}
        aria-label="Command"
        placeholder="npx -y @modelcontextprotocol/server-everything"
        title="The command and its arguments. On Windows use npx.cmd or the full path to node.exe; {{variables}} are resolved."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const [command = '', ...args] = splitCommandLine(e.target.value);
          onChange({ ...s, command, args });
        }}
      />
    );
  if (s.transport === 'mock') return <Input className={cls} aria-label="Mock definition file" placeholder="mocks/server.mcp-mock.yaml" value={s.mockFile} onChange={(e) => onChange({ ...s, mockFile: e.target.value })} />;
  return <Input className={cls} aria-label="Server URL" placeholder="https://example.com/mcp" value={s.url} onChange={(e) => onChange({ ...s, url: e.target.value })} />;
}

/** The Settings tab: every field of the server, or its JSON. */
function ServerSettings({ s, onChange, folders = [] }: { s: McpServerConfig; onChange(s: McpServerConfig): void; folders?: string[] }) {
  const [json, setJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const envMap = s.transport === 'stdio' ? (s.env ?? {}) : {};
  // the table keeps its own rows while you type: the saved config is a name → value map, which can't hold a row whose
  // name isn't typed yet (a value typed first used to vanish), nor a row turned off
  const [envRows, setEnvRows] = useState<KeyValue[]>(() => Object.entries(envMap).map(([key, value]) => ({ key, value, enabled: true })));
  const envKey = JSON.stringify(envMap);
  const lastEnv = useRef(envKey);
  useEffect(() => {
    // another server, or the JSON editor changed it: start from the config again
    if (envKey === lastEnv.current) return;
    lastEnv.current = envKey;
    setEnvRows(Object.entries(envMap).map(([key, value]) => ({ key, value, enabled: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKey, s.id]);
  const changeEnv = (rows: KeyValue[]) => {
    setEnvRows(rows);
    const env = Object.fromEntries(rows.filter((r) => r.key.trim() && r.enabled !== false).map((r) => [r.key.trim(), r.value]));
    lastEnv.current = JSON.stringify(env);
    onChange({ ...s, env } as McpServerConfig);
  };
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <SectionTitle>Server settings</SectionTitle>
          <Button
            size="sm"
            className="ml-auto"
            icon={<Braces size={12} />}
            onClick={() => {
              if (!json) {
                setJsonText(JSON.stringify(s, null, 2));
                return setJson(true);
              }
              try {
                onChange({ ...(JSON.parse(jsonText) as McpServerConfig), id: s.id });
                setJson(false);
              } catch (e) {
                useApp.getState().toast(`Invalid JSON: ${(e as Error).message}`, 'error');
              }
            }}
          >
            {json ? 'Apply JSON' : 'Edit JSON'}
          </Button>
        </div>
        {json ? (
          <div className="h-80 border border-line rounded-lg overflow-hidden">
            <CodeEditor language="json" value={jsonText} onChange={setJsonText} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} />
              </Field>
              <Field label="Folder" hint="Optional: groups servers in the list.">
                <Input list="mcp-folders" value={s.folder ?? ''} placeholder="(top level)" onChange={(e) => onChange({ ...s, folder: e.target.value.trim() ? e.target.value : undefined })} />
                <datalist id="mcp-folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </Field>
            </div>
            {s.transport === 'stdio' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Command" hint="On Windows use npx.cmd or the full path to node.exe. Variables like {{workspaceDir}} are resolved.">
                    <Input className="mono" value={s.command} onChange={(e) => onChange({ ...s, command: e.target.value })} />
                  </Field>
                  <Field label="Working directory">
                    <Input className="mono" value={s.cwd ?? ''} onChange={(e) => onChange({ ...s, cwd: e.target.value || undefined })} />
                  </Field>
                </div>
                <Field label="Arguments (one per line)">
                  <Textarea className="field mono min-h-20" value={(s.args ?? []).join('\n')} onChange={(e) => onChange({ ...s, args: e.target.value.split('\n').filter((x) => x !== '') })} />
                </Field>
                <Field label="Environment variables" hint="Use {{variables}} to reference secrets instead of pasting them here.">
                  <KeyValueEditor rows={envRows} onChange={changeEnv} />
                </Field>
              </>
            ) : s.transport === 'mock' ? (
              <Field label="Mock definition" hint="A *.mcp-mock.yaml file in this workspace, with tools and their canned responses, resources and prompts. Connect to a real server and use Save as mock to record one.">
                <Input className="mono" value={s.mockFile} onChange={(e) => onChange({ ...s, mockFile: e.target.value })} />
              </Field>
            ) : (
              <>
                <Field label="URL">
                  <Input className="mono" value={s.url} onChange={(e) => onChange({ ...s, url: e.target.value })} />
                </Field>
                <Field label="Headers" hint="Use {{variables}} for tokens and keys.">
                  <KeyValueEditor rows={s.headers ?? []} onChange={(headers) => onChange({ ...s, headers })} />
                </Field>
              </>
            )}
          </>
        )}
        <p className="text-xs text-muted">Save with Ctrl+S; Connect saves first. Servers are kept in the workspace (mcp-servers.json).</p>
      </div>
    </div>
  );
}

/** Timeline of every JSON-RPC message with direction, method, latency and payloads (spec §12.4). */
function McpTrace({ events, error }: { events: McpEvent[]; error?: NormalizedError }) {
  const [sel, setSel] = useState<McpEvent>();
  const [filter, setFilter] = useState('');
  const endRef = useRef(0);
  const shown = useMemo(() => (filter ? events.filter((e) => e.method.includes(filter) || e.kind.includes(filter)) : events), [events, filter]);
  const t0 = events[0]?.timestamp ?? 0;
  endRef.current = shown.length - 1;
  return (
    <Split id="mcp-trace" initial={55}>
      <div className="h-full flex flex-col">
        {error && <ErrorPanel error={error} />}
        <div className="flex items-center gap-2 px-2 h-9 border-b border-line text-xs">
          <Input className="h-6 min-h-6 w-48 text-xs" placeholder="Filter method (e.g. tools/call)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="text-muted">{plural(shown.length, 'event')}</span>
        </div>
        <div className="grid grid-cols-[70px_22px_1fr_80px_70px] text-[0.72rem] text-muted px-2 py-1 border-b border-line">
          <span>+time</span>
          <span />
          <span>method</span>
          <span>kind</span>
          <span className="text-right">latency</span>
        </div>
        <VirtualList
          className="flex-1"
          items={shown}
          rowHeight={26}
          render={(e) => (
            <button onClick={() => setSel(e)} className={cx('w-full h-full grid grid-cols-[70px_22px_1fr_80px_70px] items-center px-2 text-xs border-b border-line/50 text-left hover:bg-hover', sel?.id === e.id && 'bg-accent/10')}>
              <span className="tabular-nums text-muted">{((e.timestamp - t0) / 1000).toFixed(3)}s</span>
              {e.direction === 'outgoing' ? <ArrowUpRight size={12} className="text-accent" /> : e.direction === 'incoming' ? <ArrowDownLeft size={12} className="text-ok" /> : <CircleDot size={10} className="text-muted" />}
              <span className={cx('mono truncate', e.kind === 'error' && 'text-bad')}>{e.method}</span>
              <span className={cx(e.kind === 'error' ? 'text-bad' : 'text-muted')}>{e.kind}</span>
              <span className="text-right tabular-nums">{e.durationMs !== undefined ? formatMs(e.durationMs) : ''}</span>
            </button>
          )}
        />
      </div>
      <div className="h-full">
        {sel ? (
          <JsonTree
            data={JSON.parse(JSON.stringify({ timestamp: new Date(sel.timestamp).toISOString(), direction: sel.direction, method: sel.method, kind: sel.kind, rpcId: sel.rpcId, durationMs: sel.durationMs, request: sel.request, response: sel.response, error: sel.error, metadata: sel.metadata }))}
          />
        ) : (
          <Empty title="Select an event" />
        )}
      </div>
    </Split>
  );
}


