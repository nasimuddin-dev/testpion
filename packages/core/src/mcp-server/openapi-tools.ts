import { readdirSync } from 'node:fs';
import { lintOpenApi, OPENAPI_LINT_RULES, type OpenApiLintSeverity } from '../openapi/lint.js';
import { openApiOutline } from '../openapi/outline.js';
import { fuzzCases, runFuzz } from '../openapi/fuzz.js';
import type { EngineContext } from '../engine.js';
import type { HttpRequestSpec } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/** MCP tools for API definitions (OpenAPI / Swagger) beyond the diff and coverage: the linter. */
export function openApiTools(d: { store: WorkspaceStore; readSpecRef(ref: string): Promise<string>; context?(environment?: string): EngineContext }): Tool[] {
  return [
    {
      name: 'api_fuzz',
      write: true,
      description:
        "Fuzz an API from its OpenAPI document: for each operation, its valid example and then requests that break one rule of the schema at a time (a required field left out, a wrong type, a value outside its enum, range, length or format, a body that is not JSON, a path or query parameter of the wrong type). Reports server errors (5xx: bugs), invalid input the API accepted (validation gaps), statuses the document doesn't list, and operations that weren't authorized. It sends real requests that may create or change data, so only local or private-network hosts are allowed and DELETE is left out unless includeDelete. {{variables}} (tokens, {{baseUrl}}) resolve from `environment`; production environments are refused.",
      inputSchema: {
        type: 'object',
        properties: {
          spec: str('OpenAPI document: link, workspace path or text'),
          baseUrl: str("The API's address (default: the environment's baseUrl, else the document's first server)"),
          environment: str('Environment for {{variables}} such as the access token'),
          operations: { type: 'array', items: { type: 'string' }, description: 'Only these operations: "POST /patients" or operationIds' },
          includeDelete: { type: 'boolean', description: 'Also fuzz DELETE operations' },
          maxPerOperation: { type: 'number', description: 'At most this many requests per operation (default 25)' },
        },
        required: ['spec'],
      },
      run: async (a) => {
        const text = await d.readSpecRef(String(a.spec ?? ''));
        const environment = a.environment ? String(a.environment) : undefined;
        if (environment && d.store.getEnvironment(environment)?.isProduction) throw new ApsError('ConfigurationError', `${environment} is a production environment: fuzzing is not run there`);
        const ctx = d.context?.(environment);
        try {
          const resolve = ctx ? (r: HttpRequestSpec) => ctx.vars.resolveDeep(r) : undefined;
          const envBase = ctx ? ctx.vars.resolve('{{baseUrl}}') : undefined;
          const baseUrl = a.baseUrl ? String(a.baseUrl) : envBase && !envBase.includes('{{') ? envBase : undefined;
          const { cases } = fuzzCases(text, {
            baseUrl,
            operations: Array.isArray(a.operations) ? a.operations.map(String) : undefined,
            includeDelete: a.includeDelete === true,
            maxPerOperation: Math.min(Number(a.maxPerOperation) || 25, 50),
          });
          const report = await runFuzz(text, cases, { resolve, concurrency: 4 });
          // the findings first; the requests that went as expected only counted
          return {
            ...report,
            results: report.results
              .filter((r) => r.verdict !== 'ok' && r.verdict !== 'not-judged')
              .map((r) => ({
                operation: r.case.operation,
                case: r.case.name,
                verdict: r.verdict,
                status: r.status,
                message: r.message,
                bodyPreview: ctx ? ctx.redactor.redactString(r.bodyPreview ?? '') : r.bodyPreview,
              })),
          };
        } finally {
          await ctx?.dispose();
        }
      },
    },
    {
      name: 'openapi_outline',
      description:
        'Read an OpenAPI 3 / Swagger 2 document the way a person reads its docs: operations grouped by tag with method, path, operationId, summary, parameters (name, in, required, type), the request body and each response with its schema as a short type outline, the security schemes, and the request an import would make (method, url with {{path params}}, query, headers, sample body). Narrow it with `tag` or `operationId`. `spec` is an http(s) link, a path inside the workspace (e.g. specs/pets.yaml) or the document text. Use it to understand an API before writing requests or tests.',
      inputSchema: {
        type: 'object',
        properties: { spec: str('OpenAPI document: link, workspace path or text'), tag: str('Only this tag'), operationId: str('Only this operation') },
        required: ['spec'],
      },
      run: async (a) => {
        const o = openApiOutline(await d.readSpecRef(String(a.spec ?? '')));
        const tags = o.tags
          .filter((t) => !a.tag || t.name.toLowerCase() === String(a.tag).toLowerCase())
          .map((t) => ({ ...t, operations: t.operations.filter((op) => !a.operationId || op.operationId === String(a.operationId)) }))
          .filter((t) => t.operations.length);
        return { ...o, tags };
      },
    },
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
