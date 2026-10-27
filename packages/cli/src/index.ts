import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import {
  ApsError,
  normalizeError,
  ENGINE_VERSION,
  setProxySettings,
  setTlsTrust,
  prefetchEnvironmentSecrets,
  setProductionAllowedByDefault,
  useMcpSdkBundle,
} from '@testpion/core';
import { EXIT, red, dim, yellow, CliError, withWorkspace } from './shared.js';
import { applyCliContract, commandFromArgv } from './contract.js';
import { beginCommand, cli, finishOutput, machine, noteWarning } from './output.js';
import { describeDryRun, finishDryRun } from './dry-run.js';
import { PlanOnly } from './plan.js';
import { regroup, rewriteLegacy } from './groups.js';
import { registerRunCommands } from './commands/run.js';
import { registerEvaluationCommands } from './commands/evaluations.js';
import { registerServeCommands } from './commands/serve.js';
import { registerDataCommands } from './commands/data.js';
import { registerImportCommands } from './commands/import.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerMonitorCommands } from './commands/monitor.js';
import { registerDoctorCommand, registerDiagnosticsCommand } from './commands/doctor.js';
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
import { registerAiSpecCommands } from './commands/ai-spec.js';
import { registerAiSecurityCommands } from './commands/ai-security.js';
import { registerAiDriftCommand } from './commands/ai-drift.js';
import { registerFlowsCommand } from './commands/flows.js';
import { registerFlowCommand } from './commands/flow.js';
import { registerFlowExportCommand } from './commands/flow-export.js';
import { registerFlowFromHarCommand } from './commands/flow-from-har.js';
import { registerFlowGenerateCommand } from './commands/flow-generate.js';
import { registerFlowReportCommand } from './commands/flow-scale.js';
import { registerTestFromCommand } from './commands/test-from.js';
import { registerAiCommands } from './commands/ai.js';
import { registerKindsCommand } from './commands/kinds.js';
import { registerRagCommands } from './commands/rag.js';
import { registerItemCommand } from './commands/item.js';
import { registerOutputCommand } from './commands/output.js';
import { registerBundleCommands } from './commands/bundle.js';
import { registerTrustCommands } from './commands/trust.js';
import { registerSettingsCommands } from './commands/settings.js';
import { registerAuthCommands } from './commands/auth.js';

/** The commands that send to APIs with an environment (by their path): they take --allow-production. */
const SENDING_COMMANDS = new Set(['test', 'run', 'run-collection', 'load', 'send', 'monitor add', 'monitor run', 'monitor start', 'eval run', 'serve flows', 'ai attempt-fix', 'rag probe', 'security generate', 'security run']);

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
  registerImportCommands(program);
  registerWorkspaceCommands(program);
  registerDoctorCommand(program);
  registerDiagnosticsCommand(program);
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
  registerAiSpecCommands(program);
  registerAiSecurityCommands(program);
  registerAiDriftCommand(program);
  registerFlowsCommand(program);
  registerFlowCommand(program);
  registerFlowExportCommand(program);
  registerFlowFromHarCommand(program);
  registerFlowGenerateCommand(program);
  registerFlowReportCommand(program);
  registerTestFromCommand(program);
  registerAiCommands(program);
  registerKindsCommand(program);
  registerBundleCommands(program);
  registerRagCommands(program);
  registerItemCommand(program);
  registerOutputCommand(program);
  registerTrustCommands(program);
  registerSettingsCommands(program);
  registerAuthCommands(program);

  // WF-06: the commands that send take --allow-production; without it the engine refuses data-changing requests to an
  // environment marked as production (GETs still run, so a smoke run against production works as before)
  const all = (c: Command): Command[] => [c, ...c.commands.flatMap(all)];
  const path = (c: Command): string => (c.parent && c.parent !== program ? `${path(c.parent)} ${c.name()}` : c.name());
  for (const c of all(program)) {
    if (!SENDING_COMMANDS.has(path(c))) continue;
    c.option('--allow-production', 'allow data-changing requests (POST, PUT, PATCH, DELETE, mutations …) to an environment marked as production');
    c.option('--trust-scripts', "let the workspace's scripts read secret variables and send requests to any host (otherwise only hosts the workspace was allowed to reach; or set TESTPION_TRUST_SCRIPTS=1)");
  }
  program.hook('preAction', (_cmd, action) => {
    if ((action.opts() as { trustScripts?: unknown }).trustScripts === true) process.env.TESTPION_TRUST_SCRIPTS = '1';
    // `mcp-server --allow-production` is the server's own gate (each tool call still passes allowProduction)
    if (path(action) !== 'mcp-server') setProductionAllowedByDefault((action.opts() as { allowProduction?: unknown }).allowProduction === true);
  });

  // test hook: a rejection nobody awaits while the command runs, to see what a crash looks like from outside (tests/unit/robustness-fixes.test.ts)
  if (process.env.TESTPION_TEST_CRASH === 'reject')
    program.hook('preAction', async () => {
      void Promise.reject(new Error('detached rejection (test)'));
      await new Promise((r) => setTimeout(r, 100));
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
  regroup(program);
  applyCliContract(program);
  return program;
}

/** Set once the command has answered (its envelope is written): a crash after that cannot add a second one. */
let answered = false;
let crashed = false;
let running: { program: Command; argv: string[] } | undefined;

/**
 * An exception or rejection nobody caught (a late trace flush, a socket error after the answer): a crash, not a failed test. Node's default
 * ends the process with code 1 (= EXIT.TEST_FAILURE) and a --json caller gets no envelope. This prints the error, answers --json with the
 * envelope (exit code 3) when the command has not answered yet, and returns the exit code to use.
 */
export function reportCrash(e: unknown): number | undefined {
  const err = normalizeError(e);
  console.error(red(`${err.kind}: ${err.message}`));
  if (process.env.TESTPION_DEBUG && e instanceof Error && e.stack) console.error(dim(e.stack));
  if (answered) return undefined; // the command's result stands: its exit code is already set
  answered = crashed = true;
  try {
    // the command may not have started (the crash came first): a --json caller still gets its envelope
    if (!cli.command && running?.argv.includes('--json')) beginCommand(commandFromArgv(running.program, running.argv), { json: true }, true);
    finishOutput(EXIT.EXECUTION_ERROR, e);
  } catch {
    /* the output itself is what failed */
  }
  return EXIT.EXECUTION_ERROR;
}

/** What to try after a wrong command or option: the nearest command (by spelling), and where the list is. */
function commanderHint(program: Command, argv: string[], e: CommanderError): string {
  const base = commandFromArgv(program, argv);
  const at = base.split(' ').filter(Boolean).reduce<Command>((c, w) => c.commands.find((x) => x.name() === w) ?? c, program);
  const help = `${['testpion', base].filter(Boolean).join(' ')} --help lists ${e.code === 'commander.unknownOption' ? 'the options' : 'the commands'}.`;
  if (e.code !== 'commander.unknownCommand') return help;
  const m = /unknown command '([^']+)'/.exec(e.message);
  const word = m?.[1] ?? '';
  const names = at.commands.flatMap((c) => [c.name(), ...c.aliases()]);
  const near = names.map((n) => ({ n, d: editDistance(word.toLowerCase(), n.toLowerCase()) })).sort((a, b) => a.d - b.d)[0];
  const maybe = near && near.d <= Math.max(2, Math.floor(word.length / 3)) ? `Did you mean ${['testpion', base, near.n].filter(Boolean).join(' ')}? ` : '';
  return maybe + help;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

export async function main(args = process.argv): Promise<number> {
  // the old spellings (`openapi-lint`, `lint-tests`, `mock-mcp` …) are the commands they became (groups.ts)
  const argv = rewriteLegacy(args);
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
  // the MCP SDK as one file, when the build made it (see core's mcp-server/sdk.ts)
  const sdkFile = fileURLToPath(new URL('./mcp-sdk.cjs', import.meta.url));
  if (existsSync(sdkFile)) useMcpSdkBundle(sdkFile);
  const program = buildProgram();
  program.exitOverride();
  running = { program, argv };
  let code: number;
  let error: unknown;
  try {
    await program.parseAsync(argv);
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    if (e instanceof PlanOnly) {
      // a git command's dry run: its plan was printed instead of running it
      code = EXIT.SUCCESS;
      cli.dryRun = { changes: [], applied: false, plan: e.plan };
      if (!machine()) console.log(`Dry run: nothing was changed. It would ${String(e.plan.would)}.`);
    } else if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return EXIT.SUCCESS;
      // a wrong argument: the command never started, but a --json caller still gets the envelope
      if (!cli.command && argv.includes('--json'))
        beginCommand(commandFromArgv(program, argv), { json: true }, true);
      code = EXIT.CONFIG_ERROR;
      const msg = e.message.replace(/^error: /, '');
      const hint = commanderHint(program, argv, e);
      error = Object.assign(new CliError(msg, code), { hint });
      if (!machine()) console.error(dim(`  → ${hint}`));
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
      code = e instanceof ApsError && (err.kind === 'ConfigurationError' || err.kind === 'ValidationError' || err.kind === 'SchemaError' || err.kind === 'ConflictError') ? EXIT.CONFIG_ERROR : EXIT.EXECUTION_ERROR;
      error = e;
    }
  }
  // a dry run: what would have changed (nothing was)
  const dry = finishDryRun();
  if (dry) {
    cli.dryRun = dry;
    if (!machine()) console.log(describeDryRun(dry));
  }
  if (crashed) return EXIT.EXECUTION_ERROR; // a crash already answered (envelope, exit 3)
  answered = true;
  finishOutput(code, error);
  // a script that reads the text: the --json form answers with a structured error
  if (code > 1 && !machine() && cli.canJson && !process.stdout.isTTY) console.error(dim(`For a machine-readable error, run it again with --json (status, errors: [{ code, message, hint, retryable }]).`));
  return code;
}

// `node dist/index.js …` works like `node bin/testpion.js …` (the library module used to print nothing and exit 0)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().then((code) => (process.exitCode = code));
