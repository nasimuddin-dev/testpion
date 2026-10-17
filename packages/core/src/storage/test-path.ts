/**
 * A test file path someone else chose — an AI proposal's target (`--path`, an RPC's `path`, a hand-edited proposal) or an
 * agent's `write_test_file` — checked the same way on every OS. The check is lexical and never asks `node:path`, whose
 * answer depends on the OS it runs on (`C:\x.yaml` is absolute on Windows and a plain file name on Linux and macOS): a
 * path is a list of `/`-separated names inside tests/, ending in .yaml, .yml or .json. Writing then checks the real
 * (symlink-resolved) location too (`realTestFilePath`), so a link inside tests/ cannot carry a write outside it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApsError } from '../errors.js';

/** Longest accepted path (characters, after `tests/` is dropped) and name: well inside every OS's limits. */
export const MAX_TEST_PATH = 200;
const MAX_TEST_NAME = 100;
const TEST_FILE = /\.(ya?ml|json)$/i;
/** Names Windows reserves for devices (with any extension): a file named so cannot be made there. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;

const escapes = (asked: string, why: string) =>
  new ApsError('ValidationError', `Path escapes the workspace's tests/ folder: ${JSON.stringify(asked)} (${why})`, {
    suggestions: ['Give a path relative to tests/ with / between folders, e.g. flows/orders.yaml.'],
  });
const invalid = (asked: string, why: string) =>
  new ApsError('ValidationError', `Not a usable test file path: ${JSON.stringify(asked)} (${why})`, {
    suggestions: ['Give a path relative to tests/ with / between folders, e.g. flows/orders.yaml.'],
  });

/**
 * The path relative to tests/ (`flows/orders.yaml`, a leading `tests/` dropped), or a ValidationError saying why not:
 * absolute paths (`/x`, `C:x`, `C:\x`, `\\server\share`), backslashes (a separator on Windows only), `..`, percent
 * encoding, control characters, empty names (`a//b`), names Windows cannot hold (`<>:"|?*`, a trailing dot or space,
 * CON, NUL, …), over-long paths, and anything but a YAML or JSON file.
 */
export function relativeTestFilePath(asked: unknown): string {
  if (typeof asked !== 'string') throw invalid(String(asked), 'not text');
  const given = asked.trim();
  if (!given) throw invalid(asked, 'empty');
  if (/[\u0000-\u001f\u007f]/.test(given)) throw invalid(asked, 'it holds a control character');
  if (/%[0-9a-f]{2}/i.test(given)) throw escapes(asked, 'percent-encoded names are not decoded');
  // the same answer on every OS: what is absolute on any of them is refused, and \ is never read as a mere character
  if (/^[a-z]:/i.test(given)) throw escapes(asked, 'an absolute path (a drive)');
  if (/^[\\/]/.test(given)) throw escapes(asked, 'an absolute path');
  if (given.includes('\\')) throw escapes(asked, 'use / between folders, not \\');
  const names = given.split('/').filter((n) => n !== '.');
  if (names[0] === 'tests' && names.length > 1) names.shift();
  for (const n of names) {
    if (n === '..') throw escapes(asked, '".." leaves the folder');
    if (n === '') throw invalid(asked, 'an empty folder name');
    if (/[<>:"|?*]/.test(n)) throw invalid(asked, `"${n}" holds a character Windows does not allow in file names`);
    if (/[. ]$/.test(n)) throw invalid(asked, `"${n}" ends with a dot or a space`);
    if (RESERVED.test(n)) throw invalid(asked, `"${n}" is a device name on Windows`);
    if (n.length > MAX_TEST_NAME) throw invalid(asked, `a name longer than ${MAX_TEST_NAME} characters`);
  }
  const rel = names.join('/');
  if (!rel) throw invalid(asked, 'no file name');
  if (rel.length > MAX_TEST_PATH) throw invalid(asked, `longer than ${MAX_TEST_PATH} characters`);
  if (!TEST_FILE.test(rel))
    throw new ApsError('ValidationError', `A proposed test file is YAML or JSON (.yaml, .yml, .json) under tests/: ${asked}`, { suggestions: ['Pass a path under tests/, e.g. flows/orders.yaml.'] });
  return rel;
}

/** The deepest part of `p` that exists, really (symlinks resolved), plus the names below it that do not exist yet. */
function realOf(p: string): string {
  const missing: string[] = [];
  let at = p;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    missing.unshift(basename(at));
    at = up;
  }
  let real = at;
  try {
    real = realpathSync.native(at);
  } catch {
    /* unreadable: compared as given */
  }
  return missing.length ? join(real, ...missing) : real;
}

/**
 * Where a checked relative test path (`relativeTestFilePath`) is written: inside `testsRoot` both as named and really,
 * so a folder (or file) under tests/ that links elsewhere is refused before anything is written.
 */
export function realTestFilePath(testsRoot: string, rel: string): string {
  const root = resolve(testsRoot);
  const abs = join(root, ...rel.split('/'));
  const lexical = relative(root, abs);
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw escapes(rel, 'outside tests/');
  const really = relative(realOf(root), realOf(abs));
  if (!really || really === '..' || really.startsWith(`..${sep}`) || isAbsolute(really)) throw escapes(rel, 'a link in tests/ leads outside it');
  return abs;
}

/** A test file path from outside (an AI proposal, an agent): checked lexically, then where it really lands under `testsRoot`. */
export function checkedTestFilePath(testsRoot: string, asked: unknown): { rel: string; abs: string } {
  const rel = relativeTestFilePath(asked);
  return { rel, abs: realTestFilePath(testsRoot, rel) };
}
