import type { AuthConfig, BodyConfig, Collection, CollectionNode, KeyValue, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';

/**
 * `.http` / `.rest` files, the request format of VS Code's REST Client and the JetBrains HTTP Client (kept next to code
 * in many repositories): requests separated by `###`, `@name = value` file variables, `# @name login` request names and
 * `{{login.response.body.token}}` chaining, and JetBrains `> {% … %}` response handlers / `< {% … %}` pre-request
 * scripts, which run in TestPion through a small `client` / `response` / `request` shim on `tp.*`.
 */
const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT';
const REQUEST_LINE = new RegExp(`^(${METHODS})\\s+(\\S.*?)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, 'i');

/** Whether a text is an .http file: a request line (METHOD URL) and the format's markers or a URL alone. */
export function isHttpFile(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const first = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('//') && !/^@[\w.-]+\s*=/.test(l));
  if (!first || !REQUEST_LINE.test(first)) return false;
  // a cURL or fetch snippet starts differently; a lone "GET https://…" line is an .http request too
  return /^(https?:\/\/|\{\{|\/)/i.test(first.replace(REQUEST_LINE, '$2'));
}

/** What the JetBrains HTTP Client gives scripts, on top of TestPion's tp.* (the handler's code runs as written). */
const RESPONSE_SHIM = [
  '// JetBrains HTTP Client API, mapped to tp.*',
  'const client = { test: (name, fn) => tp.test(name, fn), assert: (cond, message) => tp.expect(!!cond, message || "assertion failed").to.be.true, log: (...a) => console.log(...a), global: { set: (k, v) => tp.environment.set(k, v), get: (k) => tp.environment.get(k), clear: (k) => tp.environment.unset(k) } };',
  'const response = { status: tp.response.code, body: (() => { try { return tp.response.json(); } catch { return tp.response.text(); } })(), headers: { valueOf: (h) => tp.response.headers.get(h), valuesOf: (h) => [tp.response.headers.get(h)].filter(Boolean) }, contentType: { mimeType: String(tp.response.headers.get("Content-Type") || "").split(";")[0] } };',
].join('\n');
const REQUEST_SHIM = [
  '// JetBrains HTTP Client API, mapped to tp.*',
  'const client = { log: (...a) => console.log(...a), global: { set: (k, v) => tp.environment.set(k, v), get: (k) => tp.environment.get(k), clear: (k) => tp.environment.unset(k) } };',
  'const request = { variables: { set: (k, v) => tp.variables.set(k, v), get: (k) => tp.variables.get(k) }, environment: { get: (k) => tp.environment.get(k) } };',
].join('\n');

/** After a request named in REST Client style, its response is kept for {{name.response.body.…}} references. */
const keepResponse = (name: string) =>
  `// REST Client chaining: {{${name}.response.body…}} and {{${name}.response.headers…}} read this\ntp.variables.set(${JSON.stringify(name)}, { response: { status: tp.response.code, body: (() => { try { return tp.response.json(); } catch { return tp.response.text(); } })(), headers: tp.response.headers.toObject() } });`;

export interface HttpFileImport {
  collection: Collection;
  /** What did not come over, for the import message. */
  notes: string[];
}

export function importHttpFile(text: string, opts: { name?: string } = {}): HttpFileImport {
  const notes: string[] = [];
  const variables: KeyValue[] = [];
  const items: SavedHttpRequest[] = [];
  const named = new Set<string>();
  // blocks between ### separators (a ### line may carry the request's name)
  const blocks: Array<{ title?: string; lines: string[] }> = [{ lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const sep = /^###\s*(.*)$/.exec(line);
    if (sep) blocks.push({ title: sep[1]!.trim() || undefined, lines: [] });
    else blocks[blocks.length - 1]!.lines.push(line);
  }
  for (const block of blocks) {
    let name = block.title;
    let i = 0;
    const ls = block.lines;
    let pre = '';
    // comments, file variables, @name and pre-request scripts before the request line
    for (; i < ls.length; i++) {
      const l = ls[i]!.trim();
      if (!l) continue;
      const v = /^@([\w.-]+)\s*=\s*(.*)$/.exec(l);
      if (v) {
        variables.push({ key: v[1]!, value: v[2]!.trim(), enabled: true });
        continue;
      }
      const at = /^(?:#|\/\/)\s*@name\s+(\S+)/.exec(l);
      if (at) {
        name = at[1]!;
        named.add(at[1]!);
        continue;
      }
      if (/^(?:#|\/\/)\s*@/.test(l)) continue; // @no-redirect, @no-cookie-jar …
      if (l.startsWith('#') || l.startsWith('//')) continue;
      if (l.startsWith('< {%')) {
        const end = ls.findIndex((x, j) => j >= i && x.includes('%}'));
        pre = ls
          .slice(i, end + 1)
          .join('\n')
          .replace(/^\s*<\s*\{%/, '')
          .replace(/%\}\s*$/, '')
          .trim();
        i = end;
        continue;
      }
      break;
    }
    if (i >= ls.length) continue;
    const m = REQUEST_LINE.exec(ls[i]!.trim()) ?? /^((?:https?:\/\/|\{\{)\S.*)$/i.exec(ls[i]!.trim());
    if (!m) {
      notes.push(`Not a request line: ${ls[i]!.trim().slice(0, 80)}`);
      continue;
    }
    const method = m.length > 2 && m[2] ? m[1]!.toUpperCase() : 'GET';
    let url = (m.length > 2 && m[2] ? m[2] : m[1])!.trim();
    i++;
    // query lines that continue the URL (REST Client allows ?a=1 / &b=2 on the next lines)
    while (i < ls.length && /^\s+[?&]/.test(ls[i]!)) url += ls[i++]!.trim();
    const headers: KeyValue[] = [];
    for (; i < ls.length && ls[i]!.trim(); i++) {
      const h = /^([^:\s][^:]*):\s*(.*)$/.exec(ls[i]!.trim());
      if (h) headers.push({ key: h[1]!.trim(), value: h[2]!.trim(), enabled: true });
    }
    // the body, up to a response handler or the end; JetBrains `> {% … %}` handlers become the test script
    const rest = ls.slice(i + 1);
    const handlerAt = rest.findIndex((l) => /^\s*>\s*(\{%|\S+\.js\s*$)/.test(l));
    let bodyText = (handlerAt >= 0 ? rest.slice(0, handlerAt) : rest).join('\n').replace(/\s+$/, '');
    let handler = '';
    if (handlerAt >= 0) {
      const tail = rest.slice(handlerAt).join('\n');
      const inline = /^\s*>\s*\{%([\s\S]*?)%\}/.exec(tail);
      if (inline) handler = inline[1]!.trim();
      else notes.push(`${name ?? `${method} ${url}`}: the response handler in a file (${tail.trim().slice(1).trim()}) isn't imported`);
    }
    // a response reference (<> ./previous.json) and comments after the body
    bodyText = bodyText
      .split('\n')
      .filter((l) => !/^\s*<>\s/.test(l))
      .join('\n')
      .replace(/\s+$/, '');
    let body: BodyConfig | undefined;
    const ct = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
    if (/^\s*<\s+\S/.test(bodyText) && !bodyText.includes('\n')) {
      body = { type: 'binary', filePath: bodyText.trim().replace(/^<\s+/, '') };
      notes.push(`${name ?? `${method} ${url}`}: the body comes from the file ${bodyText.trim().replace(/^<\s+/, '')}; check the path in TestPion`);
    } else if (bodyText.trim()) {
      if (/x-www-form-urlencoded/.test(ct))
        body = {
          type: 'form-urlencoded',
          fields: bodyText
            .replace(/\n\s*&/g, '&')
            .trim()
            .split('&')
            .map((p) => {
              const [k, ...v] = p.split('=');
              return { key: decodeURIComponent(k!.trim()), value: decodeURIComponent(v.join('=').trim()), enabled: true };
            }),
        };
      else body = { type: /json/.test(ct) || /^\s*[{[]/.test(bodyText) ? 'json' : /xml/.test(ct) ? 'xml' : 'text', content: bodyText.trim() };
    }
    // an Authorization header written as Basic user password (REST Client) becomes basic auth
    let auth: AuthConfig | undefined;
    const authIdx = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
    if (authIdx >= 0) {
      const a = headers[authIdx]!.value;
      const basic = /^Basic\s+(\S+)\s+(\S+)$/i.exec(a);
      const bearer = /^Bearer\s+(\S+)$/i.exec(a);
      if (basic) auth = { type: 'basic', username: basic[1]!, password: basic[2]! };
      else if (bearer) auth = { type: 'bearer', token: bearer[1]! };
      if (auth) headers.splice(authIdx, 1);
    }
    const scripts: string[] = [];
    if (handler) scripts.push(`${RESPONSE_SHIM}\n\n${handler}`);
    const reqName = name ?? `${method} ${url.replace(/^\{\{[^}]+\}\}|^https?:\/\/[^/]+/, '') || url}`;
    items.push({
      kind: 'http',
      id: shortId('req-'),
      name: reqName,
      request: { method, url, headers, ...(body ? { body } : {}), auth: auth ?? { type: 'inherit' } },
      ...(pre ? { preRequestScript: `${REQUEST_SHIM}\n\n${pre}` } : {}),
      ...(scripts.length ? { testScript: scripts.join('\n\n') } : {}),
      // the REST Client name, to add the chaining script once every reference is known
      ...({ __restName: at(name, named) } as object),
    } as SavedHttpRequest);
  }
  // REST Client chaining: a named request whose response another one reads keeps it ({{login.response.body.$.token}})
  const all = JSON.stringify(items);
  for (const it of items) {
    const rn = (it as unknown as { __restName?: string }).__restName;
    delete (it as unknown as { __restName?: string }).__restName;
    if (!rn || !all.includes(`{{${rn}.response.`)) continue;
    it.testScript = [it.testScript, keepResponse(rn)].filter(Boolean).join('\n\n');
  }
  // {{x.response.body.$.a.b}} (JSONPath root) reads like {{x.response.body.a.b}} in TestPion
  const fix = (s: string) => s.replace(/\{\{\s*([\w-]+)\.response\.body\.\$\.?/g, '{{$1.response.body.');
  const collection: Collection = {
    schemaVersion: SCHEMA_VERSION,
    id: `${slugify(opts.name ?? 'http-requests') || 'http-requests'}-${shortId().slice(-4)}`,
    name: opts.name ?? 'HTTP requests',
    version: 0,
    variables: variables.map((v) => ({ ...v, value: fix(v.value) })),
    items: JSON.parse(fix(JSON.stringify(items))) as CollectionNode[],
    updatedAt: new Date().toISOString(),
  };
  if (/\{\{\s*\$dotenv\s/.test(text)) notes.push('{{$dotenv NAME}} reads a .env file in REST Client: import the .env file as an environment, then use {{NAME}}');
  return { collection, notes };
}

const at = (name: string | undefined, named: Set<string>) => (name && named.has(name) ? name : undefined);

/** A collection as one .http file (REST Client and JetBrains read it): folders as comments, scripts left out. */
export function collectionToHttpFile(c: Collection): { text: string; notes: string[] } {
  const notes: string[] = [];
  const out: string[] = [`# ${c.name}`, ''];
  for (const v of c.variables ?? []) if (v.enabled !== false) out.push(`@${v.key} = ${v.value}`);
  if ((c.variables ?? []).length) out.push('');
  // {{variables}} stay readable in a form body; the rest is URL-encoded
  const enc = (v: string) => encodeURIComponent(v).replace(/%7B%7B(.*?)%7D%7D/g, (_m, x: string) => `{{${decodeURIComponent(x)}}}`);
  const walk = (nodes: CollectionNode[], path: string[], inherited: AuthConfig | undefined) => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        walk(n.items, [...path, n.name], n.auth && n.auth.type !== 'inherit' ? n.auth : inherited);
        continue;
      }
      if (n.kind !== 'http') {
        notes.push(`${n.name}: only HTTP requests fit an .http file`);
        continue;
      }
      const r = n.request;
      out.push(`### ${[...path, n.name].join(' / ')}`);
      out.push(`# @name ${slugify(n.name).replace(/-/g, '_') || 'request'}`);
      const q = (r.params ?? []).filter((p) => p.enabled !== false && p.key);
      const url = q.length ? `${r.url}${r.url.includes('?') ? '&' : '?'}${q.map((p) => `${p.key}=${p.value}`).join('&')}` : r.url;
      out.push(`${r.method.toUpperCase()} ${url}`);
      for (const h of r.headers ?? []) if (h.enabled !== false && h.key) out.push(`${h.key}: ${h.value}`);
      // a request that inherits its auth gets its folder's or collection's
      const a = !r.auth || r.auth.type === 'inherit' ? inherited : r.auth;
      if (a?.type === 'bearer') out.push(`Authorization: Bearer ${a.token ?? ''}`);
      else if (a?.type === 'basic') out.push(`Authorization: Basic ${a.username ?? ''} ${a.password ?? ''}`);
      else if (a?.type === 'apiKey' && (a.in ?? 'header') === 'header') out.push(`${a.key}: ${a.value ?? ''}`);
      else if (a && a.type !== 'inherit' && a.type !== 'none') notes.push(`${n.name}: ${a.type} auth isn't written (the .http format has no place for it)`);
      const b = r.body;
      if (b && b.type !== 'none') {
        if ((b.type === 'json' || b.type === 'xml' || b.type === 'text' || b.type === 'html') && !(r.headers ?? []).some((h) => h.key.toLowerCase() === 'content-type'))
          out.push(`Content-Type: ${b.type === 'json' ? 'application/json' : b.type === 'xml' ? 'application/xml' : b.type === 'html' ? 'text/html' : 'text/plain'}`);
        if (b.type === 'form-urlencoded' && !(r.headers ?? []).some((h) => h.key.toLowerCase() === 'content-type')) out.push('Content-Type: application/x-www-form-urlencoded');
        out.push('');
        if (b.type === 'json' || b.type === 'xml' || b.type === 'text' || b.type === 'html') out.push(b.content);
        else if (b.type === 'form-urlencoded')
          out.push(
            b.fields
              .filter((f) => f.enabled !== false)
              .map((f) => `${enc(f.key)}=${enc(f.value)}`)
              .join('&'),
          );
        else if (b.type === 'binary') out.push(`< ${b.filePath}`);
        else notes.push(`${n.name}: a multipart body isn't written`);
      }
      if (n.testScript || n.preRequestScript) notes.push(`${n.name}: scripts aren't written (they use tp.* / pm.*)`);
      out.push('');
    }
  };
  walk(c.items, [], c.auth && c.auth.type !== 'inherit' ? c.auth : undefined);
  return {
    text:
      out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd() + '\n',
    notes,
  };
}
