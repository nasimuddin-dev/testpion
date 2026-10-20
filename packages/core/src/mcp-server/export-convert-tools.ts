import { ApsError } from '../errors.js';
import { collectionToBru } from '../import/bru-export.js';
import { convertCollectionScriptsFrom, convertScriptText, requireScriptTool, SCRIPT_TOOLS } from '../import/convert-api.js';
import { collectionToHttpFile } from '../import/http-file.js';
import { collectionToInsomniaV4, collectionToInsomniaV5 } from '../import/insomnia-export.js';
import { collectionToOpenCollection, collectionToOpenCollectionBundle } from '../import/opencollection-export.js';
import { exportPostmanCollection } from '../import/postman-export.js';
import { collectionToOpenApiText } from '../openapi/from-collection.js';
import { liftTests } from '../scripts/convert/lift-tests.js';
import type { Collection } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

export const EXPORT_FORMATS = ['postman', 'insomnia', 'insomnia-v4', 'opencollection', 'opencollection-file', 'bruno', 'http', 'openapi'] as const;

/**
 * MCP tools for the way out and for scripts: `export_collection` (a collection as a file other tools import: Postman,
 * Insomnia, OpenCollection / Bruno, .http, OpenAPI), `convert_script_code` (a script from another tool's API to `tp.*`, read-only),
 * `convert_scripts` (the scripts of a collection of the workspace, saved unless `dry_run`) and `lift_tests` (simple tests of a script
 * as assertions, read-only). The same engines as `testpion export` and `testpion scripts convert`.
 */
export function exportConvertTools({ store }: { store: WorkspaceStore }): Tool[] {
  const collectionOf = (ref: unknown): Collection => {
    const r = String(ref ?? '');
    const c = store.listCollections().find((x) => !x.problem && (x.id === r || x.name === r));
    if (!c) throw new ApsError('ConfigurationError', `No collection "${r}". Available: ${store.listCollections().filter((x) => !x.problem).map((x) => x.name).join(', ') || 'none'}`);
    return c;
  };
  return [
    {
      name: 'export_collection',
      description:
        'A collection of the workspace as a file other tools import, returned as text (nothing is written): `postman` (collection v2.1 JSON), `insomnia` (v5 YAML), `insomnia-v4` (JSON), `opencollection-file` (Bruno\'s YAML, one file), `opencollection` / `bruno` (the files of a folder: [{ path, text }]), `http` (.http file), `openapi` (OpenAPI 3.1 YAML). The workspace\'s environments go with Insomnia and OpenCollection (secret values never). `notes` lists what the format cannot hold (examples, JWT auth, assertions it could not write as tests …): nothing is dropped silently. Scripts are written in the target tool\'s API.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), format: { type: 'string', enum: [...EXPORT_FORMATS], description: 'The target format' } }, required: ['collection', 'format'] },
      run: (a) => {
        const c = collectionOf(a.collection);
        const envs = store.listEnvironments().filter((e) => !e.problem);
        switch (String(a.format)) {
          case 'postman': {
            const r = exportPostmanCollection(c);
            return { format: 'postman', text: JSON.stringify(r.collection, null, 2) + '\n', notes: r.notes };
          }
          case 'insomnia':
            return { format: 'insomnia', ...collectionToInsomniaV5(c, envs) };
          case 'insomnia-v4':
            return { format: 'insomnia-v4', ...collectionToInsomniaV4(c, envs) };
          case 'opencollection-file':
            return { format: 'opencollection-file', ...collectionToOpenCollectionBundle(c, envs) };
          case 'opencollection': {
            const r = collectionToOpenCollection(c, envs);
            return { format: 'opencollection', files: r.files, notes: r.notes };
          }
          case 'bruno':
            return { format: 'bruno', files: collectionToBru(c, envs), notes: [] };
          case 'http':
            return { format: 'http', ...collectionToHttpFile(c) };
          case 'openapi':
            return { format: 'openapi', text: collectionToOpenApiText(c), notes: [] };
          default:
            throw new ApsError('ValidationError', `Unknown format "${String(a.format)}"`, { suggestions: [`Use one of: ${EXPORT_FORMATS.join(', ')}`] });
        }
      },
    },
    {
      name: 'convert_script_code',
      description: `Convert one script from another tool's API to TestPion's tp.* and return it with the findings (calls with no equivalent are marked // TODO(import); a script that does not parse is returned as written with the line). \`from\`: ${SCRIPT_TOOLS.join(', ')}. Nothing is run or saved. Use convert_scripts for the scripts of a collection.`,
      inputSchema: { type: 'object', properties: { code: str('The script'), from: { type: 'string', enum: [...SCRIPT_TOOLS], description: 'The script API it is written for' } }, required: ['code', 'from'] },
      run: (a) => {
        const r = convertScriptText(String(a.code ?? ''), requireScriptTool(a.from));
        return { status: r.status, changes: r.changes, code: r.code, findings: r.findings, ...(r.reason ? { reason: r.reason } : {}) };
      },
    },
    {
      name: 'convert_scripts',
      write: true,
      description: `Convert the scripts of a collection of the workspace from another tool's script API (${SCRIPT_TOOLS.join(', ')}) to tp.* (an import with keep_pm, a collection pasted from a colleague), optionally lifting simple tests into assertions. Saves the collection unless \`dry_run\`. Returns what was converted, what was kept and why, and the findings by item.`,
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), from: { type: 'string', enum: [...SCRIPT_TOOLS] }, lift_tests: { type: 'boolean', description: 'Turn simple tests (status, response time, headers, JSON fields) into assertions' }, dry_run: { type: 'boolean', description: 'Only report' } }, required: ['collection', 'from'] },
      run: (a) => {
        const c = collectionOf(a.collection);
        const r = convertCollectionScriptsFrom(c, requireScriptTool(a.from), { liftTests: a.lift_tests === true });
        if (a.dry_run !== true && (r.converted || r.lifted)) store.saveCollection(r.collection);
        return { collection: c.name, saved: a.dry_run !== true && !!(r.converted || r.lifted), converted: r.converted, lifted: r.lifted, kept: r.kept, findings: r.findings.filter((f) => f.severity !== 'info') };
      },
    },
    {
      name: 'lift_tests',
      description: 'Find the simple tests of a tp.* (or pm.*) script (a status, a response time, a header, a JSON field, a body text) and return them as TestPion assertions plus the script without them. Nothing is saved; add the assertions to a request with edit tools, or use convert_scripts with lift_tests.',
      inputSchema: { type: 'object', properties: { code: str('The test script') }, required: ['code'] },
      run: (a) => {
        const r = liftTests(String(a.code ?? ''));
        return { lifted: r.lifted, assertions: r.assertions, remaining: r.code };
      },
    },
  ];
}
