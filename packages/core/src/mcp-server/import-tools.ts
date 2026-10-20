import { ApsError } from '../errors.js';
import { fetchImportText } from '../import/fetch-url.js';
import { expandImportFiles, type ImportInput } from '../import/inputs.js';
import { listImportReceipts, readImportReport, undoImportReceipt } from '../import/import-receipt.js';
import { planInputs } from '../import/plan.js';
import { fetchPostmanInputs, parsePostmanRef } from '../import/postman-api.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools around `import_definition`: what an import would do before it is done (`import_preview`), the compatibility
 * report of an import that was done (`get_import_report`) and taking it back (`undo_definition_import`).
 */
export function importTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'import_preview',
      description:
        'Say what importing would do, without writing anything: for each input the collections (with their folder and request tree), environments, API definitions, flows and secret values it would create, the name clashes with the workspace, and the compatibility report (per item imported fully, with changes or not imported, and why: unsupported auth, Insomnia template tags, script APIs without an equivalent, values to enter). Inputs: `text`, a `url` (an OpenAPI/Swagger link, a GitHub file, `postman:collection/<id>` with `postman_api_key`), or `files` ([{ path, text }]: a folder\'s files, a Bruno or OpenCollection folder, many files at once). Then import_definition does it; get_import_report reads the report again.',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('Document text to preview'),
          url: str('http(s) link, or postman:collection/<id> | postman:environment/<id> | postman:workspace/<id>'),
          files: { type: 'array', items: { type: 'object', properties: { path: str('Path inside the folder'), text: str('The file text') }, required: ['path', 'text'] }, description: 'Several files, or the files of a collection folder (Bruno, OpenCollection)' },
          keep_pm: { type: 'boolean', description: 'Keep pm.* in Postman / Insomnia scripts instead of converting them to tp.*' },
          postman_api_key: str('A Postman API key for postman:… references (sent only to api.getpostman.com, never returned)'),
        },
      },
      run: async (a) => {
        const { inputs, skipped } = await inputsOf(a);
        return planInputs(store, inputs, skipped, { scripts: a.keep_pm === true ? 'keep' : 'tp' });
      },
    },
    {
      name: 'get_import_report',
      description: 'The compatibility report of an import done in this workspace (the id import_definition returned as `importId`): counts, per-item findings with the item path, field and original text, grouped by code. Without an id, lists the last imports (30 are kept).',
      inputSchema: { type: 'object', properties: { id: str('The import id (imp-…); omit to list') } },
      run: (a) => (typeof a.id === 'string' && a.id ? readImportReport(store, a.id) : { imports: listImportReceipts(store) }),
    },
    {
      name: 'undo_definition_import',
      write: true,
      description: 'Take back an import made by import_definition (the id it returned as `importId`): its collections, environments and API definitions go to Recently deleted (restore_item puts them back) and its flow files are removed. Refused, changing nothing, while an imported collection or flow was edited since, unless `force` is true. Bundle imports are taken back by undo_import.',
      inputSchema: { type: 'object', properties: { id: str('The import id (imp-…)'), force: { type: 'boolean', description: 'Undo even if the imported items were edited since' } }, required: ['id'] },
      run: (a) => undoImportReceipt(store, String(a.id), { force: a.force === true }),
    },
  ];
}

async function inputsOf(a: Record<string, unknown>): Promise<{ inputs: ImportInput[]; skipped: Array<{ path: string; why: string }> }> {
  if (Array.isArray(a.files) && a.files.length) {
    const files = a.files.map((f) => ({ path: String((f as { path?: unknown }).path ?? ''), data: String((f as { text?: unknown }).text ?? '') }));
    return expandImportFiles(files);
  }
  if (typeof a.url === 'string' && a.url) {
    const ref = parsePostmanRef(a.url);
    if (ref) return { inputs: await fetchPostmanInputs(ref, typeof a.postman_api_key === 'string' ? a.postman_api_key : process.env.POSTMAN_API_KEY), skipped: [] };
    const f = await fetchImportText(a.url);
    return { inputs: [{ name: f.fileName ?? a.url, text: f.text, source: f.url, fileCount: 1 }], skipped: [] };
  }
  if (typeof a.text === 'string' && a.text.trim()) return { inputs: [{ name: 'pasted', text: a.text, source: 'text', fileCount: 1 }], skipped: [] };
  throw new ApsError('ValidationError', 'Give text, a url or files to preview');
}
