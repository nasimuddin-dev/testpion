/**
 * What every command of the CLI takes and does the same way (one place, not one per command):
 *
 * - `--json`: one envelope (output.ts); `--jsonl` on the commands that stream (runs, servers, data runs): a line per
 *   event, then the envelope.
 * - `--dry-run` on the commands that write files or change state: run against copies, nothing changed, the result
 *   lists what would be (dry-run.ts). Commands with a dry run of their own keep it; the commands that run git print
 *   their plan instead (plan.ts), because a copy cannot show what git would do.
 * - `--yes` on the commands that delete or overwrite, as the MCP tools confirm (confirm.ts): without it a terminal asks,
 *   and a non-interactive run refuses with `{ confirmationRequired, wouldDo }`.
 * - `--non-interactive`: never wait for input (also with CI or TESTPION_NON_INTERACTIVE=1); what would ask fails with
 *   a hint instead.
 */
import type { Command } from 'commander';
import { setAiCostCap } from '@testpion/core';
import { beginCommand, cli } from './output.js';
import { CliError, EXIT } from './shared.js';
import { refuseWhenOpenElsewhere } from './workspace-guard.js';
import { startDryRun } from './dry-run.js';
import { CLI_CONFIRM, confirmBeforeRun } from './confirm.js';
import { PLAN_ONLY, PlanOnly, planFor } from './plan.js';

/** The commands that stream what happens (a line per result, call or row): they take --jsonl. */
export const STREAMING_COMMANDS = new Set(['test', 'run', 'run-collection', 'eval run', 'load', 'serve flows', 'debug', 'monitor start', 'record']);

/** Commands whose --json printed a line per event before the envelope existed: --json is --jsonl for them. */
export const JSON_MEANS_JSONL = new Set(['serve flows', 'debug', 'mock collection', 'mock graphql']);

/**
 * Commands whose stdout is not ours (the MCP protocol of a server, what git reads from its drivers): they accept --json
 * so no caller has to know the list, and ignore it.
 */
export const NO_ENVELOPE = new Set(['mcp-server', 'merge-driver', 'git textconv']);

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
  'ai apply',
  'ai undo',
  'ai discard',
  'item delete',
  'item restore',
  'import-undo',
  'rag connect',
  'rag cache clear',
  'rag label set',
  'rag label clear',
  'rag probes add',
  'rag import',
  'rag export',
  'rag metric import',
  'rag metric export',
  'output',
  'git unshare-session',
  'git allow-secret',
  'git disallow-secret',
  'git fix-secrets',
  'git undo',
  'settings set',
  'settings reset',
]);

/** The commands that call the user's AI model: each takes `--max-cost <usd>`, refused before anything is sent when one call could cost more. */
export const AI_COMMANDS = new Set(['ai run', 'ai triage', 'ai script', 'ai attempt-fix', 'generate tests', 'tidy', 'flow generate', 'security generate', 'openapi drift', 'search', 'rag generate-dataset', 'rag draft-references', 'rag author']);

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
    // every command takes --json, so an agent never has to know which ones do (a command that prints JSON already keeps its own)
    if (!hasOption(c, '--json') && !hasOption(c, '--jsonl')) c.option('--json', NO_ENVELOPE.has(path) ? 'accepted and ignored: the output of this command is not ours' : 'print the result as one JSON envelope (for scripts and AI agents)');
    if (WRITE_COMMANDS.has(path) && !path.startsWith('workspace ') && !hasOption(c, '--force') && !hasOption(c, '--yes')) c.option('--force', 'write even when another TestPion has this workspace open');
    if (AI_COMMANDS.has(path) && !hasOption(c, '--max-cost')) c.option('--max-cost <usd>', 'refuse before anything is sent when one AI call could cost more than this many US dollars (the price table; a local model is free)');
    if (PLAN_ONLY[path] && !hasOption(c, '--dry-run')) c.option('--dry-run', 'change nothing: print what it would do (git is not run)');
    if (CLI_CONFIRM.some((e) => e.command === path) && !hasOption(c, '--yes')) c.option('--yes', 'confirm: required when it cannot ask (--non-interactive, CI); --dry-run shows what it would do first');
    if (!hasOption(c, '--non-interactive')) c.option('--non-interactive', 'never wait for input: fail with a hint instead (the default with CI or TESTPION_NON_INTERACTIVE=1)');
  }
  program.hook('preAction', (_cmd, action) => {
    const path = commandPath(program, action);
    // with the parent's options: `flow report --json` may hand --json to `flow`
    const o = action.optsWithGlobals() as { json?: unknown; jsonl?: unknown; dryRun?: unknown; nonInteractive?: unknown; workspace?: unknown };
    beginCommand(
      path,
      { ...o, json: NO_ENVELOPE.has(path) ? false : o.json, jsonl: o.jsonl === true || (JSON_MEANS_JSONL.has(path) && o.json === true) },
      [action, action.parent].some((c) => !!c && (hasOption(c, '--json') || hasOption(c, '--jsonl'))),
    );
    if (WRITE_COMMANDS.has(path) && !path.startsWith('workspace ')) refuseWhenOpenElsewhere(o as Record<string, unknown>); // another TestPion has this workspace open (workspace-guard.ts)
    // one AI call may not cost more than --max-cost
    if (AI_COMMANDS.has(path) && typeof (o as { maxCost?: unknown }).maxCost === 'string') {
      const cap = Number((o as { maxCost: string }).maxCost);
      if (!(cap >= 0)) throw Object.assign(new CliError('--max-cost is an amount in US dollars, 0 or more', EXIT.CONFIG_ERROR), { hint: 'For example --max-cost 0.05.' });
      setAiCostCap(cap);
    }
    // a command that runs git prints its plan and does not run
    const run = async () => {
      if (o.dryRun === true && PLAN_ONLY[path]) {
        const plan = await planFor(path, o.workspace, o as Record<string, unknown>, action.processedArgs.map(String));
        if (plan) throw new PlanOnly(plan);
      }
      // the generic dry run (a command with its own handles --dry-run itself)
      if (o.dryRun === true && genericDryRun.has(path)) startDryRun();
      // a command that deletes or overwrites asks, or refuses without --yes (confirm.ts)
      await confirmBeforeRun(path, action, o as Record<string, unknown>, action.processedArgs.map(String));
    };
    return run();
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
