/**
 * AI-2 · Failed-run triage: "Explain and fix failures with AI". The run's failures are grouped without a model
 * (run-evidence.ts), the model sees the groups' representatives with their evidence and answers with causes — one cause
 * may explain many groups (an expired token behind twelve endpoints) — each with its evidence, a confidence and a fix:
 * a check to change, a test file or script to edit, a variable of the environment to set, or none (the API regressed:
 * a bug report with the evidence). Every fix is a proposal item proven by the `fix` verifier (fix-items.ts) before it is
 * offered; nothing is applied here. Without a model the groups are the answer (`deterministicTriage`), with their
 * likely cause said from the evidence (401 → auth, a 5xx that passed before → the API) — AI is an upgrade.
 *
 * Every host calls `triageRun`: the app (`ai.triageRun`), the CLI (`testpion ai triage`, `testpion test … --triage`),
 * the MCP server (`ai_triage_run`) and the generic runner (`testpion ai run triage-run --item run:<id>`).
 */
import { checkLabel, type ItemRef } from '@testpion/shared';
import type { CheckConfig } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { AiPrivacy } from './ai-settings.js';
import type { Proposal, ProposalFinding, ProposalItem } from './proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { bugReport, fixItems, staleCheckUpdate, type FixCheckData, type FixSpec, type FixTarget } from './fix-items.js';
import { runEvidence, runIdOfRef, TRIAGE_CAUSES, type FailureEvidence, type FailureGroup, type RunEvidence, type TriageCause } from './run-evidence.js';

export const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['causes'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what went wrong in this run' },
    causes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['groups', 'kind', 'title', 'explanation', 'confidence', 'fix'],
        properties: {
          groups: { type: 'array', items: { type: 'string' }, description: 'The ids of the groups it explains (g1, g2 …)' },
          kind: { type: 'string', enum: [...TRIAGE_CAUSES] },
          title: { type: 'string', description: 'The cause in a few words' },
          explanation: { type: 'string', description: 'Why, citing the evidence' },
          confidence: { type: 'number', description: '0 to 1' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Facts from the context that show it' },
          fix: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['check', 'edit', 'variable', 'none'] },
              result: { type: 'string', description: "check: the failing result (a sample's result id)" },
              checkIndex: { type: 'number', description: "check: the failing check's checkIndex from failingChecksAsWritten" },
              replacement: { type: 'object', description: 'check: the whole check to use instead ({ type, path, expected … })' },
              find: { type: 'string', description: "edit: text copied exactly from the sample's definition" },
              replace: { type: 'string', description: 'edit: the new text' },
              name: { type: 'string', description: 'variable: its name' },
              value: { type: 'string', description: 'variable: its value (never a secret)' },
              note: { type: 'string', description: 'none: what to do instead' },
            },
          },
        },
      },
    },
  },
};

interface Cause {
  groups?: unknown;
  kind?: unknown;
  title?: unknown;
  explanation?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  fix?: Partial<FixSpec> & { type?: unknown };
}

/** The local part of a prepared triage: the evidence and the privacy level it was sent at. */
interface TriageLocal {
  evidence: RunEvidence;
}

const sourceLabel = (ev: RunEvidence, s: FailureEvidence) => {
  const src = s.source ? ev.sources[s.source] : undefined;
  return src?.kind === 'request' ? `request "${src.name}"` : src?.kind === 'test' ? `tests/${src.path}${s.step ? ` step ${s.step}` : ''}` : s.name;
};

/** A source's definition the model may quote for an edit: the step of a test file, or a request's test script. */
function definitionOf(ev: RunEvidence, s: FailureEvidence): string | undefined {
  const src = s.source ? ev.sources[s.source] : undefined;
  if (src?.kind === 'request') return s.failedChecks.some((c) => c.type === 'script') ? src.testScript : undefined;
  if (src?.kind !== 'test') return undefined;
  // the step's lines (from its `- id:` / `- name:` to the next step), so an edit's `find` is exact text of the file
  const lines = src.text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*(id|name):\\s*["']?${(s.step ?? s.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`).test(l));
  if (start < 0) return src.text.length <= 4000 ? src.text : undefined;
  const indent = /^\s*/.exec(lines[start]!)![0].length;
  let end = start + 1;
  while (end < lines.length && !(lines[end]!.trim().startsWith('-') && /^\s*/.exec(lines[end]!)![0].length === indent) && !(lines[end]!.trim() && /^\s*/.exec(lines[end]!)![0].length < indent)) end++;
  return lines.slice(start, end).join('\n');
}

/** What the model is sent (budgets and redaction come after): the groups, never every failure. */
export function triageContext(ev: RunEvidence, privacy: AiPrivacy): Record<string, unknown> {
  const values = privacy === 'full';
  return {
    run: {
      name: ev.run.name,
      environment: ev.run.environment,
      total: ev.run.total,
      passed: ev.run.passed,
      failed: ev.run.failed,
      errors: ev.run.errors,
      kind: ev.run.origin?.kind ?? 'tests',
      failures: ev.failures,
    },
    groups: ev.groups.map((g) => ({
      id: g.id,
      signature: g.signature,
      count: g.count,
      likely: g.hint,
      ...(g.history ? { recent: g.history.recent.map((x) => (x === 'passed' ? 'P' : 'F')).join(''), flips: g.history.flips } : {}),
      samples: g.samples.map((s) => ({
        result: s.resultId,
        test: sourceLabel(ev, s),
        request: s.request,
        status: s.response?.status,
        ...(s.error ? { error: values ? s.error : { kind: s.error.kind } } : {}),
        // at metadata, what a check says is its type and subject (a failure message quotes the body)
        failed: s.failedChecks.map((c) => (values ? c : { type: c.type, check: c.name })),
        // the checks as the test writes them, each by its place: a check fix names it by checkIndex (it cannot mismatch)
        failingChecksAsWritten: s.failedAssertions.map((a) => ({ checkIndex: a.index, check: a.check })),
        ...(s.unresolvedVariables ? { unresolvedVariables: s.unresolvedVariables } : {}),
        ...(s.response?.headers ? { headers: s.response.headers.slice(0, 20) } : {}),
        ...(s.response?.body !== undefined ? { body: s.response.body } : {}),
        ...(values && definitionOf(ev, s) ? { definition: definitionOf(ev, s) } : {}),
        ...(s.latencyMs !== undefined ? { latencyMs: s.latencyMs } : {}),
      })),
      lastPassing: g.lastPassing
        ? {
            run: g.lastPassing.runId,
            at: g.lastPassing.startedAt,
            status: g.lastPassing.response?.status,
            changed: g.lastPassing.changed
              ? {
                  ...(g.lastPassing.changed.status ? { status: g.lastPassing.changed.status } : {}),
                  // headers one result did not store are not compared (never "added since the last pass")
                  ...(g.lastPassing.changed.headersNotStored
                    ? { headersCompared: false, headersNotStoredFor: g.lastPassing.changed.headersNotStored === 'both' ? 'either run' : `the ${g.lastPassing.changed.headersNotStored} run` }
                    : { headers: g.lastPassing.changed.headers.map((h) => (values ? h : { name: h.name, kind: h.kind })) }),
                  body: g.lastPassing.changed.body.map((c) => (values ? c : { path: c.path, kind: c.kind })),
                  identical: g.lastPassing.changed.identical,
                }
              : 'not comparable (no stored response)',
          }
        : 'never passed before this run (in the runs kept)',
    })),
    ...(ev.omitted.groups ? { omitted: `${ev.omitted.groups} more groups (${ev.omitted.failures} failures) are not shown` } : {}),
  };
}

/** Evidence a caller gathered already (`triageRun`), so the task does not read the run twice. */
const gathered = new WeakMap<WorkspaceStore, Map<string, RunEvidence>>();

/** Run `fn` with `ev` as the evidence of its run (and of run:last when that is it). */
export async function withEvidence<T>(store: WorkspaceStore, ev: RunEvidence, fn: () => Promise<T>): Promise<T> {
  let m = gathered.get(store);
  if (!m) gathered.set(store, (m = new Map()));
  m.set(ev.runId, ev);
  try {
    return await fn();
  } finally {
    m.delete(ev.runId);
  }
}

/** The task's `prepare`: the evidence of run:<id> (or run:last). */
export async function prepareTriage(store: WorkspaceStore, item: ItemRef, o: { privacy: AiPrivacy }): Promise<PreparedItem> {
  const id = runIdOfRef(item);
  const ev = gathered.get(store)?.get(id) ?? (await runEvidence(store, id));
  return { label: `${ev.run.name} (${ev.failures} failure${ev.failures === 1 ? '' : 's'})`, context: triageContext(ev, o.privacy), local: { evidence: ev } satisfies TriageLocal };
}

/** The places a cause's fix applies to: each group's representatives (their source, step and responses). */
function targetsOf(ev: RunEvidence, groups: FailureGroup[]): FixTarget[] {
  const out: FixTarget[] = [];
  for (const g of groups)
    for (const s of g.samples) {
      const source = s.source ? ev.sources[s.source] : undefined;
      if (!source) continue;
      out.push({
        source,
        ...(s.step ? { step: s.step } : {}),
        resultIds: g.resultIds,
        failedAssertions: s.failedAssertions,
        verifyOn: [
          {
            resultId: s.resultId,
            ...(s.response && s.complete ? { failing: s.response } : s.response ? { failing: { ...s.response, body: undefined } } : {}),
            ...(g.lastPassing?.response && s === g.samples[0] ? { lastPassing: g.lastPassing.response } : {}),
          },
        ],
        unresolvedVariables: s.unresolvedVariables ?? [],
        request: s.request,
      });
    }
  return out;
}

/** "status 200 → 500; $.status removed": what changed since the last passing run, in words. */
function changedText(g: FailureGroup): string | undefined {
  const c = g.lastPassing?.changed;
  if (!c) return undefined;
  const parts = [
    c.status ? `status ${c.status.before} → ${c.status.after}` : '',
    ...c.body.slice(0, 4).map((b) => `${b.path} ${b.kind}`),
    ...c.headers.slice(0, 2).map((h) => `header ${h.name} ${h.kind}`),
  ].filter(Boolean);
  // said once: headers were not compared (one side kept none), so none is "added" or "removed"
  const note = c.headersNotStored ? `headers not stored for the ${c.headersNotStored === 'both' ? 'passing or the failing' : c.headersNotStored} run` : '';
  if (!parts.length) return c.identical ? (note ? `nothing in the status or body; ${note}` : 'nothing (the same response)') : undefined;
  return [...parts, note].filter(Boolean).join('; ');
}

/**
 * TestPion's own updates of stale expected values in groups (fix-items.ts `staleCheckUpdate`): for each representative,
 * each failing check that the failing response answers with another plain value. The model's fix comes first; these
 * are used when it gave none that could be made, and offered beside it when they differ — never silently dropped.
 */
function engineCandidates(groups: FailureGroup[], ev: RunEvidence, finding: string, title: string): DraftItem[] {
  const out: DraftItem[] = [];
  for (const g of groups)
    for (const sm of g.samples) {
      const source = sm.source ? ev.sources[sm.source] : undefined;
      if (!source || !sm.complete || !sm.response) continue;
      const last = sm === g.samples[0] ? g.lastPassing?.response : undefined;
      for (const a of sm.failedAssertions) {
        const next = staleCheckUpdate(a.check, sm.response, last);
        if (!next) continue;
        const target: FixTarget = {
          source,
          ...(sm.step ? { step: sm.step } : {}),
          resultIds: g.resultIds,
          failedAssertions: [a],
          verifyOn: [{ resultId: sm.resultId, failing: sm.response, ...(last ? { lastPassing: last } : {}) }],
          unresolvedVariables: [],
          request: sm.request,
        };
        const r = fixItems({ type: 'check', result: sm.resultId, checkIndex: a.index, replacement: next }, [target], { finding, title, engine: true });
        out.push(...r.items.map((i) => ({ ...i, title: `${i.title} (TestPion: the value the API answers now)` })));
      }
    }
  return out;
}

/** What the model may write instead, for a repair turn: the failing checks by result and checkIndex. */
function checkRefs(groups: FailureGroup[]): string {
  const refs = groups.flatMap((g) => g.samples.flatMap((sm) => sm.failedAssertions.map((a) => `result "${sm.resultId}" checkIndex ${a.index} (${checkLabel(a.check)})`))).slice(0, 6);
  return refs.length ? ` The failing checks: ${refs.join('; ')}.` : '';
}

const causesOf = (v: unknown): Cause[] => {
  const list = (v as { causes?: unknown } | undefined)?.causes;
  return Array.isArray(list) ? list.filter((c): c is Cause => !!c && typeof c === 'object') : [];
};

/**
 * The task's `propose`: each cause's fix as verified items (fix-items.ts), a bug report for an API that regressed.
 * A cause whose fix could not be made is a `problem` (the repair turn says why and how to name the check), and
 * TestPion's own update of a stale value stands in for it; when the model's check differs from TestPion's, TestPion's is
 * offered beside it (`alternatives`).
 */
export function proposeTriage(answer: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems: string[] } {
  const { evidence: ev } = input.local as TriageLocal;
  const items: DraftItem[] = [];
  const notes: string[] = [];
  const problems: string[] = [];
  causesOf(answer.value).forEach((c, n) => {
    const finding = `c${n + 1}`;
    const ids = Array.isArray(c.groups) ? c.groups.map(String) : [];
    const groups = ev.groups.filter((g) => ids.includes(g.id));
    const unknown = ids.filter((id) => !ev.groups.some((g) => g.id === id));
    if (unknown.length) notes.push(`Cause ${n + 1} named groups that do not exist (${unknown.join(', ')}): left out.`);
    if (!groups.length) return;
    const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 120) : `Cause ${n + 1}`;
    const fix = (c.fix ?? { type: 'none' }) as FixSpec;
    const targets = targetsOf(ev, groups);
    if (fix.type === 'check' || fix.type === 'edit' || fix.type === 'variable') {
      // a run that does not say what it ran (an old run, a collection file): its tests cannot be changed from here
      if (!targets.length && fix.type !== 'variable') return void notes.push(`${title}: TestPion can't find where these tests are defined, so the fix is not offered.`);
      const r = fixItems(fix, targets, { finding, title, environment: ev.run.environment });
      const own = fix.type === 'variable' ? [] : engineCandidates(groups, ev, finding, title);
      if (r.items.length) {
        // TestPion's own update, when it says something else, is offered beside the model's (Safer: … in the review)
        for (const it of r.items) {
          const alt = own.filter((o) => o.target && JSON.stringify(o.target) === JSON.stringify(it.target) && o.after !== it.after);
          if (alt.length)
            it.alternatives = [
              ...(it.alternatives ?? []),
              ...alt.map((a) => ({ label: `TestPion: ${checkLabel((a.data as { check?: CheckConfig }).check ?? { type: 'check' })}`, after: a.after, data: a.data })),
            ];
        }
        items.push(...r.items);
        notes.push(...r.notes);
        return;
      }
      // the model's fix could not be made: the repair turn says why and how to name the check
      problems.push(
        `Cause "${title}": no change could be made — ${r.notes.join(' ') || 'the fix is incomplete'} Name a failing check by its result and checkIndex: {"type": "check", "result": …, "checkIndex": N, "replacement": {the whole new check}}; an edit's find must be copied exactly from the sample's definition.${checkRefs(groups)}`,
      );
      if (own.length) {
        items.push(...own);
        notes.push(`${title}: the model's fix could not be made (${r.notes.join(' ') || 'incomplete'}); TestPion's own update of the stale value is offered instead.`);
      } else notes.push(...r.notes);
      return;
    }
    // a stale test the model gave no change for: TestPion's own update of the value (verified like any fix)
    if (c.kind === 'stale-test') {
      const own = engineCandidates(groups, ev, finding, title);
      if (own.length) {
        items.push(...own);
        notes.push(`${title}: TestPion's own update of the stale value is offered (the model proposed no change).`);
        return;
      }
    }
    // the test is right: what changed, as a bug report to copy (an API that regressed), or what to do
    const g = groups[0]!;
    const s = g.samples[0];
    const t = targets[0];
    if (c.kind === 'api-regression' && s && t) {
      const changed = changedText(g);
      items.push({
        kind: 'text',
        finding,
        title: `Bug report: ${title}`,
        after: bugReport({
          title,
          explanation: typeof c.explanation === 'string' ? c.explanation : undefined,
          target: t,
          check: s.failedChecks[0]?.name,
          message: s.failedChecks[0]?.message,
          status: s.response?.status,
          changed,
          runId: ev.runId,
          ...(g.lastPassing ? { lastPassing: { runId: g.lastPassing.runId, startedAt: g.lastPassing.startedAt } } : {}),
        }),
        language: 'markdown',
        data: {
          fix: {
            evidence: g.lastPassing
              ? {
                  changed: !!changed && !g.lastPassing.changed?.identical,
                  label: changed ? `the response changed since the last passing run: ${changed}` : 'no stored response of the last passing run to compare with',
                }
              : { changed: false, label: 'no earlier passing run: the test may never have passed' },
            verifyOn: [],
          } satisfies FixCheckData,
        },
      });
    } else if (typeof fix.note === 'string' && fix.note.trim()) items.push({ kind: 'text', finding, title: `What to do: ${title}`, after: fix.note.trim(), language: 'markdown' });
  });
  return { items, notes, problems };
}

/** Evidence a finding cites: the model's own words, then the facts TestPion gathered (each linking its result). */
function factsOf(ev: RunEvidence, groups: FailureGroup[], said: unknown): ProposalFinding['evidence'] {
  const out: ProposalFinding['evidence'] = Array.isArray(said)
    ? said
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .slice(0, 6)
        .map((text) => ({ text: text.slice(0, 300) }))
    : [];
  for (const g of groups.slice(0, 6)) {
    const s = g.samples[0];
    const ref: ItemRef | undefined = s ? { kind: 'run', runId: ev.runId, resultId: s.resultId } : undefined;
    out.push({ text: `${g.count} × ${g.signature}${s?.failedChecks[0] ? ` — ${s.failedChecks[0].message}` : s?.error ? ` — ${s.error.message}` : ''}`.slice(0, 300), ...(ref ? { ref } : {}) });
    const changed = changedText(g);
    if (g.lastPassing)
      out.push({
        text: `Last passed in run ${g.lastPassing.runId} (${g.lastPassing.startedAt.slice(0, 16).replace('T', ' ')})${changed ? `; changed since: ${changed}` : ''}`,
        ref: { kind: 'run', runId: g.lastPassing.runId },
      });
    if (g.history && g.history.flips >= 2) out.push({ text: `Its result changed ${g.history.flips} times in the last ${g.history.recent.length} runs (flaky)` });
  }
  return out;
}

/** The task's `describe`: one finding per cause, and the groups no cause explains (never hidden). */
export function describeTriage(value: unknown, items: ProposalItem[], input: AiTaskInput): { summary?: string; findings: ProposalFinding[]; notes: string[] } {
  const { evidence: ev } = input.local as TriageLocal;
  const covered = new Set<string>();
  const findings: ProposalFinding[] = [];
  causesOf(value).forEach((c, n) => {
    const ids = Array.isArray(c.groups) ? c.groups.map(String) : [];
    const groups = ev.groups.filter((g) => ids.includes(g.id));
    if (!groups.length) return;
    groups.forEach((g) => covered.add(g.id));
    const kind = TRIAGE_CAUSES.includes(c.kind as TriageCause) ? String(c.kind) : 'unknown';
    findings.push({
      id: `c${n + 1}`,
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 120) : `Cause ${n + 1}`,
      kind,
      ...(typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1 ? { confidence: c.confidence } : {}),
      ...(typeof c.explanation === 'string' ? { explanation: c.explanation.slice(0, 2000) } : {}),
      evidence: factsOf(ev, groups, c.evidence),
      count: groups.reduce((k, g) => k + g.count, 0),
      resultIds: groups.flatMap((g) => g.resultIds).slice(0, 5000),
      groups: groups.map((g) => g.id),
    });
  });
  const rest = ev.groups.filter((g) => !covered.has(g.id));
  const det = deterministicFindings(ev, rest).map((f, i) => ({ ...f, id: `d${i + 1}`, title: `${f.title} (not explained by the model)` }));
  const notes = ev.omitted.groups ? [`${ev.omitted.groups} more groups (${ev.omitted.failures} failures) were not analysed: fix these first, then triage again.`] : [];
  void items;
  return {
    ...(typeof (value as { summary?: unknown })?.summary === 'string' ? { summary: String((value as { summary: string }).summary).slice(0, 1200) } : {}),
    findings: [...findings, ...det],
    notes,
  };
}

const HINT_TITLE: Record<TriageCause, string> = {
  auth: 'Not authorised: a missing, wrong or expired credential',
  environment: 'The environment: a variable, the network or a server in front of the API',
  'api-regression': 'The API fails (5xx)',
  flaky: 'Flaky: passes and fails without a change',
  timing: 'Too slow for its time limit',
  'stale-test': 'The test expects what the API no longer answers',
  'test-data': 'Test data',
  unknown: 'Failed check',
};

/** Findings without a model: auth and environment groups together (one cause behind many endpoints), the rest one each. */
export function deterministicFindings(ev: RunEvidence, groups: FailureGroup[] = ev.groups): ProposalFinding[] {
  const clusters = new Map<string, FailureGroup[]>();
  for (const g of groups) {
    const k = g.hint === 'auth' || g.hint === 'environment' ? g.hint : `${g.hint}|${g.id}`;
    clusters.set(k, [...(clusters.get(k) ?? []), g]);
  }
  return [...clusters.values()].map((gs, i) => {
    const hint = gs[0]!.hint;
    const changed = gs.length === 1 ? changedText(gs[0]!) : undefined;
    // a check that held on the last passing run and fails now, with no 5xx: the API's answer changed
    const kind: TriageCause = hint === 'unknown' && changed && !gs[0]!.lastPassing?.changed?.identical ? 'stale-test' : hint;
    return {
      id: `d${i + 1}`,
      title: gs.length > 1 ? `${HINT_TITLE[kind]} (${gs.length} endpoints)` : `${HINT_TITLE[kind]}: ${gs[0]!.signature}`,
      kind,
      explanation: kind === 'stale-test' ? `The response changed since the last passing run (${changed}): either the API regressed or the test is stale.` : undefined,
      evidence: factsOf(ev, gs, []),
      count: gs.reduce((k, g) => k + g.count, 0),
      resultIds: gs.flatMap((g) => g.resultIds).slice(0, 5000),
      groups: gs.map((g) => g.id),
    };
  });
}

/** A triage as every host returns it: the groups, the causes (the model's, or TestPion's without one) and the proposal. */
export interface TriageReport {
  runId: string;
  run: RunEvidence['run'];
  failures: number;
  groups: Array<{ id: string; signature: string; likely: TriageCause; count: number; refs: ItemRef[]; lastPassing?: { runId: string; startedAt: string } }>;
  omitted: RunEvidence['omitted'];
  findings: ProposalFinding[];
  /** The model wrote the causes (false: TestPion's grouping alone). */
  ai: boolean;
  summary?: string;
  model?: string;
  /** Why there is no model's answer (none set up, or it failed). */
  fallback?: string;
  proposal?: Proposal;
}

/** The report of a run without a model (see `deterministicFindings`). */
export async function deterministicTriage(store: WorkspaceStore, runId: string, fallback?: string): Promise<TriageReport> {
  const ev = await runEvidence(store, runId);
  return reportOf(ev, { findings: deterministicFindings(ev), ai: false, ...(fallback ? { fallback } : {}) });
}

export function reportOf(ev: RunEvidence, o: Pick<TriageReport, 'findings' | 'ai'> & Partial<TriageReport>): TriageReport {
  return {
    runId: ev.runId,
    run: ev.run,
    failures: ev.failures,
    groups: ev.groups.map((g) => ({
      id: g.id,
      signature: g.signature,
      likely: g.hint,
      count: g.count,
      refs: g.samples.map((s) => ({ kind: 'run' as const, runId: ev.runId, resultId: s.resultId })),
      ...(g.lastPassing ? { lastPassing: { runId: g.lastPassing.runId, startedAt: g.lastPassing.startedAt } } : {}),
    })),
    omitted: ev.omitted,
    ...o,
  };
}
