/**
 * Who owns an item, for a workspace several teams share: the owners CODEOWNERS names for the file that holds it (the
 * last matching rule wins, as GitHub reads the file), and who last changed that file in git. The Info panel, `ref_info`,
 * `testpion item owners` and a Needs-attention line (*@payments-team: monitor "Checkout" is failing*) read them here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitLog, repoRoot, toRepoPath } from './git.js';

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

const PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** The rules of the repository's CODEOWNERS, in file order (comments and empty lines left out); none without the file. */
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({ pattern, owners: owners.filter((o) => o.startsWith('@') || o.includes('@')) });
  }
  return rules;
}

/** A CODEOWNERS pattern as a regular expression over a repository-relative path (gitignore-like, as GitHub matches it). */
function patternRegex(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/');
  const dirOnly = p.endsWith('/');
  p = p.replace(/^\//, '').replace(/\/$/, '');
  const body = p
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  const hasSlash = pattern.replace(/\/$/, '').includes('/');
  const start = anchored || hasSlash ? '^' : '(^|/)';
  const end = dirOnly ? '(/|$)' : '($|/)';
  return new RegExp(`${start}${body}${end}`);
}

/** The owners of a repository-relative path: the last matching rule's. */
export function ownersOf(rules: OwnerRule[], repoPath: string): string[] {
  let found: string[] = [];
  const path = repoPath.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const r of rules) if (patternRegex(r.pattern).test(path)) found = r.owners;
  return found;
}

/** The CODEOWNERS rules of the repository the workspace is in, from where GitHub reads them; none when there is no file. */
export async function workspaceCodeowners(ws: string): Promise<{ repo: string; rules: OwnerRule[] } | undefined> {
  const repo = await repoRoot(ws);
  if (!repo) return undefined;
  const place = PLACES.map((p) => join(repo, p)).find((p) => existsSync(p));
  if (!place) return undefined;
  try {
    return { repo, rules: parseCodeowners(readFileSync(place, 'utf8')) };
  } catch {
    return undefined;
  }
}

export interface Ownership {
  /** The workspace file the owners are read for. */
  file: string;
  /** From CODEOWNERS; empty when no rule names the file (or there is no file). */
  owners: string[];
  /** Who last changed the file in git, when it has a commit. */
  lastChange?: { author: string; date: string; subject: string; short: string };
}

/** Owners and the last change of a workspace file (`collections/payments.json`, `tests/smoke.yaml`). */
export async function ownershipOf(ws: string, file: string, codeowners?: Awaited<ReturnType<typeof workspaceCodeowners>>): Promise<Ownership> {
  const co = codeowners === undefined ? await workspaceCodeowners(ws) : codeowners;
  const owners = co ? ownersOf(co.rules, toRepoPath(co.repo, ws, file)) : [];
  const last = (await gitLog(ws, { path: file, limit: 1 }))[0];
  return { file, owners, ...(last ? { lastChange: { author: last.author, date: last.date, subject: last.subject, short: last.short } } : {}) };
}
