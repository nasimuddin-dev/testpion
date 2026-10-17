import type { CollectionFolder, CollectionNode, KeyValue } from '../model/types.js';
import { DYNAMIC_VARIABLES } from '../vars/dynamic.js';

/**
 * Insomnia's template tags (https://developer.konghq.com/insomnia/template-tags/) in an imported request, as
 * TestPion: `{% uuid %}`, `{% now %}`, `{% timestamp %}` and `{% faker %}` become dynamic variables ({{$guid}} …);
 * `{% base64 %}`, `{% hash %}` and a custom `{% now %}` format become a pre-request line that sets a variable; a
 * `{% response %}` of another request is CHAINED (that request's post-response script sets a collection variable,
 * this one uses `{{it}}`); `{% prompt %}` becomes a variable to set. Any other tag stays as text with a note that
 * names the request: nothing is left as a silent literal.
 */

type Any = Record<string, any>;

/** An imported Insomnia request and its Insomnia id (`req_…`), in collection order. */
export interface InsomniaImported {
  id?: string;
  node: Exclude<CollectionNode, { kind: 'folder' }>;
}

const DYNAMIC = new Set(DYNAMIC_VARIABLES.map((v) => v.name));
const TAG = /\{%\s*([\w.-]+)\s*([\s\S]*?)\s*%\}/g;

/** `'a', 'b::x', 60` → ['a', 'b::x', '60']; `b64::<base64>::46b` arguments are decoded (Insomnia encodes some). */
export function tagArgs(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([^,\s]+)/g)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(['"\\])/g, '$1');
    const b64 = /^b64::([A-Za-z0-9+/=_-]*)::46b$/.exec(v);
    out.push(b64 ? decodeB64(b64[1]!) : v);
  }
  return out;
}

function decodeB64(s: string): string {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

/** A simple JSONPath (`$.a.b[0]['c-d']`) as an optional-chaining accessor (`?.a?.b?.[0]?.["c-d"]`); undefined when it uses filters, wildcards or `..`. */
export function jsonPathAccessor(path: string): { accessor: string; last: string } | undefined {
  const p = path.trim();
  if (!p.startsWith('$')) return undefined;
  let accessor = '';
  let last = 'value';
  const re = /\.([A-Za-z_$][\w$]*)|\[\s*(\d+)\s*\]|\[\s*(['"])([^'"]*)\3\s*\]/y;
  let i = 1;
  while (i < p.length) {
    re.lastIndex = i;
    const m = re.exec(p);
    if (!m) return undefined;
    if (m[1] !== undefined) {
      accessor += `?.${m[1]}`;
      last = m[1];
    } else if (m[2] !== undefined) accessor += `?.[${m[2]}]`;
    else {
      accessor += `?.[${JSON.stringify(m[4])}]`;
      last = m[4]!;
    }
    i = re.lastIndex;
  }
  return { accessor, last };
}

const ident = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'value';

interface State {
  notes: string[];
  noted: Set<string>;
  byId: Map<string, { node: InsomniaImported['node']; index: number }>;
  chained: Map<string, string>;
  taken: Set<string>;
}

const note = (st: State, text: string) => {
  if (st.noted.has(text)) return;
  st.noted.add(text);
  st.notes.push(text);
};

const appendScript = (node: InsomniaImported['node'], field: 'preRequestScript' | 'testScript', lines: string[]) => {
  node[field] = [node[field], ...lines].filter((x) => x && String(x).trim()).join('\n');
};

/** A variable name not used yet by this import. */
const fresh = (st: State, base: string) => {
  let name = base;
  for (let i = 2; st.taken.has(name); i++) name = `${base}_${i}`;
  st.taken.add(name);
  return name;
};

/** Where a tag is: a request (with its index in collection order and its pre-request lines), a folder or an environment. */
interface Place {
  /** As notes name it: `"Get patient"`, `Folder "Patients"`, `Environment "Staging"`. */
  where: string;
  index?: number;
  pre?: string[];
}

function mapTag(st: State, tag: string, name: string, args: string[], at: Place): string {
  const { where, pre } = at;
  const literal = (why: string) => {
    note(st, `${where}: Insomnia template tag ${tag.replace(/\s+/g, ' ').slice(0, 120)} ${why}: it is left as text, set the value by hand`);
    return tag;
  };
  const viaScript = (base: string, expr: string) => {
    if (!pre) return literal('needs a pre-request script (only requests have one here)');
    const v = fresh(st, `insomnia_${base}`);
    pre.push(`{ const CryptoJS = require('crypto-js'); tp.variables.set(${JSON.stringify(v)}, ${expr}); } // Insomnia ${tag.replace(/\s+/g, ' ').slice(0, 80)}`);
    return `{{${v}}}`;
  };
  const value = (s: string | undefined) => `tp.variables.replaceIn(${JSON.stringify(s ?? '')})`;
  switch (name) {
    case 'uuid':
      if (args[0] && args[0] !== 'v4') note(st, `${where}: {% uuid '${args[0]}' %} became {{$guid}} (a version 4 UUID)`);
      return '{{$guid}}';
    case 'timestamp':
      return '{{$timestampMs}}';
    case 'now': {
      const kind = args[0] ?? 'iso-8601';
      if (kind === 'iso-8601' || kind === '') return '{{$isoTimestamp}}';
      if (kind === 'millis') return '{{$timestampMs}}';
      if (kind === 'unix') return '{{$timestamp}}';
      if (kind === 'custom' && args[1]) return viaScript('now', `require('moment')().format(${JSON.stringify(args[1])})`);
      return literal(`(format "${kind}") is not known`);
    }
    case 'faker': {
      const v = `$${(args[0] ?? '').replace(/^\$/, '')}`;
      return DYNAMIC.has(v) ? `{{${v}}}` : literal(`(${args[0] ?? 'no name'}) has no TestPion dynamic variable`);
    }
    case 'base64': {
      const [action = 'encode', kind = 'normal', text] = args;
      const encoded = `CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(${value(text)}))`;
      if (action === 'encode') return viaScript('base64', kind === 'url' ? `${encoded}.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')` : encoded);
      if (action === 'decode') return viaScript('base64', `CryptoJS.enc.Base64.parse(${value(text)}${kind === 'url' ? `.replace(/-/g, '+').replace(/_/g, '/')` : ''}).toString(CryptoJS.enc.Utf8)`);
      return literal(`(action "${action}") is not known`);
    }
    case 'hash': {
      const [algorithm = 'md5', encoding = 'hex', text] = args;
      const fn = ({ md5: 'MD5', sha1: 'SHA1', sha256: 'SHA256', sha512: 'SHA512' } as Record<string, string>)[algorithm.toLowerCase()];
      if (!fn || !/^(hex|base64)$/.test(encoding)) return literal(`(${algorithm}, ${encoding}) is not supported`);
      return viaScript('hash', `CryptoJS.${fn}(${value(text)}).toString(CryptoJS.enc.${encoding === 'hex' ? 'Hex' : 'Base64'})`);
    }
    case 'prompt': {
      const label = args[1] || args[0] || 'value';
      const v = `prompt_${ident(label)}`;
      note(st, `${where}: Insomnia asked for "${label}" when sending ({% prompt %}): it is now {{${v}}}, set it in an environment`);
      return `{{${v}}}`;
    }
    case 'response': {
      const [field = 'body', refId = '', filter = '', policy = 'never'] = args;
      const ref = st.byId.get(refId);
      if (!ref) return literal(`refers to a request that is not in this import (${refId || 'none'})`);
      const path = field === 'body' && filter ? jsonPathAccessor(filter) : undefined;
      if (field === 'body' && filter && !path) return literal(`(${filter.startsWith('/') ? 'an XPath' : `the JSONPath ${filter}`}) is beyond the simple paths an import converts`);
      const read: Record<string, [string, string]> = {
        body: path ? [`tp.response.json()${path.accessor}`, path.last] : ['tp.response.text()', 'body'],
        header: [`tp.response.headers.get(${JSON.stringify(filter)})`, filter || 'header'],
        raw: ['tp.response.text()', 'body'],
        url: ['tp.request.url.toString()', 'url'],
      };
      if (!read[field]) return literal(`(attribute "${field}") is not known`);
      const [expr, suffix] = read[field]!;
      const key = `${refId}|${field}|${filter}`;
      let v = st.chained.get(key);
      if (!v) {
        v = fresh(st, `insomnia_${ident(ref.node.name)}_${ident(suffix)}`);
        st.chained.set(key, v);
        appendScript(ref.node, 'testScript', [`// Insomnia {% response %}: requests that use {{${v}}} read it from this response`, `tp.collectionVariables.set(${JSON.stringify(v)}, ${expr});`]);
      }
      const order = at.index !== undefined && ref.index > at.index ? `, which comes later in the collection: move it first or run it before` : '';
      const auto = policy !== 'never' ? ' (Insomnia sent it on its own when needed)' : '';
      note(st, `${where}: {% response %} from "${ref.node.name}" became {{${v}}}, set by "${ref.node.name}"'s post-response script: send "${ref.node.name}" first${auto}${order}`);
      return `{{${v}}}`;
    }
    default:
      return literal('has no TestPion equivalent');
  }
}

function mapString(st: State, s: string, at: Place): string {
  if (!s.includes('{%')) return s;
  return s.replace(TAG, (tag, name: string, raw: string) => mapTag(st, tag, name, tagArgs(raw), at));
}

function walk(st: State, v: unknown, at: Place): unknown {
  if (typeof v === 'string') return mapString(st, v, at);
  if (Array.isArray(v)) return v.map((x) => walk(st, x, at));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Any).map(([k, x]) => [k, walk(st, x, at)]));
  return v;
}

/**
 * Map the template tags of every imported request (url, params, headers, body, auth), of the folders' auth and
 * variables and of the environments' values, in place. Returns the notes (each names the item).
 */
export function mapInsomniaTemplateTags(requests: InsomniaImported[], folders: CollectionFolder[] = [], environments: Array<{ name: string; variables: KeyValue[] }> = []): string[] {
  const st: State = { notes: [], noted: new Set(), byId: new Map(), chained: new Map(), taken: new Set() };
  requests.forEach((r, index) => r.id && st.byId.set(r.id, { node: r.node, index }));
  requests.forEach((r, index) => {
    if (!JSON.stringify(r.node.request).includes('{%')) return;
    const pre: string[] = [];
    r.node.request = walk(st, r.node.request, { where: `"${r.node.name}"`, index, pre }) as typeof r.node.request;
    // the pre-request lines run before the request's own script
    if (pre.length) r.node.preRequestScript = [...pre, r.node.preRequestScript].filter(Boolean).join('\n');
  });
  for (const f of folders) {
    const at = { where: `Folder "${f.name}"` };
    if (f.auth && JSON.stringify(f.auth).includes('{%')) f.auth = walk(st, f.auth, at) as typeof f.auth;
    for (const v of f.variables ?? []) if (v.value?.includes('{%')) v.value = mapString(st, v.value, at);
  }
  for (const e of environments) for (const v of e.variables) if (v.value?.includes('{%')) v.value = mapString(st, v.value, { where: `Environment "${e.name}"` });
  return st.notes;
}
