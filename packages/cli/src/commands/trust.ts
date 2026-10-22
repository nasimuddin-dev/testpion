import type { Command } from 'commander';
import { forgetHost, forgetSecretReads, forgetTrustedCommands, trustSummary } from '@testpion/core';
import { dim, bold, printJson, withWorkspace, WORKSPACE_OPTION, JSON_RESULT_OPTION } from '../shared.js';

/** `testpion trust list|forget`: what the user allowed this workspace on this computer (programs, script hosts, secret reads). */
export function registerTrustCommands(program: Command): void {
  const trust = program.command('trust').description("what you allowed a workspace on this computer: the programs it may start, the hosts its scripts may reach, reading secrets (kept outside the workspace)");
  trust
    .command('list')
    .description('list the decisions for the workspace')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const s = trustSummary(store);
        if (o.json) return printJson(s);
        if (!s.commands.length && !s.hosts.length && !s.secretReads) return console.log(dim('Nothing is allowed for this workspace.'));
        for (const c of s.commands) console.log(`${bold('program')}  ${[c.command, ...c.args].join(' ')}  ${dim(c.at)}`);
        for (const h of s.hosts) console.log(`${bold('host')}     ${h.host === '*' ? 'any host' : h.host}  ${dim(h.at)}`);
        if (s.secretReads) console.log(`${bold('secrets')}  scripts may read secret variables  ${dim(s.secretReads.at)}`);
      }),
    );
  trust
    .command('forget')
    .description('forget decisions: one host (--host), the secret reads (--secrets), or everything (--all)')
    .option('--host <host>', 'forget this host')
    .option('--secrets', 'forget that scripts may read secrets')
    .option('--all', 'forget every decision, programs included')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action((o: { workspace?: string; json?: boolean; host?: string; secrets?: boolean; all?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        if (o.all || (!o.host && !o.secrets)) forgetTrustedCommands(store);
        if (o.host) forgetHost(store, o.host);
        if (o.secrets) forgetSecretReads(store);
        const s = trustSummary(store);
        if (o.json) return printJson(s);
        console.log(dim('Forgotten.'));
      }),
    );
}
