import { envColor } from '../components/EnvSelect';
import { Plus, ArrowLeftRight, Grid3x3, Download, FileJson, FileText, KeyRound, Save, ScanSearch, TriangleAlert } from 'lucide-react';
import { SecretRefsLine } from '../components/SecretRefsLine';
import { useGitRepo } from '../lib/git';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCollectionTree } from '../lib/collections-store';
import { call } from '../api';
import { persisted, promptText, toastError, useApp, attempt } from '../store';
import { useLibraryTabs } from '../lib/library-tabs';
import { LibraryTabStrip, NoOpenItems } from '../components/LibraryTabStrip';
import { deleteWithUndo, restoreDeleted } from '../lib/undo-delete';
import { useIntent } from '../hooks';
import type { Environment, KeyValue } from '../types';
import { CollectionVariablesPane } from '../components/CollectionVariablesPane';
import { uid } from '../lib/format';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { EnvCompare } from '../components/EnvCompare';
import { EnvMatrix } from '../components/EnvMatrix';
import { TrashDialog } from '../components/TrashDialog';
import { Badge, Button, Callout, cx, Empty, Field, Input, Menu, MoreMenu, Split, Tabs, Toggle } from '../components/ui';
import type { NodeMenuCtx } from '../lib/node-menu';
import { CountPill, focusRow, treeKeys, withRefDefaults } from '../components/TreeParts';
import { buildNodeMenu } from '../lib/node-menu';
import { TreeRowShell } from '../components/TreeRowShell';
import { refreshEnvironments, useEnvironments } from '../lib/environments-store';
import { deliverSave, type SaveResult } from '../lib/files';
import { AlsoAddDialog } from '../components/AlsoAddTo';

/**
 * WF-19: open environments are tabs (the one tab model: a single click in the list opens a preview tab, double-click
 * keeps it), each with its unsaved edits (`null`: none, the saved environment is shown), kept per workspace. Secret
 * values typed in are never kept here (they go to the OS store on Save).
 */
const envDrafts = persisted<Environment | null>('env-edit', null);

export function EnvironmentsView() {
  const inGit = useGitRepo();
  const ws = useApp((s) => s.workspace);
  const settings = useApp((s) => s.settings);
  const activeEnv = useApp((s) => s.environment);
  const envs = useEnvironments();
  const [comparing, setComparing] = useState(false);
  const [matrix, setMatrix] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  /** Export the selected environment (secret values are never exported). */
  const exportEnv = async (format: 'postman' | 'dotenv') => {
    if (!draft) return;
    await attempt(async () => {
      const r = await call<SaveResult & { name: string }>('env.export', { id: draft.id, format });
      if (deliverSave(r) && r.path) useApp.getState().toast(`Exported to ${r.path} (secret values are left out)`, 'success');
    });
  };
  const tabs = useLibraryTabs<Environment | null>('environments', envDrafts, { canBeEmpty: true });
  const sel = tabs.active.savedId;
  /** Open an environment: in its tab, or the preview tab (a single click in the list), or a new tab. */
  const setSel = (id: string | undefined, o: { preview?: boolean } = {}) => id && tabs.open(id, null, o);
  /** Its tabs close (a deleted environment). */
  const closeTabsOf = (id: string) => tabs.close(tabs.tabs.filter((t) => t.savedId === id).map((t) => t.id), null);
  const newEnvironment = async () => {
    const name = await promptText('New environment', { message: 'Environment name', value: 'Staging', okLabel: 'Create' });
    if (!name) return;
    const env: Environment = { id: uid('env-'), name, variables: [{ key: 'baseUrl', value: '', enabled: true }] };
    await call('env.save', { env });
    await load();
    setSel(env.id);
    await useApp.getState().refreshWorkspace();
  };
  // what the open tab shows: its unsaved edits, else the environment as saved
  const savedEnv = envs.find((e) => e.id === sel);
  const draft: Environment | undefined = tabs.d ?? savedEnv;
  const dirty = !!tabs.d && JSON.stringify(tabs.d) !== JSON.stringify(savedEnv);
  const setDraft = (v: Environment | undefined | ((d: Environment | undefined) => Environment | undefined)) => tabs.setD((cur) => (typeof v === 'function' ? v(cur ?? savedEnv) : v) ?? null);
  /** A copy of an environment (secret values are not copied). */
  const duplicateEnv = async (from: Environment) => {
    const env = { ...from, id: uid('env-'), name: `${from.name} copy`, isProduction: false, variables: from.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) };
    await call('env.save', { env });
    await load();
    setSel(env.id);
    await useApp.getState().refreshWorkspace();
  };
  /** At once, with Undo in the message (the environment and its secret values come back from Recently deleted). */
  const deleteEnv = (env: Environment) =>
    deleteWithUndo({
      kind: 'environment',
      name: env.name,
      trash: true,
      focus: `env:${env.id}`,
      run: async () => {
        await call('env.delete', { id: env.id });
        closeTabsOf(env.id);
        await load();
        await useApp.getState().refreshWorkspace();
      },
      undo: async () => {
        await restoreDeleted('environment', env.id);
        await load();
        await useApp.getState().refreshWorkspace();
      },
    });
  /** The environment being renamed in place (F2, or Rename in its menu). */
  const [renamingEnv, setRenamingEnv] = useState<string>();
  /** Rename from the list: the active environment (chosen by name) stays active, and the open one keeps its unsaved edits. */
  const renameEnv = async (env: Environment, name?: string) => {
    setRenamingEnv(undefined);
    focusRow(`env:${env.id}`);
    if (!name) return;
    try {
      reordering.current = true;
      await call('env.save', { env: { ...env, name } });
      await load();
      if (activeEnv === env.name) useApp.getState().setEnvironment(name);
      await useApp.getState().refreshWorkspace();
    } catch (e) {
      reordering.current = false;
      toastError(e);
    }
  };
  // variables of the open environment that nothing reads (refreshed when it is opened or saved)
  const [unused, setUnused] = useState<string[]>([]);
  const refreshUnused = (env?: string) => void (env ? call<string[]>('vars.unused', { environment: env }).then(setUnused, () => setUnused([])) : setUnused([]));
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<'environment' | 'collection' | 'workspace' | 'global'>('environment');
  const [colVarsFor, setColVarsFor] = useState<string>();
  // only how many collection variables there are: the outline counts them
  const allCollections = useCollectionTree();
  const colVarCount = useMemo(() => allCollections.reduce((n, c) => n + (c.variableCount ?? c.variables?.length ?? 0), 0), [allCollections]);
  const [wsVars, setWsVars] = useState<KeyValue[]>(ws?.variables ?? []);
  const [globals, setGlobals] = useState<KeyValue[]>(settings?.globalVariables ?? []);
  const load = async () => {
    const e = await refreshEnvironments();
    // nothing open yet: the first environment, in the first tab
    if (!tabs.active.savedId && e[0]) tabs.open(e[0].id, null);
  };
  const envsVersion = useApp((s) => s.envsVersion);
  useEffect(() => {
    void load();
  }, [envsVersion]);
  const [dragId, setDragId] = useState<string>();
  const [dropAt, setDropAt] = useState<number>();
  /** Move an environment to position `to`; the order is saved and used by every environment picker. */
  const move = async (id: string, to: number) => {
    setDragId(undefined);
    setDropAt(undefined);
    const from = envs.findIndex((e) => e.id === id);
    if (from < 0 || to < 0 || to >= envs.length || to === from) return;
    const next = [...envs];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    try {
      await call('env.reorder', { ids: next.map((e) => e.id) });
      reordering.current = true;
      await refreshEnvironments();
      await useApp.getState().refreshWorkspace();
    } catch (e) {
      toastError(e);
      await load();
    }
  };
  useEffect(() => setWsVars(ws?.variables ?? []), [ws]);
  useEffect(() => setGlobals(settings?.globalVariables ?? []), [settings]);
  // a reorder only changes positions: keep the open environment's unsaved edits
  const reordering = useRef(false);
  useEffect(() => {
    const e = envs.find((x) => x.id === sel);
    if (reordering.current) {
      reordering.current = false;
      // a reorder or a rename from the list: the open environment's unsaved edits take its new order and name
      if (e && tabs.d) setDraft((d) => (d?.id === e.id ? { ...d, order: e.order, name: e.name } : d));
      return;
    }
    const add = pendingAdd.current;
    if (e && add && add.envId === e.id && !e.variables.some((v) => v.key === add.key)) {
      pendingAdd.current = undefined;
      // unsaved until Save, like any edit
      setDraft((d) => ({ ...(d ?? e), variables: [...(d ?? e).variables, { key: add.key, value: '', enabled: true }] }));
    }
    // a tab keeps its unsaved edits (switching tabs, a save elsewhere); without edits it shows the environment as saved
    refreshUnused(e?.name);
    setSecretValues({});
    if (e && !e.problem) void call('env.secretStatus', { envId: e.id, keys: (e.variables ?? []).filter((v) => v.secret).map((v) => v.key) }).then(setSecretStatus, toastError);
  }, [sel, envs]);
  // a variable to add (from the variables overview: "{{name}} is not defined anywhere ▸ Add"): a row ready for its value
  const pendingAdd = useRef<{ envId: string; key: string } | undefined>(undefined);
  useIntent('environments', (p) => {
    // the New environment button of an empty state elsewhere (Home): lib/empty-actions.ts
    if (p?.create) (setScope('environment'), void newEnvironment());
    if (p?.environmentId && p.addVariable) {
      const key = String(p.addVariable);
      // already open: the row goes into the draft now (selecting it again changes nothing)
      if (sel === p.environmentId) setDraft((d) => (d && !d.variables.some((v) => v.key === key) ? { ...d, variables: [...d.variables, { key, value: '', enabled: true }] } : d));
      else pendingAdd.current = { envId: String(p.environmentId), key };
    }
    if (p?.environmentId) (setScope('environment'), setSel(p.environmentId));
    else if (p?.tab === 'globals') setScope('global');
    else if (p?.tab === 'workspace') setScope('workspace');
    else if (p?.tab === 'collection') (setScope('collection'), setColVarsFor(p.collectionId));
  });

  /** An environment's menu (lib/node-menu.ts builds it): open, make active, rename, duplicate, history, delete with Undo. */
  const envMenu = (e: Environment): NodeMenuCtx => ({
    ref: { kind: 'environment', environmentId: e.id },
    name: e.name,
    repo: inGit,
    on: {
      open: () => setSel(e.id),
      makeActive: () => void useApp.getState().setEnvironment(e.name),
      rename: () => setRenamingEnv(e.id),
      duplicate: () => void duplicateEnv(e),
      delete: () => void deleteEnv(e),
    },
    disabled: activeEnv === e.name ? { makeActive: 'It is the active environment' } : e.problem ? { makeActive: 'Its file cannot be read' } : {},
  });
  // new variables of a saved environment, offered to the others (AlsoAddDialog)
  const [alsoFor, setAlsoFor] = useState<{ from: string; keys: string[] }>();
  const rows: KeyValue[] = (draft?.variables ?? []).map((v) => ({ ...v, value: v.secret ? secretValues[v.key] ?? '' : v.value }));
  const save = async () => {
    if (!draft) return;
    await attempt(async () => {
      // secret values go to the OS credential store; only the key is written to the workspace file
      const variables = rows.map((r) => ({ key: r.key, value: r.secret ? '' : r.value, secret: r.secret, enabled: r.enabled }));
      const secrets = Object.fromEntries(rows.filter((r) => r.secret && r.value).map((r) => [r.key, r.value]));
      // a variable switched to secret keeps its previous plain value as the secret
      for (const r of rows) {
        const prev = envs.find((e) => e.id === draft.id)?.variables.find((v) => v.key === r.key);
        if (r.secret && !r.value && prev && !prev.secret && prev.value) secrets[r.key] = prev.value;
      }
      // variables new in this environment that some other environment lacks: offer to add them there too (WF-14)
      const before = new Set(envs.find((e) => e.id === draft.id)?.variables.map((v) => v.key) ?? []);
      const added = variables.map((v) => v.key).filter((k) => k && !before.has(k));
      const missingElsewhere = added.filter((k) => envs.some((e) => e.id !== draft.id && !e.problem && !e.variables.some((v) => v.key === k)));
      await call('env.save', { env: { ...draft, variables }, secrets });
      tabs.setD(null); // saved: the tab shows the environment as saved
      await load();
      await useApp.getState().refreshWorkspace();
      useApp.getState().toast('Environment saved', 'success');
      if (missingElsewhere.length && envs.some((e) => e.id !== draft.id)) setAlsoFor({ from: draft.id, keys: missingElsewhere });
    });
  };
  return (
    <div className="h-full flex flex-col">
      {alsoFor && <AlsoAddDialog from={alsoFor.from} keys={alsoFor.keys} onClose={() => setAlsoFor(undefined)} />}
      <Tabs
        value={scope}
        onChange={setScope}
        tabs={[
          { id: 'environment', label: 'Environments', badge: envs.length },
          { id: 'collection', label: 'Collection variables', badge: colVarCount },
          { id: 'workspace', label: 'Workspace variables', badge: wsVars.length },
          { id: 'global', label: 'Global variables', badge: globals.length },
        ]}
        right={<span className="text-xs text-muted pr-2">Precedence: Global → Workspace → Environment → Collection → Request → Runtime</span>}
      />
      <div className="flex-1 min-h-0">
        {scope === 'environment' && (
          <Split id="envs" sidebar initial={22}>
            <div className="h-full flex flex-col bg-panel/50" onKeyDown={treeKeys}>
              <TreeRowShell
                kind="section:environment"
                nodeId="environments:section"
                label="Environments"
                header
                className="mx-0 pl-3 shrink-0"
                ctx={() => ({ create: [{ label: 'New environment', icon: <Plus size={14} />, onSelect: () => void newEnvironment() }], on: { recentlyDeleted: () => setTrashOpen(true) } })}
              >
                <span className="text-[0.82rem] font-semibold truncate">Environments</span>
                {envs.length > 0 && <CountPill n={envs.length} />}
              </TreeRowShell>
              <div className="flex-1 overflow-auto" role="tree" aria-label="Environments">
                {envs.map((e, i) => (
                  <TreeRowShell
                    key={e.id}
                    kind="environment"
                    git={{ kind: 'environment', environmentId: e.id }}
                    nodeId={`env:${e.id}`}
                    label={e.name}
                    active={sel === e.id}
                    onClick={() => {
                      setSel(e.id, { preview: true });
                      useApp.getState().markPlace('environments', { environmentId: e.id });
                    }}
                    onOpen={() => setSel(e.id)}
                    ctx={() => envMenu(e)}
                    rename={
                      renamingEnv === e.id
                        ? {
                            value: e.name,
                            label: 'Environment name',
                            validate: (name) => (envs.some((x) => x.id !== e.id && x.name.toLowerCase() === name.toLowerCase()) ? 'Another environment has this name' : undefined),
                            done: (name) => void renameEnv(e, name),
                          }
                        : undefined
                    }
                    // dragged onto another row it moves there (the order is the one every environment picker uses); Alt+↑/↓ too
                    drag={[{ kind: 'environment', environmentId: e.id }]}
                    onDragStart={() => setDragId(e.id)}
                    onDragEnd={() => (setDragId(undefined), setDropAt(undefined))}
                    drop={{
                      onDragOver: (ev) => {
                        if (!dragId || dragId === e.id) return;
                        ev.preventDefault();
                        setDropAt(i);
                      },
                      onDragLeave: () => setDropAt((d) => (d === i ? undefined : d)),
                      onDrop: (ev) => {
                        ev.preventDefault();
                        if (dragId) void move(dragId, i);
                      },
                      over: dropAt === i ? 'before' : undefined,
                    }}
                    onKeyDown={(ev) => {
                      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
                      ev.preventDefault();
                      void move(e.id, ev.key === 'ArrowUp' ? i - 1 : i + 1);
                    }}
                    className={cx('pl-3 cursor-grab active:cursor-grabbing', dragId === e.id && 'opacity-50')}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: envColor(e) }} />
                    <span className="truncate">{String(e.name)}</span>
                    {e.isProduction && <Badge tone="bad">prod</Badge>}
                    {e.problem ? (
                      <span className="ml-auto text-warn" title={`This environment's file cannot be read: ${e.problem}`}>
                        <TriangleAlert size={13} aria-label="Cannot be read" />
                      </span>
                    ) : (
                      <span className="ml-auto">
                        <CountPill n={e.variables?.length ?? 0} />
                      </span>
                    )}
                  </TreeRowShell>
                ))}
              </div>
            </div>
            <div className="h-full flex flex-col min-w-0">
            <LibraryTabStrip
              label="Open environments"
              library="environments"
              refOf={(t) => (t.savedId ? { kind: 'environment', environmentId: t.savedId } : undefined)}
              tabs={tabs.tabs}
              active={tabs.active.id}
              titleOf={(t) => envs.find((x) => x.id === t.savedId)?.name ?? 'Environment'}
              dirty={dirty}
              onSelect={tabs.select}
              onClose={(ids) => tabs.close(ids, null)}
              onKeep={tabs.keep}
              onNew={() => void newEnvironment()}
              newLabel="New environment"
            />
            <div className="flex-1 min-h-0">
            {draft ? (
              <div className="h-full overflow-auto p-3 flex flex-col gap-3">
                <div className="flex items-end gap-3 flex-wrap">
                  <Field label="Name">
                    <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                  <Field label="Color">
                    <input type="color" aria-label="Environment color" className="field h-8 w-14 p-1 cursor-pointer" value={draft.color ?? '#1a7f37'} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
                  </Field>
                  <Toggle
                    checked={!!draft.isProduction}
                    onChange={(isProduction) => setDraft({ ...draft, isProduction })}
                    label="Production — asks before anything that changes data"
                    title="Sending or running anything that can change data here asks first: POST, PUT, PATCH and DELETE, GraphQL mutations, gRPC calls that are not reads, messages, MCP tool calls, load tests. Reads go without asking. From the terminal: --allow-production."
                  />
                  <div className="ml-auto flex gap-2">
                    {envs.length > 1 && (
                      <Button icon={<ArrowLeftRight size={13} />} onClick={() => setComparing(true)} title="Compare with another environment">
                        Compare
                      </Button>
                    )}
                    {envs.length > 1 && (
                      <Button icon={<Grid3x3 size={13} />} onClick={() => setMatrix(true)} title="Every variable across every environment: what is missing, empty or off where">
                        Matrix
                      </Button>
                    )}
                    <Button icon={<ScanSearch size={13} />} title="Where this environment's variables are used; rename one everywhere" onClick={() => useApp.getState().set({ variableUsages: draft.variables[0]?.key ?? true })}>
                      Usages
                    </Button>
                    <Menu
                      align="end"
                      width={250}
                      trigger={
                        <Button icon={<Download size={13} />} title="Export (secret values are left out)">
                          Export
                        </Button>
                      }
                      items={[
                        { label: 'Postman environment (.json)', icon: <FileJson size={14} />, onSelect: () => void exportEnv('postman') },
                        { label: '.env file', icon: <FileText size={14} />, onSelect: () => void exportEnv('dotenv') },
                      ]}
                    />
                    <Button variant="primary" icon={<Save size={13} />} onClick={save} disabled={!!draft.problem} title={draft.problem ? 'Fix the file first: saving now would replace it with what is shown here' : undefined}>
                      Save
                    </Button>
                    <MoreMenu
                      label="More environment actions"
                      // the environment's own menu (lib/node-menu.ts), without Open and Make active: this page is it
                      items={buildNodeMenu(
                        'environment',
                        withRefDefaults({
                          ref: { kind: 'environment', environmentId: draft.id },
                          repo: inGit,
                          on: { duplicate: () => void duplicateEnv(draft), delete: () => void deleteEnv(draft) },
                        }, 'environment'),
                      )}
                    />
                  </div>
                </div>
                {draft.problem && (
                  <Callout tone="warn">
                    The file of this environment cannot be read, so its variables are not shown and it cannot be saved here: {draft.problem}. Fix the file (or restore it from git), or delete the environment.
                  </Callout>
                )}
                <KeyValueEditor
                  rows={rows}
                  allowSecret
                  secretStatus={secretStatus}
                  keyPlaceholder="Variable"
                  onChange={(next) => {
                    setSecretValues(Object.fromEntries(next.filter((r) => r.secret).map((r) => [r.key, r.value])));
                    setDraft({ ...draft, variables: next.map((r) => ({ key: r.key, value: r.secret ? '' : r.value, secret: r.secret, enabled: r.enabled })) });
                  }}
                />
                {unused.length > 0 && (
                  <p className="text-xs text-muted px-1" title="No request, script, saved item, test file or other variable reads these. Find usages to double-check before deleting.">
                    Not used anywhere in the workspace: <span className="mono text-fg">{unused.join(', ')}</span>
                  </p>
                )}
                <SecretRefsLine environment={draft.id} version={JSON.stringify(envs.find((e) => e.id === draft.id)?.variables ?? [])} />
                <CurrentValues envName={draft.name} />
                <div className="text-xs text-muted flex items-start gap-2 bg-panel rounded-md p-2">
                  <KeyRound size={13} className="mt-0.5 shrink-0" />
                  <span>
                    Secret variables are encrypted with the OS credential store and are never written to workspace files, exports, logs, traces or reports. In CI, provide them as environment variables named <span className="mono">TESTPION_SECRET_ENV_{'<ENV_ID>'}_{'<KEY>'}</span> or reference{' '}
                    <span className="mono">{'{{$env.NAME}}'}</span>.
                  </span>
                </div>
              </div>
            ) : tabs.empty && envs.length ? (
              // every tab closed: the shared empty state of a tab view (Tests, Monitors, Load tests, Evaluations, Playground)
              <NoOpenItems icon={KeyRound} title="No open environments" newLabel="New environment" onNew={() => void newEnvironment()}>
                Open an environment from the list to edit its variables; the top bar switches the active one.
              </NoOpenItems>
            ) : (
              <Empty
                title={envs.length ? 'Select an environment' : 'No environments yet'}
                actions={[{ label: 'New environment', onClick: () => void newEnvironment() }]}
              >
                {envs.length
                  ? 'Pick one on the left to edit its variables; the top bar switches the active one.'
                  : 'An environment holds the variables a request refers to as {{baseUrl}}, {{token}} …: one per stage (Development, Staging, Production), switched in the top bar. Secret values go to the OS secret store, never into the workspace files.'}
              </Empty>
            )}
            </div>
            </div>
          </Split>
        )}
        {scope === 'collection' && <CollectionVariablesPane initial={colVarsFor} />}
        {scope === 'workspace' && (
          <div className="p-3 flex flex-col gap-3 overflow-auto h-full">
            <ScopeHint
              empty={!wsVars.length}
              text="Workspace variables are shared by every collection and environment in this workspace, e.g. an app name or a team id. An environment or collection variable with the same name wins."
              collections={colVarCount}
              onCollections={() => setScope('collection')}
            />
            <KeyValueEditor rows={wsVars} onChange={setWsVars} keyPlaceholder="Variable" allowSecret />
            <div>
              <Button
                variant="primary"
                onClick={async () => {
                  await call('ws.update', { variables: wsVars });
                  await useApp.getState().refreshWorkspace();
                  useApp.getState().toast('Workspace variables saved', 'success');
                }}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted">Built-in: {'{{workspaceDir}}'}, {'{{$uuid}}'}, {'{{$timestamp}}'}, {'{{$isoTimestamp}}'}, {'{{$randomInt}}'}, {'{{$randomEmail}}'}, {'{{$env.NAME}}'}, {'{{$secret.NAME}}'}.</p>
          </div>
        )}
        {scope === 'global' && (
          <div className="p-3 flex flex-col gap-3 overflow-auto h-full">
            <ScopeHint
              empty={!globals.length}
              text="Global variables are available in every workspace on this computer (Postman's globals; scripts set them with tp.globals.set). Every other scope wins over them."
              collections={colVarCount}
              onCollections={() => setScope('collection')}
            />
            <KeyValueEditor rows={globals} onChange={setGlobals} keyPlaceholder="Variable" />
            <div>
              <Button variant="primary" onClick={() => settings && useApp.getState().saveSettings({ ...settings, globalVariables: globals }).then(() => useApp.getState().toast('Global variables saved', 'success'))}>
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
      {trashOpen && <TrashDialog kinds={['environment']} onClose={() => setTrashOpen(false)} onRestored={(r) => void load().then(() => setSel(r.id))} />}
      {comparing && sel && <EnvCompare environments={envs} initialLeft={sel} onClose={() => setComparing(false)} />}
      {matrix && <EnvMatrix onClose={() => setMatrix(false)} />}
    </div>
  );
}

/** Values set by scripts (tp.environment.set) for this environment — local to this machine, like Postman's current values. */
function CurrentValues({ envName }: { envName: string }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const load = () => void call<Record<string, unknown>>('currentValues.get', { scope: 'environment', owner: envName }).then(setValues);
  useEffect(load, [envName]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = Object.keys(values);
  return (
    <div className="rounded-md border border-line">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-sm">
        <span className="font-medium">Current values</span>
        <span className="text-xs text-muted">set by scripts on this machine; they override the values above and are never saved to workspace files</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={load}>
          Refresh
        </Button>
        <Button
          size="sm"
          disabled={!keys.length}
          onClick={async () => {
            await call('currentValues.reset', { scope: 'environment', owner: envName });
            load();
            useApp.getState().toast('Current values reset', 'success');
          }}
        >
          Reset all
        </Button>
      </div>
      {keys.length ? (
        <table className="w-full text-sm">
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t border-line first:border-0">
                <td className="px-3 py-1 mono w-1/3">{k}</td>
                <td className="px-3 py-1 mono text-muted truncate">{typeof values[k] === 'object' ? JSON.stringify(values[k]) : String(values[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="px-3 py-2 text-xs text-muted">None yet. Scripts can set them with tp.environment.set("key", value).</div>
      )}
    </div>
  );
}

/** What a variable scope is for; when it has none yet, says so and points to where the variables usually are. */
function ScopeHint({ empty, text, collections, onCollections }: { empty: boolean; text: string; collections: number; onCollections(): void }) {
  return (
    <div className={cx('text-xs rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1', empty ? 'border border-line bg-panel/60' : 'text-muted')} data-scope-hint>
      <span className={empty ? 'text-fg' : undefined}>{text}</span>
      {empty && (
        <span className="text-muted">
          None yet: type a name and a value below to add one.
          {collections > 0 && (
            <>
              {' '}
              Imported collections keep their variables in the collection:{' '}
              <button className="text-accent hover:underline" onClick={onCollections}>
                see the {collections} collection variables
              </button>
              .
            </>
          )}
        </span>
      )}
    </div>
  );
}
