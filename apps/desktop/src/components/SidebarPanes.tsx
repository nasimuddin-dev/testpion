import { Check, History, KeyRound, Pencil, Plus } from 'lucide-react';
import { RowMenu } from './TreeParts';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { promptText, useApp } from '../store';
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
    useApp.getState().openIntent('environments', { environmentId: id });
  };
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 pb-2">
        <Input className="flex-1 h-7 min-h-7 text-sm" placeholder="Filter environments" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <IconButton label="New environment" onClick={() => void create()}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="flex-1 overflow-auto">
        <button className={cx('w-[calc(100%-0.5rem)] mx-1 rounded-md flex items-center gap-2 px-3 h-8 text-sm text-left transition-colors', !env ? 'bg-accent-soft text-accent' : 'hover:bg-hover text-muted')} onClick={() => useApp.getState().setEnvironment(undefined)}>
          <span className="w-2 h-2 rounded-full bg-[var(--line-strong)] shrink-0" />
          <span className="flex-1">No environment</span>
          {!env && <Check size={13} />}
        </button>
        {envs.map((e) => (
          <div key={e.id} className={cx('group flex items-center gap-2 mx-1 rounded-md px-3 h-8 text-sm transition-colors', e.name === env ? 'bg-accent-soft text-accent' : 'hover:bg-hover')}>
            <button
              className={cx('flex-1 flex items-center gap-2 text-left min-w-0', e.problem && 'text-bad cursor-not-allowed')}
              disabled={!!e.problem}
              onClick={() => useApp.getState().setEnvironment(e.name)}
              title={e.problem ? `This environment's file cannot be read: ${e.problem}` : 'Make this the active environment'}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color ?? (e.isProduction ? 'var(--bad)' : 'var(--ok)') }} />
              <span className="truncate">{e.name}</span>
              {e.isProduction && <Badge tone="bad">prod</Badge>}
              {e.name === env && <Check size={13} className="ml-auto shrink-0" />}
            </button>
            <RowMenu
              label={e.name}
              items={[
                { label: 'Make active', icon: <Check size={14} />, disabled: e.name === env, onSelect: () => useApp.getState().setEnvironment(e.name) },
                { label: 'Edit', icon: <Pencil size={14} />, onSelect: () => useApp.getState().openIntent('environments', { environmentId: e.id }) },
              ]}
            />
          </div>
        ))}
        {!ws?.environments.length && (
          <Empty icon={<KeyRound size={22} />} title="No environments">
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
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-2 pb-2">
        <Input className="w-full h-7 min-h-7 text-sm" placeholder="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto">
        {rows.map((r, i) =>
          'header' in r ? (
            <div key={`h-${i}`} className="px-3 pt-2.5 pb-1 text-xs font-semibold text-muted">
              {r.header}
            </div>
          ) : (
            <button
              key={r.item.id}
              className="w-[calc(100%-0.5rem)] mx-1 rounded-md flex items-center gap-2 px-2 h-8 text-sm text-left hover:bg-hover transition-colors"
              title={r.item.url}
              onClick={() => (onOpen ? onOpen(r.item) : useApp.getState().openIntent('history', { historyId: r.item.id }))}
            >
              {r.item.method && <span className={cx('mono method-badge text-[0.64rem] font-bold w-12 shrink-0', `method-${r.item.method}`)}>{r.item.method}</span>}
              <span className="truncate flex-1">{kind === 'http' ? (r.item.url ?? r.item.name) : r.item.name}</span>
              {r.item.status !== undefined && <Badge tone={statusTone(r.item.status)}>{r.item.status}</Badge>}
            </button>
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
