/**
 * RPC handlers of judge calibration (the matrix drill-down's Pass/Fail labels and the Calibrate panel): label a judged
 * result, list the labels, and the calibration report of a run against them (with the best pass mark per metric). The window
 * computes nothing: the engine does, the same as `testpion rag label|calibrate` and the MCP tools.
 */
import { applyThreshold, calibrateRun, clearLabel, defaultLabelsName, labelResult, readLabels, recordOfResult } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function ragCalibrateHandlers(be: Backend): Handlers {
  const nameOf = (run: string, labels?: string) => labels || defaultLabelsName(be.ws, run);
  return {
    /** The labels of a run's label set (all, or the ones of one result's record). */
    'rag.label.list': ({ run, labels, result }: { run: string; labels?: string; result?: string }) => {
      const name = nameOf(run, labels);
      let all: ReturnType<typeof readLabels>['labels'] = [];
      try {
        all = readLabels(be.ws, name).labels;
      } catch {
        /* no file yet */
      }
      const record = result ? recordOfResult(result) : undefined;
      return { labels: name, items: record ? all.filter((l) => l.record === record) : all };
    },
    'rag.label.set': async ({ run, result, metric, label, note, labels }: { run: string; result: string; metric: string; label: 'pass' | 'fail'; note?: string; labels?: string }) => labelResult(be.ws, { run, result, metric, label, note, labels }),
    'rag.label.clear': ({ run, labels, result, metric }: { run: string; labels?: string; result: string; metric: string }) => ({ cleared: clearLabel(be.ws, nameOf(run, labels), recordOfResult(result), metric) }),
    /** The calibration report of a run; `tune` adds the best pass mark per metric. */
    'rag.calibrate': ({ run, labels, metrics, tune, thresholds }: { run: string; labels?: string; metrics?: string[]; tune?: boolean; thresholds?: Record<string, number> }) => calibrateRun(be.ws, { run, labels: nameOf(run, labels), metrics, tune, thresholds }),
    /** Write a tuned pass mark into a saved evaluation's evaluator, or a custom metric file (with its `calibration:` summary). */
    'rag.calibrate.apply': (p: { metric: string; threshold: number; evaluation?: string; calibration?: { run: string; kappa?: number; tpr?: number; tnr?: number; n: number } }) => applyThreshold(be.ws, p),
  };
}
