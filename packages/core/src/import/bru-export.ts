import type { AuthConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, Environment, KeyValue, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';

/**
 * A collection as a Bruno collection folder (the way Bruno keeps collections in git): bruno.json,
 * collection.bru, a folder per folder (with folder.bru), a .bru file per request and environments/*.bru.
 * Secret variables keep their names only. Scripts that came from Bruno go back as they were; other
 * scripts use the tp.* API (Postman's too), which Bruno doesn't run, so they are marked.
 */
export function collectionToBru(collection: Collection, environments: Environment[] = []): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  files.push({ path: 'bruno.json', text: JSON.stringify({ version: '1', name: collection.name, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2) + '\n' });
  const root = rootBlocks(collection.auth, collection.variables, collection.preRequestScript, collection.testScript, collection.description);
  if (root) files.push({ path: 'collection.bru', text: root });
  const used = new Set<string>();
  const walk = (nodes: CollectionNode[], dir: string) => {
    nodes.forEach((n, i) => {
      const base = unique(used, `${dir}${fileName(n.name)}`);
      if (n.kind === 'folder') {
        const f = n as CollectionFolder;
        files.push({ path: `${base}/folder.bru`, text: [block('meta', [['name', f.name], ['seq', String(i + 1)]]), rootBlocks(f.auth, f.variables, f.preRequestScript, f.testScript) ?? ''].filter(Boolean).join('\n') });
        walk(f.items, `${base}/`);
      } else files.push({ path: `${base}.bru`, text: requestBru(n, i + 1) });
    });
  };
  walk(collection.items, '');
  for (const e of environments) {
    const plain = e.variables.filter((v) => !v.secret);
    const secret = e.variables.filter((v) => v.secret);
    const parts = [block('vars', plain.map((v) => [v.key, v.value ?? '', v.enabled === false]))];
    if (secret.length) parts.push(`vars:secret [\n${secret.map((v) => `  ${v.enabled === false ? '~' : ''}${v.key}`).join(',\n')}\n]\n`);
    files.push({ path: `environments/${fileName(e.name)}.bru`, text: parts.join('\n') });
  }
  return files;
}

const fileName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+$/g, '').replace(/^\.+/, '') || 'request';
function unique(used: Set<string>, p: string): string {
  let out = p;
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${p} (${i})`;
  used.add(out.toLowerCase());
  return out;
}

/** `name {` key: value lines `}` ("~" marks disabled entries); an empty block is left out. */
function block(name: string, entries: Array<[string, string, boolean?]>): string {
  if (!entries.length) return '';
  return `${name} {\n${entries.map(([k, v, off]) => `  ${off ? '~' : ''}${k}: ${String(v).replace(/\r?\n/g, ' ')}`).join('\n')}\n}\n`;
}
/** `name {` indented text `}`, for bodies, scripts and docs. */
function textBlock(name: string, text: string | undefined): string {
  if (!text?.trim()) return '';
  return `${name} {\n${text.replace(/\r\n/g, '\n').split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')}\n}\n`;
}
const kvEntries = (l?: KeyValue[]): Array<[string, string, boolean]> => (l ?? []).filter((x) => x.key).map((x) => [x.key, x.value ?? '', x.enabled === false]);

/** A script for Bruno: its own scripts without the import marker; tp.* scripts marked (Bruno runs bru / req / res). */
function script(s: string | undefined): string | undefined {
  if (!s?.trim()) return undefined;
  if (/^\/\/ Bruno script/.test(s)) return s.replace(/^\/\/ Bruno script[^\n]*\n?/, '');
  return `// Exported from TestPion: this script uses the tp.* script API (Postman-compatible); rewrite it with Bruno's bru / req / res to run it in Bruno.\n${s}`;
}

function authMode(a: AuthConfig | undefined): string {
  if (!a) return 'inherit';
  const map: Record<string, string> = { none: 'none', inherit: 'inherit', bearer: 'bearer', basic: 'basic', digest: 'digest', apiKey: 'apikey', awsv4: 'awsv4', oauth2: 'oauth2' };
  return map[a.type] ?? 'none';
}
function authBlock(a: AuthConfig | undefined): string {
  if (!a) return '';
  const x = a as unknown as Record<string, string | undefined>;
  switch (a.type) {
    case 'bearer':
      return block('auth:bearer', [['token', x.token ?? '']]);
    case 'basic':
    case 'digest':
      return block(`auth:${a.type}`, [['username', x.username ?? ''], ['password', x.password ?? '']]);
    case 'apiKey':
      return block('auth:apikey', [['key', x.key ?? ''], ['value', x.value ?? ''], ['placement', x.in === 'query' ? 'queryparams' : 'header']]);
    case 'awsv4':
      return block('auth:awsv4', [['accessKeyId', x.accessKey ?? ''], ['secretAccessKey', x.secretKey ?? ''], ['sessionToken', x.sessionToken ?? ''], ['service', x.service ?? ''], ['region', x.region ?? ''], ['profileName', '']]);
    case 'oauth2':
      return block('auth:oauth2', [['grant_type', x.grantType ?? 'client_credentials'], ['access_token_url', x.tokenUrl ?? ''], ['client_id', x.clientId ?? ''], ['client_secret', x.clientSecret ?? ''], ['scope', x.scope ?? '']]);
    default:
      return '';
  }
}

function rootBlocks(auth: AuthConfig | undefined, vars: KeyValue[] | undefined, pre?: string, post?: string, docs?: string): string | undefined {
  const parts = [
    auth && auth.type !== 'inherit' ? block('auth', [['mode', authMode(auth)]]) + authBlock(auth) : '',
    block('vars:pre-request', kvEntries(vars)),
    textBlock('script:pre-request', script(pre)),
    textBlock('tests', script(post)),
    textBlock('docs', docs),
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

/** Status and JSONPath equals / exists checks as Bruno assertions; others are left out. */
function assertions(checks: CheckConfig[] | undefined): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = [];
  for (const c of checks ?? []) {
    const path = typeof c.path === 'string' ? c.path.replace(/^\$\.?/, '') : '';
    const lit = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
    if (c.type === 'status' && c.expected !== undefined) out.push(['res.status', `eq ${c.expected}`, false]);
    else if (c.type === 'equals' && path) out.push([`res.body.${path}`, `eq ${lit(c.expected)}`, false]);
    else if (c.type === 'exists' && path) out.push([`res.body.${path}`, 'isDefined', false]);
  }
  return out;
}

function requestBru(n: SavedHttpRequest | SavedGraphQLRequest, seq: number): string {
  if (n.kind === 'graphql') {
    const r = n.request;
    return [
      block('meta', [['name', n.name], ['type', 'graphql'], ['seq', String(seq)]]),
      block('post', [['url', r.endpoint], ['body', 'graphql'], ['auth', authMode(r.auth)]]),
      block('headers', kvEntries(r.headers)),
      authBlock(r.auth),
      textBlock('body:graphql', r.query),
      textBlock('body:graphql:vars', r.variables ? JSON.stringify(r.variables, null, 2) : undefined),
      textBlock('script:pre-request', script(n.preRequestScript)),
      block('assert', assertions(n.assertions)),
      textBlock('tests', script(n.testScript)),
    ]
      .filter(Boolean)
      .join('\n');
  }
  const r = n.request;
  const b = r.body;
  const bodyMode = !b || b.type === 'none' ? 'none' : b.type === 'form-urlencoded' ? 'form-urlencoded' : b.type === 'multipart' ? 'multipart-form' : b.type === 'json' || b.type === 'xml' || b.type === 'text' ? b.type : 'text';
  const body =
    !b || b.type === 'none'
      ? ''
      : b.type === 'form-urlencoded'
        ? block('body:form-urlencoded', kvEntries(b.fields))
        : b.type === 'multipart'
          ? block('body:multipart-form', (b.fields ?? []).filter((f) => f.key).map((f) => [f.key, f.kind === 'file' ? `@file(${f.value})` : f.value, f.enabled === false]))
          : 'content' in b
            ? textBlock(`body:${bodyMode}`, String(b.content ?? ''))
            : '';
  const url = r.params?.some((p) => p.enabled !== false && p.key) ? `${r.url}${r.url.includes('?') ? '&' : '?'}${r.params.filter((p) => p.enabled !== false && p.key).map((p) => `${p.key}=${p.value ?? ''}`).join('&')}` : r.url;
  return [
    block('meta', [['name', n.name], ['type', 'http'], ['seq', String(seq)]]),
    block(r.method.toLowerCase(), [['url', url], ['body', bodyMode], ['auth', authMode(r.auth)]]),
    block('params:query', kvEntries(r.params)),
    block('params:path', kvEntries(r.pathVariables)),
    block('headers', kvEntries(r.headers)),
    authBlock(r.auth),
    body,
    textBlock('script:pre-request', script(n.preRequestScript)),
    block('assert', assertions(n.assertions)),
    textBlock('tests', script(n.testScript)),
    textBlock('docs', n.description),
  ]
    .filter(Boolean)
    .join('\n');
}
