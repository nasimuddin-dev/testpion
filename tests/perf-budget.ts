import { expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';

/**
 * Performance budgets that do not flake on a loaded machine (planning/review-2026-10-22-robustness.md, section 8).
 *
 * The owner's budgets are for a quiet machine. A test that asserts them on a shared box fails for reasons that are not the code, so:
 *  - what is asserted always is the WORK (operations counted: git spawns, parses, files read), which cannot flake;
 *  - the time is asserted against the budget scaled by a calibration of this machine's speed right now (a fixed CPU loop timed against
 *    its time on the reference machine) and by TESTPION_PERF_SLACK, with a margin;
 *  - TESTPION_PERF_GATE=1 (the release checklist, a quiet machine) holds the unscaled budget times TESTPION_PERF_SLACK.
 */
export const PERF_GATE = process.env.TESTPION_PERF_GATE === '1';
export const PERF_SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);

/** Time of the calibration loop on the reference machine (a developer laptop, idle), in ms. */
const REFERENCE_MS = 40;
/** The headroom over the scaled budget when the gate is off: a regression of an order of magnitude fails, a busy minute does not. */
const SOFT_MARGIN = 3;

let scale: number | undefined;

/** How much slower this machine is right now than the reference (1 = as fast or faster; capped at 25). */
export function machineScale(): number {
  if (scale !== undefined) return scale;
  const run = () => {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < 20_000_000; i++) x = (x + i * 31) | 0;
    if (x === 42) console.log(x); // keep the loop
    return performance.now() - t0;
  };
  const best = Math.min(run(), run(), run());
  scale = Math.min(25, Math.max(1, best / REFERENCE_MS));
  return scale;
}

/** The time a test may take: the budget on a quiet machine with the gate, else scaled to this machine with a margin. */
export function budgetMs(budget: number): number {
  return PERF_GATE ? budget * PERF_SLACK : budget * PERF_SLACK * machineScale() * SOFT_MARGIN;
}

/** Asserts `ms` is within the budget (see above); always logs how it went. */
export function expectWithin(ms: number, budget: number, what: string): void {
  const allowed = budgetMs(budget);
  console.log(`${what}: ${ms.toFixed(0)} ms (budget ${budget} ms${PERF_GATE ? ', gate on' : `, allowed ${allowed.toFixed(0)} ms on this machine (x${machineScale().toFixed(1)})`})`);
  expect(ms, `${what} took ${ms.toFixed(0)} ms, allowed ${allowed.toFixed(0)} ms`).toBeLessThan(allowed);
}

/** heapUsed after a full collection: without it the figure depends on when V8 last ran (the garbage is measured, not the leak). */
export function heapAfterGc(): number {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}
