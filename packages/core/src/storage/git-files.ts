import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { atomicWrite, realPathOf } from './fsutil.js';

/** The files that make a workspace folder git-ready (GIT-102); see git-ready.ts and planning/git-integration.md. */

/** What stays on this computer: results, traces, the local database and state. Everything else is shared. */
export const GITIGNORE_LINES = [
  '# TestPion: results and this computer\'s state stay out of git',
  'runs/',
  'traces/',
  'payloads/',
  'reports/',
  'baselines/',
  'trash/',
  '.local/',
  'debugger/*.har',
  'database.sqlite*',
  'metadata.jsonl',
  '.template-offered.json',
  // the copy kept when an older workspace file is migrated, and a write that was cut short
  'workspace.json.bak-*',
  '*.tmp-*',
];

export const GITATTRIBUTES_LINES = [
  '# TestPion: the same line endings on Windows, macOS and Linux',
  '* text=auto eol=lf',
  '*.png binary',
  '*.jpg binary',
  '*.sqlite binary',
  // merged item by item when the TestPion merge driver is set up, and read item by item in `git diff` when the diff driver is
  // (both: testpion git fix); without them git uses its line merge and its plain diff
  'collections/*.json merge=testpion diff=testpion',
  'environments/*.json merge=testpion diff=testpion',
  'library/*.json merge=testpion diff=testpion',
  'mcp-servers.json merge=testpion diff=testpion',
  'providers.json merge=testpion diff=testpion',
];

export interface GitReadyResult {
  /** Files created or extended (.gitignore, .gitattributes). */
  files: string[];
  /** Collection files rewritten in the git-friendly form. */
  collections: string[];
  /** Whether the folder is already a git repository (or inside one). */
  inRepository: boolean;
}

/** The text of an ignore file with the lines it is missing added (what the user wrote stays); undefined: nothing to add. */
export function ignoreText(had: string, lines: readonly string[] = GITIGNORE_LINES): string | undefined {
  const present = new Set(had.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l.trim()));
  if (!missing.some((l) => !l.startsWith('#'))) return undefined;
  return `${had}${had && !had.endsWith('\n') ? '\n' : ''}${had ? '\n' : ''}${missing.join('\n')}\n`;
}

/** The name of an attribute: `merge=testpion` is merge, `-text` is text, `binary` is binary. */
const attrName = (a: string) => a.replace(/^[-!]/, '').split('=')[0]!;

/**
 * The text of an attributes file with what it is missing added. A pattern the file has already gets the attributes it lacks on
 * its own line (`collections/*.json merge=testpion` becomes `… merge=testpion diff=testpion`), never a second line for the
 * same pattern; an attribute the user set to another value stays theirs. Undefined: nothing to add.
 */
export function attributesText(had: string, wanted: readonly string[] = GITATTRIBUTES_LINES): string | undefined {
  const lines = had.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const appended: string[] = [];
  // a comment is added with the first line it describes, and only if the file does not have it yet
  let pending: string[] = [];
  let changed = false;
  for (const w of wanted) {
    if (w.startsWith('#')) {
      if (!lines.some((l) => l.trim() === w.trim())) pending.push(w);
      continue;
    }
    const [pattern, ...attrs] = w.trim().split(/\s+/);
    const at = lines.findIndex((l) => !l.trim().startsWith('#') && l.trim().split(/\s+/)[0] === pattern);
    if (at < 0) {
      appended.push(...pending, w);
      pending = [];
      changed = true;
      continue;
    }
    pending = [];
    const have = lines[at]!.trim().split(/\s+/).slice(1);
    const add = attrs.filter((a) => !have.some((h) => attrName(h) === attrName(a)));
    if (add.length) {
      lines[at] = `${lines[at]!.replace(/\s+$/, '')} ${add.join(' ')}`;
      changed = true;
    }
  }
  if (!changed) return undefined;
  return [...lines, ...(lines.length && appended.length ? [''] : []), ...appended].join('\n') + '\n';
}

function ensureFile(file: string, next: (had: string) => string | undefined): boolean {
  const had = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const text = next(had);
  if (text === undefined) return false;
  atomicWrite(file, text);
  return true;
}

/** The ignore and attribute files only (new workspaces get them when created). */
export function writeGitFiles(root: string): string[] {
  const out: string[] = [];
  if (ensureFile(join(root, '.gitignore'), (had) => ignoreText(had))) out.push('.gitignore');
  if (ensureFile(join(root, '.gitattributes'), (had) => attributesText(had))) out.push('.gitattributes');
  return out;
}

/**
 * Whether `root` is inside a git repository (a `.git` here or in a parent folder of its real path: git finds the
 * repository of the folder a link leads to, not of the folders above the link).
 */
export function isInGitRepository(root: string): boolean {
  let dir = realPathOf(root);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return true;
    const up = join(dir, '..');
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

const HOOK_MARK = '# testpion-secret-guard';

/** `text` as one word for a POSIX shell: in single quotes, each single quote inside closed, escaped and reopened. Nothing in it is expanded. */
export const shellQuote = (text: string): string => `'${text.split("'").join("'\\''")}'`;

/**
 * The text of the pre-commit hook. The workspace's path inside the repository comes from the repository (a folder name
 * is whatever whoever made the repository chose), so it is never written into a line the shell parses: it is the
 * single-quoted variable W, and the check gets "$W", which the shell expands without reading `$(...)`, backticks,
 * quotes or newlines in it. `cli` is the command that installed the hook (from the app, not from the workspace): a
 * shell command line, run through `eval` so its own quoting (a path with spaces) holds.
 */
export function preCommitScript(rel: string, cli?: string): string {
  return [
    '#!/bin/sh',
    HOOK_MARK,
    '# Refuse a commit that would publish a secret typed into the TestPion workspace. Skip once with: git commit --no-verify',
    `W=${shellQuote(rel)}`,
    // testpion on the PATH, else the CLI that installed this hook, else npx
    `if command -v testpion >/dev/null 2>&1; then T=testpion; ${cli ? `else T=${shellQuote(cli)}; ` : 'else T="npx --no-install testpion"; '}fi`,
    // eval: the remembered command is quoted (e.g. a path with spaces), which a plain $T would split; the path stays a variable
    'eval "$T git check -w \\"\\$W\\""',
    'code=$?',
    // 1: secrets found, the commit stops. Anything else: the check could not run; say so and let the commit through
    'if [ $code -eq 1 ]; then echo "TestPion: secrets are typed into the workspace (above). Use secret variables, then commit again."; exit 1; fi',
    'if [ $code -ne 0 ]; then echo "TestPion: the secret check could not run (exit $code); committing without it."; fi',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Install a git pre-commit hook that runs `testpion git check` for this workspace (GIT-104). An existing hook that
 * is not TestPion's is never overwritten: the message says how to add the check to it.
 */
export function installPreCommitHook(root: string, cli?: string): { installed: boolean; path?: string; message: string } {
  // up from the real folder, as git looks (see isInGitRepository); the hook's path to the workspace is from there too
  const real = realPathOf(root);
  let dir = real;
  let gitDir: string | undefined;
  for (let i = 0; i < 64 && !gitDir; i++) {
    const g = join(dir, '.git');
    if (existsSync(g)) {
      // usually a folder; in a worktree or submodule a file that points to the real folder
      const text = statSync(g).isFile() ? readFileSync(g, 'utf8').trim() : '';
      gitDir = text.startsWith('gitdir:') ? resolve(dir, text.slice('gitdir:'.length).trim()) : g;
      break;
    }
    const up = join(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  if (!gitDir) return { installed: false, message: `Not a git repository: run  git init  in ${root} first.` };
  const hook = join(gitDir, 'hooks', 'pre-commit');
  const rel = relative(dir, real).split(sep).join('/') || '.';
  const script = preCommitScript(rel, cli);
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(HOOK_MARK))
    return { installed: false, path: hook, message: `A pre-commit hook already exists (${hook}). Add this line to it:  testpion git check -w ${shellQuote(rel)} || exit 1` };
  atomicWrite(hook, script);
  try {
    chmodSync(hook, 0o755);
  } catch {
    /* Windows: git for Windows runs it anyway */
  }
  return { installed: true, path: hook, message: `Installed ${hook}` };
}
