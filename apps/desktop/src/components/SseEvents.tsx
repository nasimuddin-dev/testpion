import { useSticky } from '../lib/sticky';
import { ArrivalSpark } from './charts';
import { useId, useMemo, useState } from 'react';
import { Radio, Square } from 'lucide-react';
import type { SseEvent } from '../types';
import { Badge, Button, cx, Empty, Input, Split, VirtualList } from './ui';
import { JsonTree, RawView } from './JsonView';
import { prettyBody } from '../lib/pretty';
import { plural } from '../lib/format';

const ROW = 30;

/**
 * Server-Sent Events, one row per event (time, type, id, data), like Postman's event stream view.
 * Live while the stream is open (with Stop); a selected event shows its data in full (JSON as a tree).
 */
export function SseEvents({ events, live, onStop, stopped, dropped, stateKey }: { events: SseEvent[]; live?: boolean; onStop?(): void; stopped?: boolean; dropped?: number; /** Keeps the selected event when the live list gives way to the finished response (the request tab's id). */ stateKey?: string }) {
  const [filter, setFilter] = useState('');
  const own = useId();
  const [selected, setSelected] = useSticky<number | undefined>(`sse.selected.${stateKey ?? own}`, undefined);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = events.map((e, i) => ({ e, i }));
    return f ? all.filter(({ e }) => e.event.toLowerCase().includes(f) || e.data.toLowerCase().includes(f) || (e.id ?? '').toLowerCase().includes(f)) : all;
  }, [events, filter]);
  const types = useMemo(() => new Set(events.map((e) => e.event)).size, [events]);
  const sel = selected !== undefined ? events[selected] : undefined;
  const selJson = useMemo(() => {
    if (!sel) return undefined;
    try {
      return JSON.parse(sel.data) as unknown;
    } catch {
      return undefined;
    }
  }, [sel]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0 text-sm">
        {live ? (
          <span className="flex items-center gap-1.5 text-accent">
            <Radio size={14} className="animate-pulse" /> Receiving events
          </span>
        ) : (
          <span className="text-muted">Event stream</span>
        )}
        <Badge tone="accent">{plural(events.length, 'event')}</Badge>
        <ArrivalSpark times={events.map((e) => e.atMs)} />
        {types > 1 && <span className="text-xs text-muted">{types} types</span>}
        {stopped && <Badge tone="warn" title="You stopped the stream; these are the events received until then.">stopped</Badge>}
        {!!dropped && <Badge tone="warn" title="Only the first 10,000 events are kept.">{dropped} not kept</Badge>}
        <Input className="ml-auto h-7 w-48 text-xs" placeholder="Filter type, id or data" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter events" />
        {live && onStop && (
          <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
      {!events.length ? (
        <Empty icon={<Radio size={26} />} title={live ? 'Connected, waiting for the first event' : 'No events'}>
          {live ? 'Events appear here as the server sends them.' : 'The stream closed without a complete event.'}
        </Empty>
      ) : (
        <div className="flex-1 min-h-0">
          {/* the list and the selected event, with the divider between them dragged like every other split */}
          <Split id="sse-events" direction="vertical" initial={55} collapsedSecond={!sel}>
            <div className="h-full min-h-0 flex flex-col">
              <div className="grid grid-cols-[80px_120px_90px_1fr] gap-2 px-3 py-1 text-[11px] uppercase tracking-wide text-muted border-b border-line shrink-0">
                <span>Time</span>
                <span>Event</span>
                <span>Id</span>
                <span>Data</span>
              </div>
              <VirtualList
                className="flex-1"
                items={shown}
                rowHeight={ROW}
                scrollToIndex={live && !filter ? shown.length - 1 : undefined}
                render={({ e, i }) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelected(i === selected ? undefined : i)}
                    className={cx('w-full grid grid-cols-[80px_120px_90px_1fr] gap-2 px-3 items-center text-left text-xs border-b border-line/60 hover:bg-hover', i === selected && 'bg-accent-soft')}
                    style={{ height: ROW }}
                  >
                    <span className="tabular-nums text-muted">{(e.atMs / 1000).toFixed(2)} s</span>
                    <span className="truncate font-medium">{e.event}</span>
                    <span className="truncate mono text-muted">{e.id ?? ''}</span>
                    <span className="truncate mono">{e.data}</span>
                  </button>
                )}
              />
            </div>
            {sel ? (
              <div className="h-full min-h-0 flex flex-col" data-sse-event>
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted border-b border-line shrink-0">
                  <b className="text-fg">{sel.event}</b>
                  {sel.id && <span className="mono">id {sel.id}</span>}
                  {sel.retry !== undefined && <span>retry {sel.retry} ms</span>}
                  <span>at {(sel.atMs / 1000).toFixed(3)} s</span>
                </div>
                <div className="flex-1 min-h-0">{selJson !== undefined ? <JsonTree data={selJson} /> : <RawView text={prettyBody(sel.data)} />}</div>
              </div>
            ) : (
              <div />
            )}
          </Split>
        </div>
      )}
    </div>
  );
}
