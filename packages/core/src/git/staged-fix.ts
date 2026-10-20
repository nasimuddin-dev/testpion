import { readFileSync } from 'node:fs';
import { kindOfPath } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { secretKeys, type SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Environment } from '../model/types.js';
import { workspaceFile } from './item-address.js';
import { beginJournal } from './journal.js';
import { isAllowed, readSecretsAllow, secretFingerprint } from './secrets-allow.js';
import { stripFileText, type StagedSecret } from './staged-secrets.js';

/**
 * The one-click fix for secrets typed into a staged file, for the kinds that `fixCommittableSecrets` does not reach (release C
 * of planning/git-everything.md §4e, B-26b): MCP servers (headers and environment), AI providers (headers, and a typed key),
 * library items (gRPC metadata, WebSocket headers, prompts, monitors …), test and flow files, API definitions and any other
 * JSON or text file in the workspace. Collections, environments and workspace variables keep their own fix (they are saved
 * through the store).
 *
 * It uses the same reading as the scan, so what is fixed is exactly what was found: each value becomes a `{{variable}}` in the
 * file (written in the stable form) and the value a secret variable of the chosen environment, in the OS secret store, never
 * in a file. A provider's typed key goes to its provider secret instead. A value `.testpion/secrets-allow.json` allows is
 * left alone. The files are copied aside first, so Undo restores them.
 */
export interface StagedFixResult {
  fixed: Array<{ file: string; item: string; field: string; variable: string }>;
  /** Secret variables created in the environment. */
  variables: string[];
  /** Files rewritten (a dry run: that would be). */
  files: string[];
  skipped: Array<{ file: string; reason: string }>;
  applied: boolean;
  undoId?: string;
}

/** Kinds whose fix goes through the store (see fixCommittableSecrets). */
const STORE_KINDS = new Set(['collection', 'environment', 'workspace']);

export async function fixStagedFiles(store: WorkspaceStore, secrets: SecretStore | undefined, o: { files: string[]; environmentId: string; dryRun?: boolean }): Promise<StagedFixResult> {
  const env = store.listEnvironments().find((e) => e.id === o.environmentId);
  if (!env) throw new ApsError('ValidationError', `No environment ${o.environmentId} to keep the secret variables in`, { suggestions: ['Pass an existing environment: its secret variables keep the values.'] });
  const result: StagedFixResult = { fixed: [], variables: [], files: [], skipped: [], applied: false };
  const allow = readSecretsAllow(store.root).entries;
  // names the environment uses are never taken by a replacement, and neither are the ones an earlier file just took
  const reserved = new Set(env.variables.map((v) => v.key));
  const texts = new Map<string, string>();
  const values = new Map<string, string>();
  const providerKeys = new Map<string, string>();
  for (const file of [...new Set(o.files)]) {
    const kind = kindOfPath(file, { raw: true })?.kind;
    if (kind && STORE_KINDS.has(kind)) continue;
    if (kind === 'dataset') {
      result.skipped.push({ file, reason: 'a dataset holds data: change the data (or generate synthetic data) instead of moving it to a variable' });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(workspaceFile(store.root, file), 'utf8');
    } catch {
      result.skipped.push({ file, reason: 'the file is not in the working folder any more' });
      continue;
    }
    const r = stripFileText(file, text, { reserve: reserved, allow: (item, field, value) => isAllowed(allow, { file, item, field, hash: secretFingerprint(file, item, field, value) }) });
    if (!r.replaced.length) continue;
    r.replaced.forEach((x, i) => {
      const value = r.values[i]!;
      const provider = /^\{\{\$secret\.provider\.(.+)\.apiKey\}\}$/.exec(x.variable)?.[1];
      if (provider) providerKeys.set(provider, value);
      else {
        const name = x.variable.replace(/^\{\{|\}\}$/g, '');
        values.set(name, value);
        reserved.add(name);
      }
      result.fixed.push({ file, item: x.item, field: x.field, variable: x.variable.startsWith('{{') ? x.variable : `{{${x.variable}}}` });
    });
    texts.set(file, r.text);
    result.files.push(file);
  }
  result.variables = [...values.keys()];
  if (o.dryRun || !texts.size) return result;
  if (!secrets) throw new ApsError('ConfigurationError', 'There is no secret store here to keep the values in', { suggestions: ['Fix it in the TestPion app (Git view), whose secret store keeps them; `dryRun` shows what would change.'] });

  const undo = beginJournal(store.root, 'fix-secrets', 'Move typed secrets to secret variables', result.files);
  for (const [id, value] of providerKeys) await secrets.set(secretKeys.provider(id), value);
  if (values.size) {
    const latest = store.listEnvironments().find((e) => e.id === env.id) ?? env;
    const vars: Environment['variables'] = [...latest.variables];
    for (const [key, value] of values) {
      await secrets.set(secretKeys.envVar(env.id, key), value);
      const i = vars.findIndex((x) => x.key === key);
      const row = { key, value: '', enabled: true, secret: true };
      if (i >= 0) vars[i] = { ...vars[i]!, ...row };
      else vars.push(row);
    }
    store.saveEnvironment({ ...latest, variables: vars });
  }
  for (const [file, text] of texts) atomicWrite(workspaceFile(store.root, file), text);
  return { ...result, applied: true, undoId: undo.id };
}

export type { StagedSecret };
