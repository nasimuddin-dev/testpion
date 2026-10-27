import { spawnSyncChecked } from '../net/process.js';
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

type ConflictMode = 'items' | 'text' | 'binary';

interface ConflictHunk {
  /** `hunk:<n>`: the key to settle it with. */
  key: string;
  /** Where it is, in words: "near step create-order", "line 14". */
  where: string;
  ours: string;
  base: string;
  theirs: string;
  /** The id of the step of a test or flow file this hunk is in (settle all of a step's hunks with `step:<id>`). */
  step?: string;
}

/** The hunks of one step of a test or flow file: one choice for the step (`key`: `step:<id>`) settles them all. */
interface ConflictStep {
  key: string;
  step: string;
  /** The keys of its hunks. */
  hunks: string[];
}

interface ConflictField {
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

interface ConflictDetail {
  path: string;
  mode: ConflictMode;
  kind?: KindId;
  items: Array<Omit<MergeConflict, 'base' | 'ours' | 'theirs' | 'fields'> & { parts: Part[]; fields?: ConflictField[]; /** The item as JSON, to start an edit from (ours). */ editable?: string }>;
  hunks: ConflictHunk[];
  /** A test or flow file: the hunks grouped by the step they are in, so a conflict is settled by step; a hunk outside any step stays a hunk. */
  steps?: ConflictStep[];
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
    const r = spawnSyncChecked('git', 'git', ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', o!, b!, t!], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
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

/**
 * The step of a test or flow file a line is in: the nearest `id:` above it that starts a list item (`- id: create-order`) or
 * sits at a step's own indentation. Undefined for a line outside the steps (the file's settings).
 */
function stepOf(oursText: string, line: number): string | undefined {
  const lines = oursText.split('\n');
  // the steps are the list under `tests:` / `steps:`; their items start at one indentation (a header list inside a step is deeper)
  const header = lines.findIndex((l) => /^(tests|steps):\s*$/.test(l));
  if (header < 0) return undefined;
  const first = lines.slice(header + 1).find((l) => /^\s*-\s/.test(l));
  if (!first) return undefined;
  const indent = /^(\s*)/.exec(first)![1]!.length;
  for (let i = Math.min(line, lines.length) - 1; i > header; i--) {
    const m = /^(\s*)-\s+(?:id|name):\s*["']?([^"'\n#]+?)["']?\s*$/.exec(lines[i]!);
    if (m && m[1]!.length === indent) return m[2];
    // a setting of the file after the steps (an unindented key) is not in any step
    if (/^[A-Za-z_][\w-]*:/.test(lines[i]!)) return undefined;
  }
  return undefined;
}

function textHunks(base: string, ours: string, theirs: string, bySteps = false): ConflictHunk[] {
  return mergeSegments(base, ours, theirs)
    .filter((s): s is Extract<Segment, { line: number }> => 'line' in s)
    .map((s, n) => {
      const step = bySteps ? stepOf(ours, s.line) : undefined;
      return { key: `hunk:${n}`, where: whereIn(ours, s.line), ours: s.ours, base: s.base, theirs: s.theirs, ...(step ? { step } : {}) };
    });
}

/** The hunks of a test or flow file grouped by step (a step with one hunk too: the choice is made by step everywhere). */
function stepsOf(hunks: ConflictHunk[]): ConflictStep[] {
  const by = new Map<string, string[]>();
  for (const h of hunks) if (h.step) (by.get(h.step) ?? by.set(h.step, []).get(h.step)!).push(h.key);
  return [...by].map(([step, keys]) => ({ key: `step:${step}`, step, hunks: keys }));
}

const isStepFile = (path: string, kind: KindId | undefined) => kind === 'test' && /\.ya?ml$/i.test(path);

/** The text with each hunk settled: `side` for the ones without a choice. */
function applyHunks(base: string, ours: string, theirs: string, side: 'ours' | 'theirs', resolutions: MergeResolutions, bySteps = false): string {
  let n = 0;
  return mergeSegments(base, ours, theirs)
    .map((s) => {
      if ('text' in s) return s.text;
      // a choice for a step settles its hunks, unless the hunk has a choice of its own
      const step = bySteps ? stepOf(ours, s.line) : undefined;
      const r = resolutions[`hunk:${n++}`] ?? (step ? resolutions[`step:${step}`] : undefined) ?? side;
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
  if (!merged) {
    const bySteps = isStepFile(path, kind);
    const hunks = textHunks(base, ours, theirs, bySteps);
    const steps = bySteps ? stepsOf(hunks) : [];
    return { path, mode: 'text', ...(kind ? { kind } : {}), items: [], hunks, ...(steps.length ? { steps } : {}) };
  }
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
  const kind = kindOfPath(path, { raw: true })?.kind;
  const [base, ours, theirs] = await conflictStages(ws, path);
  const abs = workspaceFile(ws, path);
  const meaning = !isBinaryPath(path) && mergeModeOfPath(path) ? mergeWorkspaceTexts(base, ours, theirs, {}, path) : undefined;
  if (meaning) {
    // every conflict without a choice takes the side asked for
    const all: MergeResolutions = { ...Object.fromEntries(meaning.items.map((c) => [c.key, side])), ...(resolutions ?? {}) };
    const merged = mergeWorkspaceTexts(base, ours, theirs, all, path)!;
    atomicWrite(abs, matchEol(safeRead(abs), merged.text));
  } else if (!isBinaryPath(path) && resolutions && Object.keys(resolutions).length) {
    atomicWrite(abs, matchEol(safeRead(abs), applyHunks(base, ours, theirs, side, resolutions, isStepFile(path, kind))));
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
