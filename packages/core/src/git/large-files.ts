import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { KIND_INFO, liveKinds, type KindId } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { attributesText, ignoreText } from '../storage/git-files.js';
import { stableText } from '../storage/stable-files.js';
import { runGit } from './git.js';
import { gitPathOf, workspaceFile } from './item-address.js';
import { beginJournal } from './journal.js';
import { requireRepo } from './item-ops.js';

/**
 * Big files in the repository (release C of planning/git-everything.md §4f). GitHub warns at 50 MiB and rejects 100 MiB; a
 * dataset of tens of megabytes also makes every clone slower for everyone. The policy is the registry's (`size` of the
 * dataset kind), with one answer per level:
 *  - `warn` (5 MB): said in the commit panel; nothing changes.
 *  - `lfs` (50 MB): offered a way out. Either **Git LFS** (`.gitattributes` gets `filter=lfs` for the file: the repository
 *    keeps a small pointer, the data lives on the LFS server), or **by reference** (a `datasets/x.csv.ref` file with the size and
 *    checksum is committed, the data file is git-ignored and each person gets it where the team keeps it).
 *  - `refuse` (100 MB): a commit that would take the file is refused (GitHub would reject the push), until one of the above.
 */
export type LargeLevel = 'warn' | 'lfs' | 'refuse';

const MB = 1024 * 1024;
const POLICY = KIND_INFO.dataset.size ?? {};
export const LARGE_WARN_BYTES = POLICY.gitWarnBytes ?? 5 * MB;
export const LARGE_LFS_BYTES = POLICY.gitLfsBytes ?? 50 * MB;
export const LARGE_REFUSE_BYTES = POLICY.gitRefuseBytes ?? 100 * MB;

export const largeLevel = (bytes: number): LargeLevel | undefined => (bytes >= LARGE_REFUSE_BYTES ? 'refuse' : bytes >= LARGE_LFS_BYTES ? 'lfs' : bytes >= LARGE_WARN_BYTES ? 'warn' : undefined);

export interface LargeFile {
  file: string;
  bytes: number;
  level: LargeLevel;
  kind?: KindId;
}

/* ------------------------------------------------------------------ finding them */

/** The folders of the kinds that keep raw documents (datasets, API definitions, protos …): where big files come from. */
const RAW_DIRS = (): string[] => [...new Set(liveKinds().flatMap((k) => (k.storage.layout === 'raw-document' ? [k.storage.dir] : [])))];

function walk(dir: string, root: string, out: Array<{ file: string; bytes: number }>, min: number) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out, min);
    else if (e.isFile()) {
      const bytes = statSync(p).size;
      if (bytes >= min) out.push({ file: relative(root, p).split(sep).join('/'), bytes });
    }
  }
}

/**
 * Files in the workspace's document folders at or over `minBytes` (default: the warning size) that git would take: those
 * the repository ignores (a dataset kept by reference) and those LFS already covers are left out.
 */
export async function findLargeFiles(ws: string, o: { minBytes?: number } = {}): Promise<LargeFile[]> {
  const found: Array<{ file: string; bytes: number }> = [];
  for (const d of RAW_DIRS()) walk(join(ws, d), ws, found, o.minBytes ?? LARGE_WARN_BYTES);
  if (!found.length) return [];
  let keep = found;
  try {
    await requireRepo(ws);
    const ignored = new Set(
      (await runGit(ws, ['check-ignore', '-z', '--stdin'], { input: found.map((f) => f.file).join('\0') }).catch(() => '')).split('\0').filter(Boolean),
    );
    keep = found.filter((f) => !ignored.has(f.file));
    const lfs = await lfsCovered(ws, keep.map((f) => f.file));
    keep = keep.filter((f) => !lfs.has(f.file));
  } catch {
    /* not in a repository (or no git): every big file is listed; there is nothing to be ignored or tracked yet */
  }
  return keep
    .flatMap((f): LargeFile[] => {
      const level = largeLevel(f.bytes);
      return level ? [{ ...f, level }] : [];
    })
    .sort((a, b) => b.bytes - a.bytes);
}

/** The files of a list that .gitattributes puts under Git LFS. */
async function lfsCovered(ws: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const out = await runGit(ws, ['check-attr', '-z', '--stdin', 'filter'], { input: files.join('\0') }).catch(() => '');
  const parts = out.split('\0');
  const covered = new Set<string>();
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'lfs') covered.add(parts[i]!);
  return covered;
}

/** Whether Git LFS is installed (`git lfs version`). */
export async function lfsAvailable(ws: string): Promise<boolean> {
  return runGit(ws, ['lfs', 'version']).then(
    () => true,
    () => false,
  );
}

/* ------------------------------------------------------------------ the two ways out */

export interface LargePlan {
  file: string;
  mode: 'lfs' | 'reference';
  bytes: number;
  /** Workspace files the action writes. */
  writes: string[];
  /** The file is in git now, and leaves it (stays on disk) when applied. */
  untrack: boolean;
  /** What the person should know, in words. */
  notes: string[];
}

export interface LargeResult extends LargePlan {
  applied: boolean;
  undoId?: string;
  /** For `reference`: the reference file's content. */
  reference?: DatasetReference;
}

/** A pattern for .gitattributes / .gitignore that names exactly this path (glob characters escaped; a path with spaces quoted for attributes). */
const escapePattern = (p: string) => p.replace(/[\\*?[\]]/g, (c) => `\\${c}`).replace(/^([!#])/, '\\$1');
const attributePattern = (p: string) => (/\s/.test(p) ? `"${escapePattern(p).replace(/"/g, '\\"')}"` : escapePattern(p));
const ignorePattern = (p: string) => escapePattern(p).replace(/ $/, '\\ ');

/** What is in the repository about a path: tracked (in the index) or not. */
async function isTracked(ws: string, file: string): Promise<boolean> {
  return (await runGit(ws, ['ls-files', '--error-unmatch', '--', file]).then(() => true, () => false)) as boolean;
}

function checkFile(ws: string, file: string): { rel: string; bytes: number } {
  const rel = gitPathOf(file);
  const abs = workspaceFile(ws, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new ApsError('ValidationError', `${rel} is not a file of the workspace`);
  return { rel, bytes: statSync(abs).size };
}

/** Track a big file with Git LFS: `.gitattributes` names it; what is committed from now on is a pointer. Needs git-lfs installed. */
export async function trackWithLfs(ws: string, file: string, o: { dryRun?: boolean } = {}): Promise<LargeResult> {
  const { rel, bytes } = checkFile(ws, file);
  await requireRepo(ws);
  if (!(await lfsAvailable(ws)))
    throw new ApsError('ConfigurationError', 'Git LFS is not installed on this computer', {
      suggestions: ['Install it from https://git-lfs.com and run `git lfs install` once, or track the file by reference instead (a small .ref file is committed, the data stays out of git).'],
    });
  const tracked = await isTracked(ws, rel);
  const notes = [
    `${rel} gets "filter=lfs diff=lfs merge=lfs -text" in .gitattributes: the repository keeps a pointer file, the data goes to the LFS server on push.`,
    ...(tracked ? ['The file is in git history as a plain blob already: old commits keep it (git lfs migrate import rewrites history; TestPion does not).'] : []),
    'Everyone who clones needs git-lfs installed.',
  ];
  const plan: LargePlan = { file: rel, mode: 'lfs', bytes, writes: ['.gitattributes'], untrack: false, notes };
  if (o.dryRun) return { ...plan, applied: false };
  const attrs = workspaceFile(ws, '.gitattributes');
  const undo = beginJournal(ws, 'lfs', `Track ${rel} with Git LFS`, ['.gitattributes']);
  const had = existsSync(attrs) ? readFileSync(attrs, 'utf8') : '';
  const next = attributesText(had, [`${attributePattern(rel)} filter=lfs diff=lfs merge=lfs -text`]);
  if (next !== undefined) atomicWrite(attrs, next);
  // a file already in the index is cleaned again, so the next commit takes its pointer
  if (tracked) await runGit(ws, ['add', '--renormalize', '--', rel]);
  return { ...plan, applied: true, undoId: undo.id };
}

export interface DatasetReference {
  schemaVersion: string;
  /** The data file's name (inside its folder). */
  name: string;
  bytes: number;
  sha256: string;
  /** Lines of text, for a text format (a hint for people; the checksum is what verifies). */
  rows?: number;
  /** Where the team keeps the data (a URL, a bucket, a network path): free text, optional. */
  source?: string;
}

/** The checksum of a file, read in chunks (a 2 GB file does not fill the memory). */
export function sha256File(path: string): Promise<{ sha256: string; bytes: number; lines: number }> {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    let bytes = 0;
    let lines = 0;
    createReadStream(path)
      .on('data', (c) => {
        const b = c as Buffer;
        h.update(b);
        bytes += b.length;
        for (let i = 0; i < b.length; i++) if (b[i] === 10) lines++;
      })
      .on('error', fail)
      .on('end', () => done({ sha256: h.digest('hex'), bytes, lines }));
  });
}

/**
 * Track a big file by reference: `<file>.ref` (size, checksum, where to get it) is committed and the data file is git-ignored,
 * so the repository stays small and `testpion git large --check` says whether a computer has the right data. A file already in
 * git leaves the index (it stays on disk).
 */
export async function trackByReference(ws: string, file: string, o: { source?: string; dryRun?: boolean; untrack?: boolean } = {}): Promise<LargeResult> {
  const { rel, bytes } = checkFile(ws, file);
  const tracked = await isTracked(ws, rel).catch(() => false);
  const refFile = `${rel}.ref`;
  const writes = [refFile, '.gitignore'];
  const untrack = tracked && o.untrack !== false;
  const notes = [
    `${refFile} is committed with the size and checksum of ${rel}; ${rel} itself is added to .gitignore.`,
    'A teammate who pulls gets the reference and fetches the data from where you say (--source); `testpion git large --check` verifies it against the checksum.',
    ...(tracked ? ['The file is in git history already: old commits keep it.'] : []),
  ];
  const plan: LargePlan = { file: rel, mode: 'reference', bytes, writes, untrack, notes };
  const sum = await sha256File(workspaceFile(ws, rel));
  const name = rel.split('/').pop()!;
  const ref: DatasetReference = { schemaVersion: '1.0', name, bytes: sum.bytes, sha256: sum.sha256, ...(sum.lines && /\.(csv|tsv|jsonl|ndjson|md|txt)$/i.test(rel) ? { rows: sum.lines } : {}), ...(o.source ? { source: o.source } : {}) };
  if (o.dryRun) return { ...plan, applied: false, reference: ref };
  const undo = beginJournal(ws, 'reference', `Track ${rel} by reference`, writes);
  atomicWrite(workspaceFile(ws, refFile), stableText(ref));
  const ignoreFile = workspaceFile(ws, '.gitignore');
  const next = ignoreText(existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '', [ignorePattern(rel)]);
  if (next !== undefined) atomicWrite(ignoreFile, next);
  if (untrack) await runGit(ws, ['rm', '--cached', '--quiet', '--', rel]);
  return { ...plan, applied: true, undoId: undo.id, reference: ref };
}

export interface ReferenceCheck {
  /** The reference file. */
  ref: string;
  /** The data file it stands for. */
  file: string;
  state: 'ok' | 'missing' | 'different' | 'unreadable';
  expected?: { bytes: number; sha256: string; source?: string };
  actual?: { bytes: number; sha256?: string };
  message: string;
}

/** Every `*.ref` of the document folders against the data on this computer: present and matching, missing, or different. */
export async function checkReferences(ws: string): Promise<ReferenceCheck[]> {
  const refs: Array<{ file: string; bytes: number }> = [];
  for (const d of RAW_DIRS()) walk(join(ws, d), ws, refs, 0);
  const out: ReferenceCheck[] = [];
  for (const r of refs.filter((x) => x.file.endsWith('.ref'))) {
    const file = r.file.slice(0, -4);
    let ref: DatasetReference;
    try {
      ref = JSON.parse(readFileSync(join(ws, r.file), 'utf8')) as DatasetReference;
      if (typeof ref.sha256 !== 'string' || typeof ref.bytes !== 'number') throw new Error('not a reference');
    } catch {
      out.push({ ref: r.file, file, state: 'unreadable', message: `${r.file} is not a TestPion reference file` });
      continue;
    }
    const expected = { bytes: ref.bytes, sha256: ref.sha256, ...(ref.source ? { source: ref.source } : {}) };
    const abs = join(ws, file);
    if (!existsSync(abs)) {
      out.push({ ref: r.file, file, state: 'missing', expected, message: `${file} is not on this computer${ref.source ? `: get it from ${ref.source}` : ''}` });
      continue;
    }
    const size = statSync(abs).size;
    if (size !== ref.bytes) {
      out.push({ ref: r.file, file, state: 'different', expected, actual: { bytes: size }, message: `${file} has ${size} bytes; the reference says ${ref.bytes}` });
      continue;
    }
    const sum = await sha256File(abs);
    out.push(
      sum.sha256 === ref.sha256
        ? { ref: r.file, file, state: 'ok', expected, actual: { bytes: size, sha256: sum.sha256 }, message: `${file} matches its reference` }
        : { ref: r.file, file, state: 'different', expected, actual: { bytes: size, sha256: sum.sha256 }, message: `${file} has the right size but another checksum than its reference` },
    );
  }
  return out;
}

