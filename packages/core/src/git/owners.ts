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
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // the pattern ends at the first space that is not escaped (`path\ with\ spaces` is one pattern); it is kept as written
    let end = 0;
    while (end < line.length && !/\s/.test(line[end]!)) end += line[end] === '\\' && end + 1 < line.length ? 2 : 1;
    const pattern = line.slice(0, end);
    const owners = line
      .slice(end)
      .replace(/(^|\s)#.*$/, '')
      .trim()
      .split(/\s+/)
      .filter((o) => o.startsWith('@') || o.includes('@'));
    rules.push({ pattern, owners });
  }
  return rules;
}

/** One path segment of a pattern as a regular expression: `*` and `?` stay inside the segment, `\x` is x itself, the rest is literal. */
function segmentRegex(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '\\' && i + 1 < segment.length) out += segment[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '*') {
      while (segment[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * A CODEOWNERS pattern as a regular expression over a repository-relative path, as GitHub matches it (gitignore-like,
 * with GitHub's differences):
 * - a leading `/`, or a `/` inside the pattern, ties it to the repository root; a bare name (`*.js`, `apps/`) matches at any depth;
 * - a name matches the file or the folder of that name with everything in it; a trailing `/` only the folder;
 * - a last segment `*` (`docs/*`, `/tests/*`) matches the direct children only, never what is in a folder below;
 * - a segment of two stars is any number of folders, none included (two stars then `/logs` is also `logs`; `a`, two stars, `b`
 *   is also `a/b`); as the last segment it is everything inside the folder before it.
 */
function patternRegex(pattern: string): RegExp {
  const dirOnly = /(^|[^\\])\/$/.test(pattern) || pattern === '/';
  const segments = pattern.replace(/^\//, '').replace(/\/$/, '').split('/');
  const anchored = pattern.startsWith('/') || segments.length > 1;
  const last = segments.length - 1;
  let body = '';
  segments.forEach((s, i) => {
    if (s === '**') body += i === last ? '.*' : '(?:.*/)?';
    else body += segmentRegex(s) + (i < last ? '/' : '');
  });
  const end = segments[last] === '**' ? '' : !dirOnly && segments[last] === '*' ? '$' : '(/|$)';
  return new RegExp(`${anchored ? '^' : '(^|/)'}${body}${end}`);
}

/** The compiled patterns, by their text: the owners of every row of a list are asked for with the same few rules. */
const compiled = new Map<string, RegExp>(); // bounded: cleared above 2000 patterns
function regexOf(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    if (compiled.size >= 2000) compiled.clear();
    compiled.set(pattern, (re = patternRegex(pattern)));
  }
  return re;
}

/** The owners of a repository-relative path: the last matching rule's. */
export function ownersOf(rules: OwnerRule[], repoPath: string): string[] {
  let found: string[] = [];
  const path = repoPath.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const r of rules) if (regexOf(r.pattern).test(path)) found = r.owners;
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
