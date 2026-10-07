import { ArrowDownLeft, ArrowUpRight, Braces, CircleDot, Copy, Download, MoreHorizontal, Pencil, Play, Plug, Plus, Radio, Save, Sparkles, Trash2, Unplug, Wrench, History, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantContext } from '../lib/assistant-context';
import { asError, call, on, type NormalizedError } from '../api';
import { ask, confirmAction, persisted, promptText, useApp } from '../store';
import { useDoc, useDocs } from '../lib/docs';
import { useIntent, useSendShortcut, useSaveShortcut } from '../hooks';
import type { CheckConfig, CheckResult, KeyValue, McpServerConfig } from '../types';
import { formatMs, uid, plural } from '../lib/format';
import { AssertionEditor } from '../components/AssertionEditor';
import { CodeEditor } from '../components/CodeEditor';
import { JsonSchemaForm } from '../components/JsonSchemaForm';
import { JsonTree, RawView } from '../components/JsonView';
import { Markdown } from '../components/Markdown';
import { useSticky } from '../lib/sticky';
import { downloadContent } from '../lib/files';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { CheckList, ErrorPanel } from '../components/Results';
import { FolderList, type FolderListOps } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { closeTabsFor, NEW_TAB_TITLE, useSingleEditorTab } from '../components/EditorTabs';
import { EnvironmentsPane, HistoryPane } from '../components/SidebarPanes';
import { McpUsage } from '../components/McpUsage';
import { Badge, Button, cx, Empty, Field, IconButton, Input, Menu, SectionTitle, Select, Split, Tabs, VirtualList } from '../components/ui';
import { ResponseSplit } from '../components/ResponseSplit';
import { PromptsPanel, ResourcesPanel, type Discovery, type Tool } from '../components/mcp/McpPanels';

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

type Tab = 'tools' | 'resources' | 'prompts' | 'usage' | 'trace' | 'info' | 'settings';

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
      useApp.getState().toast(asError(e).message, 'error');
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
      useApp.getState().toast(asError(e).message, 'error');
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
  useSaveShortcut('mcp', () => void saveForm());

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
                { id: 'tools', label: 'Tools', badge: disc?.tools.length },
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
              ) : tab === 'tools' ? (
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
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => addServer()}>
                Add server
              </Button>
            }
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

/** "node server.js --flag" ⇄ command + arguments (quotes keep spaces). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
export function joinCommandLine(parts: string[]): string {
  return parts.map((p) => (p === '' || /[\s"']/.test(p) ? `"${p.replace(/"/g, "'")}"` : p)).join(' ');
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
                  <textarea className="field mono min-h-20" value={(s.args ?? []).join('\n')} onChange={(e) => onChange({ ...s, args: e.target.value.split('\n').filter((x) => x !== '') })} />
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

function ToolsPanel({ serverId, tools }: { serverId: string; tools: Tool[] }) {
  // kept while the app runs: switching tabs, servers or views doesn't lose arguments or results
  const k = `mcp:${serverId}:`;
  const [sel, setSel] = useSticky<string | undefined>(`${k}tool`, tools[0]?.name);
  const [filter, setFilter] = useState('');
  const [args, setArgs] = useSticky<Record<string, Record<string, unknown>>>(`${k}args`, {});
  const [raw, setRaw] = useSticky(`${k}raw`, false);
  // raw JSON arguments and assertions belong to each tool (switching tools shows that tool's own)
  const [rawText, setRawText] = useSticky(`${k}rawText:${sel ?? ''}`, () => JSON.stringify((sel && args[sel]) || {}, null, 2));
  const [assertions, setAssertions] = useSticky<CheckConfig[]>(`${k}assertions:${sel ?? ''}`, [{ type: 'status', expected: 'success' }]);
  const [results, setResults] = useSticky<Record<string, ToolRun>>(`${k}results`, {});
  const result = sel ? results[sel] : undefined;
  const setResult = (r: ToolRun | undefined) => sel && setResults((all) => ({ ...all, [sel]: r! }));
  const [running, setRunning] = useState(false);
  const [sub, setSub] = useSticky<'form' | 'schema' | 'tests'>(`${k}sub`, 'form');
  const tool = tools.find((t) => t.name === sel);
  const value = (sel && args[sel]) || {};
  const exec = async () => {
    if (!tool) return;
    let a = value;
    if (raw) {
      try {
        a = JSON.parse(rawText || '{}');
      } catch (e) {
        return useApp.getState().toast(`Invalid JSON: ${(e as Error).message}`, 'error');
      }
    }
    // required arguments left empty: say which (sending them anyway is useful to test the server's validation)
    const required = ((tool.inputSchema as { required?: string[] } | undefined)?.required ?? []).filter((k) => a[k] === undefined || a[k] === '');
    if (
      required.length &&
      !(await confirmAction({
        title: 'Required arguments are empty',
        message: `${required.join(', ')} ${required.length > 1 ? 'are' : 'is'} required by ${tool.name}.`,
        detail: 'The server will most likely reject the call. Execute anyway to test its validation.',
        confirmLabel: 'Execute anyway',
        tone: 'warning',
      }))
    )
      return;
    setRunning(true);
    try {
      setResult(await call('mcp.call', { serverId, tool: tool.name, args: a, assertions }));
    } catch (e) {
      setResult({ error: asError(e) });
    } finally {
      setRunning(false);
    }
  };
  useSendShortcut('mcp', () => !running && void exec());
  const saveTest = async () => {
    if (!tool) return;
    const name = await promptText('Save as test', { message: 'Test name', value: `${tool.name} works`, okLabel: 'Save' });
    if (!name) return;
    const rel = await call<string>('mcp.saveTest', { serverId, tool: tool.name, args: raw ? JSON.parse(rawText || '{}') : value, assertions, name });
    useApp.getState().toast(`Saved test tests/${rel}`, 'success');
  };
  const destructive = tool?.annotations?.destructiveHint === true;
  return (
    <Split id="mcp-tools" initial={28}>
      <div className="h-full flex flex-col">
        <div className="p-2">
          <Input className="w-full h-7 min-h-7 text-sm" placeholder="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="flex-1 overflow-auto">
          {tools
            .filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
            .map((t) => (
              <button key={t.name} onClick={() => setSel(t.name)} className={cx('w-full text-left px-3 py-2 border-b border-line/60', sel === t.name ? 'bg-accent/10' : 'hover:bg-hover')}>
                <div className="flex items-center gap-1.5 text-sm font-medium mono">
                  <Wrench size={12} className="text-muted" />
                  {t.name}
                  {t.annotations?.destructiveHint === true && <Badge tone="bad">destructive</Badge>}
                </div>
                {t.description && <div className="text-xs text-muted line-clamp-2">{t.description}</div>}
              </button>
            ))}
        </div>
      </div>
      {tool ? (
        <ResponseSplit id="mcp-tool-run" initialBelow={55}>
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-line">
              <span className="font-semibold mono">{tool.name}</span>
              {destructive && <Badge tone="bad">destructive hint</Badge>}
              <label className="ml-auto text-xs flex items-center gap-1 text-muted">
                <input type="checkbox" checked={raw} onChange={(e) => (setRaw(e.target.checked), e.target.checked && setRawText(JSON.stringify(value, null, 2)))} /> Raw JSON
              </label>
              <Button size="sm" variant="ghost" icon={<Sparkles size={12} />} onClick={() =>
                  useApp.getState().set({
                    assistant: {
                      task: 'generate-args',
                      title: `Arguments for ${tool.name}`,
                      context: { tool: tool.name, description: tool.description, inputSchema: tool.inputSchema },
                      apply: {
                        label: 'Use these arguments',
                        run: (code) => {
                          let v: unknown;
                          try {
                            v = JSON.parse(code);
                          } catch {
                            return 'it is not valid JSON';
                          }
                          if (!v || typeof v !== 'object' || Array.isArray(v)) return 'it is not a JSON object';
                          setArgs((a) => ({ ...a, [tool.name]: v as Record<string, unknown> }));
                          setRawText(JSON.stringify(v, null, 2));
                        },
                      },
                    },
                  })
                }
              >
                Generate args
              </Button>
              <Button size="sm" icon={<Save size={12} />} onClick={saveTest}>
                Save as test
              </Button>
              <Button size="sm" variant="primary" icon={<Play size={12} />} loading={running} onClick={async () => (destructive && !(await confirmAction({ title: 'Run a destructive tool', message: 'This tool is marked destructive by the server.', detail: 'It may change or delete data. Run it only if you mean to.', confirmLabel: 'Execute anyway', tone: 'warning' })) ? undefined : exec())}>
                Execute
              </Button>
            </div>
            <Tabs
              value={sub}
              onChange={setSub}
              tabs={[
                { id: 'form', label: 'Arguments' },
                { id: 'schema', label: 'Input schema' },
                { id: 'tests', label: 'Assertions', badge: assertions.length },
              ]}
            />
            <div className="flex-1 min-h-0 overflow-auto">
              {sub === 'form' &&
                (raw ? (
                  <CodeEditor value={rawText} onChange={setRawText} path={`mcp-args/${serverId}/${tool.name}.json`} jsonSchema={tool.inputSchema} />
                ) : (
                  <>
                    {tool.description && <p className="px-3 pt-3 text-sm text-muted">{tool.description}</p>}
                    <JsonSchemaForm schema={tool.inputSchema as never} value={value} onChange={(v) => setArgs({ ...args, [tool.name]: v })} />
                  </>
                ))}
              {sub === 'schema' && <JsonTree data={{ inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) }} />}
              {sub === 'tests' && <AssertionEditor checks={assertions} onChange={setAssertions} groups={['Response', 'Body']} />}
            </div>
          </div>
          <div className="h-full min-h-0">{result ? 'error' in result ? <ErrorPanel error={result.error} context={{ tool: tool.name }} /> : <ToolResult r={result} name={tool.name} /> : <Empty title="Execute the tool to see its result" />}</div>
        </ResponseSplit>
      ) : (
        <Empty title="This server exposes no tools" />
      )}
    </Split>
  );
}

type ToolRun = { isError: boolean; content: unknown[]; structuredContent?: unknown; durationMs: number; checks: CheckResult[]; body: unknown } | { error: NormalizedError };
type ContentItem = { type: string; text?: string; data?: string; mimeType?: string };
type ViewMode = 'pretty' | 'raw' | 'markdown';

const jsonOf = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function ToolResult({ r, name }: { r: Extract<ToolRun, { content: unknown[] }>; name: string }) {
  const [tab, setTab] = useState<'content' | 'structured' | 'tests'>(r.checks.some((c) => !c.passed) ? 'tests' : 'content');
  const items = r.content as ContentItem[];
  const text = items.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n\n');
  const looksMarkdown = /(^|\n)(#{1,6} |[-*] |\d+\. |```)|\[[^\]]+\]\([^)]+\)/.test(text) && jsonOf(text) === undefined;
  // display options, like the REST response: Pretty (JSON as a tree), Raw, Markdown (rendered)
  const [mode, setMode] = useSticky<ViewMode>('mcp:resultMode', 'pretty');
  const effective: ViewMode = mode === 'markdown' && !text ? 'pretty' : mode;
  const copy = () => void navigator.clipboard.writeText(text || JSON.stringify(r.content, null, 2)).then(() => useApp.getState().toast('Copied the result'));
  const save = () => downloadContent(`${name}-result.${jsonOf(text) !== undefined ? 'json' : looksMarkdown ? 'md' : 'txt'}`, text || JSON.stringify(r.content, null, 2));
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm">
        <Badge tone={r.isError ? 'bad' : 'ok'}>{r.isError ? 'isError' : 'success'}</Badge>
        <span className="text-muted">{formatMs(r.durationMs)}</span>
        {text && <span className="text-muted">{text.length.toLocaleString()} chars</span>}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-md border border-line overflow-hidden text-xs" role="group" aria-label="Display">
            {(['pretty', 'raw', 'markdown'] as const).map((m) => (
              <button key={m} type="button" className={cx('px-2 py-0.5 capitalize', effective === m ? 'bg-accent-soft text-fg' : 'text-muted hover:text-fg', m === 'markdown' && !text && 'opacity-40 pointer-events-none')} onClick={() => (setMode(m), setTab('content'))}>
                {m}
              </button>
            ))}
          </div>
          <IconButton label="Copy result" onClick={copy}>
            <Copy size={13} />
          </IconButton>
          <IconButton label="Save result" onClick={save}>
            <Download size={13} />
          </IconButton>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'content', label: 'Content', badge: r.content.length },
          ...(r.structuredContent !== undefined ? [{ id: 'structured' as const, label: 'Structured' }] : []),
          { id: 'tests', label: 'Assertions', badge: r.checks.length },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">
        {tab === 'content' && effective === 'raw' && <RawView text={text || JSON.stringify(r.content, null, 2)} />}
        {tab === 'content' && effective === 'markdown' && <Markdown className="p-4" source={text} />}
        {tab === 'content' &&
          effective === 'pretty' &&
          items.map((c, i) => {
            let parsed: unknown;
            if (c.type === 'text' && c.text) {
              try {
                parsed = JSON.parse(c.text);
              } catch {
                parsed = undefined;
              }
            }
            // a single content block (the usual case) fills the panel
            const single = items.length === 1;
            return (
              <div key={i} className={cx('border-b border-line', single && 'flex-1 min-h-0 flex flex-col')}>
                <div className="px-3 py-1 text-xs text-muted">
                  {c.type}
                  {c.mimeType ? ` · ${c.mimeType}` : ''}
                </div>
                {c.type === 'image' && c.data ? (
                  <img alt="tool output" className="max-w-full p-3" src={`data:${c.mimeType};base64,${c.data}`} />
                ) : parsed !== undefined ? (
                  <div className={single ? 'flex-1 min-h-0' : 'h-64'}>
                    <JsonTree data={parsed} />
                  </div>
                ) : (
                  <pre className="px-3 pb-3 mono text-xs whitespace-pre-wrap">{c.text ?? JSON.stringify(c, null, 2)}</pre>
                )}
              </div>
            );
          })}
        {tab === 'structured' && <JsonTree data={r.structuredContent} />}
        {tab === 'tests' && <CheckList checks={r.checks} />}
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

