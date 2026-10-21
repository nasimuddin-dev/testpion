/**
 * The workspace's own variables (the Globals) in a bundle. They are not an item of any kind, so a bundle carries them in
 * the manifest's `workspace` section: written when an export is asked to carry them (a whole-workspace export does by
 * default), previewed by key (new, the same, different) and merged on import without ever blanking a value the
 * workspace already has. Secret values never travel: a secret variable is blank in the bundle and marked secret.
 */
import { sha256Hex } from '../util/hash.js';
import type { SecretStripper } from '../storage/bundle-secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { BundleVariable, BundleWorkspaceSection } from './format.js';

type Row = BundleVariable;

/** The workspace's variables as a bundle section (secret values replaced), or undefined when there are none. */
export function workspaceSectionOf(store: WorkspaceStore, strip: SecretStripper): BundleWorkspaceSection | undefined {
  const own = (store.workspace.variables ?? []) as Row[];
  if (!own.length) return undefined;
  const clean = (strip.variables('workspace', 'the workspace variables', own.map((v) => ({ ...v }))) ?? []) as Row[];
  return { variables: clean.map((v) => ({ key: v.key, value: v.value, ...(typeof v.enabled === 'boolean' ? { enabled: v.enabled } : {}), ...(v.description ? { description: v.description } : {}), ...(v.secret ? { secret: true } : {}) })) };
}

type VariableAction = 'new' | 'same' | 'differs';

export interface WorkspaceVariablesPreview {
  total: number;
  variables: Array<{ key: string; action: VariableAction; secret: boolean }>;
  counts: Record<VariableAction, number>;
}

/** What importing the section would do to the workspace's variables, by key. A blank secret counts as the same when the key is already there. */
export function previewWorkspaceVariables(store: WorkspaceStore, section: BundleWorkspaceSection | undefined): WorkspaceVariablesPreview | undefined {
  if (!section?.variables.length) return undefined;
  const mine = new Map(((store.workspace.variables ?? []) as Row[]).map((v) => [v.key, v]));
  const counts: Record<VariableAction, number> = { new: 0, same: 0, differs: 0 };
  const variables = section.variables.map((v) => {
    const have = mine.get(v.key);
    const action: VariableAction = !have ? 'new' : v.secret || have.value === v.value ? 'same' : 'differs';
    counts[action]++;
    return { key: v.key, action, secret: !!v.secret };
  });
  return { total: variables.length, variables, counts };
}

export type VariableChoice = 'merge' | 'replace' | 'skip';

export interface WorkspaceVariablesOutcome {
  added: number;
  replaced: number;
  /** Variables the workspace already had with another value, left as they were (merge). */
  kept: number;
}

/** The checksum Undo compares to find out whether the variables were edited after the import. */
export const variablesSha = (store: WorkspaceStore): string => sha256Hex(JSON.stringify(store.workspace.variables ?? []));

/**
 * Write the section into the workspace. `merge` adds the keys that are new; `replace` also takes the incoming value of a
 * key that is there (a blank secret never wipes a value); `skip` writes nothing. Returns what was done, or undefined
 * when nothing changed (so no journal entry is made for it).
 */
export function applyWorkspaceVariables(store: WorkspaceStore, section: BundleWorkspaceSection | undefined, choice: VariableChoice, keepBefore: (before: Row[]) => void): WorkspaceVariablesOutcome | undefined {
  if (!section?.variables.length || choice === 'skip') return undefined;
  const before = ((store.workspace.variables ?? []) as Row[]).map((v) => ({ ...v }));
  const next = before.map((v) => ({ ...v }));
  const at = new Map(next.map((v, i) => [v.key, i]));
  const out: WorkspaceVariablesOutcome = { added: 0, replaced: 0, kept: 0 };
  for (const v of section.variables) {
    const i = at.get(v.key);
    if (i === undefined) {
      at.set(v.key, next.length);
      next.push({ ...v });
      out.added++;
    } else if (v.secret || next[i]!.value === v.value) {
      // the same, or a secret the bundle could not carry: what the workspace has stays
    } else if (choice === 'replace') {
      next[i] = { ...next[i]!, ...v };
      out.replaced++;
    } else out.kept++;
  }
  if (!out.added && !out.replaced) return out.kept ? out : undefined;
  keepBefore(before);
  store.updateWorkspace({ variables: next });
  return out;
}

/** Put the variables back as they were before an import, unless they were edited since (then they are left and named). */
export function restoreWorkspaceVariables(store: WorkspaceStore, saved: { before: Row[]; afterSha: string }): boolean {
  if (variablesSha(store) !== saved.afterSha) return false;
  store.updateWorkspace({ variables: saved.before });
  return true;
}
