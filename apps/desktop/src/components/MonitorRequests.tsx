import { useEffect, useState } from 'react';
import { call } from '../api';
import { formatMs, plural } from '../lib/format';
import { BarRow, ChartCard } from './charts';
import { RefLink } from './RefLink';
import { type ItemRef } from '@testpion/shared';

/** From `monitor.requests` (monitorRequestStats in core). */
interface Stat {
  name: string;
  runs: number;
  failed: number;
  medianMs?: number;
  p95Ms?: number;
  lastFailure?: string;
  /** Where it comes from: the saved request, or the test file at its step (WF-08). */
  ref?: ItemRef;
}

/** The monitor's requests over its latest runs: median time as a bar (slowest first), failures next to it. */
export function MonitorRequests({ monitorId, refresh }: { monitorId: string; refresh?: string }) {
  const [rows, setRows] = useState<Stat[]>([]);
  useEffect(() => {
    let live = true;
    void call<Stat[]>('monitor.requests', { id: monitorId, runs: 20 }).then(
      (r) => live && setRows(r),
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [monitorId, refresh]);
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.medianMs ?? 0));
  const failing = rows.filter((r) => r.failed > 0).length;
  // a folder shared by every request ("Smoke / …") is said once, in the header
  const first = rows[0]!.name;
  const cut = first.lastIndexOf(' / ');
  const prefix = cut > 0 && rows.every((r) => r.name.startsWith(first.slice(0, cut + 3))) ? first.slice(0, cut + 3) : '';
  return (
    <ChartCard
      title="Requests"
      aside={
        <span>
          {prefix ? `${prefix.slice(0, -3)} · ` : ''}median time over the last runs{failing ? <b className="text-bad"> · {plural(failing, 'request')} failed</b> : null}
        </span>
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.slice(0, 15).map((r) => (
          <BarRow
            key={r.name}
            label={
              r.ref ? (
                <RefLink to={r.ref} icon={false} title={`Open ${r.name}`} className="text-fg">
                  {r.name.slice(prefix.length)}
                </RefLink>
              ) : (
                <span title={r.name}>{r.name.slice(prefix.length)}</span>
              )
            }
            labelClass="w-56"
            rightClass="w-44 whitespace-nowrap"
            segments={[{ value: r.medianMs ?? 0, color: r.failed ? 'var(--bad)' : 'var(--accent)' }]}
            of={max}
            right={
              <span>
                {formatMs(r.medianMs)}
                {r.failed > 0 ? (
                  <span className="text-bad">
                    {' '}
                    · {r.failed}/{r.runs} failed
                  </span>
                ) : (
                  <span className="text-muted"> · p95 {formatMs(r.p95Ms)}</span>
                )}
              </span>
            }
            title={`${r.name}: median ${formatMs(r.medianMs)}, p95 ${formatMs(r.p95Ms)} over ${plural(r.runs, 'run')}${r.failed ? `; failed ${r.failed} times, latest: ${r.lastFailure ?? '?'}` : ''}`}
          />
        ))}
      </div>
    </ChartCard>
  );
}
