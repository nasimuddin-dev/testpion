import { Plug, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { plural } from '../lib/format';
import { attempt } from '../store';
import { Menu, type MenuItem } from './ui';

interface RunningItem {
  kind: string;
  id: string;
  label: string;
  detail?: string;
}

/**
 * The status bar's "what runs now": the MCP servers connected, and how many other things the app keeps running for the
 * workspace (mock servers, the recorder, the Debugger, open connections, subscriptions). A click lists them all, each
 * with Stop: one place to find what still listens on a port or holds a connection open.
 */
export function RunningSegment({ mcp }: { mcp: number }) {
  const [items, setItems] = useState<RunningItem[]>([]);
  const load = () => void call<RunningItem[]>('app.running').then(setItems, () => undefined);
  useEffect(() => {
    load();
    // cheap (the backend lists what it holds); often enough for a count in the status bar
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const others = items.filter((i) => i.kind !== 'mcp').length;
  const menu: MenuItem[] = items.length
    ? items.map((i) => ({
        // choosing a row stops it: the label says so
        label: `Stop: ${i.detail ? `${i.label}  ·  ${i.detail}` : i.label}`,
        icon: <Square size={14} />,
        title: `Stop: ${i.label}`,
        onSelect: () => void attempt(async () => setItems(await call<RunningItem[]>('app.stopRunning', { kind: i.kind, id: i.id }))),
      }))
    : [{ label: 'Nothing is running', disabled: true, reason: 'No mock server, recorder, capture or open connection', onSelect: () => undefined }];
  return (
    <Menu
      width={380}
      items={menu}
      trigger={
        <button className="flex items-center gap-1 hover:text-fg" title="What runs now: click to see each, with Stop" onClick={load} data-running={items.length}>
          <Plug size={12} /> {plural(mcp, 'MCP server')} connected
          {others > 0 && <span className="text-accent">{` · ${others} more running`}</span>}
        </button>
      }
    />
  );
}
