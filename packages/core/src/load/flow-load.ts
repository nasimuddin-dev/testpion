/**
 * A flow file as a load-test scenario: each virtual user runs the whole flow again and again (its steps with their
 * dependsOn, extracts, blocks and checks, its own variables and a cookie jar per user), and the load test counts every
 * step as a request of its own (per step: requests, errors, latency) and every run of the flow as an iteration (how
 * many, how many failed, how long they took). The steps' hosts go through the load safeguards before the test starts.
 */
import { isAbsolute, resolve } from 'node:path';
import type { TestCase } from '../model/types.js';
import { ApsError } from '../errors.js';
import { isInside } from '../storage/fsutil.js';
import type { ExecServices } from '../runner/execute.js';
import { loadFlowSteps, runFlowOnce } from '../runner/flow-data-run.js';
import { CookieJar } from '../cookies/cookie-jar.js';

export interface FlowLoadStepResult {
  name: string;
  status: string;
  ms: number;
  httpStatus?: number;
}

/** What the load engine runs for a flow target. */
export interface FlowLoadScenario {
  /** The steps, in file order (the per-step rows). */
  steps: string[];
  /** The URLs the steps send to, resolved as far as the variables allow (for the safeguards). */
  urls: string[];
  /** One run of the flow for virtual user `vu`. */
  iterate(vu: number, signal: AbortSignal): Promise<{ ok: boolean; ms: number; steps: FlowLoadStepResult[] }>;
}

/** The flow file of a load target: inside `testsDir` (relative paths; absolute ones must be inside it too). */
export function flowLoadFile(file: string, testsDir: string): string {
  const abs = isAbsolute(file) ? file : resolve(testsDir, file.replace(/^tests[\\/]/, ''));
  if (!isInside(testsDir, abs)) throw new ApsError('ValidationError', `The load test's flow file must be inside tests/: ${file}`);
  return abs;
}

/** The URL a step sends to, if it is an HTTP-like step. */
function urlOf(t: TestCase): string | undefined {
  const x = t as unknown as { url?: unknown; endpoint?: unknown; request?: { url?: unknown } };
  const u = x.url ?? x.endpoint ?? x.request?.url;
  return typeof u === 'string' && u ? u : undefined;
}

/** A flow file as a load scenario with the services' variables (each iteration starts from a copy of them). */
export async function flowLoadScenario(o: { file: string; services: ExecServices; stepConcurrency?: number }): Promise<FlowLoadScenario> {
  const tests = await loadFlowSteps(o.file);
  // the output: is not needed under load (nobody reads it): never read the file per iteration
  const output = null;
  const names = tests.map((t) => t.name);
  const urls = tests
    .map(urlOf)
    .filter((u): u is string => !!u)
    .map((u) => o.services.vars.resolve(u))
    // a value only a step extracts ({{id}}) is not known yet: the host is what the safeguards look at
    .map((u) => (/^\{\{/.test(u) ? u : u.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '$1')));
  const jars = new Map<number, CookieJar>();
  return {
    steps: names,
    urls,
    iterate: async (vu, signal) => {
      let jar = jars.get(vu);
      if (!jar) jars.set(vu, (jar = new CookieJar()));
      const r = await runFlowOnce({ file: o.file, tests, output, services: o.services, signal, concurrency: o.stepConcurrency ?? 4, cookieJar: jar, name: 'load iteration' });
      return {
        ok: r.status === 'passed',
        ms: r.durationMs,
        steps: r.steps.map((s) => {
          const st = (s.metadata as { status?: unknown } | undefined)?.status;
          return { name: s.name, status: s.status, ms: s.latencyMs ?? s.durationMs, ...(typeof st === 'number' ? { httpStatus: st } : {}) };
        }),
      };
    },
  };
}
