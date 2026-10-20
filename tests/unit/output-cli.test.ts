import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../../packages/cli/src/index.js';
import { commandPath } from '../../packages/cli/src/contract.js';
import { OUTPUT_PARAMS } from '../../packages/core/src/index.js';
import { OUTPUT_SURFACES, outputSurface } from '../../packages/shared/src/index.js';

/**
 * The CLI writes the outputs of the app (planning/output-export.md): `testpion output <surface>` for every surface that
 * can be built from a workspace, and `--out` / `--format` on the commands that print the same results. A surface's `cli`
 * is a real command of the program, so the registry cannot name a command that does not exist.
 */
const program = buildProgram();
const all = (c: Command): Command[] => [c, ...c.commands.flatMap(all)];
const commands = new Map(
  all(program)
    .filter((c) => c !== program)
    .map((c) => [commandPath(program, c), c]),
);
const has = (c: Command, flag: string) => c.options.some((o) => o.long === flag);

describe('output surfaces and the CLI', () => {
  it('a surface’s cli is a command of the program', () => {
    const named = OUTPUT_SURFACES.filter((s) => s.cli);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((s) => !commands.has(s.cli!)).map((s) => `${s.id}: ${s.cli}`)).toEqual([]);
  });

  it('`output` can save every surface it lists, and every surface built from the workspace is listed', () => {
    for (const id of Object.keys(OUTPUT_PARAMS)) expect(outputSurface(id), id).toBeDefined();
    // the surfaces with a source other than the app's own (console, log, Debugger session) are the ones `output` builds
    const fromWorkspace = OUTPUT_SURFACES.filter((s) => s.sources?.some((k) => !['console', 'logs', 'debugger'].includes(k))).map((s) => s.id);
    expect(fromWorkspace.filter((id) => !(id in OUTPUT_PARAMS))).toEqual([]);
    const output = commands.get('output')!;
    for (const flag of ['--format', '--out', '--include-secrets', '--list', '--json']) expect(has(output, flag), flag).toBe(true);
  });

  it('the commands that print an output take --out and --format (and --include-secrets only where the output holds secrets)', () => {
    for (const path of ['send', 'history list', 'monitor results', 'git diff', 'eval matrix']) {
      const c = commands.get(path)!;
      expect(has(c, '--out'), `${path} --out`).toBe(true);
      expect(has(c, '--format'), `${path} --format`).toBe(true);
    }
    expect(has(commands.get('send')!, '--include-secrets')).toBe(false);
    expect(has(commands.get('history list')!, '--include-secrets')).toBe(false); // History is masked when it is recorded
  });
});
