import { nodeRequire } from '../util/lazy-require.js';

// the XML parser loads with the first WSDL import (see util/lazy-require.ts)
let fxp: typeof import('fast-xml-parser') | undefined;
const xmlParser = (): typeof import('fast-xml-parser') => (fxp ??= typeof require === 'function' ? require('fast-xml-parser') : nodeRequire('fast-xml-parser'));
import { ApsError } from '../errors.js';
import type { Collection, CollectionFolder, KeyValue, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';

/**
 * WSDL 1.1 and 2.0 → a collection of SOAP requests, like Postman's WSDL import: a folder per SOAP port
 * or endpoint (SOAP 1.1 and 1.2), a POST per operation with its SOAP action and a sample envelope built
 * from the XML Schema in <types> (imported schemas when bundled with bundleWsdl).
 */

type X = Record<string, any>;

const SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const WSDL2 = 'http://www.w3.org/ns/wsdl';
const WSOAP = 'http://www.w3.org/ns/wsdl/soap';
const ENVELOPE = { 11: 'http://schemas.xmlsoap.org/soap/envelope/', 12: 'http://www.w3.org/2003/05/soap-envelope' } as const;

export function isWsdl(text: string): boolean {
  const head = text.slice(0, 4000);
  if (/^\s*<testpion-wsdl-bundle>/.test(head)) return true;
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<([\w-]+:)?definitions[\s>]/.test(head) && /schemas\.xmlsoap\.org\/wsdl\//.test(head)) return true;
  // WSDL 2.0
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<([\w-]+:)?description[\s>]/.test(head) && head.includes(WSDL2);
}

const IMPORT_RE = /<(?:[\w-]+:)?(?:import|include)\b[^>]*?\b(?:schemaLocation|location)\s*=\s*["']([^"']+)["']/g;
const stripDecl = (t: string) => t.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>/gi, '');

/**
 * A WSDL together with the documents it imports (xsd:import / xsd:include schemaLocation and
 * wsdl:import location, followed recursively, at most `limit` files), as one text that importWsdl
 * reads. `load` fetches or reads a location (already resolved against the importing document) and
 * may refuse it (e.g. another origin); refused or failing imports are skipped.
 */
export async function bundleWsdl(text: string, base: string, load: (location: string) => Promise<string | undefined>, limit = 30): Promise<string> {
  const isUrl = /^https?:\/\//i.test(base);
  const resolveLoc = async (from: string, loc: string) => {
    if (isUrl) return new URL(loc, from).toString();
    const { dirname, resolve } = await import('node:path');
    return resolve(dirname(from), loc);
  };
  const seen = new Set([base]);
  const docs: string[] = [];
  const queue: Array<{ text: string; base: string }> = [{ text, base }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const m of cur.text.matchAll(IMPORT_RE)) {
      if (seen.size > limit) break;
      const loc = await resolveLoc(cur.base, m[1]!);
      if (seen.has(loc)) continue;
      seen.add(loc);
      const t = await load(loc).catch(() => undefined);
      if (!t) continue;
      docs.push(stripDecl(t));
      queue.push({ text: t, base: loc });
    }
  }
  return docs.length ? `<testpion-wsdl-bundle>\n${[stripDecl(text), ...docs].join('\n')}\n</testpion-wsdl-bundle>` : text;
}

const local = (q: unknown) => String(q ?? '').split(':').pop()!;

export function importWsdl(text: string): { collection: Collection } {
  let doc: X;
  try {
    doc = new (xmlParser().XMLParser)({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, parseAttributeValue: false, trimValues: true, isArray: (_n, _p, _leaf, isAttr) => !isAttr }).parse(text) as X;
  } catch (e) {
    throw new ApsError('ValidationError', `The WSDL is not valid XML: ${(e as Error).message}`);
  }
  // prefix → namespace, from every xmlns declaration in the document
  const prefixes = new Map<string, string>();
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as X)) {
      if (k === '@xmlns') prefixes.set('', String(v));
      else if (k.startsWith('@xmlns:')) prefixes.set(k.slice(7), String(v));
      else if (!k.startsWith('@')) walk(v);
    }
  };
  walk(doc);
  const nsOf = (tag: string) => prefixes.get(tag.includes(':') ? tag.split(':')[0]! : '');
  const kids = (n: X | undefined, name: string, ns?: string): X[] =>
    n ? Object.entries(n).filter(([k]) => !k.startsWith('@') && k !== '#text' && local(k) === name && (!ns || nsOf(k) === ns)).flatMap(([, v]) => (Array.isArray(v) ? v : [v])) : [];
  const docOf = (n: X | undefined) => {
    const d = kids(n, 'documentation')[0];
    const t = typeof d === 'string' ? d : d?.['#text'];
    return t ? String(t).trim() : undefined;
  };

  // a bundle (bundleWsdl): the WSDL first, then the WSDLs and schemas it imports
  const bundle = kids(doc, 'testpion-wsdl-bundle')[0];
  const defs1 = bundle ? kids(bundle, 'definitions') : kids(doc, 'definitions');
  // WSDL 2.0: <description> with interface / binding / service-endpoint
  const wsdl2 = !defs1.length;
  const defs = wsdl2 ? (bundle ? kids(bundle, 'description') : kids(doc, 'description')) : defs1;
  const all = (name: string) => defs.flatMap((d) => kids(d, name));
  const root = defs[0];
  if (!root) throw new ApsError('ValidationError', 'Not a WSDL document (no <definitions> or <description>)');
  const targetNs = String(root['@targetNamespace'] ?? '');

  // XML Schema: elements, complex and simple types by name (with their schema, for the namespace)
  const schemas = [...all('types').flatMap((t) => kids(t, 'schema')), ...(bundle ? kids(bundle, 'schema') : [])];
  const elements = new Map<string, { node: X; schema: X }>();
  const complexTypes = new Map<string, { node: X; schema: X }>();
  const simpleTypes = new Map<string, X>();
  for (const s of schemas) {
    for (const e of kids(s, 'element')) elements.set(String(e['@name']), { node: e, schema: s });
    for (const c of kids(s, 'complexType')) complexTypes.set(String(c['@name']), { node: c, schema: s });
    for (const t of kids(s, 'simpleType')) simpleTypes.set(String(t['@name']), t);
  }
  const nsPrefix = new Map<string, string>();
  const prefixFor = (ns: string) => {
    if (!nsPrefix.has(ns)) nsPrefix.set(ns, nsPrefix.size === 0 ? 'tns' : `ns${nsPrefix.size}`);
    return nsPrefix.get(ns)!;
  };

  const placeholder = (type: string): string => {
    const t = local(type);
    const simple = simpleTypes.get(t);
    if (simple) {
      const r = kids(simple, 'restriction')[0];
      const first = kids(r, 'enumeration')[0];
      return first ? String(first['@value']) : placeholder(String(r?.['@base'] ?? 'string'));
    }
    if (/^(int|integer|long|short|byte|decimal|double|float|unsignedInt|unsignedLong|unsignedShort|unsignedByte|positiveInteger|nonNegativeInteger|negativeInteger|nonPositiveInteger)$/.test(t)) return '0';
    if (t === 'boolean') return 'false';
    if (t === 'dateTime') return '2024-01-01T00:00:00';
    if (t === 'date') return '2024-01-01';
    if (t === 'time') return '00:00:00';
    return '?';
  };

  /** Child elements of a complex type, as XML lines. */
  const complexBody = (ct: X, schema: X, indent: string, depth: number, seen: Set<string>): string[] => {
    const out: string[] = [];
    const ext = kids(kids(ct, 'complexContent')[0], 'extension')[0] ?? kids(kids(ct, 'complexContent')[0], 'restriction')[0];
    if (ext) {
      const base = complexTypes.get(local(ext['@base']));
      if (base && !seen.has(local(ext['@base']))) out.push(...complexBody(base.node, base.schema, indent, depth, new Set([...seen, local(ext['@base'])])));
      out.push(...complexBody(ext, schema, indent, depth, seen));
      return out;
    }
    const simpleContent = kids(ct, 'simpleContent')[0];
    if (simpleContent) return out;
    for (const group of [...kids(ct, 'sequence'), ...kids(ct, 'all'), ...kids(ct, 'choice')]) {
      const isChoice = kids(ct, 'choice').includes(group);
      const items = kids(group, 'element');
      for (const e of isChoice ? items.slice(0, 1) : items) out.push(...elementXml(e, schema, indent, depth, seen, false));
      for (const inner of [...kids(group, 'sequence'), ...kids(group, 'choice')]) out.push(...complexBody({ sequence: [inner] }, schema, indent, depth, seen));
    }
    return out;
  };

  /** An element (from a schema) as XML lines with sample content. */
  const elementXml = (e: X, schema: X, indent: string, depth: number, seen: Set<string>, topLevel: boolean): string[] => {
    if (e['@ref']) {
      const r = elements.get(local(e['@ref']));
      return r ? elementXml(r.node, r.schema, indent, depth, seen, true) : [];
    }
    const name = String(e['@name'] ?? 'element');
    const qualified = topLevel || schema['@elementFormDefault'] === 'qualified';
    const tag = qualified ? `${prefixFor(String(schema['@targetNamespace'] ?? targetNs))}:${name}` : name;
    const inline = kids(e, 'complexType')[0];
    const typeName = e['@type'] ? local(e['@type']) : undefined;
    const ct = inline ? { node: inline, schema } : typeName ? complexTypes.get(typeName) : undefined;
    if (!ct) {
      const simpleInline = kids(e, 'simpleType')[0];
      const value = simpleInline ? placeholder(String(kids(simpleInline, 'restriction')[0]?.['@base'] ?? 'string')) : placeholder(String(e['@type'] ?? 'string'));
      return [`${indent}<${tag}>${value}</${tag}>`];
    }
    const key = typeName ?? `${name}#inline`;
    if (depth > 8 || seen.has(key)) return [`${indent}<${tag}/>`];
    const body = complexBody(ct.node, ct.schema, `${indent}  `, depth + 1, new Set([...seen, key]));
    return body.length ? [`${indent}<${tag}>`, ...body, `${indent}</${tag}>`] : [`${indent}<${tag}/>`];
  };

  /** A POST with the SOAP envelope (namespaces used by the body declared on it) and the version's headers. */
  const soapRequest = (name: string, version: 11 | 12, action: string, body: string[], urlVar: string, description?: string): SavedHttpRequest => {
    const decls = [...nsPrefix.entries()].map(([ns, p]) => ` xmlns:${p}="${ns}"`).join('');
    const envelope = [`<soap:Envelope xmlns:soap="${ENVELOPE[version]}"${decls}>`, '  <soap:Header/>', '  <soap:Body>', ...body, '  </soap:Body>', '</soap:Envelope>'].join('\n');
    const headers: KeyValue[] =
      version === 12
        ? [{ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`, enabled: true }]
        : [
            { key: 'Content-Type', value: 'text/xml; charset=utf-8', enabled: true },
            { key: 'SOAPAction', value: `"${action}"`, enabled: true },
          ];
    return {
      kind: 'http',
      id: shortId('req-'),
      name,
      ...(description ? { description } : {}),
      request: { method: 'POST', url: `{{${urlVar}}}`, params: [], headers, body: { type: 'xml', content: envelope }, auth: { type: 'inherit' } },
      assertions: [{ type: 'status', expected: 200 }],
    } as SavedHttpRequest;
  };

  const items: CollectionFolder[] = [];
  const variables: KeyValue[] = [];
  const baseUrls = new Map<string, string>();
  /** {{baseUrl}} for the first address, a variable named after the port / endpoint for others. */
  const urlVarFor = (address: string, portName: string) => {
    let v = [...baseUrls.entries()].find(([, a]) => a === address)?.[0];
    if (!v) {
      v = baseUrls.size === 0 ? 'baseUrl' : `${slugify(portName).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Url`;
      baseUrls.set(v, address);
      variables.push({ key: v, value: address, enabled: true });
    }
    return v;
  };
  /** An attribute by local name in a namespace (e.g. wsoap:version), whatever its prefix. */
  const attrNs = (n: X | undefined, name: string, ns?: string) =>
    Object.entries(n ?? {}).find(([k]) => k.startsWith('@') && local(k.slice(1)) === name && (!ns || nsOf(k.slice(1)) === ns))?.[1] as string | undefined;

  if (wsdl2) {
    // interface operations (with inherited ones): input element, document/literal; #any and #none give an empty body
    const interfaces = new Map(all('interface').map((i) => [String(i['@name']), i]));
    const opsOf = (iface: X | undefined, seen = new Set<string>()): X[] => {
      if (!iface || seen.has(String(iface['@name']))) return [];
      seen.add(String(iface['@name']));
      const inherited = String(iface['@extends'] ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((e) => opsOf(interfaces.get(local(e)), seen));
      return [...inherited, ...kids(iface, 'operation')];
    };
    for (const service of all('service')) {
      for (const endpoint of kids(service, 'endpoint')) {
        const binding = all('binding').find((b) => b['@name'] === local(endpoint['@binding']));
        if (!binding || String(binding['@type'] ?? '') !== WSOAP) continue; // HTTP bindings are not SOAP
        // SOAP 1.2 unless wsoap:version="1.1"
        const version: 11 | 12 = String(attrNs(binding, 'version', WSOAP) ?? '1.2') === '1.1' ? 11 : 12;
        const address = String(endpoint['@address'] ?? '');
        const urlVar = urlVarFor(address, String(endpoint['@name']));
        const iface = interfaces.get(local(binding['@interface'] ?? service['@interface']));
        const actions = new Map(kids(binding, 'operation').map((bop) => [local(bop['@ref']), String(attrNs(bop, 'action', WSOAP) ?? '')]));
        const requests: SavedHttpRequest[] = [];
        for (const op of opsOf(iface)) {
          const name = String(op['@name']);
          const input = kids(op, 'input')[0];
          const elName = String(input?.['@element'] ?? '#none');
          nsPrefix.clear();
          const el = elName.startsWith('#') ? undefined : elements.get(local(elName));
          const body = el ? elementXml(el.node, el.schema, '    ', 0, new Set(), true) : [];
          // the binding's wsoap:action, else the interface input's wsam:Action
          const action = actions.get(name) || String(attrNs(input, 'Action') ?? '');
          requests.push(soapRequest(name, version, action, body, urlVar, docOf(op)));
        }
        if (requests.length) items.push({ kind: 'folder', id: shortId('fld-'), name: `${service['@name']} · ${endpoint['@name']}${version === 12 ? ' (SOAP 1.2)' : ''}`, items: requests });
      }
    }
  }

  const messages = new Map<string, X[]>();
  for (const m of all('message')) messages.set(String(m['@name']), kids(m, 'part'));
  const portTypes = new Map<string, Map<string, X>>();
  for (const pt of all('portType')) portTypes.set(String(pt['@name']), new Map(kids(pt, 'operation').map((o) => [String(o['@name']), o])));

  for (const service of wsdl2 ? [] : all('service')) {
    for (const port of kids(service, 'port')) {
      const binding = all('binding').find((b) => b['@name'] === local(port['@binding']));
      if (!binding) continue;
      const soapBinding = kids(binding, 'binding', SOAP11)[0] ?? kids(binding, 'binding', SOAP12)[0];
      if (!soapBinding) continue; // an HTTP binding: not SOAP
      const version: 11 | 12 = kids(binding, 'binding', SOAP12)[0] ? 12 : 11;
      const address = String((kids(port, 'address', version === 12 ? SOAP12 : SOAP11)[0] ?? kids(port, 'address')[0])?.['@location'] ?? '');
      const urlVar = urlVarFor(address, String(port['@name']));
      const ops = portTypes.get(local(binding['@type'])) ?? new Map<string, X>();
      const requests: SavedHttpRequest[] = [];
      for (const bop of kids(binding, 'operation')) {
        const name = String(bop['@name']);
        const soapOp = kids(bop, 'operation', version === 12 ? SOAP12 : SOAP11)[0] ?? kids(bop, 'operation').find((o) => o !== bop);
        const action = String(soapOp?.['@soapAction'] ?? '');
        const style = String(soapOp?.['@style'] ?? soapBinding['@style'] ?? 'document');
        const op = ops.get(name);
        const parts = messages.get(local(kids(op, 'input')[0]?.['@message'])) ?? [];
        nsPrefix.clear();
        let body: string[];
        if (style === 'rpc') {
          const ns = String(kids(kids(bop, 'input')[0], 'body')[0]?.['@namespace'] ?? targetNs);
          const p = prefixFor(ns);
          body = [
            `    <${p}:${name}>`,
            ...parts.flatMap((part) => {
              const el = part['@element'] ? elements.get(local(part['@element'])) : undefined;
              if (el) return elementXml(el.node, el.schema, '      ', 0, new Set(), true);
              const ct = complexTypes.get(local(part['@type']));
              if (ct) {
                const inner = complexBody(ct.node, ct.schema, '        ', 1, new Set([local(part['@type'])]));
                return inner.length ? [`      <${part['@name']}>`, ...inner, `      </${part['@name']}>`] : [`      <${part['@name']}/>`];
              }
              return [`      <${part['@name']}>${placeholder(String(part['@type'] ?? 'string'))}</${part['@name']}>`];
            }),
            `    </${p}:${name}>`,
          ];
        } else {
          body = parts.flatMap((part) => {
            const el = part['@element'] ? elements.get(local(part['@element'])) : undefined;
            return el ? elementXml(el.node, el.schema, '    ', 0, new Set(), true) : [];
          });
        }
        requests.push(soapRequest(name, version, action, body, urlVar, docOf(op)));
      }
      if (requests.length) items.push({ kind: 'folder', id: shortId('fld-'), name: `${service['@name']} · ${port['@name']}${version === 12 ? ' (SOAP 1.2)' : ''}`, items: requests });
    }
  }
  if (!items.length) throw new ApsError('ValidationError', 'The WSDL has no SOAP operations', { suggestions: ['Only SOAP 1.1 and 1.2 bindings are imported (not HTTP bindings).'] });
  // one port: no need for the folder level
  const name = String(root['@name'] ?? all('service')[0]?.['@name'] ?? 'SOAP service');
  const description = docOf(root) ?? docOf(all('service')[0]);
  return {
    collection: {
      schemaVersion: SCHEMA_VERSION,
      id: `${slugify(name) || 'wsdl'}-${shortId().slice(-4)}`,
      name,
      version: 0,
      variables,
      items: items.length === 1 ? items[0]!.items : items,
      ...(description ? { description } : {}),
      updatedAt: new Date().toISOString(),
    },
  };
}
