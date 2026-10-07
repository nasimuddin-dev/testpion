import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { Collection, HttpRequestSpec } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { loadOpenApi } from './contract.js';
import { fuzzCases, type FuzzCase } from './fuzz.js';
import { collectionToOpenApiText } from './from-collection.js';
import { deref, openApiOutline, type OutlineOperation } from './outline.js';
import type { GeneratedTestFile } from './tests-from-spec.js';

/**
 * An integration suite from an API definition (`testpion integration-suite`, the Preview tab's Generate ▸ Integration
 * flows, `generate_flows` for agents): one flow per resource the API creates, each step depending on the one before —
 * create it, read it back, update it, see it listed, delete it, see it gone — with the created id flowing between steps
 * (`extract` → `{{variable}}`) and the clean-up at the end, so the flow leaves nothing behind and runs again. A login
 * operation becomes the first step, saving `{{accessToken}}` for the rest. A collection goes through the OpenAPI
 * document made from it (saved examples included), so the same generator serves both.
 */

type Json = Record<string, any>;

/** A resource the API creates: its collection path (POST) and, when it has one, its item path (GET / PUT / DELETE). */
interface Resource {
  name: string;
  path: string;
  itemPath?: string;
  /** The item path's last parameter (`id` in `/patients/{id}`). */
  itemParam?: string;
  create: OutlineOperation;
  read?: OutlineOperation;
  update?: OutlineOperation;
  list?: OutlineOperation;
  remove?: OutlineOperation;
}

const LOGIN_PATH = /(auth|login|signin|sign-in|token|session)/i;
const TOKEN_FIELD = /^(access_?token|id_?token|token|jwt|bearer)$/i;
/** Login body fields and the environment variables they come from. */
const LOGIN_VALUES: Array<[RegExp, string]> = [
  [/^client_?id$/i, '{{clientId}}'],
  [/^client_?secret$/i, '{{clientSecret}}'],
  [/^(user_?name|user|login)$/i, '{{username}}'],
  [/^(pass(word)?|pwd)$/i, '{{password}}'],
  [/^e-?mail$/i, '{{email}}'],
  [/^api_?key$/i, '{{apiKey}}'],
];

const singular = (s: string) => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('ses') || s.endsWith('xes') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s);
const success = (op: OutlineOperation) => op.responses.map((r) => r.code).find((c) => /^2\d\d$/.test(c));
const statusOf = (op: OutlineOperation, fallback: number | string) => {
  const s = success(op);
  return s ? Number(s) : fallback;
};

/** The resources of a document: every path with a POST whose sibling `<path>/{param}` holds the item operations. */
function resourcesOf(ops: OutlineOperation[]): Resource[] {
  const byPath = new Map<string, OutlineOperation[]>();
  for (const op of ops) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);
  const find = (path: string, method: string) => byPath.get(path)?.find((o) => o.method.toUpperCase() === method);
  const out: Resource[] = [];
  for (const [path, list] of byPath) {
    if (/\{[^}]+\}$/.test(path)) continue; // an item path, not a collection
    const create = list.find((o) => o.method.toUpperCase() === 'POST');
    if (!create || LOGIN_PATH.test(path.split('/').pop() ?? '')) continue;
    // the item path: the same path plus one parameter; a POST without one is an action (/user/createWithList), not a resource.
    // A collection's request often names one record (/patients/1, /patients/3f2a…): that is the item path, its id the parameter.
    let itemPath = [...byPath.keys()].find((p) => p.startsWith(`${path}/{`) && /^\{[^}]+\}$/.test(p.slice(path.length + 1)));
    let literal: string | undefined;
    if (!itemPath) {
      literal = [...byPath.keys()].find((p) => p.startsWith(`${path}/`) && /^(\d+|[0-9a-f-]{8,}|[\w-]*\d[\w-]*)$/i.test(p.slice(path.length + 1)));
      if (literal) itemPath = `${path}/{id}`;
    }
    if (!itemPath) continue;
    const itemParam = itemPath.slice(path.length + 2, -1);
    const itemOps = literal ?? itemPath;
    const name =
      slugify(
        singular(
          path
            .split('/')
            .filter((s) => s && !s.startsWith('{'))
            .pop() ?? 'item',
        ),
      ) || 'item';
    out.push({
      name,
      path,
      itemPath,
      itemParam,
      create,
      read: find(itemOps, 'GET'),
      update: find(itemOps, 'PUT') ?? find(itemOps, 'PATCH'),
      list: find(path, 'GET'),
      remove: find(itemOps, 'DELETE'),
    });
  }
  return out;
}

/** The success response's JSON schema of an operation, dereferenced (undefined when it has none). */
function responseSchema(doc: Json, op: OutlineOperation): Json | undefined {
  const node = deref(doc, (doc.paths as Json)?.[op.path])?.[op.method.toLowerCase()];
  const code = success(op);
  const res = code ? deref(doc, node?.responses?.[code]) : undefined;
  if (!res) return undefined;
  if (res.schema) return deref(doc, res.schema); // Swagger 2
  const content = (res.content ?? {}) as Json;
  const media = content['application/json'] ?? Object.values(content)[0];
  return media?.schema ? deref(doc, media.schema) : undefined;
}

/**
 * The field of a created record that the item path takes: the path parameter when the record has it (`username` in
 * /user/{username}), else `id`, else the first `…Id` field.
 */
function idFieldOf(schema: Json | undefined, itemParam: string | undefined): string {
  const props = Object.keys((schema?.properties as Json) ?? {});
  if (itemParam && props.includes(itemParam)) return itemParam;
  if (props.includes('id')) return 'id';
  return props.find((p) => /(^|_)id$/i.test(p)) ?? 'id';
}

/** An item URL from the path template: the last parameter is the created id, earlier ones are variables to set. */
function itemUrl(path: string, idVar: string, lastParam: string): string {
  return `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, (_, p: string) => (p === lastParam ? `{{${idVar}}}` : `{{${p}}}`))}`;
}

/** The request's body as the test file writes it; names and e-mails get a random part so a flow can run again. */
function bodyOf(req: HttpRequestSpec, unique: boolean): Record<string, unknown> {
  const b = req.body;
  if (!b || b.type === 'none') return {};
  if (b.type === 'json') {
    try {
      const v = JSON.parse(b.content) as unknown;
      if (unique && v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Json;
        const key = Object.keys(o).find((k) => /^(name|title|label|subject|username|e-?mail)$/i.test(k) && typeof o[k] === 'string');
        if (key) o[key] = /mail/i.test(key) ? `{{$randomInt}}-${o[key]}` : `${o[key]} {{$randomInt}}`;
      }
      return { body: v };
    } catch {
      return { body: { type: 'json', content: b.content } };
    }
  }
  return { body: b };
}

/** The login step: the operation's body fields mapped to environment variables, the token saved as `accessToken`. */
function loginStep(doc: Json, op: OutlineOperation, valid: FuzzCase | undefined): { step: Record<string, unknown>; variables: string[]; assumed?: string } | undefined {
  const node = deref(doc, (doc.paths as Json)?.[op.path])?.[op.method.toLowerCase()];
  const schema = responseSchema(doc, op);
  const documented = Object.keys((schema?.properties as Json) ?? {}).find((k) => TOKEN_FIELD.test(k));
  // a login operation whose answer is not documented (a collection without a saved example): the usual field, said so
  const tokenField = documented ?? (schema ? undefined : 'access_token');
  if (!tokenField) return undefined;
  const body = deref(doc, node?.requestBody);
  const content = (body?.content ?? {}) as Json;
  const [contentType, media] = Object.entries(content)[0] ?? [];
  const reqSchema = media ? deref(doc, (media as Json).schema) : undefined;
  const all = Object.keys((reqSchema?.properties as Json) ?? {});
  // client credentials when the API takes them (CI has no person to type a password); the other grant's fields are left out
  const clientCredentials = all.some((p) => /^client_?id$/i.test(p));
  const props = all.filter((p) => (clientCredentials ? !/^(user_?name|user|login|pass(word)?|pwd)$/i.test(p) : true));
  const variables: string[] = [];
  const valueOf = (field: string): string => {
    if (/^grant_?type$/i.test(field)) return clientCredentials ? 'client_credentials' : 'password';
    const known = LOGIN_VALUES.find(([re]) => re.test(field));
    if (known) {
      variables.push(known[1].slice(2, -2));
      return known[1];
    }
    variables.push(field);
    return `{{${field}}}`;
  };
  const fields = props.map((p) => [p, valueOf(p)] as const);
  const step: Record<string, unknown> = {
    id: 'auth-token',
    name: op.summary ?? 'Obtain an access token',
    method: op.method.toUpperCase(),
    url: `{{baseUrl}}${op.path}`,
    ...(fields.length
      ? /form/i.test(contentType ?? '')
        ? { body: { type: 'form-urlencoded', fields: fields.map(([key, value]) => ({ key, value })) } }
        : { body: Object.fromEntries(fields) }
      : bodyOf(valid?.request ?? ({} as HttpRequestSpec), false)),
    extract: { accessToken: `$.${tokenField}` },
    assertions: [
      { type: 'status', expected: statusOf(op, 200) },
      { type: 'exists', path: `$.${tokenField}` },
    ],
  };
  return { step, variables: [...new Set(variables)], ...(documented ? {} : { assumed: tokenField }) };
}

/** The flows of a document, as test files, and the variables a person must set before running them. */
export function flowsFromSpec(text: string, opts: { specPath?: string; title?: string } = {}): { files: GeneratedTestFile[]; variables: string[]; resources: string[] } {
  const doc = loadOpenApi(text) as Json;
  const outline = openApiOutline(text);
  const ops = outline.tags.flatMap((t) => t.operations);
  const { cases } = fuzzCases(text, { baseUrl: '{{baseUrl}}', includeDelete: true, maxPerOperation: 60 });
  const validOf = (op: OutlineOperation) => cases.find((c) => c.operation === `${op.method.toUpperCase()} ${op.path}` && c.mutation === 'valid');
  const api = slugify(opts.specPath?.replace(/^specs\//, '').replace(/\.(openapi|swagger)?\.?(ya?ml|json)$/i, '') || opts.title || outline.title) || 'api';
  const files: GeneratedTestFile[] = [];
  const variables = new Set<string>(['baseUrl']);
  const contract = opts.specPath ? [{ type: 'openapi', spec: opts.specPath }] : [];

  // the login operation (a POST under /auth, /login, /token … whose answer holds a token) becomes the first step
  const loginOp = ops.find((o) => o.method.toUpperCase() === 'POST' && LOGIN_PATH.test(o.path));
  const login = loginOp ? loginStep(doc, loginOp, validOf(loginOp)) : undefined;
  const needsAuth = ops.some((o) => o.security.length);
  if (login) {
    for (const v of login.variables) variables.add(v);
    files.push({
      path: `tests/${api}/flows/auth.yaml`,
      yaml:
        `# Generated from ${opts.specPath ?? outline.title} by TestPion: the access token the flows depend on, from the environment's ${login.variables.map((v) => `{{${v}}}`).join(', ') || 'credentials'}.\n` +
        (login.assumed ? `# The answer is not documented: the token is assumed to be in $.${login.assumed}; change the extract and the check if the API names it differently.\n` : '') +
        stringify({ type: 'http', ...login.step }, { lineWidth: 0 }),
      tests: 1,
    });
  } else if (needsAuth) variables.add('accessToken');

  const resources = resourcesOf(ops);
  for (const r of resources) {
    const valid = validOf(r.create);
    if (!valid) continue;
    const idField = idFieldOf(responseSchema(doc, r.create), r.itemParam);
    // the variable the id travels in: patientId, userUsername
    const camel = (s: string) => s.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const idVar = camel(r.name) + camel(idField).replace(/^./, (c) => c.toUpperCase());
    const auth = valid.request.auth && valid.request.auth.type !== 'inherit' && valid.request.auth.type !== 'none' ? { auth: valid.request.auth } : {};
    for (const m of (r.itemPath ?? '').matchAll(/\{([^}]+)\}/g)) if (m[1] !== r.itemParam) variables.add(m[1]!);
    const steps: Array<Record<string, unknown>> = [];
    const step = (id: string, name: string, op: OutlineOperation, url: string, extra: Record<string, unknown>, dependsOn?: string | string[]) =>
      steps.push({ id: `${r.name}-${id}`, name, ...(dependsOn ? { dependsOn } : {}), method: op.method.toUpperCase(), url, ...auth, ...extra });

    step('create', `Create a ${r.name}`, r.create, `{{baseUrl}}${r.path}`, {
      ...bodyOf(valid.request, true),
      extract: { [idVar]: `$.${idField}` },
      assertions: [{ type: 'status', expected: statusOf(r.create, '2xx') }, ...contract, { type: 'exists', path: `$.${idField}` }],
    });
    const after: string[] = [`${r.name}-create`];
    if (r.read && r.itemPath && r.itemParam) {
      step(
        'read',
        `Read it back`,
        r.read,
        itemUrl(r.itemPath, idVar, r.itemParam),
        { assertions: [{ type: 'status', expected: statusOf(r.read, 200) }, ...contract, { type: 'equals', path: `$.${idField}`, expected: `{{${idVar}}}` }] },
        `${r.name}-create`,
      );
      after.push(`${r.name}-read`);
    }
    if (r.update && r.itemPath && r.itemParam) {
      const u = validOf(r.update);
      step(
        'update',
        `Update it`,
        r.update,
        itemUrl(r.itemPath, idVar, r.itemParam),
        { ...(u ? bodyOf(u.request, false) : {}), assertions: [{ type: 'status', expected: statusOf(r.update, '2xx') }, ...contract] },
        after[after.length - 1],
      );
      after.push(`${r.name}-update`);
    }
    if (r.list) {
      step(
        'listed',
        `It is in the list`,
        r.list,
        `{{baseUrl}}${r.path}`,
        {
          assertions: [
            { type: 'status', expected: statusOf(r.list, 200) },
            { type: 'contains', expected: `{{${idVar}}}` },
          ],
        },
        `${r.name}-create`,
      );
      after.push(`${r.name}-listed`);
    }
    if (r.remove && r.itemPath && r.itemParam) {
      step('delete', `Delete it (clean-up)`, r.remove, itemUrl(r.itemPath, idVar, r.itemParam), { assertions: [{ type: 'status', expected: statusOf(r.remove, '2xx') }] }, after);
      if (r.read) step('gone', `It is gone afterwards`, r.read, itemUrl(r.itemPath, idVar, r.itemParam), { assertions: [{ type: 'status', expected: 404 }] }, `${r.name}-delete`);
    }
    const head =
      `# Generated from ${opts.specPath ?? outline.title} by TestPion: the life of one ${r.name} through the API, each step depending on the one before.\n` +
      `# Review the example values (bodies, ids), then: testpion run --suite ${api}-integration\n` +
      (r.remove ? '' : `# The API documents no DELETE for ${r.path}: the records this flow creates stay; add a clean-up step when there is a way.\n`);
    files.push({
      path: `tests/${api}/flows/${r.name}.yaml`,
      yaml: head + stringify({ defaults: { type: 'http', ...(login ? { dependsOn: 'auth-token' } : {}) }, tests: steps }, { lineWidth: 0, aliasDuplicateObjects: false }),
      tests: steps.length,
    });
  }
  if (files.some((f) => f.path.includes('/flows/') && !f.path.endsWith('/auth.yaml')))
    files.push({
      path: `tests/${api}-integration.suite.yaml`,
      yaml: stringify(
        {
          name: `${outline.title} integration`,
          description: `Generated from ${opts.specPath ?? 'the API definition'}: one flow per resource (create, read, update, list, delete), the login first.`,
          tests: [`${api}/flows`],
        },
        { lineWidth: 0 },
      ),
      tests: files.reduce((n, f) => n + f.tests, 0),
    });
  return { files, variables: [...variables], resources: resources.map((r) => r.name) };
}

/** The flows of a collection: through the OpenAPI document made from it (its saved examples say what answers look like). */
export function flowsFromCollection(collection: Collection): ReturnType<typeof flowsFromSpec> {
  return flowsFromSpec(collectionToOpenApiText(collection, { format: 'yaml', serverUrl: '{{baseUrl}}' }), { title: collection.name });
}

export interface WrittenFlows {
  written: GeneratedTestFile[];
  skipped: string[];
  /** Environment variables the flows read (baseUrl, credentials, parent ids). */
  variables: string[];
  resources: string[];
}

/** Write the flows of a definition in specs/ (or of a collection) into the workspace; files that exist are kept unless `overwrite`. */
export function writeFlows(store: Pick<WorkspaceStore, 'safePath'>, source: { spec: string } | { collection: Collection }, opts: { overwrite?: boolean } = {}): WrittenFlows {
  const r = 'spec' in source ? flowsFromSpec(readFileSync(store.safePath(source.spec), 'utf8'), { specPath: source.spec }) : flowsFromCollection(source.collection);
  const written: GeneratedTestFile[] = [];
  const skipped: string[] = [];
  for (const f of r.files) {
    const file = store.safePath(f.path);
    if (existsSync(file) && !opts.overwrite) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.yaml);
    written.push(f);
  }
  return { written, skipped, variables: r.variables, resources: r.resources };
}
