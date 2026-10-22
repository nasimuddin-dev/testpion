/**
 * The CLI's confirmation contract: the same commands ask the same questions as the MCP tools (`CONFIRM_TOOLS` in
 * @testpion/core), by one table.
 *
 * A command that deletes, overwrites or drops something takes `--yes`. Without it, a run on a terminal asks "Continue?";
 * a run that cannot ask (`--non-interactive`, CI, a pipe) refuses before anything changed, with exit code 2 and the
 * answer MCP gives: `{ confirmationRequired: true, wouldDo, hint }` (in the `--json` envelope's `data`), so an agent
 * sees what would happen and asks the person, then repeats the command with `--yes`. `--dry-run` previews instead.
 *
 * Every tool in CONFIRM_TOOLS is either the twin of a row of CLI_CONFIRM or in CLI_NO_CONFIRM with the reason it needs no
 * `--yes` here (tests/unit/ui-friendliness.test.ts keeps the two lists complete when a tool is added).
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { CONFIRM_TOOLS } from '@testpion/core';
import { CliError, EXIT } from './shared.js';
import { cli, machine, printJson } from './output.js';

type Opts = Record<string, unknown>;

export interface CliConfirm {
  /** The MCP tool this command is the twin of (its `describe` says what the call does); undefined: the command words it. */
  tool?: string;
  /** The command's path ("item delete"). */
  command: string;
  /** Only some calls ask (an option that overwrites). */
  when?(o: Opts, args: string[]): boolean;
  /** The arguments of the tool's `describe`, from the command's options and arguments. */
  args(o: Opts, args: string[]): Record<string, unknown>;
  /** What the command does, in words, when there is no tool to ask. */
  describe?(o: Opts, args: string[]): string;
}

const real = (o: Opts) => o.dryRun !== true;

export const CLI_CONFIRM: CliConfirm[] = [
  { tool: 'delete_item', command: 'item delete', args: (_o, a) => ({ ref: a[0] }) },
  { tool: 'undo_definition_import', command: 'import-undo', args: (_o, a) => ({ id: a[0] }) },
  { tool: 'undo_import', command: 'import', when: (o) => typeof o.undo === 'string' && real(o), args: (o) => ({ import_id: o.undo }) },
  { command: 'workspace delete', when: real, args: () => ({}), describe: (_o, a) => `delete the workspace ${JSON.stringify(a[0] ?? '')} from the list, and its folder when it lives in the app's data folder` },
  { command: 'trash empty', when: real, args: () => ({}), describe: (o) => (o.id ? `delete the Recently deleted item ${JSON.stringify(String(o.id))} for good (it cannot be undone)` : 'delete everything in Recently deleted for good (it cannot be undone)') },
  { tool: 'git_resolve', command: 'git resolve', args: (o, a) => ({ path: a[0], side: o.ours ? 'ours' : o.theirs ? 'theirs' : undefined }) },
  { tool: 'git_stash', command: 'git stash drop', args: () => ({ action: 'drop' }) },
  { tool: 'git_stash', command: 'git stash apply', args: () => ({ action: 'apply' }) },
  { tool: 'git_stash', command: 'git stash pop', args: () => ({ action: 'pop' }) },
  { tool: 'git_stash', command: 'git stash push', when: real, args: (o) => ({ action: 'push', name: o.message }) },
  { tool: 'git_restore_item', command: 'git restore', when: real, args: (o, a) => ({ ref: a[0], rev: o.rev }) },
  { tool: 'git_discard_item', command: 'git discard-item', when: real, args: (_o, a) => ({ ref: a[0] }) },
  { tool: 'git_undo', command: 'git undo', when: (o) => o.list !== true, args: (_o, a) => ({ id: a[0] }) },
  { tool: 'git_share_session', command: 'git unshare-session', args: (_o, a) => ({ name: a[0], unshare: true }) },
  { tool: 'git_fix_setup', command: 'git fix', when: real, args: (o) => ({ hook: o.hook === true, untrack: o.untrack === true }) },
  { tool: 'git_track_large', command: 'git large', when: (o) => typeof o.track === 'string' && real(o), args: (o) => ({ file: o.track, mode: o.lfs ? 'lfs' : 'reference' }) },
  { tool: 'git_codeowners', command: 'git codeowners', when: (o) => o.write === true && real(o), args: () => ({}) },
  { tool: 'git_sync', command: 'git sync', args: () => ({}) },
  { tool: 'collection_tidy', command: 'tidy', when: (o) => real(o) && !o.ai && !o.flow && !!(o.removeDuplicates || o.removeEmptyFolders || o.removeUnusedVariables || o.useCollectionAuth), args: (_o, a) => ({ collection: a[0] }) },
  { tool: 'rename_variable', command: 'vars rename', when: real, args: (_o, a) => ({ from: a[0], to: a[1] }) },
  { tool: 'replace_in_collection', command: 'replace', when: (o) => o.apply === true && real(o), args: (_o, a) => ({ collection: a[0], find: a[1], replace: a[2] }) },
  { tool: 'move_variables_to_environments', command: 'vars move', when: real, args: (_o, a) => ({ collection: a[0] }) },
  { tool: 'flow_remove_step', command: 'flow edit', when: (o) => typeof o.remove === 'string' && real(o), args: (o, a) => ({ id: o.remove, file: a[0] }) },
  { tool: 'ai_undo_proposal', command: 'ai undo', when: real, args: (_o, a) => ({ id: a[0] }) },
  { tool: 'ai_apply_proposal', command: 'ai apply', when: real, args: (o, a) => ({ id: a[0], items: typeof o.items === 'string' ? o.items.split(',') : undefined }) },
  { tool: 'generate_flows', command: 'integration-suite', when: (o) => o.overwrite === true && real(o), args: () => ({ overwrite: true }) },
  { tool: 'generate_tests', command: 'tests-from-spec', when: (o) => o.overwrite === true && real(o), args: () => ({ overwrite: true }) },
  { tool: 'generate_dataset', command: 'generate-data', when: (o) => o.overwrite === true && real(o), args: (_o, a) => ({ overwrite: true, name: a[0] }) },
  { tool: 'rag_capture_dataset', command: 'rag capture', when: (o) => o.overwrite === true && real(o), args: (o) => ({ overwrite: true, name: o.name }) },
  { tool: 'agents_init', command: 'agents init', when: (o) => o.force === true && real(o), args: () => ({ force: true }) },
];

/**
 * The MCP tools whose twin on the command line asks for nothing, and why: a command whose whole purpose is to send,
 * spend or write what you named (you chose the evaluation, the budget, the file), a tool the CLI does not have, or one
 * the CLI previews with its own flag.
 */
export const CLI_NO_CONFIRM: Record<string, string> = {
  rag_run: 'the command is the run: you named the evaluation and can bound it with --estimate / --max-cost / --max-calls',
  rag_rescore: 'the command is the run: --estimate and --max-cost bound it',
  rag_try_metric: 'rag metric test: you named the metric and the sample',
  rag_probe: 'rag probe sends the one question you wrote',
  rag_validate_metric: 'rag metric validate: you asked for it, --examples is the opt-in',
  rag_import_dataset: 'rag import writes the file you named with --out, never over an existing one',
  rag_save_custom_metric: 'rag metric import --force is the overwrite opt-in',
  rag_generate_testset: 'rag generate-dataset: nothing is written until the proposal is applied (ai apply asks)',
  rag_draft_references: 'rag draft-references: nothing is written until the proposal is applied (ai apply asks)',
  rag_author_evaluation: 'rag author: nothing is saved until the proposal is applied (ai apply asks)',
  save_output: 'output --out writes the new file you named, never over a file',
  export_bundle: 'export writes the file you named, never over a file',
  export_traces: 'the CLI has no trace export to a collector',
  import_definition: 'import has --preview and --dry-run, and import-undo takes it back',
  import_bundle_apply: 'import --apply of a previewed plan: you named the plan, --on-conflict says what happens to items that exist',
  security_tests_run: 'security run is the run: you named the file and the environment',
  delete_request: 'the CLI deletes requests through item delete / collection edits, not a tool of its own',
  set_request_checks: 'the CLI has no twin: checks are edited in the collection file or with ai apply',
  write_test_file: 'the CLI writes test files through generate / tests-from-spec (their --overwrite asks)',
  generate_tests: 'generate tests has no --overwrite; tests-from-spec --overwrite asks',
  flow_webhook_set: 'flow edit --no-webhook is one line of a flow file, shown by --dry-run',
  debugger_rules: 'the CLI has no Debugger rules twin',
  debugger_session: 'the CLI has no Debugger session twin',
  ai_attempt_fix: 'ai attempt-fix is the run: you named the proposal and --times',
};

const quote = (v: unknown) => JSON.stringify(String(v ?? ''));

/** What the call would do, in words (the tool's own sentence when the command has a twin). */
export function wouldDo(e: CliConfirm, o: Opts, args: string[]): string {
  const a = e.args(o, args);
  if (e.tool) {
    const t = CONFIRM_TOOLS[e.tool];
    if (t) return t.describe(a);
  }
  return e.describe?.(o, args) ?? `run ${e.command} ${args.map(quote).join(' ')}`.trim();
}

/** Ask on the terminal. */
async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((done) => rl.question(`${question} [y/N] `, done));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Before a command runs: when it deletes or overwrites and `--yes` was not given, ask (on a terminal) or refuse with
 * the MCP answer. `command` is the action command (to set `--yes` for a command that checks it itself).
 */
export async function confirmBeforeRun(path: string, command: Command, o: Opts, args: string[]): Promise<void> {
  if (o.yes === true || o.dryRun === true) return;
  for (const e of CLI_CONFIRM) {
    if (e.command !== path || (e.when && !e.when(o, args))) continue;
    const what = wouldDo(e, o, args);
    const interactive = !cli.nonInteractive && !!process.stdin.isTTY && !cli.json && !cli.jsonl;
    if (interactive) {
      if (await askYes(`This will ${what}.\nContinue?`)) {
        command.setOptionValue('yes', true);
        return;
      }
      throw Object.assign(new CliError('Cancelled: nothing was changed.', EXIT.CONFIG_ERROR), { hint: `Run it again with --yes to skip this question.` });
    }
    const hint = 'Nothing was changed. Run it again with --yes to confirm (or --dry-run to see what it would change).';
    if (machine()) printJson({ confirmationRequired: true, wouldDo: what, hint, confirm: `testpion ${path} … --yes` });
    throw Object.assign(new CliError(`Confirmation required: this would ${what}.`, EXIT.CONFIG_ERROR), { hint });
  }
}
