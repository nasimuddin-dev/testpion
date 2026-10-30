/**
 * Prompt versions of a saved evaluation (A-4, A-5): snapshots of its prompt and system prompt, each with the result of the run
 * made with it, so "which wording is better" is a list and "go back" is one click. A run is tied to a version by what it ran, not
 * by a label: every case of an evaluation run carries the tag `prompt:<hash>` of the prompt and system prompt it was sent with
 * (`evaluationTests`), and a version is its own hash. Making a version current is gated: one that failed the pass line, or did worse
 * than the prompt in use, or was never run, asks first and says the numbers.
 */
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readRunSummary } from './run-records.js';
import { runResults } from './run-results.js';
import { EVALUATIONS_LIBRARY, findSavedEvaluation, promptHashOf, type PromptVersion, type SavedEvaluation } from './saved-evaluations.js';

/** The tag every case of an evaluation run carries. */
export const PROMPT_TAG = 'prompt:';

export interface PromptVersionRun {
  runId: string;
  startedAt: string;
  passed: number;
  total: number;
  /** 0 to 1. */
  passRate: number;
  costUsd: number;
}

export interface PromptVersionRow {
  /** The version's id: the hash of its prompt. */
  id: string;
  name: string;
  at: string;
  note?: string;
  /** This is the evaluation's prompt now. */
  current: boolean;
  /** The newest run made with exactly this prompt. */
  run?: PromptVersionRun;
  prompt: string;
  system?: string;
}

export interface PromptVersions {
  evaluation: string;
  /** The hash of the prompt in use, and whether it is saved as a version (else it is "unsaved"). */
  currentHash: string;
  currentSaved: boolean;
  /** The newest run of the prompt in use, when it has one that is not a saved version's. */
  currentRun?: PromptVersionRun;
  passLine?: number;
  versions: PromptVersionRow[];
  text: string;
}

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** The hash a run was made with: the tag of its first result. */
async function runHash(store: WorkspaceStore, runId: string): Promise<string | undefined> {
  for await (const r of runResults(store, runId)) return r.tags?.find((t) => t.startsWith(PROMPT_TAG))?.slice(PROMPT_TAG.length);
  return undefined;
}

/** The newest finished run for each prompt hash among the runs of this evaluation (at most the newest 100 are read). */
export async function runsByPrompt(store: WorkspaceStore, evaluation: string): Promise<Map<string, PromptVersionRun>> {
  const out = new Map<string, PromptVersionRun>();
  const metas = store.meta.listRuns({ query: evaluation, limit: 200 }).items.filter((m) => m.name === evaluation).slice(0, 100);
  for (const m of metas) {
    const s = readRunSummary(store, m.id);
    if (!s || s.cancelled || s.total - s.skipped <= 0) continue;
    const hash = await runHash(store, m.id);
    if (!hash || out.has(hash)) continue;
    const ran = s.total - s.skipped;
    out.set(hash, { runId: m.id, startedAt: s.startedAt, passed: s.passed, total: ran, passRate: s.passed / ran, costUsd: s.costUsd ?? 0 });
  }
  return out;
}

/** The versions of a saved evaluation, newest first, each with the result of its latest run. */
export async function listPromptVersions(store: WorkspaceStore, ref: string): Promise<PromptVersions> {
  const saved = findSavedEvaluation(store, ref);
  const currentHash = promptHashOf(saved);
  const runs = await runsByPrompt(store, saved.name);
  const list = [...(saved.promptVersions ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const versions: PromptVersionRow[] = list.map((v) => ({ id: v.id, name: v.name, at: v.at, ...(v.note ? { note: v.note } : {}), current: v.id === currentHash, ...(runs.get(v.id) ? { run: runs.get(v.id)! } : {}), prompt: v.prompt, ...(v.system ? { system: v.system } : {}) }));
  const currentSaved = versions.some((v) => v.current);
  const currentRun = !currentSaved ? runs.get(currentHash) : undefined;
  const say = (v: PromptVersionRow) => `${v.current ? '* ' : '  '}${v.name}: ${v.run ? `${v.run.passed} of ${v.run.total} passed (${percent(v.run.passRate)})` : 'not run yet'}`;
  const text = versions.length ? versions.map(say).join('\n') : 'No versions saved yet.';
  return { evaluation: saved.name, currentHash, currentSaved, ...(currentRun ? { currentRun } : {}), ...(typeof saved.passLine === 'number' ? { passLine: saved.passLine } : {}), versions, text };
}

function writeEvaluation(store: WorkspaceStore, id: string, change: (d: SavedEvaluation) => SavedEvaluation): void {
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i.id === id ? { ...i, data: change(i.data), updatedAt: new Date().toISOString() } : i)) });
}

/** Save the evaluation's prompt and system prompt now as a named version. A prompt that is already a version is not saved twice. */
export function savePromptVersion(store: WorkspaceStore, o: { evaluation: string; name: string; note?: string }): PromptVersion {
  const saved = findSavedEvaluation(store, o.evaluation);
  if (saved.type === 'rag') throw new ApsError('ValidationError', 'A bot with sources has no prompt of its own to version: the bot answers', { suggestions: [] });
  const name = o.name.trim();
  if (!name) throw new ApsError('ValidationError', 'Give the version a name, for example "Shorter prompt"');
  const id = promptHashOf(saved);
  const have = saved.promptVersions ?? [];
  const same = have.find((v) => v.id === id);
  if (same) throw new ApsError('ValidationError', `This prompt is already saved as "${same.name}"`, { suggestions: ['Change the prompt first, or use that version.'] });
  if (have.some((v) => v.name.toLowerCase() === name.toLowerCase())) throw new ApsError('ValidationError', `There is already a version called "${name}"`, { suggestions: ['Choose another name.'] });
  const version: PromptVersion = { id, name, prompt: saved.prompt, ...(saved.system ? { system: saved.system } : {}), at: new Date().toISOString(), ...(o.note?.trim() ? { note: o.note.trim() } : {}) };
  writeEvaluation(store, saved.id, (d) => ({ ...d, promptVersions: [...(d.promptVersions ?? []), version] }));
  return version;
}

export interface PromptGate {
  /** Why making the version current asks first, in words with the numbers; empty: it goes through. */
  reasons: string[];
}

/** What stands in the way of making a version current (A-5): under the pass line, worse than the prompt in use, or never run. */
export function promptGate(v: { name: string; run?: PromptVersionRun }, current: { name?: string; run?: PromptVersionRun }, passLine?: number): PromptGate {
  const reasons: string[] = [];
  if (!v.run) reasons.push(`"${v.name}" has not been run: nothing says how it does.`);
  else {
    if (typeof passLine === 'number' && v.run.passRate * 100 < passLine) reasons.push(`"${v.name}" passed ${v.run.passed} of ${v.run.total} (${percent(v.run.passRate)}); the pass line is ${passLine}%.`);
    if (current.run && v.run.passRate < current.run.passRate) reasons.push(`"${v.name}" passed ${percent(v.run.passRate)}; the prompt in use${current.name ? ` ("${current.name}")` : ''} passed ${percent(current.run.passRate)}.`);
  }
  return { reasons };
}

/**
 * Make a saved version the evaluation's prompt. The prompt in use is kept first ("Before <version>") when it is not a version
 * yet, so nothing is lost. With reasons from the gate it throws until `confirm` is true, and says the numbers.
 */
export async function usePromptVersion(store: WorkspaceStore, o: { evaluation: string; version: string; confirm?: boolean }): Promise<{ evaluation: string; version: string; kept?: string; gated: string[] }> {
  const list = await listPromptVersions(store, o.evaluation);
  const want = o.version.trim().toLowerCase();
  const v = list.versions.find((x) => x.id === o.version || x.name.toLowerCase() === want);
  if (!v) throw new ApsError('ValidationError', `No version "${o.version}" of "${list.evaluation}". Saved: ${list.versions.map((x) => x.name).join(', ') || 'none'}`, { suggestions: ['List them with `testpion eval versions <evaluation>`.'] });
  if (v.current) return { evaluation: list.evaluation, version: v.name, gated: [] };
  const inUse = list.versions.find((x) => x.current);
  const gate = promptGate(v, { name: inUse?.name, run: inUse?.run ?? list.currentRun }, list.passLine);
  if (gate.reasons.length && !o.confirm) throw new ApsError('ValidationError', `${gate.reasons.join(' ')} Confirm to make it current anyway.`, { suggestions: ['Run it first, or pass --confirm.'] });
  const saved = findSavedEvaluation(store, o.evaluation);
  let kept: string | undefined;
  if (!list.currentSaved && saved.prompt.trim()) {
    kept = `Before ${v.name}`;
    let name = kept;
    for (let i = 2; (saved.promptVersions ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${kept} (${i})`;
    savePromptVersion(store, { evaluation: o.evaluation, name });
    kept = name;
  }
  writeEvaluation(store, saved.id, (d) => {
    const { system: _s, ...rest } = d;
    return { ...rest, prompt: v.prompt, ...(v.system ? { system: v.system } : {}) };
  });
  return { evaluation: list.evaluation, version: v.name, ...(kept ? { kept } : {}), gated: gate.reasons };
}
