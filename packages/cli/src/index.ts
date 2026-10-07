import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import {
  ApsError,
  normalizeError,
  ENGINE_VERSION,
  setProxySettings,
  setTlsTrust,
  prefetchEnvironmentSecrets,
  WorkspaceManager,
} from '@testpion/core';
import { EXIT, red, dim, yellow, CliError, openWorkspace } from './shared.js';
import { registerRunCommands } from './commands/run.js';
import { registerEvaluationCommands } from './commands/evaluations.js';
import { registerServeCommands } from './commands/serve.js';
import { registerDataCommands } from './commands/data.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerMonitorCommands } from './commands/monitor.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerSecretsCommands } from './commands/secrets.js';

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
  registerMonitorCommands(program);
  registerSecretsCommands(program);

  // an environment's secret manager references (op://, vault://, aws-sm:// …) are read before the command runs
  program.hook('preAction', async (_cmd, action) => {
    const o = action.opts() as { environment?: unknown; workspace?: unknown };
    if (typeof o.environment !== 'string' || !o.environment || /\.json$/i.test(o.environment)) return;
    let store;
    try {
      store = openWorkspace(typeof o.workspace === 'string' ? o.workspace : undefined, undefined, new WorkspaceManager()).store;
    } catch {
      return; // the command says what is wrong with the workspace
    }
    try {
      const r = await prefetchEnvironmentSecrets(store, o.environment, { trustAll: true });
      for (const f of r.failed) console.error(yellow(`${f.ref}: ${f.error}`));
    } finally {
      store.close();
    }
  });

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
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return EXIT.SUCCESS;
      return EXIT.CONFIG_ERROR;
    }
    if (e instanceof CliError) {
      console.error(red(e.message));
      return e.exitCode;
    }
    const err = normalizeError(e);
    console.error(red(`${err.kind}: ${err.message}`));
    for (const s of err.suggestions) console.error(dim(`  → ${s}`));
    return e instanceof ApsError && (err.kind === 'ConfigurationError' || err.kind === 'ValidationError' || err.kind === 'SchemaError') ? EXIT.CONFIG_ERROR : EXIT.EXECUTION_ERROR;
  }
}
