/** Moving data in and out: import, export, docs, script conversion, response history and environments. */
import { exportTextFormat } from './export-formats.js';
import { exportMoreFormat, MORE_EXPORT_FORMATS } from './export-more.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { requireScriptTool, convertScriptText, convertCollectionScriptsFrom, WorkspaceManager, formatDuration, ciConfig, ciTargetOfRun, finishedRun, compareEnvironments, environmentMatrix, compareRequestAcrossEnvironments, collectionRequests, type CiProvider, convertCollectionScripts, Redactor, collectionMarkdown, collectionHtml, exportPostmanCollection, exportPostmanEnvironment, collectionToBru, type Environment, diffOpenApi, lintOpenApi, OPENAPI_LINT_RULES, type OpenApiLintSeverity, type OpenApiLintResult, workspaceApiCoverage, apiCoverageMarkdown, securityLint, collectionSecurityFindings, type SecurityFinding, listSpecs, unusedVariables, definedVariableNames, findEnvironment, setEnvironmentVariables, addVariablesToEnvironments, unsetEnvironmentVariables, variableFlow, collectionToOpenApiText, variableUsages, renameVariable, collectionSavedItems, listWorkspaceDatasets, appendDatasetRow, readWorkspaceDataset, workspaceReportHtml, collectionVariableFlow, loadHistory, workspaceStorage, deleteRunsBefore, listCertificates, workspaceAttention, decodeJwt, describeExpiry, recordCertificate, checkCertificate } from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, CliError, printJson, findWorkspaceUp, withWorkspace, warnProblems, cliSecrets, cliContext, requireCollection, requireEnvironment, loadCollectionRef, readDefinition, WORKSPACE_OPTION, JSON_OPTION, JSON_RESULT_OPTION } from '../shared.js';
import { requireInteractive } from '../contract.js';
import { runBundleExport, wantsBundleExport } from './bundle.js';
import { runPackageExport } from './export-package.js';

export function registerDataCommands(program: Command): void {
  program
    .command('lint')
    .description("review a collection's requests: secrets typed in instead of secret variables, secrets in query strings, plain http to other hosts, turned-off TLS checks, and {{variables}} nothing defines")
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment whose variables count as defined (for the variables check)')
    .addOption(new Option('--fail-on <severity>', 'exit 1 when a finding is at least this severe').choices(['high', 'medium', 'low']))
    .option('--json', 'print the findings as JSON')
    .action(async (ref: string, o: { workspace?: string; environment?: string; failOn?: 'high' | 'medium' | 'low'; json?: boolean }) => {
      const c = await loadCollectionRef(ref, o.workspace);
      const settings = new WorkspaceManager().loadSettings();
      let findings: SecurityFinding[];
      try {
        // variables: those of the environment, collection, workspace and globals count as defined
        findings = await withWorkspace(o.workspace, async (store) => {
          const ctx = cliContext(store, o.environment);
          try {
            return collectionSecurityFindings(store, c, ctx, settings.redactFields);
          } finally {
            await ctx.dispose();
          }
        });
      } catch {
        /* a collection file outside a workspace: only its own variables */
        findings = [...securityLint(c, settings.redactFields), ...variableFlow(c, [])];
      }
      if (o.json) printJson(findings);
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
    .option(...JSON_OPTION)
    .action((name: string, o) => {
      return withWorkspace(o.workspace, (store) => {
        const uses = variableUsages(store, name);
        if (o.json) printJson(uses);
        else if (!uses.length) console.log(yellow(`{{${name}}} isn't used or defined in this workspace.`));
        else for (const u of uses) console.log(`${u.where}  ${dim(u.field)}`);
      });
    });
  varsCmd
    .command('unused')
    .description('variables of the environments and the workspace that nothing reads ({{name}} anywhere, script gets, test files)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option(...JSON_OPTION)
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        const rows = unusedVariables(store);
        if (o.json) printJson(rows);
        else if (!rows.length) console.log(green('Every variable is used.'));
        else for (const r of rows) console.log(`${r.scope}: ${r.unused.join(', ')}`);
      });
    });
  varsCmd
    .command('rename')
    .description('rename a variable everywhere in the workspace (secret values stored by the app move with it)')
    .argument('<from>', 'current name')
    .argument('<to>', 'new name')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option(...JSON_OPTION)
    .action(async (from: string, to: string, o) => {
      return withWorkspace(o.workspace, async (store) => {
        const r = await renameVariable(store, from, to, { secrets: cliSecrets() });
        if (o.json) printJson({ from, to, files: r.files, changed: r.changed });
        else console.log(green(`Renamed {{${from}}} to {{${to}}} in ${r.changed.length} places (${r.files} files).`));
      }).catch((e) => {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      });
    });
  program
    .command('openapi-diff')
    .description('compare two versions of an OpenAPI / Swagger document and list breaking changes (for CI: --fail-on-breaking)')
    .argument('<old>', 'the previous document: a file or an http(s) link')
    .argument('<new>', 'the new document: a file or an http(s) link')
    .option('--fail-on-breaking', 'exit 1 when there are breaking changes')
    .option('--breaking-only', 'leave out the non-breaking changes')
    .option(...JSON_RESULT_OPTION)
    .action(async (oldRef: string, newRef: string, o: { failOnBreaking?: boolean; breakingOnly?: boolean; json?: boolean }) => {
      const read = (ref: string) => readDefinition(ref);
      let d: ReturnType<typeof diffOpenApi>;
      try {
        d = diffOpenApi(await read(oldRef), await read(newRef));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      if (o.breakingOnly) d = { ...d, nonBreaking: [] };
      if (o.json) printJson(d);
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
    .option(...JSON_RESULT_OPTION)
    .action(async (refs: string[], o: { workspace?: string; disable?: string; severity: string; failOn: string; rules?: boolean; json?: boolean }) => {
      const levels = ['error', 'warning', 'info'];
      if (o.rules) {
        if (o.json) printJson(OPENAPI_LINT_RULES);
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
      if (!files.length)
        files = await withWorkspace(o.workspace, (store, ephemeral) => {
          const dir = store.path('specs');
          if (ephemeral || !existsSync(dir)) throw new CliError('Name the documents to lint, or run it in a workspace with a specs/ folder', EXIT.CONFIG_ERROR);
          const docs = listSpecs(store).map((p) => join(store.root, ...p.split('/')));
          if (!docs.length) throw new CliError(`No OpenAPI documents in ${dir}`, EXIT.CONFIG_ERROR);
          return docs;
        });
      const results: Array<{ file: string } & OpenApiLintResult> = [];
      for (const ref of files) {
        results.push({ file: ref, ...lintOpenApi(await readDefinition(ref, o.workspace), { disable, minSeverity: o.severity as OpenApiLintSeverity }) });
      }
      const worst = (sev: string) => results.some((r) => r.problems.some((p) => levels.indexOf(p.severity) <= levels.indexOf(sev)));
      if (o.json) printJson(results);
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
    .option(...WORKSPACE_OPTION)
    .option('--run <runId...>', 'use these runs (repeatable; default: the latest run)')
    .option('--history [n]', 'also use the request history (the last n entries, default 1000)')
    .option('--base-url <url>', 'only count requests under this URL (e.g. your staging server)')
    .option('--exclude-deprecated', 'leave deprecated operations out of the totals')
    .option('--min <percent>', 'exit 1 when fewer than this percent of the operations are covered')
    .option('--markdown <file>', 'also write a Markdown report (for pull requests)')
    .option('--json', 'print the full report as JSON (for scripts and AI agents)')
    .action(async (specRef: string, o: { workspace?: string; run?: string[]; history?: string | boolean; baseUrl?: string; excludeDeprecated?: boolean; min?: string; markdown?: string; json?: boolean }) => {
      const specText = await readDefinition(specRef, o.workspace);
      const min = o.min === undefined ? undefined : Number(o.min);
      if (min !== undefined && !(min >= 0 && min <= 100)) throw new CliError('--min must be a percentage between 0 and 100', EXIT.CONFIG_ERROR);
      const { report, sources } = await withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        try {
          return await workspaceApiCoverage(store, specText, {
            runs: o.run,
            history: o.history === undefined ? undefined : o.history === true ? 1000 : Number(o.history),
            baseUrl: o.baseUrl,
            excludeDeprecated: o.excludeDeprecated,
          });
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
      });
      if (o.markdown) writeFileSync(o.markdown, apiCoverageMarkdown(report));
      if (o.json) printJson({ ...report, sources });
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
    .option(...WORKSPACE_OPTION)
    .option(...JSON_OPTION)
    .action((o: { workspace?: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const all = store.listCollections();
        if (!o.json) warnProblems(all, 'collection');
        const rows = all
          .filter((c) => !c.problem)
          .map((c) => {
            const saved = collectionSavedItems(store, c.id);
            return { id: c.id, name: c.name, requests: collectionRequests(c).length, grpcCalls: saved?.grpc?.length ?? 0, connections: saved?.websocket?.length ?? 0 };
          });
        if (o.json) return printJson([...rows, ...all.filter((c) => c.problem).map((c) => ({ id: c.id, name: c.name, problem: c.problem }))]);
        if (!rows.length) return console.log(dim('No collections. Create one in the app, or import one: testpion import <file>'));
        for (const r of rows) console.log(`${r.name}  ${dim(r.id)}  ${[`${r.requests} request${r.requests === 1 ? '' : 's'}`, r.grpcCalls ? `${r.grpcCalls} gRPC` : '', r.connections ? `${r.connections} connection${r.connections === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`);
      });
    });
  program
    .command('storage')
    .description('what the workspace keeps on disk (runs, traces, response bodies, history) and, with --delete-runs-older-than, clean up old runs')
    .option(...WORKSPACE_OPTION)
    .option('--delete-runs-older-than <days>', 'delete runs that started more than this many days ago (results and reports; baselines stay)')
    .option(...JSON_OPTION)
    .action((o: { workspace?: string; deleteRunsOlderThan?: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        let deleted: { deleted: number; bytes: number } | undefined;
        if (o.deleteRunsOlderThan !== undefined) {
          const days = Number(o.deleteRunsOlderThan);
          if (!(days >= 1)) throw new CliError('--delete-runs-older-than needs a number of days (1 or more)', EXIT.CONFIG_ERROR);
          deleted = deleteRunsBefore(store, new Date(Date.now() - days * 86_400_000).toISOString());
        }
        const u = workspaceStorage(store);
        if (o.json) return printJson({ ...u, ...(deleted ? { deleted } : {}) });
        if (deleted) console.log(green(`Deleted ${deleted.deleted} run${deleted.deleted === 1 ? '' : 's'} (${(deleted.bytes / 1048576).toFixed(1)} MB)`));
        for (const p of u.parts) console.log(`${p.label.padEnd(28)} ${(p.bytes / 1048576).toFixed(1).padStart(8)} MB  ${dim(`${p.files} files`)}`);
        console.log(`${'Total'.padEnd(28)} ${(u.totalBytes / 1048576).toFixed(1).padStart(8)} MB`);
        console.log(dim(`${u.runs} runs, ${u.history} history entries, ${u.traces} traces`));
      });
    });
  program
    .command('jwt')
    .description('decode a JSON Web Token (header, claims, expiry); the signature is not verified. Reads stdin when the token is -')
    .argument('<token>', 'the token (a "Bearer " prefix is fine), or - for stdin')
    .option(...JSON_OPTION)
    .action(async (token: string, o: { json?: boolean }) => {
      let t = token;
      if (t === '-') {
        // from a terminal that would wait for someone to type the token
        if (process.stdin.isTTY) requireInteractive('Reading the token from the terminal', 'Pipe it in (echo "$TOKEN" | testpion jwt -) or pass it as the argument.');
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
      if (o.json) return printJson(d);
      console.log(bold('Header'), JSON.stringify(d.header));
      console.log(bold('Claims'));
      printJson(d.payload);
      if (d.issuedAt) console.log(dim(`issued at  ${d.issuedAt}`));
      if (d.expiresAt) console.log(`${dim('expires at')} ${d.expiresAt}  ${d.expired ? red(`expired ${describeExpiry(d.expiresInSec!)}`) : green(`expires ${describeExpiry(d.expiresInSec!)}`)}`);
      else console.log(yellow('no expiry (exp) claim'));
      console.log(dim('The signature is not verified.'));
      if (d.expired) process.exitCode = EXIT.TEST_FAILURE;
    });
  program
    .command('attention')
    .alias('problems')
    .description("the problems of the workspace, as the app's Problems panel lists them: files that can't be read, failing monitors, the latest failed run (failures and errors apart), failing requests, expiring certificates, flaky tests (exit 1 on a high-severity item); also: testpion problems")
    .option(...WORKSPACE_OPTION)
    .option('--cert-days <days>', 'warn about certificates that expire within this many days', '30')
    .option(...JSON_OPTION)
    .option('--markdown', 'print a Markdown list (to post to a chat or a pull request)')
    .action(async (o: { workspace?: string; certDays: string; json?: boolean; markdown?: boolean }) => {
      return withWorkspace(o.workspace, async (store) => {
        const items = await workspaceAttention(store, { certDays: Number(o.certDays) || 30 });
        if (o.json) printJson(items);
        else if (o.markdown) console.log(items.length ? ['**Needs attention**', ...items.map((i) => `- ${i.severity === 'high' ? '🔴' : i.severity === 'medium' ? '🟠' : '⚪'} ${i.message}`)].join('\n') : '✅ Nothing needs attention.');
        else if (!items.length) console.log(green('Nothing needs attention.'));
        else for (const i of items) console.log(`${i.severity === 'high' ? red('high  ') : i.severity === 'medium' ? yellow('medium') : dim('low   ')} ${dim(i.type.padEnd(7))} ${i.message}`);
        process.exitCode = items.some((i) => i.severity === 'high') ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      });
    });
  program
    .command('certificates')
    .description('TLS certificates of the HTTPS hosts the workspace has called (app, runs, monitors, agents), soonest to expire first; with --warn, exit 1 when one expires within that many days')
    .option(...WORKSPACE_OPTION)
    .option('--warn <days>', 'exit 1 when a certificate expires within this many days (for cron or CI)')
    .option('--check <hosts...>', 'connect to these hosts (host, host:port or https URL) and check their certificates now, instead of listing the recorded ones')
    .option(...JSON_OPTION)
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
          await withWorkspace(o.workspace, (store) => {
            for (const c of out) if (!c.error) recordCertificate(store, `https://${c.host}:${c.port}/`, c as { validTo?: string });
          });
        } catch {
          /* no workspace here: nothing to record */
        }
        if (o.json) printJson(out);
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
      return withWorkspace(o.workspace, (store) => {
        const list = listCertificates(store);
        const warn = o.warn === undefined ? undefined : Number(o.warn);
        if (warn !== undefined && !(warn >= 0)) throw new CliError('--warn needs a number of days', EXIT.CONFIG_ERROR);
        const soon = warn === undefined ? [] : list.filter((c) => c.daysLeft !== undefined && c.daysLeft <= warn);
        if (o.json) printJson(list);
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
      });
    });
  program
    .command('load-history')
    .description('earlier load tests of the workspace (from the app, testpion load and agents), newest first: throughput, p50/p95/p99, error rate and pass rules')
    .option(...WORKSPACE_OPTION)
    .option('-q, --query <text>', 'only load tests whose name or target contains this')
    .option('-n, --limit <n>', 'how many', '20')
    .option(...JSON_OPTION)
    .action((o: { workspace?: string; query?: string; limit: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const rows = loadHistory(store, { query: o.query, limit: Number(o.limit) || 20 });
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No load tests yet.'));
        for (const r of rows)
          console.log(
            `${new Date(r.startedAt).toLocaleString()}  ${r.name}  ${dim(`${r.virtualUsers} VUs, ${r.durationSec}s`)}  ${Math.round(r.throughput)} req/s  p95 ${formatDuration(r.p95)}${r.ttfbP95 !== undefined ? dim(` (server ${formatDuration(r.ttfbP95)})`) : ''}  ${r.errorRate > 0.01 ? red(`${(r.errorRate * 100).toFixed(1)}% errors`) : `${(r.errorRate * 100).toFixed(1)}% errors`}${r.passed === undefined ? '' : r.passed ? green('  passed') : red('  failed')}`,
          );
      });
    });
  program
    .command('variable-flow')
    .description('how variables flow through a collection run: which requests set each variable in scripts and which use it, in run order; flags used-before-set, never-set and unused')
    .argument('<collection>', 'collection name or id')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_OPTION)
    .action((ref: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const c = requireCollection(store, ref, { loadable: true });
        const flows = collectionVariableFlow(store.getCollection(c.id), definedVariableNames(store, new WorkspaceManager().loadSettings()));
        if (o.json) return printJson(flows);
        const shown = flows.filter((f) => f.setBy.length || f.issue);
        if (!shown.length) return console.log(dim('No variables set by scripts, and no problems found.'));
        for (const f of shown) {
          const issue = f.issue === 'unused' ? yellow(' (set, never used)') : f.issue ? red(f.issue === 'never-set' ? ' (never set)' : ' (used before it is set)') : '';
          console.log(`{{${f.name}}}  ${f.setBy.map((p) => p.name).join(', ') || dim(f.defined ? 'environment / collection' : 'nothing sets it')} → ${f.usedBy.length} use${f.usedBy.length === 1 ? '' : 's'}${issue}`);
        }
        if (shown.some((f) => f.issue && f.issue !== 'unused')) process.exitCode = EXIT.TEST_FAILURE;
      }),
    );
  program
    .command('workspace-report')
    .description('the workspace at a glance as one HTML file to share: requests and tests per day, the health of each collection, monitors and the latest runs (names, counts and timings only)')
    .option(...WORKSPACE_OPTION)
    .option('-d, --days <n>', 'days of activity, up to 90', '14')
    .option('-o, --out <file>', 'write here (default: <workspace>-report.html)')
    .action(async (o: { workspace?: string; days: string; out?: string }) => {
      return withWorkspace(o.workspace, async (store) => {
        const out = resolve(o.out ?? `${store.workspace.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'workspace'}-report.html`);
        writeFileSync(out, workspaceReportHtml(store, { days: Number(o.days) || 14, tzOffsetMin: new Date().getTimezoneOffset(), attention: await workspaceAttention(store) }));
        console.log(green(`Wrote ${out}`));
      });
    });
  const datasets = program
    .command('datasets')
    .description('data files in the workspace datasets/ folder (for run-collection -d and test datasets), newest first; SQLite databases with their tables. `datasets show <name>` prints the rows of one')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_OPTION)
    .option('--add <dataset>', 'add a record to this JSONL dataset (made when missing; ".jsonl" is added without an extension), e.g. an evaluation case')
    .option('--row <json>', 'the record for --add, as JSON: {"message": "Cancel my booking", "expected": "cancellation"}')
    .action(async (o: { workspace?: string; json?: boolean; add?: string; row?: string }) => {
      return withWorkspace(o.workspace, async (store) => {
        if (o.add) {
          let row: Record<string, unknown>;
          try {
            row = JSON.parse(o.row ?? '');
          } catch {
            throw new CliError(`--row must be a JSON object: --row '{"message": "hi", "expected": "greeting"}'`, EXIT.CONFIG_ERROR);
          }
          const out = await appendDatasetRow(store, o.add, row);
          return o.json ? printJson(out) : console.log(green(`${out.path}: ${out.rows} record${out.rows === 1 ? '' : 's'}`));
        }
        const rows = listWorkspaceDatasets(store);
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No datasets. Put CSV, JSON, JSONL or SQLite files in the workspace datasets/ folder.'));
        for (const r of rows) console.log(`${r.path}  ${dim(`${r.format}, ${(r.size / 1024).toFixed(1)} KB${r.tables ? `, tables: ${r.tables.join(', ') || 'none'}` : ''}`)}`);
      });
    });
  datasets
    .command('show')
    .description('the first rows of a dataset with its columns (and the kind of value each holds) and how many records it has; a SQLite database needs --query')
    .argument('<name>', 'the file under datasets/, e.g. users.csv or intents.jsonl')
    .option(...WORKSPACE_OPTION)
    .option('-n, --limit <n>', 'how many rows (default 20, up to 10000)', '20')
    .option('-q, --query <sql>', 'SQLite: the SELECT whose rows are the records')
    .option('--json', 'print as JSON: path, format, count, columns [{ name, type }], rows')
    .action(async (name: string, o: { workspace?: string; limit: string; query?: string; json?: boolean }) => {
      // `datasets` takes --json and -w too: given after `show`, Commander hands them to the parent
      const parent = datasets.opts() as { workspace?: string; json?: boolean };
      return withWorkspace(o.workspace ?? parent.workspace, async (store) => {
        const d = await readWorkspaceDataset(store, name, { limit: Number(o.limit) || 20, query: o.query });
        if (o.json || parent.json) return printJson(d);
        console.log(`${d.path}  ${dim(`${d.format}, ${(d.size / 1024).toFixed(1)} KB, ${d.count} record${d.count === 1 ? '' : 's'}, ${d.columns.length} column${d.columns.length === 1 ? '' : 's'}`)}`);
        if (d.tables && !d.query) return console.log(d.tables.length ? `Tables: ${d.tables.join(', ')}  ${dim('(add --query "SELECT * FROM <table>" to read rows)')}` : dim('No tables'));
        if (!d.columns.length) return console.log(dim('No records'));
        const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').slice(0, 40);
        const widths = d.columns.map((c) => Math.min(40, Math.max(c.name.length, c.type.length, ...d.rows.map((r) => cell(r[c.name]).length))));
        const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
        console.log(bold(line(d.columns.map((c) => c.name))));
        console.log(dim(line(d.columns.map((c) => c.type))));
        for (const r of d.rows) console.log(line(d.columns.map((c) => cell(r[c.name]))));
        if (d.count > d.rows.length) console.log(dim(`… ${d.count - d.rows.length} more (--limit ${d.count} shows them all)`));
      });
    });
  program
    .command('requests')
    .description("list what a collection holds: its HTTP and GraphQL requests, then its gRPC calls and WebSocket / Socket.IO / MQTT connections (run-collection runs them all)")
    .argument('<collection>', 'collection name or id')
    .option(...WORKSPACE_OPTION)
    .option('--health', 'add how each HTTP and GraphQL request has been doing in the app: responses, failed, latest status, median time, whether it has checks')
    .option(...JSON_OPTION)
    .action((ref: string, o: { workspace?: string; json?: boolean; health?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const c = requireCollection(store, ref, { loadable: true });
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
        if (o.json) return printJson(rows);
        for (const r of rows as Array<(typeof rows)[number] & { responses?: number; failed?: number; lastStatus?: number | string; lastOk?: boolean; medianMs?: number; hasChecks?: boolean }>) {
          const health =
            o.health && r.responses !== undefined
              ? '  ' + (r.responses ? `${r.lastOk ? green(String(r.lastStatus ?? 'ok')) : red(String(r.lastStatus ?? 'failed'))} ${r.medianMs !== undefined ? formatDuration(r.medianMs) : ''} ${dim(`${r.failed}/${r.responses} failed`)}` : dim('not sent')) + (r.hasChecks ? '' : yellow(' no checks'))
              : '';
          console.log(`${r.method.padEnd(6)} ${r.folder ? dim(`${r.folder} / `) : ''}${r.name}  ${dim(r.target)}${health}`);
        }
      });
    });
  program
    .command('export')
    .description('export a collection as a Postman v2.1 collection (default), TestPion JSON, an OpenAPI 3.1 document (--format openapi), a Bruno collection folder (--format bruno --out <folder>) or as OpenCollection YAML (--format opencollection --out <folder>, or --format opencollection-file), an Insomnia file (--format insomnia: v5 YAML, insomnia-v4: JSON), an .http file (--format http) or its connections as AsyncAPI 3.0 (--format asyncapi). What the target format cannot hold is listed on stderr (not exported: …)\n<collection> is a collection name or id in the workspace, or a collection file to convert\nA TestPion bundle (.testpion.zip / .testpion.json) holds any items: kind:id items (collection:<id> spec:specs/<path> dataset:<name> mcp-server:<id> ...), --section <kind>, or --all; --uses adds what they use (a collection: its environments, API definitions, datasets, MCP servers, mocks, protos, tests, flows). Secret values are never in it.')
    .argument('[refs...]', 'collection name or id, a file, or an http(s) link; for a bundle: the items as kind:id')
    .option(...WORKSPACE_OPTION)
    .addOption(new Option('-f, --format <format>', 'output format').choices(['postman', 'testpion', 'openapi', 'bruno', 'http', 'asyncapi', 'bundle', ...MORE_EXPORT_FORMATS]).default('postman'))
    .option('--json', 'with --format openapi: JSON instead of YAML')
    .option('-o, --out <file>', 'write to this file instead of stdout (a bundle: <title>.testpion.zip in the current folder; .zip or .json picks the form)')
    .option('--section <kind>', 'a bundle of every item of one kind (collection, environment, spec, dataset, test, mcp-server, mcp-mock, proto, script-package, prompt, load-test, evaluation, monitor, grpc-call, ws-connection, provider)')
    .option('--all', 'a bundle of the whole workspace (AI providers only with --providers)')
    .option('--uses', 'a bundle: add everything the items use')
    .option('--datasets <mode>', 'a bundle: embed, reference or auto (embed up to 10 MB, bigger by reference; default)')
    .option('--providers', 'a bundle: include AI providers in a whole-workspace or section export')
    .option('--extras', 'with --format postman (a .postman.zip) or --format bruno (a folder): add what the collection uses - environments, API definitions, data files, an .mcp.json - and the workspace variables as Postman globals')
    .option('--folder <kind:name>', 'a bundle: the items in one folder of a list, e.g. spec:pets (a test folder: test:smoke/api)')
    .option('--globals', "a bundle: carry the workspace's own variables (the Globals; secret values blank). With --all they travel by default")
    .option('--no-globals', 'a bundle: leave the Globals out of a whole-workspace export')
    .option('--exclude <items>', 'a bundle with --uses: kind:id items (comma separated) that something uses but that stay out; they are listed as left out')
    .option('--title <text>', 'a bundle: its title')
    .action(async (refs: string[], o: { workspace?: string; extras?: boolean; folder?: string; globals?: boolean; exclude?: string; format: 'postman' | 'testpion' | 'openapi' | 'bruno' | 'http' | 'asyncapi' | 'bundle' | (typeof MORE_EXPORT_FORMATS)[number]; json?: boolean; out?: string; section?: string; all?: boolean; uses?: boolean; datasets?: 'auto' | 'embed' | 'reference'; providers?: boolean; title?: string }) => {
      if (o.extras) return runPackageExport(refs[0], o);
      if (wantsBundleExport(refs, o)) return runBundleExport(refs, o);
      if (refs.length !== 1) throw new CliError('Give one collection (name, id, file or link) to export in this format; several items go in a bundle (kind:id items, --format bundle)', EXIT.CONFIG_ERROR);
      const ref = refs[0]!;
      const c = await loadCollectionRef(ref, o.workspace);
      if (o.format === 'bruno') {
        // a folder like the one Bruno keeps in git; the workspace's environments go to environments/ (secret values never)
        if (!o.out) throw new CliError('--format bruno writes a folder: give it with --out <folder>', EXIT.CONFIG_ERROR);
        const wsDir = o.workspace ? undefined : findWorkspaceUp(process.cwd());
        const envs: Environment[] = o.workspace || wsDir ? await withWorkspace(o.workspace ?? wsDir, (store) => store.listEnvironments()) : [];
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
      if (await exportTextFormat(o.format, c, o)) return;
      if (await exportMoreFormat(o.format, c, o)) return;
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
          savedItems = await withWorkspace(wsDir, (store) => collectionSavedItems(store, c.id));
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
    .option(...WORKSPACE_OPTION)
    .option('-o, --out <file>', 'write to this file instead of stdout')
    .action((ref: string, o: { workspace?: string; out?: string }) => {
      return withWorkspace(o.workspace, (store, ephemeral) => {
        const json = JSON.stringify(exportPostmanEnvironment(requireEnvironment(store, ref)), null, 2) + '\n';
        if (o.out) {
          writeFileSync(resolve(o.out), json);
          console.error(dim(`Environment written to ${resolve(o.out)}`));
        } else process.stdout.write(json);
      });
    });
  program
    .command('docs')
    .description('write Markdown or HTML (--html) documentation for a collection (descriptions, requests, parameters, examples; secrets masked)\n<collection> is a collection name or id in the workspace, or a TestPion / Postman v2.1 collection or OpenAPI file or link')
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option(...WORKSPACE_OPTION)
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
    .command('scripts')
    .description('script tools')
    .command('convert')
    .description("rewrite scripts between Postman's pm.* and TestPion's tp.* (both always work), or from another tool's script API (--from bruno | insomnia | thunder | hoppscotch | postman) to tp.*: the scripts of a collection, or a file (--file)")
    .option('-w, --workspace <nameOrPath>', 'the workspace (not needed with --file)')
    .option('--to <tp|pm>', 'the name to use', 'tp')
    .option('--from <api>', 'convert from this tool\'s script API: postman, insomnia, bruno, thunder or hoppscotch')
    .option('--file <path>', 'convert this script file (- reads stdin) and print the result')
    .option('--lift-tests', 'with --from and a collection: turn simple tests into assertions')
    .option('--collection <nameOrId>', 'only this collection (default: all)')
    .option('--dry-run', 'only report what would change')
    .option('--report <file>', 'write the findings (calls with no equivalent, scripts that do not parse) as JSON')
    .option('--json', 'print the result as JSON')
    .action((o) => {
      if (o.to !== 'tp' && o.to !== 'pm') throw new CliError('--to must be tp or pm', EXIT.CONFIG_ERROR);
      // another tool's script API → tp.*
      if (o.from || o.file) {
        const tool = requireScriptTool(o.from ?? 'postman');
        if (o.to !== 'tp') throw new CliError('--from converts to tp.*: leave --to out', EXIT.CONFIG_ERROR);
        if (o.file) {
          const code = o.file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(o.file), 'utf8');
          const r = convertScriptText(code, tool);
          if (o.report) writeFileSync(resolve(o.report), JSON.stringify({ status: r.status, changes: r.changes, findings: r.findings }, null, 2) + '\n');
          if (o.json) printJson({ from: tool, status: r.status, changes: r.changes, code: r.code, findings: r.findings, reason: r.reason });
          else {
            process.stdout.write(r.code.endsWith('\n') ? r.code : r.code + '\n');
            for (const f of r.findings) console.error(yellow(`line ${f.line}: ${f.message}`));
          }
          return;
        }
        if (!o.workspace) throw new CliError('Give the workspace (-w) for a collection, or a script file (--file)', EXIT.CONFIG_ERROR);
        return withWorkspace(o.workspace, (store) => {
          const cols = o.collection ? [requireCollection(store, String(o.collection), { loadable: true })] : store.listCollections().filter((c) => !c.problem);
          const results = cols.map((c) => {
            const r = convertCollectionScriptsFrom(c, tool, { liftTests: !!o.liftTests });
            if (!o.dryRun && (r.converted || r.lifted)) store.saveCollection(r.collection);
            return { collection: c.name, converted: r.converted, lifted: r.lifted, kept: r.kept, findings: r.findings.filter((f) => f.severity !== 'info') };
          });
          if (o.report) writeFileSync(resolve(o.report), JSON.stringify(results, null, 2) + '\n');
          if (o.json) printJson({ from: tool, dryRun: !!o.dryRun, results });
          else
            for (const r of results) {
              console.log(`${r.converted || r.lifted ? green(`${o.dryRun ? 'Would convert' : 'Converted'} ${r.converted} script(s)${r.lifted ? ` and lift ${r.lifted} test(s)` : ''}`) : dim('No change')} in "${r.collection}"${r.kept.length ? yellow(` (${r.kept.length} kept: ${r.kept.map((s) => s.where).join(', ')})`) : ''}`);
              for (const f of r.findings.slice(0, 10)) console.log(yellow(`  ${f.where.join(' / ')}: ${f.message}`));
            }
        });
      }
      if (!o.workspace) throw new CliError('Give the workspace with -w', EXIT.CONFIG_ERROR);
      return withWorkspace(o.workspace, (store) => {
        const cols = o.collection ? [requireCollection(store, String(o.collection), { loadable: true })] : store.listCollections().filter((c) => !c.problem);
        const results = cols.map((c) => {
          const r = convertCollectionScripts(c, o.to === 'tp' ? 'pm' : 'tp', o.to);
          if (!o.dryRun && r.changed) store.saveCollection(r.collection);
          return { collection: c.name, changed: r.changed, replacements: r.replacements, skipped: r.skipped };
        });
        if (o.json) printJson({ to: o.to, dryRun: !!o.dryRun, results });
        else
          for (const r of results)
            console.log(`${r.changed ? green(`${o.dryRun ? 'Would convert' : 'Converted'} ${r.changed} script(s)`) : dim('No change')} in "${r.collection}"${r.skipped.length ? yellow(` (${r.skipped.length} skipped: ${r.skipped.map((s) => s.where).join(', ')})`) : ''}`);
      });
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
    .option('--rag-evaluation <name>', 'run a saved RAG evaluation (`testpion rag run`) with its metrics and gates; the judge model\'s key is a CI secret')
    .option('--rag-preset <id>', 'with --rag-evaluation: a metric preset replacing its metrics')
    .option('--rag-judge <provider/model>', 'with --rag-evaluation: the judge')
    .option('--rag-min <metric=value...>', 'with --rag-evaluation: gates, e.g. faithfulness=0.8 (the mean must reach it)')
    .option('--rag-baseline <run>', 'with --rag-evaluation: compare with this run, metric by metric')
    .option('--rag-max-cost <usd>', 'with --rag-evaluation: stop judging once this much is spent')
    .option('--rag-compat <name>', 'with --rag-evaluation: ragas reads the Ragas metric names with Ragas options')
    .option('--rag-repeat-target <n>', 'with --rag-evaluation: call the RAG system n times per question (2 to 10)')
    .option('--rag-nightly <cron>', 'with --rag-evaluation: a nightly job on this cron schedule (UTC, "0 3 * * *") instead of every push')
    .option('--rag-sample <n>', 'with --rag-nightly: score n questions per night, a different set each day')
    .option('--rag-regression', 'with --rag-nightly: fail when a metric dropped against the previous night')
    .option('--rag-max-drop <n>', 'with --rag-regression: the smallest drop that fails (default 0.05)')
    .option('--rag-comment', 'with --rag-evaluation (GitHub): post the metrics table as a pull-request comment')
    .option('--run <runId>', 'instead of --suite / --collection / --tests: what this finished run ran, in its environment ("last": the newest finished run of test files or a collection)')
    .option('--data [file]', 'one flow file (--tests file): run it once per row of this data (a dataset; without a value, the file\'s own data:)')
    .option('--env-matrix <names...>', 'one flow file: run it in each of these environments and compare step by step')
    .option('--timeline-html', 'one flow file: keep the run as an HTML timeline (test-results/timeline.html), also when it fails')
    .option('-e, --environment <name>', 'environment to run with')
    .option('--allow-production', 'the pipeline may send data-changing requests to an environment marked as production (adds --allow-production to its run line)')
    .option('--workspace-dir <path>', 'the workspace folder relative to the repository root', '.')
    .option('--openapi <file>', 'OpenAPI document in the repository: pull requests fail on breaking changes against the target branch')
    .option('--start <command>', 'integration tests: start the system under test first, in the background (e.g. "npm start", "docker compose up -d")')
    .option('--wait-for <url>', 'with --start: wait until this URL answers (the health check) before the tests')
    .option('--wait-seconds <n>', 'how long to wait for it (default 90)')
    .option('-o, --out <file>', 'write the file here (default: print it)')
    .option('--json', 'print { path, content, secrets, command } as JSON')
    .action((provider: string, o) => {
      return withWorkspace(o.workspace, (store) => {
        // --run: the run's files (with its filter) or collection, and its environment unless -e names another
        const fromRun = o.run ? ciTargetOfRun(store, finishedRun(store, String(o.run))) : undefined;
        if (fromRun?.note) console.error(dim(fromRun.note));
        const c = ciConfig(store, {
          provider: provider as CiProvider,
          suite: o.suite,
          collection: o.collection,
          folders: o.folder,
          tests: o.tests,
          ...(o.ragEvaluation ? { ragEvaluation: o.ragEvaluation, ragPreset: o.ragPreset, ragJudge: o.ragJudge, ragMin: o.ragMin, ragBaseline: o.ragBaseline, ragMaxCost: o.ragMaxCost !== undefined ? Number(o.ragMaxCost) : undefined, ragCompat: o.ragCompat, ragRepeatTarget: o.ragRepeatTarget ? Number(o.ragRepeatTarget) : undefined, ragComment: o.ragComment, ragNightly: o.ragNightly, ragSample: o.ragSample ? Number(o.ragSample) : undefined, ragRegression: o.ragRegression, ragMaxDrop: o.ragMaxDrop ? Number(o.ragMaxDrop) : undefined } : {}),
          ...fromRun?.target,
          data: o.data === true ? '' : o.data,
          envMatrix: o.envMatrix,
          timelineHtml: o.timelineHtml,
          allowProduction: o.allowProduction,
          environment: o.environment ?? fromRun?.environment,
          workspaceDir: o.workspaceDir,
          openapi: o.openapi,
          start: o.start,
          waitFor: o.waitFor,
          waitSeconds: o.waitSeconds ? Number(o.waitSeconds) : undefined,
        });
        if (o.json) return printJson(c);
        if (o.out) {
          writeFileSync(resolve(o.out), c.content);
          console.error(green(`Wrote ${o.out}`) + dim(` (usually ${c.path})`));
        } else process.stdout.write(c.content);
        if (c.secrets.length) console.error(dim(`CI secrets to create: ${c.secrets.map((x) => `${x.name} (${x.description})`).join(', ')}`));
      });
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
            if (o.json) printJson(r);
            else console.log(green(`${url} answered ${res.status} after ${r.afterMs} ms (${attempts} ${attempts === 1 ? 'try' : 'tries'})`));
            return;
          }
          last = `status ${res.status}`;
        } catch (e) {
          last = (e as Error).message;
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      const r = { ready: false, url, afterMs: Date.now() - t0, attempts, last };
      if (o.json) printJson(r);
      else console.log(red(`${url} did not answer within ${timeout / 1000} s (${attempts} tries; last: ${last})`));
      process.exitCode = EXIT.EXECUTION_ERROR;
    });
  const envCmd = program.command('env').description('list environments, set plain variables, and set their order');
  envCmd
    .command('matrix')
    .description('every variable across every environment: set, empty, missing or off (never values); exit 1 when one is incomplete somewhere')
    .option(...WORKSPACE_OPTION)
    .option('--all', 'also list variables that are set everywhere')
    .option(...JSON_OPTION)
    .action((o: { workspace?: string; all?: boolean; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const m = environmentMatrix(store, { secrets: cliSecrets() });
        const rows = o.all ? m.rows : m.rows.filter((r) => r.incompleteIn.length);
        if (o.json) printJson({ ...m, rows });
        else {
          const w = Math.min(32, Math.max(8, ...m.rows.map((r) => r.key.length)));
          console.log(`${''.padEnd(w)}  ${m.environments.map((e) => bold(e.slice(0, 12).padEnd(12))).join(' ')}`);
          const mark = { set: green('set'.padEnd(12)), empty: yellow('empty'.padEnd(12)), missing: red('missing'.padEnd(12)), disabled: dim('off'.padEnd(12)) };
          for (const r of rows) console.log(`${r.key.slice(0, w).padEnd(w)}  ${r.cells.map((c) => mark[c.state]).join(' ')}`);
          console.log(m.incomplete ? yellow(`${m.incomplete} of ${m.rows.length} variables are missing, empty or off somewhere`) : green(`All ${m.rows.length} variables are set in every environment`));
        }
        process.exitCode = m.incomplete ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      });
    });
  envCmd
    .command('set')
    .description('set plain variables of an environment (key=value …); secret variables are set in the app')
    .argument('<environment>', 'environment name or id')
    .argument('<assignments...>', 'key=value pairs')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--create', 'create the environment if it does not exist')
    .option('--also-in <environments...>', 'also add them to these environments where they are missing (empty; --copy for the same values)')
    .option('--copy', 'with --also-in: the same values')
    .option('--json', 'print the variable names as JSON')
    .action((ref: string, pairs: string[], o) => {
      return withWorkspace(o.workspace, async (store) => {
        const values: Record<string, string> = {};
        for (const p of pairs) {
          const i = p.indexOf('=');
          if (i <= 0) throw new CliError(`Expected key=value, got "${p}"`, EXIT.CONFIG_ERROR);
          values[p.slice(0, i)] = p.slice(i + 1);
        }
        const env = setEnvironmentVariables(store, ref, values, { create: !!o.create });
        const also = o.alsoIn?.length ? await addVariablesToEnvironments(store, env.id, Object.keys(values), (o.alsoIn as string[]).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean), { copy: !!o.copy }) : undefined;
        if (o.json) printJson({ environment: env.name, set: Object.keys(values), ...(also ? { also } : {}) });
        else {
          console.log(green(`${env.name}: set ${Object.keys(values).join(', ')}`));
          for (const a of also ?? []) console.log(a.added.length ? green(`${a.environment}: added ${a.added.join(', ')}`) : `${a.environment}: has them already`);
        }
      }).catch((e) => {
        throw e instanceof CliError ? e : new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      });
    });
  envCmd
    .command('unset')
    .description('remove plain variables from an environment')
    .argument('<environment>', 'environment name or id')
    .argument('<keys...>', 'variable names')
    .requiredOption('-w, --workspace <nameOrPath>')
    .action((ref: string, keys: string[], o) => {
      return withWorkspace(o.workspace, (store) => {
        const env = unsetEnvironmentVariables(store, ref, keys);
        console.log(green(`${env.name}: removed ${keys.join(', ')}`));
      }).catch((e) => {
        throw e instanceof CliError ? e : new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      });
    });
  envCmd
    .command('get')
    .description("print a plain variable's value (secret values are never printed)")
    .argument('<environment>', 'environment name or id')
    .argument('<key>', 'variable name')
    .requiredOption('-w, --workspace <nameOrPath>')
    .action((ref: string, key: string, o) => {
      return withWorkspace(o.workspace, (store) => {
        const env = findEnvironment(store, ref);
        if (!env) throw new CliError(`No environment "${ref}"`, EXIT.CONFIG_ERROR);
        const v = env.variables.find((x) => x.key === key);
        if (!v) throw new CliError(`${env.name} has no variable "${key}"`, EXIT.CONFIG_ERROR);
        if ((v as { secret?: boolean }).secret) throw new CliError(`"${key}" is a secret variable: its value is never printed`, EXIT.CONFIG_ERROR);
        console.log(v.value);
      });
    });
  envCmd
    .command('list')
    .description('list environments in display order, with variable names (never values)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option(...JSON_OPTION)
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        const all = store.listEnvironments();
        const envs = all.map((e) => ({ id: e.id, name: e.name, production: !!e.isProduction, isProduction: !!e.isProduction, variables: e.variables.filter((v) => v.enabled !== false).map((v) => (v.secret ? `${v.key} (secret)` : v.key)), ...(e.problem ? { problem: e.problem } : {}) }));
        if (o.json) printJson(envs);
        else for (const e of envs.filter((x) => !x.problem)) console.log(`${e.name}${e.production ? red(' (production)') : ''}\t${dim(e.variables.join(', '))}`);
        if (!o.json) warnProblems(all, 'environment');
      });
    });
  envCmd
    .command('order')
    .description('set the display order of environments (names or ids, first to last; others follow)')
    .argument('<environments...>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print the new order as JSON')
    .action((refs: string[], o) => {
      return withWorkspace(o.workspace, (store) => {
        const names = store.reorderEnvironments(refs.map((r) => requireEnvironment(store, r).id)).map((e) => e.name);
        if (o.json) printJson(names);
        else console.log(names.join('\n'));
      });
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
    .option(...JSON_OPTION)
    .action(async (left: string, right: string, o) => {
      return withWorkspace(o.workspace, async (store) => {
        if (o.request) {
          const cols = o.collection ? [requireCollection(store, String(o.collection), { loadable: true })] : store.listCollections().filter((c) => !c.problem);
          const want = String(o.request).toLowerCase();
          const collection = cols.find((c) => collectionRequests(c).some((r) => r.id === o.request || r.name.toLowerCase() === want));
          if (!collection) throw new CliError(`No saved request "${o.request}"`, EXIT.CONFIG_ERROR);
          for (const e of [left, right]) if (!store.getEnvironment(e)) throw new CliError(`No environment "${e}"`, EXIT.CONFIG_ERROR);
          const r = await compareRequestAcrossEnvironments({ collection, request: o.request, left, right, context: (environment) => cliContext(store, environment, { collectionId: collection.id }) });
          if (o.json) printJson(r);
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
        const d = compareEnvironments(get(left), get(right), { values: !!o.values, secrets: cliSecrets(), redactor: new Redactor(new WorkspaceManager().loadSettings().redactFields) });
        if (!o.all) d.rows = d.rows.filter((r) => r.status !== 'same');
        if (o.json) printJson(d);
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
      });
    });
}
