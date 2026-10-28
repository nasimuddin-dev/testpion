import { useApp } from '../../store';
import { formatCost, plural } from '../../lib/format';
import type { EvalEstimateResult } from '../../lib/eval-estimate';
import { Badge, LinkButton } from '../ui';

/** Seconds as a few words: "a moment", "~40 s", "~3 min". */
const time = (s: number) => (s < 1 ? 'a moment' : s < 90 ? `~${Math.round(s)} s` : `~${Math.round(s / 60)} min`);

/**
 * What a run costs, said under Run before it starts (AU-5, AU-18): the cases, the price from the price table (or "free" for
 * the offline demo model and models on this computer), the time, the cap that stops it, and the one-click remedy when the
 * model has no price. The same numbers as `testpion eval estimate`.
 */
export function EvalCostLine({ estimate, model }: { estimate?: EvalEstimateResult; model: string }) {
  if (!estimate) return <span className="text-xs text-muted" data-eval-cost="loading">Estimating the cost …</span>;
  const { plan } = estimate;
  const cases = plural(estimate.cases, 'case');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" data-eval-cost={estimate.offline ? 'offline' : estimate.free ? 'free' : estimate.priced ? 'priced' : 'unknown'}>
      <span>
        {cases} · {estimate.free ? (estimate.offline ? 'free' : 'free, runs on this computer') : estimate.costUsd !== undefined ? `about ${formatCost(estimate.costUsd)}` : 'cost unknown'}
        {estimate.reviewerChecks > 0 && ` · ${estimate.calls} calls with the AI reviewer`} · {time(estimate.seconds)}
      </span>
      {estimate.offline && (
        <Badge tone="warn" title="The offline demo model needs no key and no network. Its answers come from rules, so use it to try things out, not to judge a real model.">
          Offline demo
        </Badge>
      )}
      {!estimate.priced && (
        <LinkButton
          icon={null}
          onClick={() => useApp.getState().openIntent('settings', { tab: 'pricing', addPrice: { provider: estimate.provider, model: model || estimate.model } })}
          title="Prices are yours to set (they change): add this model's price per million tokens, then the cost and the cap work"
        >
          Set a price…
        </LinkButton>
      )}
      {plan.capUsd !== undefined && !estimate.free && <span title="The run stops once it has cost this much. Change it under Options.">· stops at {formatCost(plan.capUsd)}</span>}
    </div>
  );
}
