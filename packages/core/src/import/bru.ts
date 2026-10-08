import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ApsError } from '../errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * Bruno's own file format (.bru), the files of a Bruno collection folder (the way Bruno keeps
 * collections in git): bruno.json, collection.bru, folder.bru, one .bru file per request and
 * environments/*.bru. They are turned into the shape of a Bruno JSON export, so the Bruno importer
 * handles both.
 */

/** One block of a .bru file: `name { … }` (key: value lines or text) or `name [ … ]` (a list). */
export interface BruBlock {
  name: string;
  /** key: value entries, in order (`~key` = disabled). */
  entries: Array<{ key: string; value: string; enabled: boolean }>;
  /** The block's text, one indentation level removed (for bodies, scripts, tests and docs). */
  text: string;
  list?: string[];
}

const TEXT_BLOCK = /^(body(:(json|text|xml|sparql|graphql|graphql:vars))?|script:.*|tests|docs)$/;

/** Parse a .bru file into its blocks. */
export function parseBru(text: string): BruBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BruBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^([A-Za-z][\w:-]*)\s*([{[])\s*$/.exec(lines[i]!);
    if (!open) continue;
    const close = open[2] === '{' ? '}' : ']';
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j]!.trimEnd() !== close; j++) body.push(lines[j]!);
    i = j;
    const name = open[1]!;
    const dedented = body.map((l) => (l.startsWith('  ') ? l.slice(2) : l.replace(/^\t/, '')));
    const block: BruBlock = { name, entries: [], text: dedented.join('\n').replace(/^\n+|\s+$/g, '') };
    if (close === ']') block.list = body.map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
    else if (!TEXT_BLOCK.test(name)) {
      for (const l of body) {
        const t = l.trim();
        if (!t) continue;
        const m = /^(~?)([^:]+?)\s*:\s?(.*)$/.exec(t);
        if (m) block.entries.push({ key: m[2]!.trim(), value: m[3]!.trim(), enabled: !m[1] });
      }
    }
    blocks.push(block);
  }
  return blocks;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'connect', 'trace'];

const dict = (b: BruBlock | undefined) => Object.fromEntries((b?.entries ?? []).map((e) => [e.key, e.value]));
const nv = (b: BruBlock | undefined) => (b?.entries ?? []).map((e) => ({ name: e.key, value: e.value, enabled: e.enabled }));

/** The auth of a request, folder or collection, in Bruno's JSON export shape. */
function authOf(blocks: BruBlock[], mode: string | undefined): Any | undefined {
  if (!mode) return undefined;
  const get = (n: string) => dict(blocks.find((b) => b.name === `auth:${n}`));
  switch (mode) {
    case 'bearer':
      return { mode, bearer: get('bearer') };
    case 'basic':
      return { mode, basic: get('basic') };
    case 'digest':
      return { mode, digest: get('digest') };
    case 'apikey':
      return { mode, apikey: get('apikey') };
    case 'awsv4':
      return { mode, awsv4: get('awsv4') };
    case 'oauth2': {
      const o = get('oauth2');
      return { mode, oauth2: { grantType: o.grant_type, accessTokenUrl: o.access_token_url, clientId: o.client_id, clientSecret: o.client_secret, scope: o.scope } };
    }
    default:
      return { mode };
  }
}

/** The shared parts of collection.bru and folder.bru (Bruno's "root"). */
function rootOf(blocks: BruBlock[]): Any {
  const find = (n: string) => blocks.find((b) => b.name === n);
  return {
    request: {
      auth: authOf(blocks, dict(find('auth')).mode),
      headers: nv(find('headers')),
      vars: { req: nv(find('vars:pre-request')) },
      script: { req: find('script:pre-request')?.text, res: find('script:post-response')?.text },
      tests: find('tests')?.text,
    },
    docs: find('docs')?.text,
  };
}

/** A request .bru file as a Bruno JSON export item (undefined when it is not a request). */
function bruRequest(text: string, fallbackName: string): Any | undefined {
  const blocks = parseBru(text);
  const find = (n: string) => blocks.find((b) => b.name === n);
  const meta = dict(find('meta'));
  const methodBlock = blocks.find((b) => METHODS.includes(b.name));
  if (!methodBlock) return undefined;
  const m = dict(methodBlock);
  const graphql = meta.type === 'graphql';
  const bodyMode = String(m.body ?? 'none');
  const body: Any = { mode: { 'form-urlencoded': 'formUrlEncoded', 'multipart-form': 'multipartForm' }[bodyMode] ?? bodyMode };
  if (find('body:json')) body.json = find('body:json')!.text;
  if (find('body:text')) body.text = find('body:text')!.text;
  if (find('body:xml')) body.xml = find('body:xml')!.text;
  if (find('body:form-urlencoded')) body.formUrlEncoded = nv(find('body:form-urlencoded'));
  if (find('body:multipart-form'))
    body.multipartForm = find('body:multipart-form')!.entries.map((e) => {
      const file = /^@file\((.*)\)$/.exec(e.value);
      return file ? { name: e.key, value: file[1]!.split('|'), type: 'file', enabled: e.enabled } : { name: e.key, value: e.value, type: 'text', enabled: e.enabled };
    });
  if (find('body:graphql')) body.graphql = { query: find('body:graphql')!.text, variables: find('body:graphql:vars')?.text };
  const params = [
    ...nv(find('params:query')).map((p) => ({ ...p, type: 'query' })),
    ...nv(find('params:path')).map((p) => ({ ...p, type: 'path' })),
    // Bruno 0.x: a plain `query` block
    ...nv(find('query')).map((p) => ({ ...p, type: 'query' })),
  ];
  return {
    type: graphql ? 'graphql-request' : 'http-request',
    name: meta.name || fallbackName,
    seq: Number(meta.seq) || 0,
    request: {
      url: m.url ?? '',
      method: methodBlock.name.toUpperCase(),
      headers: nv(find('headers')),
      params,
      body,
      auth: authOf(blocks, m.auth),
      script: { req: find('script:pre-request')?.text, res: find('script:post-response')?.text },
      vars: { req: nv(find('vars:pre-request')), res: nv(find('vars:post-response')) },
      assertions: nv(find('assert')),
      tests: find('tests')?.text,
      docs: find('docs')?.text,
    },
  };
}

/** An environments/*.bru file as a Bruno JSON export environment. Secret variables have no value in the file. */
function bruEnvironment(text: string, name: string): Any {
  const blocks = parseBru(text);
  const vars = nv(blocks.find((b) => b.name === 'vars'));
  const secrets = blocks.find((b) => b.name === 'vars:secret')?.list ?? [];
  return {
    name,
    variables: [...vars.map((v) => ({ ...v, secret: false })), ...secrets.map((s) => ({ name: s.replace(/^~/, ''), value: '', enabled: !s.startsWith('~'), secret: true }))],
  };
}

/**
 * Files of a Bruno collection folder (paths relative to the folder, with / or \) as a Bruno JSON
 * export. Requests are ordered by their seq, folders by folder.bru's seq, then by name.
 */
export function bruFilesToBrunoExport(files: Array<{ path: string; text: string }>, name?: string): Any {
  const norm = files.map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\.\//, ''), text: f.text }));
  const config = norm.find((f) => f.path === 'bruno.json');
  let collectionName = name;
  if (config) {
    try {
      collectionName ??= (JSON.parse(config.text) as { name?: string }).name;
    } catch {
      /* the folder name is used */
    }
  }
  const collectionFile = norm.find((f) => f.path === 'collection.bru');
  const root: Any = { name: collectionName ?? 'Bruno collection', version: '1', items: [], environments: [], ...(collectionFile ? { root: rootOf(parseBru(collectionFile.text)) } : {}) };
  const folders = new Map<string, Any>([['', root]]);
  const folderOf = (dir: string): Any => {
    if (folders.has(dir)) return folders.get(dir);
    const parent = folderOf(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
    const settings = norm.find((f) => f.path === `${dir}/folder.bru`);
    const blocks = settings ? parseBru(settings.text) : [];
    const meta = dict(blocks.find((b) => b.name === 'meta'));
    const folder = { type: 'folder', name: meta.name || dir.split('/').pop(), seq: Number(meta.seq) || Number.MAX_SAFE_INTEGER, items: [] as Any[], ...(settings ? { root: rootOf(blocks) } : {}) };
    parent.items.push(folder);
    folders.set(dir, folder);
    return folder;
  };
  for (const f of norm.filter((x) => x.path.endsWith('.bru')).sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const file = f.path.split('/').pop()!;
    if (dir === 'environments') {
      root.environments.push(bruEnvironment(f.text, file.replace(/\.bru$/, '')));
      continue;
    }
    if (file === 'folder.bru' || (file === 'collection.bru' && !dir)) {
      if (file === 'folder.bru') folderOf(dir);
      continue;
    }
    const item = bruRequest(f.text, file.replace(/\.bru$/, ''));
    if (item) folderOf(dir).items.push(item);
  }
  // folders without a seq go after the requests, in name order
  for (const folder of folders.values()) folder.items.sort((a: Any, b: Any) => (a.type === 'folder') === (b.type === 'folder') ? (a.seq ?? 0) - (b.seq ?? 0) || String(a.name).localeCompare(String(b.name)) : a.type === 'folder' ? 1 : -1);
  return root;
}

/** Is this the text of a .bru request file? */
export function looksLikeBru(text: string): boolean {
  return /^meta\s*\{/m.test(text) && new RegExp(`^(${METHODS.join('|')})\\s*\\{`, 'm').test(text);
}

/** Read a Bruno collection folder (bruno.json + .bru files) from disk as the text of a Bruno JSON export. */
export function readBrunoFolder(dir: string): string {
  if (!existsSync(join(dir, 'bruno.json')) && !readdirSync(dir).some((f) => f.endsWith('.bru')))
    throw new ApsError('ValidationError', `${dir} is not a Bruno collection folder (no bruno.json or .bru files)`, { suggestions: ['Choose the folder that holds bruno.json.'] });
  const files: Array<{ path: string; text: string }> = [];
  let total = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 12) return;
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith('.bru') || (name === 'bruno.json' && d === dir)) {
        total += st.size;
        if (total > 50 * 1024 * 1024) throw new ApsError('ValidationError', 'The Bruno folder is larger than 50 MB');
        files.push({ path: relative(dir, p), text: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(dir, 0);
  return JSON.stringify(bruFilesToBrunoExport(files, existsSync(join(dir, 'bruno.json')) ? undefined : basename(dir)));
}
