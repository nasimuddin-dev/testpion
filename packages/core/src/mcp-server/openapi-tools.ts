import { readdirSync } from 'node:fs';
import { lintOpenApi, OPENAPI_LINT_RULES, type OpenApiLintSeverity } from '../openapi/lint.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/** MCP tools for API definitions (OpenAPI / Swagger) beyond the diff and coverage: the linter. */
export function openApiTools(d: { store: WorkspaceStore; readSpecRef(ref: string): Promise<string> }): Tool[] {
  return [
    {
      name: 'openapi_lint',
      description:
        "Lint an OpenAPI 3 / Swagger 2 document: errors that break tools and clients ($refs to nothing, path parameters not declared or not required, duplicate parameters or operationIds, undefined security schemes, operations without responses, paths that differ only in parameter names) and warnings / notes that make an API hard to use (examples that don't match their schema, no operationId, no success response, a success response without a schema, a body on GET, plain http servers, missing tags or summaries, unused components). Each problem has its rule, line and column. `spec` is an http(s) link, a path inside the workspace (e.g. specs/pets.yaml) or the document text; left out, every document in the workspace's specs/ folder is linted.",
      inputSchema: {
        type: 'object',
        properties: {
          spec: str('OpenAPI document: link, workspace path or text (default: every document in specs/)'),
          disable: { type: 'array', items: { type: 'string', enum: OPENAPI_LINT_RULES.map((r) => r.id) }, description: 'Rules to leave out' },
          severity: { type: 'string', enum: ['error', 'warning', 'info'], description: 'Only this level and worse (default info: everything)' },
        },
      },
      run: async (a) => {
        const opts = {
          disable: Array.isArray(a.disable) ? a.disable.map(String) : undefined,
          minSeverity: (['error', 'warning', 'info'].includes(String(a.severity)) ? a.severity : 'info') as OpenApiLintSeverity,
        };
        if (a.spec) return lintOpenApi(await d.readSpecRef(String(a.spec)), opts);
        let files: string[] = [];
        try {
          files = readdirSync(d.store.safePath('specs')).filter((f) => /\.(ya?ml|json)$/i.test(f));
        } catch {
          /* no specs/ folder */
        }
        if (!files.length) return { documents: [], note: 'No API definitions in specs/: pass spec (a link, a workspace path or the text), or import_definition first.' };
        return { documents: await Promise.all(files.map(async (f) => ({ file: `specs/${f}`, ...lintOpenApi(await d.readSpecRef(`specs/${f}`), opts) }))), rules: OPENAPI_LINT_RULES };
      },
    },
  ];
}
