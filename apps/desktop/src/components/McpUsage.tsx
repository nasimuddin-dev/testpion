import { formatMs, plural, timeAgo } from '../lib/format';
import { BarRow, ChartCard, Swatch } from './charts';
import { Empty, Spinner } from './ui';
import { useRpc } from '../lib/use-rpc';

/** From `mcp.toolUsage` (mcpToolUsage in core). */
interface Usage {
  tool: string;
  calls: number;
  failed: number;
  medianMs?: number;
  p95Ms?: number;
  lastAt: string;
}

/** How this server's tools have been called from the app: calls and failures per tool, and their times. */
export function McpUsage({ serverId }: { serverId: string }) {
  const rows = useRpc<Usage[]>('mcp.toolUsage', { serverId }, { fallback: [] });
  if (!rows)
    return (
      <div className="h-full grid place-items-center">
        <Spinner />
      </div>
    );
  if (!rows.length) return <Empty title="No tool calls yet">Each tool you execute here is counted, with its failures and how long it took.</Empty>;
  const max = Math.max(...rows.map((r) => r.calls));
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const failed = rows.reduce((n, r) => n + r.failed, 0);
  return (
    <div className="h-full overflow-auto p-3 flex flex-col gap-3">
      <ChartCard
        title="Calls per tool"
        aside={
          <span>
            {plural(calls, 'call')} · <b className={failed ? 'text-bad' : 'text-ok'}>{failed} failed</b>
          </span>
        }
        legend={
          <>
            <Swatch color="var(--ok)" label="Succeeded" />
            <Swatch color="var(--bad)" label="Failed (isError or no result)" />
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          {rows.slice(0, 20).map((r) => (
            <BarRow
              key={r.tool}
              label={<span className="mono">{r.tool}</span>}
              labelClass="w-40"
              segments={[
                { value: r.calls - r.failed, color: 'var(--ok)' },
                { value: r.failed, color: 'var(--bad)' },
              ]}
              of={max}
              right={r.calls}
              title={`${r.tool}: ${plural(r.calls, 'call')}, ${r.failed} failed`}
            />
          ))}
        </div>
      </ChartCard>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted text-left">
            <th className="font-normal py-1">Tool</th>
            <th className="font-normal text-right">Calls</th>
            <th className="font-normal text-right">Failed</th>
            <th className="font-normal text-right">Median</th>
            <th className="font-normal text-right">p95</th>
            <th className="font-normal text-right pl-4">Last used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tool} className="border-t border-line/60">
              <td className="py-1.5 mono text-xs">{r.tool}</td>
              <td className="text-right tabular-nums">{r.calls}</td>
              <td className={'text-right tabular-nums ' + (r.failed ? 'text-bad' : 'text-muted')}>{r.failed}</td>
              <td className="text-right tabular-nums">{formatMs(r.medianMs)}</td>
              <td className="text-right tabular-nums">{formatMs(r.p95Ms)}</td>
              <td className="text-right text-muted pl-4">{timeAgo(r.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        From the tool calls made in the app (the latest 2000). Agents get the same with the <code>mcp_tool_usage</code> MCP tool; <code>testpion history mcp-tools</code> prints it.
      </p>
    </div>
  );
}
