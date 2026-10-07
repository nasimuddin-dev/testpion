import { useEffect, useState } from 'react';
import { call } from '../api';
import { formatCost, formatMs, plural, timeAgo, undatedModel } from '../lib/format';
import { BarRow, ChartCard, StatTile, Swatch } from './charts';
import { Empty, LinkButton, Spinner } from './ui';
import { useApp } from '../store';

/** From `ai.usage` (llmUsage in core). */
interface Usage {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  medianMs?: number;
  medianFirstTokenMs?: number;
  lastAt: string;
}

const IN = 'color-mix(in oklab, var(--accent) 45%, transparent)';
const OUT = 'var(--accent)';

/** What the prompts run here used, per model: tokens (input and output), estimated cost and time. */
export function AiUsage() {
  const [rows, setRows] = useState<Usage[]>();
  useEffect(() => {
    void call<Usage[]>('ai.usage').then(setRows, () => setRows([]));
  }, []);
  if (!rows)
    return (
      <div className="h-full grid place-items-center">
        <Spinner />
      </div>
    );
  if (!rows.length) return <Empty title="No prompts run yet">Each prompt you run in the Playground or a comparison is counted here: tokens, estimated cost and time per model.</Empty>;
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const tokensIn = rows.reduce((n, r) => n + r.inputTokens, 0);
  const tokensOut = rows.reduce((n, r) => n + r.outputTokens, 0);
  const priced = rows.filter((r) => r.costUsd !== undefined);
  const cost = priced.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  return (
    <div className="h-full overflow-auto p-4 flex flex-col gap-3 max-w-5xl">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <StatTile label="Prompts run" value={calls.toLocaleString()} sub={plural(rows.length, 'model')} />
        <StatTile label="Input tokens" value={tokensIn.toLocaleString()} />
        <StatTile label="Output tokens" value={tokensOut.toLocaleString()} />
        <StatTile
          label="Estimated cost"
          value={priced.length ? formatCost(cost) : '—'}
          sub={
            priced.length === rows.length ? (
              'from the price table'
            ) : (
              // the first model without a price gets a row in the price table, ready to fill in
              <>
                {priced.length ? 'models with a known price · ' : 'no price yet · '}
                <LinkButton
                  onClick={() => {
                    const m = rows.find((r) => r.costUsd === undefined);
                    useApp.getState().openIntent('settings', { tab: 'pricing', ...(m ? { addPrice: { provider: m.provider, model: undatedModel(m.model) } } : {}) });
                  }}
                >
                  Set prices…
                </LinkButton>
              </>
            )
          }
        />
      </div>
      <ChartCard
        title="Tokens per model"
        legend={
          <>
            <Swatch color={IN} label="Input" />
            <Swatch color={OUT} label="Output" />
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          {rows.slice(0, 15).map((r) => (
            <BarRow
              key={`${r.provider}·${r.model}`}
              label={<span title={`${r.provider} · ${r.model}`}>{r.model}</span>}
              labelClass="w-48"
              rightClass="w-24"
              segments={[
                { value: r.inputTokens, color: IN },
                { value: r.outputTokens, color: OUT },
              ]}
              of={max}
              right={(r.inputTokens + r.outputTokens).toLocaleString()}
              title={`${r.provider} · ${r.model}: ${r.inputTokens.toLocaleString()} in, ${r.outputTokens.toLocaleString()} out, ${plural(r.calls, 'call')}`}
            />
          ))}
        </div>
      </ChartCard>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted text-left">
            <th className="font-normal py-1">Model</th>
            <th className="font-normal text-right">Prompts</th>
            <th className="font-normal text-right">Tokens in / out</th>
            <th className="font-normal text-right">Cost</th>
            <th className="font-normal text-right">Median time</th>
            <th className="font-normal text-right">First token</th>
            <th className="font-normal text-right pl-4">Last used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.provider}·${r.model}`} className="border-t border-line/60">
              <td className="py-1.5">
                <span className="text-fg">{r.model}</span> <span className="text-xs text-muted">{r.provider}</span>
              </td>
              <td className="text-right tabular-nums">{r.calls}</td>
              <td className="text-right tabular-nums">
                {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
              </td>
              <td className="text-right tabular-nums">{r.costUsd === undefined ? '—' : formatCost(r.costUsd)}</td>
              <td className="text-right tabular-nums">{formatMs(r.medianMs)}</td>
              <td className="text-right tabular-nums">{formatMs(r.medianFirstTokenMs)}</td>
              <td className="text-right text-muted pl-4">{timeAgo(r.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        From the latest 2000 prompts run in the AI Lab. Agents get the same with the <code>llm_usage</code> MCP tool; <code>testpion history llm</code> prints it.
      </p>
    </div>
  );
}
