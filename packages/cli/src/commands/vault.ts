import type { Command } from 'commander';
import { secretKeys, VAULT_PASSPHRASE_ENV } from '@testpion/core';
import { bold, CliError, cliVault, dim, EXIT, green, JSON_RESULT_OPTION, printJson, red, withWorkspace } from '../shared.js';

/**
 * `testpion secrets vault status|list|set|delete`: the secret store the command line can write to (packages/core/src/storage/vault.ts).
 * A value is never an argument and never printed: `set` reads it from standard input, or from an environment variable
 * (`--from-env`). The app reads the same vault, after its own store; `TESTPION_SECRET_*` variables still win over both.
 */
export function registerVaultCommands(program: Command): void {
  // a group of `secrets` (the command line keeps few top-level words); `secrets <environment>` stays what it was
  const secrets = program.commands.find((c) => c.name() === 'secrets') ?? program.command('secrets');
  const vault = secrets
    .command('vault')
    .description(
      `the secret store the command line can write to: an encrypted file in the app folder that the app reads too. Its key is kept by the operating system (Windows DPAPI, macOS Keychain, Linux Secret Service), or derived from ${VAULT_PASSPHRASE_ENV} when that is set (CI, containers)`,
    );

  vault
    .command('status')
    .description('where the vault is, where its key comes from, how many secrets it holds, and whether it opens here; exit 1 when it does not')
    .option(...JSON_RESULT_OPTION)
    .action((o: { json?: boolean }) => {
      const s = cliVault().status();
      if (o.json) printJson(s);
      else {
        console.log(`${bold('Vault')}  ${s.file}${s.exists ? '' : dim('  (not made yet: `secrets vault set` makes it)')}`);
        console.log(`  key      ${s.key}`);
        console.log(`  secrets  ${s.count}`);
        console.log(`  ${s.usable ? green('opens here') : red(`does not open here: ${s.why}`)}`);
      }
      if (!s.usable) process.exitCode = EXIT.TEST_FAILURE;
    });

  vault
    .command('list')
    .description('the names of the secrets in the vault (never the values)')
    .option(...JSON_RESULT_OPTION)
    .action((o: { json?: boolean }) => {
      const names = cliVault().list().sort();
      if (o.json) return printJson({ secrets: names });
      if (!names.length) return console.log(dim('The vault is empty. `testpion secrets vault set` adds a secret.'));
      for (const n of names) console.log(n);
    });

  const named = (cmd: Command) =>
    cmd
      .argument('<name>', 'the secret variable (with -e or --global), the provider id (with --provider), or the full secret name as `secrets vault list` prints it')
      .option('-e, --environment <name>', 'a secret variable of this environment (needs -w)')
      .option('--global', 'a secret workspace variable (needs -w)')
      .option('--provider', 'the API key of the AI provider with this id')
      .option('-w, --workspace <nameOrPath>', 'the workspace of the environment or the workspace variable');
  type Named = { environment?: string; global?: boolean; provider?: boolean; workspace?: string };
  /** The store's name for what the options say. */
  const nameOf = async (name: string, o: Named): Promise<string> => {
    if (o.provider) return secretKeys.provider(name);
    if (!o.environment && !o.global) return name;
    if (!o.workspace) throw new CliError('Name the workspace with -w: a secret variable belongs to one workspace', EXIT.CONFIG_ERROR);
    return withWorkspace(o.workspace, (store) => {
      if (o.global) return secretKeys.workspaceVar(store.workspace.id, name);
      const env = store.getEnvironment(String(o.environment));
      if (!env) throw new CliError(`No environment "${o.environment}"`, EXIT.CONFIG_ERROR);
      return secretKeys.envVar(env.id, name);
    });
  };

  named(vault.command('set'))
    .description('keep a secret in the vault. The value is read from standard input (one line), or from an environment variable with --from-env; it is never an argument and never printed')
    .option('--from-env <VARIABLE>', 'take the value from this environment variable instead of standard input')
    .option(...JSON_RESULT_OPTION)
    .action(async (name: string, o: Named & { fromEnv?: string; json?: boolean }) => {
      const key = await nameOf(name, o);
      let value: string | undefined;
      if (o.fromEnv) {
        value = process.env[o.fromEnv];
        if (value === undefined) throw new CliError(`The environment variable ${o.fromEnv} is not set`, EXIT.CONFIG_ERROR);
      } else {
        if (process.stdin.isTTY) throw new CliError('Give the value on standard input (for example `printf %s "$TOKEN" | testpion secrets vault set …`) or with --from-env <VARIABLE>: a value typed as an argument would stay in the shell history', EXIT.CONFIG_ERROR);
        // a pipe that never sends anything (a script that forgot the value) is not waited for for ever
        value = await new Promise<string>((resolve, reject) => {
          let s = '';
          const quiet = setTimeout(() => reject(new CliError('No value came on standard input within 10 seconds: pipe it in (`printf %s "$TOKEN" | testpion secrets vault set …`) or use --from-env <VARIABLE>', EXIT.CONFIG_ERROR)), 10_000);
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (d) => (clearTimeout(quiet), (s += d)));
          process.stdin.on('end', () => (clearTimeout(quiet), resolve(s.replace(/\r?\n$/, ''))));
        }).finally(() => process.stdin.pause());
      }
      if (!value) throw new CliError('The value is empty: nothing was kept (`secrets vault delete` removes a secret)', EXIT.CONFIG_ERROR);
      await cliVault().set(key, value);
      if (o.json) printJson({ name: key, set: true });
      else console.log(green(`Kept ${key} in the vault`));
    });

  named(vault.command('delete'))
    .description('remove a secret from the vault')
    .option(...JSON_RESULT_OPTION)
    .action(async (name: string, o: Named & { json?: boolean }) => {
      const key = await nameOf(name, o);
      const store = cliVault();
      const had = store.list().includes(key);
      await store.delete(key);
      if (o.json) printJson({ name: key, deleted: had });
      else console.log(had ? green(`Removed ${key} from the vault`) : dim(`${key} is not in the vault`));
    });
}
