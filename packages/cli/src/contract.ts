/**
 * What every command of the CLI takes and does the same way (one place, not one per command):
 *
 * - `--json`: one envelope (output.ts); `--jsonl` on the commands that stream (runs, servers, data runs): a line per
 *   event, then the envelope.
 * - `--dry-run` on the commands that write files or change state: run against copies, nothing changed, the result
 *   lists what would be (dry-run.ts). Commands with a dry run of their own keep it.
 * - `--non-interactive`: never wait for input (also with CI or TESTPION_NON_INTERACTIVE=1); what would ask fails with
 *   a hint instead.
 */
import type { Command } from 'commander';
import { beginCommand, cli } from './output.js';
import { CliError, EXIT } from './shared.js';
import { startDryRun } from './dry-run.js';

/** The commands that stream what happens (a line per result, call or row): they take --jsonl. */
export const STREAMING_COMMANDS = new Set(['test', 'run', 'run-collection', 'eval run', 'load', 'serve flows', 'debug', 'monitor start', 'record']);

/** Commands whose --json printed a line per event before the envelope existed: --json is --jsonl for them. */
export const JSON_MEANS_JSONL = new Set(['serve flows', 'debug']);

/** The commands that write files or change state: --dry-run (unless they have their own). */
export const WRITE_COMMANDS = new Set([
  'import',
  'export',
  'export-environment',
  'docs',
  'ci',
  'report',
  'workspace-report',
  'env set',
  'env unset',
  'env order',
  'vars rename',
  'replace',
  'tidy',
  'workspace create',
  'workspace rename',
  'workspace delete',
  'workspace export',
  'trash restore',
  'trash empty',
  'monitor add',
  'monitor remove',
  'datasets',
  'generate-data',
  'tests-from-spec',
  'integration-suite',
  'test from-request',
  'flow export',
  'history export-har',
  'git setup',
]);

const all = (c: Command): Command[] => [c, ...c.commands.flatMap(all)];

/** A command's path from the program: "eval compare", "env set". */
export const commandPath = (program: Command, c: Command): string => (c.parent && c.parent !== program ? `${commandPath(program, c.parent)} ${c.name()}` : c.name());

const hasOption = (c: Command, flag: string) => c.options.some((o) => o.long === flag);

/** The commands that run something: those with an action (`test` runs tests and also groups `test from-request`). */
export const leafCommands = (program: Command): Command[] => all(program).filter((c) => c !== program && (c.commands.length === 0 || !!(c as unknown as { _actionHandler?: unknown })._actionHandler));

/** Add the shared options to every command, and start each command's output (and its dry run) before it runs. */
export function applyCliContract(program: Command): void {
  const genericDryRun = new Set<string>();
  // a wrong argument anywhere is thrown to main (which answers the envelope with --json), not an exit from commander
  for (const c of all(program)) c.exitOverride();
  for (const c of leafCommands(program)) {
    const path = commandPath(program, c);
    if (STREAMING_COMMANDS.has(path) && !hasOption(c, '--jsonl')) c.option('--jsonl', 'print a JSON line per event as it happens, then the result envelope (for scripts and AI agents)');
    if (WRITE_COMMANDS.has(path) && !hasOption(c, '--dry-run') && genericDryRun.add(path))
      c.option('--dry-run', 'change nothing: run against copies and list the files that would be added, changed or deleted');
    if (!hasOption(c, '--non-interactive')) c.option('--non-interactive', 'never wait for input: fail with a hint instead (the default with CI or TESTPION_NON_INTERACTIVE=1)');
  }
  program.hook('preAction', (_cmd, action) => {
    const path = commandPath(program, action);
    // with the parent's options: `flow report --json` may hand --json to `flow`
    const o = action.optsWithGlobals() as { json?: unknown; jsonl?: unknown; dryRun?: unknown; nonInteractive?: unknown };
    beginCommand(
      path,
      { ...o, jsonl: o.jsonl === true || (JSON_MEANS_JSONL.has(path) && o.json === true) },
      [action, action.parent].some((c) => !!c && (hasOption(c, '--json') || hasOption(c, '--jsonl'))),
    );
    // the generic dry run (a command with its own handles --dry-run itself)
    if (o.dryRun === true && genericDryRun.has(path)) startDryRun();
  });
}

/** The command `argv` names (its words that are subcommands), for an error before the command started. */
export function commandFromArgv(program: Command, argv: string[]): string {
  const words: string[] = [];
  let at: Command = program;
  for (const w of argv.slice(2)) {
    if (w.startsWith('-')) continue;
    const next = at.commands.find((c) => c.name() === w || c.aliases().includes(w));
    if (!next) break;
    words.push(next.name());
    at = next;
  }
  return words.join(' ');
}

/** Where a command would wait for a person's input: in a non-interactive run it fails at once, saying what to do instead. */
export function requireInteractive(what: string, hint: string): void {
  if (cli.nonInteractive) throw Object.assign(new CliError(`${what} waits for input, and this run is non-interactive.`, EXIT.CONFIG_ERROR), { hint });
}
