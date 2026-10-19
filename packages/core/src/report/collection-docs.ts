import type { AuthConfig, BodyConfig, Collection, CollectionNode, KeyValue, SavedExample } from '../model/types.js';
import { Redactor } from '../util/redact.js';

export interface CollectionDocsOptions {
  /** Masks sensitive header, parameter and body values (defaults to the standard redactor). */
  redactor?: Redactor;
  /** Include saved examples (default true). */
  examples?: boolean;
}

/** Stable anchor for a request or folder heading. */
export function docsAnchor(id: string): string {
  return 'req-' + id.replace(/[^A-Za-z0-9_-]/g, '-');
}

const fence = (text: string, lang = '') => {
  const ticks = /```/.test(text) ? '````' : '```';
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
};
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const langOf = (text: string, contentType?: string) =>
  /json/i.test(contentType ?? '') || /^\s*[{[]/.test(text) ? 'json' : /xml/i.test(contentType ?? '') || /^\s*</.test(text) ? 'xml' : '';

/** Like Redactor.redactUrl, but also for templated URLs (`{{baseUrl}}/x?token=…`) that URL() can't parse. */
function redactTemplateUrl(url: string, r: Redactor): string {
  const i = url.indexOf('?');
  if (i < 0) return r.redactUrl(url);
  const qs = url
    .slice(i + 1)
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      return eq > 0 && r.isSensitiveKey(decodeURIComponent(part.slice(0, eq))) ? `${part.slice(0, eq)}=REDACTED` : part;
    })
    .join('&');
  return r.redactString(url.slice(0, i) + '?' + qs);
}

function table(title: string, rows: KeyValue[] | undefined, r: Redactor): string[] {
  const live = (rows ?? []).filter((x) => x.key && x.enabled !== false);
  if (!live.length) return [];
  // a bare {{variable}} reference is not a secret, so docs show it even for sensitive names
  const shown = (x: KeyValue) => (r.isSensitiveKey(x.key) && !/^\{\{[^{}]+\}\}$/.test((x.value ?? '').trim()) ? '••••••' : r.redactString(x.value ?? ''));
  return [`**${title}**`, '', '| Name | Value | Description |', '|---|---|---|', ...live.map((x) => `| \`${cell(x.key)}\` | ${cell(shown(x))} | ${cell(x.description ?? '')} |`), ''];
}

function authText(a: AuthConfig | undefined): string | undefined {
  if (!a || a.type === 'none') return undefined;
  if (a.type === 'inherit') return 'Inherited from the folder or collection';
  const names: Record<string, string> = { basic: 'Basic', bearer: 'Bearer token', apiKey: 'API key', jwt: 'JWT', oauth2: 'OAuth 2.0', headers: 'Custom headers', digest: 'Digest', awsv4: 'AWS Signature', oauth1: 'OAuth 1.0', ntlm: 'NTLM', hawk: 'Hawk', edgegrid: 'Akamai EdgeGrid' };
  return names[a.type] ?? a.type;
}

function bodyText(b: BodyConfig | undefined, r: Redactor): string[] {
  if (!b || b.type === 'none') return [];
  if ('content' in b) {
    if (!b.content.trim()) return [];
    let text = b.content;
    if (b.type === 'json') {
      try {
        text = JSON.stringify(r.redact(JSON.parse(b.content)), null, 2);
      } catch {
        /* templated JSON ({{vars}}): keep as written */
      }
    }
    return ['**Body**', '', fence(r.redactString(text), b.type === 'json' ? 'json' : b.type === 'xml' ? 'xml' : b.type === 'html' ? 'html' : ''), ''];
  }
  if (b.type === 'form-urlencoded' || b.type === 'multipart') return table(b.type === 'multipart' ? 'Body (multipart form)' : 'Body (form URL-encoded)', b.fields, r);
  return ['**Body**', '', `Binary file \`${b.filePath.split(/[\\/]/).pop()}\``, ''];
}

function exampleText(ex: SavedExample): string[] {
  const ct = ex.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;
  const out = [`**Example: ${ex.name}** · \`${ex.status}${ex.statusText ? ' ' + ex.statusText : ''}\``, ''];
  if (ex.request) out.push(`\`${ex.request.method} ${ex.request.url}\``, '');
  if (ex.body.trim()) {
    let body = ex.body;
    if (langOf(body, ct) === 'json') {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* keep */
      }
    }
    out.push(fence(body.length > 8000 ? body.slice(0, 8000) + '\n…' : body, langOf(body, ct)), '');
  }
  return out;
}

/**
 * Render a collection as Markdown documentation, like Postman's published docs: the collection
 * description, then every folder and request with its description, URL, auth, parameters,
 * headers, body and saved examples. Sensitive values are masked.
 */
export function collectionMarkdown(collection: Collection, opts: CollectionDocsOptions = {}): string {
  const r = opts.redactor ?? new Redactor();
  const lines: string[] = [`# ${collection.name}`, ''];
  if (collection.description?.trim()) lines.push(collection.description.trim(), '');
  const auth = authText(collection.auth);
  if (auth) lines.push(`**Authorization:** ${auth}`, '');
  lines.push(...table('Variables', collection.variables, r));

  // table of contents
  const toc: string[] = [];
  const walkToc = (nodes: CollectionNode[], depth: number) => {
    for (const n of nodes) {
      const pad = '  '.repeat(depth);
      if (n.kind === 'folder') {
        toc.push(`${pad}- [${n.name}](#${docsAnchor(n.id)})`);
        walkToc(n.items, depth + 1);
      } else toc.push(`${pad}- [${n.kind === 'http' ? n.request.method.toUpperCase() : 'GRAPHQL'} ${n.name}](#${docsAnchor(n.id)})`);
    }
  };
  walkToc(collection.items, 0);
  if (toc.length) lines.push('## Contents', '', ...toc, '');

  const walk = (nodes: CollectionNode[], level: number) => {
    const h = '#'.repeat(Math.min(level, 6));
    for (const n of nodes) {
      if (n.kind === 'folder') {
        lines.push(`<a id="${docsAnchor(n.id)}"></a>`, '', `${h} ${n.name}`, '');
        const fa = authText(n.auth);
        if (fa) lines.push(`**Authorization:** ${fa}`, '');
        walk(n.items, level + 1);
        continue;
      }
      lines.push(`<a id="${docsAnchor(n.id)}"></a>`, '', `${h} ${n.name}`, '');
      if (n.kind === 'graphql') {
        lines.push(`\`POST ${redactTemplateUrl(n.request.endpoint, r)}\` · GraphQL`, '', fence(n.request.query, 'graphql'), '');
        continue;
      }
      const q = n.request;
      lines.push(`\`${q.method.toUpperCase()} ${redactTemplateUrl(q.url, r)}\``, '');
      if (n.description?.trim()) lines.push(n.description.trim(), '');
      const a = authText(q.auth);
      if (a) lines.push(`**Authorization:** ${a}`, '');
      lines.push(...table('Path variables', q.pathVariables, r), ...table('Query parameters', q.params, r), ...table('Headers', q.headers, r), ...bodyText(q.body, r));
      if (opts.examples !== false) for (const ex of n.examples ?? []) lines.push(...exampleText(ex));
    }
  };
  walk(collection.items, 2);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
