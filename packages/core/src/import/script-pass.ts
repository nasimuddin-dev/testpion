import type { CollectionNode, HttpSettings } from '../model/types.js';
import { convertScript, type ScriptTool } from '../scripts/convert/index.js';
import type { ImportScriptsMode, ImportScriptsSummary } from './import-scripts.js';
import type { ImportDocument, ImportFinding } from './model.js';

type Holder = { name?: string; preRequestScript?: string; testScript?: string; items?: CollectionNode[]; kind?: string; settings?: HttpSettings; request?: { settings?: HttpSettings } };

const INSOMNIA_HEADER = (alias: string) => `// Insomnia script: insomnia.* runs as ${alias}.* (the same API)\n`;

/**
 * The scripts of a parsed document, in TestPion's script API: Postman's `pm.*` (and the legacy `postman.*` /
 * `tests[]` of old collections), Insomnia's `insomnia.*`, Bruno's `bru.*` become `tp.*` (scripts/convert, by syntax
 * tree). `'keep'` leaves Postman's `pm.*` and puts Insomnia's on `pm.*` (it runs either way: `pm` is an alias of `tp`).
 * One summary (scripts converted / kept and why / calls with no equivalent) and a finding for each line needing a look.
 */
export function convertDocumentScripts(doc: ImportDocument, mode: ImportScriptsMode = 'tp'): void {
  const tool: ScriptTool | undefined = doc.scriptTool;
  if (!tool) return;
  let converted = 0;
  const unchanged: ImportScriptsSummary['unchanged'] = [];
  const warnings: NonNullable<ImportScriptsSummary['warnings']> = [];
  const add = (f: ImportFinding) => doc.findings.push(f);

  const processEnv = new Set<string>();
  const fix = (code: string | undefined, path: string[], rootName: string, phase: 'pre-request' | 'post-response', holder?: Holder): string | undefined => {
    if (!code?.trim()) return code;
    // Postman's scripts stay on pm.* with --keep-pm; Insomnia's become pm.* then; Bruno's always become tp.*
    if (tool === 'postman' && mode === 'keep') return code;
    const alias = tool === 'insomnia' && mode === 'keep' ? 'pm' : 'tp';
    const r = convertScript(code, tool, { alias });
    // constants the script set on the request (req.setTimeout) are the request's settings now
    if (r.lifts && holder) {
      if (holder.kind === 'http' && holder.request) holder.request.settings = { ...holder.request.settings, ...r.lifts };
      else if (holder.kind === 'folder' || holder.kind === undefined) holder.settings = { ...holder.settings, ...r.lifts };
    }
    for (const name of r.processEnv ?? []) processEnv.add(name);
    const where = [rootName, ...path].join(' / ') + ` (${phase})`;
    const item = path.at(-1) ?? rootName;
    if (r.status === 'converted' && !(mode === 'keep' && tool === 'insomnia')) converted++;
    if (r.status === 'kept') {
      unchanged.push({ where, reason: r.reason ?? 'kept as it is' });
      if (r.findings.some((f) => f.code === 'SCRIPT_PARSE_ERROR')) add({ code: 'SCRIPT_PARSE_ERROR', severity: 'changed', where: path, field: `script:${phase}`, message: `${where}: ${r.reason}; it is kept as written (the sandbox runs it as it is)` });
    }
    for (const f of r.findings) {
      if (f.code === 'SCRIPT_API') {
        warnings.push({ where, api: f.api });
        // (Insomnia's notes name the item, the others the whole path)
        add({ code: 'SCRIPT_API', severity: 'changed', where: path, field: `script:${phase}`, message: tool === 'insomnia' ? `"${item}": ${f.message}` : `${where}: ${f.message}`, original: f.api, suggestion: `Rewrite the marked line with TestPion's script API (the coverage table in Import fidelity lists what maps)` });
      } else if (f.code === 'SCRIPT_LIFT') add({ code: 'SCRIPT_LIFT', severity: 'info', where: path, field: `script:${phase}`, message: `"${item}": ${f.message}` });
      else if (f.code === 'SCRIPT_BASE_ENVIRONMENT') add({ code: 'SCRIPT_BASE_ENVIRONMENT', severity: 'changed', where: path, field: `script:${phase}`, message: `"${item}": ${f.message}` });
    }
    // the Insomnia marker line (an imported script says where it came from)
    if (tool === 'insomnia' && r.status === 'converted' && !r.code.startsWith('// Insomnia script')) return INSOMNIA_HEADER(alias) + r.code;
    return r.code;
  };

  const walk = <T extends Holder>(n: T, path: string[], rootName: string): T => {
    const out: T = { ...n, ...(n.request ? { request: { ...n.request } } : {}) };
    if (n.preRequestScript !== undefined) out.preRequestScript = fix(n.preRequestScript, path, rootName, 'pre-request', out);
    if (n.testScript !== undefined) out.testScript = fix(n.testScript, path, rootName, 'post-response', out);
    if (n.items) out.items = n.items.map((c) => walk(c as Holder, [...path, c.name ?? '?'], rootName)) as CollectionNode[];
    return out;
  };
  doc.collections = doc.collections.map((c) => walk(c as unknown as Holder, [], c.name) as unknown as typeof c);
  // Bruno's bru.getProcessEnv('NAME'): the name must exist as a variable (the collection's .env file is imported as one)
  if (processEnv.size) {
    const defined = new Set<string>([...doc.environments.flatMap((e) => e.variables.map((v) => v.key)), ...doc.collections.flatMap((c) => c.variables.map((v) => v.key))]);
    const missingNames = [...processEnv].filter((n) => !defined.has(n));
    if (missingNames.length) add({ code: 'VALUE_NEEDED', severity: 'changed', where: [], message: `Values needed: ${missingNames.join(', ')} (read by bru.getProcessEnv in the scripts; Bruno takes them from the collection's .env file, which was not imported): create ${missingNames.length > 1 ? 'variables' : 'a variable'} with ${missingNames.length > 1 ? 'these names' : 'this name'} in an environment` });
  }
  doc.scripts = { converted, unchanged, ...(warnings.length ? { warnings } : {}) };
}
