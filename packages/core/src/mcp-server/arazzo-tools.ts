import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApsError } from '../errors.js';
import { importArazzo, resolveArazzoSources } from '../import/arazzo.js';
import { exportArazzoFromWorkspace } from '../import/arazzo-export.js';
import { fetchImportText } from '../import/fetch-url.js';
import { importArazzoIntoWorkspace } from '../import/workspace-import.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools for Arazzo 1.0 (the OpenAPI Initiative's workflow format): import a document's workflows as flow files
 * under tests/arazzo/, and export a flow file as an Arazzo document.
 */
export function arazzoTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'import_arazzo',
      write: true,
      description:
        "Import an Arazzo 1.0 document (workflows over OpenAPI operations) as TestPion flow files: one file per workflow under tests/arazzo/, steps in order (each depends on the one before), operationId / operationPath → method and URL ({{baseUrl}} + path), parameters → params / headers / path, requestBody → body, $inputs.x → {{x}}, $steps.s.outputs.o → {{s_o}} with an extract on step s, successCriteria → checks, onFailure retry → retries, workflow inputs → the file's expose inputs. The OpenAPI sources are looked up in the workspace (specs/, by path or file name); `fetch_sources: true` downloads http(s) ones. What a flow file cannot say (goto, xpath criteria …) is kept as a comment on the step and listed in `notes`. `dry_run: true` returns the files' text without writing them. Run a result with run_tests; export_arazzo goes the other way.",
      inputSchema: {
        type: 'object',
        properties: {
          text: str('The Arazzo document (YAML or JSON)'),
          file: str('Or a workspace file holding it, e.g. specs/adopt-pet.arazzo.yaml'),
          url: str('Or an http(s) link to download it from'),
          fetch_sources: { type: 'boolean', description: 'Download OpenAPI source descriptions given as http(s) URLs (default false: only workspace files)' },
          dry_run: { type: 'boolean', description: 'Return the flow files without writing them' },
        },
      },
      run: async (a) => {
        let text = typeof a.text === 'string' ? a.text : '';
        let baseDir: string | undefined;
        if (!text.trim() && typeof a.file === 'string' && a.file) {
          const p = store.safePath(a.file);
          if (!existsSync(p)) throw new ApsError('ValidationError', `No file ${a.file} in the workspace`);
          text = readFileSync(p, 'utf8');
          baseDir = dirname(p);
        }
        if (!text.trim() && typeof a.url === 'string' && a.url) text = (await fetchImportText(a.url)).text;
        if (!text.trim()) throw new ApsError('ValidationError', 'Give the Arazzo document as text, file or url');
        const resolved = await resolveArazzoSources(text, { workspace: store.root, baseDir, fetch: a.fetch_sources === true ? async (u) => (await fetchImportText(u)).text : undefined });
        if (a.dry_run === true) {
          const r = importArazzo(text, { sources: resolved.sources });
          return { written: false, flows: r.flows, notes: r.notes, baseUrls: r.baseUrls, unresolvedSources: r.unresolvedSources, fetched: resolved.fetched };
        }
        const r = importArazzoIntoWorkspace(store, text, { baseDir, sources: resolved.sources });
        return { written: true, flows: r.flows, notes: r.notes ?? [], fetched: resolved.fetched, missingSources: resolved.missing };
      },
    },
    {
      name: 'export_arazzo',
      description:
        'A flow file (tests/…) as an Arazzo 1.0 document: HTTP steps become operations of an OpenAPI document (operationId, else operationPath; a request no document describes keeps x-testpion-request), extracts → outputs, {{variables}} → $steps.x.outputs.y / $inputs.z, status / body / header checks → successCriteria, retries → a retry action, dependsOn → step order. The OpenAPI source is `spec`, else the sources an Arazzo import noted in the file, else the workspace spec that matches the most requests. Returns { text (YAML), document, notes, sources }; nothing is written (testpion flow export -o writes a file).',
      inputSchema: {
        type: 'object',
        properties: {
          file: str('The flow file, e.g. arazzo/adopt-pet.yaml (relative to tests/) or tests/checkout.yaml'),
          spec: str('The OpenAPI document to match, e.g. specs/petstore.json'),
          workflow_id: str('The workflowId (default: the one noted by an import, else the file name)'),
        },
        required: ['file'],
      },
      run: (a) => {
        const r = exportArazzoFromWorkspace(store, String(a.file), {
          spec: typeof a.spec === 'string' && a.spec ? a.spec : undefined,
          workflowId: typeof a.workflow_id === 'string' && a.workflow_id ? a.workflow_id : undefined,
        });
        return { file: r.file, text: r.text, document: r.document, notes: r.notes, sources: r.sources };
      },
    },
  ];
}
