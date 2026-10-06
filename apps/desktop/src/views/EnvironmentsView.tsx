import { ArchiveRestore, ArrowLeftRight, Check, Copy, Grid3x3, Download, FileJson, FileText, History, KeyRound, Pencil, Save, ScanSearch, Trash2 } from 'lucide-react';
import { useGit } from '../lib/git';
import { GitItemHistory } from '../components/GitItemHistory';
import { useEffect, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, promptText, useApp } from '../store';
import { useIntent } from '../hooks';
import type { Collection, Environment, KeyValue } from '../types';
import { CollectionVariablesPane } from '../components/CollectionVariablesPane';
import { download, uid } from '../lib/format';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { EnvCompare } from '../components/EnvCompare';
import { EnvMatrix } from '../components/EnvMatrix';
import { TrashDialog } from '../components/TrashDialog';
import { Badge, Button, cx, Empty, Field, Input, Menu, MoreMenu, Split, Tabs, Toggle } from '../components/ui';
import { CountPill, focusRow, InlineRename, RowMenu, TreeHeader, treeKeys } from '../components/TreeParts';

export function EnvironmentsView() {
  const git = useGit();
  const [historyOf, setHistoryOf] = useState<{ id: string; name: string }>();
  const ws = useApp((s) => s.workspace);
  const settings = useApp((s) => s.settings);
  const activeEnv = useApp((s) => s.environment);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [comparing, setComparing] = useState(false);
  const [matrix, setMatrix] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  /** Export the selected environment (secret values are never exported). */
  const exportEnv = async (format: 'postman' | 'dotenv') => {
    if (!draft) return;
    try {
      const r = await call<{ path?: string; environment?: unknown; text?: string; name: string }>('env.export', { id: draft.id, format });
      if (r.environment) download(r.name, JSON.stringify(r.environment, null, 2));
      else if (r.text !== undefined) download(r.name, r.text, 'text/plain');
      else if (r.path) useApp.getState().toast(`Exported to ${r.path} (secret values are left out)`, 'success');
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    }
  };
  const [sel, setSel] = useState<string>();
  const [draft, setDraft] = useState<Environment>();
  /** A copy of an environment (secret values are not copied). */
  const duplicateEnv = async (from: Environment) => {
    const env = { ...from, id: uid('env-'), name: `${from.name} copy`, isProduction: false, variables: from.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) };
    await call('env.save', { env });
    await load();
    setSel(env.id);
    await useApp.getState().refreshWorkspace();
  };
  const deleteEnv = async (env: Environment) => {
    if (!(await confirmAction({ title: 'Delete environment', message: `Delete the environment "${env.name}"?`, detail: 'You can restore it, with its secret values, from Recently deleted for 30 days.', confirmLabel: 'Delete environment', danger: true }))) return;
    await call('env.delete', { id: env.id });
    if (sel === env.id) setSel(undefined);
    await load();
    await useApp.getState().refreshWorkspace();
  };
  const [menuFor, setMenuFor] = useState<string>();
  /** The environment being renamed in place (F2, or Rename in its menu). */
  const [renamingEnv, setRenamingEnv] = useState<string>();
  /** Rename from the list: the active environment (chosen by name) stays active, and the open one keeps its unsaved edits. */
  const renameEnv = async (env: Environment, name?: string) => {
    setRenamingEnv(undefined);
    focusRow(env.id);
    if (!name) return;
    try {
      reordering.current = true;
      await call('env.save', { env: { ...env, name } });
      await load();
      if (activeEnv === env.name) useApp.getState().setEnvironment(name);
      await useApp.getState().refreshWorkspace();
    } catch (e) {
      reordering.current = false;
      useApp.getState().toast(asError(e).message, 'error');
    }
  };
  // variables of the open environment that nothing reads (refreshed when it is opened or saved)
  const [unused, setUnused] = useState<string[]>([]);
  const refreshUnused = (env?: string) => void (env ? call<string[]>('vars.unused', { environment: env }).then(setUnused, () => setUnused([])) : setUnused([]));
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<'environment' | 'collection' | 'workspace' | 'global'>('environment');
  const [colVarsFor, setColVarsFor] = useState<string>();
  const [colVarCount, setColVarCount] = useState(0);
  useEffect(() => {
    const count = () => void call<Collection[]>('col.list').then((l) => setColVarCount(l.reduce((n, c) => n + (c.variables?.length ?? 0), 0)), () => undefined);
    count();
    return on('data.changed', count);
  }, []);
  const [wsVars, setWsVars] = useState<KeyValue[]>(ws?.variables ?? []);
  const [globals, setGlobals] = useState<KeyValue[]>(settings?.globalVariables ?? []);
  const load = async () => {
    const e = await call<Environment[]>('env.list');
    setEnvs(e);
    setSel((s) => s ?? e[0]?.id);
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
      const saved = await call<Environment[]>('env.reorder', { ids: next.map((e) => e.id) });
      reordering.current = true;
      setEnvs(saved);
      await useApp.getState().refreshWorkspace();
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
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
      // a reorder or a rename from the list: keep the open environment's unsaved edits
      if (e) setDraft((d) => (d?.id === e.id ? { ...d, order: e.order, name: e.name } : e));
      return;
    }
    setDraft(e);
    refreshUnused(e?.name);
    setSecretValues({});
    if (e) void call('env.secretStatus', { envId: e.id, keys: e.variables.filter((v) => v.secret).map((v) => v.key) }).then(setSecretStatus);
  }, [sel, envs]);
  useIntent('environments', (p) => {
    if (p?.environmentId) (setScope('environment'), setSel(p.environmentId));
    else if (p?.tab === 'globals') setScope('global');
    else if (p?.tab === 'workspace') setScope('workspace');
    else if (p?.tab === 'collection') (setScope('collection'), setColVarsFor(p.collectionId));
  });

  const rows: KeyValue[] = (draft?.variables ?? []).map((v) => ({ ...v, value: v.secret ? secretValues[v.key] ?? '' : v.value }));
  const save = async () => {
    if (!draft) return;
    try {
      // secret values go to the OS credential store; only the key is written to the workspace file
      const variables = rows.map((r) => ({ key: r.key, value: r.secret ? '' : r.value, secret: r.secret, enabled: r.enabled }));
      const secrets = Object.fromEntries(rows.filter((r) => r.secret && r.value).map((r) => [r.key, r.value]));
      // a variable switched to secret keeps its previous plain value as the secret
      for (const r of rows) {
        const prev = envs.find((e) => e.id === draft.id)?.variables.find((v) => v.key === r.key);
        if (r.secret && !r.value && prev && !prev.secret && prev.value) secrets[r.key] = prev.value;
      }
      await call('env.save', { env: { ...draft, variables }, secrets });
      await load();
      await useApp.getState().refreshWorkspace();
      useApp.getState().toast('Environment saved', 'success');
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    }
  };
  return (
    <div className="h-full flex flex-col">
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
              <TreeHeader
                title="Environments"
                count={envs.length}
                addLabel="New environment"
                onAdd={async () => {
                  const name = await promptText('New environment', { message: 'Environment name', value: 'Staging', okLabel: 'Create' });
                  if (!name) return;
                  const env: Environment = { id: uid('env-'), name, variables: [{ key: 'baseUrl', value: '', enabled: true }] };
                  await call('env.save', { env });
                  await load();
                  setSel(env.id);
                  await useApp.getState().refreshWorkspace();
                }}
                menu={[{ label: 'Recently deleted…', icon: <ArchiveRestore size={14} />, onSelect: () => setTrashOpen(true) }]}
              />
              {envs.map((e, i) => (
                <div
                  key={e.id}
                  draggable={renamingEnv !== e.id}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setMenuFor(e.id);
                  }}
                  onDragStart={(ev) => {
                    setDragId(e.id);
                    ev.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(ev) => {
                    if (!dragId || dragId === e.id) return;
                    ev.preventDefault();
                    setDropAt(i);
                  }}
                  onDragLeave={() => setDropAt((d) => (d === i ? undefined : d))}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    if (dragId) void move(dragId, i);
                  }}
                  onDragEnd={() => (setDragId(undefined), setDropAt(undefined))}
                  className={cx(
                    'group flex items-center gap-1 h-8 mx-1 pl-3 pr-1 rounded-md cursor-grab active:cursor-grabbing transition-colors',
                    sel === e.id ? 'bg-accent-soft' : 'hover:bg-hover',
                    menuFor === e.id && sel !== e.id && 'bg-hover',
                    dragId === e.id && 'opacity-50',
                    dropAt === i && 'shadow-[inset_0_2px_0_var(--accent)]',
                  )}
                >
                  {renamingEnv === e.id ? (
                    <div className="flex-1 min-w-0 flex items-center gap-2 text-sm">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color ?? (e.isProduction ? 'var(--bad)' : 'var(--ok)') }} />
                      <InlineRename
                        value={e.name}
                        label="Environment name"
                        validate={(name) => (envs.some((x) => x.id !== e.id && x.name.toLowerCase() === name.toLowerCase()) ? 'Another environment has this name' : undefined)}
                        onCommit={(name) => void renameEnv(e, name)}
                        onCancel={() => void renameEnv(e)}
                      />
                    </div>
                  ) : (
                  <button
                    className="flex-1 min-w-0 flex items-center gap-2 text-left text-sm"
                    title="Drag (or Alt+↑/↓) to reorder · F2 renames"
                    data-tree-row
                    data-rename-id={e.id}
                    onClick={() => {
                      setSel(e.id);
                      useApp.getState().markPlace('environments', { environmentId: e.id });
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'F2') {
                        ev.preventDefault();
                        return setRenamingEnv(e.id);
                      }
                      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
                      ev.preventDefault();
                      void move(e.id, ev.key === 'ArrowUp' ? i - 1 : i + 1);
                    }}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color ?? (e.isProduction ? 'var(--bad)' : 'var(--ok)') }} />
                    <span className="truncate">{e.name}</span>
                    {e.isProduction && <Badge tone="bad">prod</Badge>}
                    <span className="ml-auto"><CountPill n={e.variables.length} /></span>
                  </button>
                  )}
                  <RowMenu
                    label={e.name}
                    open={menuFor === e.id}
                    onOpenChange={(o) => setMenuFor(o ? e.id : undefined)}
                    items={[
                      { label: 'Make active', icon: <Check size={14} />, disabled: activeEnv === e.name, onSelect: () => void useApp.getState().setEnvironment(e.name) },
                      { label: 'Rename', icon: <Pencil size={14} />, separator: true, onSelect: () => setRenamingEnv(e.id) },
                      { label: 'Duplicate', icon: <Copy size={14} />, onSelect: () => void duplicateEnv(e) },
                      ...(git.status?.repository ? [{ label: 'History in git…', icon: <History size={14} />, onSelect: () => setHistoryOf({ id: e.id, name: e.name }) }] : []),
                      { label: 'Delete', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void deleteEnv(e) },
                    ]}
                  />
                </div>
              ))}
            </div>
            {draft ? (
              <div className="h-full overflow-auto p-3 flex flex-col gap-3">
                <div className="flex items-end gap-3 flex-wrap">
                  <Field label="Name">
                    <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                  <Field label="Color">
                    <input type="color" aria-label="Environment color" className="field h-8 w-14 p-1 cursor-pointer" value={draft.color ?? '#1a7f37'} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
                  </Field>
                  <Toggle checked={!!draft.isProduction} onChange={(isProduction) => setDraft({ ...draft, isProduction })} label="Production (blocks load tests, shows a warning)" />
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
                    <Button variant="primary" icon={<Save size={13} />} onClick={save}>
                      Save
                    </Button>
                    <MoreMenu
                      label="More environment actions"
                      items={[
                        { label: 'Duplicate', icon: <Copy size={14} />, onSelect: () => void duplicateEnv(draft) },
                        ...(git.status?.repository ? [{ label: 'History in git…', icon: <History size={14} />, onSelect: () => setHistoryOf({ id: draft.id, name: draft.name }) }] : []),
                        { label: 'Delete environment', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void deleteEnv(draft) },
                      ]}
                    />
                  </div>
                </div>
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
                <CurrentValues envName={draft.name} />
                <div className="text-xs text-muted flex items-start gap-2 bg-panel rounded-md p-2">
                  <KeyRound size={13} className="mt-0.5 shrink-0" />
                  <span>
                    Secret variables are encrypted with the OS credential store and are never written to workspace files, exports, logs, traces or reports. In CI, provide them as environment variables named <span className="mono">TESTPION_SECRET_ENV_{'<ENV_ID>'}_{'<KEY>'}</span> or reference{' '}
                    <span className="mono">{'{{$env.NAME}}'}</span>.
                  </span>
                </div>
              </div>
            ) : (
              <Empty title="Select an environment" />
            )}
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
              text="Global variables are available in every workspace on this computer (Postman's globals; scripts set them with pm.globals.set). Every other scope wins over them."
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
      {trashOpen && <TrashDialog kind="environment" onClose={() => setTrashOpen(false)} onRestored={(r) => void load().then(() => setSel(r.id))} />}
      {comparing && sel && <EnvCompare environments={envs} initialLeft={sel} onClose={() => setComparing(false)} />}
      {matrix && <EnvMatrix onClose={() => setMatrix(false)} />}
      {historyOf && <GitItemHistory target={{ environmentId: historyOf.id }} name={historyOf.name} onClose={() => (setHistoryOf(undefined), void load())} />}
    </div>
  );
}

/** Values set by scripts (pm.environment.set) for this environment — local to this machine, like Postman's current values. */
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
        <div className="px-3 py-2 text-xs text-muted">None yet. Scripts can set them with pm.environment.set("key", value).</div>
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
