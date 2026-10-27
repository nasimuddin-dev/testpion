import { Command } from 'commander';
import { oauth2TokenOf } from '@testpion/core';
import { bold, cliContext, dim, green, respond, withWorkspace, WORKSPACE_OPTION } from '../shared.js';

/** `testpion auth token`: the CLI twin of "Get token" in the Authorization tab and the MCP tool auth_token. */
export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('authorization tools');
  auth
    .command('token')
    .description('run the OAuth 2.0 grant of a collection or one of its requests now, and say whether it works, when the token ends and its scope (the token itself is masked)')
    .argument('<collection>', 'collection name or id')
    .argument('[request]', 'a request of it (its own, folder or collection auth is used)')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'the environment whose variables fill the auth fields')
    .option('--cached', 'use the token already cached when there is one (default: ask the server for a new one)')
    .action((collection: string, request: string | undefined, o: { workspace?: string; environment?: string; cached?: boolean }) =>
      withWorkspace(o.workspace, async (store) => {
        const ctx = cliContext(store, o.environment);
        try {
          const t = await oauth2TokenOf(store, ctx, { collection, request, fresh: !o.cached });
          respond(t, () => {
            console.log(`${green('Token received')} ${dim(`(${t.grantType}, from the ${t.from})`)}`);
            console.log(`${bold('Token')}    ${t.tokenMasked}`);
            console.log(`${bold('Ends')}     ${t.expiresAt} ${dim(`(in ${t.expiresInSeconds} s)`)}`);
            if (t.scope) console.log(`${bold('Scope')}    ${t.scope}`);
            console.log(`${bold('Refresh')}  ${t.hasRefreshToken ? 'yes' : 'no'}`);
          });
        } finally {
          await ctx.dispose();
        }
      }),
    );
}
