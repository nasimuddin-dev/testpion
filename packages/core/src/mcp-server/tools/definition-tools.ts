import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import { fetchImportText } from '../../import/fetch-url.js';
import { importIntoWorkspace } from '../../import/workspace-import.js';
import { workspaceApiCoverage } from '../../openapi/coverage.js';
import { diffOpenApi } from '../../openapi/diff.js';
import { collectionToOpenApiText } from '../../openapi/from-collection.js';
import { collectionSecurityFindings } from '../../runner/collection-findings.js';
import { renameVariable, variableUsages } from '../../storage/variable-refactor.js';
import { importsMany, runImportMany } from './import-tools.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** API definitions and the variables of a collection: security review, OpenAPI, coverage, import, rename. */
export function definitionTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, findCollection, readSpec, checkEnvironment } = d;
  return [
    {
      name: 'security_review',
      description: "Security review of a collection's request definitions: secrets typed in instead of kept in secret variables, secrets in query strings, plain http to non-local hosts, credentials over http, turned-off TLS verification. Returns findings (high / medium / low) with where they are. Values are never returned.",
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), environment: str('Environment whose variables count as defined') }, required: ['collection'] },
      run: async (a) => {
        const c = findCollection(a.collection);
        const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment), collectionId: c.id });
        try {
          return collectionSecurityFindings(store, c, ctx, settings.redactFields);
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'collection_openapi',
      description: 'An OpenAPI 3.1 document (YAML) describing a collection\'s HTTP requests: paths, parameters, request bodies with inferred schemas, saved examples as responses, folders as tags, auth as security schemes. Useful to document an API that only exists as a collection, or to compare it with a spec (openapi_diff).',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => collectionToOpenApiText(findCollection(a.collection)),
    },
    {
      name: 'variable_usages',
      description: 'Where a variable is used or defined in the workspace: {{name}} in requests (URL, headers, bodies, auth …), tp.environment.get("name") & co. in scripts, environments, collection / folder / workspace variables and test files.',
      inputSchema: { type: 'object', properties: { name: str('Variable name, without {{ }}') }, required: ['name'] },
      run: (a) => variableUsages(store, String(a.name ?? '')),
    },
    {
      name: 'rename_variable',
      write: true,
      description: 'Rename a variable everywhere in the workspace (requests, scripts, environments, collection / folder / workspace variables, test files); refuses when the new name is already defined. Secret values move with it.',
      inputSchema: { type: 'object', properties: { from: str('Current name'), to: str('New name') }, required: ['from', 'to'] },
      run: async (a) => {
        const r = await renameVariable(store, String(a.from ?? ''), String(a.to ?? ''), { secrets });
        return { files: r.files, places: r.changed.length, changed: r.changed };
      },
    },
    {
      name: 'openapi_diff',
      description:
        'Compare two versions of an OpenAPI / Swagger document and list breaking changes (removed operations or success responses, new required parameters or body fields, type changes, removed or now-optional response fields, narrowed enums) and non-breaking ones. `old` and `new` are each an http(s) link, a path inside the workspace (e.g. specs/pets.openapi.json) or the document text.',
      inputSchema: { type: 'object', properties: { old: str('Previous version: link, workspace path or text'), new: str('New version: link, workspace path or text') }, required: ['old', 'new'] },
      run: async (a) => diffOpenApi(await readSpec(String(a.old ?? '')), await readSpec(String(a.new ?? ''))),
    },
    {
      name: 'api_coverage',
      description:
        "API coverage of an OpenAPI / Swagger document: which operations and documented response codes the workspace's test runs (default: the latest run) and optionally its request history exercised, which were never called, observed codes the document doesn't describe, and requests to paths it doesn't have. Use it to find untested endpoints and error cases, then write tests for them (save_test / save_request). `spec` is an http(s) link, a path inside the workspace (e.g. specs/pets.yaml) or the document text.",
      inputSchema: {
        type: 'object',
        properties: {
          spec: str('OpenAPI document: link, workspace path or text'),
          runs: { type: 'array', items: { type: 'string' }, description: 'Run ids to use (default: the latest run)' },
          history: { type: 'number', description: 'Also use the last n request history entries' },
          baseUrl: str('Only count requests under this URL'),
          excludeDeprecated: { type: 'boolean', description: 'Leave deprecated operations out of the totals' },
        },
        required: ['spec'],
      },
      run: async (a) => {
        const { report, sources } = await workspaceApiCoverage(store, await readSpec(String(a.spec ?? '')), {
          runs: Array.isArray(a.runs) && a.runs.length ? a.runs.map(String) : undefined,
          history: typeof a.history === 'number' && a.history > 0 ? Math.min(a.history, 10_000) : undefined,
          baseUrl: a.baseUrl ? String(a.baseUrl) : undefined,
          excludeDeprecated: a.excludeDeprecated === true,
        });
        return { ...report, sources };
      },
    },
    {
      name: 'import_definition',
      write: true,
      description:
        'Import an API definition or collection into the workspace from a public http(s) link (`url`: OpenAPI/Swagger URL, a GitHub/GitLab/Bitbucket file page, a Postman collection API link) or from `text` (OpenAPI, AsyncAPI, Postman collection or environment, Insomnia, Bruno, Hoppscotch, WSDL, HAR, .env, GraphQL SDL). OpenAPI imports keep the document in specs/ and add contract checks to each request. Postman / Insomnia scripts are converted to TestPion\'s tp.* (pm.* still runs; `keep_pm: true` leaves pm.*); `scripts` reports how many were converted and which were left. Returns what was created; secret values from a .env are never written to files (listed in `secretsToSet`); `notes` lists everything that did not map one to one (unsupported auth set to none with a placeholder header, Insomnia template tags, values needed …), naming the item; `report` is the same as a compatibility report and `importId` takes it back (undo_definition_import) or reads it again (get_import_report). import_preview shows all of it before anything is written.',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('http(s) link to download and import'),
          text: str('Document text to import (when no url)'),
          name: str('Name for an imported .env environment'),
          contractChecks: { type: 'boolean', description: 'For OpenAPI: add a contract check to each request (default true)' },
          keep_pm: { type: 'boolean', description: 'For Postman / Insomnia: keep pm.* in scripts instead of converting them to tp.* (default false)' },
          lift_tests: { type: 'boolean', description: 'Turn simple tests (status, response time, headers, JSON fields) into assertions' },
          update: { type: 'boolean', description: 'A source imported before updates the collection it made, item by item (default true); false adds a copy' },
          decisions: { type: 'object', additionalProperties: { type: 'string', enum: ['replace', 'new', 'skip'] }, description: 'For an update: the item keys import_preview prints → replace | new | skip' },
          files: { type: 'array', items: { type: 'object', properties: { path: str('Path inside the folder'), text: str('The file text') } }, description: 'Several files or a collection folder\'s files (like import_preview)' },
        },
      },
      run: async (a) => {
        if (importsMany(a)) return runImportMany(store, a);
        const f = typeof a.url === 'string' && a.url ? await fetchImportText(a.url) : undefined;
        const text = f?.text ?? (typeof a.text === 'string' ? a.text : '');
        if (!text.trim()) throw new ApsError('ValidationError', 'Give a url or text to import');
        const r = importIntoWorkspace(store, text, { contractChecks: a.contractChecks !== false, name: typeof a.name === 'string' ? a.name : undefined, scripts: a.keep_pm === true ? 'keep' : 'tp', liftTests: a.lift_tests === true, update: a.update === false ? false : a.decisions && typeof a.decisions === 'object' ? { decisions: a.decisions as Record<string, 'replace' | 'new' | 'skip'> } : true });
        return {
          format: r.format,
          source: f?.url,
          collection: r.collection ? { name: r.collection.name, id: r.collection.id } : undefined,
          environments: r.environments?.map((e) => e.name),
          specPath: r.specPath,
          contractChecks: r.contractChecks,
          secretsToSet: r.secretsToSet?.length ? r.secretsToSet : undefined,
          scriptWarnings: r.scriptWarnings,
          scripts: r.scripts,
          // everything that did not map one to one (unsupported auth, template tags, values needed …), naming the item
          notes: r.notes?.length ? r.notes : undefined,
          // the compatibility report (per item: fully / with changes / not imported, and why) and the id to read or undo it
          report: r.report,
          importId: r.receipt?.id,
          updated: r.updated,
        };
      },
    },
  ];
}
