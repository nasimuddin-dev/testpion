import { parse as parseYaml } from 'yaml';
import { ApsError } from '../errors.js';
import { importOpenApi } from '../import/importers.js';
import type { CollectionNode, HttpRequestSpec } from '../model/types.js';
import { deref } from '../util/json-ref.js';

/**
 * An OpenAPI 3 / Swagger 2 document as a reader sees it (the API definition's Preview, `testpion openapi-ops`, the
 * `openapi_outline` MCP tool): operations grouped by tag with their parameters, request body and responses, schemas
 * written as short type outlines, and a ready request per operation (the same one an import makes).
 */
export interface OutlineParam {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description?: string;
}

export interface OutlineResponse {
  code: string;
  description?: string;
  contentType?: string;
  schema?: string;
}

export interface OutlineOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  tag: string;
  parameters: OutlineParam[];
  requestBody?: { contentType: string; required: boolean; schema: string };
  responses: OutlineResponse[];
  security: string[];
  /** The request an import makes for it, with the server address filled in. */
  request?: HttpRequestSpec;
}

export interface ApiOutline {
  title: string;
  version?: string;
  description?: string;
  servers: string[];
  tags: Array<{ name: string; description?: string; operations: OutlineOperation[] }>;
  operations: number;
}

type Json = Record<string, any>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

export { deref };

/** The success response of an operation: its first exact 2xx code, else a `2XX`-style range. */
export function successCode(codes: string[]): string | undefined {
  return codes.find((c) => /^2\d\d$/.test(c)) ?? codes.find((c) => /^2/i.test(c));
}

const refName = (node: any) => (node && typeof node.$ref === 'string' ? String(node.$ref).split('/').pop() : undefined);

/** A short type for a parameter or a field: string (uuid), integer, Pet[], "a" | "b" … */
function typeName(doc: Json, s0: any): string {
  const name = refName(s0);
  const s = deref(doc, s0) ?? {};
  if (name && (s.type === 'object' || s.properties || s.allOf)) return name;
  if (s.enum)
    return (
      s.enum
        .slice(0, 6)
        .map((v: unknown) => JSON.stringify(v))
        .join(' | ') + (s.enum.length > 6 ? ' | …' : '')
    );
  if (s.oneOf || s.anyOf)
    return (s.oneOf ?? s.anyOf)
      .slice(0, 4)
      .map((x: any) => typeName(doc, x))
      .join(' | ');
  const t = Array.isArray(s.type) ? s.type.filter((x: string) => x !== 'null').join(' | ') : s.type;
  if (t === 'array' || s.items) return `${typeName(doc, s.items)}[]`;
  const base = t ?? (s.properties ? 'object' : 'any');
  return s.format ? `${base} (${s.format})` : base;
}

/** A schema as an indented outline: `{ id: string (uuid), name: string, owner?: Owner { … } }`. */
export function schemaOutline(doc: Json, s0: any, depth = 0, seen: string[] = []): string {
  const name = refName(s0);
  const s = deref(doc, s0) ?? {};
  const pad = '  '.repeat(depth + 1);
  if (s.allOf) {
    const merged = { type: 'object', properties: {}, required: [] as string[] } as Json;
    for (const part of s.allOf.map((x: any) => deref(doc, x))) {
      Object.assign(merged.properties, part?.properties ?? {});
      merged.required.push(...(part?.required ?? []));
    }
    return schemaOutline(doc, merged, depth, seen);
  }
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  if (t === 'array' || s.items) return `${schemaOutline(doc, s.items, depth, seen)}[]`;
  if (!(t === 'object' || s.properties) || !s.properties) return typeName(doc, s0);
  if (name && (seen.includes(name) || depth >= 3)) return name;
  const req = new Set<string>(s.required ?? []);
  const fields = Object.entries(s.properties as Json).map(([k, v]) => {
    const desc = deref(doc, v)?.description;
    return `${pad}${k}${req.has(k) ? '' : '?'}: ${schemaOutline(doc, v, depth + 1, name ? [...seen, name] : seen)}${desc ? `  // ${String(desc).split('\n')[0]!.slice(0, 80)}` : ''}`;
  });
  return `${name ? `${name} ` : ''}{\n${fields.join('\n')}\n${'  '.repeat(depth)}}`;
}

export function openApiOutline(text: string): ApiOutline {
  let doc: Json;
  try {
    doc = (text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text)) as Json;
  } catch (e) {
    throw new ApsError('ValidationError', `The OpenAPI document is not valid YAML or JSON: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger) || !doc.paths)
    throw new ApsError('ValidationError', 'Not an OpenAPI 3 or Swagger 2 document (no "openapi"/"swagger" version or no "paths")');
  const v2 = !!doc.swagger;

  // the requests an import makes, by "METHOD url", with the server address in place of {{baseUrl}}
  const requests = new Map<string, HttpRequestSpec>();
  try {
    const { collection } = importOpenApi(text);
    const base = collection.variables.find((v) => v.key === 'baseUrl')?.value ?? '';
    const walk = (nodes: CollectionNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'folder') walk(n.items);
        else if (n.kind === 'http') requests.set(`${n.request.method} ${n.request.url}`, { ...n.request, url: n.request.url.replace('{{baseUrl}}', base) });
      }
    };
    walk(collection.items);
  } catch {
    /* the outline still shows the document */
  }

  const servers = v2
    ? doc.host
      ? [`${(doc.schemes as string[] | undefined)?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}`]
      : []
    : ((doc.servers as Json[]) ?? []).map((s) => String(s?.url ?? '')).filter(Boolean);
  const declared = ((doc.tags as Json[]) ?? []).map((t) => ({ name: String(t?.name ?? ''), description: t?.description as string | undefined }));
  const byTag = new Map<string, OutlineOperation[]>();
  let count = 0;
  for (const [path, item0] of Object.entries((doc.paths as Json) ?? {})) {
    const item = deref(doc, item0) as Json;
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op || typeof op !== 'object') continue;
      count++;
      const own = ((op.parameters as unknown[]) ?? []).map((p) => deref(doc, p) as Json);
      const params = [...own, ...((item.parameters as unknown[]) ?? []).map((p) => deref(doc, p) as Json).filter((p) => !own.some((o) => o?.name === p?.name && o?.in === p?.in))].filter(
        (p) => p && p.in !== 'body',
      );
      let requestBody: OutlineOperation['requestBody'];
      if (v2) {
        const bp = ((op.parameters as unknown[]) ?? []).map((p) => deref(doc, p) as Json).find((p) => p?.in === 'body');
        if (bp) requestBody = { contentType: ((op.consumes ?? doc.consumes) as string[] | undefined)?.[0] ?? 'application/json', required: !!bp.required, schema: schemaOutline(doc, bp.schema) };
      } else if (op.requestBody) {
        const rb = deref(doc, op.requestBody) as Json;
        const ct = Object.keys(rb?.content ?? {})[0];
        if (ct) requestBody = { contentType: ct, required: !!rb.required, schema: rb.content[ct]?.schema ? schemaOutline(doc, rb.content[ct].schema) : '' };
      }
      const responses: OutlineResponse[] = Object.entries((op.responses as Json) ?? {}).map(([code, r0]) => {
        const r = deref(doc, r0) as Json;
        if (v2) return { code, description: r?.description, contentType: r?.schema ? 'application/json' : undefined, schema: r?.schema ? schemaOutline(doc, r.schema) : undefined };
        const ct = Object.keys(r?.content ?? {}).find((k) => /json/.test(k)) ?? Object.keys(r?.content ?? {})[0];
        return { code, description: r?.description, contentType: ct, schema: ct && r.content[ct]?.schema ? schemaOutline(doc, r.content[ct].schema) : undefined };
      });
      const tag = String((op.tags as string[] | undefined)?.[0] ?? 'default');
      const url = '{{baseUrl}}' + path.replace(/\{([^}]+)\}/g, '{{$1}}');
      const entry: OutlineOperation = {
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        deprecated: op.deprecated === true,
        tag,
        parameters: params.map((p) => ({
          name: String(p.name),
          in: String(p.in),
          required: p.required === true || p.in === 'path',
          type: v2 && !p.schema ? typeName(doc, p) : typeName(doc, p.schema),
          description: p.description,
        })),
        requestBody,
        responses,
        security: [...new Set(((op.security ?? doc.security ?? []) as Json[]).flatMap((s) => Object.keys(s ?? {})))],
        request: requests.get(`${method.toUpperCase()} ${url}`),
      };
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(entry);
    }
  }
  const order = [...declared.map((t) => t.name).filter((n) => byTag.has(n)), ...[...byTag.keys()].filter((n) => !declared.some((t) => t.name === n))];
  return {
    title: String(doc.info?.title ?? 'API'),
    version: doc.info?.version !== undefined ? String(doc.info.version) : undefined,
    description: doc.info?.description,
    servers,
    tags: order.map((name) => ({ name, description: declared.find((t) => t.name === name)?.description, operations: byTag.get(name)! })),
    operations: count,
  };
}
