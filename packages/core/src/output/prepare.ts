/**
 * Building an output from a source with the surface's policy applied — the one path of the window's down arrow, `testpion
 * output` and MCP `save_output` — and the deps a workspace alone can give (a CLI or an MCP server has no console or
 * Debugger session; a window adds its own).
 */
import type { OutputSource } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { evalMatrixPage } from '../runner/eval-matrix-runs.js';
import { flowRunTimeline, runTimeline } from '../runner/flow-report.js';
import { readScaleRows, type RowFilter } from '../runner/flow-scale-runs.js';
import { runResults } from '../runner/run-results.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import { checkOutput, isRedacting, redactOutputText, secretNotice } from './policy.js';
import { buildSource } from './sources.js';
import { type Built, type OutputDeps } from './types.js';

const identity = (t: string) => t;

/** The deps a workspace alone gives: a run's results, a data run's rows and an evaluation matrix from disk, a flow timeline. */
export function storeOutputDeps(store: WorkspaceStore, redactor: Redactor): OutputDeps {
  return {
    store,
    redactor,
    results: (runId) => runResults(store, runId),
    scaleRows: (p) => readScaleRows(store, String(p.id ?? ''), { offset: Number(p.offset) || 0, limit: Number(p.limit) || 500, status: p.status as RowFilter | undefined }) as never,
    evalMatrix: (p) => evalMatrixPage(store, p as never) as never,
    flowTimeline: ({ file, runId }) => {
      if (file) return flowRunTimeline(store, file, runId);
      if (!runId) throw new ApsError('ValidationError', 'A flow timeline needs a file or a run');
      return runTimeline(store, runId);
    },
  };
}

interface SourceCall {
  surface: string;
  format: string;
  source: OutputSource;
  includeSecrets?: boolean;
}

/** What a call writes: the source built in the format, with the surface's secrets policy applied, and the notice a raw output earns. */
export async function prepareSource(
  deps: OutputDeps,
  p: SourceCall,
  signal: AbortSignal,
  who = 'output.save',
): Promise<{ built: Built; redacting: boolean; notice?: string; info: ReturnType<typeof checkOutput>['info']; format: ReturnType<typeof checkOutput>['format'] }> {
  const { info, format } = checkOutput(p, who);
  const redacting = isRedacting(info, p.includeSecrets);
  const redact = redacting ? (t: string) => redactOutputText(t, format, deps.redactor) : identity;
  // a source masked at capture (a run's reports, the Debugger's HAR) holds nothing left to mask: the builders skip the
  // second pass (sources.ts)
  const built = await buildSource(deps, p.source, format, redact, redacting, signal, redacting && !!info.capturedRedacted);
  const notice = info.redaction === 'raw-notice' && built.sample ? secretNotice(await built.sample(), deps.redactor) : undefined;
  return { built, redacting, notice, info, format };
}

/** All the bytes of a build, refusing past `limit` (an MCP result, a copy). */
export async function collectBuilt(built: Built, limit: number): Promise<{ bytes: Buffer; truncated: boolean; total: number }> {
  const parts: Buffer[] = [];
  let size = 0;
  let total = 0;
  for await (const c of built.chunks) {
    const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
    total += buf.length;
    if (size < limit) {
      const take = buf.subarray(0, limit - size);
      parts.push(take);
      size += take.length;
    }
  }
  return { bytes: Buffer.concat(parts), truncated: total > size, total };
}
