import { kindOfPath, libraryOfPath, LIBRARY_LABEL, type ItemRef } from '@testpion/shared';
import type { Collection, Environment, KeyValue, McpServerConfig, ProviderConfig } from '../model/types.js';
import { classifySecret, isSecretReference, type SecretConfidence } from '../security/secrets.js';
import { SecretStripper, type ReplacedSecret, type ReplacedSecretKind } from '../storage/bundle-secrets.js';
import { isBinaryPath } from './item-changes.js';
import { requireRepo } from './item-ops.js';
import { runGit, toRepoPath } from './git.js';

/**
 * The secret scan of a commit, over what is STAGED (release B of planning/git-everything.md §4e): the blobs in the index,
 * not the working folder, so what is scanned is exactly what the commit would publish. It uses the one detector the exports
 * use (`SecretStripper`, security/secrets.ts `classifySecret`), kind by kind: collections, environments, workspace
 * variables, MCP servers (deny by default), providers, library items, test files, API definitions, datasets, and the
 * shapes of provider keys, private keys and passwords in any other text file.
 *
 *  - `high`: a secret name with a typed value, or a value shaped like a key: the commit is refused.
 *  - `medium`: probably a secret (a value in an MCP header, a JWT): the user can confirm and commit anyway.
 */
export interface StagedSecret {
  file: string;
  kind: ReplacedSecretKind;
  /** The item, in words: "MCP server Weather", "environment Staging". */
  item: string;
  /** Where in it: `headers.Authorization`, `variables.token`. */
  field: string;
  /** The variable to use instead: `{{WEATHER_AUTHORIZATION}}`. */
  variable: string;
  confidence: Extract<SecretConfidence, 'high' | 'medium'>;
  /** In plain words, for the panel, the CLI and agents. Never the value. */
  message: string;
  ref?: ItemRef;
}

export interface StagedScan {
  /** Nothing staged is scanned for these: the commit would take all of them. */
  staged: string[];
  /** High confidence: the commit is refused until they are fixed (or unstaged). */
  blocking: StagedSecret[];
  /** Medium confidence: the commit needs a confirmation. */
  confirm: StagedSecret[];
  /** Staged files that were too big or binary to read, named so nothing is claimed for them. */
  skipped: string[];
}

const SCHEME = /^(Bearer|Basic|Token|Digest|ApiKey)\s+/i;
const MAX_SCAN = 8 * 1024 * 1024;

/** The exports' stripper, told how sure each replacement is. */
class Scan extends SecretStripper {
  readonly levels = new Map<number, 'high' | 'medium'>();
  override swap(kind: ReplacedSecretKind, item: string, field: string, base: string, value: string): string {
    const i = this.replaced.length;
    const key = field.split('.').pop()!.replace(/\[.*$/, '');
    const c = classifySecret(key, value.replace(SCHEME, '')) ?? classifySecret(key, value);
    this.levels.set(i, c?.confidence === 'high' ? 'high' : 'medium');
    return super.swap(kind, item, field, base, value);
  }
  override text(kind: ReplacedSecretKind, item: string, field: string, s: string): string {
    const i = this.replaced.length;
    const out = super.text(kind, item, field, s);
    for (let j = i; j < this.replaced.length; j++) this.levels.set(j, 'high');
    return out;
  }
  override variables<T extends KeyValue & { secret?: boolean }>(kind: ReplacedSecretKind, item: string, vars: T[] | undefined): T[] | undefined {
    const i = this.replaced.length;
    const out = super.variables(kind, item, vars);
    for (let j = i; j < this.replaced.length; j++) {
      const key = this.replaced[j]!.field.replace(/^variables\./, '');
      const v = vars?.find((x) => x.key === key);
      this.levels.set(j, classifySecret(key, v?.value)?.confidence === 'high' ? 'high' : 'medium');
    }
    return out;
  }
  override provider(p: ProviderConfig): ProviderConfig {
    const i = this.replaced.length;
    const out = super.provider(p);
    for (let j = i; j < this.replaced.length; j++) if (!this.levels.has(j)) this.levels.set(j, this.replaced[j]!.field === 'apiKey' ? 'high' : 'medium');
    return out;
  }
}

type Rec = Record<string, unknown>;
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
};

/** What one staged file holds, scanned by its kind. */
export function scanFileText(file: string, text: string): StagedSecret[] {
  const strip = new Scan();
  const refs = new Map<number, ItemRef | undefined>();
  const at = (ref?: ItemRef) => {
    for (let i = refs.size; i < strip.replaced.length; i++) refs.set(i, ref);
  };
  const k = kindOfPath(file, { raw: true });
  const lib = libraryOfPath(file, { raw: true });
  const doc = /\.json$/i.test(file) ? parse(text) : undefined;
  const has = (key: string): boolean => !!doc && typeof doc === 'object' && Array.isArray((doc as Rec)[key]);
  if (k?.kind === 'collection' && k.id && doc && typeof doc === 'object') {
    strip.collection(doc as Collection);
    at({ kind: 'collection', collectionId: String((doc as Rec).id ?? k.id) });
  } else if (k?.kind === 'environment' && k.id && doc && typeof doc === 'object') {
    const e = doc as unknown as Environment;
    strip.environment(e);
    at(e.id ? { kind: 'environment', environmentId: e.id } : undefined);
  } else if (k?.kind === 'workspace' && has('variables')) {
    strip.variables('workspace', 'workspace', (doc as Rec).variables as KeyValue[]);
    at({ kind: 'environment', scope: 'workspace' });
  } else if (k?.kind === 'mcp-server' && has('servers')) {
    for (const s of (doc as Rec).servers as McpServerConfig[]) {
      strip.mcpServer(s);
      at(s?.id ? { kind: 'mcp-server', serverId: s.id } : undefined);
    }
  } else if (k?.kind === 'provider' && has('providers')) {
    for (const p of (doc as Rec).providers as ProviderConfig[]) {
      strip.provider(p);
      at(p?.id ? { kind: 'provider', providerId: p.id } : undefined);
    }
  } else if (lib && has('items')) {
    const what = LIBRARY_LABEL[lib] ?? 'Saved item';
    for (const i of (doc as Rec).items as Array<{ id: string; name?: string; data?: unknown }>) {
      strip.data('library', `${what} ${i?.name ?? i?.id}`, i?.data);
      at(i?.id ? { kind: 'saved', library: lib, itemId: i.id } : undefined);
    }
  } else if (k?.kind === 'dataset' && k.id) {
    strip.datasetFile(file, text);
    at({ kind: 'dataset', name: k.id });
  } else if (doc && typeof doc === 'object') {
    // any other JSON file (the Debugger rules, a hand-made file): read as data, so a secret-named property counts
    strip.data('file', file, doc);
    at(undefined);
  } else {
    strip.text(k?.kind === 'test' ? 'test' : 'file', file, 'content', text);
    at(undefined);
  }
  return strip.replaced.map((r: ReplacedSecret, i) => {
    const confidence = strip.levels.get(i) ?? 'medium';
    const variable = r.variable.startsWith('{{') ? r.variable : `{{${r.variable}}}`;
    const ref = refs.get(i);
    return {
      file,
      kind: r.kind,
      item: r.item,
      field: r.field,
      variable,
      confidence,
      message: `${r.item} (${file}) has a ${confidence === 'high' ? 'secret' : 'probable secret'} typed into ${r.field}: use ${variable} and keep the value as a secret variable.`,
      ...(ref ? { ref } : {}),
    };
  });
}

/** The files in the index that a commit would take (added, copied, modified, renamed), workspace-relative. */
export async function stagedFiles(ws: string): Promise<string[]> {
  await requireRepo(ws);
  const out = await runGit(ws, ['diff', '--cached', '--relative', '--name-only', '-z', '--diff-filter=ACMR', '--', '.']);
  return out.split('\0').filter(Boolean);
}

/** Scan what is staged (the blobs in the index) with the one detector; see {@link StagedSecret}. */
export async function scanStagedSecrets(ws: string): Promise<StagedScan> {
  const repo = await requireRepo(ws);
  const staged = await stagedFiles(ws);
  const scan: StagedScan = { staged, blocking: [], confirm: [], skipped: [] };
  for (const file of staged) {
    if (isBinaryPath(file)) {
      scan.skipped.push(file);
      continue;
    }
    const inRepo = toRepoPath(repo, ws, file);
    const size = Number((await runGit(ws, ['cat-file', '-s', `:${inRepo}`]).catch(() => '0')).trim()) || 0;
    if (size > MAX_SCAN) {
      scan.skipped.push(file);
      continue;
    }
    const text = await runGit(ws, ['show', `:${inRepo}`]).catch(() => undefined);
    if (text === undefined || text.includes('\0')) {
      scan.skipped.push(file);
      continue;
    }
    for (const f of scanFileText(file, text)) (f.confidence === 'high' ? scan.blocking : scan.confirm).push(f);
  }
  return scan;
}

/** The commit's answer to a scan: refused (high), needs a confirmation (medium), or clear. */
export function commitVerdict(scan: StagedScan, confirmed = false): { allowed: boolean; reason?: 'blocked' | 'confirm' } {
  if (scan.blocking.length) return { allowed: false, reason: 'blocked' };
  if (scan.confirm.length && !confirmed) return { allowed: false, reason: 'confirm' };
  return { allowed: true };
}

export { isSecretReference };
