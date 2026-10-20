import type { Collection, CollectionNode } from '../model/types.js';

/** Modules scripts can require (see prelude.ts). */
export const SCRIPT_MODULES = ['ajv', 'atob', 'btoa', 'chai', 'cheerio', 'crypto-js', 'csv-parse/lib/sync', 'csv-parse/sync', 'lodash', 'moment', 'tv4', 'uuid', 'xml2js'];

const UNSUPPORTED: Array<{ re: RegExp; api: string; hint: string }> = [
  // Postman's newer sandbox members with no equivalent: they would throw when the script runs
  { re: /\b(?:pm|tp)\.datasets\b/, api: 'pm.datasets', hint: 'TestPion datasets feed the runner (data file, tp.iterationData); there is no SQL over them in a script' },
  { re: /\b(?:pm|tp)\.mock\b/, api: 'pm.mock', hint: "use TestPion's mock server (Collection > Mock), which serves the saved examples" },
];

export interface ScriptWarning {
  /** Request or folder path, or "(collection)". */
  where: string;
  /** "pre-request" or "test". */
  script: 'pre-request' | 'test';
  api: string;
  hint: string;
}

function check(code: string | undefined, where: string, script: ScriptWarning['script'], out: ScriptWarning[], hasPackage: (name: string) => boolean): void {
  if (!code?.trim()) return;
  for (const u of UNSUPPORTED) if (u.api && u.re.test(code)) out.push({ where, script, api: u.api, hint: u.hint });
  // Postman's package library: works once the package is in the workspace (packages/<name>.js)
  for (const m of code.matchAll(/\bpm\.require\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    if (!hasPackage(m[1]!)) out.push({ where, script, api: `pm.require('${m[1]}')`, hint: `add the package to the workspace as packages/${m[1]}.js (Script packages)` });
  for (const m of code.matchAll(/(?<![\w.$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const name = m[1]!;
    if (!SCRIPT_MODULES.includes(name)) out.push({ where, script, api: `require('${name}')`, hint: `available modules: ${SCRIPT_MODULES.join(', ')}` });
  }
}

/**
 * Script APIs in a collection that TestPion's sandbox doesn't provide, so an import can say which
 * requests need a change before they are run. Everything else in Postman's `pm.*` API is supported.
 */
export function scriptCompatibility(collection: Collection, hasPackage: (name: string) => boolean = () => false): ScriptWarning[] {
  const out: ScriptWarning[] = [];
  check(collection.preRequestScript, '(collection)', 'pre-request', out, hasPackage);
  check(collection.testScript, '(collection)', 'test', out, hasPackage);
  const walk = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes) {
      const where = [...path, n.name].join(' / ');
      if ('preRequestScript' in n) check(n.preRequestScript, where, 'pre-request', out, hasPackage);
      if ('testScript' in n) check(n.testScript, where, 'test', out, hasPackage);
      if (n.kind === 'folder') walk(n.items, [...path, n.name]);
    }
  };
  walk(collection.items, []);
  // one line per request and API
  const seen = new Set<string>();
  return out.filter((w) => {
    const k = `${w.where}|${w.script}|${w.api}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
