import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalText, normalizeText } from '../storage/stable-files.js';
import { atomicWrite, readJson } from '../storage/fsutil.js';
import { attributesText, ignoreText, installPreCommitHook, isInGitRepository } from '../storage/git-files.js';
import { collectionFileContent, type WorkspaceStore } from '../storage/workspace.js';
import type { Collection } from '../model/types.js';
import { gitSetupMergeDriver, gitVersion, runGit } from './git.js';
import { workspaceFile } from './item-address.js';
import { beginJournal } from './journal.js';
import { findLargeFiles, type LargeFile } from './large-files.js';
import { gitSetupTextconv } from './textconv.js';

/**
 * Fix git setup (release C of planning/git-everything.md §4d): one guided, previewed and undoable action that makes a
 * workspace ready for git, and says what it did. It is the successor of "Make ready for git":
 *
 *  1. `.gitignore`: results and this computer's state stay out (runs, traces, baselines, capture sessions …).
 *  2. `.gitattributes`: one line-ending policy (`* text=auto eol=lf`), binary files, the merge driver (`merge=testpion`) and the
 *     readable-diff driver (`diff=testpion`) on every JSON kind. Lines the user wrote stay; an attribute they set differently
 *     stays theirs.
 *  3. The drivers in this repository's config (`merge.testpion`, `diff.testpion`), pointing at this app or this CLI.
 *  4. Existing files rewritten into the stable form once (fixed key order, no save counter or time, LF, one final newline): one
 *     tidy commit, and from then on a file changes only when what people wrote changes.
 *  5. Optionally the pre-commit secret check, and files git tracks that the ignore rules say should not be (`git rm --cached`).
 *  It also reports, without acting: files over the size policy (LFS / by reference), and documents with CRLF line endings.
 *
 * Idempotent. Without git installed or outside a repository the file steps still run and the rest says what is missing. Every
 * file it writes is copied aside first (git/journal.ts), so `testpion git undo` and the app's Undo put them back; the git
 * config and the hook are left (they only register TestPion's drivers).
 */
export interface GitFixOptions {
  /** Plan only: change nothing. */
  dryRun?: boolean;
  /** The command git runs as the merge driver (without the file arguments); omitted: the driver is not touched. */
  mergeDriverCommand?: string;
  /** The command git runs as the diff driver's textconv (the file is appended); omitted: not touched. */
  textconvCommand?: string;
  /** Also install the pre-commit secret check; `cli` is the command the hook calls when `testpion` is not on the PATH. */
  hook?: boolean | { cli?: string };
  /** `git rm --cached` the files git tracks that the ignore rules ignore. */
  untrack?: boolean;
}

export type GitFixStepId = 'gitignore' | 'gitattributes' | 'merge-driver' | 'diff-driver' | 'stable-format' | 'line-endings' | 'hook' | 'untrack' | 'repository' | 'large-files' | 'crlf-documents';

export interface GitFixStep {
  id: GitFixStepId;
  title: string;
  /** What it would do / did, in words (lines added, files rewritten …). */
  detail: string[];
  /** Workspace files it writes. */
  files: string[];
  /** `todo`: needed and done by this action; `advice`: reported, done by the person; `skipped`: could not be done here (the detail says why). */
  state: 'todo' | 'advice' | 'skipped';
}

export interface GitFixRewrite {
  file: string;
  reason: 'stable-format' | 'line-endings';
  lines: { before: number; after: number };
}

export interface GitFixResult {
  dryRun: boolean;
  /** Something was written or configured (false: a dry run, or nothing to do). */
  applied: boolean;
  /** There was something to do (a dry run: there would be). */
  changed: boolean;
  gitAvailable: boolean;
  inRepository: boolean;
  steps: GitFixStep[];
  /** Every workspace file written (a dry run: that would be). */
  files: string[];
  rewritten: GitFixRewrite[];
  /** Files over the size policy: for the LFS / by-reference offer. */
  largeFiles: LargeFile[];
  /** Files that could not be read as their kind and were left alone. */
  problems: string[];
  undoId?: string;
  message: string;
}

const lines = (t: string) => (t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0));
const MAX_UNTRACK_LIST = 200;

/** Every file whose stable form is a rule: the JSON kinds the app writes and the test files. `collections` are handled apart. */
function candidates(root: string): string[] {
  const out: string[] = [];
  const list = (dir: string, ok: (f: string) => boolean, deep = false) => {
    const abs = join(root, dir);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && deep && !e.name.startsWith('.')) list(`${dir}/${e.name}`, ok, deep);
      else if (e.isFile() && ok(e.name)) out.push(`${dir}/${e.name}`);
    }
  };
  list('environments', (f) => f.endsWith('.json'));
  list('library', (f) => f.endsWith('.json'));
  list('tests', (f) => /\.ya?ml$/i.test(f), true);
  for (const f of ['workspace.json', 'mcp-servers.json', 'providers.json', 'debugger/rules.json']) if (existsSync(join(root, f))) out.push(f);
  return out;
}

async function configured(ws: string, key: string): Promise<string | undefined> {
  return runGit(ws, ['config', '--local', '--get', key]).then((v) => v.trim() || undefined, () => undefined);
}

/** Documents with CRLF line endings (a count: they are user text, never rewritten): specs, protos, packages, mocks, datasets under 2 MB. */
function crlfDocuments(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory() && !e.name.startsWith('.')) walk(rel);
      else if (e.isFile() && /\.(ya?ml|json|proto|js|csv|tsv|md|jsonl)$/i.test(e.name) && statSync(join(root, rel)).size < 2 * 1024 * 1024 && readFileSync(join(root, rel), 'utf8').includes('\r\n')) out.push(rel);
    }
  };
  for (const d of ['specs', 'protos', 'packages', 'mocks', 'datasets']) walk(d);
  return out;
}

export async function fixGitSetup(store: WorkspaceStore, o: GitFixOptions = {}): Promise<GitFixResult> {
  const root = store.root;
  const dryRun = !!o.dryRun;
  const gitAvailable = !!(await gitVersion());
  const inRepository = gitAvailable && isInGitRepository(root);
  const steps: GitFixStep[] = [];
  const writes = new Map<string, string>();
  const rewritten: GitFixRewrite[] = [];
  const problems: string[] = [];

  // 1-2: the ignore and attribute files
  const read = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
  const gi = ignoreText(read('.gitignore'));
  if (gi !== undefined) {
    writes.set('.gitignore', gi);
    const had = new Set(read('.gitignore').split(/\r?\n/).map((l) => l.trim()));
    steps.push({ id: 'gitignore', title: 'Keep results and this computer\'s state out of git', detail: gi.split('\n').filter((l) => l && !l.startsWith('#') && !had.has(l.trim())).map((l) => `ignore ${l}`), files: ['.gitignore'], state: 'todo' });
  }
  const ga = attributesText(read('.gitattributes'));
  if (ga !== undefined) {
    writes.set('.gitattributes', ga);
    const had = read('.gitattributes').split(/\r?\n/).map((l) => l.trim());
    steps.push({ id: 'gitattributes', title: 'Line endings, merge and diff drivers for every JSON kind', detail: ga.split('\n').filter((l) => l && !l.startsWith('#') && !had.includes(l.trim())).map((l) => l.trim()), files: ['.gitattributes'], state: 'todo' });
  }

  // 4: the stable form, once
  const tidyCollections: string[] = [];
  const dir = store.path('collections');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    const rel = `collections/${f}`;
    let raw: Collection;
    try {
      raw = readJson<Collection>(join(dir, f));
    } catch {
      problems.push(`${rel} is not valid JSON: left alone`);
      continue;
    }
    const text = readFileSync(join(dir, f), 'utf8');
    const tidy = JSON.stringify(collectionFileContent(raw), null, 2) + '\n';
    if (text === tidy) continue;
    tidyCollections.push(rel);
    rewritten.push({ file: rel, reason: normalizeText(text) === tidy ? 'line-endings' : 'stable-format', lines: { before: lines(text), after: lines(tidy) } });
  }
  for (const rel of candidates(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const next = canonicalText(rel, text);
    if (next === undefined) {
      if (/\.json$/i.test(rel)) problems.push(`${rel} is not valid JSON: left alone`);
      continue;
    }
    if (next === text) continue;
    writes.set(rel, next);
    rewritten.push({ file: rel, reason: normalizeText(text) === next ? 'line-endings' : 'stable-format', lines: { before: lines(text), after: lines(next) } });
  }
  if (rewritten.length) {
    const lineEndings = rewritten.filter((r) => r.reason === 'line-endings').length;
    steps.push({
      id: 'stable-format',
      title: 'Write existing files in the stable format (once)',
      detail: [
        `${rewritten.length} file${rewritten.length === 1 ? '' : 's'}: fixed key order, no save counter or time, LF line endings${lineEndings ? ` (${lineEndings} only change line endings)` : ''}`,
        'commit the result on its own ("TestPion: stable files"), so later changes are real changes',
      ],
      files: rewritten.map((r) => r.file),
      state: 'todo',
    });
  }

  // 3: the drivers in the repository's config
  const drivers: Array<{ id: GitFixStepId; key: string; want: string; title: string; set(): Promise<void> }> = [];
  if (inRepository && o.mergeDriverCommand)
    drivers.push({ id: 'merge-driver', key: 'merge.testpion.driver', want: `${o.mergeDriverCommand} %O %A %B %P`, title: 'Merge collections, environments and lists item by item', set: () => gitSetupMergeDriver(root, o.mergeDriverCommand!) });
  if (inRepository && o.textconvCommand)
    drivers.push({ id: 'diff-driver', key: 'diff.testpion.textconv', want: o.textconvCommand, title: 'Show git diff item by item (readable-diff driver)', set: () => gitSetupTextconv(root, o.textconvCommand!) });
  const pending: typeof drivers = [];
  for (const d of drivers) if ((await configured(root, d.key)) !== d.want) pending.push(d);
  for (const d of pending) steps.push({ id: d.id, title: d.title, detail: [`git config ${d.key}`], files: [], state: 'todo' });

  // hook, tracked-but-ignored, repository
  let installHook = false;
  if (o.hook && !inRepository) steps.push({ id: 'hook', title: 'Pre-commit secret check', detail: ['needs a git repository first'], files: [], state: 'skipped' });
  else if (o.hook) {
    // where git keeps hooks (a worktree or a configured hooksPath is elsewhere); done when the hook there is TestPion's
    const hook = resolve(root, (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit']).catch(() => '')).trim() || '.git/hooks/pre-commit');
    const ours = existsSync(hook) && readFileSync(hook, 'utf8').includes('# testpion-secret-guard');
    const foreign = existsSync(hook) && !ours;
    installHook = !ours && !foreign;
    if (foreign) steps.push({ id: 'hook', title: 'Pre-commit secret check', detail: [`a pre-commit hook of yours exists: add  testpion git check  to it (it is never overwritten)`], files: [], state: 'advice' });
    else if (!ours) steps.push({ id: 'hook', title: 'Refuse a commit that would publish a secret (pre-commit hook)', detail: ['a hook of yours is never overwritten'], files: [], state: 'todo' });
  }
  let tracked: string[] = [];
  if (inRepository) {
    tracked = (await runGit(root, ['ls-files', '-ci', '--exclude-standard', '-z', '--', '.']).catch(() => '')).split('\0').filter(Boolean);
    if (tracked.length)
      steps.push({
        id: 'untrack',
        title: 'Files git tracks that should stay out of git',
        detail: [...tracked.slice(0, 8), ...(tracked.length > 8 ? [`… ${tracked.length - 8} more`] : []), o.untrack ? 'removed from git (the files stay on disk)' : 'testpion git fix --untrack removes them from git (the files stay on disk)'],
        files: [],
        state: o.untrack ? 'todo' : 'advice',
      });
  } else if (gitAvailable) steps.push({ id: 'repository', title: 'Put the workspace under git', detail: [`run  git init  in ${root}`], files: [], state: 'advice' });
  else steps.push({ id: 'repository', title: 'Git is not installed', detail: ['Install Git from https://git-scm.com and restart TestPion; the files above are written either way'], files: [], state: 'skipped' });

  // advice: big files, CRLF documents
  const largeFiles = await findLargeFiles(root).catch(() => []);
  const big = largeFiles.filter((l) => l.level !== 'warn');
  if (big.length) steps.push({ id: 'large-files', title: 'Big files: Git LFS or track by reference', detail: big.map((l) => `${l.file} (${(l.bytes / 1048576).toFixed(0)} MB)`), files: [], state: 'advice' });
  const crlf = crlfDocuments(root);
  if (crlf.length) steps.push({ id: 'crlf-documents', title: 'Documents with CRLF line endings', detail: [`${crlf.length} file${crlf.length === 1 ? '' : 's'} (specs, datasets, scripts …): git now stores LF; run  git add --renormalize .  once to normalise them`], files: [], state: 'advice' });

  const files = [...new Set([...writes.keys(), ...tidyCollections])];
  const todo = steps.some((s) => s.state === 'todo');
  const base: Omit<GitFixResult, 'applied' | 'message' | 'undoId'> = { dryRun, changed: todo, gitAvailable, inRepository, steps, files, rewritten, largeFiles, problems };
  if (dryRun || !todo) {
    return { ...base, applied: false, message: todo ? `Would fix ${steps.filter((s) => s.state === 'todo').length} thing(s) (nothing was changed)` : steps.some((s) => s.state === 'advice') ? 'Nothing to fix by itself; see the advice' : 'Git setup is complete: nothing to fix' };
  }

  // apply: copy the files aside, then write
  const undo = files.length ? beginJournal(root, 'fix-setup', 'Fix git setup', files) : undefined;
  for (const [rel, text] of writes) atomicWrite(workspaceFile(root, rel), text);
  // collections go through the store (the save counter moves to .local/meta.json)
  for (const rel of tidyCollections) {
    const id = readJson<Collection>(join(root, rel)).id;
    store.saveCollection(store.getCollection(id));
  }
  if (writes.has('workspace.json')) store.reloadWorkspaceFile();
  for (const d of pending) await d.set();
  if (installHook) installPreCommitHook(root, typeof o.hook === 'object' ? o.hook.cli : undefined);
  if (o.untrack && tracked.length) for (let i = 0; i < tracked.length; i += MAX_UNTRACK_LIST) await runGit(root, ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...tracked.slice(i, i + MAX_UNTRACK_LIST)]);
  const did = steps.filter((s) => s.state === 'todo').map((s) => s.title);
  return {
    ...base,
    applied: true,
    ...(undo ? { undoId: undo.id } : {}),
    message: `Fixed git setup: ${did.length} step${did.length === 1 ? '' : 's'}${rewritten.length ? `, ${rewritten.length} file${rewritten.length === 1 ? '' : 's'} rewritten in the stable format` : ''}${undo ? '. Undo restores the files (the git config stays).' : ''}`,
  };
}
