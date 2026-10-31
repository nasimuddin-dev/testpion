/**
 * What your team changed lately, by meaning: the commits other people made to this workspace in the last days, each with the items it
 * changed in words ("Payments ▸ Create invoice: URL, headers"), newest first. It is the Home card "Your team's changes", `testpion git
 * activity` and the RPC `git.teamActivity`. It reads history only (log and the same item-by-item diff the Git view uses): nothing is written.
 */
import { runGit } from './git.js';
import { describeRevChanges, type SemanticChange } from './semantic.js';

/** git's empty tree: the "parent" of a first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface TeamChange {
  change: SemanticChange['change'];
  /** "Payments ▸ Create invoice", "environment Staging". */
  title: string;
  /** "URL", "2 headers" … */
  details: string[];
  kind: SemanticChange['kind'];
  ref?: SemanticChange['ref'];
}

export interface TeamCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  /** The first changes of the commit, by meaning (at most 6). */
  changes: TeamChange[];
  /** How many more changed beyond those listed. */
  more: number;
}

export interface TeamActivity {
  /** The git identity of this computer (user.email), whose commits are left out. */
  me?: string;
  days: number;
  commits: TeamCommit[];
  /** One sentence: "3 commits by 2 people in the last 14 days." */
  text: string;
}

const MAX_CHANGES = 6;

/** The commits others made to the workspace in the last `days` days (default 14), newest first, at most `limit` (default 8). */
export async function teamActivity(ws: string, o: { days?: number; limit?: number } = {}): Promise<TeamActivity> {
  const days = Math.min(Math.max(1, Math.floor(o.days ?? 14)), 365);
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? 8)), 50);
  const me = (await runGit(ws, ['config', '--get', 'user.email']).catch(() => '')).trim().toLowerCase() || undefined;
  let log = '';
  try {
    log = await runGit(ws, ['log', `--since=${days}.days.ago`, '--no-merges', `--max-count=${limit * 4}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e', '--', '.']);
  } catch {
    // no commits yet, or not a repository
  }
  const rows = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, email, date, subject] = r.split('\x1f');
      return { hash: hash!, short: short!, author: author!, email: (email ?? '').toLowerCase(), date: date!, subject: subject ?? '' };
    })
    .filter((c) => !me || c.email !== me)
    .slice(0, limit);
  const commits: TeamCommit[] = [];
  for (const c of rows) {
    let changes: SemanticChange[] = [];
    try {
      const hasParent = (await runGit(ws, ['rev-parse', '--verify', '--quiet', `${c.hash}^`]).catch(() => '')).trim() !== '';
      changes = await describeRevChanges(ws, hasParent ? `${c.hash}^` : EMPTY_TREE, c.hash);
    } catch {
      // a commit whose diff cannot be read is still listed, without its changes
    }
    commits.push({
      hash: c.hash,
      short: c.short,
      author: c.author,
      date: c.date,
      subject: c.subject,
      changes: changes.slice(0, MAX_CHANGES).map((x) => ({ change: x.change, title: x.title, details: x.details, kind: x.kind, ...(x.ref ? { ref: x.ref } : {}) })),
      more: Math.max(0, changes.length - MAX_CHANGES),
    });
  }
  const people = new Set(commits.map((c) => c.author));
  const text = commits.length
    ? `${commits.length} commit${commits.length === 1 ? '' : 's'} by ${people.size} ${people.size === 1 ? 'person' : 'people'} in the last ${days} days.`
    : `Nobody else has changed this workspace in the last ${days} days.`;
  return { ...(me ? { me } : {}), days, commits, text };
}

export interface IncomingChanges {
  /** The branch the commits come from ("origin/main"). */
  upstream: string;
  /** The commits on it that this branch does not have yet, newest first. */
  commits: Array<{ hash: string; short: string; author: string; date: string; subject: string }>;
  /** What they change, by meaning, against the point the two branches split (so your own commits are not in it). */
  changes: TeamChange[];
  more: number;
  /** "2 commits by 1 person change 3 items: Search: URL · …" or "Nothing is waiting on origin/main." */
  text: string;
}

/**
 * What a pull would bring in, before it is pulled: the commits the upstream has and this branch has not, and what they change item by
 * item (the same words as the Git view). Nothing is fetched or written: it reads what the last fetch left.
 */
export async function incomingChanges(ws: string, o: { limit?: number } = {}): Promise<IncomingChanges | undefined> {
  const upstream = (await runGit(ws, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
  if (!upstream) return undefined;
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? 20)), 100);
  const log = await runGit(ws, ['log', `HEAD..${upstream}`, `--max-count=${limit}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e']).catch(() => '');
  const commits = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, date, subject] = r.split('\x1f');
      return { hash: hash!, short: short!, author: author!, date: date!, subject: subject ?? '' };
    });
  if (!commits.length) return { upstream, commits: [], changes: [], more: 0, text: `Nothing is waiting on ${upstream}.` };
  const base = (await runGit(ws, ['merge-base', 'HEAD', upstream]).catch(() => '')).trim();
  let all: SemanticChange[] = [];
  try {
    all = await describeRevChanges(ws, base || EMPTY_TREE, commits[0]!.hash);
  } catch {
    // a diff that cannot be read: the commits are still listed
  }
  const changes = all.slice(0, 12).map((x) => ({ change: x.change, title: x.title, details: x.details, kind: x.kind, ...(x.ref ? { ref: x.ref } : {}) }));
  const people = new Set(commits.map((c) => c.author));
  const text = `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} by ${people.size} ${people.size === 1 ? 'person' : 'people'}${all.length ? ` change ${all.length} ${all.length === 1 ? 'item' : 'items'}: ${changes.slice(0, 3).map((c) => `${c.title}${c.details.length ? `: ${c.details.slice(0, 2).join(', ')}` : ''}`).join(' · ')}${all.length > 3 ? ' …' : ''}` : ''}.`;
  return { upstream, commits, changes, more: Math.max(0, all.length - changes.length), text };
}
