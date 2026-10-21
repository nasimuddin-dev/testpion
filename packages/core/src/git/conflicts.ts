import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindOfPath, type KindId } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { repoRoot, runGit, toRepoPath } from './git.js';
import { matchEol, workspaceFile } from './item-address.js';
import { isBinaryPath } from './item-changes.js';
import { mergeModeOfPath, mergeWorkspaceTexts, requestParts, type FieldConflict, type MergeConflict, type MergeResolutions } from './merge.js';

/**
 * Merge conflicts of every kind (release B of planning/git-everything.md §4g). A file git could not merge is settled
 * by what it holds:
 *  - `items`: collections, environments, library files, MCP servers, AI providers, the workspace settings and the
 *    Debugger rules are merged by meaning (item by item, and field by field inside an item); only what both sides
 *    changed differently is a conflict, with the three versions side by side.
 *  - `text`: test and flow files, API definitions, mocks, packages, datasets … are text: the lines both sides changed
 *    differently are hunks (a hunk names the step or item it is in), the rest merged.
 *  - `binary`: a database or an image: one side, whole, with the sizes.
 * Each conflict is settled with Keep mine (ours), Keep theirs, or an edit; the result is written in the stable form.
 */

export type ConflictMode = 'items' | 'text' | 'binary';

export interface ConflictHunk {
  /** `hunk:<n>`: the key to settle it with. */
  key: string;
  /** Where it is, in words: "near step create-order", "line 14". */
  where: string;
  ours: string;
  base: string;
  theirs: string;
}

export interface ConflictField {
  /** The field of the item (`request.url`, `data.prompt`). */
  path: string;
  /** The key to settle it with: `<item key>#<path>`. */
  key: string;
  base?: string;
  ours?: string;
  theirs?: string;
  /** Each side as JSON, to start an edit from. */
  oursJson?: string;
  theirsJson?: string;
}

type Part = { part: string; base?: string; ours?: string; theirs?: string; differs: boolean };

export interface ConflictDetail {
  path: string;
  mode: ConflictMode;
  kind?: KindId;
  items: Array<Omit<MergeConflict, 'base' | 'ours' | 'theirs' | 'fields'> & { parts: Part[]; fields?: ConflictField[]; /** The item as JSON, to start an edit from (ours). */ editable?: string }>;
  hunks: ConflictHunk[];
  /** For `binary`: the size of each side in bytes. */
  sizes?: { ours?: number; theirs?: number };
}

/** The three versions of a conflicted file: the common ancestor, ours, theirs (empty when a side has none). */
async function conflictStages(ws: string, path: string): Promise<[string, string, string]> {
  const repo = await repoRoot(ws);
  const inRepo = repo ? toRepoPath(repo, ws, path) : path;
  const stage = (n: 1 | 2 | 3) => runGit(ws, ['show', `:${n}:${inRepo}`]).catch(() => '');
  return Promise.all([stage(1), stage(2), stage(3)]);
}

const asText = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/* ------------------------------------------------------------------ text hunks */

type Segment = { text: string } | { ours: string; base: string; theirs: string; line: number };

/** `git merge-file --diff3` on the three versions: the text with what merged cleanly, and the hunks that did not. */
function mergeSegments(base: string, ours: string, theirs: string): Segment[] {
  const dir = mkdtempSync(join(tmpdir(), 'tp-merge-'));
  try {
    const [b, o, t] = ['base', 'ours', 'theirs'].map((n) => join(dir, n));
    writeFileSync(b!, base);
    writeFileSync(o!, ours);
    writeFileSync(t!, theirs);
    const r = spawnSync('git', ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', o!, b!, t!], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw new ApsError('ConfigurationError', (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed' : r.error.message);
    if (r.status === null || r.status < 0 || r.status > 127) throw new ApsError('ConfigurationError', `git merge-file failed: ${(r.stderr ?? '').trim()}`);
    const lines = (r.stdout ?? '').split(/(?<=\n)/);
    const out: Segment[] = [];
    let text = '';
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.startsWith('<<<<<<< ')) {
        text += lines[i];
        line++;
        continue;
      }
      if (text) out.push({ text });
      text = '';
      const parts: Record<'ours' | 'base' | 'theirs', string> = { ours: '', base: '', theirs: '' };
      let into: 'ours' | 'base' | 'theirs' = 'ours';
      const at = line;
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.startsWith('||||||| ')) into = 'base';
        else if (l.startsWith('=======') && (l === '=======\n' || l === '=======\r\n' || l === '=======')) into = 'theirs';
        else if (l.startsWith('>>>>>>> ')) break;
        else parts[into] += l;
      }
      out.push({ ...parts, line: at });
      line += parts.ours.split('\n').length - 1;
    }
    if (text) out.push({ text });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The step or item a line of a YAML / text file is in: the nearest `id:` / `name:` above it. */
function whereIn(oursText: string, line: number): string {
  const lines = oursText.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = /^\s*(?:-\s+)?(id|name):\s*["']?([^"'\n#]+?)["']?\s*$/.exec(lines[i]!);
    if (m) return `near ${m[1] === 'id' ? 'step' : 'item'} ${m[2]} (line ${line})`;
  }
  return `line ${line}`;
}

function textHunks(base: string, ours: string, theirs: string): ConflictHunk[] {
  return mergeSegments(base, ours, theirs)
    .filter((s): s is Extract<Segment, { line: number }> => 'line' in s)
    .map((s, n) => ({ key: `hunk:${n}`, where: whereIn(ours, s.line), ours: s.ours, base: s.base, theirs: s.theirs }));
}

/** The text with each hunk settled: `side` for the ones without a choice. */
function applyHunks(base: string, ours: string, theirs: string, side: 'ours' | 'theirs', resolutions: MergeResolutions): string {
  let n = 0;
  return mergeSegments(base, ours, theirs)
    .map((s) => {
      if ('text' in s) return s.text;
      const r = resolutions[`hunk:${n++}`] ?? side;
      if (r === 'ours') return s.ours;
      if (r === 'theirs') return s.theirs;
      return r.edit === '' || r.edit.endsWith('\n') ? r.edit : `${r.edit}\n`;
    })
    .join('');
}

/* ------------------------------------------------------------------ detail and resolve */

/** What conflicts in one file (GIT-302), by item and field, by hunk, or whole, for the side-by-side view. */
export async function gitConflictDetail(ws: string, path: string): Promise<ConflictDetail> {
  const kind = kindOfPath(path, { raw: true })?.kind;
  const [base, ours, theirs] = await conflictStages(ws, path);
  if (isBinaryPath(path)) {
    const size = async (n: 2 | 3) => Number((await runGit(ws, ['cat-file', '-s', `:${n}:${toRepoPath((await repoRoot(ws)) ?? ws, ws, path)}`]).catch(() => '')).trim()) || undefined;
    return { path, mode: 'binary', ...(kind ? { kind } : {}), items: [], hunks: [], sizes: { ours: await size(2), theirs: await size(3) } };
  }
  const merged = mergeModeOfPath(path) ? mergeWorkspaceTexts(base, ours, theirs, {}, path) : undefined;
  if (!merged) return { path, mode: 'text', ...(kind ? { kind } : {}), items: [], hunks: textHunks(base, ours, theirs) };
  return {
    path,
    mode: 'items',
    ...(kind ? { kind } : {}),
    hunks: [],
    items: merged.items.map(({ base: b, ours: o, theirs: th, fields, ...rest }) => {
      const isItem = rest.kind !== 'setting';
      const pb = isItem ? requestParts(b) : { Value: asText(b) ?? '' };
      const po = isItem ? requestParts(o) : { Value: asText(o) ?? '' };
      const pt = isItem ? requestParts(th) : { Value: asText(th) ?? '' };
      const names = [...new Set([...Object.keys(pb), ...Object.keys(po), ...Object.keys(pt)])];
      return {
        ...rest,
        parts: names.map((part) => ({
          part,
          base: b === undefined ? undefined : (pb[part] ?? ''),
          ours: o === undefined ? undefined : (po[part] ?? ''),
          theirs: th === undefined ? undefined : (pt[part] ?? ''),
          differs: (o === undefined ? undefined : (po[part] ?? '')) !== (th === undefined ? undefined : (pt[part] ?? '')),
        })),
        ...(fields ? { fields: fields.map((f: FieldConflict) => ({ path: f.path, key: `${rest.key}#${f.path}`, base: asText(f.base), ours: asText(f.ours), theirs: asText(f.theirs), oursJson: JSON.stringify(f.ours), theirsJson: JSON.stringify(f.theirs) })) } : {}),
        editable: JSON.stringify(o ?? th, null, 2),
      };
    }),
  };
}

/**
 * Settle one conflicted file (GIT-302) and mark it resolved. `side` is taken for every conflict without a choice;
 * `resolutions` settle conflicts one by one (keys from gitConflictDetail: an item, `<item>#<field>`, a hunk): ours,
 * theirs, or `{ edit }`. A file merged by meaning keeps every change of both sides that did not conflict and is written
 * in the stable form; a text file is merged by lines with the hunks settled; a binary file is taken whole.
 */
export async function gitResolve(ws: string, path: string, side: 'ours' | 'theirs', resolutions?: MergeResolutions): Promise<void> {
  const [base, ours, theirs] = await conflictStages(ws, path);
  const abs = workspaceFile(ws, path);
  const meaning = !isBinaryPath(path) && mergeModeOfPath(path) ? mergeWorkspaceTexts(base, ours, theirs, {}, path) : undefined;
  if (meaning) {
    // every conflict without a choice takes the side asked for
    const all: MergeResolutions = { ...Object.fromEntries(meaning.items.map((c) => [c.key, side])), ...(resolutions ?? {}) };
    const merged = mergeWorkspaceTexts(base, ours, theirs, all, path)!;
    atomicWrite(abs, matchEol(safeRead(abs), merged.text));
  } else if (!isBinaryPath(path) && resolutions && Object.keys(resolutions).length) {
    atomicWrite(abs, matchEol(safeRead(abs), applyHunks(base, ours, theirs, side, resolutions)));
  } else await runGit(ws, ['checkout', `--${side}`, '--', path]);
  await runGit(ws, ['add', '--', path]);
}

const safeRead = (abs: string): string | undefined => {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
};
