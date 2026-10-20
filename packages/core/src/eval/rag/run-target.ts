/**
 * Calling a RAG target for one question (planning/rag-testing.md §4a): the question is put into the target's request,
 * the request runs through the protocol client the app already has (HTTP, SSE, WebSocket, gRPC, MCP), and the response
 * is read into a sample by the target's mapping. The runner injects the pieces that live in runner/ (the step
 * normaliser and runner), so this module stays free of it.
 */
import type { RagSample, RagTarget } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import type { TestCase } from '../../model/types.js';
import type { VariableScope } from '../../vars/variables.js';
import type { CheckContext } from '../checks.js';
import { applyMapping, mappingProblems, responseOf, type RagResponse } from './mapping.js';

/** What the runner lends: turn a step written as in a test file into a test, run it, and say what it would change. */
export interface TargetRunner {
  normalize(raw: Record<string, unknown>): TestCase;
  /** Runs the step; resolves to the check context of its response. */
  run(step: TestCase, scope: VariableScope): Promise<CheckContext>;
  /** A production environment's gate for a step that is not read-only. */
  guard?(step: TestCase, scope: VariableScope): void;
}

const STEP_TYPES: Record<RagTarget['protocol'], string[]> = { http: ['http'], sse: ['http'], websocket: ['websocket'], grpc: ['grpc'], mcp: ['mcp'] };

/** Problems with a target that make a call impossible (shown by the Connect dialog, `testpion rag targets` and a run's start). */
export function targetProblems(t: RagTarget | undefined): string[] {
  if (!t || typeof t !== 'object') return ['The RAG target is empty.'];
  const out: string[] = [];
  if (!t.step || typeof t.step !== 'object' || Array.isArray(t.step)) out.push('The target has no request (step).');
  else {
    const type = String(t.step.type ?? (t.step.url || t.step.request ? 'http' : t.step.tool ? 'mcp' : ''));
    const allowed = STEP_TYPES[t.protocol];
    if (!allowed) out.push(`Unknown protocol "${String(t.protocol)}". Use http, sse, websocket, grpc or mcp.`);
    else if (!allowed.includes(type)) out.push(`A ${t.protocol} target's request is of type ${allowed.join(' or ')}, not "${type || 'unset'}".`);
  }
  out.push(...mappingProblems(t.mapping));
  return out;
}

/** The variables a request can use for the question: the text, as a JSON string literal and escaped for the inside of one. */
export function questionVars(question: string): Record<string, string> {
  const lit = JSON.stringify(question);
  return { question, questionJson: lit, questionEscaped: lit.slice(1, -1) };
}

export interface TargetCall {
  sample: RagSample;
  response: RagResponse;
  /** The check context of the request itself (status, headers, timing). */
  ctx: CheckContext;
  latencyMs: number;
}

/** Call the target with a question; throws a clear error when the endpoint refuses or the mapping finds no answer. */
export async function callTarget(target: RagTarget, question: string, scope: VariableScope, run: TargetRunner, extraVars: Record<string, unknown> = {}, o: { probe?: boolean } = {}): Promise<TargetCall> {
  // a probe is how the mapping is made: it needs the request to be right, not the mapping
  const problems = o.probe ? targetProblems({ ...target, mapping: { answer: '$text' } }) : targetProblems(target);
  if (problems.length) throw new ApsError('ConfigurationError', `The RAG target cannot be called: ${problems[0]}`, { suggestions: problems.slice(1).concat(['Open the target in AI Lab ▸ RAG and fix it, or `testpion rag targets` lists the problems.']) });
  const s = scope.clone();
  s.setScope('request', { ...extraVars, ...questionVars(question) });
  // placeholders are replaced in the object, before the step is read: a `json:` body keeps the question a string however it is quoted
  const raw = s.resolveDeep(target.step);
  const step = run.normalize({ name: 'RAG target', ...raw });
  if (!target.readOnly) run.guard?.(step, s);
  const t0 = performance.now();
  const ctx = await run.run(step, s);
  const latencyMs = Math.round(performance.now() - t0);
  if (ctx.isError && !o.probe) throw new ApsError('ProtocolError', `The RAG tool reported an error: ${ctx.text.slice(0, 300)}`);
  if (!o.probe && step.type === 'http' && ctx.status !== undefined && ctx.status >= 400) throw new ApsError('ProtocolError', `The RAG endpoint answered HTTP ${ctx.status}: ${ctx.text.slice(0, 300) || '(no body)'}`, { suggestions: ['Probe the target in AI Lab ▸ RAG to see the request and the response.', 'Check the URL, the authentication and the request body.'] });
  if (!o.probe && ctx.grpc && ctx.grpc.code !== 0) throw new ApsError('ProtocolError', `The RAG gRPC call ended with ${ctx.grpc.codeName}: ${ctx.grpc.details}`);
  const response = responseOf({ body: ctx.body, text: ctx.text, headers: ctx.headers });
  const mapped = mappingProblems(target.mapping);
  const sample = o.probe && mapped.length ? { answer: '', contexts: [], warnings: mapped } : applyMapping(response, target.mapping);
  if (!o.probe && sample.warnings.some((w) => w.startsWith('The answer path')))
    throw new ApsError('ConfigurationError', `The mapping found no answer in the response: ${sample.warnings[0]}`, { suggestions: ['Probe the target and click the answer in the sample response to map it again.'], details: { response: ctx.text.slice(0, 500) } });
  return { sample, response, ctx, latencyMs: sample.latencyMs ?? ctx.latencyMs ?? latencyMs };
}
