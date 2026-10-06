import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { atomicWrite } from './fsutil.js';

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
];

export const GITATTRIBUTES_LINES = [
  '# TestPion: the same line endings on Windows, macOS and Linux',
  '* text=auto eol=lf',
  '*.png binary',
  '*.jpg binary',
  '*.sqlite binary',
  // merged request by request when the TestPion merge driver is set up (testpion git setup); else git's line merge
  'collections/*.json merge=testpion',
  'environments/*.json merge=testpion',
  'library/*.json merge=testpion',
];

export interface GitReadyResult {
  /** Files created or extended (.gitignore, .gitattributes). */
  files: string[];
  /** Collection files rewritten in the git-friendly form. */
  collections: string[];
  /** Whether the folder is already a git repository (or inside one). */
  inRepository: boolean;
}

/** Append the lines a file is missing (keeping what the user wrote); returns whether it changed. */
function ensureLines(file: string, lines: string[]): boolean {
  const had = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new Set(had.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l.trim()));
  if (!missing.some((l) => !l.startsWith('#'))) return false;
  atomicWrite(file, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${had ? '\n' : ''}${missing.join('\n')}\n`);
  return true;
}

/** The ignore and attribute files only (new workspaces get them when created). */
export function writeGitFiles(root: string): string[] {
  const out: string[] = [];
  if (ensureLines(join(root, '.gitignore'), GITIGNORE_LINES)) out.push('.gitignore');
  if (ensureLines(join(root, '.gitattributes'), GITATTRIBUTES_LINES)) out.push('.gitattributes');
  return out;
}

/** Whether `root` is inside a git repository (a `.git` here or in a parent folder). */
export function isInGitRepository(root: string): boolean {
  let dir = root;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return true;
    const up = join(dir, '..');
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

const HOOK_MARK = '# testpion-secret-guard';

/**
 * Install a git pre-commit hook that runs `testpion git check` for this workspace (GIT-104). An existing hook that
 * is not TestPion's is never overwritten: the message says how to add the check to it.
 */
export function installPreCommitHook(root: string, cli?: string): { installed: boolean; path?: string; message: string } {
  let dir = root;
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
  const rel = relative(dir, root).split(sep).join('/') || '.';
  const script = [
    '#!/bin/sh',
    HOOK_MARK,
    '# Refuse a commit that would publish a secret typed into the TestPion workspace. Skip once with: git commit --no-verify',
    // testpion on the PATH, else the CLI that installed this hook, else npx
    `if command -v testpion >/dev/null 2>&1; then T=testpion; ${cli ? `else T='${cli.split("'").join(`'"'"'`)}'; ` :'else T="npx --no-install testpion"; '}fi`,
    // eval: the remembered command is quoted (e.g. a path with spaces), which a plain $T would split
    `eval "$T git check -w '${rel.split("'").join(`'"'"'`)}'"`,
    'code=$?',
    // 1: secrets found, the commit stops. Anything else: the check could not run; say so and let the commit through
    'if [ $code -eq 1 ]; then echo "TestPion: secrets are typed into the workspace (above). Use secret variables, then commit again."; exit 1; fi',
    'if [ $code -ne 0 ]; then echo "TestPion: the secret check could not run (exit $code); committing without it."; fi',
    'exit 0',
    '',
  ].join('\n');
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(HOOK_MARK))
    return { installed: false, path: hook, message: `A pre-commit hook already exists (${hook}). Add this line to it:  testpion git check -w "${rel}" || exit 1` };
  atomicWrite(hook, script);
  try {
    chmodSync(hook, 0o755);
  } catch {
    /* Windows: git for Windows runs it anyway */
  }
  return { installed: true, path: hook, message: `Installed ${hook}` };
}
