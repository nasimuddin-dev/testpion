import { kindOfPath, libraryOfPath, LIBRARY_LABEL, type ItemRef } from '@testpion/shared';
import type { Collection, Environment, KeyValue, McpServerConfig, ProviderConfig } from '../model/types.js';
import { classifySecret, isSecretReference, type SecretConfidence } from '../security/secrets.js';
import { SecretStripper, type ReplacedSecret, type ReplacedSecretKind } from '../storage/bundle-secrets.js';
import { canonicalText } from '../storage/stable-files.js';
import { isBinaryPath } from './item-changes.js';
import { largeLevel, type LargeFile } from './large-files.js';
import { isAllowed, readSecretsAllow, secretFingerprint } from './secrets-allow.js';
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
  /** Fingerprint of the value in its place (never the value): what `.testpion/secrets-allow.json` names to allow it. */
  hash: string;
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
  /** Findings that `.testpion/secrets-allow.json` allows (explicitly, with a reason): shown, never blocking. */
  allowed: StagedSecret[];
  /** Staged files big enough for the size policy (a warning, an LFS offer, or a refusal at the host's limit). */
  large: LargeFile[];
  /** Said when the allowlist could not be read (then it allows nothing). */
  allowProblem?: string;
}

const SCHEME = /^(Bearer|Basic|Token|Digest|ApiKey)\s+/i;
const MAX_SCAN = 8 * 1024 * 1024;

/** The exports' stripper, told how sure each replacement is. */
class Scan extends SecretStripper {
  readonly levels = new Map<number, 'high' | 'medium'>();
  /**
   * When a fix runs: the values the allowlist allows are left as they are (and not reported), so fixing a file never
   * rewrites an example token somebody reviewed and allowed.
   */
  allow?: (item: string, field: string, value: string) => boolean;
  readonly dropped = new Set<number>();
  override swap(kind: ReplacedSecretKind, item: string, field: string, base: string, value: string): string {
    const i = this.replaced.length;
    const key = field.split('.').pop()!.replace(/\[.*$/, '');
    const c = classifySecret(key, value.replace(SCHEME, '')) ?? classifySecret(key, value);
    this.levels.set(i, c?.confidence === 'high' ? 'high' : 'medium');
    const out = super.swap(kind, item, field, base, value);
    if (this.allow?.(item, field, this.values[i]!)) {
      this.dropped.add(i);
      return value;
    }
    return out;
  }
  override text(kind: ReplacedSecretKind, item: string, field: string, s: string): string {
    const i = this.replaced.length;
    let out = super.text(kind, item, field, s);
    for (let j = i; j < this.replaced.length; j++) {
      this.levels.set(j, 'high');
      if (this.allow?.(this.replaced[j]!.item, this.replaced[j]!.field, this.values[j]!)) {
        // put the allowed value back where its replacement is
        out = out.replace(`{{${this.replaced[j]!.variable}}}`, () => this.values[j]!);
        this.dropped.add(j);
      }
    }
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

/**
 * One file read by its kind with the one detector: what it holds that is a secret, and the file as it would be with each of
 * them replaced by its `{{variable}}` (the cleaned text is the fix; `scanFileText` only reads the findings).
 */
export function stripFileText(
  file: string,
  text: string,
  o: { allow?: (item: string, field: string, value: string) => boolean; reserve?: Iterable<string> } = {},
): { findings: StagedSecret[]; text: string; values: string[]; replaced: ReplacedSecret[] } {
  const strip = new Scan();
  strip.allow = o.allow;
  if (o.reserve) strip.reserve(o.reserve);
  let cleaned: { value?: unknown; text?: string } = {};
  const refs = new Map<number, ItemRef | undefined>();
  const at = (ref?: ItemRef) => {
    for (let i = refs.size; i < strip.replaced.length; i++) refs.set(i, ref);
  };
  const k = kindOfPath(file, { raw: true });
  const lib = libraryOfPath(file, { raw: true });
  const doc = /\.json$/i.test(file) ? parse(text) : undefined;
  const has = (key: string): boolean => !!doc && typeof doc === 'object' && Array.isArray((doc as Rec)[key]);
  if (k?.kind === 'collection' && k.id && doc && typeof doc === 'object') {
    cleaned = { value: strip.collection(doc as Collection) };
    at({ kind: 'collection', collectionId: String((doc as Rec).id ?? k.id) });
  } else if (k?.kind === 'environment' && k.id && doc && typeof doc === 'object') {
    const e = doc as unknown as Environment;
    cleaned = { value: strip.environment(e) };
    at(e.id ? { kind: 'environment', environmentId: e.id } : undefined);
  } else if (k?.kind === 'workspace' && has('variables')) {
    cleaned = { value: { ...(doc as Rec), variables: strip.variables('workspace', 'workspace', (doc as Rec).variables as KeyValue[]) } };
    at({ kind: 'environment', scope: 'workspace' });
  } else if (k?.kind === 'mcp-server' && has('servers')) {
    const servers: unknown[] = [];
    for (const s of (doc as Rec).servers as McpServerConfig[]) {
      servers.push(s && typeof s === 'object' ? strip.mcpServer(s) : s);
      at(s?.id ? { kind: 'mcp-server', serverId: s.id } : undefined);
    }
    cleaned = { value: { ...(doc as Rec), servers } };
  } else if (k?.kind === 'provider' && has('providers')) {
    const providers: unknown[] = [];
    for (const p of (doc as Rec).providers as ProviderConfig[]) {
      providers.push(p && typeof p === 'object' ? strip.provider(p) : p);
      at(p?.id ? { kind: 'provider', providerId: p.id } : undefined);
    }
    cleaned = { value: { ...(doc as Rec), providers } };
  } else if (lib && has('items')) {
    const what = LIBRARY_LABEL[lib] ?? 'Saved item';
    const items: unknown[] = [];
    for (const i of (doc as Rec).items as Array<{ id: string; name?: string; data?: unknown }>) {
      const data = strip.data('library', `${what} ${i?.name ?? i?.id}`, i?.data);
      items.push(i && typeof i === 'object' && 'data' in i ? { ...i, data } : i);
      at(i?.id ? { kind: 'saved', library: lib, itemId: i.id } : undefined);
    }
    cleaned = { value: { ...(doc as Rec), items } };
  } else if (k?.kind === 'dataset' && k.id) {
    cleaned = { text: strip.datasetFile(file, text).text };
    at({ kind: 'dataset', name: k.id });
  } else if (doc && typeof doc === 'object') {
    // any other JSON file (the Debugger rules, a hand-made file): read as data, so a secret-named property counts
    cleaned = { value: strip.data('file', file, doc) };
    at(undefined);
  } else {
    cleaned = { text: strip.text(k?.kind === 'test' ? 'test' : 'file', file, 'content', text) };
    at(undefined);
  }
  const changed = strip.replaced.length > strip.dropped.size;
  // the file as the app writes it: a JSON kind in its stable form, a document as text
  const fixed = !changed ? text : (cleaned.text ?? canonicalText(file, JSON.stringify(cleaned.value)) ?? JSON.stringify(cleaned.value, null, 2) + '\n');
  const findings = strip.replaced.flatMap((r: ReplacedSecret, i): StagedSecret[] => {
    if (strip.dropped.has(i)) return [];
    const confidence = strip.levels.get(i) ?? 'medium';
    const variable = r.variable.startsWith('{{') ? r.variable : `{{${r.variable}}}`;
    const ref = refs.get(i);
    return [{
      file,
      kind: r.kind,
      item: r.item,
      field: r.field,
      variable,
      hash: secretFingerprint(file, r.item, r.field, strip.values[i] ?? ''),
      confidence,
      message: `${r.item} (${file}) has a ${confidence === 'high' ? 'secret' : 'probable secret'} typed into ${r.field}: use ${variable} and keep the value as a secret variable.`,
      ...(ref ? { ref } : {}),
    }];
  });
  return { findings, text: fixed, values: strip.values.filter((_, i) => !strip.dropped.has(i)), replaced: strip.replaced.filter((_, i) => !strip.dropped.has(i)) };
}

/** What one staged file holds, scanned by its kind. */
export function scanFileText(file: string, text: string): StagedSecret[] {
  return stripFileText(file, text).findings;
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
  const scan: StagedScan = { staged, blocking: [], confirm: [], skipped: [], allowed: [], large: [] };
  const allow = readSecretsAllow(ws);
  if (allow.problem) scan.allowProblem = allow.problem;
  for (const file of staged) {
    const inRepo = toRepoPath(repo, ws, file);
    // the size of the staged blob (an LFS pointer is small, so a file that is tracked by LFS is never "large")
    const size = Number((await runGit(ws, ['cat-file', '-s', `:${inRepo}`]).catch(() => '0')).trim()) || 0;
    const level = largeLevel(size);
    if (level) scan.large.push({ file, bytes: size, level });
    if (isBinaryPath(file) || size > MAX_SCAN) {
      scan.skipped.push(file);
      continue;
    }
    const text = await runGit(ws, ['show', `:${inRepo}`]).catch(() => undefined);
    if (text === undefined || text.includes('\0')) {
      scan.skipped.push(file);
      continue;
    }
    for (const f of scanFileText(file, text)) {
      if (isAllowed(allow.entries, { file: f.file, item: f.item, field: f.field, hash: f.hash })) scan.allowed.push(f);
      else (f.confidence === 'high' ? scan.blocking : scan.confirm).push(f);
    }
  }
  return scan;
}

/**
 * The commit's answer to a scan: refused (a certain secret, or a file past the host's hard limit), needs a confirmation
 * (a probable secret), or clear.
 */
export function commitVerdict(scan: StagedScan, confirmed = false): { allowed: boolean; reason?: 'blocked' | 'confirm' | 'too-big' } {
  if (scan.blocking.length) return { allowed: false, reason: 'blocked' };
  if (scan.large.some((l) => l.level === 'refuse')) return { allowed: false, reason: 'too-big' };
  if (scan.confirm.length && !confirmed) return { allowed: false, reason: 'confirm' };
  return { allowed: true };
}

export { isSecretReference };
