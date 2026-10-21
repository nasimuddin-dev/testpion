import type { CheckConfig, Collection, CollectionFolder, CollectionNode, KeyValue } from '../model/types.js';
import { sha1Hex } from '../util/hash.js';

/**
 * Pieces the exporters (Insomnia, OpenCollection, and the older Postman / Bruno ones) share: stable ids, TestPion's
 * assertions as test code in `tp.*` (so they are not lost in a tool that has no assertions), and the settings a
 * collection carries that the target format only has on folders and requests.
 */

/**
 * A name as a file name on every system: no characters Windows refuses, no trailing dot or space, no leading dot, no
 * device name (CON, NUL, AUX, PRN, COM1-9, LPT1-9, with or without an extension: opening one on Windows talks to a device,
 * not a file), at most 120 characters. An empty name is `fallback`.
 */
export function safeFileName(name: string, fallback = 'request'): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').replace(/^\.+/, '').replace(/^\s+/, '').slice(0, 120).replace(/[. ]+$/g, '');
  if (!s) s = fallback;
  s = s.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, '$1_');
  return s;
}

/** A deterministic id with a prefix (`req_3f9c…`), so exporting the same collection twice gives the same ids. */
export const stableId = (prefix: string, seed: string): string => `${prefix}_${sha1Hex(seed).slice(0, 24)}`;

const q = (v: unknown) => JSON.stringify(v);
const pathExpr = (path: string): string => {
  const p = path.replace(/^\$\.?/, '');
  return `tp.response.json()${p ? '.' + p.replace(/\.(\d+)(?=\.|$)/g, '[$1]') : ''}`;
};

/**
 * TestPion's response assertions as `tp.test(…)` code, one per assertion. Returns the code and the assertions it could not
 * express (contract checks, AI evaluators …), which the export reports.
 */
export function assertionsToTests(list: CheckConfig[] | undefined): { code: string; skipped: string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const a of list ?? []) {
    const name = String(a.name ?? a.type);
    const exp = a.expected;
    let body: string | undefined;
    switch (a.type) {
      case 'status':
        body = Array.isArray(exp) ? `tp.expect(tp.response.code).to.be.oneOf(${q(exp)})` : typeof exp === 'string' && /^\dxx$/i.test(exp) ? `tp.expect(Math.floor(tp.response.code / 100)).to.equal(${exp[0]})` : `tp.expect(tp.response.code).to.equal(${q(exp)})`;
        break;
      case 'latency':
        body = `tp.expect(tp.response.responseTime).to.be.below(${Number(a.max) + 1})`;
        break;
      case 'header':
        body = exp === undefined ? `tp.expect(tp.response.headers.has(${q(a.header ?? a.name)})).to.equal(true)` : `tp.expect(tp.response.headers.get(${q(a.header ?? a.name)})).to.include(${q(exp)})`;
        break;
      case 'is-json':
        body = 'tp.response.json()';
        break;
      case 'exists':
        body = `tp.expect(${pathExpr(String(a.path))}).to.not.equal(undefined)`;
        break;
      case 'not-exists':
        body = `tp.expect(${pathExpr(String(a.path))}).to.equal(undefined)`;
        break;
      case 'equals':
      case 'json-path':
        body = `tp.expect(${pathExpr(String(a.path))}).to.eql(${q(exp)})`;
        break;
      case 'contains':
        body = a.path ? `tp.expect(${pathExpr(String(a.path))}).to.include(${q(exp)})` : `tp.expect(tp.response.text()).to.include(${q(exp)})`;
        break;
      case 'regex':
        body = `tp.expect(${a.path ? pathExpr(String(a.path)) : 'tp.response.text()'}).to.match(new RegExp(${q(a.pattern)}))`;
        break;
      case 'type':
        body = `tp.expect(${pathExpr(String(a.path))}).to.be.a(${q(exp)})`;
        break;
      case 'length':
        body = typeof exp === 'number' ? `tp.expect(${pathExpr(String(a.path))}).to.have.lengthOf(${exp})` : undefined;
        break;
      case 'greater-than':
        body = `tp.expect(${pathExpr(String(a.path))}).to.be.above(${Number(exp)})`;
        break;
      case 'less-than':
        body = `tp.expect(${pathExpr(String(a.path))}).to.be.below(${Number(exp)})`;
        break;
      case 'json-schema':
        body = typeof a.schema === 'object' ? `tp.expect(tv4.validate(tp.response.json(), ${q(a.schema)})).to.equal(true)` : undefined;
        break;
    }
    if (!body) skipped.push(a.type);
    else lines.push(`tp.test(${q(name)}, function () { ${body}; });`);
  }
  return { code: lines.join('\n'), skipped: [...new Set(skipped)] };
}

/** A script with another one before it (the collection's before the request's), blank-line separated. */
export const joinScripts = (...parts: Array<string | undefined>): string | undefined => {
  const s = parts.filter((p) => p?.trim()).join('\n\n');
  return s || undefined;
};

/** Headers by name, the later list overriding the earlier. */
function mergeHeaderLists(...lists: Array<KeyValue[] | undefined>): KeyValue[] {
  const out = new Map<string, KeyValue>();
  for (const l of lists) for (const h of l ?? []) out.set(h.key.toLowerCase(), h);
  return [...out.values()];
}

/**
 * A format with no collection-level headers, auth or scripts (Insomnia): they move onto the top-level items, which then
 * hold them, so every request still sends and runs what it did. The note says it happened.
 */
export function pushCollectionDefaultsDown(c: Collection, notes: string[]): CollectionNode[] {
  const hasAny = !!(c.headers?.length || (c.auth && c.auth.type !== 'inherit' && c.auth.type !== 'none') || c.preRequestScript?.trim() || c.testScript?.trim());
  if (!hasAny) return c.items;
  notes.push("The collection's own headers, auth and scripts were copied onto its top-level folders and requests (this format has none at the collection level)");
  return c.items.map((n): CollectionNode => {
    const base = { headers: mergeHeaderLists(c.headers, n.kind === 'folder' ? n.headers : n.kind === 'http' ? n.request.headers : n.request.headers) };
    if (n.kind === 'folder') {
      const f: CollectionFolder = { ...n, ...(base.headers.length ? { headers: base.headers } : {}), preRequestScript: joinScripts(c.preRequestScript, n.preRequestScript), testScript: joinScripts(n.testScript, c.testScript) };
      if ((!n.auth || n.auth.type === 'inherit') && c.auth) f.auth = c.auth;
      return f;
    }
    const auth = n.request.auth && n.request.auth.type !== 'inherit' ? n.request.auth : c.auth ?? n.request.auth;
    if (n.kind === 'http') return { ...n, request: { ...n.request, headers: base.headers, ...(auth ? { auth } : {}) }, preRequestScript: joinScripts(c.preRequestScript, n.preRequestScript), testScript: joinScripts(n.testScript, c.testScript) };
    return { ...n, request: { ...n.request, headers: base.headers, ...(auth ? { auth } : {}) }, preRequestScript: joinScripts(c.preRequestScript, n.preRequestScript), testScript: joinScripts(n.testScript, c.testScript) };
  });
}
