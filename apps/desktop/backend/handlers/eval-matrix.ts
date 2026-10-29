/** RPC handlers: evaluations as a matrix (cases × variants, a page at a time) and a run compared with a baseline run. */
import { compareEvalRuns, evalMatrixPage, evalMatrixResult, type EvalMatrixParams, type EvalMatrixQuery } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { evalQualityHandlers } from './eval-quality.js';
import { evalReportHandlers } from './eval-report.js';

export function evalMatrixHandlers(be: Backend): Handlers {
  return {
    // the sample, the estimate and the spend cap, and one check tried on one case (eval-quality.ts)
    ...evalQualityHandlers(be),
    // the report card, why a case failed, a case against the run before, compare mode (eval-report.ts)
    ...evalReportHandlers(be),
    /**
     * A page of the matrix of `runs` (columns, in order) against `baseline`: the rows asked for with their cells, the
     * column stats, the chip counts and the tags. Built once per set of runs and kept; pages, filters and sorts read it.
     */
    'eval.matrix': (p: EvalMatrixParams & EvalMatrixQuery) => evalMatrixPage(be.ws, p),
    /** One cell's result, whole (input, output, expected, checks with the judge's reasoning, its review). */
    'eval.matrixResult': ({ runId, resultId }: { runId: string; resultId: string }) => evalMatrixResult(be.ws, runId, resultId),
    /** A run against a baseline run, case by case (what `testpion eval compare` prints). */
    'eval.compare': (p: { run: string; baseline: string; threshold?: number; maxRegressions?: number; failOnMissing?: boolean; limit?: number }) => compareEvalRuns(be.ws, p),
  };
}
