/**
 * Every `testpion <command> …` a hint, an error, a message or a page names must be a real command: the first words
 * are checked against the commander tree (`buildProgram`), so a hint like `testpion flaky` (the command is
 * `testpion history flaky`) fails here instead of in front of a person.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../../packages/cli/src/index.js';

const ROOTS = ['packages/core/src', 'packages/cli/src', 'packages/shared/src', 'apps/desktop/src', 'apps/desktop/backend', 'apps/desktop/electron', 'docs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', '.vitepress']);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...files(p));
    } else if (/\.(ts|tsx|md)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Prose about the CLI, not a command: "the testpion command line", "testpion markers", "testpion on the PATH". */
const PROSE = new Set(['command', 'commands', 'command-line', 'markers', 'block', 'on', 'sending']);

/** A command by name or alias. */
const child = (c: Command, name: string) => c.commands.find((x) => x.name() === name || x.aliases().includes(name));

/** `testpion a b c` → the problem with it, or undefined when the command exists. */
function problem(program: Command, words: string[]): string | undefined {
  let cmd = program;
  for (const [i, w] of words.entries()) {
    const next = child(cmd, w);
    if (next) {
      cmd = next;
      continue;
    }
    // the first word must be a command; a later one may be an argument of the command found so far
    if (i === 0) return `no command "${w}"`;
    const takesArgs = cmd.registeredArguments.length > 0 || !cmd.commands.length;
    return takesArgs ? undefined : `"${words.slice(0, i).join(' ')}" has no subcommand "${w}"`;
  }
  return undefined;
}

describe('CLI commands named in hints, messages and docs', () => {
  it('every `testpion <command> …` is a command of the CLI', () => {
    const program = buildProgram();
    const bad: string[] = [];
    for (const root of ROOTS)
      for (const file of files(root)) {
        const text = readFileSync(file, 'utf8');
        // `testpion` then up to three command words (lower case, as the CLI spells them)
        for (const m of text.matchAll(/(?<![\w./@-])testpion((?: [a-z][a-z0-9]*(?:-[a-z0-9]+)*){1,3})(?![\w.:/-])/g)) {
          const words = m[1]!.trim().split(' ');
          if (PROSE.has(words[0]!)) continue;
          const why = problem(program, words);
          if (why) bad.push(`${file.replace(/\\/g, '/')}: "testpion${m[1]}" — ${why}`);
        }
      }
    expect(bad).toEqual([]);
  });
});
