/**
 * "Generate checks from this response" (B-12): the verified-assertions task (`generate-assertions`) fed with the response a
 * run stored for a result, so the Tests / run results can offer checks for a step without sending the request again.
 *
 * The result says where it is defined: a saved request (the checks join its assertions) or a step of a test file (the
 * checks join the step's, through the flow editor, comments kept). The response is the one the run stored (its trace, up
 * to 16 KB, else the result's summary up to 4 KB; a body cut short is never used to prove a check). Checks the step
 * already has are not proposed again, and with "Prefer stable checks" on a check that pins a value the server makes up
 * (an id, a time, a token) is offered in its stable form.
 */
import { checkLabel, type ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { CheckConfig } from '../model/types.js';
import { runResults } from '../runner/run-results.js';
import { finishedRun } from '../runner/result-source.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { stringifyYaml } from '../util/lazy-yaml.js';
import { contextOfItem } from './item-context.js';
import { evidenceOf, stepOfResult, type FailureSource } from './run-evidence.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { pinsGeneratedValue, saferChecks } from './verify.js';

/** What `prepare` keeps on this computer for a result's checks. */
interface ResultChecksLocal {
  kind: 'result';
  runId: string;
  resultId: string;
  source?: FailureSource;
  /** The step of a test file. */
  step?: string;
  /** The checks the request or step already has. */
  existing: CheckConfig[];
}

const sameCheck = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The context of an item for the verified-assertions task: a run's result reads the response the run stored; anything else is the generic item context. */
export async function prepareChecksItem(store: WorkspaceStore, ref: ItemRef): Promise<PreparedItem> {
  if (ref.kind !== 'run' || !ref.resultId) {
    const c = await contextOfItem(store, ref);
    return { label: c.label, context: c.context, response: c.response, previous: c.previous, collection: c.collection };
  }
  const run = ref.runId === 'last' ? finishedRun(store, 'last') : finishedRun(store, ref.runId);
  let result;
  for await (const r of runResults(store, run.runId))
    if (r.id === ref.resultId) {
      result = r;
      break;
    }
  if (!result) throw new ApsError('ConfigurationError', `No result "${ref.resultId}" in run ${run.runId}`, { suggestions: ['The app\'s Runs list shows the results of a run; run:<runId>:<resultId> names one.'] });
  const cache: Record<string, FailureSource | null> = {};
  const ev = evidenceOf(store, run.runId, result, run.origin, cache);
  const source = ev.source ? cache[ev.source] ?? undefined : undefined;
  let existing: CheckConfig[] = [];
  if (source?.kind === 'request') existing = source.assertions;
  else if (source?.kind === 'test' && ev.step) {
    // the step's own checks (evidenceOf found the failing ones; the whole list is needed here)
    const s = stepOfResult(source.text, source.path, result);
    existing = (Array.isArray(s?.step.assertions) ? s!.step.assertions : Array.isArray(s?.step.checks) ? s!.step.checks : []) as CheckConfig[];
  }
  if (result.type !== 'http' && result.type !== 'graphql')
    throw new ApsError('ValidationError', `Checks are generated for HTTP and GraphQL results; "${result.name}" is a ${result.type} step`, { suggestions: ['Pick a result of a request or an HTTP step.'] });
  if (!ev.response) throw new ApsError('ConfigurationError', `Run ${run.runId} stored no response for "${result.name}"`, { suggestions: ['Run it again with tracing on, or send the request and use Suggest checks there.'] });
  const r = ev.response;
  const local: ResultChecksLocal = { kind: 'result', runId: run.runId, resultId: result.id, source, step: ev.step, existing };
  return {
    label: result.name,
    local,
    response: ev.complete ? r : undefined,
    context: {
      request: ev.request ?? {},
      test: { name: result.name, type: result.type, ...(result.file ? { file: result.file } : {}) },
      status: r.status,
      headers: r.headers?.slice(0, 30),
      // a body that was cut short is said so and not offered as the whole response
      ...(r.body !== undefined ? { body: r.body } : { bodyNote: 'The stored body was cut short; propose checks for the status and the headers only.' }),
      ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
      ...(existing.length ? { existingChecks: existing.map((c) => checkLabel(c)) } : {}),
    },
  };
}

/**
 * The proposal items of a checks answer: for a request, checks joining its assertions; for a result of a test file, the
 * checks of its step. Checks already there are left out (said in the notes); "Prefer stable checks" swaps a pinned
 * generated value for its stable form.
 */
export function proposeChecksItems(checks: CheckConfig[], input: AiTaskInput, requestRef: ItemRef | undefined): { items: DraftItem[]; notes: string[] } {
  const local = input.local as ResultChecksLocal | undefined;
  const notes: string[] = [];
  let list = checks;
  if (local?.existing.length) {
    const fresh = list.filter((c) => !local.existing.some((e) => sameCheck(e, c)));
    if (fresh.length < list.length) notes.push(`Left out ${list.length - fresh.length} check${list.length - fresh.length === 1 ? '' : 's'} the step already has.`);
    list = fresh;
  }
  if (input.preferStable) {
    let swapped = 0;
    list = list.map((c) => {
      if (!pinsGeneratedValue(c)) return c;
      const safer = saferChecks(c)[0];
      if (!safer) return c;
      swapped++;
      return safer;
    });
    if (swapped) notes.push(`Prefer stable checks: ${swapped} check${swapped === 1 ? '' : 's'} that pinned a value the server makes up ${swapped === 1 ? 'is' : 'are'} offered as ${swapped === 1 ? 'its' : 'their'} stable form.`);
  }
  let target: ItemRef | undefined = requestRef;
  let where: Pick<DraftItem, 'path' | 'step'> = {};
  if (local?.source?.kind === 'request') target = { kind: 'request', collectionId: local.source.collectionId, requestId: local.source.requestId };
  else if (local?.source?.kind === 'test') {
    if (!local.step) return { items: [], notes: [`The step of "${local.source.path}" this result belongs to could not be found, so no checks are offered for it.`] };
    target = { kind: 'test', path: local.source.path };
    where = { path: local.source.path, step: local.step };
  }
  return {
    notes,
    items: list.map((c) => ({ kind: 'assertion' as const, title: checkLabel(c), after: stringifyYaml([c]).trim(), language: 'yaml' as const, data: c, ...(target ? { target } : {}), ...where })),
  };
}
