import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import {
  ChainSecretStore,
  createEngineContext,
  EnvSecretStore,
  fetchImportText,
  fuzzCases,
  fuzzMarkdown,
  openApiOutline,
  runFuzz,
  WorkspaceManager,
  type FuzzVerdict,
  type HttpRequestSpec,
} from '@testpion/core';
import { EXIT, bold, dim, green, red, yellow, CliError, openWorkspace } from '../shared.js';

/** `testpion openapi-ops <spec>`: an OpenAPI document's operations, the way its docs read. */
export function registerOpenApiCommands(program: Command): void {
  program
    .command('openapi-ops')
    .description(
      "list an OpenAPI / Swagger document's operations by tag: method, path, summary, parameters, request body and responses (--json adds the schemas as short type outlines and a ready request per operation)",
    )
    .argument('<spec>', 'the document: a file or an http(s) link')
    .option('--tag <tag>', 'only this tag')
    .option('--json', 'print the outline as JSON (for scripts and AI agents)')
    .action(async (ref: string, o: { tag?: string; json?: boolean }) => {
      let outline;
      try {
        outline = openApiOutline(/^https?:\/\//i.test(ref) ? (await fetchImportText(ref)).text : readFileSync(ref, 'utf8'));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      const tags = outline.tags.filter((t) => !o.tag || t.name.toLowerCase() === o.tag.toLowerCase());
      if (o.tag && !tags.length) throw new CliError(`No tag "${o.tag}": ${outline.tags.map((t) => t.name).join(', ')}`, EXIT.CONFIG_ERROR);
      if (o.json) return console.log(JSON.stringify({ ...outline, tags }, null, 2));
      console.log(bold(`${outline.title}${outline.version ? ` ${outline.version}` : ''}: ${outline.operations} operations`) + (outline.servers.length ? dim(`  ${outline.servers.join(', ')}`) : ''));
      for (const t of tags) {
        console.log(`\n${bold(t.name)}${t.description ? dim(`  ${t.description.split('\n')[0]}`) : ''}`);
        for (const op of t.operations) {
          const params = op.parameters.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ');
          const codes = op.responses.map((r) => r.code).join(' ');
          const line = `  ${op.method.padEnd(7)} ${op.path}${op.summary ? dim(`  ${op.summary}`) : ''}${params ? dim(`  (${params})`) : ''}${op.requestBody ? dim(`  body ${op.requestBody.contentType}`) : ''}${codes ? dim(`  → ${codes}`) : ''}`;
          console.log(op.deprecated ? yellow(`${line}  deprecated`) : line);
        }
      }
    });

  program
    .command('fuzz')
    .description(
      'fuzz an API from its OpenAPI document: each operation gets its valid example, then requests that break one rule of the schema at a time (a required field left out, a wrong type, a value outside its enum, range, length or format, a body that is not JSON); reports server errors (5xx), invalid input accepted and undocumented statuses. Local hosts only unless --allow-remote; exit 1 on server errors',
    )
    .argument('<spec>', 'the OpenAPI document: a file or an http(s) link')
    .option('--base-url <url>', "the API's address (default: the document's first server)")
    .option('-e, --environment <name>', 'resolve {{variables}} (tokens, {{baseUrl}}) from this workspace environment')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--operation <op...>', 'only these operations: "POST /patients" or an operationId')
    .option('--var <key=value...>', 'set a variable for the requests (repeatable), e.g. --var accessToken=…')
    .option('--include-delete', 'also fuzz DELETE operations')
    .option('--max <n>', 'at most this many requests per operation', '25')
    .option('--concurrency <n>', 'requests at once (1–8)', '4')
    .option('--allow-remote', 'allow a host that is not local or on a private network (only systems you are authorised to test)')
    .option('--fail-on <verdicts>', 'exit 1 on these findings, comma separated: server-error, accepted-invalid, undocumented-status', 'server-error')
    .option('--markdown <file>', 'also write the findings as Markdown')
    .option('--json', 'print the report as JSON (for scripts and AI agents)')
    .action(
      async (
        ref: string,
        o: {
          baseUrl?: string;
          var?: string[];
          environment?: string;
          workspace?: string;
          operation?: string[];
          includeDelete?: boolean;
          max: string;
          concurrency: string;
          allowRemote?: boolean;
          failOn: string;
          markdown?: string;
          json?: boolean;
        },
      ) => {
        let text: string;
        try {
          text = /^https?:\/\//i.test(ref) ? (await fetchImportText(ref)).text : readFileSync(ref, 'utf8');
        } catch (e) {
          throw new CliError(`Cannot read ${ref}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
        }
        let resolve: ((r: HttpRequestSpec) => HttpRequestSpec) | undefined;
        let close = () => undefined as void;
        const vars = Object.fromEntries((o.var ?? []).map((kv) => (kv.includes('=') ? [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)] : [kv, ''])));
        // without an environment, --var values fill the {{variables}} as they are
        if (!o.environment && Object.keys(vars).length)
          resolve = (r) => JSON.parse(JSON.stringify(r).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (k in vars ? JSON.stringify(vars[k]).slice(1, -1) : m)));
        if (o.environment) {
          const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
          const env = store.getEnvironment(o.environment);
          if (!env) throw new CliError(`No environment "${o.environment}"`, EXIT.CONFIG_ERROR);
          if (env.isProduction) throw new CliError(`${env.name} is a production environment: fuzzing sends invalid and data-changing requests, so it is not run there`, EXIT.CONFIG_ERROR);
          const ctx = createEngineContext({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings: new WorkspaceManager().loadSettings(), environment: o.environment });
          for (const [k, v] of Object.entries(vars)) ctx.vars.set(k, v);
          resolve = (r) => ctx.vars.resolveDeep(r);
          close = () => void ctx.dispose().finally(() => store.close());
        }
        try {
          const baseUrl = o.baseUrl ?? (o.environment && resolve ? resolve({ method: 'GET', url: '{{baseUrl}}' }).url.replace(/\{\{baseUrl\}\}/, '') || undefined : undefined);
          const { cases, operations } = fuzzCases(text, { baseUrl, operations: o.operation, includeDelete: o.includeDelete, maxPerOperation: Number(o.max) || 25 });
          if (!cases.length) throw new CliError('No operations to fuzz (DELETE is left out without --include-delete)', EXIT.CONFIG_ERROR);
          if (!o.json) console.error(dim(`${cases.length} requests to ${operations} operations…`));
          const report = await runFuzz(text, cases, { resolve, allowRemote: o.allowRemote, concurrency: Number(o.concurrency) || 4 }).catch((e: Error) => {
            throw new CliError(e.message, EXIT.CONFIG_ERROR);
          });
          if (o.markdown) writeFileSync(o.markdown, fuzzMarkdown(report));
          if (o.json) console.log(JSON.stringify(report, null, 2));
          else {
            const c = report.counts;
            console.log(
              bold(
                `${report.cases} requests, ${report.operations} operations: ${c['server-error']} server errors, ${c['accepted-invalid']} invalid inputs accepted, ${c['undocumented-status']} undocumented statuses`,
              ),
            );
            const show: Array<[FuzzVerdict, (s: string) => string]> = [
              ['server-error', red],
              ['accepted-invalid', yellow],
              ['undocumented-status', dim],
              ['rejected-valid', dim],
              ['not-authorized', yellow],
              ['failed', red],
            ];
            for (const [v, paint] of show) for (const x of report.results.filter((r) => r.verdict === v)) console.log(paint(`  ${x.case.operation.padEnd(28)} ${x.case.name}: ${x.message}`));
            if (!report.results.some((r) => r.verdict !== 'ok')) console.log(green('  Nothing found: every invalid request was rejected with a documented 4xx.'));
          }
          const failOn = o.failOn.split(',').map((x) => x.trim());
          if (report.results.some((r) => failOn.includes(r.verdict))) process.exitCode = EXIT.TEST_FAILURE;
        } finally {
          close();
        }
      },
    );
}
