import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Eye, Lock, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { activeCollectionId } from '../lib/var-popover';
import { useApp } from '../store';
import { Badge, Button, cx, Input, Tooltip } from './ui';

interface Row {
  key: string;
  initial?: string;
  current?: string;
  secret: boolean;
  enabled: boolean;
}
interface QuickLook {
  collection?: { id: string; name: string; variables: Row[] };
  environment?: { id: string; name: string; isProduction: boolean; variables: Row[] };
  workspace: Row[];
  globals: Row[];
}

function Table({ rows, empty, overridden }: { rows: Row[]; empty: string; overridden: Set<string> }) {
  if (!rows.length) return <p className="text-xs text-muted px-1 py-1">{empty}</p>;
  // the current value (set by a script on this machine) only when one differs from the value
  const hasCurrent = rows.some((r) => r.current !== undefined && r.current !== r.initial);
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="font-medium py-1 pr-2 w-1/3">Variable</th>
          <th className="font-medium py-1 pr-2">Value</th>
          {hasCurrent && (
            <th className="font-medium py-1" title="Set by a script on this machine; it is used instead of the value">
              Current value
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={cx('border-t border-line align-top', (!r.enabled || overridden.has(r.key)) && 'opacity-50')} data-variable={r.key}>
            <td className="py-1 pr-2 mono break-all">
              {r.secret && <Lock size={10} className="inline mr-1 text-muted" aria-label="Secret" />}
              {r.key}
              {overridden.has(r.key) && (
                <span className="ml-1 font-sans text-[0.65rem] text-muted" title="A scope above sets it too, and wins">
                  (overridden)
                </span>
              )}
            </td>
            <td className="py-1 pr-2 mono break-all">{r.initial ?? <span className="text-muted">—</span>}</td>
            {hasCurrent && <td className="py-1 mono break-all">{r.current !== undefined && r.current !== r.initial ? r.current : ''}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const QUICK_LOOK = 'testpion:quick-look';

/** Open the overview on one variable (from a {{variable}}'s popover ▸ All). */
export function openQuickLook(variable?: string): void {
  window.dispatchEvent(new CustomEvent(QUICK_LOOK, { detail: { variable } }));
}

/**
 * Every variable the request on screen can use, at a glance (like Postman's quick look, next to the environment
 * picker): its collection's, the active environment's, the workspace's and the globals, in the order they win, with
 * initial and current values and a filter. Secret and sensitive values are masked.
 */
export function EnvQuickLook() {
  const env = useApp((s) => s.environment);
  const [data, setData] = useState<QuickLook>();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  /** Opened from a {{variable}}: its name, to say where it is set, or that it is set nowhere. */
  const [focus, setFocus] = useState<string>();
  useEffect(() => {
    const h = (e: Event) => {
      const v = (e as CustomEvent<{ variable?: string }>).detail?.variable;
      setFocus(v);
      setFilter('');
      setOpen(true);
      load();
    };
    window.addEventListener(QUICK_LOOK, h);
    return () => window.removeEventListener(QUICK_LOOK, h);
  });
  const load = () => void call<QuickLook>('env.quickLook', { environment: env, collectionId: activeCollectionId() }).then(setData);
  const go = (view: 'environments' | 'collections', payload: Record<string, unknown>) => {
    setOpen(false);
    useApp.getState().openIntent(view, payload);
  };
  const f = filter.trim().toLowerCase();
  const shown = (rows: Row[] = []) => (f ? rows.filter((r) => r.key.toLowerCase().includes(f) || (!r.secret && `${r.initial ?? ''} ${r.current ?? ''}`.toLowerCase().includes(f))) : rows);
  // a variable set in a scope above wins: shown faded below
  const names = (rows: Row[] = []) => rows.filter((r) => r.enabled).map((r) => r.key);
  const above = {
    collection: new Set<string>(),
    environment: new Set(names(data?.collection?.variables)),
    workspace: new Set([...names(data?.collection?.variables), ...names(data?.environment?.variables)]),
    globals: new Set([...names(data?.collection?.variables), ...names(data?.environment?.variables), ...names(data?.workspace)]),
  };
  /** For one variable: each scope in the order they win, whether it sets it, and which one the request uses. */
  const trace = (() => {
    if (!focus || !data) return undefined;
    const scopes: Array<{ id: string; title: string; rows?: Row[]; edit?: () => void; missing?: string }> = [
      {
        id: 'collection',
        title: data.collection ? `Collection · ${data.collection.name}` : 'Collection',
        rows: data.collection?.variables,
        edit: data.collection ? () => go('collections', { collectionId: data.collection!.id, tab: 'variables' }) : undefined,
        missing: data.collection ? undefined : 'no collection open',
      },
      {
        id: 'environment',
        title: data.environment ? `Environment · ${data.environment.name}` : 'Environment',
        rows: data.environment?.variables,
        edit: data.environment ? () => go('environments', { environmentId: data.environment!.id }) : undefined,
        missing: data.environment ? undefined : 'no environment chosen',
      },
      { id: 'workspace', title: 'Workspace', rows: data.workspace, edit: () => go('environments', { tab: 'workspace' }) },
      { id: 'globals', title: 'Globals', rows: data.globals, edit: () => go('environments', { tab: 'globals' }) },
    ];
    let used = false;
    const lines = scopes.map((sc) => {
      const row = sc.rows?.find((r) => r.key === focus);
      const state: 'used' | 'overridden' | 'off' | 'unset' = !row ? 'unset' : !row.enabled ? 'off' : used ? 'overridden' : 'used';
      if (state === 'used') used = true;
      return { ...sc, row, state };
    });
    return { lines, winner: lines.find((l) => l.state === 'used') };
  })();
  const valueOf = (r: Row) => (r.secret ? '••••••' : (r.current ?? r.initial ?? ''));
  const count = (data?.collection?.variables.length ?? 0) + (data?.environment?.variables.length ?? 0) + (data?.workspace.length ?? 0) + (data?.globals.length ?? 0);
  const section = (title: React.ReactNode, rows: Row[] | undefined, empty: string, overridden: Set<string>, edit?: () => void, extra?: React.ReactNode) => (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-sm font-semibold min-w-0 truncate">{title}</h3>
        {extra}
        {rows && <span className="text-xs text-muted">{rows.length}</span>}
        {edit && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={edit}>
            Edit
          </Button>
        )}
      </div>
      {rows ? <Table rows={shown(rows)} empty={f && rows.length ? 'No match.' : empty} overridden={overridden} /> : <p className="text-xs text-muted">{empty}</p>}
    </section>
  );
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) load();
        else setFocus(undefined);
      }}
    >
      <Tooltip content="All variables (quick look)">
        <PopoverPrimitive.Trigger asChild>
          <button
            aria-label="Variables quick look"
            className={cx('inline-flex items-center justify-center rounded-md h-8 w-8 text-muted hover:text-fg hover:bg-hover transition-colors', open && 'bg-hover text-fg')}
          >
            <Eye size={16} />
          </button>
        </PopoverPrimitive.Trigger>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label="Variables quick look"
          className="z-[70] w-[640px] max-w-[94vw] max-h-[75vh] overflow-auto rounded-xl border border-line bg-bg p-3 shadow-lg animate-in fade-in-0 zoom-in-95 duration-150 flex flex-col gap-3"
        >
          {focus ? (
            <div className="flex items-center gap-2" data-variable-focus={focus}>
              <span className="mono text-sm text-accent truncate">{`{{${focus}}}`}</span>
              <span className="text-xs text-muted">where it is set, in the order the scopes win</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  setFocus(undefined);
                  setFilter('');
                }}
              >
                Show all variables
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <Input
                  autoFocus
                  className="h-8 pl-7 text-sm"
                  placeholder={`Filter ${count} variables by name or value`}
                  aria-label="Filter variables"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            </div>
          )}
          {trace?.winner?.row && (
            <div className="rounded-md border border-line bg-panel p-2 text-sm grid gap-1" data-variable-resolves>
              <div className="text-xs text-muted">This request uses</div>
              <div className="mono break-all">{valueOf(trace.winner.row) || <span className="text-muted">(empty)</span>}</div>
              <div className="text-xs text-muted">
                from {trace.winner.title}
                {trace.winner.row.current !== undefined && trace.winner.row.current !== trace.winner.row.initial ? ' (its current value, set by a script on this machine)' : ''}
              </div>
            </div>
          )}
          {trace && (trace.winner || (data && [data.collection?.variables, data.environment?.variables, data.workspace, data.globals].some((rows) => rows?.some((r) => r.key === focus)))) && (
            <ol className="grid gap-1" data-variable-trace>
              {trace.lines.map((l, i) => (
                <li
                  key={l.id}
                  className={cx('flex items-center gap-2 text-sm rounded-md px-2 py-1.5 border border-line', l.state === 'used' && 'bg-accent-soft', l.state === 'unset' && 'opacity-60')}
                  data-scope={l.id}
                  data-state={l.state}
                >
                  <span className="text-xs text-muted w-4 shrink-0">{i + 1}</span>
                  <span className="truncate min-w-0">{l.title}</span>
                  <span className="mono text-xs text-muted truncate min-w-0 flex-1 text-right">{l.row && l.state !== 'unset' ? valueOf(l.row) : (l.missing ?? '')}</span>
                  <Badge tone={l.state === 'used' ? 'ok' : l.state === 'overridden' ? 'warn' : 'default'}>
                    {l.state === 'used' ? 'used' : l.state === 'overridden' ? 'overridden' : l.state === 'off' ? 'turned off' : 'not set'}
                  </Badge>
                  {l.edit && (
                    <Button size="sm" variant="ghost" onClick={l.edit}>
                      Edit
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {focus && data && ![data.collection?.variables, data.environment?.variables, data.workspace, data.globals].some((rows) => rows?.some((r) => r.key === focus)) && (
            <div role="status" className="rounded-md border border-warn/50 bg-warn/5 p-2 text-sm flex items-center gap-2 flex-wrap" data-not-defined={focus}>
              <span>
                <span className="mono">{`{{${focus}}}`}</span> is not defined anywhere: not in the collection, the environment{data.environment ? ` (${data.environment.name})` : ''}, the workspace or
                the globals.
              </span>
              {data.environment && (
                <Button size="sm" variant="soft" className="ml-auto" onClick={() => go('environments', { environmentId: data.environment!.id, addVariable: focus })}>
                  Add to {data.environment.name}
                </Button>
              )}
            </div>
          )}
          {!focus &&
            section(
              data?.collection ? `Collection: ${data.collection.name}` : 'Collection',
              data?.collection?.variables,
              data?.collection ? 'This collection has no variables.' : 'Open a request of a collection to see its variables here.',
              above.collection,
              data?.collection ? () => go('collections', { collectionId: data.collection!.id, tab: 'variables' }) : undefined,
            )}
          {!focus &&
            section(
              data?.environment?.name ? `Environment: ${data.environment.name}` : 'Environment',
              data?.environment?.variables,
              data?.environment ? 'This environment has no variables.' : 'Pick an environment in the selector to use its variables.',
              above.environment,
              data?.environment ? () => go('environments', { environmentId: data.environment!.id }) : undefined,
              data?.environment?.isProduction ? <Badge tone="bad">PRODUCTION</Badge> : undefined,
            )}
          {!focus && section('Workspace', data?.workspace ?? [], 'No workspace variables.', above.workspace, () => go('environments', { tab: 'workspace' }))}
          {!focus && section('Globals', data?.globals ?? [], 'No global variables.', above.globals, () => go('environments', { tab: 'globals' }))}
          <p className="text-[0.7rem] text-muted">
            {focus
              ? 'A scope higher up wins: the collection over the environment, the environment over the workspace and the globals. Edit opens the scope to change the value there.'
              : 'Listed in the order they win: a collection variable overrides the environment, which overrides the workspace and the globals. Current values are set by scripts and kept on this machine only. Secret values are never shown.'}
          </p>
          <PopoverPrimitive.Arrow className="fill-[var(--line)]" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
