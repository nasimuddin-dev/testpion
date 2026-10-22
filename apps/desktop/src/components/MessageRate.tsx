import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';

interface Msg {
  time: number;
  direction: 'sent' | 'received' | 'system';
  size: number;
}

const SECONDS = 60;

/**
 * A connection's traffic at a glance: messages and bytes sent and received, and a sparkline of messages per
 * second over the last minute (received at the base, sent above). Redraws every second while `live` (the connection
 * is open and the tab on screen); a closed connection or a hidden tab costs nothing.
 */
export function MessageRate({ messages, live = true }: { messages: Msg[]; live?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  // the totals are counted once per change of the log, not once per tick
  const totals = useMemo(() => {
    let sent = 0;
    let received = 0;
    let sentBytes = 0;
    let receivedBytes = 0;
    for (const m of messages) {
      if (m.direction === 'system') continue;
      if (m.direction === 'sent') (sent++, (sentBytes += m.size));
      else (received++, (receivedBytes += m.size));
    }
    return { sent, received, sentBytes, receivedBytes };
  }, [messages]);
  // the last minute is at the end of the log (messages arrive in time order): the scan stops at the first older one
  const buckets = useMemo(() => {
    const b = Array.from({ length: SECONDS }, () => ({ sent: 0, received: 0 }));
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const age = Math.floor((now - m.time) / 1000);
      if (age >= SECONDS) break;
      if (m.direction !== 'system' && age >= 0) b[SECONDS - 1 - age]![m.direction]++;
    }
    return b;
  }, [messages, now]);
  const { sent, received, sentBytes, receivedBytes } = totals;
  let max = 1;
  let lastMinute = 0;
  for (const b of buckets) {
    const n = b.sent + b.received;
    lastMinute += n;
    if (n > max) max = n;
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted" title={`Sent ${sent} (${formatBytes(sentBytes)}), received ${received} (${formatBytes(receivedBytes)}); ${lastMinute} in the last minute`}>
      <span className="tabular-nums">
        <span className="text-accent">↑</span> {sent} · <span className="text-ok">↓</span> {received}
      </span>
      <span className="hidden md:inline tabular-nums">{formatBytes(sentBytes + receivedBytes)}</span>
      <span aria-hidden className="inline-flex items-end gap-px h-4 w-[120px]">
        {buckets.map((b, i) => (
          <span key={i} className="flex flex-col-reverse flex-1 h-full">
            {b.received > 0 && <span className="w-full rounded-[1px] bg-ok" style={{ height: `${(b.received / max) * 100}%` }} />}
            {b.sent > 0 && <span className="w-full rounded-[1px] bg-accent" style={{ height: `${(b.sent / max) * 100}%` }} />}
          </span>
        ))}
      </span>
    </span>
  );
}
