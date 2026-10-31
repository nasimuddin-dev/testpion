import type { Command } from 'commander';
import { environmentSecretRefs, externalSecrets, missingSecrets, prefetchEnvironmentSecrets, secretRefCommand, type Environment } from '@testpion/core';
import { cliSecrets, EXIT, green, red, dim, bold, CliError, printJson, withWorkspace, WORKSPACE_OPTION, JSON_RESULT_OPTION } from '../shared.js';

/** `testpion secrets <environment>`: the environment's secret manager references, and whether each one can be read here. */
export function registerSecretsCommands(program: Command): void {
  program
    .command('secrets')
    .description(
      "check an environment's secret manager references (op://, vault://, aws-sm://, azure-kv://, gcp-sm://): each is read with its tool, the value never printed; exit 1 when one cannot be read",
    )
    .argument('[environment]', 'environment name or id')
    .option('--missing', 'instead: list the secret variables (of every environment and the globals) that have no value here, with the environment variable that gives each one to the CLI and CI; exit 1 when one is missing')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (environment: string | undefined, o: { workspace?: string; json?: boolean; missing?: boolean }) => {
      if (o.missing) {
        const r = await withWorkspace(o.workspace, (store) => missingSecrets(store, cliSecrets()));
        if (o.json) printJson(r);
        else {
          console.log(r.count ? red(r.text) : green(r.text));
          for (const i of r.items) console.log(`  ${(i.environment ?? 'globals').padEnd(16)} ${i.key.padEnd(24)} ${dim(i.envVar)}`);
        }
        if (r.count) process.exitCode = EXIT.TEST_FAILURE;
        return;
      }
      if (!environment) throw new CliError('Name an environment, or pass --missing', EXIT.CONFIG_ERROR);
      const { env, root, failed } = await withWorkspace(o.workspace, async (store) => {
        const found: Environment | undefined = store.getEnvironment(environment);
        return { env: found, root: store.root, failed: found ? (await prefetchEnvironmentSecrets(store, environment, { trustAll: true })).failed : [] };
      });
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
      if (o.json) printJson({ environment: env.name, references: rows });
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
