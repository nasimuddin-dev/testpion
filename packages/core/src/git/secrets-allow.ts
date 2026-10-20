import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { stableText } from '../storage/stable-files.js';
import { beginJournal } from './journal.js';
import { workspaceFile } from './item-address.js';

/**
 * The allowlist of the staged secret scan (release C of planning/git-everything.md §4e): `.testpion/secrets-allow.json`
 * says, for one item, one rule and one value, "this is not a secret" (an example token in an API definition, a public
 * test key). It is explicit and reviewable:
 *  - it is committed, so a change to it is read in the pull request like any other file;
 *  - an entry names the file, the item, the field (the rule) and a fingerprint of the value, never the value, and says why;
 *  - the fingerprint covers the file, item and field as well as the value, so the same text somewhere else is still found,
 *    and a changed value is found again.
 * Nothing allows a whole file, a whole kind or a pattern.
 */
export const SECRETS_ALLOW_FILE = '.testpion/secrets-allow.json';

export interface SecretAllowEntry {
  file: string;
  /** The item in words, as the finding names it ("MCP server Weather"). */
  item: string;
  /** The field and rule, as the finding names them (`headers.X-Api-Key`, `content (stripe-key)`). */
  field: string;
  /** Fingerprint of the value (see {@link secretFingerprint}). */
  hash: string;
  /** Why it is not a secret: required, and read by whoever reviews the change. */
  reason: string;
}

interface AllowFile {
  schemaVersion: string;
  allow: SecretAllowEntry[];
}

/** A fingerprint of a value in its place: 32 hex digits of sha256 over file, item, field and value. The value is not recoverable from it. */
export const secretFingerprint = (file: string, item: string, field: string, value: string): string => createHash('sha256').update([file, item, field, value].join('\0')).digest('hex').slice(0, 32);

const byKey = (a: SecretAllowEntry, b: SecretAllowEntry) => (a.file + a.item + a.field + a.hash < b.file + b.item + b.field + b.hash ? -1 : 1);

/** The entries of the workspace's allowlist; an unreadable file allows nothing (and is reported by `problem`). */
export function readSecretsAllow(ws: string): { entries: SecretAllowEntry[]; problem?: string } {
  const file = workspaceFile(ws, SECRETS_ALLOW_FILE);
  if (!existsSync(file)) return { entries: [] };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<AllowFile>;
    const entries = (Array.isArray(doc.allow) ? doc.allow : []).filter(
      (e): e is SecretAllowEntry => !!e && typeof e.file === 'string' && typeof e.item === 'string' && typeof e.field === 'string' && typeof e.hash === 'string' && /^[0-9a-f]{32}$/.test(e.hash),
    );
    return { entries };
  } catch {
    return { entries: [], problem: `${SECRETS_ALLOW_FILE} is not valid JSON: nothing is allowed until it is fixed` };
  }
}

/** Whether an entry allows a finding (same file, item, field and value fingerprint). */
export const isAllowed = (entries: readonly SecretAllowEntry[], f: { file: string; item: string; field: string; hash: string }): boolean =>
  entries.some((e) => e.hash === f.hash && e.file === f.file && e.item === f.item && e.field === f.field);

export interface AllowResult {
  entry: SecretAllowEntry;
  /** Written (false: a dry run, or it was allowed already). */
  applied: boolean;
  undoId?: string;
}

/** Add an entry. A reason is required: the allowlist is read in review, and "why" is what the reviewer needs. */
export function allowSecret(ws: string, f: { file: string; item: string; field: string; hash: string }, reason: string, o: { dryRun?: boolean } = {}): AllowResult {
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw new ApsError('ValidationError', 'Say why this is not a secret (it is read in review)', { suggestions: ['For example: "public test key from the provider docs".'] });
  if (!/^[0-9a-f]{32}$/.test(f.hash)) throw new ApsError('ValidationError', 'The finding has no fingerprint: scan the staged files again');
  const entry: SecretAllowEntry = { file: f.file, item: f.item, field: f.field, hash: f.hash, reason: why };
  const { entries, problem } = readSecretsAllow(ws);
  if (problem) throw new ApsError('ConfigurationError', problem);
  if (isAllowed(entries, f)) return { entry, applied: false };
  if (o.dryRun) return { entry, applied: false };
  const undo = beginJournal(ws, 'allow-secret', `Allow ${f.item}: ${f.field}`, [SECRETS_ALLOW_FILE]);
  write(ws, [...entries, entry]);
  return { entry, applied: true, undoId: undo.id };
}

/** Take an entry out again (by its fingerprint). */
export function disallowSecret(ws: string, hash: string): { removed: number; undoId?: string } {
  const { entries, problem } = readSecretsAllow(ws);
  if (problem) throw new ApsError('ConfigurationError', problem);
  const keep = entries.filter((e) => !e.hash.startsWith(hash));
  if (keep.length === entries.length) return { removed: 0 };
  const undo = beginJournal(ws, 'disallow-secret', 'Stop allowing a value', [SECRETS_ALLOW_FILE]);
  write(ws, keep);
  return { removed: entries.length - keep.length, undoId: undo.id };
}

function write(ws: string, entries: SecretAllowEntry[]): void {
  const file = workspaceFile(ws, SECRETS_ALLOW_FILE);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, stableText({ schemaVersion: '1.0', allow: [...entries].sort(byKey) } satisfies AllowFile));
}
