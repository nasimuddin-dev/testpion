/**
 * RPC handlers: fuzzing an API from an API definition (specs/…): the requests that break one rule of the schema at a
 * time, sent to the API, with progress for the window and a way to stop. Requests resolve {{variables}} (tokens,
 * {{baseUrl}}) in the chosen environment; production environments are refused, remote hosts need the person's opt-in.
 */
import { readFileSync } from 'node:fs';
import { ApsError, fuzzCases, runFuzz, writeFuzzFindingTests, type FuzzReport } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

const SPEC_PATH = /^specs\/[^/\\]+\.(ya?ml|json)$/i;
let running: AbortController | undefined;

export function fuzzHandlers(be: Backend): Handlers {
  return {
    'openapi.fuzz': async (p: {
      path: string;
      environment?: string;
      baseUrl?: string;
      includeDelete?: boolean;
      allowRemote?: boolean;
      operations?: string[];
      maxPerOperation?: number;
    }): Promise<FuzzReport> => {
      if (!SPEC_PATH.test(p.path ?? '')) throw new ApsError('ValidationError', `Not an API definition in specs/: ${p.path ?? ''}`);
      if (p.environment && be.ws.getEnvironment(p.environment)?.isProduction)
        throw new ApsError('ConfigurationError', 'Fuzzing is not run against a production environment', { why: 'It sends invalid and data-changing requests.' });
      const text = readFileSync(be.ws.safePath(p.path), 'utf8');
      running?.abort();
      const ctrl = new AbortController();
      running = ctrl;
      const ctx = be.context({ environment: p.environment });
      try {
        const envBase = ctx.vars.resolve('{{baseUrl}}');
        const baseUrl = p.baseUrl?.trim() ? ctx.vars.resolve(p.baseUrl.trim()) : envBase.includes('{{') ? undefined : envBase;
        const { cases } = fuzzCases(text, { baseUrl, includeDelete: p.includeDelete, operations: p.operations?.length ? p.operations : undefined, maxPerOperation: p.maxPerOperation });
        if (!cases.length) throw new ApsError('ValidationError', 'No operations to fuzz (DELETE is left out unless you include it)');
        be.host.emit('fuzz.progress', { done: 0, total: cases.length });
        const report = await runFuzz(text, cases, {
          resolve: (r) => ctx.vars.resolveDeep(r),
          allowRemote: p.allowRemote,
          signal: ctrl.signal,
          onResult: (_r, done) => be.host.emit('fuzz.progress', { done, total: cases.length }),
        });
        // what the window shows and keeps: response bodies redacted like everything else
        return { ...report, baseUrl, results: report.results.map((r) => ({ ...r, bodyPreview: r.bodyPreview ? ctx.redactor.redactString(r.bodyPreview) : undefined })) } as FuzzReport;
      } finally {
        if (running === ctrl) running = undefined;
        await ctx.dispose();
      }
    },
    /** A run's server errors and accepted invalid inputs as regression tests (tests/<api>/fuzz-findings.yaml). */
    'openapi.fuzzSaveTests': ({ path, report, baseUrl }: { path: string; report: FuzzReport; baseUrl?: string }) => {
      if (!SPEC_PATH.test(path ?? '')) throw new ApsError('ValidationError', `Not an API definition in specs/: ${path ?? ''}`);
      const out = writeFuzzFindingTests(be.ws, path, report, { baseUrl });
      if (!out) throw new ApsError('ValidationError', 'No server errors or accepted invalid inputs to save as tests');
      be.host.emit('workspace.changedOnDisk', { message: `${out.path} written`, kinds: ['tests'], files: [out.path] });
      return out;
    },
    'openapi.fuzzStop': () => {
      running?.abort();
      return true;
    },
  };
}
