import type { Command } from 'commander';
import { environmentSecretRefs, externalSecrets, prefetchEnvironmentSecrets, secretRefCommand, WorkspaceManager, type Environment } from '@testpion/core';
import { EXIT, green, red, dim, bold, CliError, openWorkspace } from '../shared.js';

/** `testpion secrets <environment>`: the environment's secret manager references, and whether each one can be read here. */
export function registerSecretsCommands(program: Command): void {
  program
    .command('secrets')
    .description(
      "check an environment's secret manager references (op://, vault://, aws-sm://, azure-kv://, gcp-sm://): each is read with its tool, the value never printed; exit 1 when one cannot be read",
    )
    .argument('<environment>', 'environment name or id')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (environment: string, o: { workspace?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      let env: Environment | undefined;
      const root = store.root;
      let failed: Array<{ ref: string; error: string }> = [];
      try {
        env = store.getEnvironment(environment);
        if (env) failed = (await prefetchEnvironmentSecrets(store, environment, { trustAll: true })).failed;
      } finally {
        store.close();
      }
      if (!env) throw new CliError(`No environment "${environment}"`, EXIT.CONFIG_ERROR);
      const refs = environmentSecretRefs(env);
      // every reference is read (the CLI reads them, as it reads $env); the values are never printed
      const rows = env.variables
        .filter((v) => refs.includes(v.value.trim()))
        .map((v) => {
          let manager = '';
          try {
            manager = secretRefCommand(v.value).label;
          } catch {
            /* reported as not read */
          }
          return { key: v.key, ref: v.value.trim(), manager, read: externalSecrets.get(v.value, root) !== undefined, error: failed.find((f) => f.ref === v.value.trim())?.error };
        });
      if (o.json) console.log(JSON.stringify({ environment: env.name, references: rows }, null, 2));
      else if (!rows.length) console.log(dim(`${env.name} has no secret manager references.`));
      else {
        console.log(bold(`${env.name}: ${rows.length} reference${rows.length === 1 ? '' : 's'}`));
        for (const r of rows)
          console.log(
            `  ${r.read ? green('✓') : red('✗')} ${r.key.padEnd(24)} ${dim(r.ref)}${r.manager ? dim(` (${r.manager})`) : ''}${
              r.error
                ? red(`
      ${r.error}`)
                : ''
            }`,
          );
      }
      if (rows.some((r) => !r.read)) process.exitCode = EXIT.TEST_FAILURE;
    });
}
