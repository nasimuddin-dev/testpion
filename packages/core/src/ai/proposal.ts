/**
 * Proposals (AIB-4): what an AI task suggests changing, never applied by the task itself. A proposal lists items (a
 * test file, a flow, checks to add to a request, a script, a request, a patch) each with its before/after text for a
 * diff and the badges of the verifiers that checked it. It is kept per workspace in `.local/ai/proposals/` (git-ignored,
 * per computer) for a day, so the app, the CLI (`testpion ai apply <id>`) and an agent over MCP (`ai_apply_proposal`)
 * can apply it — all of it or some items — as a separate, deliberate step.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { atomicWrite, removeOwned } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { noteProposalOutcome, type AiSurface } from '../storage/ai-usage.js';
import { shortId } from '../util/ids.js';
import { checkedTestFilePath } from '../storage/test-path.js';

type ProposalItemKind = 'file' | 'flow' | 'assertion' | 'script' | 'request' | 'patch' | 'variable' | 'collection' | 'spec' | 'metric' | 'dataset-row' | 'evaluation' | 'text';

/** What a verifier said about an item: `pass` (checked and fine), `fail`, `warn`, `skip` (could not check). */
export interface VerificationBadge {
  verifier: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  /** Short: "parsed", "linted", "7/7 checks pass on the last response". */
  label: string;
  detail?: string;
}

export interface ProposalItem {
  id: string;
  kind: ProposalItemKind;
  title: string;
  /** The thing it changes (a request, a flow, a collection). */
  target?: ItemRef;
  /** file / flow: the path under tests/ (`smoke/orders.yaml`). */
  path?: string;
  /** assertion: the step (its id or name) of the test file `path` the check is added to (a check for a request is added to the saved request instead). */
  step?: string;
  /** The current text (absent for something new). */
  before?: string;
  /** The proposed text (YAML, JSON, JavaScript, Markdown). */
  after: string;
  language?: 'yaml' | 'json' | 'javascript' | 'markdown' | 'text' | 'graphql';
  /** Structured payload for applying: the check (assertion), `{ phase }` (script), the request (request, patch). */
  data?: unknown;
  verification: VerificationBadge[];
  /** Ticked when the review opens: a failing verification unticks it. */
  selected: boolean;
  /** Safer forms a verifier offers (a check that pins a changing value → exists / type / regex); the review can switch to one. */
  alternatives?: Array<{ label: string; after: string; data?: unknown }>;
  /** The finding it fixes (`Proposal.findings`: a cause of failures, a flaky pattern). */
  finding?: string;
}

/**
 * What an analysing task found (a cause behind failed results, why a test is flaky), with its evidence: shown above
 * the items that fix it. A finding without items is an explanation only (the API regressed, a token expired).
 */
export interface ProposalFinding {
  id: string;
  title: string;
  /** api-regression, stale-test, auth, environment, test-data, flaky, timing … (the task's own words). */
  kind: string;
  /** 0–1, the model's own. */
  confidence?: number;
  explanation?: string;
  /** Facts behind it, each linking what it is about when it can. */
  evidence: Array<{ text: string; ref?: ItemRef }>;
  /** How many results it explains. */
  count?: number;
  /** The results it explains (for "Rerun the affected tests"), at most a few thousand. */
  resultIds?: string[];
  /** The deterministic groups it covers. */
  groups?: string[];
}

export interface ProposalUndo {
  item: string;
  /** file: the content before (null: the file did not exist). */
  file?: { path: string; before: string | null };
  /** request: the node before (null: it did not exist) in its collection. */
  node?: { collectionId: string; nodeId: string; parentId?: string; before: unknown | null };
  /** collection: the whole collection before the change (a tidy). */
  collection?: { collectionId: string; before: unknown };
  /** variable: its value in the environment before (null: it was not there). */
  variable?: { environment: string; key: string; before: string | null };
  /** spec: an API definition of the workspace (specs/…) before the change. */
  spec?: { path: string; before: string };
  /** metric: a custom metric file (metrics/<id>.yaml) before the change (null: it did not exist). */
  metric?: { id: string; before: string | null };
  /** dataset-row: a dataset file (datasets/<name>.jsonl) before the rows were added (null: it did not exist). */
  dataset?: { path: string; before: string | null };
  /** evaluation: a saved evaluation (library `evaluations`) before the change (null: it did not exist). */
  evaluation?: { id: string; before: unknown | null };
}

export interface Proposal {
  schemaVersion: 1;
  id: string;
  task: string;
  /** The prompt version that produced it (tasks are versioned). */
  taskVersion: number;
  title: string;
  summary?: string;
  /** What the model assumed ("POST /orders returns id"). */
  assumptions: string[];
  /** What TestPion changed in the model's answer before offering it (a step naming a request that does not exist, dropped). */
  notes?: string[];
  items: ProposalItem[];
  provider: string;
  model: string;
  surface: AiSurface;
  createdAt: string;
  expiresAt: string;
  status: 'open' | 'applied' | 'discarded';
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** What the task was asked (for Regenerate): the question, the item, the hint. */
  request?: { question?: string; item?: ItemRef; hint?: string; privacy?: string; path?: string };
  /** Problems the model's answer still had after the repairs (shown, never hidden). */
  problems?: string[];
  /** What it found (an analysing task: triage, flaky analysis), with the items that fix each. */
  findings?: ProposalFinding[];
  /** Attempts to fix: the items applied, then the tests run again (`attemptFix`), newest last. */
  attempts?: ProposalAttempt[];
  applied?: { at: string; items: string[]; undo: ProposalUndo[]; undone?: string };
}

/** One "Attempt to fix": what ran how often, and the verdict. */
export interface ProposalAttempt {
  at: string;
  items: string[];
  runs: number;
  passed: number;
  /** stable: passed every time; flaky: some runs failed; failing: none passed. */
  verdict: 'stable' | 'flaky' | 'failing';
  /** The failures of the runs that failed (the first few). */
  failures?: string[];
}

const PROPOSAL_STATUSES: ReadonlyArray<Proposal['status']> = ['open', 'applied', 'discarded'];

/** A proposal is kept a day. */
const PROPOSAL_TTL_MS = 24 * 3600_000;
/** At most this many proposals per workspace (the oldest go first). */
const MAX_PROPOSALS = 200;

const dir = (store: WorkspaceStore) => join(store.root, '.local', 'ai', 'proposals');
const fileOf = (store: WorkspaceStore, id: string) => {
  if (!/^ai-[A-Za-z0-9_-]{4,40}$/.test(id)) throw new ApsError('ValidationError', `"${id}" is not a proposal id (they look like ai-k3x9q2)`);
  return join(dir(store), `${id}.json`);
};

/**
 * The test file a task is asked to propose (`--path`, an RPC's `path`), checked before anything is sent: a YAML or
 * JSON file inside tests/. A path that leaves tests/ is refused here, not after the model was paid for; applying checks
 * it again (writeTestFile), so a hand-edited proposal cannot write outside either.
 */
export function proposedTestFilePath(store: WorkspaceStore, asked: string): string {
  // the same rules on every OS (storage/test-path.ts), not node:path's: C:\x.yaml is refused on Linux and macOS too
  return checkedTestFilePath(store.path('tests'), asked).rel;
}

function newProposalId(): string {
  return shortId('ai-');
}

/** A new open proposal: the fields of the task, with the id, the timestamps and the status every proposal starts with. */
export function openProposal(f: Omit<Proposal, 'schemaVersion' | 'id' | 'createdAt' | 'expiresAt' | 'status'>, now = Date.now()): Proposal {
  return { schemaVersion: 1, id: newProposalId(), ...f, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(), status: 'open' };
}

/** A proposal TestPion made without a model (none set up, or not asked for), saved: no assumptions, no usage. */
export function saveDraftProposal(
  store: WorkspaceStore,
  f: { task: string; title: string; summary: string; notes: string[]; items: ProposalItem[]; findings?: ProposalFinding[]; model: string; surface: AiSurface; request: NonNullable<Proposal['request']> },
): Proposal {
  const { findings, ...rest } = f;
  return saveProposal(store, openProposal({ ...rest, taskVersion: 0, assumptions: [], ...(findings ? { findings } : {}), provider: 'TestPion', usage: { inputTokens: 0, outputTokens: 0 } }));
}

export function saveProposal(store: WorkspaceStore, p: Proposal): Proposal {
  mkdirSync(dir(store), { recursive: true });
  atomicWrite(fileOf(store, p.id), JSON.stringify(p, null, 2));
  pruneProposals(store);
  return p;
}

/** A proposal by its id; expired or unknown ones say so (with what to do). */
export function getProposal(store: WorkspaceStore, id: string, now = Date.now()): Proposal {
  const f = fileOf(store, id);
  if (!existsSync(f))
    throw new ApsError('ConfigurationError', `No AI proposal "${id}" in this workspace`, {
      suggestions: ['Proposals are kept for a day on the computer that made them: run the task again (testpion ai run …, MCP ai_run_task).', 'testpion ai proposals lists the open ones.'],
    });
  let p: Proposal;
  try {
    p = JSON.parse(readFileSync(f, 'utf8')) as Proposal;
    if (!p || typeof p !== 'object' || !Array.isArray(p.items)) throw new Error('not a proposal');
  } catch {
    // a damaged file (an edit, a disk error) is said as such, not as an internal error
    throw new ApsError('ConfigurationError', `The AI proposal "${id}" cannot be read`, { suggestions: ['Run the task again for a new proposal.'] });
  }
  if (p.status === 'open' && Date.parse(p.expiresAt) < now)
    throw new ApsError('ConfigurationError', `The AI proposal "${id}" expired`, { suggestions: ['Run the task again: a proposal is kept for a day.'] });
  return p;
}

interface ProposalSummary {
  id: string;
  task: string;
  title: string;
  status: Proposal['status'];
  items: number;
  createdAt: string;
  expiresAt: string;
  model: string;
  surface: AiSurface;
}

/** The proposals of a workspace, newest first (expired open ones are left out and removed). */
export function listProposals(store: WorkspaceStore, o: { status?: Proposal['status'] } = {}): ProposalSummary[] {
  // an unknown status is a mistake (a typo, an agent's guess), not "no proposals" (every host: app, CLI, MCP)
  if (o.status && !PROPOSAL_STATUSES.includes(o.status))
    throw new ApsError('ValidationError', `"${String(o.status)}" is not a proposal status`, { suggestions: [`Use one of: ${PROPOSAL_STATUSES.join(', ')}`] });
  pruneProposals(store);
  if (!existsSync(dir(store))) return [];
  const out: ProposalSummary[] = [];
  for (const name of readdirSync(dir(store))) {
    if (!name.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir(store), name), 'utf8')) as Proposal;
      if (o.status && p.status !== o.status) continue;
      out.push({
        id: p.id,
        task: p.task,
        title: p.title,
        status: p.status,
        items: p.items.length,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        model: `${p.provider}/${p.model}`,
        surface: p.surface,
      });
    } catch {
      /* a broken file is skipped (and pruned when old) */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Discard a proposal: it stays listed as discarded until it expires (the usage ledger counts the outcome). */
export function discardProposal(store: WorkspaceStore, id: string): Proposal {
  const p = getProposal(store, id);
  if (p.status === 'applied')
    throw new ApsError('ConfigurationError', `The AI proposal "${id}" was applied already`, { suggestions: ['Undo it instead (the app offers Undo; testpion ai undo <id>).'] });
  noteProposalOutcome(store, p.id, p.createdAt, 'discarded');
  return saveProposal(store, { ...p, status: 'discarded' });
}

/** Remove expired proposals (a day old, an applied one a week) and keep at most MAX_PROPOSALS. */
function pruneProposals(store: WorkspaceStore, now = Date.now()): void {
  const d = dir(store);
  if (!existsSync(d)) return;
  const files = readdirSync(d)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      const f = join(d, n);
      try {
        return { f, at: statSync(f).mtimeMs };
      } catch {
        return { f, at: 0 };
      }
    })
    .sort((a, b) => b.at - a.at);
  files.forEach((x, i) => {
    // applied ones keep their undo for a week; the rest expire after a day
    if (i >= MAX_PROPOSALS || now - x.at > 7 * PROPOSAL_TTL_MS) return removeOwned(x.f);
    if (now - x.at > PROPOSAL_TTL_MS) {
      try {
        const p = JSON.parse(readFileSync(x.f, 'utf8')) as Proposal;
        if (p.status !== 'applied') removeOwned(x.f);
      } catch {
        removeOwned(x.f);
      }
    }
  });
}
