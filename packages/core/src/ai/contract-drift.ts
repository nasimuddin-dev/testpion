/**
 * AI-9 · Contract drift explained: an OpenAPI document compared with real traffic (History, a HAR file, a recorded run),
 * the drift found deterministically (openapi/drift.ts), the model explaining what each drift means and choosing the fix,
 * and the fix proposed as a reviewed change that is verified against the same traffic.
 *
 * The model decides nothing about the facts: it gets the findings (kind, operation, place, what the schema says, what
 * was seen, how often) and the schemas involved, and answers per finding: who is right (the document is outdated, the
 * API has a bug, a test is stale, it is intended), the impact, and an action — patch the spec, fix the API, pin the
 * contract in a test, or ignore it. A spec patch is NOT written by the model: TestPion makes it from what was observed
 * (spec-patch.ts: add the property with the observed type, set the type, allow null, drop the required entry …) and
 * proves it by re-checking the same traffic against the patched document — the drift must be gone and no other drift may
 * appear — and by linting the patched document. Without a model the additive findings (a new field, a new status, a new
 * enum value) are offered as patches and the rest is listed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ItemRef } from '@testpion/shared';
import { exchangesFromHar } from '../debugger/har.js';
import { ApsError } from '../errors.js';
import { analyseDrift, DRIFT_TITLES, driftFindingsForModel, type DriftExchange, type DriftFinding, type DriftReport } from '../openapi/drift.js';
import { lintOpenApi } from '../openapi/lint.js';
import { loadOpenApi, validateAgainstOpenApi, type OpenApiDoc } from '../openapi/contract.js';
import { applyPatchOps, isJsonSpec, planPatch, type PatchOp } from '../openapi/spec-patch.js';
import { runResults } from '../runner/run-results.js';
import { finishedRun } from '../runner/result-source.js';
import type { AiSurface } from '../storage/ai-usage.js';
import { historyResponse } from '../storage/history-compare.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { newProposalId, PROPOSAL_TTL_MS, saveProposal, type Proposal, type ProposalFinding, type ProposalItem } from './proposal.js';
import { requestOfResult, responseOfResult } from './run-evidence.js';
import { loadSpec } from './spec-tests.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { registerVerifier, verifyItems } from './verify.js';

/* ------------------------------------------------------------------ the traffic */

/** Where the traffic comes from. */
export type DriftSource =
  | { kind: 'history'; limit?: number; host?: string; requestId?: string }
  | { kind: 'har'; path?: string; text?: string }
  | { kind: 'run'; runId: string };

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;

const parseBody = (text: string | undefined, contentType: string | undefined): unknown => {
  if (text === undefined || text === '') return undefined;
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(text))
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  return text;
};

/** The traffic of a source as exchanges (see DriftSource). History entries that are not HTTP responses are left out. */
export async function gatherExchanges(store: WorkspaceStore, source: DriftSource): Promise<DriftExchange[]> {
  if (source.kind === 'history') {
    const limit = Math.min(Math.max(Math.round(source.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const page = store.meta.listHistory({ requests: true, kind: 'http', limit, ...(source.requestId ? { requestId: source.requestId } : {}) });
    const out: DriftExchange[] = [];
    for (const h of page.items) {
      const status = typeof h.status === 'number' ? h.status : Number(h.status);
      if (!h.url || !h.method || !Number.isFinite(status) || status <= 0) continue;
      if (source.host) {
        let host = '';
        try {
          host = new URL(h.url).host;
        } catch {
          /* a URL with a variable in it: no host to match */
        }
        if (host !== source.host && !h.url.includes(source.host)) continue;
      }
      const r = historyResponse(store, h);
      const contentType = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      out.push({
        id: h.id,
        method: h.method,
        url: h.url,
        status,
        ...(contentType ? { contentType } : {}),
        ...(r.body !== undefined ? { body: parseBody(r.body, contentType) } : {}),
        at: h.timestamp,
        ...(h.collectionId && h.requestId ? { request: { collectionId: h.collectionId, requestId: h.requestId } } : {}),
        ref: { kind: 'history', historyId: h.id },
      });
    }
    return out;
  }
  if (source.kind === 'har') {
    let text = source.text;
    if (text === undefined && source.path) {
      const file = isAbsolute(source.path) ? source.path : store.safePath(source.path);
      if (!existsSync(file)) throw new ApsError('ConfigurationError', `${source.path} does not exist`, { suggestions: ['Save a Debugger session as HAR (Debugger ▸ Save session) or export History as HAR, then pass its path.'] });
      if (statSync(file).size > 64 * 1024 * 1024) throw new ApsError('ValidationError', `${source.path} is larger than 64 MB`, { suggestions: ['Capture less, or filter the session to one host before saving it.'] });
      text = readFileSync(file, 'utf8');
    }
    if (!text) throw new ApsError('ValidationError', 'A HAR source needs a file (path) or its text');
    let har: unknown;
    try {
      har = JSON.parse(text);
    } catch {
      throw new ApsError('ValidationError', 'That is not a HAR file (not valid JSON)');
    }
    return exchangesFromHar(har)
      .filter((x) => x.kind === 'http' && x.status)
      .slice(0, MAX_LIMIT)
      .map((x, i) => ({
        id: `har-${i + 1}`,
        method: x.method,
        url: x.url,
        status: x.status!,
        ...(x.contentType ? { contentType: x.contentType } : {}),
        ...(x.responseBody !== undefined ? { body: parseBody(x.responseBody, x.contentType) } : {}),
        at: x.startedAt,
      }));
  }
  const run = finishedRun(store, source.runId);
  const out: DriftExchange[] = [];
  for await (const r of runResults(store, run.runId)) {
    if (r.type !== 'http' || out.length >= MAX_LIMIT) continue;
    const req = requestOfResult(r);
    const { response, complete } = responseOfResult(store, r);
    if (!req?.method || !req.url || !response?.status) continue;
    const contentType = response.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    out.push({
      id: r.id,
      method: req.method,
      url: req.url,
      status: response.status,
      ...(contentType ? { contentType } : {}),
      // a body cut short is not compared (a half document would look like missing fields)
      ...(complete && response.body !== undefined ? { body: parseBody(response.body, contentType) } : {}),
      ref: { kind: 'run', runId: run.runId, resultId: r.id },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ the analysis of a spec against traffic */

export interface DriftLocal {
  spec: string;
  text: string;
  source: DriftSource;
  report: DriftReport;
  /** The findings by id (with their raw samples). */
  findings: Record<string, DriftFinding>;
  /** The parsed document and the traffic, kept on this computer for the proposal and its verification (never sent). */
  doc: OpenApiDoc;
  exchanges: DriftExchange[];
}

/** The drift of a spec file of the workspace against a source of traffic: deterministic, nothing is sent. */
export async function driftOfSpec(store: WorkspaceStore, spec: string, source: DriftSource): Promise<{ local: DriftLocal; doc: OpenApiDoc; exchanges: DriftExchange[] }> {
  const { text, doc } = loadSpec(store, spec);
  const exchanges = await gatherExchanges(store, source);
  if (!exchanges.length)
    throw new ApsError('ConfigurationError', `No traffic to compare with ${spec}`, {
      suggestions: [
        source.kind === 'history' ? 'Send requests first (History keeps them), or widen --limit / drop --host.' : source.kind === 'run' ? 'Pick a run of HTTP tests that stored their responses.' : 'The HAR file has no HTTP responses.',
      ],
    });
  const report = analyseDrift(doc, exchanges);
  return { local: { spec, text, source, report, findings: Object.fromEntries(report.findings.map((f) => [f.id, f])), doc, exchanges }, doc, exchanges };
}

/** What the drift report says in one place for a host (the CLI, MCP, the dialog): the facts, no model. */
export async function contractDrift(store: WorkspaceStore, spec: string, source: DriftSource): Promise<DriftReport & { spec: string; source: DriftSource; patchable: number }> {
  const { local, doc } = await driftOfSpec(store, spec, source);
  const patchable = local.report.findings.filter((f) => !('skip' in planPatch(doc, f, f.sample))).length;
  return { ...local.report, spec, source, patchable };
}

/* ------------------------------------------------------------------ the task */

export const DRIFT_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['findings'],
  properties: {
    summary: { type: 'string', description: 'What the traffic shows about this API definition, one or two sentences' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict', 'action'],
        properties: {
          id: { type: 'string', description: 'The id of a finding in context.findings (never invented)' },
          verdict: { type: 'string', enum: ['spec-outdated', 'api-bug', 'test-stale', 'intended', 'unknown'], description: 'Who is wrong: the document, the API, a test; or it is intended' },
          impact: { type: 'string', description: 'What breaks or misleads for the clients of the API, one sentence' },
          explanation: { type: 'string', description: 'Why you think so, from the evidence (the counts, the other responses, the document)' },
          confidence: { type: 'number', description: '0 to 1' },
          action: { type: 'string', enum: ['patch-spec', 'fix-api', 'pin-test', 'ignore'], description: 'patch-spec: the document should say what the API does; fix-api: the API is wrong; pin-test: add a contract check to the saved requests; ignore' },
        },
      },
    },
  },
};

interface Decision {
  finding: DriftFinding;
  action: 'patch-spec' | 'fix-api' | 'pin-test' | 'ignore';
  verdict: string;
  impact?: string;
  explanation?: string;
  confidence?: number;
  selected: boolean;
}

/** The kinds a client cannot be hurt by (more is documented than before): offered as ticked patches without a model. */
const ADDITIVE = new Set(['undocumented-field', 'undocumented-status', 'enum-value']);

const slim = (v: unknown): unknown => {
  const t = JSON.stringify(v);
  return t && t.length > 1800 ? `${t.slice(0, 1800)} …` : v;
};

/** The schemas involved (the documented response of each operation with drift), short, for the model. */
function schemasFor(doc: OpenApiDoc, report: DriftReport): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const f of report.findings) {
    const key = `${f.operation}|${f.status}`;
    if (seen.has(key) || out.length >= 8 || !f.status) continue;
    seen.add(key);
    const m = /^([A-Z]+) (.+)$/.exec(f.operation);
    const resp = m ? ((doc.paths ?? {})[m[2]!]?.[m[1]!.toLowerCase()] as { responses?: Record<string, unknown> } | undefined)?.responses?.[f.status] : undefined;
    if (resp) out.push({ operation: f.operation, status: f.status, response: slim(resp) });
  }
  return out;
}

/** The task's own context for a spec file (registry `prepare`): the drift found, never the traffic itself. */
export async function prepareDriftContext(store: WorkspaceStore, ref: ItemRef, o: { context?: Record<string, unknown> } = {}): Promise<PreparedItem> {
  if (ref.kind !== 'spec') throw new ApsError('ValidationError', `Contract drift compares an API definition with traffic, not a ${ref.kind}`, { suggestions: ['Pass spec:<path> (specs/clinic.yaml).'] });
  const source = sourceOf(o.context?.options as Record<string, unknown> | undefined);
  const { local, doc } = await driftOfSpec(store, ref.path, source);
  if (!local.report.findings.length) throw new ApsError('ValidationError', `${ref.path} and the traffic agree: there is no drift to explain`, { suggestions: ['The deterministic report (testpion openapi-drift) lists what was compared.'] });
  return {
    label: ref.path,
    local,
    context: {
      spec: { path: ref.path, title: String((doc.info as { title?: string } | undefined)?.title ?? ''), version: String(doc.openapi ?? doc.swagger ?? '') },
      traffic: { source: source.kind, exchanges: local.report.exchanges, matched: local.report.matched },
      kinds: DRIFT_TITLES,
      findings: driftFindingsForModel(local.report, { examples: true, max: 60 }),
      schemas: schemasFor(doc, local.report),
      ...(local.report.findings.length > 60 ? { omitted: local.report.findings.length - 60 } : {}),
    },
  };
}

/** A source from the options a caller passes (`context.options.source`). */
export function sourceOf(options: Record<string, unknown> | undefined): DriftSource {
  const s = (options?.source ?? options ?? {}) as Record<string, unknown>;
  const kind = String(s.kind ?? (s.runId ? 'run' : s.har || s.path || s.text ? 'har' : 'history'));
  if (kind === 'run') {
    if (!s.runId) throw new ApsError('ValidationError', 'A run source needs runId');
    return { kind: 'run', runId: String(s.runId) };
  }
  if (kind === 'har') return { kind: 'har', ...(typeof (s.har ?? s.path) === 'string' ? { path: String(s.har ?? s.path) } : {}), ...(typeof s.text === 'string' ? { text: s.text } : {}) };
  return {
    kind: 'history',
    ...(typeof s.limit === 'number' ? { limit: s.limit } : {}),
    ...(typeof s.host === 'string' && s.host.trim() ? { host: s.host.trim() } : {}),
    ...(typeof s.requestId === 'string' && s.requestId.trim() ? { requestId: s.requestId.trim() } : {}),
  };
}

const exampleRef = (f: DriftFinding, ex: DriftExchange[]): ItemRef | undefined => ex.find((e) => e.id === f.exchanges[0])?.ref;

/** The items and findings of the decisions (shared by the model's plan and the deterministic draft). */
function itemsOf(local: DriftLocal, doc: OpenApiDoc, exchanges: DriftExchange[], decisions: Decision[]): { items: DraftItem[]; findings: ProposalFinding[]; notes: string[] } {
  const items: DraftItem[] = [];
  const notes: string[] = [];
  const findings: ProposalFinding[] = [];
  const json = isJsonSpec(local.spec);
  for (const d of decisions) {
    const f = d.finding;
    const pf: ProposalFinding = {
      id: f.id,
      title: `${DRIFT_TITLES[f.kind]}: ${f.operation}${f.status ? ` ${f.status}` : ''}${f.pointer ? ` ${f.pointer}` : ''}`,
      kind: d.verdict,
      ...(typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1 ? { confidence: d.confidence } : {}),
      explanation: [d.impact, d.explanation].filter(Boolean).join('\n') || undefined,
      evidence: [
        { text: `Seen ${f.observed.join(', ')} in ${f.count} of ${f.of} ${f.of === 1 ? 'response' : 'responses'}${f.expected ? `; the document says ${f.expected}` : ''}.`, ...(exampleRef(f, exchanges) ? { ref: exampleRef(f, exchanges) } : {}) },
      ],
      count: f.count,
    };
    findings.push(pf);
    if (d.action === 'patch-spec') {
      const plan = planPatch(doc, f, f.sample);
      if ('skip' in plan) {
        notes.push(`${f.operation}${f.pointer ? ` ${f.pointer}` : ''}: no patch — ${plan.skip}.`);
        continue;
      }
      let after: string;
      try {
        after = applyPatchOps(local.text, json, plan.ops);
      } catch (e) {
        notes.push(`${f.operation}${f.pointer ? ` ${f.pointer}` : ''}: the patch could not be made — ${(e as Error).message}`);
        continue;
      }
      items.push({
        kind: 'spec',
        finding: f.id,
        title: `${local.spec}: ${plan.summary}`,
        path: local.spec,
        before: local.text,
        after,
        language: 'yaml',
        selected: d.selected,
        data: { spec: { path: local.spec, ops: plan.ops, finding: f.id, source: local.source } },
      } as DraftItem & { selected: boolean });
    } else if (d.action === 'pin-test') {
      const req = f.requests[0];
      if (!req) {
        notes.push(`${f.operation}: no saved request to add the contract check to (this traffic did not come from a saved request).`);
        continue;
      }
      items.push({
        kind: 'assertion',
        finding: f.id,
        title: `${f.operation}: check the response against ${local.spec}`,
        target: { kind: 'request', collectionId: req.collectionId, requestId: req.requestId },
        after: `- type: openapi\n  spec: ${local.spec}\n`,
        language: 'yaml',
        data: { type: 'openapi', spec: local.spec, drift: { finding: f.id, exchange: f.exchanges[0], source: local.source } },
      });
    }
  }
  return { items, findings, notes };
}

function decisionsOf(value: unknown, local: DriftLocal): Decision[] {
  const list = Array.isArray((value as { findings?: unknown })?.findings) ? ((value as { findings: Array<Record<string, unknown>> }).findings) : [];
  const out: Decision[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const f = local.findings[String(x?.id)];
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    const action = (['patch-spec', 'fix-api', 'pin-test', 'ignore'] as const).find((a) => a === x.action) ?? 'ignore';
    out.push({
      finding: f,
      action,
      verdict: ['spec-outdated', 'api-bug', 'test-stale', 'intended', 'unknown'].includes(String(x.verdict)) ? String(x.verdict) : 'unknown',
      ...(typeof x.impact === 'string' ? { impact: x.impact.slice(0, 400) } : {}),
      ...(typeof x.explanation === 'string' ? { explanation: x.explanation.slice(0, 1200) } : {}),
      ...(typeof x.confidence === 'number' ? { confidence: x.confidence } : {}),
      // the model chose to patch the document: ticked, unless it is a breaking change it is not sure of
      selected: !(x.confidence !== undefined && Number(x.confidence) < 0.5),
    });
  }
  return out;
}

/** The proposal items of the model's decisions (registry `propose`). */
export function proposeDrift(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[] } {
  const local = input.local as DriftLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'Contract drift needs the spec and the traffic it is compared with');
  const decisions = decisionsOf(a.value, local);
  const { doc, exchanges } = local;
  const r = itemsOf(local, doc, exchanges, decisions);
  // what the model did not explain stays visible in `describe`
  return { items: r.items, notes: r.notes };
}

/** The summary and findings of the proposal (registry `describe`): the model's, then the drift it did not explain. */
export function describeDrift(value: unknown, _items: ProposalItem[], input: AiTaskInput): { summary?: string; findings: ProposalFinding[]; notes: string[] } {
  const local = input.local as DriftLocal;
  const { doc, exchanges } = local;
  const decisions = decisionsOf(value, local);
  const { findings } = itemsOf(local, doc, exchanges, decisions);
  const covered = new Set(decisions.map((d) => d.finding.id));
  const rest = local.report.findings.filter((f) => !covered.has(f.id));
  const more = itemsOf(local, doc, exchanges, rest.map((finding) => ({ finding, action: 'ignore' as const, verdict: 'unknown', selected: false })))
    .findings.map((f) => ({ ...f, title: `${f.title} (not explained by the model)` }));
  return {
    summary: [typeof (value as { summary?: unknown })?.summary === 'string' ? String((value as { summary: string }).summary).slice(0, 1200) : '', `${local.report.findings.length} kinds of drift in ${local.report.exchanges} responses.`].filter(Boolean).join(' '),
    findings: [...findings, ...more],
    notes: [],
  };
}

/* ------------------------------------------------------------------ verification */

/**
 * A spec patch is proven against the same traffic: the patched document parses, lints no worse than before, the drift it
 * answers is gone and no other drift appears. A contract check added to a request must fail on the response that
 * drifted (it would catch the drift) — a check that passes there proves nothing.
 */
registerVerifier('drift', async (item, ctx) => {
  const d = (item.data as { spec?: { path: string; ops: PatchOp[]; finding: string; source: DriftSource }; type?: string; drift?: { finding: string; exchange?: string; source: DriftSource } } | undefined) ?? {};
  if (item.kind === 'spec' && d.spec && ctx.store) {
    const { path, ops, finding, source } = d.spec;
    const { text, doc } = loadSpec(ctx.store, path);
    let patched: string;
    try {
      patched = applyPatchOps(text, isJsonSpec(path), ops);
    } catch (e) {
      return { verifier: 'drift', status: 'fail', label: 'the patch cannot be applied', detail: (e as Error).message };
    }
    let newDoc: OpenApiDoc;
    try {
      newDoc = loadOpenApi(patched);
    } catch (e) {
      return { verifier: 'drift', status: 'fail', label: 'the patched document does not load', detail: (e as Error).message };
    }
    const before = lintOpenApi(text).counts;
    const after = lintOpenApi(patched).counts;
    const exchanges = await gatherExchanges(ctx.store, source);
    const was = analyseDrift(doc, exchanges);
    const now = analyseDrift(newDoc, exchanges);
    const target = was.findings.find((f) => f.id === finding);
    const stillThere = now.findings.some((f) => f.id === finding);
    const known = new Set(was.findings.map((f) => f.id));
    const introduced = now.findings.filter((f) => !known.has(f.id));
    if (!target) return { verifier: 'drift', status: 'skip', label: 'the drift is not in the traffic any more', detail: 'The traffic changed since the proposal was made.' };
    if (stillThere) return { verifier: 'drift', status: 'fail', label: 'the drift is still there after the patch', detail: `${target.operation}${target.pointer ? ` ${target.pointer}` : ''} still differs from the document.` };
    if (introduced.length) return { verifier: 'drift', status: 'fail', label: `the patch introduces ${introduced.length} other drift`, detail: introduced.slice(0, 4).map((f) => `${DRIFT_TITLES[f.kind]}: ${f.operation} ${f.pointer ?? ''}`).join('\n') };
    if (after.error > before.error) return { verifier: 'drift', status: 'fail', label: 'the patched document lints worse', detail: `${before.error} errors before, ${after.error} after.` };
    return { verifier: 'drift', status: 'pass', label: `drift gone on ${target.count} of ${target.of} responses · ${was.findings.length - now.findings.length} fewer in all · lint no worse` };
  }
  if (item.kind === 'assertion' && d.type === 'openapi' && d.drift && ctx.store) {
    const { text } = loadSpec(ctx.store, String((item.data as { spec: string }).spec));
    const doc = loadOpenApi(text);
    const exchanges = await gatherExchanges(ctx.store, d.drift.source);
    const e = exchanges.find((x) => x.id === d.drift!.exchange);
    if (!e) return { verifier: 'drift', status: 'skip', label: 'the exchange is not in the traffic any more' };
    const r = validateAgainstOpenApi(doc, { method: e.method, url: e.url }, { status: e.status, contentType: e.contentType, body: e.body, text: typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '') });
    return r.passed
      ? { verifier: 'drift', status: 'warn', label: 'the check passes on the response that drifted', detail: 'The contract check would not have caught this drift.' }
      : { verifier: 'drift', status: 'pass', label: 'the check fails on the response that drifted (it catches it)', detail: r.message };
  }
  return undefined;
});

export const DRIFT_VERIFIERS = ['drift'];

/* ------------------------------------------------------------------ without a model */

/** The additive drift as ticked patches and the rest listed, without any model (no AI set up, or asked for). */
export async function draftDriftProposal(store: WorkspaceStore, spec: string, source: DriftSource, o: { surface: AiSurface; reason?: string }): Promise<Proposal> {
  const { local, doc, exchanges } = await driftOfSpec(store, spec, source);
  if (!local.report.findings.length) throw new ApsError('ValidationError', `${spec} and the traffic agree: there is no drift to fix`);
  const decisions: Decision[] = local.report.findings.map((finding) => ({
    finding,
    action: 'skip' in planPatch(doc, finding, finding.sample) ? 'ignore' : 'patch-spec',
    verdict: ADDITIVE.has(finding.kind) ? 'spec-outdated' : 'unknown',
    // a field, a status or an enum value that is only missing from the document is safe to add; a changed type, a null or an absent required field may be an API bug
    selected: ADDITIVE.has(finding.kind),
  }));
  const r = itemsOf(local, doc, exchanges, decisions);
  const items: ProposalItem[] = r.items.map((d, i) => ({ ...d, id: `i${i + 1}`, verification: [], selected: (d as { selected?: boolean }).selected ?? true }));
  await verifyItems(items, DRIFT_VERIFIERS, { store });
  const now = Date.now();
  return saveProposal(store, {
    schemaVersion: 1,
    id: newProposalId(),
    task: 'contract-drift',
    taskVersion: 0,
    title: `Contract drift (no AI): ${spec}`,
    summary: `${local.report.findings.length} kinds of drift in ${local.report.exchanges} responses; ${items.length} patch${items.length === 1 ? '' : 'es'} TestPion can make from what was observed (the ones that only add to the document are ticked).`,
    assumptions: [],
    notes: [o.reason ?? 'No AI model is set up: these are the patches TestPion makes itself.', ...r.notes],
    items,
    findings: r.findings,
    provider: 'TestPion',
    model: 'no AI (deterministic patches)',
    surface: o.surface,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'open',
    usage: { inputTokens: 0, outputTokens: 0 },
    request: { item: { kind: 'spec', path: spec } },
  });
}
