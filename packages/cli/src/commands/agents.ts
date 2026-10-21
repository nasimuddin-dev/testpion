/**
 * `testpion agents init`: AGENTS.md (and, when asked, a CLAUDE.md pointer and a Cursor rule) in the workspace root,
 * written from the live workspace. Only TestPion's marked part of each file is ever replaced; the report says what was
 * created, updated, left unchanged or skipped (and why). `agents-md` is the 0.45 name, kept as an alias.
 */
import { Command } from 'commander';
import { ApsError, agentWorkspaceFacts, initAgentFiles, parseAgentTargets, renderAgentsMd, type AgentsInitResult } from '@testpion/core';
import { EXIT, bold, CliError, dim, green, printJson, red, withWorkspace, yellow, WORKSPACE_OPTION } from '../shared.js';

interface InitOptions {
  workspace?: string;
  targets?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

function targetsOf(v: string | undefined) {
  try {
    return parseAgentTargets(v);
  } catch (e) {
    throw new CliError((e as ApsError).message, EXIT.CONFIG_ERROR);
  }
}

function print(r: AgentsInitResult): void {
  const mark = { created: green('created  '), updated: green('updated  '), unchanged: dim('unchanged'), skipped: yellow('skipped  ') } as const;
  console.log(bold(`${r.dryRun ? 'Would write' : 'Agent files'} for "${r.workspace}"`) + dim(`  (${r.root})`));
  for (const f of r.files) console.log(`  ${mark[f.status]} ${f.path}${f.reason ? dim(`  ${f.reason}`) : ''}`);
  if (r.files.some((f) => f.status === 'skipped')) console.log(red('Some files were not written: see the reasons above.'));
}

const init = (o: InitOptions) =>
  withWorkspace(o.workspace, (store, ephemeral) => {
    if (ephemeral) throw new CliError('No workspace found: run inside a workspace folder or pass -w <name|path>', EXIT.CONFIG_ERROR);
    const r = initAgentFiles(store, { targets: targetsOf(o.targets), force: o.force, dryRun: o.dryRun });
    if (o.json) printJson(r);
    else print(r);
    // a file left alone because its markers are broken: the caller (a script, an agent) must see it
    if (r.files.some((f) => f.status === 'skipped')) process.exitCode = EXIT.CONFIG_ERROR;
  });

export function registerAgentsCommands(program: Command): void {
  const agents = program.command('agents').description('files that tell AI coding agents (Claude Code, Codex, Cursor, Copilot …) how to work with this workspace');
  agents
    .command('init')
    .description(
      'write AGENTS.md into the workspace root (and with --targets also a CLAUDE.md pointer and .cursor/rules/testpion.mdc): its folders, collections, environments (names only), tests and flows, the commands and exit codes, the MCP server, secrets and production rules. Only the part between <!-- testpion:begin --> and <!-- testpion:end --> is replaced; your own text stays',
    )
    .option(...WORKSPACE_OPTION)
    .option('--targets <list>', 'which files: agents (AGENTS.md, always), claude (CLAUDE.md), cursor (.cursor/rules/testpion.mdc); comma-separated', 'agents')
    .option('--force', 'repair broken markers (a missing begin or end, two blocks) instead of skipping the file')
    .option('--dry-run', 'report what would be written, write nothing')
    .option('--json', 'print { workspace, root, dryRun, files: [{ target, path, status, reason? }] } (status: created, updated, unchanged, skipped)')
    .action((o: InitOptions) => init(o));
  program
    .command('agents-md')
    .description('the TestPion part of AGENTS.md (same as `agents init`; --stdout prints it instead)')
    .option(...WORKSPACE_OPTION)
    .option('--stdout', 'print it instead of writing the file')
    .option('--json', 'print the report as JSON')
    .action((o: { workspace?: string; stdout?: boolean; json?: boolean }) => {
      if (!o.stdout) return init({ workspace: o.workspace, json: o.json });
      return withWorkspace(o.workspace, (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace folder or pass -w <name|path>', EXIT.CONFIG_ERROR);
        process.stdout.write(renderAgentsMd(agentWorkspaceFacts(store)));
      });
    });
}
