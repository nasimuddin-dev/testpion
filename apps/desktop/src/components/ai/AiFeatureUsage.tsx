import type { AiUsageSummary } from '@testpion/core';
import { formatCost, formatMs, plural, timeAgo } from '../../lib/format';
import { useRpc } from '../../lib/use-rpc';
import { useApp } from '../../store';
import { BarRow, ChartCard, StatTile } from '../charts';
import { LinkButton, Spinner } from '../ui';

const SURFACE: Record<string, string> = { app: 'App', cli: 'CLI', mcp: 'MCP agents', ci: 'CI' };

/**
 * What the AI features used in this workspace (the usage ledger, AIB-6): today and the last 30 days, the caps and what
 * is left of them, per task, per model and per surface (the app, the CLI, MCP agents, CI), and the latest calls.
 */
export function AiFeatureUsage() {
  const s = useRpc<AiUsageSummary>('ai.taskUsage', { days: 30 });
  if (!s)
    return (
      <div className="py-6 grid place-items-center">
        <Spinner />
      </div>
    );
  const tokens = (x: { inputTokens: number; outputTokens: number }) => (x.inputTokens + x.outputTokens).toLocaleString();
  const max = Math.max(1, ...s.byTask.map((t) => t.inputTokens + t.outputTokens));
  const caps = s.caps;
  return (
    <section className="flex flex-col gap-3" aria-label="AI features usage" data-ai-feature-usage>
      <h2 className="font-semibold">AI features</h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <StatTile label="Calls today" value={s.today.calls.toLocaleString()} sub={`${tokens(s.today)} tokens`} />
        <StatTile
          label="Cost today"
          value={formatCost(s.today.costUsd)}
          sub={caps.budgetLeftToday !== undefined ? `${formatCost(caps.budgetLeftToday)} left of ${formatCost(caps.dailyBudgetUsd)}` : 'no daily cap'}
        />
        <StatTile label={`Last ${s.period.days} days`} value={s.period.calls.toLocaleString()} sub={`${tokens(s.period)} tokens · ${formatCost(s.period.costUsd)}`} />
        <StatTile
          label="Tokens left today"
          value={caps.tokensLeftToday !== undefined ? caps.tokensLeftToday.toLocaleString() : '—'}
          sub={
            <LinkButton onClick={() => useApp.getState().openIntent('settings', { tab: 'assistant' })}>
              {caps.dailyTokens ? `of ${caps.dailyTokens.toLocaleString()} · Limits…` : 'Set limits…'}
            </LinkButton>
          }
        />
      </div>
      {s.byTask.length > 0 ? (
        <>
          <ChartCard title="Tokens per task">
            <div className="flex flex-col gap-1.5">
              {s.byTask.slice(0, 12).map((t) => (
                <BarRow
                  key={t.task}
                  label={t.task}
                  labelClass="w-48"
                  rightClass="w-28"
                  segments={[{ value: t.inputTokens + t.outputTokens, color: 'var(--accent)' }]}
                  of={max}
                  right={`${tokens(t)} · ${t.calls}×`}
                  title={`${t.task}: ${plural(t.calls, 'call')}, ${formatCost(t.costUsd)}`}
                />
              ))}
            </div>
          </ChartCard>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-muted text-left">
                  <th className="font-normal py-1">Model</th>
                  <th className="font-normal text-right">Calls</th>
                  <th className="font-normal text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {s.byModel.map((m) => (
                  <tr key={`${m.provider}/${m.model}`} className="border-t border-line/60">
                    <td className="py-1">
                      {m.model} <span className="text-xs text-muted">{m.provider}</span>
                    </td>
                    <td className="text-right tabular-nums">{m.calls}</td>
                    <td className="text-right tabular-nums">{m.unpriced === m.calls ? '—' : formatCost(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full">
              <thead>
                <tr className="text-xs text-muted text-left">
                  <th className="font-normal py-1">From</th>
                  <th className="font-normal text-right">Calls</th>
                  <th className="font-normal text-right">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {s.bySurface.map((x) => (
                  <tr key={x.surface} className="border-t border-line/60">
                    <td className="py-1">{SURFACE[x.surface] ?? x.surface}</td>
                    <td className="text-right tabular-nums">{x.calls}</td>
                    <td className="text-right tabular-nums">{tokens(x)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted text-xs">Latest calls</summary>
            <table className="w-full mt-1">
              <tbody>
                {s.recent.slice(0, 30).map((r) => (
                  <tr key={r.id} className="border-t border-line/60 text-xs">
                    <td className="py-1">{r.task}</td>
                    <td className="text-muted">{SURFACE[r.surface] ?? r.surface}</td>
                    <td className="text-muted">{r.model}</td>
                    <td className="text-right tabular-nums">{(r.inputTokens + r.outputTokens).toLocaleString()}</td>
                    <td className="text-right tabular-nums">{r.costUsd === undefined ? '—' : formatCost(r.costUsd)}</td>
                    <td className="text-right tabular-nums">{formatMs(r.ms)}</td>
                    <td className="pl-3">{r.outcome}</td>
                    <td className="text-right text-muted pl-3">{timeAgo(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p className="text-sm text-muted">
          No AI feature has been used in this workspace yet. Each call — explain, suggest checks, write a flow — is counted here, from the app, the CLI, MCP agents and CI.
        </p>
      )}
      <p className="text-xs text-muted">
        Agents get the same with the <code>ai_usage</code> MCP tool; <code>testpion ai usage</code> prints it.
      </p>
    </section>
  );
}
