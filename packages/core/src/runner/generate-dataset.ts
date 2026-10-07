import { randomInt, randomUUID } from 'node:crypto';
import { ApsError } from '../errors.js';
import { dynamicValue } from '../vars/dynamic.js';

/**
 * Test data for data-driven runs (`testpion datasets generate`, the Datasets view's Generate, `generate_dataset`):
 * rows made from a JSON schema (an OpenAPI request body's, or one written by hand), each field filled by what its
 * name and schema say it is: an email, a first name, a city, a price, a date, a UUID, a value of its enum, a number in
 * its range, text within its length. Saved as CSV or JSON in the workspace's datasets/ folder.
 */
type Json = Record<string, any>;

export type DatasetRow = Record<string, unknown>;

/** Field name patterns → the dynamic variable that fits them (the same values as {{$randomEmail}} …). */
const BY_NAME: Array<[RegExp, string]> = [
  [/e-?mail/i, '$randomEmail'],
  [/^(first_?name|given_?name|forename)$/i, '$randomFirstName'],
  [/^(last_?name|family_?name|surname)$/i, '$randomLastName'],
  [/^(full_?name|owner_?name|customer_?name|contact_?name|user_?name_?full)$/i, '$randomFullName'],
  [/^(user_?name|login|handle|nickname)$/i, '$randomUserName'],
  [/phone|mobile|tel/i, '$randomPhoneNumber'],
  [/^city|town$/i, '$randomCity'],
  [/^country_?code$/i, '$randomCountryCode'],
  [/^country$/i, '$randomCountry'],
  [/street|address/i, '$randomStreetAddress'],
  [/company|organi[sz]ation|employer/i, '$randomCompanyName'],
  [/job|title|position/i, '$randomJobTitle'],
  [/department/i, '$randomDepartment'],
  [/product/i, '$randomProductName'],
  [/price|amount|cost|total|fee/i, '$randomPrice'],
  [/currency/i, '$randomCurrencyCode'],
  [/^(url|website|homepage|link)$/i, '$randomUrl'],
  [/avatar|image|photo|picture/i, '$randomImageUrl'],
  [/domain/i, '$randomDomainName'],
  [/^ip(_?address)?$/i, '$randomIP'],
  [/user_?agent/i, '$randomUserAgent'],
  [/locale|language/i, '$randomLocale'],
  [/color|colour/i, '$randomColor'],
  [/^lat(itude)?$/i, '$randomLatitude'],
  [/^(lng|lon|longitude)$/i, '$randomLongitude'],
  [/description|notes?|comment|summary|bio|message/i, '$randomLoremSentence'],
  [/slug/i, '$randomLoremSlug'],
  [/password|secret/i, '$randomPassword'],
  [/file_?name/i, '$randomFileName'],
  [/mime|content_?type/i, '$randomMimeType'],
  [/version/i, '$randomSemver'],
];

const ISO_DATE = (d: Date) => d.toISOString();

function deref(doc: Json | undefined, node: any, seen = 0): any {
  if (!doc || !node || typeof node !== 'object' || typeof node.$ref !== 'string' || seen > 20) return node;
  if (!node.$ref.startsWith('#/')) return {};
  let cur: any = doc;
  for (const p of node.$ref.slice(2).split('/')) cur = cur?.[decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~'))];
  return deref(doc, cur, seen + 1);
}

const typeOf = (s: any): string | undefined => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : (s?.type ?? (s?.properties ? 'object' : s?.items ? 'array' : undefined)));

/** One value for a field: its enum, its format, what its name says, or its type within its limits. */
export function generateValue(name: string, s0: unknown, doc?: Json, depth = 0, row = 0): unknown {
  const s = deref(doc, s0) ?? {};
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[randomInt(0, s.enum.length)];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: unknown) => generateValue(name, x, doc, depth + 1, row)));
  if (s.oneOf || s.anyOf) {
    const list = (s.oneOf ?? s.anyOf) as unknown[];
    return generateValue(name, list[randomInt(0, list.length)], doc, depth + 1, row);
  }
  const t = typeOf(s);
  if (t === 'object') {
    if (depth > 4) return {};
    return Object.fromEntries(Object.entries((s.properties as Json) ?? {}).map(([k, v]) => [k, generateValue(k, v, doc, depth + 1, row)]));
  }
  if (t === 'array') {
    if (depth > 4) return [];
    const n = Math.max(s.minItems ?? 1, Math.min(s.maxItems ?? 3, 3));
    return Array.from({ length: n }, () => generateValue(name.replace(/s$/, ''), s.items, doc, depth + 1, row));
  }
  if (t === 'integer' || t === 'number') {
    const min = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : /age/i.test(name) ? 1 : /id$/i.test(name) ? 1 : 0);
    const max =
      s.maximum ?? (s.exclusiveMaximum !== undefined ? s.exclusiveMaximum - 1 : /age/i.test(name) ? 20 : /^id$/i.test(name) ? 100_000 : /price|amount|cost|total|weight/i.test(name) ? 500 : 1000);
    if (/^id$/i.test(name) && s.minimum === undefined) return row + 1;
    if (t === 'integer') return randomInt(Math.ceil(min), Math.floor(max) + 1);
    return Math.round((min + Math.random() * (max - min)) * 100) / 100;
  }
  if (t === 'boolean') return randomInt(0, 2) === 1;
  // strings: the format first, then the name, then text within the length
  switch (s.format) {
    case 'email':
      return dynamicValue('$randomEmail');
    case 'uuid':
      return randomUUID();
    case 'date-time':
      return ISO_DATE(new Date(Date.now() - randomInt(0, 365) * 86_400_000));
    case 'date':
      return ISO_DATE(new Date(Date.now() - randomInt(0, 3650) * 86_400_000)).slice(0, 10);
    case 'uri':
    case 'url':
      return dynamicValue('$randomUrl');
    case 'ipv4':
      return dynamicValue('$randomIP');
    case 'ipv6':
      return dynamicValue('$randomIPV6');
    case 'hostname':
      return dynamicValue('$randomDomainName');
  }
  if (/(_|^)id$|Id$/.test(name) && !s.maxLength) return randomUUID();
  if (/date|_at$|At$|time/i.test(name)) return ISO_DATE(new Date(Date.now() - randomInt(0, 365) * 86_400_000));
  let v: unknown = BY_NAME.find(([re]) => re.test(name))?.[1];
  v = v ? dynamicValue(v as string) : /name/i.test(name) ? dynamicValue('$randomFullName') : dynamicValue('$randomWords');
  let str = String(v);
  if (typeof s.maxLength === 'number' && str.length > s.maxLength) str = str.slice(0, s.maxLength);
  if (typeof s.minLength === 'number' && str.length < s.minLength) str = str.padEnd(s.minLength, 'x');
  return str;
}

/** `count` rows of an object schema (its top-level fields are the columns). */
export function generateRows(schema: unknown, count: number, opts: { doc?: Json } = {}): DatasetRow[] {
  const s = deref(opts.doc, schema);
  if (!s || typeof s !== 'object') throw new ApsError('ValidationError', 'The schema is not a JSON schema');
  if (typeOf(s) !== 'object' && !s.allOf)
    throw new ApsError('ValidationError', 'A dataset needs an object schema: its fields become the columns', {
      suggestions: ['Give { type: object, properties: { … } }, or a request body that is an object.'],
    });
  const n = Math.max(1, Math.min(count, 100_000));
  return Array.from({ length: n }, (_v, i) => generateValue('', s, opts.doc, 0, i) as DatasetRow);
}

/** Rows as CSV: nested values as JSON, quoted where needed. */
export function rowsToCsv(rows: DatasetRow[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

/** The JSON schema of an operation's request body in an OpenAPI document ("POST /patients" or an operationId). */
export function operationBodySchema(doc: Json, operation: string): unknown {
  const [m, ...rest] = operation.trim().split(/\s+/);
  for (const [path, item] of Object.entries((doc.paths as Json) ?? {})) {
    for (const [method, op] of Object.entries((deref(doc, item) as Json) ?? {})) {
      if (!op || typeof op !== 'object') continue;
      const hit = (op as Json).operationId === operation || (rest.length && method.toLowerCase() === m!.toLowerCase() && path === rest.join(' '));
      if (!hit) continue;
      const rb = deref(doc, (op as Json).requestBody) as Json | undefined;
      const ct = Object.keys(rb?.content ?? {}).find((k) => /json/.test(k));
      const body = ct ? rb!.content[ct].schema : ((op as Json).parameters as Json[] | undefined)?.map((p) => deref(doc, p)).find((p) => p?.in === 'body')?.schema;
      if (!body) throw new ApsError('ValidationError', `${operation} has no JSON request body`);
      return body;
    }
  }
  throw new ApsError('ValidationError', `No operation "${operation}" in the document`, { suggestions: ['Write it as METHOD /path (POST /patients) or give the operationId.'] });
}
