/** Moving data in and out: import, export, docs, script conversion, response history and environments. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  WorkspaceManager,
  formatDuration,
  importRequestSnippet,
  compareHistory,
  responseTimeStats,
  ciConfig,
  compareEnvironments,
  environmentMatrix,
  compareRequestAcrossEnvironments,
  collectionRequests,
  createEngineContext,
  ChainSecretStore,
  EnvSecretStore,
  type CiProvider,
  type WorkspaceStore,
  convertCollectionScripts,
  redactDiff,
  isRequestSnippet,
  Redactor,
  collectionMarkdown,
  collectionHtml,
  exportPostmanCollection,
  exportPostmanEnvironment,
  type CollectionNode,
  fetchImportText,
  readBrunoFolder,
  collectionToBru,
  collectionToHttpFile,
  type Environment,
  bundleWsdl,
  isWsdl,
  importIntoWorkspace,
  diffOpenApi,
  lintOpenApi,
  OPENAPI_LINT_RULES,
  type OpenApiLintSeverity,
  type OpenApiLintResult,
  workspaceApiCoverage,
  apiCoverageMarkdown,
  securityLint,
  findEnvironment,
  setEnvironmentVariables,
  unsetEnvironmentVariables,
  variableFlow,
  collectionToOpenApiText,
  variableUsages,
  renameVariable,
  historyToHar,
  collectionSavedItems,
  listWorkspaceDatasets,
  workspaceReportHtml,
  collectionVariableFlow,
  referencedVariableNames,
  loadHistory,
  workspaceStorage,
  deleteRunsBefore,
  listCertificates,
  workspaceAttention,
  decodeJwt,
  describeExpiry,
  recordCertificate,
  checkCertificate,
  certificateLint,
  mcpToolUsage,
  llmUsage,
  testHistory,
  summarizeTestHistory,
  flakyTests,
  scoreTrend,
} from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, CliError, openWorkspace, loadCollectionRef, findWorkspaceUp } from '../shared.js';

export function registerDataCommands(program: Command): void {
  program
    .command('lint')
    .description("review a collection's requests: secrets typed in instead of secret variables, secrets in query strings, plain http to other hosts, turned-off TLS checks, and {{variables}} nothing defines")
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <name>', 'environment whose variables count as defined (for the variables check)')
    .addOption(new Option('--fail-on <severity>', 'exit 1 when a finding is at least this severe').choices(['high', 'medium', 'low']))
    .option('--json', 'print the findings as JSON')
    .action(async (ref: string, o: { workspace?: string; environment?: string; failOn?: 'high' | 'medium' | 'low'; json?: boolean }) => {
      const c = await loadCollectionRef(ref, o.workspace);
      const settings = new WorkspaceManager().loadSettings();
      // variables: those of the environment, collection, workspace and globals count as defined
      let known: string[] = [];
      let certs: ReturnType<typeof certificateLint> = [];
      try {
        const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
        const ctx = createEngineContext({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings, environment: o.environment });
        known = Object.keys(ctx.vars.toObject());
        certs = certificateLint(c, (u) => ctx.vars.resolve(u), listCertificates(store));
        await ctx.dispose();
        store.close();
      } catch {
        /* a collection file outside a workspace: only its own variables */
      }
      const findings = [...securityLint(c, settings.redactFields), ...certs, ...variableFlow(c, known)];
      if (o.json) console.log(JSON.stringify(findings, null, 2));
      else if (!findings.length) console.log(green(`No findings in "${c.name}".`));
      else {
        for (const f of findings) console.log(`${f.severity === 'high' ? red('high  ') : f.severity === 'medium' ? yellow('medium') : dim('low   ')} ${f.message}\n       ${dim(f.where)}`);
        console.log(bold(`\n${findings.length} finding${findings.length > 1 ? 's' : ''}`));
      }
      const rank = { high: 3, medium: 2, low: 1 };
      if (o.failOn && findings.some((f) => rank[f.severity] >= rank[o.failOn!])) process.exitCode = EXIT.TEST_FAILURE;
    });
  const varsCmd = program.command('vars').description('where a variable is used, and renaming it everywhere in a workspace');
  varsCmd
    .command('usages')
    .description('list where a variable is used or defined (requests, scripts, environments, collection/folder/workspace variables, test files)')
    .argument('<name>', 'variable name, without {{ }}')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action((name: string, o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const uses = variableUsages(store, name);
        if (o.json) console.log(JSON.stringify(uses, null, 2));
        else if (!uses.length) console.log(yellow(`{{${name}}} isn't used or defined in this workspace.`));
        else for (const u of uses) console.log(`${u.where}  ${dim(u.field)}`);
      } finally {
        store.close();
      }
    });
  varsCmd
    .command('unused')
    .description('variables of the environments and the workspace that nothing reads ({{name}} anywhere, script gets, test files)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action((o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const used = referencedVariableNames(store);
        const rows = [
          ...store.listEnvironments().map((e) => ({ scope: `environment ${e.name}`, unused: e.variables.map((v) => v.key).filter((k) => k && !used.has(k)) })),
          { scope: 'workspace', unused: (store.workspace.variables ?? []).map((v) => v.key).filter((k) => k && !used.has(k)) },
        ].filter((x) => x.unused.length);
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) console.log(green('Every variable is used.'));
        else for (const r of rows) console.log(`${r.scope}: ${r.unused.join(', ')}`);
      } finally {
        store.close();
      }
    });
  varsCmd
    .command('rename')
    .description('rename a variable everywhere in the workspace (secret values stored by the app move with it)')
    .argument('<from>', 'current name')
    .argument('<to>', 'new name')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action(async (from: string, to: string, o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const r = await renameVariable(store, from, to, { secrets: new ChainSecretStore([new EnvSecretStore()]) });
        if (o.json) console.log(JSON.stringify({ from, to, files: r.files, changed: r.changed }, null, 2));
        else console.log(green(`Renamed {{${from}}} to {{${to}}} in ${r.changed.length} places (${r.files} files).`));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      } finally {
        store.close();
      }
    });
  program
    .command('openapi-diff')
    .description('compare two versions of an OpenAPI / Swagger document and list breaking changes (for CI: --fail-on-breaking)')
    .argument('<old>', 'the previous document: a file or an http(s) link')
    .argument('<new>', 'the new document: a file or an http(s) link')
    .option('--fail-on-breaking', 'exit 1 when there are breaking changes')
    .option('--breaking-only', 'leave out the non-breaking changes')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (oldRef: string, newRef: string, o: { failOnBreaking?: boolean; breakingOnly?: boolean; json?: boolean }) => {
      const read = async (ref: string) => (/^https?:\/\//i.test(ref) ? (await fetchImportText(ref)).text : readFileSync(ref, 'utf8'));
      let d: ReturnType<typeof diffOpenApi>;
      try {
        d = diffOpenApi(await read(oldRef), await read(newRef));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      if (o.breakingOnly) d = { ...d, nonBreaking: [] };
      if (o.json) console.log(JSON.stringify(d, null, 2));
      else {
        const ops = d.operations;
        console.log(bold(`${ops.old} → ${ops.new} operations (${ops.added} added, ${ops.removed} removed)`));
        if (d.breaking.length) {
          console.log(red(bold(`\n${d.breaking.length} breaking change${d.breaking.length > 1 ? 's' : ''}:`)));
          for (const c of d.breaking) console.log(red(`  ✗ ${c.where}: ${c.message}`));
        } else console.log(green('\nNo breaking changes.'));
        if (d.nonBreaking.length) {
          console.log(dim(`\n${d.nonBreaking.length} other change${d.nonBreaking.length > 1 ? 's' : ''}:`));
          for (const c of d.nonBreaking) console.log(dim(`  · ${c.where}: ${c.message}`));
        }
      }
      if (o.failOnBreaking && d.breaking.length) process.exitCode = EXIT.TEST_FAILURE;
    });
  program
    .command('openapi-lint')
    .description('lint OpenAPI / Swagger documents: broken $refs, undeclared path parameters, duplicate operationIds, undefined security schemes, examples that do not match their schema, missing responses (for CI: exit 1 on errors)')
    .argument('[specs...]', 'documents: files or http(s) links (default: every document in the workspace\'s specs/ folder)')
    .option('-w, --workspace <dir>', 'with no documents given: the workspace folder whose specs/ to lint (default: nearest workspace.json)')
    .option('--disable <rules>', 'rules to leave out, comma separated (see --rules)')
    .option('--severity <level>', 'show only this level and worse: error, warning or info', 'info')
    .option('--fail-on <level>', 'exit 1 when a problem of this level or worse is found: error, warning, info or none', 'error')
    .option('--rules', 'list the rules and exit')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (refs: string[], o: { workspace?: string; disable?: string; severity: string; failOn: string; rules?: boolean; json?: boolean }) => {
      const levels = ['error', 'warning', 'info'];
      if (o.rules) {
        if (o.json) console.log(JSON.stringify(OPENAPI_LINT_RULES, null, 2));
        else for (const r of OPENAPI_LINT_RULES) console.log(`${r.id.padEnd(28)} ${r.severity.padEnd(8)} ${r.description}`);
        return;
      }
      if (!levels.includes(o.severity)) throw new CliError(`--severity must be error, warning or info`, EXIT.CONFIG_ERROR);
      if (![...levels, 'none'].includes(o.failOn)) throw new CliError(`--fail-on must be error, warning, info or none`, EXIT.CONFIG_ERROR);
      const disable = (o.disable ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const unknown = disable.filter((d) => !OPENAPI_LINT_RULES.some((r) => r.id === d));
      if (unknown.length) throw new CliError(`Unknown rule${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (testpion openapi-lint --rules lists them)`, EXIT.CONFIG_ERROR);
      // a folder stands for its documents
      let files = refs.flatMap((r) => {
        if (/^https?:\/\//i.test(r) || !existsSync(r) || !statSync(r).isDirectory()) return [r];
        const docs = readdirSync(r).filter((f) => /\.(ya?ml|json)$/i.test(f));
        if (!docs.length) throw new CliError(`No OpenAPI documents in ${r}`, EXIT.CONFIG_ERROR);
        return docs.map((f) => join(r, f));
      });
      if (!files.length) {
        const ws = o.workspace ? resolve(o.workspace) : findWorkspaceUp(process.cwd());
        const dir = ws ? join(ws, 'specs') : undefined;
        if (!dir || !existsSync(dir)) throw new CliError('Name the documents to lint, or run it in a workspace with a specs/ folder', EXIT.CONFIG_ERROR);
        files = readdirSync(dir)
          .filter((f) => /\.(ya?ml|json)$/i.test(f))
          .map((f) => join(dir, f));
        if (!files.length) throw new CliError(`No OpenAPI documents in ${dir}`, EXIT.CONFIG_ERROR);
      }
      const results: Array<{ file: string } & OpenApiLintResult> = [];
      for (const ref of files) {
        let text: string;
        try {
          text = /^https?:\/\//i.test(ref) ? (await fetchImportText(ref)).text : readFileSync(ref, 'utf8');
        } catch (e) {
          throw new CliError(`Cannot read ${ref}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
        }
        results.push({ file: ref, ...lintOpenApi(text, { disable, minSeverity: o.severity as OpenApiLintSeverity }) });
      }
      const worst = (sev: string) => results.some((r) => r.problems.some((p) => levels.indexOf(p.severity) <= levels.indexOf(sev)));
      if (o.json) console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
      else
        for (const r of results) {
          const c = r.counts;
          const head = `${r.file}: ${r.operations} operations, ${c.error} error${c.error === 1 ? '' : 's'}, ${c.warning} warning${c.warning === 1 ? '' : 's'}, ${c.info} note${c.info === 1 ? '' : 's'}`;
          console.log(bold(head));
          for (const p of r.problems) {
            const line = `  ${r.file}:${p.line}:${p.column}  ${p.severity.padEnd(7)} ${p.message}  ${dim(p.rule)}`;
            console.log(p.severity === 'error' ? red(line) : p.severity === 'warning' ? yellow(line) : dim(line));
          }
          if (!r.problems.length) console.log(green('  No problems.'));
        }
      if (o.failOn !== 'none' && worst(o.failOn)) process.exitCode = EXIT.TEST_FAILURE;
    });
  program
    .command('coverage')
    .description(
      'API coverage: which operations and documented responses of an OpenAPI document your test runs and request history exercised\n' +
        'Uses the latest run unless --run or --history is given. For CI: --min <percent> exits 1 below the threshold',
    )
    .argument('<spec>', 'OpenAPI / Swagger document: a file or an http(s) link')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--run <runId...>', 'use these runs (repeatable; default: the latest run)')
    .option('--history [n]', 'also use the request history (the last n entries, default 1000)')
    .option('--base-url <url>', 'only count requests under this URL (e.g. your staging server)')
    .option('--exclude-deprecated', 'leave deprecated operations out of the totals')
    .option('--min <percent>', 'exit 1 when fewer than this percent of the operations are covered')
    .option('--markdown <file>', 'also write a Markdown report (for pull requests)')
    .option('--json', 'print the full report as JSON (for scripts and AI agents)')
    .action(async (specRef: string, o: { workspace?: string; run?: string[]; history?: string | boolean; baseUrl?: string; excludeDeprecated?: boolean; min?: string; markdown?: string; json?: boolean }) => {
      let specText: string;
      try {
        specText = /^https?:\/\//i.test(specRef) ? (await fetchImportText(specRef)).text : readFileSync(specRef, 'utf8');
      } catch (e) {
        throw new CliError(`Could not read ${specRef}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
      }
      const min = o.min === undefined ? undefined : Number(o.min);
      if (min !== undefined && !(min >= 0 && min <= 100)) throw new CliError('--min must be a percentage between 0 and 100', EXIT.CONFIG_ERROR);
      const { store, ephemeral } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
      let result: Awaited<ReturnType<typeof workspaceApiCoverage>>;
      try {
        result = await workspaceApiCoverage(store, specText, {
          runs: o.run,
          history: o.history === undefined ? undefined : o.history === true ? 1000 : Number(o.history),
          baseUrl: o.baseUrl,
          excludeDeprecated: o.excludeDeprecated,
        });
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      } finally {
        store.close();
      }
      const { report, sources } = result;
      if (o.markdown) writeFileSync(o.markdown, apiCoverageMarkdown(report));
      if (o.json) console.log(JSON.stringify({ ...report, sources }, null, 2));
      else {
        const s = report.summary;
        const from = [sources.runs.map((r) => `run ${r.name} (${r.id})`).join(', '), sources.historyEntries ? `${sources.historyEntries} history entries` : ''].filter(Boolean).join(' + ');
        console.log(bold(`API coverage${report.title ? ` — ${report.title}` : ''}`));
        console.log(dim(`from ${from || 'no requests'} · ${s.observations} requests analysed`));
        for (const op of report.operations) {
          const icon = !op.covered ? red('✗') : op.untestedStatuses.length ? yellow('◐') : green('✓');
          const seen = Object.keys(op.statuses).join(', ');
          const extra = [seen && `seen ${seen}`, op.untestedStatuses.length ? `not seen ${op.untestedStatuses.join(', ')}` : '', op.undocumentedStatuses.length ? `undocumented ${op.undocumentedStatuses.join(', ')}` : '', op.deprecated ? 'deprecated' : '']
            .filter(Boolean)
            .join(' · ');
          console.log(`  ${icon} ${op.method.padEnd(6)} ${op.path}${extra ? dim(`  ${extra}`) : ''}`);
        }
        if (report.unmatched.length) {
          console.log(dim(`\n${s.unmatched} request(s) not in the document:`));
          for (const u of report.unmatched.slice(0, 10)) console.log(dim(`  · ${u.method} ${u.path} ×${u.count}`));
        }
        const ok = min === undefined || s.operationPct >= min;
        console.log(`\n${(ok ? green : red)(bold(`${s.operationPct}%`))} of operations covered (${s.covered}/${s.operations}) · ${s.statusPct}% of documented responses seen (${s.testedStatuses}/${s.documentedStatuses})${min !== undefined ? dim(` · minimum ${min}%`) : ''}`);
        if (o.markdown) console.log(dim(`Markdown report: ${o.markdown}`));
      }
      if (min !== undefined && report.summary.operationPct < min) process.exitCode = EXIT.TEST_FAILURE;
    });
  program
    .command('collections')
    .description('list the collections of a workspace: requests, gRPC calls and connections in each')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const rows = store
          .listCollections()
          .filter((c) => !c.problem)
          .map((c) => {
            const saved = collectionSavedItems(store, c.id);
            return { id: c.id, name: c.name, requests: collectionRequests(c).length, grpcCalls: saved?.grpc?.length ?? 0, connections: saved?.websocket?.length ?? 0 };
          });
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        if (!rows.length) return console.log(dim('No collections. Create one in the app, or import one: testpion import <file>'));
        for (const r of rows) console.log(`${r.name}  ${dim(r.id)}  ${[`${r.requests} request${r.requests === 1 ? '' : 's'}`, r.grpcCalls ? `${r.grpcCalls} gRPC` : '', r.connections ? `${r.connections} connection${r.connections === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`);
      } finally {
        store.close();
      }
    });
  program
    .command('storage')
    .description('what the workspace keeps on disk (runs, traces, response bodies, history) and, with --delete-runs-older-than, clean up old runs')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--delete-runs-older-than <days>', 'delete runs that started more than this many days ago (results and reports; baselines stay)')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; deleteRunsOlderThan?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        let deleted: { deleted: number; bytes: number } | undefined;
        if (o.deleteRunsOlderThan !== undefined) {
          const days = Number(o.deleteRunsOlderThan);
          if (!(days >= 1)) throw new CliError('--delete-runs-older-than needs a number of days (1 or more)', EXIT.CONFIG_ERROR);
          deleted = deleteRunsBefore(store, new Date(Date.now() - days * 86_400_000).toISOString());
        }
        const u = workspaceStorage(store);
        if (o.json) return console.log(JSON.stringify({ ...u, ...(deleted ? { deleted } : {}) }, null, 2));
        if (deleted) console.log(green(`Deleted ${deleted.deleted} run${deleted.deleted === 1 ? '' : 's'} (${(deleted.bytes / 1048576).toFixed(1)} MB)`));
        for (const p of u.parts) console.log(`${p.label.padEnd(28)} ${(p.bytes / 1048576).toFixed(1).padStart(8)} MB  ${dim(`${p.files} files`)}`);
        console.log(`${'Total'.padEnd(28)} ${(u.totalBytes / 1048576).toFixed(1).padStart(8)} MB`);
        console.log(dim(`${u.runs} runs, ${u.history} history entries, ${u.traces} traces`));
      } finally {
        store.close();
      }
    });
  program
    .command('jwt')
    .description('decode a JSON Web Token (header, claims, expiry); the signature is not verified. Reads stdin when the token is -')
    .argument('<token>', 'the token (a "Bearer " prefix is fine), or - for stdin')
    .option('--json', 'print as JSON')
    .action(async (token: string, o: { json?: boolean }) => {
      let t = token;
      if (t === '-') {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        t = Buffer.concat(chunks).toString('utf8').trim();
      }
      let d: ReturnType<typeof decodeJwt>;
      try {
        d = decodeJwt(t);
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      if (o.json) return console.log(JSON.stringify(d, null, 2));
      console.log(bold('Header'), JSON.stringify(d.header));
      console.log(bold('Claims'));
      console.log(JSON.stringify(d.payload, null, 2));
      if (d.issuedAt) console.log(dim(`issued at  ${d.issuedAt}`));
      if (d.expiresAt) console.log(`${dim('expires at')} ${d.expiresAt}  ${d.expired ? red(`expired ${describeExpiry(d.expiresInSec!)}`) : green(`expires ${describeExpiry(d.expiresInSec!)}`)}`);
      else console.log(yellow('no expiry (exp) claim'));
      console.log(dim('The signature is not verified.'));
      if (d.expired) process.exitCode = EXIT.TEST_FAILURE;
    });
  program
    .command('attention')
    .description('what needs attention in the workspace: failing monitors, expiring certificates, the latest failed run, failing requests, flaky tests (exit 1 on a high-severity item)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--cert-days <days>', 'warn about certificates that expire within this many days', '30')
    .option('--json', 'print as JSON')
    .option('--markdown', 'print a Markdown list (to post to a chat or a pull request)')
    .action(async (o: { workspace?: string; certDays: string; json?: boolean; markdown?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const items = await workspaceAttention(store, { certDays: Number(o.certDays) || 30 });
        if (o.json) console.log(JSON.stringify(items, null, 2));
        else if (o.markdown) console.log(items.length ? ['**Needs attention**', ...items.map((i) => `- ${i.severity === 'high' ? '🔴' : i.severity === 'medium' ? '🟠' : '⚪'} ${i.message}`)].join('\n') : '✅ Nothing needs attention.');
        else if (!items.length) console.log(green('Nothing needs attention.'));
        else for (const i of items) console.log(`${i.severity === 'high' ? red('high  ') : i.severity === 'medium' ? yellow('medium') : dim('low   ')} ${i.message}`);
        process.exitCode = items.some((i) => i.severity === 'high') ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      } finally {
        store.close();
      }
    });
  program
    .command('certificates')
    .description('TLS certificates of the HTTPS hosts the workspace has called (app, runs, monitors, agents), soonest to expire first; with --warn, exit 1 when one expires within that many days')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--warn <days>', 'exit 1 when a certificate expires within this many days (for cron or CI)')
    .option('--check <hosts...>', 'connect to these hosts (host, host:port or https URL) and check their certificates now, instead of listing the recorded ones')
    .option('--json', 'print as JSON')
    .action(async (o: { workspace?: string; warn?: string; check?: string[]; json?: boolean }) => {
      if (o.check?.length) {
        // direct TLS handshakes; also recorded in the workspace when there is one
        const warn = o.warn === undefined ? undefined : Number(o.warn);
        const out: Array<Record<string, unknown>> = [];
        let bad = false;
        for (const t of o.check) {
          try {
            const c = await checkCertificate(t);
            out.push({ target: t, ...c });
            if (!c.trusted || (c.daysLeft ?? 0) < 0 || (warn !== undefined && c.daysLeft !== undefined && c.daysLeft <= warn)) bad = true;
          } catch (e) {
            out.push({ target: t, error: (e as Error).message });
            bad = true;
          }
        }
        try {
          const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
          for (const c of out) if (!c.error) recordCertificate(store, `https://${c.host}:${c.port}/`, c as { validTo?: string });
          store.close();
        } catch {
          /* no workspace here: nothing to record */
        }
        if (o.json) console.log(JSON.stringify(out, null, 2));
        else
          for (const c of out) {
            if (c.error) {
              console.log(`${String(c.target)}  ${red(String(c.error))}`);
              continue;
            }
            const d = c.daysLeft as number | undefined;
            const left = d === undefined ? dim('?') : d < 0 ? red(`expired ${-d} days ago`) : d < 14 || (warn !== undefined && d <= warn) ? red(`${d} days left`) : d < 30 ? yellow(`${d} days left`) : green(`${d} days left`);
            console.log(`${String(c.host)}:${c.port}  ${left}  ${c.trusted ? green('trusted') : red(`not trusted (${c.trustError})`)}  ${dim(`${c.subject ?? ''} · ${c.issuer ?? ''} · ${c.protocol ?? ''} · until ${String(c.validTo ?? '?').slice(0, 10)}`)}`);
          }
        if (bad) process.exitCode = EXIT.TEST_FAILURE;
        return;
      }
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const list = listCertificates(store);
        const warn = o.warn === undefined ? undefined : Number(o.warn);
        if (warn !== undefined && !(warn >= 0)) throw new CliError('--warn needs a number of days', EXIT.CONFIG_ERROR);
        const soon = warn === undefined ? [] : list.filter((c) => c.daysLeft !== undefined && c.daysLeft <= warn);
        if (o.json) console.log(JSON.stringify(list, null, 2));
        else if (!list.length) console.log(dim('No certificates yet: they are recorded when HTTPS requests are sent from the app, test runs, monitors or agents.'));
        else {
          const w = Math.min(40, Math.max(...list.map((c) => c.host.length)));
          for (const c of list) {
            const d = c.daysLeft;
            const text = (d === undefined ? '?' : d < 0 ? `expired ${-d}d ago` : `${d} days`).padEnd(16);
            const left = d === undefined ? dim(text) : d < 14 ? red(text) : d < 30 ? yellow(text) : green(text);
            console.log(`${c.host.slice(0, w).padEnd(w)}  ${left} ${dim(`${c.validTo?.slice(0, 10) ?? ''} · ${c.issuer ?? ''} · seen ${c.lastSeen.slice(0, 10)}`)}`);
          }
        }
        if (soon.length) {
          if (!o.json) console.error(red(`${soon.length} certificate${soon.length === 1 ? '' : 's'} expire${soon.length === 1 ? 's' : ''} within ${warn} days: ${soon.map((c) => c.host).join(', ')}`));
          process.exitCode = EXIT.TEST_FAILURE;
        }
      } finally {
        store.close();
      }
    });
  program
    .command('load-history')
    .description('earlier load tests of the workspace (from the app, testpion load and agents), newest first: throughput, p50/p95/p99, error rate and pass rules')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-q, --query <text>', 'only load tests whose name or target contains this')
    .option('-n, --limit <n>', 'how many', '20')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; query?: string; limit: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const rows = loadHistory(store, { query: o.query, limit: Number(o.limit) || 20 });
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        if (!rows.length) return console.log(dim('No load tests yet.'));
        for (const r of rows)
          console.log(
            `${new Date(r.startedAt).toLocaleString()}  ${r.name}  ${dim(`${r.virtualUsers} VUs, ${r.durationSec}s`)}  ${Math.round(r.throughput)} req/s  p95 ${formatDuration(r.p95)}${r.ttfbP95 !== undefined ? dim(` (server ${formatDuration(r.ttfbP95)})`) : ''}  ${r.errorRate > 0.01 ? red(`${(r.errorRate * 100).toFixed(1)}% errors`) : `${(r.errorRate * 100).toFixed(1)}% errors`}${r.passed === undefined ? '' : r.passed ? green('  passed') : red('  failed')}`,
          );
      } finally {
        store.close();
      }
    });
  program
    .command('variable-flow')
    .description('how variables flow through a collection run: which requests set each variable in scripts and which use it, in run order; flags used-before-set, never-set and unused')
    .argument('<collection>', 'collection name or id')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print as JSON')
    .action((ref: string, o: { workspace?: string; json?: boolean }) => {
      const mgr = new WorkspaceManager();
      const { store } = openWorkspace(o.workspace, undefined, mgr);
      try {
        const cols = store.listCollections().filter((c) => !c.problem);
        const c = cols.find((x) => x.id === ref) ?? cols.find((x) => x.name.toLowerCase() === ref.toLowerCase());
        if (!c) throw new CliError(`No collection "${ref}". Collections: ${cols.map((x) => x.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
        const defined = [...store.listEnvironments().flatMap((e) => e.variables.map((v) => v.key)), ...(store.workspace.variables ?? []).map((v) => v.key), ...(mgr.loadSettings().globalVariables ?? []).map((v) => v.key)];
        const flows = collectionVariableFlow(store.getCollection(c.id), defined);
        if (o.json) return console.log(JSON.stringify(flows, null, 2));
        const shown = flows.filter((f) => f.setBy.length || f.issue);
        if (!shown.length) return console.log(dim('No variables set by scripts, and no problems found.'));
        for (const f of shown) {
          const issue = f.issue === 'unused' ? yellow(' (set, never used)') : f.issue ? red(f.issue === 'never-set' ? ' (never set)' : ' (used before it is set)') : '';
          console.log(`{{${f.name}}}  ${f.setBy.map((p) => p.name).join(', ') || dim(f.defined ? 'environment / collection' : 'nothing sets it')} → ${f.usedBy.length} use${f.usedBy.length === 1 ? '' : 's'}${issue}`);
        }
        if (shown.some((f) => f.issue && f.issue !== 'unused')) process.exitCode = EXIT.TEST_FAILURE;
      } finally {
        store.close();
      }
    });
  program
    .command('workspace-report')
    .description('the workspace at a glance as one HTML file to share: requests and tests per day, the health of each collection, monitors and the latest runs (names, counts and timings only)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-d, --days <n>', 'days of activity, up to 90', '14')
    .option('-o, --out <file>', 'write here (default: <workspace>-report.html)')
    .action(async (o: { workspace?: string; days: string; out?: string }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const out = resolve(o.out ?? `${store.workspace.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'workspace'}-report.html`);
        writeFileSync(out, workspaceReportHtml(store, { days: Number(o.days) || 14, tzOffsetMin: new Date().getTimezoneOffset(), attention: await workspaceAttention(store) }));
        console.log(green(`Wrote ${out}`));
      } finally {
        store.close();
      }
    });
  program
    .command('datasets')
    .description('data files in the workspace datasets/ folder (for run-collection -d and test datasets), newest first; SQLite databases with their tables')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const rows = listWorkspaceDatasets(store);
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        if (!rows.length) return console.log(dim('No datasets. Put CSV, JSON, JSONL or SQLite files in the workspace datasets/ folder.'));
        for (const r of rows) console.log(`${r.path}  ${dim(`${r.format}, ${(r.size / 1024).toFixed(1)} KB${r.tables ? `, tables: ${r.tables.join(', ') || 'none'}` : ''}`)}`);
      } finally {
        store.close();
      }
    });
  program
    .command('requests')
    .description("list what a collection holds: its HTTP and GraphQL requests, then its gRPC calls and WebSocket / Socket.IO / MQTT connections (run-collection runs them all)")
    .argument('<collection>', 'collection name or id')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--health', 'add how each HTTP and GraphQL request has been doing in the app: responses, failed, latest status, median time, whether it has checks')
    .option('--json', 'print as JSON')
    .action((ref: string, o: { workspace?: string; json?: boolean; health?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const cols = store.listCollections().filter((c) => !c.problem);
        const c = cols.find((x) => x.id === ref) ?? cols.find((x) => x.name.toLowerCase() === ref.toLowerCase());
        if (!c) throw new CliError(`No collection "${ref}". Collections: ${cols.map((x) => x.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
        const redactor = new Redactor();
        const saved = collectionSavedItems(store, c.id);
        const rows = [
          ...collectionRequests(c).map((r) => ({ id: r.id, kind: r.node.kind, name: r.name, folder: r.path.join(' / ') || undefined, method: r.node.kind === 'http' ? r.node.request.method : 'GQL', target: redactor.redactString(r.node.kind === 'http' ? r.node.request.url : r.node.request.endpoint) })),
          ...(saved?.grpc ?? []).map((i) => ({ id: i.id, kind: 'grpc', name: i.name, folder: i.folder, method: 'gRPC', target: `${(i.data as { target?: string }).target ?? ''} ${(i.data as { method?: string }).method ?? ''}`.trim() })),
          ...(saved?.websocket ?? []).map((i) => {
            const d = i.data as { url?: string; mode?: string };
            return { id: i.id, kind: 'websocket', name: i.name, folder: i.folder, method: d.mode === 'mqtt' ? 'MQTT' : d.mode === 'socketio' ? 'SIO' : 'WS', target: redactor.redactString(d.url ?? '') };
          }),
        ];
        if (o.health) {
          const stats = new Map(store.meta.requestStats(c.id).map((s) => [s.requestId, s]));
          const checks = new Map(collectionRequests(c).map((r) => [r.id, !!r.node.assertions?.length || !!r.node.testScript?.trim()]));
          for (const r of rows as Array<Record<string, unknown>>) {
            if (!checks.has(r.id as string)) continue;
            const s = stats.get(r.id as string);
            Object.assign(r, { hasChecks: checks.get(r.id as string), responses: s?.count ?? 0, failed: s?.failed, lastStatus: s?.lastStatus, lastOk: s?.lastOk, medianMs: s?.medianMs });
          }
        }
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        for (const r of rows as Array<(typeof rows)[number] & { responses?: number; failed?: number; lastStatus?: number | string; lastOk?: boolean; medianMs?: number; hasChecks?: boolean }>) {
          const health =
            o.health && r.responses !== undefined
              ? '  ' + (r.responses ? `${r.lastOk ? green(String(r.lastStatus ?? 'ok')) : red(String(r.lastStatus ?? 'failed'))} ${r.medianMs !== undefined ? formatDuration(r.medianMs) : ''} ${dim(`${r.failed}/${r.responses} failed`)}` : dim('not sent')) + (r.hasChecks ? '' : yellow(' no checks'))
              : '';
          console.log(`${r.method.padEnd(6)} ${r.folder ? dim(`${r.folder} / `) : ''}${r.name}  ${dim(r.target)}${health}`);
        }
      } finally {
        store.close();
      }
    });
  program
    .command('export')
    .description('export a collection as a Postman v2.1 collection (default), TestPion JSON, an OpenAPI 3.1 document (--format openapi), a Bruno collection folder (--format bruno --out <folder>) or an .http file for REST Client / JetBrains (--format http)\n<collection> is a collection name or id in the workspace, or a collection file to convert')
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .addOption(new Option('-f, --format <format>', 'output format').choices(['postman', 'testpion', 'openapi', 'bruno', 'http']).default('postman'))
    .option('--json', 'with --format openapi: JSON instead of YAML')
    .option('-o, --out <file>', 'write to this file instead of stdout')
    .action(async (ref: string, o: { workspace?: string; format: 'postman' | 'testpion' | 'openapi' | 'bruno' | 'http'; json?: boolean; out?: string }) => {
      const c = await loadCollectionRef(ref, o.workspace);
      if (o.format === 'bruno') {
        // a folder like the one Bruno keeps in git; the workspace's environments go to environments/ (secret values never)
        if (!o.out) throw new CliError('--format bruno writes a folder: give it with --out <folder>', EXIT.CONFIG_ERROR);
        const wsDir = o.workspace ? undefined : findWorkspaceUp(process.cwd());
        let envs: Environment[] = [];
        if (o.workspace || wsDir) {
          const { store } = openWorkspace(o.workspace ?? wsDir, undefined, new WorkspaceManager());
          envs = store.listEnvironments();
          store.close();
        }
        const out = resolve(o.out);
        const files = collectionToBru(c, envs);
        for (const f of files) {
          const p = join(out, ...f.path.split('/'));
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.text);
        }
        console.error(dim(`Bruno collection written to ${out} (${files.length} files${envs.length ? `, ${envs.length} environments without secret values` : ''})`));
        return;
      }
      if (o.format === 'http') {
        const { text, notes } = collectionToHttpFile(c);
        for (const n of notes) console.error(yellow(`not exported: ${n}`));
        if (o.out) writeFileSync(resolve(o.out), text);
        else process.stdout.write(text);
        return;
      }
      if (o.format === 'openapi') {
        const text = collectionToOpenApiText(c, { format: o.json ? 'json' : 'yaml' });
        if (o.out) {
          writeFileSync(resolve(o.out), text);
          console.error(dim(`OpenAPI document written to ${resolve(o.out)}`));
        } else process.stdout.write(text);
        return;
      }
      // a workspace collection's gRPC calls and connections go into a TestPion file (`savedItems`)
      let savedItems: ReturnType<typeof collectionSavedItems>;
      const wsDir = o.workspace ?? findWorkspaceUp(process.cwd());
      if (wsDir) {
        try {
          const { store } = openWorkspace(wsDir, undefined, new WorkspaceManager());
          savedItems = collectionSavedItems(store, c.id);
          store.close();
        } catch {
          savedItems = undefined;
        }
      }
      const { collection, notes } = o.format === 'postman' ? exportPostmanCollection(c) : { collection: { ...c, ...(savedItems ? { savedItems } : {}) }, notes: [] as string[] };
      if (o.format === 'postman' && savedItems) notes.push(`${Object.values(savedItems).reduce((n, l) => n + (l?.length ?? 0), 0)} gRPC call(s) or connection(s) (Postman's format has no place for them; use --format testpion)`);
      const json = JSON.stringify(collection, null, 2) + '\n';
      for (const n of notes) console.error(yellow(`not exported: ${n}`));
      if (o.out) {
        writeFileSync(resolve(o.out), json);
        console.error(dim(`Collection written to ${resolve(o.out)}`));
      } else process.stdout.write(json);
    });
  program
    .command('export-environment')
    .description("export a workspace environment in Postman's environment format (secret values are never included)")
    .argument('<environment>', 'environment name or id')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-o, --out <file>', 'write to this file instead of stdout')
    .action((ref: string, o: { workspace?: string; out?: string }) => {
      const { store, ephemeral } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const env = store.getEnvironment(ref);
        if (!env) throw new CliError(`Environment "${ref}" not found. Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
        const json = JSON.stringify(exportPostmanEnvironment(env), null, 2) + '\n';
        if (o.out) {
          writeFileSync(resolve(o.out), json);
          console.error(dim(`Environment written to ${resolve(o.out)}`));
        } else process.stdout.write(json);
      } finally {
        store.close();
        if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
      }
    });
  program
    .command('docs')
    .description('write Markdown or HTML (--html) documentation for a collection (descriptions, requests, parameters, examples; secrets masked)\n<collection> is a collection name or id in the workspace, or a TestPion / Postman v2.1 collection or OpenAPI file or link')
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-o, --out <file>', 'write to this file instead of stdout')
    .option('--no-examples', 'leave out saved examples')
    .option('--html', 'a self-contained HTML page (sidebar, search, copy buttons) to publish or share')
    .action(async (ref: string, o: { workspace?: string; out?: string; examples?: boolean; html?: boolean }) => {
      const c = await loadCollectionRef(ref, o.workspace);
      const md = o.html ? collectionHtml(c, { examples: o.examples }) : collectionMarkdown(c, { examples: o.examples });
      if (o.out) {
        writeFileSync(resolve(o.out), md);
        console.error(dim(`Documentation written to ${resolve(o.out)}`));
      } else process.stdout.write(md);
    });
  program
    .command('import')
    .description('import OpenAPI/Swagger, Postman, Insomnia, Bruno, Hoppscotch, HAR, .env or collection files, or a copied cURL / fetch / PowerShell request, into a workspace')
    .argument('<file>', 'file to import, a Bruno collection folder, an http(s) link to download (OpenAPI URL, GitHub file, Postman API link), or - to read stdin (e.g. a cURL command from the clipboard)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--collection <name>', 'for a cURL / fetch / PowerShell request: the collection to add it to (created if needed)', 'Imported')
    .option('--folder <path>', 'for a request: folder path inside the collection, e.g. "Auth / Tokens"')
    .option('--name <name>', 'for a request: its name (default: method and path)')
    .option('--no-contract-checks', 'for an OpenAPI document: do not add openapi contract checks to the requests')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (file: string, o) => {
      const mgr = new WorkspaceManager();
      const { store } = openWorkspace(o.workspace, undefined, mgr);
      try {
        const link = /^https?:\/\//i.test(file) ? await fetchImportText(file) : undefined;
        // a folder is a Bruno collection (bruno.json and .bru files)
        const folder = !link && file !== '-' && existsSync(file) && statSync(file).isDirectory();
        let text = link ? link.text : file === '-' ? readFileSync(0, 'utf8') : folder ? readBrunoFolder(file) : readFileSync(file, 'utf8');
        // a local WSDL's schemas and WSDLs next to it (schemaLocation="types.xsd")
        if (!link && !folder && file !== '-' && isWsdl(text)) text = await bundleWsdl(text, resolve(file), async (loc) => (existsSync(loc) ? readFileSync(loc, 'utf8') : undefined));
        const source = link?.fileName ?? file;
        if (isRequestSnippet(text)) {
          // secrets in the command (tokens, keys, cookies) become {{variables}}; they are never written to disk
          const r = importRequestSnippet(store.listCollections().filter((c) => !c.problem), text, new Redactor(mgr.loadSettings().redactFields), { collection: o.collection, folder: o.folder, name: o.name });
          const saved = store.saveCollection(r.collection);
          const out = { format: r.format, collection: saved.name, collectionId: saved.id, createdCollection: r.created, request: r.node.name, requestId: r.node.id, method: r.node.request.method, url: r.node.request.url, placeholders: r.placeholders };
          if (o.json) console.log(JSON.stringify(out, null, 2));
          else {
            console.log(green(`Imported ${r.format} request "${r.node.name}" into collection "${saved.name}"`));
            if (r.placeholders.length) console.log(yellow(`Secrets were replaced by variables; set them as secret environment variables: ${r.placeholders.map((p) => `${p.variable} (${p.where})`).join(', ')}`));
          }
          return;
        }
        const r = importIntoWorkspace(store, text, { contractChecks: o.contractChecks !== false, name: dotenvName(source) ?? httpFileName(source) });
        if (o.json) console.log(JSON.stringify({ format: r.format, collection: r.collection?.name, collectionId: r.collection?.id, environment: r.environment?.name, environments: r.environments?.map((e) => e.name), secretsToSet: r.secretsToSet, specPath: r.specPath, contractChecks: r.contractChecks, scriptWarnings: r.scriptWarnings, notes: r.notes }, null, 2));
        else {
          console.log(green(`Imported ${r.format}: ${r.collection ? `collection "${r.collection.name}"` : ''}${r.environments?.length ? ` ${r.environments.length > 1 ? 'environments' : 'environment'} ${r.environments.map((e) => `"${e.name}"`).join(', ')}` : ''}`));
          if (r.specPath) console.log(dim(`Kept the document as ${r.specPath}${r.contractChecks ? `; ${r.contractChecks} requests check the OpenAPI contract` : ''}`));
          if (r.scriptWarnings?.length) {
            console.log(yellow(`${r.scriptWarnings.length} script${r.scriptWarnings.length > 1 ? 's use' : ' uses'} something TestPion's sandbox doesn't have:`));
            for (const w of r.scriptWarnings) console.log(yellow(`  ${w.where} (${w.script} script): ${w.api}; ${w.hint}`));
          }
          for (const n of r.notes ?? []) console.log(yellow(`  ${n}`));
          if (r.secretsToSet?.length) console.log(yellow(`Secret values were not saved (set them in the app, or as TESTPION_SECRET_* variables): ${r.secretsToSet.join(', ')}`));
        }
      } finally {
        store.close();
      }
    });
  program
    .command('scripts')
    .description('script tools')
    .command('convert')
    .description("rewrite collection scripts between Postman's pm.* and TestPion's tp.* (both always work)")
    .requiredOption('-w, --workspace <nameOrPath>')
    .requiredOption('--to <tp|pm>', 'the name to use')
    .option('--collection <nameOrId>', 'only this collection (default: all)')
    .option('--dry-run', 'only report what would change')
    .option('--json', 'print the result as JSON')
    .action((o) => {
      if (o.to !== 'tp' && o.to !== 'pm') throw new CliError('--to must be tp or pm', EXIT.CONFIG_ERROR);
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const want = o.collection ? String(o.collection).toLowerCase() : undefined;
        const cols = store.listCollections().filter((c) => !c.problem && (!want || c.id.toLowerCase() === want || c.name.toLowerCase() === want));
        if (want && !cols.length) throw new CliError(`No collection "${o.collection}"`, EXIT.CONFIG_ERROR);
        const results = cols.map((c) => {
          const r = convertCollectionScripts(c, o.to === 'tp' ? 'pm' : 'tp', o.to);
          if (!o.dryRun && r.changed) store.saveCollection(r.collection);
          return { collection: c.name, changed: r.changed, replacements: r.replacements, skipped: r.skipped };
        });
        if (o.json) console.log(JSON.stringify({ to: o.to, dryRun: !!o.dryRun, results }, null, 2));
        else
          for (const r of results)
            console.log(`${r.changed ? green(`${o.dryRun ? 'Would convert' : 'Converted'} ${r.changed} script(s)`) : dim('No change')} in "${r.collection}"${r.skipped.length ? yellow(` (${r.skipped.length} skipped: ${r.skipped.map((s) => s.where).join(', ')})`) : ''}`);
      } finally {
        store.close();
      }
    });
  const histCmd = program.command('history').description('response history of requests sent in the app, and comparing two responses');
  histCmd
    .command('export-har')
    .description('write HTTP and GraphQL history as a HAR file (browser devtools and other tools open it; secrets masked)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-q, --query <text>', 'only entries matching this text (name, URL, method, status)')
    .option('-n, --limit <n>', 'how many, newest first', '500')
    .option('-o, --out <file>', 'write here (default: print it)')
    .action((o) => {
      const mgr = new WorkspaceManager();
      const { store } = openWorkspace(o.workspace, undefined, mgr);
      try {
        const items = store.meta.listHistory({ query: o.query, limit: Math.min(Number(o.limit) || 500, 2000) }).items;
        const har = historyToHar(store, items, new Redactor(mgr.loadSettings().redactFields));
        const text = JSON.stringify(har, null, 2) + '\n';
        if (o.out) {
          writeFileSync(resolve(o.out), text);
          console.log(green(`Wrote ${(har.log as { entries: unknown[] }).entries.length} entries to ${resolve(o.out)}`));
        } else process.stdout.write(text);
      } finally {
        store.close();
      }
    });
  histCmd
    .command('list')
    .description('recent responses, newest first (optionally of one saved request)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--collection <nameOrId>', 'collection of --request')
    .option('--request <nameOrId>', 'only responses of this saved request')
    .option('--failed', 'only responses that failed (4xx/5xx, transport errors, non-OK gRPC codes)')
    .option('-n, --limit <n>', 'how many', '20')
    .option('--json', 'print as JSON')
    .action((o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const requestId = o.request ? savedRequestId(store, o.request, o.collection) : undefined;
        const items = store.meta.listHistory({ requestId, kind: requestId ? 'http' : undefined, failed: o.failed || undefined, limit: Math.min(Number(o.limit) || 20, 500) }).items;
        const rows = items.map((h) => ({ id: h.id, timestamp: h.timestamp, kind: h.kind, name: h.name, method: h.method, status: h.status, durationMs: h.durationMs, size: h.size }));
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else for (const r of rows) console.log(`${dim(r.id)}  ${r.timestamp}  ${String(r.status ?? '').padEnd(4)} ${r.method ?? r.kind} ${r.name}  ${dim(formatDuration(r.durationMs ?? 0))}`);
      } finally {
        store.close();
      }
    });
  histCmd
    .command('stats')
    .description("response-time summary of a saved request's recent responses: median, p95, slowest, failed")
    .requiredOption('-w, --workspace <nameOrPath>')
    .requiredOption('--request <nameOrId>', 'saved request')
    .option('--collection <nameOrId>', 'collection of --request')
    .option('-n, --limit <n>', 'how many recent responses', '50')
    .option('--json', 'print as JSON')
    .action((o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const requestId = savedRequestId(store, o.request, o.collection);
        const s = responseTimeStats(store.meta.listHistory({ requestId, kind: 'http', limit: Math.min(Number(o.limit) || 50, 500) }).items);
        if (o.json) console.log(JSON.stringify(s, null, 2));
        else if (!s.count) console.log('No responses yet. Send the request from the app first.');
        else {
          const f = (v?: number) => formatDuration(v ?? 0);
          console.log(`${s.count} responses: median ${f(s.p50Ms)}, p95 ${f(s.p95Ms)}, fastest ${f(s.minMs)}, slowest ${f(s.maxMs)}, mean ${f(s.meanMs)}`);
          console.log(s.failed ? red(`${s.failed} failed`) : green('none failed'));
        }
      } finally {
        store.close();
      }
    });
  histCmd
    .command('activity')
    .description('workspace activity per day: requests sent, failed requests, median response time, test runs and failed tests')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-d, --days <n>', 'how many days, up to 90', '14')
    .option('--json', 'print as JSON')
    .action((o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const a = store.meta.activity({ days: Number(o.days) || 14, tzOffsetMin: new Date().getTimezoneOffset() });
        if (o.json) console.log(JSON.stringify(a, null, 2));
        else {
          for (const d of a.days)
            console.log(
              `${d.day}  ${String(d.requests).padStart(4)} requests${d.failedRequests ? red(` (${d.failedRequests} failed)`) : ''}${d.medianMs !== undefined ? dim(`  median ${formatDuration(d.medianMs)}`) : ''}  ${d.runs ? `${d.runs} runs, ${d.tests} tests${d.failedTests ? red(` (${d.failedTests} failed)`) : ''}` : ''}`,
            );
          const kinds = Object.entries(a.byKind).map(([k, n]) => `${k} ${n}`).join(', ');
          if (kinds) console.log(dim(`By kind: ${kinds}`));
        }
      } finally {
        store.close();
      }
    });
  histCmd
    .command('scores')
    .description("each evaluator's mean score run by run (evaluations, AI and RAG tests), oldest first")
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-q, --query <text>', 'only runs whose name contains this')
    .option('-n, --limit <n>', 'how many runs', '20')
    .option('--json', 'print as JSON')
    .action((o: { workspace: string; query?: string; limit: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const points = scoreTrend(store, { name: o.query, limit: Number(o.limit) || 20 });
        if (o.json) return console.log(JSON.stringify(points, null, 2));
        if (!points.length) return console.log(dim('No runs with scores.'));
        const evaluators = [...new Set(points.flatMap((p) => Object.keys(p.scores)))].sort();
        const w = Math.max(...evaluators.map((e) => e.length));
        // one row per evaluator: its score in each run, oldest to newest
        for (const e of evaluators)
          console.log(`${e.padEnd(w)}  ${points.map((p) => (p.scores[e] === undefined ? dim('  -  ') : p.scores[e]! >= 0.7 ? green(p.scores[e]!.toFixed(2)) : yellow(p.scores[e]!.toFixed(2)))).join(' ')}`);
        console.log(dim(`${points.length} runs, oldest left: ${points[0]!.startedAt.slice(0, 16)} → ${points[points.length - 1]!.startedAt.slice(0, 16)}`));
      } finally {
        store.close();
      }
    });
  histCmd
    .command('flaky')
    .description('tests whose result keeps changing across the latest runs, or that passed only after a retry (exit 1 when there are any)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-n, --runs <n>', 'how many of the latest runs', '30')
    .option('--json', 'print as JSON')
    .action(async (o: { workspace: string; runs: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const rows = await flakyTests(store, { runs: Number(o.runs) || 30 });
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) console.log(green('No flaky tests in the latest runs.'));
        else
          for (const t of rows)
            console.log(`${t.recent.map((s) => (s === 'passed' ? green('█') : red('█'))).join('')}  ${bold(t.name)}  ${dim(`${t.passed}/${t.runs} passed · flipped ${t.flips}×${t.retried ? ` · ${t.retried} retried` : ''} · last ${t.lastStatus}`)}`);
        process.exitCode = rows.length ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      } finally {
        store.close();
      }
    });
  histCmd
    .command('test')
    .description('one test (or saved request) across the latest runs, newest first: status, latency and the checks that failed, with how often the result flipped (flaky)')
    .argument('<name>', 'test name as in run results (or its id with --id)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--id', 'the argument is the test / request id')
    .option('-n, --limit <n>', 'how many runs', '20')
    .option('--json', 'print as JSON')
    .action(async (name: string, o: { workspace: string; id?: boolean; limit: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const points = await testHistory(store, o.id ? { id: name } : { name }, { limit: Number(o.limit) || 20 });
        const sum = summarizeTestHistory(points);
        if (o.json) return console.log(JSON.stringify({ summary: sum, runs: points }, null, 2));
        if (!points.length) return console.log(dim(`"${name}" is in none of the latest runs.`));
        console.log(`${bold(name)}  ${sum.failed ? red(`${sum.failed} of ${sum.runs} failed`) : green(`passed ${sum.passed} of ${sum.runs}`)}${sum.flips > 1 ? yellow(`  flipped ${sum.flips} times (flaky?)`) : ''}${sum.medianMs !== undefined ? dim(`  median ${formatDuration(sum.medianMs)}`) : ''}`);
        console.log('  ' + [...points].reverse().map((p) => (p.status === 'passed' ? green('█') : p.status === 'skipped' ? dim('·') : red('█'))).join('') + dim('  oldest → newest'));
        for (const p of points)
          console.log(`  ${p.startedAt.slice(0, 16).replace('T', ' ')}  ${p.status === 'passed' ? green('passed') : p.status === 'skipped' ? dim('skipped') : red(p.status)}  ${dim(`${p.latencyMs !== undefined ? formatDuration(p.latencyMs) : ''} · ${p.runName}${p.environment ? ` · ${p.environment}` : ''}`)}${p.failures.length ? red(`  ${p.failures.join('; ')}`) : ''}`);
      } finally {
        store.close();
      }
    });
  histCmd
    .command('mcp-tools')
    .description('MCP tool calls made in the app, per tool: calls, failures, median and p95 time, last used')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-s, --server <name>', 'only this MCP server')
    .option('--json', 'print as JSON')
    .action((o: { workspace: string; server?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const rows = mcpToolUsage(store).filter((u) => !o.server || u.server.toLowerCase() === o.server.toLowerCase() || u.serverId === o.server);
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        if (!rows.length) return console.log(dim('No MCP tool calls in the history.'));
        const w = Math.min(48, Math.max(...rows.map((r) => `${r.server} · ${r.tool}`.length)));
        for (const r of rows)
          console.log(`${`${r.server} · ${r.tool}`.slice(0, w).padEnd(w)}  ${String(r.calls).padStart(5)} calls  ${r.failed ? red(`${r.failed} failed`.padEnd(10)) : dim('0 failed'.padEnd(10))}  ${dim(`median ${r.medianMs ?? '-'} ms · p95 ${r.p95Ms ?? '-'} ms`)}`);
      } finally {
        store.close();
      }
    });
  histCmd
    .command('llm')
    .description('prompts run in the AI Lab, per provider and model: prompts, input / output tokens, estimated cost, median time')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action((o: { workspace: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const rows = llmUsage(store);
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        if (!rows.length) return console.log(dim('No prompts in the history.'));
        const w = Math.min(48, Math.max(...rows.map((r) => `${r.provider} · ${r.model}`.length)));
        for (const r of rows)
          console.log(`${`${r.provider} · ${r.model}`.slice(0, w).padEnd(w)}  ${String(r.calls).padStart(5)} prompts  ${`${r.inputTokens} in / ${r.outputTokens} out`.padEnd(22)}  ${dim(`${r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : 'no price'} · median ${r.medianMs ?? '-'} ms`)}`);
      } finally {
        store.close();
      }
    });
  histCmd
    .command('diff')
    .description('compare two responses from the history (older first): status, timing, headers and a field-by-field body diff')
    .argument('<before>', 'history id of the older response')
    .argument('<after>', 'history id of the newer response')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print the diff as JSON')
    .action((before: string, after: string, o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        // values of sensitive fields and headers are masked (agents read this output too)
        const r = redactDiff(compareHistory(store, before, after), new Redactor(new WorkspaceManager().loadSettings().redactFields));
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(`${r.diff.different ? yellow('Changed') : green('Same')}: ${r.diff.summary}`);
          for (const c of r.diff.body.changes) console.log(`  ${c.kind === 'added' ? green('+') : c.kind === 'removed' ? red('-') : yellow('~')} ${c.path}  ${c.kind === 'added' ? JSON.stringify(c.after) : c.kind === 'removed' ? JSON.stringify(c.before) : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`}`);
          for (const l of r.diff.body.lines ?? []) if (l.op !== ' ') console.log(`  ${l.op === '+' ? green('+') : red('-')} ${l.text}`);
          for (const h of r.diff.headers.filter((x) => !x.volatile)) console.log(`  header ${h.name}: ${h.before ?? '(none)'} -> ${h.after ?? '(none)'}`);
        }
        process.exitCode = 0;
      } finally {
        store.close();
      }
    });
  program
    .command('ci')
    .description('write a CI pipeline that runs a suite, a collection or test files: GitHub Actions, GitLab CI, Azure Pipelines or Jenkins')
    .argument('<provider>', 'github, gitlab, azure or jenkins')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--suite <name>', 'run tests/<name>.suite.yaml')
    .option('--collection <nameOrId>', 'run a collection')
    .option('--folder <nameOrId>', 'with --collection: only this folder or request (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--tests <paths...>', 'test files or folders under tests/ (default: all)')
    .option('-e, --environment <name>', 'environment to run with')
    .option('--workspace-dir <path>', 'the workspace folder relative to the repository root', '.')
    .option('--openapi <file>', 'OpenAPI document in the repository: pull requests fail on breaking changes against the target branch')
    .option('--start <command>', 'integration tests: start the system under test first, in the background (e.g. "npm start", "docker compose up -d")')
    .option('--wait-for <url>', 'with --start: wait until this URL answers (the health check) before the tests')
    .option('--wait-seconds <n>', 'how long to wait for it (default 90)')
    .option('-o, --out <file>', 'write the file here (default: print it)')
    .option('--json', 'print { path, content, secrets, command } as JSON')
    .action((provider: string, o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const c = ciConfig(store, {
          provider: provider as CiProvider,
          suite: o.suite,
          collection: o.collection,
          folders: o.folder,
          tests: o.tests,
          environment: o.environment,
          workspaceDir: o.workspaceDir,
          openapi: o.openapi,
          start: o.start,
          waitFor: o.waitFor,
          waitSeconds: o.waitSeconds ? Number(o.waitSeconds) : undefined,
        });
        if (o.json) return console.log(JSON.stringify(c, null, 2));
        if (o.out) {
          writeFileSync(resolve(o.out), c.content);
          console.error(green(`Wrote ${o.out}`) + dim(` (usually ${c.path})`));
        } else process.stdout.write(c.content);
        if (c.secrets.length) console.error(dim(`CI secrets to create: ${c.secrets.map((x) => `${x.name} (${x.description})`).join(', ')}`));
      } finally {
        store.close();
      }
    });
  program
    .command('wait-for')
    .description('wait until a URL answers (2xx or 3xx): the health check before integration tests, after starting the system under test; exit 3 when it never does')
    .argument('<url>', 'e.g. http://127.0.0.1:4010/health')
    .option('--timeout <seconds>', 'give up after this long', '90')
    .option('--interval <ms>', 'time between tries', '1000')
    .option('--json', 'print { ready, url, status, afterMs, attempts } as JSON')
    .action(async (url: string, o) => {
      const timeout = Math.max(1, Number(o.timeout) || 90) * 1000;
      const interval = Math.max(100, Number(o.interval) || 1000);
      const t0 = Date.now();
      let attempts = 0;
      let last = '';
      while (Date.now() - t0 < timeout) {
        attempts++;
        try {
          const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(interval * 5, 10_000)) });
          if (res.status < 400) {
            const r = { ready: true, url, status: res.status, afterMs: Date.now() - t0, attempts };
            console.log(o.json ? JSON.stringify(r) : green(`${url} answered ${res.status} after ${r.afterMs} ms (${attempts} ${attempts === 1 ? 'try' : 'tries'})`));
            return;
          }
          last = `status ${res.status}`;
        } catch (e) {
          last = (e as Error).message;
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      const r = { ready: false, url, afterMs: Date.now() - t0, attempts, last };
      console.log(o.json ? JSON.stringify(r) : red(`${url} did not answer within ${timeout / 1000} s (${attempts} tries; last: ${last})`));
      process.exitCode = EXIT.EXECUTION_ERROR;
    });
  const envCmd = program.command('env').description('list environments, set plain variables, and set their order');
  envCmd
    .command('matrix')
    .description('every variable across every environment: set, empty, missing or off (never values); exit 1 when one is incomplete somewhere')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--all', 'also list variables that are set everywhere')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; all?: boolean; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const m = environmentMatrix(store.listEnvironments().map((e) => store.getEnvironment(e.id)!).filter(Boolean), { secrets: new EnvSecretStore() });
        const rows = o.all ? m.rows : m.rows.filter((r) => r.incompleteIn.length);
        if (o.json) console.log(JSON.stringify({ ...m, rows }, null, 2));
        else {
          const w = Math.min(32, Math.max(8, ...m.rows.map((r) => r.key.length)));
          console.log(`${''.padEnd(w)}  ${m.environments.map((e) => bold(e.slice(0, 12).padEnd(12))).join(' ')}`);
          const mark = { set: green('set'.padEnd(12)), empty: yellow('empty'.padEnd(12)), missing: red('missing'.padEnd(12)), disabled: dim('off'.padEnd(12)) };
          for (const r of rows) console.log(`${r.key.slice(0, w).padEnd(w)}  ${r.cells.map((c) => mark[c.state]).join(' ')}`);
          console.log(m.incomplete ? yellow(`${m.incomplete} of ${m.rows.length} variables are missing, empty or off somewhere`) : green(`All ${m.rows.length} variables are set in every environment`));
        }
        process.exitCode = m.incomplete ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      } finally {
        store.close();
      }
    });
  envCmd
    .command('set')
    .description('set plain variables of an environment (key=value …); secret variables are set in the app')
    .argument('<environment>', 'environment name or id')
    .argument('<assignments...>', 'key=value pairs')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--create', 'create the environment if it does not exist')
    .option('--json', 'print the variable names as JSON')
    .action((ref: string, pairs: string[], o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const values: Record<string, string> = {};
        for (const p of pairs) {
          const i = p.indexOf('=');
          if (i <= 0) throw new CliError(`Expected key=value, got "${p}"`, EXIT.CONFIG_ERROR);
          values[p.slice(0, i)] = p.slice(i + 1);
        }
        const env = setEnvironmentVariables(store, ref, values, { create: !!o.create });
        if (o.json) console.log(JSON.stringify({ environment: env.name, set: Object.keys(values) }, null, 2));
        else console.log(green(`${env.name}: set ${Object.keys(values).join(', ')}`));
      } catch (e) {
        throw e instanceof CliError ? e : new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      } finally {
        store.close();
      }
    });
  envCmd
    .command('unset')
    .description('remove plain variables from an environment')
    .argument('<environment>', 'environment name or id')
    .argument('<keys...>', 'variable names')
    .requiredOption('-w, --workspace <nameOrPath>')
    .action((ref: string, keys: string[], o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const env = unsetEnvironmentVariables(store, ref, keys);
        console.log(green(`${env.name}: removed ${keys.join(', ')}`));
      } catch (e) {
        throw e instanceof CliError ? e : new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      } finally {
        store.close();
      }
    });
  envCmd
    .command('get')
    .description("print a plain variable's value (secret values are never printed)")
    .argument('<environment>', 'environment name or id')
    .argument('<key>', 'variable name')
    .requiredOption('-w, --workspace <nameOrPath>')
    .action((ref: string, key: string, o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const env = findEnvironment(store, ref);
        if (!env) throw new CliError(`No environment "${ref}"`, EXIT.CONFIG_ERROR);
        const v = env.variables.find((x) => x.key === key);
        if (!v) throw new CliError(`${env.name} has no variable "${key}"`, EXIT.CONFIG_ERROR);
        if ((v as { secret?: boolean }).secret) throw new CliError(`"${key}" is a secret variable: its value is never printed`, EXIT.CONFIG_ERROR);
        console.log(v.value);
      } finally {
        store.close();
      }
    });
  envCmd
    .command('list')
    .description('list environments in display order, with variable names (never values)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action((o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const envs = store.listEnvironments().map((e) => ({ id: e.id, name: e.name, production: !!e.isProduction, variables: e.variables.filter((v) => v.enabled !== false).map((v) => (v.secret ? `${v.key} (secret)` : v.key)) }));
        if (o.json) console.log(JSON.stringify(envs, null, 2));
        else for (const e of envs) console.log(`${e.name}${e.production ? red(' (production)') : ''}\t${dim(e.variables.join(', '))}`);
      } finally {
        store.close();
      }
    });
  envCmd
    .command('order')
    .description('set the display order of environments (names or ids, first to last; others follow)')
    .argument('<environments...>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print the new order as JSON')
    .action((refs: string[], o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const envs = store.listEnvironments();
        const ids = refs.map((r) => {
          const e = envs.find((x) => x.id === r) ?? envs.find((x) => x.name.toLowerCase() === r.toLowerCase());
          if (!e) throw new CliError(`No environment "${r}". Available: ${envs.map((x) => x.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
          return e.id;
        });
        const names = store.reorderEnvironments(ids).map((e) => e.name);
        console.log(o.json ? JSON.stringify(names) : names.join('\n'));
      } finally {
        store.close();
      }
    });
  envCmd
    .command('diff')
    .description('compare two environments: variables missing on one side, different, disabled, or secrets set on one side only (exit 1 when they differ)')
    .argument('<left>', 'environment name or id')
    .argument('<right>', 'environment name or id')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--values', 'show values (secrets and sensitive-looking keys stay masked)')
    .option('--all', 'also list variables that are the same')
    .option('--request <nameOrId>', 'instead: send this saved request with both environments and diff the responses')
    .option('--collection <nameOrId>', 'collection of --request')
    .option('--json', 'print as JSON')
    .action(async (left: string, right: string, o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        if (o.request) {
          const cols = store.listCollections().filter((c) => !c.problem && (!o.collection || c.id === o.collection || c.name.toLowerCase() === String(o.collection).toLowerCase()));
          const want = String(o.request).toLowerCase();
          const collection = cols.find((c) => collectionRequests(c).some((r) => r.id === o.request || r.name.toLowerCase() === want));
          if (!collection) throw new CliError(`No saved request "${o.request}"`, EXIT.CONFIG_ERROR);
          for (const e of [left, right]) if (!store.getEnvironment(e)) throw new CliError(`No environment "${e}"`, EXIT.CONFIG_ERROR);
          const settings = new WorkspaceManager().loadSettings();
          const secrets = new ChainSecretStore([new EnvSecretStore()]);
          const r = await compareRequestAcrossEnvironments({ collection, request: o.request, left, right, context: (environment) => createEngineContext({ store, secrets, settings, environment, collectionId: collection.id }) });
          if (o.json) console.log(JSON.stringify(r, null, 2));
          else {
            const side = (x: typeof r.left) => `${bold(x.environment)} ${x.error ? red(x.error) : `${x.status} ${dim(formatDuration(x.durationMs ?? 0))}`}`;
            console.log(`${r.request}: ${side(r.left)} vs ${side(r.right)}`);
            console.log(`${r.diff.different ? yellow('Different') : green('Same')}: ${r.diff.summary}`);
            for (const c of r.diff.body.changes) console.log(`  ${c.kind === 'added' ? green('+') : c.kind === 'removed' ? red('-') : yellow('~')} ${c.path}  ${c.kind === 'added' ? JSON.stringify(c.after) : c.kind === 'removed' ? JSON.stringify(c.before) : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`}`);
            for (const h of r.diff.headers.filter((x) => !x.volatile)) console.log(`  header ${h.name}: ${h.before ?? '(none)'} -> ${h.after ?? '(none)'}`);
          }
          process.exitCode = r.diff.different ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
          return;
        }
        const get = (ref: string) => {
          const e = store.getEnvironment(ref);
          if (!e) throw new CliError(`No environment "${ref}". Available: ${store.listEnvironments().map((x) => x.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
          return e;
        };
        const d = compareEnvironments(get(left), get(right), { values: !!o.values, secrets: new EnvSecretStore(), redactor: new Redactor(new WorkspaceManager().loadSettings().redactFields) });
        if (!o.all) d.rows = d.rows.filter((r) => r.status !== 'same');
        if (o.json) console.log(JSON.stringify(d, null, 2));
        else {
          const { summary: s } = d;
          console.log(`${bold(d.left)} vs ${bold(d.right)}: ${s.different} different, ${s.onlyLeft} only in ${d.left}, ${s.onlyRight} only in ${d.right}, ${s.same} same`);
          for (const r of d.rows) {
            const mark = r.status === 'same' ? dim('=') : r.status === 'different' ? yellow('~') : r.status === 'only-left' ? red('<') : green('>');
            const extra = [r.secret ? 'secret' : '', r.disabledLeft ? `disabled in ${d.left}` : '', r.disabledRight ? `disabled in ${d.right}` : ''].filter(Boolean).join(', ');
            const vals = o.values ? `  ${r.left ?? dim('(none)')} ${dim('→')} ${r.right ?? dim('(none)')}` : '';
            console.log(`  ${mark} ${r.key}${vals}${extra ? dim(`  (${extra})`) : ''}`);
          }
        }
        process.exitCode = d.summary.different + d.summary.onlyLeft + d.summary.onlyRight ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      } finally {
        store.close();
      }
    });
}

/** Id of a saved request by name or id (optionally within one collection). */
function savedRequestId(store: WorkspaceStore, request: string, collection?: string): string {
  const want = String(request).toLowerCase();
  const cols = store.listCollections().filter((c) => !c.problem && (!collection || c.id === collection || c.name.toLowerCase() === String(collection).toLowerCase()));
  const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? flat(n.items) : [n]));
  const hit = cols.flatMap((c) => flat(c.items)).find((n) => n.id.toLowerCase() === want || n.name.toLowerCase() === want);
  if (!hit) throw new CliError(`No saved request "${request}"`, EXIT.CONFIG_ERROR);
  return hit.id;
}

/** The environment name for an imported .env file: ".env.staging" / "staging.env" → "staging" (else the default). */
/** clinic.http / api.rest → the collection's name. */
function httpFileName(file: string): string | undefined {
  const base = file.split(/[\\/]/).pop() ?? '';
  return /\.(http|rest)$/i.test(base) ? base.replace(/\.(http|rest)$/i, '') : undefined;
}

function dotenvName(file: string): string | undefined {
  const base = file.split(/[\\/]/).pop() ?? '';
  if (!/(^\.env|\.env$)/.test(base)) return undefined;
  return base.replace(/^\.env\.?/, '').replace(/\.env$/, '') || undefined;
}
