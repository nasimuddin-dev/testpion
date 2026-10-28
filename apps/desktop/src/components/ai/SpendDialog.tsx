import type { EvalEstimateResult } from '../../lib/eval-estimate';
import { formatCost } from '../../lib/format';
import { Button, Modal } from '../ui';

/** A run that costs more than $0.50 (or makes over 100 calls) asks once before it sends anything (AU-18). */
export function SpendDialog({ estimate, onRun, onClose }: { estimate: EvalEstimateResult; onRun(): void; onClose(): void }) {
  return (
    <Modal
      title="This run costs money"
      onClose={onClose}
      onSubmit={onRun}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onRun} data-spend-run>
            Run {estimate.cases} cases
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm" data-spend-dialog>
        <p>
          {estimate.costUsd !== undefined ? `Running ${estimate.cases} cases on ${estimate.provider}${estimate.model ? ` / ${estimate.model}` : ''} costs about ${formatCost(estimate.costUsd)}.` : `Running ${estimate.cases} cases makes about ${estimate.calls} calls to ${estimate.provider}${estimate.model ? ` / ${estimate.model}` : ''}, and the model has no price, so the cost is not known.`}
        </p>
        {estimate.plan.reason && <p className="text-muted">{estimate.plan.reason}</p>}
        <p className="text-muted">Tip: set “Only the first … cases” under Options to try a few cases first.</p>
      </div>
    </Modal>
  );
}
