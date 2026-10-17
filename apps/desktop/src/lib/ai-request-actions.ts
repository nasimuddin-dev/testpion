/**
 * The request editor's generating AI actions (AI-3), built the one way: Suggest assertions, Generate tests and
 * Generate request go through the core task runner and open the proposal review at once, each item verified before it
 * is offered — checks against the response on screen and the one before it (unstable values flagged with a safer
 * form), tp tests run in the sandbox (never pm.*). Accept puts the chosen items into the editor (its own undo: nothing
 * is saved until the person saves); Run now in the review sends the request again and checks every item once more.
 */
import type { ItemRef } from '@testpion/shared';
import type { AiResponse, AssistantApplied, AssistantRequest } from '../store';
import type { HttpRequestSpec } from '../types';

/** A response as the editor holds it. */
export interface ShownResponse {
  status: number;
  headers: Array<[string, string]>;
  bodyPreview?: string;
  durationMs?: number;
}

/** A response as the AI verifiers take it. */
export const aiResponseOf = (r: ShownResponse): AiResponse => ({ status: r.status, headers: r.headers, body: r.bodyPreview, latencyMs: r.durationMs });

interface About {
  request: { method: string; url: string };
  response: ShownResponse;
  /** The saved request the tab edits: its earlier response in History is the "previous" one. */
  item?: ItemRef;
  /** Send the tab's request again; resolves to the new response (or nothing when it failed). */
  rerun?(): Promise<ShownResponse | undefined>;
}

const context = (a: About) => ({ request: a.request, status: a.response.status, headers: a.response.headers.slice(0, 20), body: a.response.bodyPreview, ...(a.response.durationMs !== undefined ? { latencyMs: a.response.durationMs } : {}) });
const rerunOf = (a: About) => (a.rerun ? async () => await a.rerun!().then((r) => (r ? aiResponseOf(r) : undefined)) : undefined);

/** Suggest assertions: checks as JSON, each verified; Accept adds the chosen ones to the tab's Tests. */
export function suggestChecksAi(a: About, add: (code: string) => AssistantApplied | Promise<AssistantApplied>): AssistantRequest {
  return {
    task: 'generate-assertions',
    title: 'Suggested assertions',
    // the body is sent whole: the context builder fits it to the budget (sampled, never cut mid-JSON)
    context: context(a),
    response: aiResponseOf(a.response),
    ...(a.item ? { item: a.item } : {}),
    autoReview: true,
    rerun: rerunOf(a),
    apply: { label: 'Add to the checks', run: add },
  };
}

/** Generate tests: one tp.test per item, each run in the sandbox; Accept appends the chosen ones to the Post-response script. */
export function generateTestsAi(a: About, append: (code: string) => AssistantApplied | Promise<AssistantApplied>): AssistantRequest {
  return {
    task: 'generate-pm-tests',
    title: 'Tests for this response',
    context: { request: a.request, response: { status: a.response.status, headers: a.response.headers.slice(0, 20), body: a.response.bodyPreview, timeMs: a.response.durationMs } },
    response: aiResponseOf(a.response),
    ...(a.item ? { item: a.item } : {}),
    autoReview: true,
    rerun: rerunOf(a),
    apply: { label: 'Add to the Post-response script', run: append },
  };
}

/** Generate a request from words: Accept opens it as a new, unsaved tab (nothing is sent until Send). */
export function generateRequestAi(description: string, open: (r: { name?: string; request: HttpRequestSpec }) => AssistantApplied): AssistantRequest {
  return {
    task: 'generate-request',
    title: 'Write a request',
    question: description,
    context: {},
    autoReview: true,
    apply: {
      label: 'Open as a new request',
      run: (code) => {
        let r: { name?: string; request?: HttpRequestSpec };
        try {
          r = JSON.parse(code) as typeof r;
        } catch {
          return 'it is not a request';
        }
        return r.request?.url ? open({ name: r.name, request: r.request }) : 'it has no URL';
      },
    },
  };
}
