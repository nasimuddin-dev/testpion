import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import {
  ApsError,
  normalizeError,
  ENGINE_VERSION,
  setProxySettings,
  setTlsTrust,
  prefetchEnvironmentSecrets,
  setProductionAllowedByDefault,
} from '@testpion/core';
import { EXIT, red, dim, yellow, CliError, withWorkspace } from './shared.js';
import { applyCliContract, commandFromArgv } from './contract.js';
import { beginCommand, cli, finishOutput, machine, noteWarning } from './output.js';
import { describeDryRun, finishDryRun } from './dry-run.js';
import { registerRunCommands } from './commands/run.js';
import { registerEvaluationCommands } from './commands/evaluations.js';
import { registerServeCommands } from './commands/serve.js';
import { registerDataCommands } from './commands/data.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerMonitorCommands } from './commands/monitor.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerAgentInfoCommand } from './commands/agent-info.js';
import { registerAgentsCommands } from './commands/agents.js';
import { registerOpenCommand } from './commands/open.js';
import { registerSecretsCommands } from './commands/secrets.js';
import { registerHistoryCommands } from './commands/history.js';
import { registerOpenApiCommands } from './commands/openapi.js';
import { registerGenerateCommands } from './commands/generate.js';
import { registerReplaceCommands } from './commands/replace.js';
import { registerVarsMoveCommand } from './commands/vars-move.js';
import { registerTidyCommand } from './commands/tidy.js';
import { registerFlowsCommand } from './commands/flows.js';
import { registerFlowCommand } from './commands/flow.js';
import { registerFlowExportCommand } from './commands/flow-export.js';
import { registerFlowFromHarCommand } from './commands/flow-from-har.js';
import { registerFlowGenerateCommand } from './commands/flow-generate.js';
import { registerFlowReportCommand } from './commands/flow-scale.js';
import { registerTestFromCommand } from './commands/test-from.js';
import { registerAiCommands } from './commands/ai.js';

/** The commands that send to APIs with an environment (by their path): they take --allow-production. */
export const SENDING_COMMANDS = new Set(['test', 'run', 'run-collection', 'load', 'send', 'monitor add', 'monitor run', 'monitor start', 'eval run', 'serve flows']);

/** The testpion command line: one module per area of commands (commands/*.ts). */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('testpion')
    .description('TestPion CLI — run REST, GraphQL, MCP and AI tests locally and in CI/CD.\n\nExit codes: 0 success · 1 test failure · 2 configuration error · 3 execution error')
    .version(ENGINE_VERSION);

  registerRunCommands(program);
  registerEvaluationCommands(program);
  registerServeCommands(program);
  registerDataCommands(program);
  registerWorkspaceCommands(program);
  registerDoctorCommand(program);
  registerAgentInfoCommand(program);
  registerAgentsCommands(program);
  registerOpenCommand(program);
  registerMonitorCommands(program);
  registerSecretsCommands(program);
  registerHistoryCommands(program);
  registerOpenApiCommands(program);
  registerGenerateCommands(program);
  registerReplaceCommands(program);
  registerVarsMoveCommand(program);
  registerTidyCommand(program);
  registerFlowsCommand(program);
  registerFlowCommand(program);
  registerFlowExportCommand(program);
  registerFlowFromHarCommand(program);
  registerFlowGenerateCommand(program);
  registerFlowReportCommand(program);
  registerTestFromCommand(program);
  registerAiCommands(program);

  // WF-06: the commands that send take --allow-production; without it the engine refuses data-changing requests to an
  // environment marked as production (GETs still run, so a smoke run against production works as before)
  const all = (c: Command): Command[] => [c, ...c.commands.flatMap(all)];
  const path = (c: Command): string => (c.parent && c.parent !== program ? `${path(c.parent)} ${c.name()}` : c.name());
  for (const c of all(program)) if (SENDING_COMMANDS.has(path(c))) c.option('--allow-production', 'allow data-changing requests (POST, PUT, PATCH, DELETE, mutations …) to an environment marked as production');
  program.hook('preAction', (_cmd, action) => {
    // `mcp-server --allow-production` is the server's own gate (each tool call still passes allowProduction)
    if (path(action) !== 'mcp-server') setProductionAllowedByDefault((action.opts() as { allowProduction?: unknown }).allowProduction === true);
  });

  // an environment's secret manager references (op://, vault://, aws-sm:// …) are read before the command runs
  program.hook('preAction', async (_cmd, action) => {
    const o = action.opts() as { environment?: unknown; workspace?: unknown };
    if (typeof o.environment !== 'string' || !o.environment || /\.json$/i.test(o.environment)) return;
    const environment = o.environment;
    let r: Awaited<ReturnType<typeof prefetchEnvironmentSecrets>>;
    try {
      r = await withWorkspace(typeof o.workspace === 'string' ? o.workspace : undefined, (store) => prefetchEnvironmentSecrets(store, environment, { trustAll: true }));
    } catch (e) {
      if (e instanceof CliError) return; // the command says what is wrong with the workspace
      throw e;
    }
    for (const f of r.failed) {
      console.error(yellow(`${f.ref}: ${f.error}`));
      noteWarning(`${f.ref}: ${f.error}`);
    }
  });

  // the same options and output for every command: --json envelope, --jsonl, --dry-run, --non-interactive (contract.ts)
  applyCliContract(program);
  return program;
}

export async function main(argv = process.argv): Promise<number> {
  // HTTP_PROXY / HTTPS_PROXY / NO_PROXY apply to everything the CLI sends (curl-style)
  setProxySettings({ mode: process.env.TESTPION_NO_PROXY ? 'off' : 'env' });
  // TESTPION_USE_SYSTEM_CA=1 trusts the OS certificate store; TESTPION_CA_FILE adds CA certificates (PEM).
  // (Node's own NODE_EXTRA_CA_CERTS works too.)
  if (process.env.TESTPION_USE_SYSTEM_CA || process.env.TESTPION_CA_FILE) {
    try {
      setTlsTrust({ systemCa: !!process.env.TESTPION_USE_SYSTEM_CA, extraCa: process.env.TESTPION_CA_FILE ? readFileSync(process.env.TESTPION_CA_FILE, 'utf8') : undefined });
    } catch (e) {
      console.error(red(`TESTPION_CA_FILE: ${(e as Error).message}`));
      return EXIT.CONFIG_ERROR;
    }
  }
  const program = buildProgram();
  program.exitOverride();
  let code: number;
  let error: unknown;
  try {
    await program.parseAsync(argv);
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return EXIT.SUCCESS;
      // a wrong argument: the command never started, but a --json caller still gets the envelope
      if (!cli.command && argv.includes('--json'))
        beginCommand(commandFromArgv(program, argv), { json: true }, true);
      code = EXIT.CONFIG_ERROR;
      error = new CliError(e.message.replace(/^error: /, ''), code);
    } else if (e instanceof CliError) {
      console.error(red(e.message));
      const hint = (e as { hint?: unknown }).hint;
      if (typeof hint === 'string') console.error(dim(`  → ${hint}`));
      code = e.exitCode;
      error = e;
    } else {
      const err = normalizeError(e);
      console.error(red(`${err.kind}: ${err.message}`));
      for (const s of err.suggestions) console.error(dim(`  → ${s}`));
      code = e instanceof ApsError && (err.kind === 'ConfigurationError' || err.kind === 'ValidationError' || err.kind === 'SchemaError') ? EXIT.CONFIG_ERROR : EXIT.EXECUTION_ERROR;
      error = e;
    }
  }
  // a dry run: what would have changed (nothing was)
  const dry = finishDryRun();
  if (dry) {
    cli.dryRun = dry;
    if (!machine()) console.log(describeDryRun(dry));
  }
  finishOutput(code, error);
  // a script that reads the text: the --json form answers with a structured error
  if (code > 1 && !machine() && cli.canJson && !process.stdout.isTTY) console.error(dim(`For a machine-readable error, run it again with --json (status, errors: [{ code, message, hint, retryable }]).`));
  return code;
}
