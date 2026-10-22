import { envColor } from './EnvSelect';
import { Check, History, KeyRound, Plus } from 'lucide-react';
import { TreeBadge, treeKeys } from './TreeParts';
import { TreeRowShell } from './TreeRowShell';
import { saveAsTest } from '../lib/save-test';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { promptText, useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { groupByDay, uid } from '../lib/format';
import { Badge, cx, Empty, IconButton, Input, statusTone } from './ui';

/** Sidebar pane: the workspace's environments; click one to make it active (Postman's Environments sidebar). */
export function EnvironmentsPane() {
  const ws = useApp((s) => s.workspace);
  const env = useApp((s) => s.environment);
  const [filter, setFilter] = useState('');
  const envs = (ws?.environments ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const create = async () => {
    const name = (await promptText('New environment', { message: 'Environment name', placeholder: 'Staging', okLabel: 'Create', icon: <KeyRound size={18} /> }))?.trim();
    if (!name) return;
    const id = uid('env-');
    await call('env.save', { env: { id, name, variables: [{ key: 'baseUrl', value: '' }] } });
    await useApp.getState().refreshWorkspace();
    void openRef({ kind: 'environment', environmentId: id });
  };
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 pb-2">
        <Input className="flex-1 h-7 min-h-7 text-sm" placeholder="Filter environments" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <IconButton label="New environment" onClick={() => void create()}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="flex-1 overflow-auto" role="tree" aria-label="Environments" onKeyDown={treeKeys}>
        <button className={cx('w-[calc(100%-0.5rem)] mx-1 rounded-md flex items-center gap-2 px-3 h-8 text-sm text-left transition-colors', !env ? 'bg-accent-soft text-accent' : 'hover:bg-hover text-muted')} onClick={() => useApp.getState().setEnvironment(undefined)}>
          <span className="w-2 h-2 rounded-full bg-[var(--line-strong)] shrink-0" />
          <span className="flex-1">No environment</span>
          {!env && <Check size={13} />}
        </button>
        {/* the one row (TreeRowShell): click makes it active, Enter / double-click opens it, ⋯ / right-click / Shift+F10 its menu */}
        {envs.map((e) => (
          <TreeRowShell
            key={e.id}
            kind="environment"
            git={{ kind: 'environment', environmentId: e.id }}
            nodeId={`env-pane:${e.id}`}
            label={e.name}
            active={e.name === env}
            onClick={() => !e.problem && useApp.getState().setEnvironment(e.name)}
            onOpen={() => void openRef({ kind: 'environment', environmentId: e.id })}
            ctx={() => ({
              ref: { kind: 'environment', environmentId: e.id },
              name: e.name,
              on: { open: () => void openRef({ kind: 'environment', environmentId: e.id }), makeActive: () => useApp.getState().setEnvironment(e.name) },
              disabled: e.name === env ? { makeActive: 'It is the active environment' } : e.problem ? { makeActive: 'Its file cannot be read' } : {},
            })}
            className={cx('pl-3', e.name === env && 'text-accent')}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: envColor(e) }} />
            <span className={cx('truncate', e.problem && 'text-bad')}>{e.name}</span>
            {e.isProduction && <Badge tone="bad">prod</Badge>}
            {e.name === env && <Check size={13} className="ml-auto shrink-0" />}
          </TreeRowShell>
        ))}
        {!ws?.environments.length && (
          <Empty icon={<KeyRound size={22} />} title="No environments" actions={[{ label: 'New environment', icon: <Plus size={13} />, onClick: () => void create() }]}>
            Environments hold variables such as <span className="mono">baseUrl</span> and tokens.
          </Empty>
        )}
      </div>
    </div>
  );
}

export interface HistoryItem {
  id: string;
  timestamp: string;
  kind: string;
  name: string;
  method?: string;
  url?: string;
  status?: number | string;
  request?: unknown;
}

/**
 * Sidebar pane: recent requests of one kind (http, graphql, grpc, websocket, mcp, llm) grouped by day.
 * Clicking one hands it to the view (REST opens it in a new tab); without `onOpen` it opens in History.
 */
export function HistoryPane({ kind = 'http', onOpen, noun = 'Requests you send' }: { kind?: string; onOpen?(item: HistoryItem): void; noun?: string }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const load = () => void call<{ items: HistoryItem[] }>('history.list', { kind, query: filter || undefined, limit: 100 }).then((r) => setItems(r.items));
    const t = setTimeout(load, 150);
    const off = useApp.subscribe((s, p) => s.activity !== p.activity && Object.keys(s.activity).length < Object.keys(p.activity).length && load());
    return () => (clearTimeout(t), off());
  }, [filter, kind]);
  const rows = useMemo(() => groupByDay(items, (h) => h.timestamp), [items]);
  const open = (item: HistoryItem) => (onOpen ? onOpen(item) : void openRef({ kind: 'history', historyId: item.id }));
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-2 pb-2">
        <Input className="w-full h-7 min-h-7 text-sm" placeholder="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto" role="tree" aria-label="History" onKeyDown={treeKeys}>
        {rows.map((r, i) =>
          'header' in r ? (
            <div key={`h-${i}`} className="px-3 pt-2.5 pb-1 text-xs font-semibold text-muted">
              {r.header}
            </div>
          ) : (
            // the one row (TreeRowShell): click or Enter opens it, ⋯ / right-click / Shift+F10 its menu, it drags onto a flow canvas
            <TreeRowShell
              key={r.item.id}
              kind="history"
              nodeId={`history-pane:${r.item.id}`}
              label={r.item.name}
              onClick={() => open(r.item)}
              onOpen={() => open(r.item)}
              drag={[{ kind: 'history', historyId: r.item.id }]}
              ctx={() => ({ ref: { kind: 'history', historyId: r.item.id }, name: r.item.name, on: { open: () => open(r.item), testFile: () => void saveAsTest({ ref: { kind: 'history', historyId: r.item.id }, name: r.item.name }) } })}
              className="pl-2"
            >
              {r.item.method && <TreeBadge label={r.item.method} className={`method-${r.item.method}`} />}
              <span className="truncate flex-1">{kind === 'http' ? (r.item.url ?? r.item.name) : r.item.name}</span>
              {r.item.status !== undefined && <Badge tone={statusTone(r.item.status)}>{r.item.status}</Badge>}
            </TreeRowShell>
          ),
        )}
        {!items.length && (
          <Empty icon={<History size={22} />} title={filter ? 'No matches' : 'No history yet'}>
            {filter ? 'Try another filter.' : `${noun} appear here, grouped by day.`}
          </Empty>
        )}
      </div>
    </div>
  );
}
