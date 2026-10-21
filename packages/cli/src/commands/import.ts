/** `testpion import` (a file, several, a folder, an archive or a link; preview first when it is more than one file), `import-report` and `import-undo`. */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  WorkspaceManager,
  Redactor,
  detectFormat,
  expandImportFiles,
  fetchImportText,
  fetchPostmanInputs,
  parsePostmanRef,
  parseRepoLink,
  fetchRepoFiles,
  type ReimportAction,
  readImportPath,
  readImportReport,
  listImportReceipts,
  undoMany,
  planInputs,
  importInputs,
  importRequestSnippet,
  isRequestSnippet,
  keepPmApplies,
  reportMarkdown,
  findingDetail,
  resolveArazzoSources,
  bundleWsdl,
  isWsdl,
  type ImportInput,
  type ImportManyPlan,
  type ImportPlan,
  type ImportReport,
  type SkippedFile,
  type WorkspaceImportResult,
} from '@testpion/core';
import { isBundleFile, runBundleImport } from './bundle.js';
import { EXIT, green, yellow, dim, bold, CliError, printJson, withWorkspace, JSON_OPTION, JSON_RESULT_OPTION } from '../shared.js';

/** clinic.http / api.rest → the collection's name; a GraphQL schema file's name too. */
function httpFileName(file: string): string | undefined {
  const base = file.split(/[\\/]/).pop() ?? '';
  return /\.(http|rest|graphqls?|gql)$/i.test(base) ? base.replace(/\.(http|rest|graphqls?|gql)$/i, '') : undefined;
}

/** ".env.staging" / "staging.env" → "staging" (else the default). */
function dotenvName(file: string): string | undefined {
  const base = file.split(/[\\/]/).pop() ?? '';
  if (!/(^\.env|\.env$)/.test(base)) return undefined;
  return base.replace(/^\.env\.?/, '').replace(/\.env$/, '') || undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function printPlan(label: string, p: ImportPlan): void {
  const c = p.collections;
  const what = [
    ...c.map((x) => `collection "${x.name}" (${plural(x.requests, 'request')}${x.folders ? `, ${plural(x.folders, 'folder')}` : ''}${x.nameTaken ? '; the name is taken, so it gets its own id' : ''})`),
    ...p.environments.map((e) => `environment "${e.renamedTo ?? e.name}" (${plural(e.variables, 'variable')})`),
    ...p.specs.map((s) => `API definition ${s.path}${s.existing === 'different' ? ' (a different one is there: both are kept)' : ''}`),
    ...p.flows.map((f) => `flow ${f.path}`),
    ...Object.entries(p.library).map(([k, n]) => `${plural(n, k === 'grpc' ? 'gRPC call' : 'connection')}`),
  ];
  console.log(bold(label) + dim(`  ${p.tool ?? p.format}`));
  for (const w of what) console.log(`  creates ${w}`);
  if (p.globals) console.log(`  sets ${plural(p.globals, 'global variable')}`);
  if (p.cookies) console.log(`  adds ${plural(p.cookies, 'cookie')} to the cookie jar`);
  // a source imported before: the import updates that collection item by item
  for (const rp of p.reimport ?? []) {
    const c = rp.counts;
    console.log(`  UPDATES collection "${rp.collectionName}" (imported from this source before): ${c.replace} to replace, ${c.new} new, ${c.skip} to skip${c.conflicts ? `, ${plural(c.conflicts, 'conflict')} (edited here too: skipped unless --update-decisions says replace)` : ''}`);
    for (const i of [rp.root, ...rp.items].filter((x) => x.action !== 'skip' || x.conflict).slice(0, 12)) console.log(dim(`    ${i.action.padEnd(7)} ${i.path.length ? i.path.join(' / ') : '(collection settings)'}  ${i.reason}  [${i.key}]`));
    if (rp.gone.length) console.log(dim(`    ${plural(rp.gone.length, 'item')} no longer in the source (kept)`));
  }
  printReport(p.report);
}

function printReport(r: ImportReport, max = 12): void {
  const s = r.summary;
  console.log(dim(`  ${s.items} items: ${s.full} fully, ${s.changed} with changes, ${s.notImported} not imported${s.valuesNeeded ? `, ${plural(s.valuesNeeded, 'value')} to enter` : ''}`));
  if (r.scripts) console.log(dim(`  scripts: ${r.scripts.converted} converted to tp.*${r.scripts.kept ? `, ${r.scripts.kept} kept as written` : ''}${r.scripts.todo ? `, ${r.scripts.todo} marked TODO(import)` : ''}`));
  let shown = 0;
  for (const g of r.groups) {
    if (g.severity === 'info' && g.code !== 'SECRET_VALUES') continue;
    console.log(yellow(`  ${g.title} (${g.count})`));
    for (const f of r.findings.filter((x) => x.code === g.code)) {
      if (shown++ >= max) break;
      console.log(yellow(`    ${f.where.length ? `${f.where.join(' / ')}: ` : ''}${findingDetail(f)}`));
    }
  }
  const total = r.findings.filter((f) => f.severity !== 'info').length;
  if (shown < total) console.log(yellow(`    … and ${total - shown} more (--json or --report lists them all)`));
}

function reportFile(path: string, reports: Array<{ source: string; report: ImportReport }>): void {
  const out = resolve(path);
  const md = /\.md$/i.test(path);
  const text = md
    ? reports.map((r) => `<!-- ${r.source} -->\n${reportMarkdown(r.report)}`).join('\n')
    : JSON.stringify(reports.length === 1 ? reports[0]!.report : reports.map((r) => ({ source: r.source, ...r.report })), null, 2) + '\n';
  writeFileSync(out, text);
  console.error(dim(`Report written to ${out}`));
}

export function registerImportCommands(program: Command): void {
  program
    .command('import')
    .description(
      'import OpenAPI/Swagger, Postman, Insomnia, Bruno (folders and OpenCollection YAML too), Hoppscotch, HAR, .env or collection files, Arazzo workflows (as flow files under tests/arazzo/), or a copied cURL / fetch / PowerShell request, into a workspace. Several files, a folder or a ZIP (a Postman data export) are previewed first: --apply imports them',
    )
    .argument('[input...]', 'file(s) to import, a collection folder, a .zip, an http(s) link (OpenAPI URL, GitHub file, Postman API link), postman:collection/<id> (needs a Postman API key), or - to read stdin (e.g. a cURL command from the clipboard)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--preview', 'show what would be created and what would not come over, and write nothing (a bundle: say what importing would do per item)')
    .option('--on-conflict <choice>', 'a TestPion bundle: when an item is already here: keep-both (default; the new one is renamed), replace (yours is replaced; --undo restores it) or skip')
    .option('--only <kinds>', 'a bundle: import only these kinds or kind:id items (comma separated); `workspace` is the Globals the bundle carries')
    .option('--globals <mode>', "a bundle: the workspace's own variables (Globals) it carries: merge (default: add the new keys), replace (also take its values) or skip")
    .option('--into <collection[/folder]>', "a bundle: add its collection's folders and requests under this collection id (or collection id/folder id) instead of making a new collection")
    .option('--decisions <file>', 'a bundle: a JSON file of "kind:id": "keep-both" | "replace" | "skip" for single items')
    .option('--max-size <mb>', 'a bundle: refuse a file larger than this many megabytes')
    .option('--undo <importId>', 'take back a bundle import (what it made is removed, what it replaced is restored)')
    .option('--list', 'list the bundle imports that can be undone')
    .option('--apply', 'import several files, a folder or a ZIP (they are previewed by default); a single file is imported without it')
    .option('--report <file>', 'write the compatibility report (.json, or .md for Markdown)')
    .option('--collection <name>', 'for a cURL / fetch / PowerShell request: the collection to add it to (created if needed)', 'Imported')
    .option('--folder <path>', 'for a request: folder path inside the collection, e.g. "Auth / Tokens"')
    .option('--name <name>', 'for a request: its name (default: method and path)')
    .option('--no-contract-checks', 'for an OpenAPI document: do not add openapi contract checks to the requests')
    .option('--replace-spec', 'for an OpenAPI / AsyncAPI document: replace a different document of the same name in specs/ (it goes to the trash; default: keep both, the new one as name-2)')
    .option('--keep-pm', "for Postman / Insomnia: keep pm.* in scripts (default: they are converted to TestPion's tp.*; pm.* runs either way)")
    .option('--lift-tests', 'turn simple tests (a status, a response time, a header, a JSON field) of the scripts into assertions')
    .option('--new-copy', 'when the source was imported before, add another collection instead of updating the one it made')
    .option('--update-decisions <file>', 'an update: a JSON file of "<item key>": "replace" | "new" | "skip" (the keys the preview prints) to override what the update would do')
    .option('--fetch-sources', 'for Arazzo: download OpenAPI source descriptions given as http(s) URLs (default: only files next to the Arazzo file or in the workspace, e.g. specs/)')
    .option('--postman-api-key <key>', 'a Postman API key for postman:… ids and links (or the POSTMAN_API_KEY variable); sent only to api.getpostman.com')
    .option(...JSON_RESULT_OPTION)
    .action(async (inputsArg: string[], o) => {
      // a TestPion bundle (.testpion.zip / .testpion.json, a workspace export) merges with the user's choices (commands/bundle.ts)
      if (o.undo || o.list || (inputsArg.length === 1 && inputsArg[0] !== '-' && isBundleFile(inputsArg[0]!))) return runBundleImport(inputsArg[0], o);
      if (!inputsArg.length) throw new CliError('Give a file to import (or --undo <importId> / --list for a bundle import)', EXIT.CONFIG_ERROR);
      return withWorkspace(o.workspace, async (store) => {
        // ---- gather the inputs
        const inputs: ImportInput[] = [];
        const skipped: SkippedFile[] = [];
        let container = false;
        /** Where a plain file came from on disk (its folder is where an Arazzo document looks for its OpenAPI files). */
        const fileOf = new Map<ImportInput, string>();
        const apiKey = o.postmanApiKey ?? process.env.POSTMAN_API_KEY;
        for (const arg of inputsArg) {
          // a GitHub / GitLab repository or folder (public only: no credential is sent)
          const repo = /^https:\/\//i.test(arg) ? parseRepoLink(arg) : undefined;
          if (repo) {
            const fetched = await fetchRepoFiles(repo);
            const expanded = expandImportFiles(fetched.files, { folderName: fetched.folderName });
            inputs.push(...expanded.inputs);
            skipped.push(...fetched.skipped, ...expanded.skipped);
            container = true;
            continue;
          }
          if (/^https?:\/\//i.test(arg) || /^postman:/i.test(arg)) {
            const ref = parsePostmanRef(arg);
            if (ref) {
              inputs.push(...(await fetchPostmanInputs(ref, apiKey)));
              container ||= ref.kind === 'workspace';
              continue;
            }
            if (/^postman:/i.test(arg)) throw new CliError(`"${arg}" is not a Postman reference: use postman:collection/<id>, postman:environment/<id> or postman:workspace/<id>`, EXIT.CONFIG_ERROR);
            const link = await fetchImportText(arg);
            inputs.push({ name: link.fileName ?? arg, text: link.text, source: link.url, fileCount: 1 });
            continue;
          }
          if (arg === '-') {
            inputs.push({ name: 'stdin', text: readFileSync(0, 'utf8'), source: '-', fileCount: 1 });
            continue;
          }
          if (!existsSync(arg)) throw new CliError(`${arg} does not exist`, EXIT.CONFIG_ERROR);
          const isDir = statSync(arg).isDirectory();
          const read = readImportPath(arg);
          const expanded = expandImportFiles(read.files, { folderName: read.folderName });
          // a ZIP or a folder is a container: its contents are previewed before they are written
          container ||= isDir || /\.zip$/i.test(arg);
          for (const i of expanded.inputs) {
            inputs.push(i);
            if (!isDir && !/\.zip$/i.test(arg)) fileOf.set(i, resolve(arg));
          }
          skipped.push(...expanded.skipped);
        }
        if (!inputs.length) throw new CliError(`Nothing to import: ${skipped.length ? `${plural(skipped.length, 'file')} skipped (${skipped.slice(0, 3).map((s) => `${s.path}: ${s.why}`).join('; ')})` : 'no file given'}`, EXIT.CONFIG_ERROR);

        // a local WSDL's schemas and WSDLs next to it (schemaLocation="types.xsd")
        for (const i of inputs) {
          const f = fileOf.get(i);
          if (f && isWsdl(i.text)) i.text = await bundleWsdl(i.text, f, async (loc) => (existsSync(loc) ? readFileSync(loc, 'utf8') : undefined));
        }
        const scripts = o.keepPm ? ('keep' as const) : ('tp' as const);

        // ---- one copied request (cURL, fetch, PowerShell, HTTPie): saved to a collection
        if (inputs.length === 1 && isRequestSnippet(inputs[0]!.text)) {
          // secrets in the command (tokens, keys, cookies) become {{variables}}; they are never written to disk
          const r = importRequestSnippet(store.listCollections().filter((c) => !c.problem), inputs[0]!.text, new Redactor(new WorkspaceManager().loadSettings().redactFields), { collection: o.collection, folder: o.folder, name: o.name });
          const saved = store.saveCollection(r.collection);
          const out = { format: r.format, collection: saved.name, collectionId: saved.id, createdCollection: r.created, request: r.node.name, requestId: r.node.id, method: r.node.request.method, url: r.node.request.url, placeholders: r.placeholders };
          if (o.json) printJson(out);
          else {
            console.log(green(`Imported ${r.format} request "${r.node.name}" into collection "${saved.name}"`));
            if (r.placeholders.length) console.log(yellow(`Secrets were replaced by variables; set them as secret environment variables: ${r.placeholders.map((p) => `${p.variable} (${p.where})`).join(', ')}`));
          }
          return;
        }

        // ---- preview (asked for, or by default for several files, a folder or a ZIP)
        const many = inputs.length > 1 || container;
        if (o.preview || (many && !o.apply)) {
          const plan: ImportManyPlan = planInputs(store, inputs, skipped, { scripts, liftTests: !!o.liftTests });
          if (o.report) reportFile(o.report, plan.inputs.flatMap((p) => ('plan' in p ? [{ source: p.input.source, report: p.plan.report }] : [])));
          if (o.json) printJson({ preview: true, ...plan, applyWith: many && !o.preview ? 'testpion import … --apply' : undefined });
          else {
            console.log(bold(`Preview of ${plural(inputs.length, 'import')}: nothing was written`));
            for (const p of plan.inputs) {
              if ('plan' in p) printPlan(p.input.source, p.plan);
              else console.log(yellow(`${p.input.source}: cannot be imported: ${p.error.message}`));
            }
            for (const s of skipped.slice(0, 15)) console.log(dim(`skipped ${s.path}: ${s.why}`));
            if (skipped.length > 15) console.log(dim(`… and ${skipped.length - 15} more files skipped`));
            const t = plan.totals;
            console.log(green(`${plural(t.collections, 'collection')}, ${plural(t.requests, 'request')}, ${plural(t.environments, 'environment')}`) + (t.errors ? yellow(`, ${plural(t.errors, 'file')} that cannot be imported`) : ''));
            if (!o.preview) console.log(dim('Add --apply to import them.'));
          }
          if (plan.totals.errors && !plan.totals.collections && !plan.totals.environments) process.exitCode = EXIT.CONFIG_ERROR;
          return;
        }

        // ---- import
        const arazzoFor = async (i: ImportInput) => {
          if (detectFormat(i.text) !== 'arazzo') return undefined;
          const f = fileOf.get(i);
          const baseDir = f ? dirname(f) : undefined;
          return { baseDir, sources: (await resolveArazzoSources(i.text, { workspace: store.root, baseDir, fetch: o.fetchSources ? async (u) => (await fetchImportText(u)).text : undefined })).sources };
        };
        const arazzo = new Map<ImportInput, Awaited<ReturnType<typeof arazzoFor>>>();
        for (const i of inputs) arazzo.set(i, await arazzoFor(i));
        let decisions: Record<string, ReimportAction> | undefined;
        if (o.updateDecisions) {
          if (!existsSync(o.updateDecisions)) throw new CliError(`${o.updateDecisions} does not exist`, EXIT.CONFIG_ERROR);
          try {
            decisions = JSON.parse(readFileSync(o.updateDecisions, 'utf8'));
          } catch {
            throw new CliError(`${o.updateDecisions} is not valid JSON`, EXIT.CONFIG_ERROR);
          }
        }
        const { imported, receipts } = importInputs(store, inputs, {
          contractChecks: o.contractChecks !== false,
          scripts,
          liftTests: !!o.liftTests,
          // a source imported before updates the collection it made (item by item), unless --new-copy
          update: o.newCopy ? false : decisions ? { decisions } : true,
          specs: o.replaceSpec ? 'replace' : 'keep-both',
          envName: (i) => dotenvName(i.source) ?? httpFileName(i.source) ?? i.name,
          arazzo: (i) => arazzo.get(i),
        });
        if (o.report) reportFile(o.report, imported.flatMap((x) => (x.result?.report ? [{ source: x.input.source, report: x.result.report }] : [])));
        const flat = (r: WorkspaceImportResult) => ({
          format: r.format,
          collection: r.collection?.name,
          collectionId: r.collection?.id,
          collections: r.collections,
          environment: r.environment?.name,
          environments: r.environments?.map((e) => e.name),
          flows: r.flows,
          updated: r.updated,
          globals: r.globals,
          cookies: r.cookies,
          secretsToSet: r.secretsToSet,
          specPath: r.specPath,
          specKeptBoth: r.specKeptBoth,
          specReplaced: r.specReplaced,
          contractChecks: r.contractChecks,
          scriptWarnings: r.scriptWarnings,
          notes: r.notes,
          scripts: r.scripts,
          report: r.report,
          importId: r.receipt?.id,
        });
        if (o.json) {
          if (!many && imported[0]?.result) printJson(flat(imported[0].result));
          else printJson({ imported: imported.map((x) => ({ source: x.input.source, ...(x.result ? flat(x.result) : { error: x.error }) })), skipped, receipts });
        } else {
          for (const x of imported) {
            if (!x.result) {
              console.log(yellow(`${x.input.source}: cannot be imported: ${x.error!.message}`));
              continue;
            }
            printImported(x.result, many ? x.input.source : undefined);
          }
          if (many) for (const s of skipped.slice(0, 15)) console.log(dim(`skipped ${s.path}: ${s.why}`));
          if (receipts.length) console.log(dim(`To take it back: testpion import-undo ${receipts.join(' ')} -w <workspace>`));
        }
        if (imported.some((x) => x.error) && !imported.some((x) => x.result)) process.exitCode = EXIT.CONFIG_ERROR;
      });
    });

  program
    .command('import-report')
    .description('print the compatibility report of an import (the last 30 of a workspace are kept); without an id, list the imports')
    .argument('[id]', 'the import id (imp-…) printed after an import')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--markdown', 'print the report as Markdown')
    .option(...JSON_OPTION)
    .action((id: string | undefined, o) =>
      withWorkspace(o.workspace, (store) => {
        if (!id) {
          const list = listImportReceipts(store);
          if (o.json) printJson(list);
          else if (!list.length) console.log(dim('No imports kept in this workspace.'));
          else for (const i of list) console.log(`${i.id}  ${dim(i.at)}  ${i.format}  ${[...i.collections, ...i.environments].join(', ')}  ${dim(`${i.summary.changed} with changes, ${i.summary.notImported} not imported`)}`);
          return;
        }
        const { receipt, report } = readImportReport(store, id);
        if (o.json) printJson({ receipt, report });
        else if (o.markdown) process.stdout.write(reportMarkdown(report));
        else {
          console.log(bold(`${receipt.id}  ${receipt.format}  ${receipt.at}`));
          printReport(report, 50);
        }
      }),
    );

  program
    .command('import-undo')
    .description('take an import back: its collections, environments and API definitions go to Recently deleted (`testpion trash restore` puts them back), its flow files are removed. Refused while an imported collection was edited, unless --force')
    .argument('<id...>', 'import ids (imp-…) printed after an import, or listed by `testpion import-report`')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--force', 'undo even if the imported collections were edited since')
    .option(...JSON_OPTION)
    .action((ids: string[], o) =>
      withWorkspace(o.workspace, (store) => {
        const results = undoMany(store, ids, { force: !!o.force });
        if (o.json) printJson(results);
        else
          for (const r of results) {
            if (r.refused?.length) {
              for (const why of r.refused) console.log(yellow(`${r.id}: ${why}`));
              console.log(dim('Nothing was changed. --force undoes it anyway.'));
            } else console.log(green(`Undid ${r.id}: ${r.trashed.map((t) => `${t.kind} "${t.name}"`).concat(r.removed).join(', ') || 'nothing was left to remove'}`) + (r.trashed.length ? dim('  (Recently deleted: testpion trash list)') : ''));
          }
        if (results.some((r) => r.refused?.length)) process.exitCode = EXIT.CONFIG_ERROR;
      }),
    );
}

/** What an import did, in the lines a person reads. */
function printImported(r: WorkspaceImportResult, label?: string): void {
  for (const u of r.updated ?? []) console.log(green(`${label ? `${label}: ` : ''}Updated collection "${u.name}": ${u.applied.replaced} replaced, ${u.applied.added} added, ${u.applied.skipped} left as they are`));
  console.log(green(`${label ? `${label}: ` : ''}Imported ${r.format}: ${r.collection ? `collection "${r.collection.name}"` : ''}${r.collections && r.collections.length > 1 ? ` and ${r.collections.length - 1} more` : ''}${r.environments?.length ? ` ${r.environments.length > 1 ? 'environments' : 'environment'} ${r.environments.map((e) => `"${e.name}"`).join(', ')}` : ''}${r.flows?.length ? `${r.flows.length} flow${r.flows.length > 1 ? 's' : ''}` : ''}`));
  for (const f of r.flows ?? []) console.log(dim(`  ${f.path}  (workflow ${f.workflowId}, ${f.steps} steps; testpion flow ${f.path.replace(/^tests\//, '')} shows it)`));
  if (r.specPath) console.log(dim(`Kept the document as ${r.specPath}${r.contractChecks ? `; ${r.contractChecks} requests check the OpenAPI contract` : ''}`));
  if (r.scripts?.converted) console.log(dim(`Converted ${r.scripts.converted} script${r.scripts.converted === 1 ? '' : 's'} to tp.*${keepPmApplies(r.format) ? ' (--keep-pm keeps pm.*)' : ''}`));
  for (const u of r.scripts?.unchanged ?? []) console.log(yellow(`  Kept pm.* in ${u.where}: ${u.reason}`));
  if (r.scriptWarnings?.length) {
    console.log(yellow(`${r.scriptWarnings.length} script${r.scriptWarnings.length > 1 ? 's use' : ' uses'} something TestPion's sandbox doesn't have:`));
    for (const w of r.scriptWarnings) console.log(yellow(`  ${w.where} (${w.script} script): ${w.api}; ${w.hint}`));
  }
  // what did not map one to one (unsupported auth, template tags, values needed …); --json lists every note
  const notes = r.notes ?? [];
  if (notes.length) console.log(yellow(`Check after import (${notes.length} note${notes.length === 1 ? '' : 's'}):`));
  for (const n of notes.slice(0, 20)) console.log(yellow(`  ${n}`));
  if (notes.length > 20) console.log(yellow(`  … and ${notes.length - 20} more (--json lists them all)`));
  if (r.secretsToSet?.length) console.log(yellow(`Secret values were not saved (set them in the app, or as TESTPION_SECRET_* variables): ${r.secretsToSet.join(', ')}`));
}
