import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { generateWorkspaceDataset, WorkspaceManager } from '@testpion/core';
import { EXIT, green, dim, CliError, openWorkspace } from '../shared.js';

/** `testpion generate-data <name>`: realistic rows from a JSON schema or an operation's request body, into datasets/. */
export function registerGenerateCommands(program: Command): void {
  program
    .command('generate-data')
    .description(
      "generate test data into the workspace's datasets/ folder: rows from a JSON schema (--schema) or an API definition operation's request body (--spec and --operation), each field filled by its format, enum, range and name (emails, names, cities, prices, dates, UUIDs …)",
    )
    .argument('<name>', 'the dataset name (datasets/<name>.csv)')
    .option('-n, --rows <n>', 'how many rows', '20')
    .option('--schema <file>', 'a JSON schema (JSON or YAML file) for one row')
    .option('--spec <file>', 'an API definition in the workspace, e.g. specs/clinic.yaml')
    .option('--operation <op>', 'with --spec: "POST /patients" or an operationId')
    .option('--format <format>', 'csv or json', 'csv')
    .option('--overwrite', 'replace a dataset of the same name')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((name: string, o: { rows: string; schema?: string; spec?: string; operation?: string; format: string; overwrite?: boolean; workspace?: string; json?: boolean }) => {
      if (o.format !== 'csv' && o.format !== 'json') throw new CliError('--format must be csv or json', EXIT.CONFIG_ERROR);
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const out = generateWorkspaceDataset(store, {
          name,
          rows: Number(o.rows) || 20,
          format: o.format,
          schema: o.schema ? readFileSync(o.schema, 'utf8') : undefined,
          spec: o.spec?.replace(/\\/g, '/'),
          operation: o.operation,
          overwrite: o.overwrite,
        });
        if (o.json) console.log(JSON.stringify(out, null, 2));
        else {
          console.log(green(`${out.path}: ${out.rows} rows`));
          console.log(dim(`  columns: ${out.columns.join(', ')}`));
          console.log(dim(`  run with it: testpion run-collection "<collection>" -d ${out.path}`));
        }
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      } finally {
        store.close();
      }
    });
}
