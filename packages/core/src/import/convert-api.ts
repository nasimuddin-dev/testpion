import type { Collection } from '../model/types.js';
import { ApsError } from '../errors.js';
import { convertScript, type ScriptResult, type ScriptTool } from '../scripts/convert/index.js';
import { convertDocumentScripts } from './script-pass.js';
import { liftDocumentTests } from './lift-pass.js';
import { newDocument, type ImportFinding } from './model.js';

/**
 * Script conversion as a call (CLI `scripts convert --from`, MCP `convert_scripts`): another tool's script API to TestPion's
 * `tp.*`, for a piece of code or for the scripts of a collection that is already in the workspace (an import with `--keep-pm`,
 * a collection pasted from a colleague). The same converter the import uses; nothing is executed.
 */

export const SCRIPT_TOOLS: readonly ScriptTool[] = ['postman', 'insomnia', 'bruno', 'thunder', 'hoppscotch'];

export function requireScriptTool(tool: unknown): ScriptTool {
  if (typeof tool === 'string' && (SCRIPT_TOOLS as readonly string[]).includes(tool.toLowerCase())) return tool.toLowerCase() as ScriptTool;
  throw new ApsError('ValidationError', `Unknown script API "${String(tool)}"`, { suggestions: [`Use one of: ${SCRIPT_TOOLS.join(', ')}`] });
}

/** One script. */
export function convertScriptText(code: string, tool: ScriptTool): ScriptResult {
  return convertScript(code, tool);
}

export interface CollectionScriptsResult {
  collection: Collection;
  /** Scripts rewritten. */
  converted: number;
  /** Scripts left as written, with the reason. */
  kept: Array<{ where: string; reason: string }>;
  /** Everything that needs a hand (calls with no equivalent, scripts that do not parse), naming the item. */
  findings: ImportFinding[];
  /** Simple tests lifted into assertions (when asked). */
  lifted: number;
}

/** The scripts of a collection, from `tool`'s API to `tp.*` (and, with `liftTests`, simple tests to assertions). */
export function convertCollectionScriptsFrom(collection: Collection, tool: ScriptTool, opts: { liftTests?: boolean } = {}): CollectionScriptsResult {
  const doc = newDocument('collection', '', { collections: [JSON.parse(JSON.stringify(collection)) as Collection], scriptTool: tool });
  convertDocumentScripts(doc, 'tp');
  const lifted = opts.liftTests ? liftDocumentTests(doc, true) : 0;
  return { collection: doc.collections[0]!, converted: doc.scripts?.converted ?? 0, kept: doc.scripts?.unchanged ?? [], findings: doc.findings, lifted };
}
