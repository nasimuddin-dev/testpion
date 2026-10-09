/** `testpion flow export <file> --arazzo`: a flow file as an Arazzo 1.0 workflow document. */
import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { ApsError, exportArazzoFromWorkspace } from '@testpion/core';
import { dim, green, printJson, withWorkspace, yellow } from '../shared.js';

export function registerFlowExportCommand(program: Command): void {
  const flow = program.commands.find((c) => c.name() === 'flow');
  if (!flow) return;
  flow
    .command('export')
    .description(
      "write a flow file as an Arazzo 1.0 workflow (the OpenAPI Initiative's format): HTTP steps become operations of an OpenAPI document (operationId, else operationPath), extracts become outputs, {{variables}} runtime expressions, status and body checks successCriteria; what Arazzo cannot say stays under x-testpion-* keys",
    )
    .argument('<file>', 'a test file (inside tests/, e.g. arazzo/adopt-pet.yaml)')
    .option('--arazzo', 'the format (Arazzo is the only one, and the default)')
    .option(
      '--spec <file>',
      'the OpenAPI document to match requests against (a workspace file, e.g. specs/petstore.json); default: the sources an Arazzo import noted in the file, else the workspace spec that describes the most requests',
    )
    .option('--workflow-id <id>', 'the workflowId (default: the one an import noted, else the file name)')
    .option('-o, --out <file>', 'write the document here (default: print it)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print { file, document, notes, sources } as JSON (for scripts and AI agents)')
    .action(async (file: string, o: { spec?: string; workflowId?: string; out?: string; workspace?: string; json?: boolean }) => {
      const parent = flow.opts() as { workspace?: string; json?: boolean };
      o.json ||= parent.json;
      return withWorkspace(o.workspace ?? parent.workspace, (store) => {
        const r = exportArazzoFromWorkspace(store, file, { spec: o.spec, workflowId: o.workflowId });
        if (o.out) {
          if (!/\.(ya?ml|json)$/i.test(o.out)) throw new ApsError('ValidationError', '--out is a .yaml, .yml or .json file (e.g. checkout.arazzo.yaml)');
          writeFileSync(o.out, /\.json$/i.test(o.out) ? JSON.stringify(r.document, null, 2) + '\n' : r.text);
        }
        if (o.json) return printJson({ file: r.file, out: o.out, document: r.document, notes: r.notes, sources: r.sources });
        if (!o.out) process.stdout.write(r.text);
        else console.log(`${green('wrote')} ${o.out}  ${dim(`(${r.document.workflows[0].steps.length} steps from tests/${r.file.replace(/^tests\//, '')})`)}`);
        for (const n of r.notes) console.error(yellow(`  ${n}`));
      });
    });
}
