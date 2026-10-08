import { Copy, ExternalLink, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCollections } from '../lib/collections-store';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import type { KeyValue } from '../types';
import { KeyValueEditor } from './KeyValueEditor';
import { CountPill, TreeHeader, treeKeys } from './TreeParts';
import { Button, cx, Empty, Split } from './ui';
import { refreshEnvironments } from '../lib/environments-store';
import { plural } from '../lib/format';

/**
 * Environments ▸ Collection variables: every collection's variables in one place (they are also in each collection's
 * settings). Pick a collection on the left, edit its variables on the right, Save.
 */
export function CollectionVariablesPane({ initial }: { initial?: string }) {
  // the shared list: a save elsewhere replaces only that collection, so unsaved edits here stay
  const all = useCollections();
  const cols = useMemo(() => all.filter((c) => !c.problem), [all]);
  const [sel, setSel] = useState<string | undefined>(initial);
  const [rows, setRows] = useState<KeyValue[]>([]);
  const [saved, setSaved] = useState<string>('[]');
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => setSel((s) => (s && cols.some((c) => c.id === s) ? s : (cols.find((c) => c.variables?.length)?.id ?? cols[0]?.id))), [cols]);
  useEffect(() => setSel((s) => initial ?? s), [initial]);
  const current = cols.find((c) => c.id === sel);
  // the stored variables come in when another collection is picked, or when they change and nothing here is unsaved
  // (a refresh or a save elsewhere must not drop what is being typed)
  const shownId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const v = (current?.variables ?? []) as KeyValue[];
    const other = shownId.current !== current?.id;
    if (!other && JSON.stringify(rowsRef.current) !== savedRef.current) return;
    shownId.current = current?.id;
    setRows(v);
    setSaved(JSON.stringify(v));
  }, [current?.id, current?.variables]);
  const dirty = JSON.stringify(rows) !== saved;

  const pick = async (id: string) => {
    if (id === sel) return;
    if (dirty && !(await confirmAction({ title: 'Unsaved changes', message: `The variables of "${current?.name}" have unsaved changes.`, confirmLabel: 'Discard changes', danger: true }))) return;
    setSel(id);
  };
  const save = async () => {
    if (!current) return;
    try {
      await call('col.save', { ...current, variables: rows });
      setSaved(JSON.stringify(rows));
      useApp.getState().toast(`Saved the variables of "${current.name}"`, 'success');
    } catch (e) {
      toastError(e);
    }
  };

  /** Collection variables apply only to its requests: copy them into the active environment to use them anywhere. */
  const copyToEnvironment = async () => {
    const name = useApp.getState().environment;
    if (!name) return useApp.getState().toast('Choose an environment in the top bar first: the variables are copied into it.', 'error');
    const env = (await refreshEnvironments()).find((e) => e.name === name);
    if (!env) return;
    const have = new Set(env.variables.map((v) => v.key));
    const add = rows.filter((r) => r.key && !have.has(r.key));
    const kept = rows.filter((r) => r.key && have.has(r.key)).length;
    if (!add.length) return useApp.getState().toast(`"${name}" already has all ${rows.filter((r) => r.key).length} of these variables`, 'success');
    const ok = await confirmAction({
      title: 'Copy to environment',
      message: `Copy ${plural(add.length, 'variable')} of "${current?.name}" to the environment "${name}"?`,
      detail: `${kept ? `${kept} it already has keep their value there. ` : ''}Then they work everywhere this environment is active (MCP servers, other collections). In this collection's requests the collection's own value still wins.`,
      confirmLabel: 'Copy',
      tone: 'question',
    });
    if (!ok) return;
    try {
      await call('env.save', { env: { ...env, variables: [...env.variables, ...add.map((r) => ({ key: r.key, value: r.value, enabled: r.enabled !== false }))] } });
      await useApp.getState().refreshWorkspace();
      useApp.getState().toast(`Copied ${plural(add.length, 'variable')} to "${name}"`, 'success');
    } catch (e) {
      toastError(e);
    }
  };

  if (!cols.length)
    return (
      <Empty title="No collections yet" icon={<ExternalLink size={22} />}>
        Collection variables belong to a collection: create or import one in Collections first.
      </Empty>
    );
  return (
    <Split id="collection-vars" sidebar initial={22}>
      <div className="h-full flex flex-col bg-panel/50" onKeyDown={treeKeys}>
        <TreeHeader title="Collections" count={cols.length} />
        <div className="flex-1 overflow-auto py-1" role="list" aria-label="Collections">
          {cols.map((c) => (
            <button
              key={c.id}
              data-tree-row
              aria-current={c.id === sel ? 'true' : undefined}
              onClick={() => void pick(c.id)}
              className={cx('w-[calc(100%-0.5rem)] mx-1 flex items-center gap-2 h-8 px-3 rounded-md text-sm text-left transition-colors', c.id === sel ? 'bg-accent-soft' : 'hover:bg-hover')}
            >
              <span className="truncate flex-1">{c.name}</span>
              <CountPill n={c.variables?.length ?? 0} />
            </button>
          ))}
        </div>
      </div>
      <div className="h-full overflow-auto p-3 flex flex-col gap-3">
        {current && (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="font-semibold truncate">{current.name}</h2>
              <span className="text-xs text-muted shrink-0">{rows.length} variables</span>
              <Button size="sm" variant="ghost" className="ml-auto" icon={<ExternalLink size={13} />} onClick={() => useApp.getState().openIntent('collections', { collectionId: current.id, tab: 'variables' })}>
                Open collection
              </Button>
              <Button size="sm" icon={<Copy size={13} />} disabled={!rows.some((r) => r.key)} onClick={() => void copyToEnvironment()} title="Use them outside this collection too (MCP servers, other collections)">
                Copy to environment
              </Button>
              <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
            </div>
            <p className="text-xs text-muted">Used by this collection's requests. A collection variable overrides an environment, workspace or global variable with the same name, and is overridden by request and runtime variables.</p>
            <KeyValueEditor rows={rows} onChange={setRows} keyPlaceholder="Variable" />
          </>
        )}
      </div>
    </Split>
  );
}
