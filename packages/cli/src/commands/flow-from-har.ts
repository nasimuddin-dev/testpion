/** `testpion flow from-har <file.har>`: recorded traffic (a HAR file) as a flow file whose steps pass values along. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Command } from 'commander';
import { ApsError, flowFromHar, isSecretRef, recordedFlowPath, Redactor, requireEnvironment, secretKeys } from '@testpion/core';
import { cliSecrets, dim, green, printJson, withWorkspace, yellow, WORKSPACE_OPTION, groupOptions, subcommand } from '../shared.js';

export function registerFlowFromHarCommand(program: Command): void {
  const flow = subcommand(program, 'flow');
  if (!flow) return;
  flow
    .command('from-har')
    .description(
      'make a flow file from recorded traffic (a HAR file: the HTTP Debugger, a browser, Fiddler …): steps in the order the requests were made, each origin as {{baseUrl}}, values that came from an earlier response (tokens, ids, cursors) extracted and passed as {{variables}} with dependsOn, the recorded status checked; static assets, preflights and analytics left out; secrets (Authorization, cookies, API keys, passwords) become variables to set in an environment, never written',
    )
    .argument('<file>', 'the HAR file')
    .option('-o, --out <file>', 'the flow file to write, inside tests/ (default: tests/recorded/<name>.yaml)')
    .option('--name <name>', "the flow's name (default: the HAR file's name)")
    .option('-e, --environment <name>', 'use the variables of this environment that hold an origin or a secret that was sent')
    .option('--keep-noise', 'keep static assets, preflights and analytics requests')
    .option('--noise-host <host...>', 'more hosts to leave out as telemetry')
    .option('--dry-run', 'print the flow without writing it')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print { file, steps, links, variables, secrets, dropped, notes, text } as JSON (for scripts and AI agents)')
    .action(async (file: string, o: { out?: string; name?: string; environment?: string; keepNoise?: boolean; noiseHost?: string[]; dryRun?: boolean; workspace?: string; json?: boolean }) => {
      const workspace = groupOptions(flow, o);
      if (!existsSync(file)) throw new ApsError('ValidationError', `No file ${file}`);
      const text = readFileSync(file, 'utf8');
      return withWorkspace(workspace, (store) => {
        const name = o.name?.trim() || basename(file, extname(file));
        const env = o.environment ? requireEnvironment(store, o.environment) : undefined;
        const secrets = cliSecrets();
        const r = flowFromHar(text, {
          name,
          source: basename(file),
          redactor: new Redactor(),
          keepNoise: o.keepNoise,
          extraNoiseHosts: o.noiseHost,
          environment: env && {
            name: env.name,
            variables: env.variables
              .filter((v) => !isSecretRef(v.value))
              .map((v) => ({ key: v.key, enabled: v.enabled, value: v.secret ? (secrets.get(secretKeys.envVar(env.id, v.key)) ?? '') : v.value })),
          },
        });
        let path = o.out ? o.out.replace(/\\/g, '/').replace(/^(\.\/)?tests\//, '') : recordedFlowPath(name);
        if (!/\.ya?ml$/i.test(path)) throw new ApsError('ValidationError', '--out is a .yaml file inside tests/ (e.g. tests/recorded/checkout.yaml)');
        if (!o.out) for (let i = 2; existsSync(store.safePath(path, store.path('tests'))); i++) path = recordedFlowPath(name).replace(/\.yaml$/, `-${i}.yaml`);
        if (!o.dryRun) store.writeTestFile(path, r.text);
        if (o.json) return printJson({ file: `tests/${path}`, written: !o.dryRun, ...r });
        if (o.dryRun) return void process.stdout.write(r.text);
        console.log(
          `${green('wrote')} tests/${path}  ${dim(`(${r.steps.length} steps, ${r.links.length} values passed between them${r.dropped.length ? `, ${r.dropped.length} exchanges left out` : ''})`)}`,
        );
        for (const l of r.links) console.log(dim(`  ${l.source === 'cookie jar' ? l.variable : `{{${l.variable}}}`} from step ${l.fromIndex} (${l.source}) → ${l.target} in step ${l.toIndex}`));
        for (const n of r.notes) console.error(yellow(`  ${n}`));
      });
    });
}
