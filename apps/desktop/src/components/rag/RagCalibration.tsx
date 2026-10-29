import { plural } from '../../lib/format';
import { useEffect, useMemo, useState } from 'react';
import type { CalibrationReport } from '@testpion/core';
import { outputFileName } from '@testpion/shared';
import { call } from '../../api';
import { Button, Callout, Modal, Spinner } from '../ui';
import { AgreementCard } from '../ai/AgreementCard';
import type { OutputSpec } from '../output/output-core';
import { OutputActions } from '../output/OutputFrame';

/**
 * Calibrate judge: how well the judge of each metric agrees with the Pass / Fail labels you gave in the sample detail
 * (and with your Good / Bad reviews of whole results). Cohen's kappa rather than raw agreement, a bootstrap interval,
 * the confusion matrix, the numbers per judge model, the samples where you disagree, and the pass mark that would agree
 * most. Statistics over what the run stored: no model is called.
 */
export function RagCalibration({ runId, evaluation, onUseThreshold, onOpenSample, onClose }: { runId: string; evaluation?: string; onUseThreshold?(metric: string, t: number): void; onOpenSample?(resultId: string, metric: string): void; onClose(): void }) {
  const [report, setReport] = useState<CalibrationReport>();
  const [error, setError] = useState<string>();
  const [rev, setRev] = useState(0);
  // the report as a file (Markdown or JSON): the engine builds it from the same labels, the same run
  const spec = useMemo<OutputSpec>(() => {
    const source = { kind: 'rag-calibration' as const, runId, ...(report?.labels ? { labels: report.labels } : {}) };
    return {
      id: 'rag.calibration',
      what: 'AI reviewer calibration report',
      name: outputFileName({ name: `rag-calibration-${runId}`, ext: '' }),
      formats: [
        { format: 'md', label: 'Report (Markdown)', source, default: true },
        { format: 'json', label: 'Numbers (JSON)', source },
      ],
      empty: report?.metrics.length ? undefined : 'Nothing is labelled yet',
    };
  }, [runId, report?.labels, report?.metrics.length]);
  useEffect(() => {
    let live = true;
    setReport(undefined);
    void call<CalibrationReport>('rag.calibrate', { run: runId, tune: true }).then(
      (r) => live && setReport(r),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [runId, rev]);
  return (
    <Modal title="Calibrate the AI reviewer" onClose={onClose} width={880} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-3 text-sm" data-rag-calibration data-output="rag.calibration">
        <div className="flex items-center">
          <OutputActions spec={spec} />
        </div>
        {error && <Callout tone="bad">{error}</Callout>}
        {!report && !error && <Spinner />}
        {report && (
          <>
            <div className="text-xs text-muted">
              {plural(report.labelled, 'labelled sample')} of {report.results} in this run · labels in labels/{report.labels}.json
              {report.stale ? ` · ${report.stale} left out because the system answered differently since` : ''}
              {report.missing ? ` · ${report.missing} labels are about records this run does not have` : ''}
            </div>
            {!report.metrics.length && <Callout tone="accent">Nothing to compare yet. Open a sample (click a cell of the matrix) and press Pass or Fail under “Your label” on a metric: 30 or more labels, passes and fails both, make the numbers worth trusting.</Callout>}
            {report.metrics.map((m) => (
              <AgreementCard key={m.metric} m={m} evaluation={evaluation} run={runId} onUse={onUseThreshold} onOpen={onOpenSample} onApplied={() => setRev((x) => x + 1)} />
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
