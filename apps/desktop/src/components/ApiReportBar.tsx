import { useMemo, type ReactNode } from 'react';
import { OutputActions } from './output/OutputFrame';
import { apiReportSpec, type ApiReport } from './output/api-report-specs';

/**
 * The down arrow of an API report (lint, fuzzing, coverage, the security review, a comparison of two versions): one
 * bar for all five, so each saves the same two formats the same way. `children` are the report's own tools.
 */
export function ApiReportBar({ kind, report, children }: { kind: ApiReport['kind']; report?: ApiReport; children?: ReactNode }) {
  const spec = useMemo(() => apiReportSpec(report, kind), [report, kind]);
  return (
    <div className="flex items-center ml-auto min-w-0" data-output="api.reports">
      <OutputActions spec={spec}>{children}</OutputActions>
    </div>
  );
}
